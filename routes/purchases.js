const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const auth    = require('../middleware/auth');
const { logAudit } = require('../middleware/auditLog');
const { yearPKT } = require('../utils/dateUtils');

// ─── Purchase lifecycle (post 2026-08 refactor) ────────────────────────────
// The landed cost that lands in `inventory.purchase_rate` is derived from
// the six-step vendor-cost formula (Q6 from the audit):
//
//   Net_Rate    = Purchase_Rate × (1 − Disc%/100)
//   Final_Rate  = Net_Rate × (1 + Tax%/100)
//   Total_Cost  = Final_Rate × Qty
//   Total_Stock = Qty + Bonus
//   Landed_Rate = Total_Cost / Total_Stock     ← the per-unit cost basis
//
// If the purchased batch already exists in inventory (i.e. the operator
// is topping up an existing batch), the new inventory rate is the
// weighted average of the CURRENT REMAINING inventory qty at its current
// rate and the newly-received stock at its landed rate:
//
//   Weighted_Rate =
//     (existing_qty × existing_rate + new_stock × landed_rate)
//     ------------------------------------------------------------
//                 existing_qty + new_stock
//
// Weight is REMAINING inventory (per Q6) — anything already sold from
// that batch carries its own frozen `purchase_rate_snapshot` on
// `sale_items`, so the weighted average never re-writes the cost of
// units that have already left the shelf.
//
// The server enforces confirmation before applying any weighted-average
// rate change. If the client submits without `confirm_rate_change: true`
// on a purchase whose landed cost differs from the current inventory
// rate for any batch, the server responds 409 with the per-line preview
// so the UI can show the operator exactly what will happen before they
// commit.
//
// Concurrency:
//   - Every batch's inventory row is `SELECT ... FOR UPDATE` before we
//     read the weighted-average inputs, so two purchases toucing the
//     same batch cannot race.
//
// Journal:
//   - Every stock addition writes an `inventory_movements` row with
//     ref_type='purchase', ref_id=<purchases.id> and
//     rate_at_movement = the landed rate for that specific line.

// Paisa-level tolerance for money comparisons.
const PAISA = 0.005;

// Round to 2 decimal places (used for line totals, ledger figures).
const money2 = (n) => Math.round(parseFloat(n || 0) * 100) / 100;

// Round to 4 decimal places (inventory.purchase_rate is DECIMAL(12,4)).
const money4 = (n) => Math.round(parseFloat(n || 0) * 10000) / 10000;


// ── Landed cost per line (server-side implementation of the 6-step
//    formula). Returns both the intermediate steps and the final
//    landed_rate — the intermediates are echoed in the preview response
//    so the operator can see exactly how the number was arrived at.
function computeLineLandedCost({ purchase_rate, discount_pct, tax_pct, qty, bonus }) {
  const rate = parseFloat(purchase_rate || 0);
  const disc = parseFloat(discount_pct  || 0);
  const tax  = parseFloat(tax_pct       || 0);
  const q    = parseInt  (qty           || 0, 10);
  const b    = parseInt  (bonus         || 0, 10);

  const net_rate    = rate * (1 - disc / 100);
  const final_rate  = net_rate * (1 + tax / 100);
  const total_cost  = final_rate * q;
  const total_stock = q + b;
  const landed_rate = total_stock > 0 ? total_cost / total_stock : 0;

  return {
    net_rate:    money4(net_rate),
    final_rate:  money4(final_rate),
    total_cost:  money2(total_cost),
    total_stock,
    landed_rate: money4(landed_rate),
  };
}


// ── Weighted average blend against remaining inventory qty (per Q6).
//    `newStock` = qty + bonus (total units flowing IN from this line).
function weightedAverageRate({ existing_qty, existing_rate, new_stock, landed_rate }) {
  const eq = parseFloat(existing_qty  || 0);
  const er = parseFloat(existing_rate || 0);
  const nq = parseFloat(new_stock     || 0);
  const nr = parseFloat(landed_rate   || 0);
  const total = eq + nq;
  if (total <= 0) return 0;
  return money4((eq * er + nq * nr) / total);
}


