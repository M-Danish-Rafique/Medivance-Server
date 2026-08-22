const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const auth    = require('../middleware/auth');
const { logAudit } = require('../middleware/auditLog');
const { todayPKT, formatDatePKT, addMonthsPKT } = require('../utils/dateUtils');

// ─── Recovery lifecycle (post 2026-08 refactor) ────────────────────────────
// A recovery event captures three kinds of activity against a single sale
// invoice: cash collected, discount granted at recovery time, and product
// returns. Cross-invoice returns are no longer supported at any surface —
// every return line references the same invoice being settled.
//
// Invariants maintained by every write in this file:
//   1. sales.total_discount     = SUM(recoveries.total_discount     WHERE sale_id=s.id)
//   2. sales.total_return_amount= SUM(recoveries.total_return_amount WHERE sale_id=s.id)
//   3. sales.total_recovered    = SUM(recoveries.net_collected      WHERE sale_id=s.id)
//   4. SUM(sale_items.recovery_discount) per invoice == sales.total_discount
//   5. SUM(sale_items.recovered_amount)  per invoice == sales.total_recovered
//   6. sale_items.returned_qty = SUM(return_items.qty_returned WHERE sale_item_id=si.id)
//   7. sale_items.returned_qty <= sale_items.qty                (CHECK in DB)
//   8. return_items.return_rate <= per-unit paid by customer, less per-unit
//      share of recovery-time discount already granted on that line.
// Invariants 1–3 and 6 are recomputed inside `rebuildSaleFromRecoveries`.
// Invariants 4–5 are the job of `reprorateSaleItems`, called from within
// `rebuildSaleFromRecoveries`. Invariants 7–8 are enforced at write time.
//
// Locking:
//   - A sale is locked (sales.is_locked=1) the moment its first recovery
//     event is inserted. This blocks further sales-side edits/deletes.
//   - If a recovery is edited down to zero (no discount, no return, no
//     cash), the client is expected to confirm and the server then removes
//     the entry, reverses its side effects, and rebuilds. If the removal
//     leaves the invoice with zero cumulative activity, the invoice
//     auto-unlocks and becomes editable/deletable again. Otherwise it
//     stays locked. See PUT /:id.
//
// Concurrency:
//   - Every write path opens with `SELECT sales.* WHERE id=? FOR UPDATE`
//     so two simultaneous recovery submissions on the same invoice
//     serialize behind each other instead of racing.
//
// Audit:
//   - Every mutating action writes an `audit_logs` row via `logAudit`.

// Paisa-level tolerance for money comparisons.
const PAISA = 0.005;

// Round to 2 decimal places.
const money = (n) => Math.round(parseFloat(n || 0) * 100) / 100;

// What the customer actually paid per unit for a sale_item — tax-inclusive,
// net of the invoice-time discount (`discount_pct` on the sale_item).
// Used as the basis for the return-rate cap and for proration weight.
function unitPaid(si) {
  const rate = parseFloat(si.sale_rate || 0);
  const disc = parseFloat(si.discount_pct || 0);
  const tax  = parseFloat(si.tax_pct || 0);
  return money(rate * (1 - disc / 100) * (1 + tax / 100));
}

// Per-unit return-rate cap (Q3 + Q4): the customer gets back what they
// actually paid per unit, minus their per-unit share of any discount
// already granted at recovery time on this line.
//   cap = unit_paid − (line_cumulative_recovery_discount / kept_qty)
//
// The divisor is REMAINING kept qty (qty − returned_qty), not original
// qty. That way discount granted after some units have already been
// returned only spreads across the units still with the customer,
// instead of leaking a share onto units that are gone. Without this,
// a discount grant that follows a partial return would push the
// per-unit cap up on the remaining units (they'd carry both their own
// share and the returned units' share of new discount), producing an
// over-refund on the next return event. See the 2026-08-22 audit note.
//
// A caller enforcing this at write time must pass the recovery_discount
// value that will be in effect AFTER the current event is applied — not
// the pre-event value — otherwise a fresh recovery-time discount can slip
// past the check on the same event.
function returnRateCap(si, cumulativeRecoveryDiscount) {
  const paidPerUnit = unitPaid(si);
  const keptQty = parseInt(si.qty || 0, 10) - parseInt(si.returned_qty || 0, 10);
  const perUnitRecDisc = keptQty > 0
    ? money(cumulativeRecoveryDiscount / keptQty)
    : 0;
  return Math.max(0, money(paidPerUnit - perUnitRecDisc));
}

// Re-prorate cumulative invoice-level discount and cash across sale_items
// by each line's tax-inclusive total (`sale_items.total`) share of the
// invoice. Rounding residuals land on the last line so the sum equals the
// invoice-level figure exactly. Called from `rebuildSaleFromRecoveries`.
async function reprorateSaleItems(conn, saleId, saleTotalDiscount, saleTotalRecovered) {
  const [items] = await conn.query(
    'SELECT id, total FROM sale_items WHERE sale_id=? ORDER BY id',
    [saleId]
  );
  if (!items.length) return;
  const lineSum = items.reduce((s, i) => s + parseFloat(i.total || 0), 0);
  if (lineSum <= 0) {
    // Every line total is 0 (fully-shrunk legacy invoice). Zero out both
    // cumulatives on every line so invariants 4 and 5 hold.
    for (const it of items) {
      await conn.query(
        'UPDATE sale_items SET recovery_discount=0, recovered_amount=0 WHERE id=?',
        [it.id]
      );
    }
    return;
  }
  let allocatedDisc = 0, allocatedRec = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const isLast = i === items.length - 1;
    let discShare, recShare;
    if (isLast) {
      discShare = money(saleTotalDiscount - allocatedDisc);
      recShare  = money(saleTotalRecovered - allocatedRec);
    } else {
      const weight = parseFloat(item.total) / lineSum;
      discShare = money(saleTotalDiscount * weight);
      recShare  = money(saleTotalRecovered * weight);
      allocatedDisc += discShare;
      allocatedRec  += recShare;
    }
    await conn.query(
      'UPDATE sale_items SET recovery_discount=?, recovered_amount=? WHERE id=?',
      [discShare, recShare, item.id]
    );
  }
}

