const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const auth    = require('../middleware/auth');
const { logAudit } = require('../middleware/auditLog');
const { canViewPurchaseRate } = require('../utils/purchaseRateAccess');
const { yearPKT } = require('../utils/dateUtils');

// ─── Sale lifecycle (post 2026-08 refactor) ────────────────────────────────
// Every write path now:
//   1. Snapshots inventory.purchase_rate onto sale_items.purchase_rate_snapshot
//      at insert time — the item's cost basis is frozen for the Profit
//      report even if inventory rates change later.
//   2. Locks the inventory row with FOR UPDATE before adjusting qty, so two
//      concurrent invoices selling the same batch cannot oversell it.
//   3. Records every stock movement in inventory_movements (forward-looking
//      journal for the "stock as of date" feature planned for a later
//      iteration).
//   4. is_locked continues to guard PUT / DELETE. When recoveries.js
//      auto-unlocks a sale (all recoveries gone), this endpoint becomes
//      writable again automatically — no extra handling needed here.

// ── Fiscal year prefix (used only when generating a new invoice number)
function getFiscalPrefix(dateValue) {
  const year = yearPKT(dateValue || new Date());
  if (Number.isNaN(year)) return 'S' + String(yearPKT()).slice(-2);
  return `S${String(year).slice(-2)}`;
}

async function generateInvoiceNo(dateValue) {
  const prefix = getFiscalPrefix(dateValue);
  const [rows] = await db.query(
    'SELECT invoice_no FROM sales WHERE invoice_no LIKE ? ORDER BY invoice_no DESC LIMIT 1',
    [`${prefix}-%`]
  );
  if (rows.length === 0) return `${prefix}-00001`;
  const num = parseInt(rows[0].invoice_no.split('-')[1]) + 1;
  return `${prefix}-${String(num).padStart(5, '0')}`;
}

// Look up the current inventory row for (product, batch) and return its
// purchase_rate, or null if the batch no longer exists in inventory. Used
// to freeze cost-of-goods onto sale_items at sale time.
async function snapshotPurchaseRate(conn, productId, batchNo) {
  const [rows] = await conn.query(
    'SELECT purchase_rate FROM inventory WHERE product_id=? AND batch_no=? LIMIT 1',
    [productId, batchNo]
  );
  if (!rows.length) return null;
  return rows[0].purchase_rate;
}