// ── Journal helper (parallel to the one in sales.js). Kept local because
//    each module writes movements with its own ref_type vocabulary.
async function recordInventoryMovement(conn, {
  productId, batchNo, date, refType, refId, qtyIn, qtyOut, rateAtMovement, note,
}) {
  await conn.query(
    `INSERT INTO inventory_movements
       (product_id, batch_no, movement_date, ref_type, ref_id,
        qty_in, qty_out, rate_at_movement, note)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [productId, batchNo || '', date, refType, refId,
     qtyIn || 0, qtyOut || 0, rateAtMovement ?? null, note || null]
  );
}


// ── Build the per-line preview for an incoming purchase payload. Reads
//    the CURRENT inventory row (with FOR UPDATE when we're inside a
//    write transaction, plain SELECT otherwise) so the preview accurately
//    reflects what will happen at commit time.
async function buildLinePreviews(conn, items, { lockForUpdate = false } = {}) {
  const previews = [];
  let anyRateChange = false;

  for (const item of (items || [])) {
    const landed = computeLineLandedCost(item);

    const sqlSuffix = lockForUpdate ? ' FOR UPDATE' : '';
    const [invRows] = await conn.query(
      `SELECT id, qty, purchase_rate, sale_rate, retail_price, exp_date
         FROM inventory WHERE product_id=? AND batch_no=?` + sqlSuffix,
      [item.product_id, item.batch_no]
    );
    const existing = invRows[0] || null;

    let weighted_rate       = landed.landed_rate;
    let rate_change_required = false;

    if (existing) {
      weighted_rate = weightedAverageRate({
        existing_qty:  existing.qty,
        existing_rate: existing.purchase_rate,
        new_stock:     landed.total_stock,
        landed_rate:   landed.landed_rate,
      });
      // Any perceptible change in the inventory purchase_rate is a
      // confirmation trigger. 0.0001 aligns with the DECIMAL(12,4) scale.
      if (Math.abs(parseFloat(existing.purchase_rate) - weighted_rate) > 0.00005) {
        rate_change_required = true;
        anyRateChange = true;
      }
    }

    previews.push({
      product_id:            item.product_id,
      batch_no:              item.batch_no,
      product_name:          item.product_name || null,
      landed_cost_steps:     landed,       // net_rate / final_rate / total_cost / total_stock / landed_rate
      existing_in_inventory: !!existing,
      existing_qty:          existing ? parseInt(existing.qty, 10) : null,
      existing_rate:         existing ? parseFloat(existing.purchase_rate) : null,
      existing_exp_date:     existing ? existing.exp_date : null,
      existing_retail_price: existing ? parseFloat(existing.retail_price) : null,
      existing_sale_rate:    existing ? parseFloat(existing.sale_rate)    : null,
      weighted_rate,
      rate_change_required,
      __existing_row:        existing,      // internal, stripped before response
    });
  }

  return { previews, anyRateChange };
}


// ── Apply the writes for a single purchase line: insert purchase_items,
//    upsert inventory using the weighted average, and journal the movement.
async function applyPurchaseLine(conn, {
  purchaseRowId, purchaseDate, item, landed, preview,
}) {
  // purchase_items row keeps the RAW vendor figures — the derived landed
  // rate lands only in inventory.purchase_rate, so an auditor can always
  // reconstruct what the vendor charged vs what our cost basis became.
  await conn.query(
    `INSERT INTO purchase_items
       (purchase_id, product_id, batch_no, pack_size, purchase_rate,
        qty, bonus, discount_pct, tax_pct, sale_tax_pct,
        exp_date, retail_price, total)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [purchaseRowId, item.product_id, item.batch_no, item.pack_size,
     item.purchase_rate,
     item.qty, item.bonus || 0,
     item.discount_pct || 0, item.tax_pct || 0, item.sale_tax_pct || 0,
     item.exp_date || null, item.retail_price || 0, item.total]
  );

  const totalStock = landed.total_stock;

  if (preview.existing_in_inventory) {
    // Weighted-average update against remaining inventory.
    await conn.query(
      `UPDATE inventory
         SET qty            = qty + ?,
             purchase_rate  = ?,
             sale_rate      = ?,
             retail_price   = ?,
             exp_date       = ?,
             updated_at     = NOW()
       WHERE id=?`,
      [totalStock, preview.weighted_rate,
       item.sale_rate    != null && item.sale_rate    !== '' ? item.sale_rate    : preview.existing_sale_rate,
       item.retail_price != null && item.retail_price !== '' ? item.retail_price : preview.existing_retail_price,
       item.exp_date     != null && item.exp_date     !== '' ? item.exp_date     : preview.existing_exp_date,
       preview.__existing_row.id]
    );
  } else {
    await conn.query(
      `INSERT INTO inventory
         (product_id, batch_no, qty, purchase_rate, sale_rate, retail_price, exp_date)
       VALUES (?,?,?,?,?,?,?)`,
      [item.product_id, item.batch_no, totalStock,
       landed.landed_rate,
       item.sale_rate    || 0,
       item.retail_price || 0,
       item.exp_date     || null]
    );
  }

  await recordInventoryMovement(conn, {
    productId:      item.product_id,
    batchNo:        item.batch_no,
    date:           purchaseDate,
    refType:        'purchase',
    refId:          purchaseRowId,
    qtyIn:          totalStock,
    qtyOut:         0,
    rateAtMovement: landed.landed_rate,
    note:           `Purchase — landed ${landed.landed_rate}`,
  });
}