// Rebuild every sale-level and per-line cumulative for an invoice from the
// actual set of `recoveries` rows that reference it. This is the single
// source of truth for keeping the DB consistent after any change to a
// recovery event (insert, edit, or deletion). Applies the auto-unlock
// rule at the end.
async function rebuildSaleFromRecoveries(conn, saleId) {
  const [saleRows] = await conn.query('SELECT * FROM sales WHERE id=? FOR UPDATE', [saleId]);
  if (!saleRows.length) throw Object.assign(new Error('Sale not found'), { status: 404 });
  const sale = saleRows[0];
  const invoiceTotal = parseFloat(sale.total_amount);

  const [recs] = await conn.query(
    `SELECT id, total_discount, total_return_amount, net_collected
       FROM recoveries WHERE sale_id=? ORDER BY date ASC, id ASC`,
    [saleId]
  );

  let runDisc = 0, runReturn = 0, runRecovered = 0;
  let finalNet = invoiceTotal, finalPending = invoiceTotal;
  for (const r of recs) {
    runDisc      += parseFloat(r.total_discount || 0);
    runReturn    += parseFloat(r.total_return_amount || 0);
    runRecovered += parseFloat(r.net_collected || 0);
    const netCollectible = money(invoiceTotal - runDisc - runReturn);
    if (netCollectible < -PAISA) {
      throw Object.assign(new Error(
        'Discount + returns exceed invoice total after this change'
      ), { status: 400 });
    }
    // NOTE: we deliberately do NOT check runRecovered <= netCollectible
    // here. When a later return retroactively pushes netCollectible below
    // the cash that was legitimately collected in an earlier recovery,
    // the customer simply ends up with store credit (already recorded on
    // customer_ledger by the return itself). Rejecting that case would
    // block a valid business scenario — e.g. "customer paid, then later
    // returned goods worth more than what was still owed". The
    // this-event-only cash cap is enforced at insert / edit time in POST /
    // and PUT /:id, before we ever reach the rebuild.
    const pending = Math.max(0, money(netCollectible - runRecovered));
    await conn.query(
      'UPDATE recoveries SET net_collectible=?, pending_amount=? WHERE id=?',
      [netCollectible, pending, r.id]
    );
    finalNet = netCollectible;
    finalPending = pending;
  }
  runDisc      = money(runDisc);
  runReturn    = money(runReturn);
  runRecovered = money(runRecovered);

  const status = finalPending <= PAISA ? 'completed' : 'pending';

  // Auto-unlock rule (Q1 + user's #1 refinement): when there are no
  // recovery events left AND the cumulative activity on the invoice is
  // zero, unlock so the invoice becomes editable/deletable again. Any
  // remaining recovery keeps the invoice locked.
  const shouldUnlock =
    recs.length === 0 &&
    Math.abs(runDisc + runReturn + runRecovered) < PAISA;
  const isLocked = shouldUnlock ? 0 : 1;

  await conn.query(
    `UPDATE sales
       SET is_locked=?, total_discount=?, total_return_amount=?,
           net_collectible=?, total_recovered=?, pending_amount=?,
           recovery_status=?
     WHERE id=?`,
    [isLocked, runDisc, runReturn, finalNet, runRecovered, finalPending, status, saleId]
  );

  // Per-line cumulatives from re-proration + return_items sum.
  await reprorateSaleItems(conn, saleId, runDisc, runRecovered);
  await conn.query(
    `UPDATE sale_items si
        LEFT JOIN (
          SELECT sale_item_id, COALESCE(SUM(qty_returned), 0) AS q
            FROM return_items
           GROUP BY sale_item_id
        ) r ON r.sale_item_id = si.id
       SET si.returned_qty = COALESCE(r.q, 0)
     WHERE si.sale_id = ?`,
    [saleId]
  );

  return {
    invoiceTotal,
    totalDiscount: runDisc,
    totalReturn: runReturn,
    totalRecovered: runRecovered,
    netCollectible: finalNet,
    pending: finalPending,
    status,
    isLocked,
    unlocked: shouldUnlock,
  };
}

// Cheap invariant check called after every write. If either aggregate
// invariant (4 or 5) drifts, the transaction is aborted with a 500 so we
// never commit incoherent state.
async function assertInvariants(conn, saleId) {
  const [[row]] = await conn.query(
    `SELECT s.total_discount AS invD, s.total_recovered AS invR,
            COALESCE((SELECT SUM(recovery_discount) FROM sale_items WHERE sale_id=s.id), 0) AS itemD,
            COALESCE((SELECT SUM(recovered_amount)  FROM sale_items WHERE sale_id=s.id), 0) AS itemR
       FROM sales s
      WHERE s.id = ?`,
    [saleId]
  );
  if (Math.abs(parseFloat(row.invD) - parseFloat(row.itemD)) > PAISA) {
    throw Object.assign(new Error(
      `Integrity check failed: invoice discount (${row.invD}) does not equal sum of item discounts (${row.itemD})`
    ), { status: 500 });
  }
  if (Math.abs(parseFloat(row.invR) - parseFloat(row.itemR)) > PAISA) {
    throw Object.assign(new Error(
      `Integrity check failed: invoice recovered (${row.invR}) does not equal sum of item recovered (${row.itemR})`
    ), { status: 500 });
  }
}

// Undo a recovery event's side effects — used only by the empty-entry
// deletion path in PUT /:id. Reverses ledger + inventory, cascade-deletes
// the recovery (its recovery_items / return_items go via FK). Throws a
// clean 409 if a returned batch has been re-sold and reversal would drive
// inventory negative.
async function reverseRecoveryEffects(conn, recoveryId, sale) {
  const [ledgerRows] = await conn.query(
    `SELECT dr, cr FROM customer_ledger WHERE reference_type='payment' AND reference_id=?`,
    [recoveryId]
  );
  // Original writes did: balance = balance − (cr − dr) for each row.
  // Reverse the aggregate movement by adding the same net back.
  let netBalanceChange = 0;
  for (const lr of ledgerRows) {
    netBalanceChange += parseFloat(lr.cr || 0) - parseFloat(lr.dr || 0);
  }
  if (Math.abs(netBalanceChange) > PAISA) {
    await conn.query('UPDATE customers SET balance=balance+? WHERE id=?',
      [netBalanceChange, sale.customer_id]);
  }
  await conn.query(
    `DELETE FROM customer_ledger WHERE reference_type='payment' AND reference_id=?`,
    [recoveryId]
  );

  // Reverse the return-driven inventory restock. Block if any batch would
  // go negative (physical goods were re-sold since the return).
  const [oldReturns] = await conn.query(
    'SELECT product_id, batch_no, qty_returned FROM return_items WHERE recovery_id=?',
    [recoveryId]
  );
  for (const ret of oldReturns) {
    const qty = parseInt(ret.qty_returned);
    if (qty <= 0) continue;
    const [invRows] = await conn.query(
      'SELECT qty FROM inventory WHERE product_id=? AND batch_no=? FOR UPDATE',
      [ret.product_id, ret.batch_no]
    );
    const currentQty = invRows.length ? parseInt(invRows[0].qty) : 0;
    if (currentQty < qty) {
      throw Object.assign(new Error(
        `Cannot undo this recovery — ${qty} unit(s) of batch ${ret.batch_no} were restocked when the return was recorded, but only ${currentQty} unit(s) remain in inventory (the rest has already been re-sold). Contact admin.`
      ), { status: 409 });
    }
    await conn.query(
      'UPDATE inventory SET qty=qty-? WHERE product_id=? AND batch_no=?',
      [qty, ret.product_id, ret.batch_no]
    );
  }

  // FK cascade drops recovery_items and return_items.
  await conn.query('DELETE FROM recoveries WHERE id=?', [recoveryId]);
}

