const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const auth    = require('../middleware/auth');
const { logAudit } = require('../middleware/auditLog');
const { todayPKT, formatDatePKT, addMonthsPKT } = require('../utils/dateUtils');
const { assertSelectableEmployee } = require('../utils/masterEmployees');
const { fmtPKR } = require('../utils/salaryAdvances');

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

// Write per-row values for many rows of one table in a single statement:
// `UPDATE t SET a = CASE id WHEN ? THEN ? … END, … WHERE id IN (…)`.
// Every round trip to the database costs network latency inside an open
// transaction (locks held meanwhile), so the recovery paths never update
// row by row. `table` and `columns` are code constants, never user input.
async function updateRowsById(conn, table, columns, rows) {
  if (!rows.length) return;
  const params = [];
  const sets = columns.map((col) => {
    const whens = rows.map((row) => { params.push(row.id, row[col]); return 'WHEN ? THEN ?'; });
    return `${col} = CASE id ${whens.join(' ')} END`;
  });
  params.push(rows.map(row => row.id));
  await conn.query(`UPDATE ${table} SET ${sets.join(', ')} WHERE id IN (?)`, params);
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
    await conn.query(
      'UPDATE sale_items SET recovery_discount=0, recovered_amount=0 WHERE sale_id=?',
      [saleId]
    );
    return;
  }
  let allocatedDisc = 0, allocatedRec = 0;
  const shares = items.map((item, i) => {
    if (i === items.length - 1) {
      return {
        id: item.id,
        recovery_discount: money(saleTotalDiscount - allocatedDisc),
        recovered_amount:  money(saleTotalRecovered - allocatedRec),
      };
    }
    const weight = parseFloat(item.total) / lineSum;
    const discShare = money(saleTotalDiscount * weight);
    const recShare  = money(saleTotalRecovered * weight);
    allocatedDisc += discShare;
    allocatedRec  += recShare;
    return { id: item.id, recovery_discount: discShare, recovered_amount: recShare };
  });
  await updateRowsById(conn, 'sale_items', ['recovery_discount', 'recovered_amount'], shares);
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
  const snapshots = [];
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
    snapshots.push({ id: r.id, net_collectible: netCollectible, pending_amount: pending });
    finalNet = netCollectible;
    finalPending = pending;
  }
  await updateRowsById(conn, 'recoveries', ['net_collectible', 'pending_amount'], snapshots);
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
  // The correlated subquery reads only this invoice's return lines (index
  // fk_ret_sale_item). A derived table over all of return_items took shared
  // locks on every return in the system until commit, so any other user's
  // return or recovery waited behind this transaction (Quick Recovery
  // timeouts, 2026-10-15).
  await reprorateSaleItems(conn, saleId, runDisc, runRecovered);
  await conn.query(
    `UPDATE sale_items si
        SET si.returned_qty = (SELECT COALESCE(SUM(ri.qty_returned), 0)
                                 FROM return_items ri
                                WHERE ri.sale_item_id = si.id)
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
// Body: { date, entries: [{ invoice_no, discount, expected_pending? }] }
// Each entry fully collects (remaining balance − discount) in one shot.
//
// Every entry is its own transaction — one failure does not roll back the
// others. The response is always 200 for a valid request; each result's
// `success` flag and `code` tell the UI what happened to that invoice:
//   ALREADY_RECOVERED  the invoice is settled (often by an earlier attempt of
//                      this same save whose response never arrived), so
//                      nothing was recorded — a retry is always safe
//   BALANCE_CHANGED    `expected_pending` (the balance the operator saw) no
//                      longer matches; `pending_amount` carries the new one
//   NOT_FOUND · DISCOUNT_TOO_HIGH · NOTHING_TO_COLLECT · INVOICE_BUSY · FAILED
//
// Speed matters here: the client waits on this request, and every entry
// holds its invoice and customer rows locked until it commits. Each entry
// costs a fixed number of statements (no per-line round trips), all entries
// share one connection, and a row locked by another user is waited for at
// most 10 s (instead of the server's 50 s default) before the entry is
// reported as INVOICE_BUSY. A deadlock (InnoDB detects it at once and rolls
// this entry back) is retried after a short pause. The client sends
// SAVE_BATCH_SIZE (10) invoices per request (QuickRecovery.jsx) so progress
// stays visible.

const BULK_MAX_ENTRIES = 500;
const BULK_LOCK_WAIT_SECONDS = 10;
const BULK_MAX_ATTEMPTS = 3;
const LOCK_CONFLICT_ERRORS = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);
const RETRYABLE_LOCK_ERRORS = new Set(['ER_LOCK_DEADLOCK']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const entryError = (status, code, message, extra = {}) =>
  Object.assign(new Error(message), { status, code, ...extra });

// One Quick Recovery entry, inside the caller's open transaction.
async function settleQuickRecoveryEntry(conn, entry, date) {
  const invoiceNo = String(entry.invoice_no ?? '').trim();
  const discount = money(Math.max(0, parseFloat(entry.discount) || 0));

  const [sRows] = await conn.query(
    'SELECT * FROM sales WHERE invoice_no=? FOR UPDATE',
    [invoiceNo]
  );
  if (!sRows.length) {
    throw entryError(404, 'NOT_FOUND', 'Invoice not found.');
  }
  const sale = sRows[0];
  if (sale.recovery_status === 'completed') {
    throw entryError(409, 'ALREADY_RECOVERED',
      'The invoice is already fully recovered. Nothing was recorded.');
  }

  const priorDiscount = parseFloat(sale.total_discount || 0);
  const priorReturn   = parseFloat(sale.total_return_amount || 0);
  const priorRecovered= parseFloat(sale.total_recovered || 0);
  const invoiceTotal  = parseFloat(sale.total_amount);

  const maxAdditionalDisc = money(
    invoiceTotal - priorDiscount - priorReturn - priorRecovered
  );
  const pendingNow = Math.max(0, maxAdditionalDisc);

  // The operator confirmed an amount computed from the balance on screen.
  // If another recovery or return changed it since, collecting "whatever is
  // still owed" would record a different sum than the one confirmed.
  const expected = entry.expected_pending;
  if (expected !== undefined && expected !== null && expected !== ''
      && Math.abs(money(expected) - pendingNow) > PAISA) {
    throw entryError(409, 'BALANCE_CHANGED',
      `The balance changed to ${fmtPKR(pendingNow)} after the list was loaded. Check the amount and save again.`,
      { pending_amount: pendingNow });
  }

  if (discount > maxAdditionalDisc + PAISA) {
    throw entryError(400, 'DISCOUNT_TOO_HIGH',
      `The discount exceeds the invoice balance of ${fmtPKR(pendingNow)}.`);
  }

  // Quick Recovery collects whatever is still owed after the discount.
  const netCollectible = money(invoiceTotal - priorDiscount - discount - priorReturn);
  const recoveredAmount = Math.max(0, money(netCollectible - priorRecovered));

  if (discount <= 0 && recoveredAmount <= 0) {
    throw entryError(400, 'NOTHING_TO_COLLECT', 'Nothing is left to collect on this invoice.');
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
    const rows = items.map((item, i) => {
      const share = i === items.length - 1
        ? money(discount - allocated)
        : money(discount * (parseFloat(item.total) / lineSum));
      allocated += share;
      return [recoveryId, item.id, item.product_id, item.batch_no,
              item.total, share, money(parseFloat(item.total) - share)];
    });
    if (rows.length) {
      await conn.query(
        `INSERT INTO recovery_items
           (recovery_id, sale_item_id, product_id, batch_no,
            original_total, discount_given, final_amount)
         VALUES ?`,
        [rows]
      );
    }
  }

  // Balance and ledger together: one balance update for discount + cash,
  // then both ledger rows in one insert. The discount row carries the
  // balance after the discount only, exactly as two separate steps would.
  await conn.query('UPDATE customers SET balance=balance-? WHERE id=?',
    [money(discount + recoveredAmount), sale.customer_id]);
  const [[cust]] = await conn.query(
    'SELECT balance FROM customers WHERE id=?', [sale.customer_id]);
  const closing = money(cust.balance);
  const ledgerRows = [];
  if (discount > 0) {
    ledgerRows.push([sale.customer_id, date, sale.invoice_no,
      `Discount on Invoice ${sale.invoice_no} (Quick Recovery)`,
      0, discount, money(closing + recoveredAmount), 'payment', recoveryId]);
  }
  if (recoveredAmount > 0) {
    ledgerRows.push([sale.customer_id, date, sale.invoice_no,
      `Cash Collected — Invoice ${sale.invoice_no} (Quick Recovery)`,
      0, recoveredAmount, closing, 'payment', recoveryId]);
  }
  await conn.query(
    `INSERT INTO customer_ledger
       (customer_id, date, invoice_no, description, dr, cr, balance,
        reference_type, reference_id)
     VALUES ?`,
    [ledgerRows]
  );

  // Rebuild + verify integrity.
  await rebuildSaleFromRecoveries(conn, sale.id);
  await assertInvariants(conn, sale.id);

  return { recoveryId, sale, discount, recoveredAmount };
}

router.post('/bulk', auth, async (req, res) => {
  const { date, entries } = req.body || {};
  if (!date) return res.status(400).json({ message: 'Recovery date is required.' });
  if (!DATE_RE.test(String(date))) {
    return res.status(400).json({ message: 'The recovery date is not valid.' });
  }
  if (!Array.isArray(entries) || !entries.length) {
    return res.status(400).json({ message: 'No invoices selected.' });
  }
  if (entries.length > BULK_MAX_ENTRIES) {
    return res.status(400).json({
      message: `Select at most ${BULK_MAX_ENTRIES} invoices in one save.`,
    });
  }

  // One connection for the whole request, with a short lock-wait cap that is
  // put back before the connection returns to the pool. A connection that
  // fails is destroyed and the next entry takes a fresh one.
  let conn = null;
  const getConn = async () => {
    if (!conn) {
      const c = await db.getConnection();
      try {
        await c.query('SET SESSION innodb_lock_wait_timeout = ?', [BULK_LOCK_WAIT_SECONDS]);
      } catch (err) { c.destroy(); throw err; }
      conn = c;
    }
    return conn;
  };
  const dropConn = () => { if (conn) { conn.destroy(); conn = null; } };
  const releaseConn = async () => {
    if (!conn) return;
    const c = conn;
    conn = null;
    try {
      await c.query('SET SESSION innodb_lock_wait_timeout = DEFAULT');
      c.release();
    } catch { c.destroy(); }
  };

  const results = [];
  try {
    for (const raw of entries) {
      const entry = raw && typeof raw === 'object' ? raw : {};
      const invoiceNo = String(entry.invoice_no ?? '').trim();
      let settled = null;
      let failure = null;

      for (let attempt = 1; attempt <= BULK_MAX_ATTEMPTS; attempt++) {
        let c = null;
        try {
          c = await getConn();
          await c.beginTransaction();
          settled = await settleQuickRecoveryEntry(c, entry, date);
          await c.commit();
          break;
        } catch (err) {
          if (c) {
            try { await c.rollback(); } catch { dropConn(); }
          }
          if (err.fatal) dropConn();
          if (RETRYABLE_LOCK_ERRORS.has(err.code) && attempt < BULK_MAX_ATTEMPTS) {
            await new Promise(r => setTimeout(r, 150 * attempt + Math.floor(Math.random() * 150)));
            continue;
          }
          failure = err;
          break;
        }
      }

      if (settled) {
        const { recoveryId, sale, discount, recoveredAmount } = settled;
        await logAudit(req, 'CREATE', 'recovery', recoveryId,
          `Quick Recovery on invoice ${sale.invoice_no}: discount ${discount}, recovered ${recoveredAmount}`
        );
        results.push({ invoice_no: invoiceNo, success: true, recovered: recoveredAmount, discount });
        continue;
      }

      if (failure.code && failure.status) {
        // A business rule from settleQuickRecoveryEntry.
        results.push({
          invoice_no: invoiceNo, success: false, code: failure.code, message: failure.message,
          ...(failure.pending_amount !== undefined && { pending_amount: failure.pending_amount }),
        });
      } else if (LOCK_CONFLICT_ERRORS.has(failure.code)) {
        results.push({
          invoice_no: invoiceNo, success: false, code: 'INVOICE_BUSY',
          message: 'Another user is updating this invoice. Nothing was recorded. Save it again.',
        });
      } else {
        console.error(`[Quick Recovery] ${invoiceNo}:`, failure);
        results.push({
          invoice_no: invoiceNo, success: false, code: 'FAILED',
          message: 'The recovery could not be saved. Nothing was recorded. Save it again.',
        });
      }
    }
  } catch (err) {
    // Only reachable through a bug above; answer rather than leave the
    // client waiting for a response that never comes.
    console.error('[Quick Recovery] request failed:', err);
    await releaseConn();
    return res.status(500).json({
      message: 'The recovery could not be completed. Refresh the list to see which invoices were saved.',
      results,
    });
  }
  await releaseConn();

  const failed = results.filter(r => !r.success);
  res.json({
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

    // An inactive person is accepted only if they are already on the invoice:
    // its Delivery By (a recovery stays credited to the original supplier) or
    // its Salesman (Quick Return credits the invoice's salesman).
    const recoveryPersonId = await assertSelectableEmployee(conn, salesman_id, {
      label: 'supplier', keepIds: [currentSale.delivery_by, currentSale.salesman_id],
    });

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
      [sale_id, recoveryPersonId, date, notes || null,
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