// Journal one inventory qty change. Called from every write path that
// touches inventory.qty so the movement history stays complete going
// forward. rate_at_movement is populated when known (e.g. sale time,
// snapshot from inventory); left NULL otherwise.
async function recordInventoryMovement(conn, {
  productId, batchNo, date, refType, refId, qtyIn, qtyOut, rateAtMovement, note,
}) {
  await conn.query(
    `INSERT INTO inventory_movements
       (product_id, batch_no, movement_date, ref_type, ref_id, qty_in, qty_out, rate_at_movement, note)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [productId, batchNo || '', date, refType, refId,
     qtyIn || 0, qtyOut || 0, rateAtMovement ?? null, note || null]
  );
}

// Lock the inventory row for update, verify enough stock exists, decrement,
// and journal the movement. Returns the pre-deduction qty so callers can
// log it if useful.
async function deductInventoryOrThrow(conn, {
  productId, batchNo, qty, date, refType, refId, note,
}) {
  if (qty <= 0) return 0;
  const [invRows] = await conn.query(
    'SELECT id, qty, purchase_rate FROM inventory WHERE product_id=? AND batch_no=? FOR UPDATE',
    [productId, batchNo]
  );
  if (!invRows.length) {
    throw Object.assign(new Error(
      `Batch "${batchNo || '(no batch)'}" is not in inventory for product id ${productId}. Cannot sell it.`
    ), { status: 400 });
  }
  const current = parseInt(invRows[0].qty || 0);
  if (current < qty) {
    throw Object.assign(new Error(
      `Insufficient stock in batch "${batchNo}" (available: ${Math.max(0, current)}, needed: ${qty}). Refresh and try again — a concurrent sale may have consumed it.`
    ), { status: 409 });
  }
  await conn.query(
    'UPDATE inventory SET qty=qty-? WHERE id=?',
    [qty, invRows[0].id]
  );
  await recordInventoryMovement(conn, {
    productId, batchNo, date, refType, refId,
    qtyIn: 0, qtyOut: qty,
    rateAtMovement: invRows[0].purchase_rate,
    note,
  });
  return current;
}

// Restore qty to a batch (used by sale edit/delete and any other reversal
// path). If the batch was previously deleted from inventory the caller
// should have caught that upstream; here we just no-op the update but
// still log the movement, so the audit trail is complete.
async function restoreInventory(conn, {
  productId, batchNo, qty, date, refType, refId, note,
}) {
  if (qty <= 0) return;
  const [invRows] = await conn.query(
    'SELECT id, purchase_rate FROM inventory WHERE product_id=? AND batch_no=? FOR UPDATE',
    [productId, batchNo]
  );
  let rate = null;
  if (invRows.length) {
    rate = invRows[0].purchase_rate;
    await conn.query(
      'UPDATE inventory SET qty=qty+? WHERE id=?',
      [qty, invRows[0].id]
    );
  }
  await recordInventoryMovement(conn, {
    productId, batchNo, date, refType, refId,
    qtyIn: qty, qtyOut: 0,
    rateAtMovement: rate,
    note,
  });
}


// ═══════════════════════════════════════════════════════════════════════════
// READ endpoints
// ═══════════════════════════════════════════════════════════════════════════

router.get('/', auth, async (req, res) => {
  try {
    // Optional `print_status` filter used by the Bulk Print flow — kept
    // server-side so future paginated loads can push the filter down
    // instead of trimming the payload on the client. Default 'all' keeps
    // the existing Sales page behaviour unchanged.
    const printStatus = String(req.query.print_status || 'all').toLowerCase();
    let printFilterSql = '';
    if (printStatus === 'unprinted')    printFilterSql = 'WHERE s.printed_at IS NULL';
    else if (printStatus === 'printed') printFilterSql = 'WHERE s.printed_at IS NOT NULL';

    // s.* already surfaces the new printed_at / last_printed_type /
    // last_printed_by columns added by the 2026-08-22_bulk_print
    // migration, so the client doesn't need extra joins for the
    // "Printed as … on <date>" chip.
    //
    // c.is_licensed is included so the Bulk Print flow can compute its
    // per-invoice "smart default" type (licensed → warranty, non-licensed
    // → non-warranty) client-side without a second round-trip.
    const [rows] = await db.query(`
      SELECT s.*, DATE_FORMAT(s.date, '%Y-%m-%d') AS date,
             c.name as customer_name, c.is_licensed,
             e.name as salesman_name,
             d.name as delivery_by_name,
             ci.name as city_name, a.name as area_name, t.name as territory_name,
             (SELECT GROUP_CONCAT(DISTINCT si.product_id) FROM sale_items si WHERE si.sale_id = s.id) as product_ids
      FROM sales s
      JOIN customers c ON s.customer_id=c.id
      LEFT JOIN employees e ON s.salesman_id=e.id
      LEFT JOIN employees d ON s.delivery_by=d.id
      LEFT JOIN cities ci ON c.city_id=ci.id
      LEFT JOIN areas a ON c.area_id=a.id
      LEFT JOIN territories t ON c.territory_id=t.id
      ${printFilterSql}
      ORDER BY s.date DESC, s.id DESC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Get previous rates for a product sold to a customer.
// Admins always see purchase_rate regardless of `products.show_purchase_rate` — the
// visibility flag exists to hide sensitive cost data from junior staff, not from
// account owners.
router.get('/history/rates', auth, async (req, res) => {
  try {
    const { product_id, customer_id } = req.query;
    if (!product_id || !customer_id) return res.json({ history: [], purchase_rate: null });
    const [rows] = await db.query(`
      SELECT si.sale_rate, si.discount_pct, s.date, s.invoice_no
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.id
      WHERE si.product_id = ? AND s.customer_id = ?
      ORDER BY s.date DESC, s.id DESC
      LIMIT 3
    `, [product_id, customer_id]);
    const [inv] = await db.query(
      'SELECT purchase_rate FROM inventory WHERE product_id=? ORDER BY updated_at DESC LIMIT 1',
      [product_id]
    );
    const isAdmin = req.user?.role === 'admin';
    let canView;
    if (isAdmin) {
      canView = true;
    } else {
      const [[product]] = await db.query('SELECT show_purchase_rate FROM products WHERE id=?', [product_id]);
      canView = await canViewPurchaseRate(req, db, product || { show_purchase_rate: 1 });
    }
    res.json({
      history: rows,
      purchase_rate: canView ? (inv[0]?.purchase_rate || null) : null,
      purchase_rate_visible: canView,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Get single sale with items
router.get('/:id', auth, async (req, res) => {
  try {
    // `c.is_licensed` is what the Bulk Print flow uses to resolve the
    // "smart default" invoice type per-invoice (licensed → warranty,
    // non-licensed → non-warranty). Same rule the print_queue seed used
    // before it was removed.
    //
    // `c.ntn` and `c.strn` carry the customer's Pakistan tax identifiers
    // (clean digits; formatting is applied by frontend/TaxIdInput's
    // exported `formatTaxId` when the invoice renders). InvoiceDocument
    // hides both the label and the value when either is NULL/empty.
    const [rows] = await db.query(`
      SELECT s.*, DATE_FORMAT(s.date, '%Y-%m-%d') AS date,
             c.name as customer_name, c.address as customer_address, c.phone as customer_phone,
             c.license_no, c.license_expiry, c.is_licensed,
             c.ntn, c.strn,
             e.name as salesman_name,
             d.name as delivery_by_name,
             ci.name as city_name, a.name as area_name, t.name as territory_name
      FROM sales s
      JOIN customers c ON s.customer_id=c.id
      LEFT JOIN employees e ON s.salesman_id=e.id
      LEFT JOIN employees d ON s.delivery_by=d.id
      LEFT JOIN cities ci ON c.city_id=ci.id
      LEFT JOIN areas a ON c.area_id=a.id
      LEFT JOIN territories t ON c.territory_id=t.id
      WHERE s.id=?`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Sale not found' });
    const [items] = await db.query(`
      SELECT si.*, p.name as product_name, p.pack_size as product_pack_size,
             COALESCE(
               NULLIF((SELECT inv.retail_price FROM inventory inv
                WHERE inv.product_id=si.product_id AND inv.batch_no=si.batch_no LIMIT 1), 0),
               NULLIF(p.retail_price, 0), 0
             ) as retail_price,
             (SELECT inv.exp_date FROM inventory inv
              WHERE inv.product_id=si.product_id AND inv.batch_no=si.batch_no LIMIT 1) as exp_date,
             (SELECT COALESCE(SUM(rt.qty_returned), 0) FROM return_items rt
              WHERE rt.sale_item_id=si.id) as already_returned,
             -- Server-computed return_rate = what the customer actually paid
             -- per unit (net of invoice-time discount, tax-inclusive) minus
             -- their per-unit share of any recovery-time discount already
             -- granted on this line. This is the ONLY rate at which stock
             -- returned from this line will be credited back — the client
             -- must NOT let the user override it (see recoveries.js which
             -- also computes and enforces this server-side).
             --
             -- The divisor is (qty − returned_qty), NOT qty. Discount
             -- granted after a partial return only spreads across the
             -- units still with the customer; the already-returned units
             -- don't "share" the new discount. Keep in lockstep with the
             -- returnRateCap() JS helper in recoveries.js. See the
             -- 2026-08-22 audit note.
             GREATEST(0, ROUND(
               si.sale_rate * (1 - si.discount_pct / 100) * (1 + si.tax_pct / 100)
               - (CASE WHEN (si.qty - si.returned_qty) > 0
                       THEN si.recovery_discount / (si.qty - si.returned_qty)
                       ELSE 0 END),
               2
             )) as return_rate
      FROM sale_items si
      JOIN products p ON si.product_id=p.id WHERE si.sale_id=?`, [req.params.id]);
    res.json({ ...rows[0], items });
  } catch (err) { res.status(500).json({ message: err.message }); }
});


// ═══════════════════════════════════════════════════════════════════════════
// POST / — Create sale
// ═══════════════════════════════════════════════════════════════════════════

router.post('/', auth, async (req, res) => {
  const conn = await db.getConnection();
  await conn.beginTransaction();
  try {
    const { customer_id, salesman_id, delivery_by, date, items } = req.body;
    if (!customer_id || !date || !items || items.length === 0) {
      await conn.rollback();
      return res.status(400).json({ message: 'Customer, date and items are required' });
    }

    const invoice_no = await generateInvoiceNo(date);
    const total_amount = items.reduce((sum, i) => sum + parseFloat(i.total || 0), 0);

    const [result] = await conn.query(
      `INSERT INTO sales
         (invoice_no, customer_id, salesman_id, delivery_by, date,
          total_amount, net_collectible, pending_amount, is_locked)
       VALUES (?,?,?,?,?,?,?,?,0)`,
      [invoice_no, customer_id, salesman_id || null, delivery_by || null, date,
       total_amount, total_amount, total_amount]
    );
    const sId = result.insertId;

    for (const item of items) {
      const totalQty = parseInt(item.qty) + parseInt(item.bonus || 0);

      // Lock, verify stock, deduct, and journal — in one call.
      await deductInventoryOrThrow(conn, {
        productId: item.product_id,
        batchNo:   item.batch_no,
        qty:       totalQty,
        date,
        refType:   'sale',
        refId:     sId,
        note:      `Sale ${invoice_no}`,
      });

      // Snapshot cost basis AFTER the lock+deduct (row already loaded above,
      // but querying again is negligible and keeps the helper generic).
      const costSnapshot = await snapshotPurchaseRate(conn, item.product_id, item.batch_no);

      await conn.query(
        `INSERT INTO sale_items
           (sale_id, product_id, batch_no, pack_size, sale_rate,
            purchase_rate_snapshot, qty, bonus, discount_pct, tax_pct, total)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [sId, item.product_id, item.batch_no, item.pack_size, item.sale_rate,
         costSnapshot, item.qty, item.bonus || 0,
         item.discount_pct || 0, item.tax_pct || 0, item.total]
      );
    }

    // Customer ledger + balance.
    await conn.query('UPDATE customers SET balance=balance+? WHERE id=?',
      [total_amount, customer_id]);
    const [custRows] = await conn.query(
      'SELECT balance FROM customers WHERE id=?', [customer_id]);
    const newBalance = custRows[0].balance;
    await conn.query(
      `INSERT INTO customer_ledger
         (customer_id, date, invoice_no, description, dr, cr, balance,
          reference_type, reference_id)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [customer_id, date, invoice_no, 'Sale', total_amount, 0, newBalance, 'sale', sId]
    );

    // NOTE: The 2026-08-22 Bulk Print refactor removed the print_queue
    // seed that used to live here. New invoices default to "unprinted"
    // (sales.printed_at IS NULL) and appear at the top of the Sales list;
    // operators either print them one-off from the row action or select
    // them into the Bulk Print flow. See the migration header for the
    // rationale.

    // Tax ledger for taxable manufactured products only. This intentionally
    // uses products.tax_applicable / products.sale_tax_pct rather than the
    // sale_item's user-entered tax_pct — the tax_ledger drives sales-tax
    // filings for self-manufactured stock, not sale-line accounting. See
    // 2026-08 audit F1 for the rationale to keep this path unchanged.
    for (const item of items) {
      const [prodTax] = await conn.query(
        'SELECT tax_applicable, sale_tax_pct FROM products WHERE id=?', [item.product_id]);
      if (prodTax[0]?.tax_applicable && parseFloat(prodTax[0].sale_tax_pct) > 0) {
        const taxRate = parseFloat(prodTax[0].sale_tax_pct);
        const taxableAmt = parseFloat(item.total);
        const taxAmt = taxableAmt * taxRate / 100;
        await conn.query(
          `INSERT INTO tax_ledger
             (sale_id, sale_item_id, product_id, sale_date, invoice_no,
              taxable_amount, tax_rate, tax_amount)
           VALUES (?,?,?,?,?,?,?,?)`,
          [sId, null, item.product_id, date, invoice_no, taxableAmt, taxRate, taxAmt]
        );
      }
    }

    await conn.commit();
    await logAudit(req, 'CREATE', 'sale', sId,
      `Created invoice ${invoice_no} for customer ${customer_id} — PKR ${total_amount}`);
    res.status(201).json({ id: sId, invoice_no, total_amount });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(err.status || 500).json({ message: err.message });
  } finally { conn.release(); }
});


// ═══════════════════════════════════════════════════════════════════════════
// PUT /:id — Update sale (blocked once any recovery has been recorded)
// ═══════════════════════════════════════════════════════════════════════════

router.put('/:id', auth, async (req, res) => {
  const conn = await db.getConnection();
  await conn.beginTransaction();
  try {
    // FOR UPDATE prevents a race with a concurrent recovery insert that
    // could otherwise lock the sale between our is_locked check and our
    // writes below.
    const [sRows] = await conn.query(
      'SELECT * FROM sales WHERE id=? FOR UPDATE', [req.params.id]);
    if (sRows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: 'Sale not found' });
    }
    const sale = sRows[0];
    if (sale.is_locked) {
      await conn.rollback();
      return res.status(403).json({
        message: 'Invoice is locked after recovery. Cannot edit.'
      });
    }

    const { customer_id, salesman_id, delivery_by, date, items } = req.body;

    // ── Restore old inventory (journal each restoration) ──────────────
    const [oldItems] = await conn.query(
      'SELECT * FROM sale_items WHERE sale_id=?', [req.params.id]);
    for (const item of oldItems) {
      const totalQty = parseInt(item.qty) + parseInt(item.bonus || 0);
      await restoreInventory(conn, {
        productId: item.product_id,
        batchNo:   item.batch_no,
        qty:       totalQty,
        date,
        refType:   'sale',
        refId:     parseInt(req.params.id),
        note:      `Sale ${sale.invoice_no} — reverting old items on edit`,
      });
    }

    // ── Reverse old ledger + wipe old sale_items ──────────────────────
    await conn.query('UPDATE customers SET balance=balance-? WHERE id=?',
      [sale.total_amount, sale.customer_id]);
    await conn.query(
      'DELETE FROM customer_ledger WHERE reference_type=? AND reference_id=?',
      ['sale', req.params.id]);
    await conn.query('DELETE FROM sale_items WHERE sale_id=?', [req.params.id]);
    // Also refresh the tax_ledger for this sale so a product-tax change
    // between the two writes doesn't leave stale rows behind.
    await conn.query('DELETE FROM tax_ledger WHERE sale_id=?', [req.params.id]);

    // ── Recompute total and update sales row ──────────────────────────
    const total_amount = items.reduce((sum, i) => sum + parseFloat(i.total || 0), 0);
    await conn.query(
      `UPDATE sales
         SET customer_id=?, salesman_id=?, delivery_by=?, date=?,
             total_amount=?, net_collectible=?, pending_amount=?
       WHERE id=?`,
      [customer_id, salesman_id || null, delivery_by || null, date,
       total_amount, total_amount, total_amount, req.params.id]
    );

    // ── Insert new items — with snapshot + inventory lock + journal ────
    for (const item of items) {
      const totalQty = parseInt(item.qty) + parseInt(item.bonus || 0);
      await deductInventoryOrThrow(conn, {
        productId: item.product_id,
        batchNo:   item.batch_no,
        qty:       totalQty,
        date,
        refType:   'sale',
        refId:     parseInt(req.params.id),
        note:      `Sale ${sale.invoice_no} — edit`,
      });
      const costSnapshot = await snapshotPurchaseRate(conn, item.product_id, item.batch_no);
      await conn.query(
        `INSERT INTO sale_items
           (sale_id, product_id, batch_no, pack_size, sale_rate,
            purchase_rate_snapshot, qty, bonus, discount_pct, tax_pct, total)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [req.params.id, item.product_id, item.batch_no, item.pack_size, item.sale_rate,
         costSnapshot, item.qty, item.bonus || 0,
         item.discount_pct || 0, item.tax_pct || 0, item.total]
      );
    }

    // ── Customer ledger + tax_ledger for the corrected sale ────────────
    await conn.query('UPDATE customers SET balance=balance+? WHERE id=?',
      [total_amount, customer_id]);
    const [custRows] = await conn.query(
      'SELECT balance FROM customers WHERE id=?', [customer_id]);
    await conn.query(
      `INSERT INTO customer_ledger
         (customer_id, date, invoice_no, description, dr, cr, balance,
          reference_type, reference_id)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [customer_id, date, sale.invoice_no, 'Sale', total_amount, 0,
       custRows[0].balance, 'sale', req.params.id]
    );

    for (const item of items) {
      const [prodTax] = await conn.query(
        'SELECT tax_applicable, sale_tax_pct FROM products WHERE id=?', [item.product_id]);
      if (prodTax[0]?.tax_applicable && parseFloat(prodTax[0].sale_tax_pct) > 0) {
        const taxRate = parseFloat(prodTax[0].sale_tax_pct);
        const taxableAmt = parseFloat(item.total);
        const taxAmt = taxableAmt * taxRate / 100;
        await conn.query(
          `INSERT INTO tax_ledger
             (sale_id, sale_item_id, product_id, sale_date, invoice_no,
              taxable_amount, tax_rate, tax_amount)
           VALUES (?,?,?,?,?,?,?,?)`,
          [req.params.id, null, item.product_id, date, sale.invoice_no,
           taxableAmt, taxRate, taxAmt]
        );
      }
    }

    await conn.commit();
    await logAudit(req, 'UPDATE', 'sale', req.params.id, `Updated invoice ${sale.invoice_no}`);
    res.json({ message: 'Sale updated' });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(err.status || 500).json({ message: err.message });
  } finally { conn.release(); }
});


// ═══════════════════════════════════════════════════════════════════════════
// DELETE /:id — Delete sale (blocked once any recovery has been recorded)
// ═══════════════════════════════════════════════════════════════════════════

router.delete('/:id', auth, async (req, res) => {
  const conn = await db.getConnection();
  await conn.beginTransaction();
  try {
    const [sRows] = await conn.query(
      'SELECT * FROM sales WHERE id=? FOR UPDATE', [req.params.id]);
    if (sRows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: 'Sale not found' });
    }
    const sale = sRows[0];
    if (sale.is_locked) {
      await conn.rollback();
      return res.status(403).json({
        message: 'Invoice is locked after recovery. Cannot delete.'
      });
    }

    // Restore stock (journal each restoration).
    const [items] = await conn.query(
      'SELECT * FROM sale_items WHERE sale_id=?', [req.params.id]);
    for (const item of items) {
      const totalQty = parseInt(item.qty) + parseInt(item.bonus || 0);
      await restoreInventory(conn, {
        productId: item.product_id,
        batchNo:   item.batch_no,
        qty:       totalQty,
        date:      sale.date,
        refType:   'sale',
        refId:     parseInt(req.params.id),
        note:      `Sale ${sale.invoice_no} — deleted`,
      });
    }

    await conn.query('UPDATE customers SET balance=balance-? WHERE id=?',
      [sale.total_amount, sale.customer_id]);
    await conn.query(
      'DELETE FROM customer_ledger WHERE reference_type=? AND reference_id=?',
      ['sale', req.params.id]);
    await conn.query('DELETE FROM tax_ledger WHERE sale_id=?', [req.params.id]);
    // sale_items cascade-delete via FK when sales is deleted.
    await conn.query('DELETE FROM sales WHERE id=?', [req.params.id]);

    await conn.commit();
    await logAudit(req, 'DELETE', 'sale', req.params.id, `Deleted invoice ${sale.invoice_no}`);
    res.json({ message: 'Sale deleted' });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(err.status || 500).json({ message: err.message });
  } finally { conn.release(); }
});


// ═══════════════════════════════════════════════════════════════════════════
// POST /mark-printed — stamp a batch of invoices as printed
// ───────────────────────────────────────────────────────────────────────────
// Called by the Bulk Print preview (frontend/BatchPrint.js) on the
// browser's `afterprint` event, once per resolved invoice_type in the
// batch. Idempotent: a second call on the same ids just updates
// printed_at to the newer timestamp and overwrites last_printed_type /
// last_printed_by — which is the desired behaviour for reprints.
//
// Batch cap of 200 mirrors the frontend hard-cap; the soft-warn at 50
// lives only on the client. Ids that no longer exist (deleted between
// selection and print) are silently ignored so a race can't 500 the
// call.
// ═══════════════════════════════════════════════════════════════════════════

const PRINT_TYPES = ['warranty', 'warranty10', 'non-warranty'];
const MARK_PRINTED_CAP = 200;

router.post('/mark-printed', auth, async (req, res) => {
  const { ids, type } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ message: 'ids must be a non-empty array' });
  }
  if (ids.length > MARK_PRINTED_CAP) {
    return res.status(400).json({
      message: `Batch cap is ${MARK_PRINTED_CAP} invoices per mark-printed call.`
    });
  }
  const numericIds = ids
    .map(id => parseInt(id, 10))
    .filter(n => Number.isFinite(n) && n > 0);
  if (numericIds.length === 0) {
    return res.status(400).json({ message: 'No valid ids provided.' });
  }
  if (!PRINT_TYPES.includes(type)) {
    return res.status(400).json({
      message: `Invalid invoice type. Expected one of: ${PRINT_TYPES.join(', ')}.`
    });
  }

  const conn = await db.getConnection();
  await conn.beginTransaction();
  try {
    const placeholders = numericIds.map(() => '?').join(',');
    const [result] = await conn.query(
      `UPDATE sales
         SET printed_at=NOW(),
             last_printed_type=?,
             last_printed_by=?
       WHERE id IN (${placeholders})`,
      [type, req.user?.id || null, ...numericIds]
    );
    await conn.commit();
    await logAudit(req, 'PRINT', 'sale', null,
      `Marked ${result.affectedRows} invoice(s) as printed (${type})`);
    res.json({ marked: result.affectedRows });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(err.status || 500).json({ message: err.message });
  } finally { conn.release(); }
});

module.exports = router;