// Shared per-line validation used by both POST / and PUT /:id, run BEFORE
// any writes. Confirms:
//   - each discount is within its line's original_total
//   - each return qty is within (sale_item.qty − already_returned_elsewhere)
// The return_rate is NEVER read from the payload — it is always computed
// server-side from `returnRateCap(si, futureRecoveryDiscount)`. The
// returned Map<sale_item_id, computedRate> is used by the write paths so
// user-supplied rates cannot influence the amount refunded.
async function validateRecoveryPayload(conn, currentSale, recovery_items, return_items) {
  // Line-level discount caps.
  for (const item of (recovery_items || [])) {
    const disc = parseFloat(item.discount_given || 0);
    const cap  = parseFloat(item.original_total || 0);
    if (disc < 0 || disc > cap + PAISA) {
      throw Object.assign(new Error(
        `Discount given for "${item.product_name || 'an item'}" must be between 0 and its invoice amount (${cap}).`
      ), { status: 400 });
    }
  }

  // For each return line, look up its sale_item and validate qty.
  // Compute the server-authoritative return rate from the per-line
  // recovery_discount that WILL be in effect after this event lands.
  const perLineDisc = new Map(); // sale_item_id -> total discount from this event on that line
  for (const item of (recovery_items || [])) {
    const cur = perLineDisc.get(item.sale_item_id) || 0;
    perLineDisc.set(item.sale_item_id, cur + parseFloat(item.discount_given || 0));
  }

  const computedRates = new Map(); // sale_item_id -> return_rate
  for (const item of (return_items || [])) {
    const qtyRet = parseInt(item.qty_returned || 0);
    if (qtyRet <= 0) continue;
    if (!item.sale_item_id) {
      throw Object.assign(new Error('Return line is missing sale_item_id.'), { status: 400 });
    }
    const [siRows] = await conn.query('SELECT * FROM sale_items WHERE id=?', [item.sale_item_id]);
    if (!siRows.length) {
      throw Object.assign(new Error(
        `Return references an unknown sale line (id ${item.sale_item_id}).`
      ), { status: 400 });
    }
    const si = siRows[0];
    if (si.sale_id !== currentSale.id) {
      throw Object.assign(new Error(
        `Cross-invoice returns are not permitted. Return line for "${item.product_name || 'product'}" belongs to a different invoice.`
      ), { status: 400 });
    }

    // Double-return guard against everything already returned on this
    // sale_item across every other recovery event.
    const [sumRows] = await conn.query(
      'SELECT COALESCE(SUM(qty_returned),0) AS returned FROM return_items WHERE sale_item_id=?',
      [item.sale_item_id]
    );
    const alreadyReturnedElsewhere = parseInt(sumRows[0].returned, 10);
    const remaining = parseInt(si.qty, 10) - alreadyReturnedElsewhere;
    if (qtyRet > remaining) {
      throw Object.assign(new Error(
        `Return qty for "${item.product_name || 'product'}" exceeds remaining returnable quantity (${Math.max(0, remaining)}).`
      ), { status: 400 });
    }

    // Server-computed return rate. Uses the per-line recovery_discount
    // that will be in effect after this event's discount contribution.
    const futureRecDisc =
      parseFloat(si.recovery_discount || 0) + (perLineDisc.get(item.sale_item_id) || 0);
    const computedRate = returnRateCap(si, futureRecDisc);
    computedRates.set(item.sale_item_id, computedRate);
  }

  return computedRates;
}

// Expiry validation (unchanged from previous version). Returns an array of
// warnings for admin-override cases, throws for hard-block cases.
async function validateReturnExpiries(conn, return_items, isAdmin) {
  const warnings = [];
  for (const item of (return_items || [])) {
    if (!item.qty_returned || parseInt(item.qty_returned) <= 0) continue;
    const [invRows] = await conn.query(
      'SELECT exp_date FROM inventory WHERE product_id=? AND batch_no=?',
      [item.product_id, item.batch_no]
    );
    if (!invRows.length || !invRows[0].exp_date) continue;

    const expiryStr = String(invRows[0].exp_date).slice(0, 10);
    const threshold = addMonthsPKT(expiryStr, -5);
    if (todayPKT() <= threshold) continue;

    const [pRows] = await conn.query('SELECT name FROM products WHERE id=?', [item.product_id]);
    const pName = pRows[0]?.name || `Product ID ${item.product_id}`;
    const isExpired = todayPKT().slice(0, 7) > expiryStr.slice(0, 7);
    if (isExpired) {
      throw Object.assign(new Error(
        `Return not allowed for "${pName}" (Batch: ${item.batch_no}). Product expired ${formatDatePKT(expiryStr)}.`
      ), { status: 400 });
    }
    if (!isAdmin) {
      throw Object.assign(new Error(
        `Return not allowed for "${pName}" (Batch: ${item.batch_no}). Product expires ${formatDatePKT(expiryStr)} — within 5 months of expiry. Return window has passed.`
      ), { status: 400 });
    }
    warnings.push(
      `"${pName}" (Batch: ${item.batch_no}) expires ${formatDatePKT(expiryStr)} — within 5 months of expiry. Returned anyway (admin override).`
    );
  }
  return warnings;
}


// ═══════════════════════════════════════════════════════════════════════════
// READ endpoints
// ═══════════════════════════════════════════════════════════════════════════