// ── Reverse a purchase's inventory effect (used by DELETE and by PUT's
//    first phase). Fails 409 if the reversal would drive any batch's qty
//    below zero — physical stock has already been sold from it.
async function reversePurchaseInventory(conn, purchaseId, purchaseDate) {
  const [oldItems] = await conn.query(
    'SELECT * FROM purchase_items WHERE purchase_id=?', [purchaseId]);
  for (const it of oldItems) {
    const stock = parseInt(it.qty || 0, 10) + parseInt(it.bonus || 0, 10);
    if (stock <= 0) continue;
    const [invRows] = await conn.query(
      `SELECT id, qty FROM inventory WHERE product_id=? AND batch_no=? FOR UPDATE`,
      [it.product_id, it.batch_no]
    );
    if (!invRows.length) {
      // Nothing to reverse — the batch was already gone from inventory.
      // Log the movement anyway so history is complete.
      await recordInventoryMovement(conn, {
        productId: it.product_id, batchNo: it.batch_no,
        date: purchaseDate, refType: 'purchase', refId: purchaseId,
        qtyIn: 0, qtyOut: 0, rateAtMovement: null,
        note: 'Purchase reversal — batch not found in inventory',
      });
      continue;
    }
    const currentQty = parseInt(invRows[0].qty, 10);
    if (currentQty < stock) {
      throw Object.assign(new Error(
        `Cannot reverse this purchase — batch ${it.batch_no} has only ${currentQty} unit(s) left in inventory, but the purchase originally added ${stock}. Some of the purchased stock has already been sold.`
      ), { status: 409 });
    }
    await conn.query(
      'UPDATE inventory SET qty=qty-? WHERE id=?', [stock, invRows[0].id]);
    await recordInventoryMovement(conn, {
      productId:      it.product_id,
      batchNo:        it.batch_no,
      date:           purchaseDate,
      refType:        'purchase',
      refId:          purchaseId,
      qtyIn:          0,
      qtyOut:         stock,
      rateAtMovement: null,
      note:           `Purchase reversal (edit or delete)`,
    });
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// Invoice-id generation
// ═══════════════════════════════════════════════════════════════════════════

function getPurchasePrefix(dateValue) {
  const year = yearPKT(dateValue || new Date());
  if (Number.isNaN(year)) return 'P' + String(yearPKT()).slice(-2);
  return `P${String(year).slice(-2)}`;
}

async function generatePurchaseId(dateValue) {
  const prefix = getPurchasePrefix(dateValue);
  const [rows] = await db.query(
    'SELECT purchase_id FROM purchases WHERE purchase_id LIKE ? ORDER BY purchase_id DESC LIMIT 1',
    [`${prefix}-%`]
  );
  if (rows.length === 0) return `${prefix}-00001`;
  const num = parseInt(rows[0].purchase_id.split('-')[1]) + 1;
  return `${prefix}-${String(num).padStart(5, '0')}`;
}


// ═══════════════════════════════════════════════════════════════════════════
// READ endpoints
// ═══════════════════════════════════════════════════════════════════════════

router.get('/', auth, async (req, res) => {
  try {
    // DATE_FORMAT gives the client a stable ISO string (matches the Sale
    // list pattern) so string-comparison-based column sorting works
    // uniformly regardless of the mysql2 date-mode setting.
    //
    // `product_ids` is a comma-separated string of every distinct
    // product_id on this purchase — used by the Purchase page's Product
    // filter to include historical purchases even for products that
    // currently have no active stock.
    const [rows] = await db.query(`
      SELECT p.*, DATE_FORMAT(p.date, '%Y-%m-%d') AS date,
             s.name as supplier_name,
             (SELECT GROUP_CONCAT(DISTINCT pi.product_id) FROM purchase_items pi WHERE pi.purchase_id = p.id) AS product_ids
      FROM purchases p
      JOIN suppliers s ON p.supplier_id=s.id
      ORDER BY p.date DESC, p.id DESC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/:id', auth, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT p.*, s.name as supplier_name FROM purchases p
      JOIN suppliers s ON p.supplier_id=s.id WHERE p.id=?`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Purchase not found' });
    const [items] = await db.query(`
      SELECT pi.*, pr.name as product_name FROM purchase_items pi
      JOIN products pr ON pi.product_id=pr.id WHERE pi.purchase_id=?`, [req.params.id]);
    res.json({ ...rows[0], items });
  } catch (err) { res.status(500).json({ message: err.message }); }
});


// Preview — returns per-line landed cost + weighted-average forecast so the
// UI can display the "Eff. Purchase Rate per Item" and "New Weighted Rate"
// BEFORE the operator hits Save. No writes. No FOR UPDATE (a preview isn't
// a commitment; the actual write will re-lock at commit time).
router.post('/preview', auth, async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'items array required' });
    }
    const conn = db; // read-only, use pool directly
    const { previews, anyRateChange } = await buildLinePreviews(conn, items);
    // Strip the internal __existing_row before responding.
    const clean = previews.map(({ __existing_row, ...rest }) => rest);
    res.json({ lines: clean, any_rate_change: anyRateChange });
  } catch (err) { res.status(500).json({ message: err.message }); }
});


// ═══════════════════════════════════════════════════════════════════════════
// POST / — Create purchase
// ═══════════════════════════════════════════════════════════════════════════
// If any line would change the current inventory purchase_rate for its
// batch (weighted-average delta) and the caller has not sent
// `confirm_rate_change: true`, the server responds 409 with the per-line
// preview so the UI can display the confirmation modal.

router.post('/', auth, async (req, res) => {
  const conn = await db.getConnection();
  await conn.beginTransaction();
  try {
    const { supplier_id, invoice_no, date, items, confirm_rate_change } = req.body;
    if (!supplier_id || !date || !items || items.length === 0) {
      return res.status(400).json({ message: 'Supplier, date and items are required' });
    }

    // Build previews under row locks so nothing shifts between decision
    // and write.
    const { previews, anyRateChange } = await buildLinePreviews(conn, items, { lockForUpdate: true });
    if (anyRateChange && !confirm_rate_change) {
      await conn.rollback();
      const clean = previews.map(({ __existing_row, ...rest }) => rest);
      return res.status(409).json({
        message: 'One or more batches will have their inventory purchase rate changed by this purchase. Please review and confirm.',
        requires_confirmation: 'confirm_rate_change',
        preview: { lines: clean, any_rate_change: true },
      });
    }

    const purchase_id = await generatePurchaseId(date);
    const total_amount = items.reduce((sum, i) => sum + parseFloat(i.total || 0), 0);

    const [result] = await conn.query(
      `INSERT INTO purchases (purchase_id, supplier_id, invoice_no, date, total_amount)
       VALUES (?,?,?,?,?)`,
      [purchase_id, supplier_id, invoice_no, date, total_amount]
    );
    const pId = result.insertId;

    for (let i = 0; i < items.length; i++) {
      const item    = items[i];
      const preview = previews[i];
      const landed  = preview.landed_cost_steps;
      await applyPurchaseLine(conn, {
        purchaseRowId: pId, purchaseDate: date, item, landed, preview,
      });
    }

    // Supplier ledger + balance.
    await conn.query('UPDATE suppliers SET balance=balance+? WHERE id=?',
      [total_amount, supplier_id]);
    const [supRows] = await conn.query(
      'SELECT balance FROM suppliers WHERE id=?', [supplier_id]);
    await conn.query(
      `INSERT INTO supplier_ledger
         (supplier_id, date, invoice_no, description, dr, cr, balance,
          reference_type, reference_id)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [supplier_id, date, invoice_no || purchase_id, 'Purchase',
       total_amount, 0, supRows[0].balance, 'purchase', pId]
    );

    await conn.commit();
    await logAudit(req, 'CREATE', 'purchase', pId,
      `Created purchase ${purchase_id} from supplier ${supplier_id} — PKR ${total_amount}`);
    res.status(201).json({ id: pId, purchase_id, total_amount });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(err.status || 500).json({ message: err.message });
  } finally { conn.release(); }
});


// ═══════════════════════════════════════════════════════════════════════════
// PUT /:id — Update purchase (reverses old inventory + ledger, applies new)
// ═══════════════════════════════════════════════════════════════════════════

router.put('/:id', auth, async (req, res) => {
  const conn = await db.getConnection();
  await conn.beginTransaction();
  try {
    const purchaseId = parseInt(req.params.id, 10);
    const { supplier_id, invoice_no, date, items, confirm_rate_change } = req.body;
    if (!supplier_id || !date || !items || items.length === 0) {
      return res.status(400).json({ message: 'Supplier, date and items are required' });
    }

    const [pRows] = await conn.query(
      'SELECT * FROM purchases WHERE id=? FOR UPDATE', [purchaseId]);
    if (pRows.length === 0) return res.status(404).json({ message: 'Purchase not found' });
    const old = pRows[0];

    // 1. Reverse old inventory (throws 409 if any batch was already
    //    partially consumed and reversal would drive it negative).
    await reversePurchaseInventory(conn, purchaseId, date);

    // 2. Reverse old supplier ledger.
    await conn.query('UPDATE suppliers SET balance=balance-? WHERE id=?',
      [old.total_amount, old.supplier_id]);
    await conn.query(
      `DELETE FROM supplier_ledger WHERE reference_type='purchase' AND reference_id=?`,
      [purchaseId]);
    await conn.query('DELETE FROM purchase_items WHERE purchase_id=?', [purchaseId]);

    // 3. Rate-change preview + confirmation gate for the corrected lines.
    const { previews, anyRateChange } = await buildLinePreviews(conn, items, { lockForUpdate: true });
    if (anyRateChange && !confirm_rate_change) {
      await conn.rollback();
      const clean = previews.map(({ __existing_row, ...rest }) => rest);
      return res.status(409).json({
        message: 'One or more batches will have their inventory purchase rate changed by this edit. Please review and confirm.',
        requires_confirmation: 'confirm_rate_change',
        preview: { lines: clean, any_rate_change: true },
      });
    }

    // 4. Update purchase row + apply new lines.
    const total_amount = items.reduce((s, i) => s + parseFloat(i.total || 0), 0);
    await conn.query(
      `UPDATE purchases
         SET supplier_id=?, invoice_no=?, date=?, total_amount=?
       WHERE id=?`,
      [supplier_id, invoice_no || null, date, total_amount, purchaseId]
    );
    for (let i = 0; i < items.length; i++) {
      await applyPurchaseLine(conn, {
        purchaseRowId: purchaseId, purchaseDate: date,
        item: items[i], landed: previews[i].landed_cost_steps, preview: previews[i],
      });
    }

    // 5. Re-add supplier ledger.
    await conn.query('UPDATE suppliers SET balance=balance+? WHERE id=?',
      [total_amount, supplier_id]);
    const [supRows] = await conn.query(
      'SELECT balance FROM suppliers WHERE id=?', [supplier_id]);
    await conn.query(
      `INSERT INTO supplier_ledger
         (supplier_id, date, invoice_no, description, dr, cr, balance,
          reference_type, reference_id)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [supplier_id, date, invoice_no || old.purchase_id, 'Purchase (Edited)',
       total_amount, 0, supRows[0].balance, 'purchase', purchaseId]
    );

    await conn.commit();
    await logAudit(req, 'UPDATE', 'purchase', purchaseId,
      `Updated purchase ID ${purchaseId}`);
    res.json({ message: 'Purchase updated successfully' });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(err.status || 500).json({ message: err.message });
  } finally { conn.release(); }
});