router.get('/', auth, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT r.*, s.invoice_no, s.date as sale_date, s.total_amount as invoice_total,
             s.total_recovered as invoice_total_recovered, s.pending_amount as invoice_pending_amount,
             s.recovery_status as invoice_recovery_status,
             c.name as customer_name, e.name as salesman_name
      FROM recoveries r
      JOIN sales s ON r.sale_id = s.id
      JOIN customers c ON s.customer_id = c.id
      LEFT JOIN employees e ON r.salesman_id = e.id
      ORDER BY r.date DESC, r.id DESC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Payment history for a single invoice.
router.get('/history/:saleId', auth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT r.id, r.date, r.notes, r.total_discount, r.total_return_amount,
              r.net_collectible, r.net_collected, r.pending_amount, r.created_at,
              e.name as salesman_name
       FROM recoveries r
       LEFT JOIN employees e ON r.salesman_id = e.id
       WHERE r.sale_id=?
       ORDER BY r.date ASC, r.id ASC`,
      [req.params.saleId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Quick Recovery: list pending invoices for fast end-of-day collection.
router.get('/quick-list', auth, async (req, res) => {
  try {
    const { date_from, date_to, salesman_id, supplier_id } = req.query;
    let sql = `
      SELECT s.id, s.invoice_no, s.date, s.total_amount, s.pending_amount,
             s.recovery_status, s.salesman_id, s.delivery_by,
             c.name as customer_name
      FROM sales s
      JOIN customers c ON s.customer_id = c.id
      WHERE s.recovery_status = 'pending'
    `;
    const params = [];
    if (date_from) { sql += ' AND s.date >= ?'; params.push(date_from); }
    if (date_to)   { sql += ' AND s.date <= ?'; params.push(date_to); }
    if (salesman_id) { sql += ' AND s.salesman_id = ?'; params.push(salesman_id); }
    if (supplier_id) { sql += ' AND s.delivery_by = ?'; params.push(supplier_id); }
    sql += ' ORDER BY s.date ASC, s.invoice_no ASC';
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Quick Return: list fully-settled invoices eligible for a standalone
// return. Same filter shape as before this refactor.
router.get('/quick-return-list', auth, async (req, res) => {
  try {
    const { date_from, date_to, salesman_id, supplier_id, customer_id, invoice_no } = req.query;
    let sql = `
      SELECT s.id, s.invoice_no, s.date, s.total_amount, s.total_recovered,
             s.total_return_amount, s.recovery_status, s.salesman_id, s.delivery_by,
             c.id as customer_id, c.name as customer_name
      FROM sales s
      JOIN customers c ON s.customer_id = c.id
      WHERE s.recovery_status = 'completed'
    `;
    const params = [];
    if (date_from) { sql += ' AND s.date >= ?'; params.push(date_from); }
    if (date_to)   { sql += ' AND s.date <= ?'; params.push(date_to); }
    if (salesman_id) { sql += ' AND s.salesman_id = ?'; params.push(salesman_id); }
    if (supplier_id) { sql += ' AND s.delivery_by = ?'; params.push(supplier_id); }
    if (customer_id) { sql += ' AND s.customer_id = ?'; params.push(customer_id); }
    if (invoice_no && invoice_no.trim()) { sql += ' AND s.invoice_no LIKE ?'; params.push(`%${invoice_no.trim()}%`); }
    sql += ' ORDER BY s.date DESC, s.invoice_no DESC LIMIT 200';
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/:id', auth, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT r.*, s.invoice_no, s.date as sale_date, s.total_amount as invoice_total,
             s.total_recovered as invoice_total_recovered, s.pending_amount as invoice_pending_amount,
             s.recovery_status as invoice_recovery_status,
             c.name as customer_name, e.name as salesman_name
      FROM recoveries r
      JOIN sales s ON r.sale_id = s.id
      JOIN customers c ON s.customer_id = c.id
      LEFT JOIN employees e ON r.salesman_id = e.id
      WHERE r.id=?`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Recovery not found' });
    const [recItems] = await db.query(
      `SELECT ri.*, p.name as product_name
         FROM recovery_items ri
         JOIN products p ON ri.product_id = p.id
        WHERE ri.recovery_id=?`,
      [req.params.id]
    );
    const [retItems] = await db.query(
      `SELECT rt.*, p.name as product_name, s.invoice_no as source_invoice,
              si.qty as current_sold_qty,
              (SELECT COALESCE(SUM(qty_returned), 0) FROM return_items
                WHERE sale_item_id = rt.sale_item_id AND recovery_id != rt.recovery_id) as already_returned_elsewhere
         FROM return_items rt
         JOIN products p ON rt.product_id = p.id
         JOIN sales s ON rt.sale_id = s.id
         LEFT JOIN sale_items si ON si.id = rt.sale_item_id
        WHERE rt.recovery_id=?`,
      [req.params.id]
    );
    res.json({ ...rows[0], recovery_items: recItems, return_items: retItems });
  } catch (err) { res.status(500).json({ message: err.message }); }
});


// ═══════════════════════════════════════════════════════════════════════════
// POST /bulk — Quick Recovery
// ═══════════════════════════════════════════════════════════════════════════
// Body: { date, entries: [{ invoice_no, discount }] }
// Each entry fully collects (remaining balance − discount) in one shot.
//
// Every entry is its own transaction — one failure does not roll back the
// others. The response's per-entry `success` flag tells the UI which ones
// went through.