// ═══════════════════════════════════════════════════════════════════════════
// DELETE /:id — Delete purchase (reverses inventory + supplier ledger)
// ═══════════════════════════════════════════════════════════════════════════
// Blocked with 409 if any purchased batch's inventory qty has dropped
// below the qty that was originally added — that means some of the
// purchased stock has already been sold and the delete cannot cleanly
// unwind. The operator must correct stock (or void the sale) first.

router.delete('/:id', auth, async (req, res) => {
  const conn = await db.getConnection();
  await conn.beginTransaction();
  try {
    const purchaseId = parseInt(req.params.id, 10);
    const [pRows] = await conn.query(
      'SELECT * FROM purchases WHERE id=? FOR UPDATE', [purchaseId]);
    if (pRows.length === 0) return res.status(404).json({ message: 'Purchase not found' });
    const purchase = pRows[0];

    await reversePurchaseInventory(conn, purchaseId, purchase.date);

    await conn.query('UPDATE suppliers SET balance=balance-? WHERE id=?',
      [purchase.total_amount, purchase.supplier_id]);
    await conn.query(
      `DELETE FROM supplier_ledger WHERE reference_type='purchase' AND reference_id=?`,
      [purchaseId]);
    // purchase_items cascade via FK when purchases is deleted.
    await conn.query('DELETE FROM purchases WHERE id=?', [purchaseId]);

    await conn.commit();
    await logAudit(req, 'DELETE', 'purchase', purchaseId,
      `Deleted purchase ID ${purchaseId}`);
    res.json({ message: 'Purchase deleted' });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(err.status || 500).json({ message: err.message });
  } finally { conn.release(); }
});

module.exports = router;