router.post('/bulk', auth, async (req, res) => {
  const { date, entries } = req.body;
  if (!date) return res.status(400).json({ message: 'Date required' });
  if (!Array.isArray(entries) || !entries.length) {
    return res.status(400).json({ message: 'No invoices selected' });
  }

  const results = [];
  for (const entry of entries) {
    const invoiceNo = entry.invoice_no;
    const discount = Math.max(0, parseFloat(entry.discount) || 0);
    const conn = await db.getConnection();
    await conn.beginTransaction();
    try {
      const [sRows] = await conn.query(
        'SELECT * FROM sales WHERE invoice_no=? FOR UPDATE',
        [invoiceNo]
      );
      if (!sRows.length) {
        throw Object.assign(new Error('Invoice not found'), { status: 404 });
      }
      const sale = sRows[0];
      if (sale.recovery_status === 'completed') {
        throw Object.assign(new Error('Already fully recovered'), { status: 400 });
      }

      const priorDiscount = parseFloat(sale.total_discount || 0);
      const priorReturn   = parseFloat(sale.total_return_amount || 0);
      const priorRecovered= parseFloat(sale.total_recovered || 0);
      const invoiceTotal  = parseFloat(sale.total_amount);

      const maxAdditionalDisc = money(
        invoiceTotal - priorDiscount - priorReturn - priorRecovered
      );
      if (discount > maxAdditionalDisc + PAISA) {
        throw Object.assign(new Error(
          `Discount exceeds remaining invoice balance (${maxAdditionalDisc.toFixed(2)})`
        ), { status: 400 });
      }

      // Quick Recovery collects whatever is still owed after the discount.
      const netCollectible = money(invoiceTotal - priorDiscount - discount - priorReturn);
      const recoveredAmount = Math.max(0, money(netCollectible - priorRecovered));

      if (discount <= 0 && recoveredAmount <= 0) {
        throw Object.assign(new Error(
          'Nothing to collect on this invoice.'
        ), { status: 400 });
      }

      // Insert the recovery event first (per-event snapshot columns get
      // finalized inside rebuildSaleFromRecoveries below).
      const [ins] = await conn.query(
        `INSERT INTO recoveries
           (sale_id, salesman_id, date, notes, total_discount,
            total_return_amount, net_collectible, net_collected, pending_amount)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [sale.id, sale.delivery_by || null, date, 'Quick Recovery',
         discount, 0, netCollectible, recoveredAmount, 0]
      );
      const recoveryId = ins.insertId;

      // Per-line discount breakdown (prorated across sale_items by
      // tax-inclusive line total share, matching the reprorate rule).
      if (discount > 0) {
        const [items] = await conn.query(
          `SELECT id, product_id, batch_no, total
             FROM sale_items
            WHERE sale_id=? AND total > 0
            ORDER BY id`,
          [sale.id]
        );
        const lineSum = items.reduce((s, i) => s + parseFloat(i.total), 0);
        let allocated = 0;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const isLast = i === items.length - 1;
          const share = isLast
            ? money(discount - allocated)
            : money(discount * (parseFloat(item.total) / lineSum));
          allocated += share;
          await conn.query(
            `INSERT INTO recovery_items
               (recovery_id, sale_item_id, product_id, batch_no,
                original_total, discount_given, final_amount)
             VALUES (?,?,?,?,?,?,?)`,
            [recoveryId, item.id, item.product_id, item.batch_no,
             item.total, share, money(parseFloat(item.total) - share)]
          );
        }
        await conn.query('UPDATE customers SET balance=balance-? WHERE id=?',
          [discount, sale.customer_id]);
        const [[c1]] = await conn.query(
          'SELECT balance FROM customers WHERE id=?', [sale.customer_id]);
        await conn.query(
          `INSERT INTO customer_ledger
             (customer_id, date, invoice_no, description, dr, cr, balance,
              reference_type, reference_id)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [sale.customer_id, date, sale.invoice_no,
           `Discount on Invoice ${sale.invoice_no} (Quick Recovery)`,
           0, discount, c1.balance, 'payment', recoveryId]
        );
      }

      if (recoveredAmount > 0) {
        await conn.query('UPDATE customers SET balance=balance-? WHERE id=?',
          [recoveredAmount, sale.customer_id]);
        const [[c2]] = await conn.query(
          'SELECT balance FROM customers WHERE id=?', [sale.customer_id]);
        await conn.query(
          `INSERT INTO customer_ledger
             (customer_id, date, invoice_no, description, dr, cr, balance,
              reference_type, reference_id)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [sale.customer_id, date, sale.invoice_no,
           `Cash Collected — Invoice ${sale.invoice_no} (Quick Recovery)`,
           0, recoveredAmount, c2.balance, 'payment', recoveryId]
        );
      }

      // Rebuild + verify integrity.
      await rebuildSaleFromRecoveries(conn, sale.id);
      await assertInvariants(conn, sale.id);

      await conn.commit();
      await logAudit(req, 'CREATE', 'recovery', recoveryId,
        `Quick Recovery on invoice ${sale.invoice_no}: discount ${discount}, recovered ${recoveredAmount}`
      );
      results.push({ invoice_no: invoiceNo, success: true, recovered: recoveredAmount, discount });
    } catch (err) {
      await conn.rollback();
      results.push({ invoice_no: invoiceNo, success: false, message: err.message });
    } finally { conn.release(); }
  }

  const failed = results.filter(r => !r.success);
  res.status(failed.length && failed.length === results.length ? 400 : 200).json({
    results,
    successCount: results.length - failed.length,
    failCount: failed.length,
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// POST / — Detailed recovery / return
// ═══════════════════════════════════════════════════════════════════════════
// Body: {
//   sale_id, salesman_id, date, notes,
//   recovery_items: [{ sale_item_id, product_id, batch_no, original_total,
//                      discount_given, final_amount, product_name }],
//   return_items:   [{ sale_item_id, product_id, batch_no, qty_returned,
//                      return_rate, return_amount, product_name }],
//   amount_recovered
// }
// All returns must reference sale_items belonging to `sale_id`. Cross-
// invoice returns are rejected in `validateRecoveryPayload`.

router.post('/', auth, async (req, res) => {
  const conn = await db.getConnection();
  await conn.beginTransaction();
  try {
    const {
      sale_id, salesman_id, date, notes,
      recovery_items, return_items, amount_recovered,
    } = req.body;
    if (!sale_id || !date) {
      return res.status(400).json({ message: 'Sale and date required' });
    }

    const [sRows] = await conn.query(
      'SELECT * FROM sales WHERE id=? FOR UPDATE', [sale_id]);
    if (!sRows.length) return res.status(404).json({ message: 'Sale not found' });
    const currentSale = sRows[0];

    // A completed invoice can still take a pure return (Quick Return flow)
    // but never a new discount or new cash.
    if (currentSale.recovery_status === 'completed') {
      const wantsDiscount = (recovery_items || []).some(i => parseFloat(i.discount_given || 0) > 0);
      const wantsCash = parseFloat(amount_recovered || 0) > 0;
      if (wantsDiscount || wantsCash) {
        await conn.rollback();
        return res.status(400).json({
          message: `Invoice ${currentSale.invoice_no} is already fully recovered.`
        });
      }
    }

    const isAdmin = req.user?.role === 'admin';
    const expiryWarnings = await validateReturnExpiries(conn, return_items, isAdmin);
    const computedRates = await validateRecoveryPayload(conn, currentSale, recovery_items, return_items);

    // Event-level (this recovery only) figures. eventReturnAmount uses the
    // server-computed rates so user-supplied return_rate values are ignored.
    const eventDiscount = (recovery_items || []).reduce(
      (s, i) => s + parseFloat(i.discount_given || 0), 0
    );
    const validReturnItems = (return_items || [])
      .filter(i => parseInt(i.qty_returned || 0) > 0);
    const eventReturnAmount = validReturnItems.reduce(
      (s, i) => s + parseInt(i.qty_returned) * (computedRates.get(i.sale_item_id) || 0), 0
    );

    const priorDiscount   = parseFloat(currentSale.total_discount || 0);
    const priorReturn     = parseFloat(currentSale.total_return_amount || 0);
    const priorRecovered  = parseFloat(currentSale.total_recovered || 0);
    const invoiceTotal    = parseFloat(currentSale.total_amount);

    const newTotalDiscount = money(priorDiscount + eventDiscount);
    const newTotalReturn   = money(priorReturn   + eventReturnAmount);
    const netCollectible   = money(invoiceTotal - newTotalDiscount - newTotalReturn);
    if (netCollectible < -PAISA) {
      await conn.rollback();
      return res.status(400).json({
        message: 'Discount and returns exceed invoice total'
      });
    }
    // Floor pending at 0 so a return that overshoots what's still owed
    // (customer is now owed money back, credit note in ledger) doesn't
    // block the recovered-amount validation below.
    const pendingBeforeThisPayment = Math.max(0, money(netCollectible - priorRecovered));

    let recoveredAmount = 0;
    if (amount_recovered !== undefined && amount_recovered !== null && amount_recovered !== '') {
      recoveredAmount = parseFloat(amount_recovered);
      if (Number.isNaN(recoveredAmount) || recoveredAmount < 0) {
        await conn.rollback();
        return res.status(400).json({
          message: 'Recovered amount must be zero or greater'
        });
      }
      if (recoveredAmount > pendingBeforeThisPayment + PAISA) {
        await conn.rollback();
        return res.status(400).json({
          message: `Recovered amount cannot exceed pending balance (${pendingBeforeThisPayment.toFixed(2)})`
        });
      }
    }

    if (!(recovery_items || []).length && !validReturnItems.length && recoveredAmount <= 0) {
      await conn.rollback();
      return res.status(400).json({
        message: 'Enter at least one discount, return, or recovered amount'
      });
    }

    // Insert the recovery event. Per-event snapshot columns are finalized
    // by rebuildSaleFromRecoveries below.
    const [ins] = await conn.query(
      `INSERT INTO recoveries
         (sale_id, salesman_id, date, notes, total_discount,
          total_return_amount, net_collectible, net_collected, pending_amount)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [sale_id, salesman_id || null, date, notes || null,
       eventDiscount, eventReturnAmount, netCollectible, recoveredAmount, 0]
    );
    const recoveryId = ins.insertId;

    // Recovery items (per-line discount snapshots).
    for (const item of (recovery_items || [])) {
      await conn.query(
        `INSERT INTO recovery_items
           (recovery_id, sale_item_id, product_id, batch_no,
            original_total, discount_given, final_amount)
         VALUES (?,?,?,?,?,?,?)`,
        [recoveryId, item.sale_item_id, item.product_id, item.batch_no,
         item.original_total, item.discount_given || 0, item.final_amount]
      );
    }

    // Discount ledger row.
    if (eventDiscount > 0) {
      await conn.query('UPDATE customers SET balance=balance-? WHERE id=?',
        [eventDiscount, currentSale.customer_id]);
      const [[cd]] = await conn.query(
        'SELECT balance FROM customers WHERE id=?', [currentSale.customer_id]);
      await conn.query(
        `INSERT INTO customer_ledger
           (customer_id, date, invoice_no, description, dr, cr, balance,
            reference_type, reference_id)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [currentSale.customer_id, date, currentSale.invoice_no,
         `Discount on Invoice ${currentSale.invoice_no}`,
         0, eventDiscount, cd.balance, 'payment', recoveryId]
      );
    }

    // Return items (current-invoice only). Each restocks its batch and
    // credits the customer via ledger. Return rate is ALWAYS server-
    // computed (from validateRecoveryPayload) — any rate the client sent
    // is discarded.
    for (const item of validReturnItems) {
      const qtyRet = parseInt(item.qty_returned);
      const retRate = computedRates.get(item.sale_item_id) || 0;
      const retAmt = money(qtyRet * retRate);

      await conn.query('UPDATE inventory SET qty=qty+? WHERE product_id=? AND batch_no=?',
        [qtyRet, item.product_id, item.batch_no]);

      await conn.query(
        `INSERT INTO return_items
           (recovery_id, sale_id, sale_item_id, product_id, batch_no,
            qty_returned, return_rate, return_amount)
         VALUES (?,?,?,?,?,?,?,?)`,
        [recoveryId, sale_id, item.sale_item_id, item.product_id,
         item.batch_no, qtyRet, retRate, retAmt]
      );

      if (retAmt > 0) {
        await conn.query('UPDATE customers SET balance=balance-? WHERE id=?',
          [retAmt, currentSale.customer_id]);
        const [[cr]] = await conn.query(
          'SELECT balance FROM customers WHERE id=?', [currentSale.customer_id]);
        await conn.query(
          `INSERT INTO customer_ledger
             (customer_id, date, invoice_no, description, dr, cr, balance,
              reference_type, reference_id)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [currentSale.customer_id, date, currentSale.invoice_no,
           `Return — ${qtyRet} unit(s) of ${item.product_name || 'product'} from ${currentSale.invoice_no}`,
           0, retAmt, cr.balance, 'payment', recoveryId]
        );
      }
    }

    // Cash-collected ledger row.
    if (recoveredAmount > 0) {
      await conn.query('UPDATE customers SET balance=balance-? WHERE id=?',
        [recoveredAmount, currentSale.customer_id]);
      const [[cc]] = await conn.query(
        'SELECT balance FROM customers WHERE id=?', [currentSale.customer_id]);
      const pendingAfter = Math.max(0, money(netCollectible - (priorRecovered + recoveredAmount)));
      const payDesc = pendingAfter > 0
        ? `Cash Collected — Invoice ${currentSale.invoice_no} (Pending: ${pendingAfter.toFixed(2)})${notes ? ' (' + notes + ')' : ''}`
        : `Cash Collected — Invoice ${currentSale.invoice_no}${notes ? ' (' + notes + ')' : ''}`;
      await conn.query(
        `INSERT INTO customer_ledger
           (customer_id, date, invoice_no, description, dr, cr, balance,
            reference_type, reference_id)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [currentSale.customer_id, date, currentSale.invoice_no, payDesc,
         0, recoveredAmount, cc.balance, 'payment', recoveryId]
      );
    }

    // Single source of truth: rebuild + verify.
    const summary = await rebuildSaleFromRecoveries(conn, sale_id);
    await assertInvariants(conn, sale_id);

    await conn.commit();
    await logAudit(req, 'CREATE', 'recovery', recoveryId,
      `Recovery on invoice ${currentSale.invoice_no}: discount ${eventDiscount}, returns ${eventReturnAmount}, recovered ${recoveredAmount}, pending ${summary.pending}, status ${summary.status}`
    );
    res.status(201).json({
      id: recoveryId,
      net_collectible: summary.netCollectible,
      amount_recovered: recoveredAmount,
      total_recovered: summary.totalRecovered,
      pending_amount: summary.pending,
      net_collected: recoveredAmount,
      recovery_status: summary.status,
      expiry_warnings: expiryWarnings.length ? expiryWarnings : undefined,
    });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(err.status || 500).json({ message: err.message });
  } finally { conn.release(); }
});


// ═══════════════════════════════════════════════════════════════════════════
// PUT /:id — Admin edit of a recovery event (also handles empty-entry delete)
// ═══════════════════════════════════════════════════════════════════════════
// If the edit reduces this recovery's discount + return + cash to zero,
// the entry is DELETED (all side effects reversed) after the client has
// confirmed via `confirm_delete_if_empty: true` in the body. If the
// invoice is left with zero cumulative activity, it auto-unlocks. If
// undoing a return would drive an inventory batch negative (goods
// re-sold), the request is rejected with 409 — the recovery cannot be
// edited to empty until stock is corrected.

router.put('/:id', auth, async (req, res) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ message: 'Only an admin account can edit a recovery entry.' });
  }
  const conn = await db.getConnection();
  await conn.beginTransaction();
  try {
    const recoveryId = parseInt(req.params.id);
    const {
      date, notes, recovery_items, return_items, amount_recovered,
      confirm_delete_if_empty,
    } = req.body;
    if (!date) {
      await conn.rollback();
      return res.status(400).json({ message: 'Date required' });
    }

    const [recRows] = await conn.query('SELECT * FROM recoveries WHERE id=?', [recoveryId]);
    if (!recRows.length) {
      await conn.rollback();
      return res.status(404).json({ message: 'Recovery not found' });
    }
    const saleId = recRows[0].sale_id;
    const originalRecovery = recRows[0];

    const [sRows] = await conn.query('SELECT * FROM sales WHERE id=? FOR UPDATE', [saleId]);
    if (!sRows.length) {
      await conn.rollback();
      return res.status(404).json({ message: 'Sale not found' });
    }
    const currentSale = sRows[0];

    // Is this edit reducing the entry to zero across the board?
    // Emptiness keys off qty_returned (not rate × qty) because the return
    // rate is now server-computed — a legitimate return line has qty > 0
    // regardless of what the payload's return_rate field says.
    const nextDiscount = (recovery_items || []).reduce(
      (s, i) => s + parseFloat(i.discount_given || 0), 0
    );
    const nextReturnQty = (return_items || [])
      .reduce((s, i) => s + parseInt(i.qty_returned || 0), 0);
    const nextCash = parseFloat(amount_recovered || 0);
    const isEmpty =
      Math.abs(nextDiscount) < PAISA &&
      nextReturnQty          === 0 &&
      Math.abs(nextCash)     < PAISA;

    // ─── Empty-entry path: delete-with-reversal ─────────────────────────
    if (isEmpty) {
      if (!confirm_delete_if_empty) {
        // Critical: release the FOR UPDATE lock on the sale row before
        // sending the 409, otherwise the next request touching this same
        // invoice hangs on `SELECT ... FOR UPDATE` until
        // innodb_lock_wait_timeout fires (≥50s), and the pool later hands
        // this connection back out with an orphaned open transaction.
        await conn.rollback();
        return res.status(409).json({
          message:
            'This edit will leave the recovery entry empty. Confirming will delete the entry entirely. If it is the last recovery on this invoice, the invoice will be unlocked for edits/deletion.',
          requires_confirmation: 'confirm_delete_if_empty',
        });
      }
      await reverseRecoveryEffects(conn, recoveryId, currentSale);
      const summary = await rebuildSaleFromRecoveries(conn, saleId);
      await assertInvariants(conn, saleId);
      await conn.commit();
      await logAudit(req, 'DELETE', 'recovery', recoveryId,
        `Empty-edit deletion of recovery on invoice ${currentSale.invoice_no}. ` +
        `Pre-delete snapshot: discount=${originalRecovery.total_discount}, ` +
        `returns=${originalRecovery.total_return_amount}, ` +
        `cash=${originalRecovery.net_collected}. Invoice ${summary.unlocked ? 'unlocked' : 'still locked'}.`
      );
      return res.json({
        deleted: true,
        unlocked: summary.unlocked,
        recovery_status: summary.status,
        pending_amount: summary.pending,
        total_recovered: summary.totalRecovered,
      });
    }

    // ─── Non-empty path: reverse old effects, apply new, rebuild ─────────
    await reverseRecoveryEffects(conn, recoveryId, currentSale);

    // The recovery row was cascade-deleted by reverseRecoveryEffects. Insert
    // a fresh one with the corrected values, reusing the same id so payment
    // history keeps its ordering. Insert-with-explicit-id is fine because
    // FKs to this row (recovery_items / return_items) were also deleted.
    const isAdmin = req.user?.role === 'admin';
    const expiryWarnings = await validateReturnExpiries(conn, return_items, isAdmin);
    const computedRates = await validateRecoveryPayload(conn, currentSale, recovery_items, return_items);

    const eventDiscount = money(nextDiscount);
    const eventReturnAmount = money(
      (return_items || [])
        .filter(i => parseInt(i.qty_returned || 0) > 0)
        .reduce((s, i) => s + parseInt(i.qty_returned) * (computedRates.get(i.sale_item_id) || 0), 0)
    );
    const recoveredAmount = money(nextCash);
    if (recoveredAmount < 0) {
      throw Object.assign(new Error('Recovered amount must be zero or greater'), { status: 400 });
    }

    // Explicit this-event cash cap (parallel to POST /). Since
    // reverseRecoveryEffects already dropped this recovery's rows, the
    // remaining `recoveries` on the sale represent OTHER events only.
    const [[otherAgg]] = await conn.query(
      `SELECT COALESCE(SUM(total_discount), 0)      AS otherDisc,
              COALESCE(SUM(total_return_amount), 0) AS otherReturn,
              COALESCE(SUM(net_collected), 0)       AS otherRecovered
         FROM recoveries WHERE sale_id=?`,
      [saleId]
    );
    const otherDisc      = parseFloat(otherAgg.otherDisc);
    const otherReturn    = parseFloat(otherAgg.otherReturn);
    const otherRecovered = parseFloat(otherAgg.otherRecovered);
    const invoiceTotalForEdit = parseFloat(currentSale.total_amount);
    const netAfterThis = money(
      invoiceTotalForEdit - (otherDisc + eventDiscount) - (otherReturn + eventReturnAmount)
    );
    if (netAfterThis < -PAISA) {
      throw Object.assign(new Error(
        'Discount + returns exceed invoice total after this edit'
      ), { status: 400 });
    }
    const pendingForThisCash = Math.max(0, money(netAfterThis - otherRecovered));
    if (recoveredAmount > pendingForThisCash + PAISA) {
      throw Object.assign(new Error(
        `Recovered amount cannot exceed pending balance (${pendingForThisCash.toFixed(2)}) available for this edit.`
      ), { status: 400 });
    }

    await conn.query(
      `INSERT INTO recoveries
         (id, sale_id, salesman_id, date, notes, total_discount,
          total_return_amount, net_collectible, net_collected, pending_amount)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [recoveryId, saleId, originalRecovery.salesman_id, date, notes || null,
       eventDiscount, eventReturnAmount, 0, recoveredAmount, 0]
    );

    for (const item of (recovery_items || [])) {
      if (parseFloat(item.discount_given || 0) <= 0) continue;
      await conn.query(
        `INSERT INTO recovery_items
           (recovery_id, sale_item_id, product_id, batch_no,
            original_total, discount_given, final_amount)
         VALUES (?,?,?,?,?,?,?)`,
        [recoveryId, item.sale_item_id, item.product_id, item.batch_no,
         item.original_total, item.discount_given, item.final_amount]
      );
    }

    if (eventDiscount > 0) {
      await conn.query('UPDATE customers SET balance=balance-? WHERE id=?',
        [eventDiscount, currentSale.customer_id]);
      const [[cd]] = await conn.query(
        'SELECT balance FROM customers WHERE id=?', [currentSale.customer_id]);
      await conn.query(
        `INSERT INTO customer_ledger
           (customer_id, date, invoice_no, description, dr, cr, balance,
            reference_type, reference_id)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [currentSale.customer_id, date, currentSale.invoice_no,
         `Discount on Invoice ${currentSale.invoice_no} (Edited)`,
         0, eventDiscount, cd.balance, 'payment', recoveryId]
      );
    }

    for (const item of (return_items || [])) {
      const qtyRet = parseInt(item.qty_returned || 0);
      if (qtyRet <= 0) continue;
      const retRate = computedRates.get(item.sale_item_id) || 0;
      const retAmt = money(qtyRet * retRate);

      await conn.query('UPDATE inventory SET qty=qty+? WHERE product_id=? AND batch_no=?',
        [qtyRet, item.product_id, item.batch_no]);

      await conn.query(
        `INSERT INTO return_items
           (recovery_id, sale_id, sale_item_id, product_id, batch_no,
            qty_returned, return_rate, return_amount)
         VALUES (?,?,?,?,?,?,?,?)`,
        [recoveryId, saleId, item.sale_item_id, item.product_id,
         item.batch_no, qtyRet, retRate, retAmt]
      );

      if (retAmt > 0) {
        await conn.query('UPDATE customers SET balance=balance-? WHERE id=?',
          [retAmt, currentSale.customer_id]);
        const [[cr]] = await conn.query(
          'SELECT balance FROM customers WHERE id=?', [currentSale.customer_id]);
        await conn.query(
          `INSERT INTO customer_ledger
             (customer_id, date, invoice_no, description, dr, cr, balance,
              reference_type, reference_id)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [currentSale.customer_id, date, currentSale.invoice_no,
           `Return — ${qtyRet} unit(s) of ${item.product_name || 'product'} from ${currentSale.invoice_no} (Edited)`,
           0, retAmt, cr.balance, 'payment', recoveryId]
        );
      }
    }

    if (recoveredAmount > 0) {
      await conn.query('UPDATE customers SET balance=balance-? WHERE id=?',
        [recoveredAmount, currentSale.customer_id]);
      const [[cc]] = await conn.query(
        'SELECT balance FROM customers WHERE id=?', [currentSale.customer_id]);
      const payDesc = `Cash Collected — Invoice ${currentSale.invoice_no} (Edited)${notes ? ' (' + notes + ')' : ''}`;
      await conn.query(
        `INSERT INTO customer_ledger
           (customer_id, date, invoice_no, description, dr, cr, balance,
            reference_type, reference_id)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [currentSale.customer_id, date, currentSale.invoice_no, payDesc,
         0, recoveredAmount, cc.balance, 'payment', recoveryId]
      );
    }

    const summary = await rebuildSaleFromRecoveries(conn, saleId);
    await assertInvariants(conn, saleId);

    await conn.commit();
    await logAudit(req, 'UPDATE', 'recovery', recoveryId,
      `Recovery on invoice ${currentSale.invoice_no} edited by admin: discount ${eventDiscount}, returns ${eventReturnAmount}, recovered ${recoveredAmount}, pending ${summary.pending}, status ${summary.status}`
    );
    res.json({
      id: recoveryId,
      net_collectible: summary.netCollectible,
      amount_recovered: recoveredAmount,
      total_recovered: summary.totalRecovered,
      pending_amount: summary.pending,
      net_collected: recoveredAmount,
      recovery_status: summary.status,
      expiry_warnings: expiryWarnings.length ? expiryWarnings : undefined,
    });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(err.status || 500).json({ message: err.message });
  } finally { conn.release(); }
});

module.exports = router;