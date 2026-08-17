const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');
const { logAudit } = require('../middleware/auditLog');
const { todayPKT, formatDatePKT, addMonthsPKT } = require('../utils/dateUtils');

// ── Shared return-line classification + application ─────────────────────────
// Used by both POST / (new recovery) and PUT /:id (admin edit). A return line
// can settle in exactly one of three ways, decided purely by the SOURCE
// invoice's own state (never by which tab it was entered from):
//
//   'shrink'          source invoice was never locked (no recovery event has
//                      ever happened against it) — safe to rewrite its own
//                      sale_items/total_amount directly, same as editing the
//                      sale before any payment.
//   'credit'          source invoice is locked AND is either (a) the same
//                      invoice currently being settled, or (b) a different
//                      invoice that is already recovery_status='completed'.
//                      Reduces the CURRENT invoice's own total_return_amount /
//                      net_collectible / pending_amount (a credit note).
//   'source_pending'  source invoice is locked, is a DIFFERENT invoice, and
//                      is still recovery_status='pending'. Reduces THAT
//                      invoice's own pending balance only — capped at what's
//                      still pending on it — and never touches the invoice
//                      currently being settled.
//
// Every path enforces the double-return guard: qty_returned can never exceed
// (sale_items.qty - total already returned against that sale_item across all
// history). Because a sale_item only ever accumulates return_items rows once
// its invoice has been locked (a return can only happen via a recovery
// event, which locks the invoice), sale_items.qty is guaranteed to still be
// the original sold qty whenever that subtraction matters.
//
// classifyReturnLine does validation only (no writes) so callers can compute
// event-level totals (e.g. how much of this event's returns count toward the
// current invoice) BEFORE inserting the recovery row that return_items lines
// need as a foreign key. applyReturnLine then performs the actual writes.

async function classifyReturnLine(conn, item, currentSale) {
  const qtyRet = parseInt(item.qty_returned, 10);
  const retRate = parseFloat(item.return_rate || 0);
  const retAmt = qtyRet * retRate;

  const [srcSaleRows] = await conn.query('SELECT * FROM sales WHERE id=?', [item.sale_id]);
  if (!srcSaleRows.length) {
    throw Object.assign(new Error('Source invoice not found for a return line.'), { status: 400 });
  }
  const srcSale = srcSaleRows[0];

  const [siRows] = await conn.query('SELECT * FROM sale_items WHERE id=?', [item.sale_item_id]);
  if (!siRows.length) {
    throw Object.assign(new Error('Source sale item not found for a return line.'), { status: 400 });
  }
  const si = siRows[0];

  const [sumRows] = await conn.query(
    'SELECT COALESCE(SUM(qty_returned),0) as returned FROM return_items WHERE sale_item_id=?',
    [item.sale_item_id]
  );
  const remaining = parseInt(si.qty, 10) - parseInt(sumRows[0].returned, 10);
  if (qtyRet > remaining) {
    throw Object.assign(new Error(
      `Return qty for "${item.product_name || 'an item'}" exceeds remaining returnable quantity (${Math.max(0, remaining)}).`
    ), { status: 400 });
  }

  const isCurrentInvoice = srcSale.id === currentSale.id;
  let branch;
  if (!srcSale.is_locked) {
    branch = 'shrink';
  } else if (isCurrentInvoice || srcSale.recovery_status === 'completed') {
    branch = 'credit';
  } else {
    const srcPendingBefore = parseFloat(srcSale.pending_amount || 0);
    if (retAmt > srcPendingBefore + 0.009) {
      throw Object.assign(new Error(
        `Return amount for invoice ${srcSale.invoice_no} (${retAmt.toFixed(2)}) exceeds its pending balance (${srcPendingBefore.toFixed(2)}).`
      ), { status: 400 });
    }
    branch = 'source_pending';
  }

  return { item, srcSale, si, qtyRet, retRate, retAmt, branch, isCurrentInvoice };
}

// Applies one classified return line's writes. Returns the amount (0 or
// retAmt) that should count toward the CURRENT invoice's own
// total_return_amount for this event.
async function applyReturnLine(conn, classified, { date, currentSale, recoveryId }) {
  const { item, srcSale, si, qtyRet, retRate, retAmt, branch } = classified;

  // Physical restock happens regardless of which financial path this return takes.
  await conn.query('UPDATE inventory SET qty=qty+? WHERE product_id=? AND batch_no=?',
    [qtyRet, item.product_id, item.batch_no]);

  if (branch === 'shrink') {
    const newQty = Math.max(0, parseInt(si.qty, 10) - qtyRet);
    if (newQty <= 0) {
      // Do NOT delete: return_items.sale_item_id (FK, no ON DELETE CASCADE) will
      // reference this row from the INSERT below in this same transaction.
      await conn.query('UPDATE sale_items SET qty=0, total=0 WHERE id=?', [si.id]);
    } else {
      const discFactor = 1 - parseFloat(si.discount_pct || 0) / 100;
      const taxFactor = 1 + parseFloat(si.tax_pct || 0) / 100;
      const newTotal = newQty * parseFloat(si.sale_rate) * discFactor * taxFactor;
      await conn.query('UPDATE sale_items SET qty=?, total=? WHERE id=?', [newQty, newTotal.toFixed(2), si.id]);
    }

    const [newItems] = await conn.query('SELECT SUM(total) as t FROM sale_items WHERE sale_id=?', [item.sale_id]);
    const newSaleTotal = parseFloat(newItems[0].t || 0);
    await conn.query('UPDATE sales SET total_amount=?, net_collectible=?, pending_amount=? WHERE id=?',
      [newSaleTotal, newSaleTotal, newSaleTotal, item.sale_id]);

    const [ledgerRows] = await conn.query(
      'SELECT id, dr, cr FROM customer_ledger WHERE reference_type="sale" AND reference_id=?', [item.sale_id]);
    if (ledgerRows.length > 0) {
      const ledgerRow = ledgerRows[0];
      const newDr = parseFloat(ledgerRow.dr) - retAmt;
      if (newDr <= 0.009 && parseFloat(ledgerRow.cr || 0) <= 0.009) {
        await conn.query('DELETE FROM customer_ledger WHERE id=?', [ledgerRow.id]);
      } else {
        await conn.query('UPDATE customer_ledger SET dr=?, balance=balance-? WHERE id=?',
          [Math.max(0, newDr).toFixed(2), retAmt, ledgerRow.id]);
      }
    }
    await conn.query('UPDATE customers SET balance=balance-? WHERE id=?', [retAmt, srcSale.customer_id]);

    await conn.query(
      `INSERT INTO return_items (recovery_id, sale_id, sale_item_id, product_id, batch_no, qty_returned, return_rate, return_amount, settlement_branch)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [recoveryId, item.sale_id, item.sale_item_id, item.product_id, item.batch_no, qtyRet, retRate, retAmt, 'shrink']);

    return 0;
  }

  if (branch === 'credit') {
    await conn.query(
      `INSERT INTO return_items (recovery_id, sale_id, sale_item_id, product_id, batch_no, qty_returned, return_rate, return_amount, settlement_branch)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [recoveryId, item.sale_id, item.sale_item_id, item.product_id, item.batch_no, qtyRet, retRate, retAmt, 'credit']);

    await conn.query('UPDATE customers SET balance=balance-? WHERE id=?', [retAmt, currentSale.customer_id]);
    const [c] = await conn.query('SELECT balance FROM customers WHERE id=?', [currentSale.customer_id]);
    await conn.query(
      `INSERT INTO customer_ledger (customer_id, date, invoice_no, description, dr, cr, balance, reference_type, reference_id)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [currentSale.customer_id, date, srcSale.invoice_no,
       `Return — ${qtyRet} unit(s) of ${item.product_name || 'product'} from ${srcSale.invoice_no}`,
       0, retAmt, c[0].balance, 'payment', recoveryId]);

    return retAmt;
  }

  // branch === 'source_pending': reduce the SOURCE invoice's own pending
  // balance only. Cap was already validated in classifyReturnLine.
  const priorSrcReturn = parseFloat(srcSale.total_return_amount || 0);
  const srcPendingBefore = parseFloat(srcSale.pending_amount || 0);
  const srcNetCollectible = parseFloat(srcSale.total_amount) - parseFloat(srcSale.total_discount || 0) - (priorSrcReturn + retAmt);
  const srcPendingAfter = Math.max(0, srcPendingBefore - retAmt);
  const srcStatus = srcPendingAfter <= 0.009 ? 'completed' : 'pending';

  await conn.query(
    `UPDATE sales SET total_return_amount=?, net_collectible=?, pending_amount=?, recovery_status=? WHERE id=?`,
    [priorSrcReturn + retAmt, srcNetCollectible, srcPendingAfter, srcStatus, srcSale.id]);

  await conn.query(
    `INSERT INTO return_items (recovery_id, sale_id, sale_item_id, product_id, batch_no, qty_returned, return_rate, return_amount, settlement_branch)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [recoveryId, item.sale_id, item.sale_item_id, item.product_id, item.batch_no, qtyRet, retRate, retAmt, 'source_pending']);

  await conn.query('UPDATE customers SET balance=balance-? WHERE id=?', [retAmt, srcSale.customer_id]);
  const [cSrc] = await conn.query('SELECT balance FROM customers WHERE id=?', [srcSale.customer_id]);
  await conn.query(
    `INSERT INTO customer_ledger (customer_id, date, invoice_no, description, dr, cr, balance, reference_type, reference_id)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [srcSale.customer_id, date, srcSale.invoice_no,
     `Return — ${qtyRet} unit(s) of ${item.product_name || 'product'} (recorded while settling Invoice ${currentSale.invoice_no})`,
     0, retAmt, cSrc[0].balance, 'payment', recoveryId]);

  return 0;
}

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

// ── Payment history for a single invoice (used by the "click invoice -> history" UI) ──
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

// ── Quick Recovery: list pending invoices for fast end-of-day collection ──
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

// ── Quick Return: list fully-settled invoices eligible for a standalone
//    (not linked-to-a-new-invoice) return — used by the Quick Return page.
//    Unlike Quick Recovery, this is normally aimed at one known invoice or
//    customer rather than a bulk date-range sweep, so customer (via the
//    CustomerAutocomplete, exact match) and invoice number (free text) are
//    the primary filters; date range and salesman/supplier stay available
//    as secondary narrowing filters. ─────────────────────────────────────
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

// ── Bulk Recovery: bulk-settle a batch of invoices in one shot ──
// Body: { date: 'YYYY-MM-DD', entries: [{ invoice_no, discount }] }
// Each invoice is fully collected (pending_amount - discount) — there's
// no partial-cash concept here, unlike the detailed Recovery modal.
router.post('/bulk', auth, async (req, res) => {
  const { date, entries } = req.body;
  if (!date) return res.status(400).json({ message: 'Date required' });
  if (!Array.isArray(entries) || !entries.length) {
    return res.status(400).json({ message: 'No invoices selected' });
  }

  const results = []; // { invoice_no, success, message, recovered? }

  for (const entry of entries) {
    const invoiceNo = entry.invoice_no;
    const discount = Number.isNaN(parseFloat(entry.discount)) ? 0 : parseFloat(entry.discount);
    const conn = await db.getConnection();
    await conn.beginTransaction();
    try {
      if (discount < 0) {
        throw Object.assign(new Error('Discount cannot be negative'), { status: 400 });
      }

      const [sRows] = await conn.query('SELECT * FROM sales WHERE invoice_no=? FOR UPDATE', [invoiceNo]);
      if (!sRows.length) throw Object.assign(new Error('Invoice not found'), { status: 404 });
      const sale = sRows[0];

      if (sale.recovery_status === 'completed') {
        throw Object.assign(new Error('Already fully recovered'), { status: 400 });
      }

      const priorDiscount = parseFloat(sale.total_discount || 0);
      const priorReturn = parseFloat(sale.total_return_amount || 0);
      const priorRecovered = parseFloat(sale.total_recovered || 0);

      const maxDiscount = parseFloat(sale.total_amount) - priorDiscount - priorReturn;
      if (discount > maxDiscount + 0.009) {
        throw Object.assign(new Error(`Discount exceeds remaining invoice amount (${maxDiscount.toFixed(2)})`), { status: 400 });
      }

      const newTotalDiscount = priorDiscount + discount;
      const netCollectible = parseFloat(sale.total_amount) - newTotalDiscount - priorReturn;
      const pendingBeforeThisPayment = Math.max(0, netCollectible - priorRecovered);

      // Quick Recovery always collects the full remaining balance.
      const recoveredAmount = pendingBeforeThisPayment;
      const newTotalRecovered = priorRecovered + recoveredAmount;
      const pendingAmount = Math.max(0, netCollectible - newTotalRecovered);
      const recoveryStatus = pendingAmount <= 0.009 ? 'completed' : 'pending';

      const [result] = await conn.query(
        `INSERT INTO recoveries (sale_id, salesman_id, date, notes, total_discount, total_return_amount, net_collectible, net_collected, pending_amount)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [sale.id, sale.delivery_by || null, date, 'Quick Recovery', discount, 0, netCollectible, recoveredAmount, pendingAmount]
      );
      const recoveryId = result.insertId;

      // Allocate the flat discount proportionally across sale_items, so
      // recovery_items (and downstream Edit/History views) stay consistent
      // with how the detailed Recovery flow records line-level discounts.
      if (discount > 0) {
        const [items] = await conn.query('SELECT id, product_id, batch_no, total FROM sale_items WHERE sale_id=? AND total > 0', [sale.id]);
        const lineTotalSum = items.reduce((s, i) => s + parseFloat(i.total), 0);
        let allocated = 0;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const isLast = i === items.length - 1;
          const share = isLast
            ? discount - allocated
            : Math.round((discount * (parseFloat(item.total) / lineTotalSum)) * 100) / 100;
          allocated += share;
          await conn.query(
            `INSERT INTO recovery_items (recovery_id, sale_item_id, product_id, batch_no, original_total, discount_given, final_amount)
             VALUES (?,?,?,?,?,?,?)`,
            [recoveryId, item.id, item.product_id, item.batch_no, item.total, share, parseFloat(item.total) - share]
          );
        }

        await conn.query('UPDATE customers SET balance=balance-? WHERE id=?', [discount, sale.customer_id]);
        const [custAfterDisc] = await conn.query('SELECT balance FROM customers WHERE id=?', [sale.customer_id]);
        await conn.query(
          `INSERT INTO customer_ledger (customer_id, date, invoice_no, description, dr, cr, balance, reference_type, reference_id)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [sale.customer_id, date, sale.invoice_no, `Discount on Invoice ${sale.invoice_no} (Quick Recovery)`, 0, discount, custAfterDisc[0].balance, 'payment', recoveryId]
        );
      }

      if (recoveredAmount > 0) {
        await conn.query('UPDATE customers SET balance=balance-? WHERE id=?', [recoveredAmount, sale.customer_id]);
        const [custRows] = await conn.query('SELECT balance FROM customers WHERE id=?', [sale.customer_id]);
        await conn.query(
          `INSERT INTO customer_ledger (customer_id, date, invoice_no, description, dr, cr, balance, reference_type, reference_id)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [sale.customer_id, date, sale.invoice_no, `Cash Collected — Invoice ${sale.invoice_no} (Quick Recovery)`, 0, recoveredAmount, custRows[0].balance, 'payment', recoveryId]
        );
      }

      await conn.query(
        `UPDATE sales SET is_locked=1, total_discount=?, total_return_amount=?, net_collectible=?,
                total_recovered=?, pending_amount=?, recovery_status=? WHERE id=?`,
        [newTotalDiscount, priorReturn, netCollectible, newTotalRecovered, pendingAmount, recoveryStatus, sale.id]
      );

      await conn.commit();
      await logAudit(req, 'CREATE', 'recovery', recoveryId,
        `Quick Recovery on invoice ${sale.invoice_no}: discount ${discount}, recovered ${recoveredAmount}, status ${recoveryStatus}`);

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
      `SELECT ri.*, p.name as product_name FROM recovery_items ri
       JOIN products p ON ri.product_id = p.id WHERE ri.recovery_id=?`, [req.params.id]);
    const [retItems] = await db.query(
      `SELECT rt.*, p.name as product_name, s.invoice_no as source_invoice, si.qty as current_sold_qty,
              (SELECT COALESCE(SUM(qty_returned), 0) FROM return_items
               WHERE sale_item_id = rt.sale_item_id AND recovery_id != rt.recovery_id) as already_returned_elsewhere
       FROM return_items rt
       JOIN products p ON rt.product_id = p.id
       JOIN sales s ON rt.sale_id = s.id
       LEFT JOIN sale_items si ON si.id = rt.sale_item_id
       WHERE rt.recovery_id=?`, [req.params.id]);
    res.json({ ...rows[0], recovery_items: recItems, return_items: retItems });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/', auth, async (req, res) => {
  const conn = await db.getConnection();
  await conn.beginTransaction();
  try {
    const { sale_id, salesman_id, date, notes, recovery_items, return_items, amount_recovered } = req.body;
    if (!sale_id || !date) return res.status(400).json({ message: 'Sale and date required' });

    // Lock the sale row for the duration of this transaction to avoid
    // two simultaneous partial payments racing on the same invoice.
    const [sRows] = await conn.query('SELECT * FROM sales WHERE id=? FOR UPDATE', [sale_id]);
    if (sRows.length === 0) return res.status(404).json({ message: 'Sale not found' });
    const currentSale = sRows[0];

    // A completed invoice can't take MORE discount or MORE cash — there's
    // nothing left to collect. But a pure return (no discount, no cash) is
    // exactly what Quick Return needs: crediting the customer back for
    // returned goods on an invoice that's already fully settled. That's the
    // same 'credit' branch classifyReturnLine already produces for a locked
    // + completed invoice, so it's safe to let it through here.
    if (currentSale.recovery_status === 'completed') {
      const requestingDiscount = (recovery_items || []).some(i => parseFloat(i.discount_given || 0) > 0);
      const requestingCash = parseFloat(amount_recovered || 0) > 0;
      if (requestingDiscount || requestingCash) {
        return res.status(400).json({ message: `Invoice ${currentSale.invoice_no} is already fully recovered.` });
      }
    }

    // ── Expiry validation for ALL return items ──────────────────────
    // Admins are allowed to push through a return that falls inside the normal
    // 5-month return window (they just get a warning back), but even admins
    // cannot return a batch that has actually passed its expiry month.
    const isAdmin = req.user?.role === 'admin';
    const expiryWarnings = [];
    const allReturnItems = return_items || [];
    for (const item of allReturnItems) {
      if (!item.qty_returned || parseInt(item.qty_returned) <= 0) continue;
      // Get expiry date from inventory for this product+batch
      const [invRows] = await conn.query(
        'SELECT exp_date FROM inventory WHERE product_id=? AND batch_no=?',
        [item.product_id, item.batch_no]
      );
      if (invRows.length > 0 && invRows[0].exp_date) {
        const expiryStr = String(invRows[0].exp_date).slice(0, 10);
        const threshold = addMonthsPKT(expiryStr, -5);
        if (todayPKT() > threshold) {
          // Get product name for the warning/error message
          const [pRows] = await conn.query('SELECT name FROM products WHERE id=?', [item.product_id]);
          const pName = pRows[0]?.name || `Product ID ${item.product_id}`;

          // Compare year-month only (day of month is ignored) to decide whether
          // the batch has actually expired, e.g. exp July 2026 + today July 2026 => not expired yet.
          const todayYearMonth = todayPKT().slice(0, 7);
          const expiryYearMonth = expiryStr.slice(0, 7);
          const isExpired = todayYearMonth > expiryYearMonth;

          if (isExpired) {
            // Past actual expiry — blocked for everyone, admin included.
            return res.status(400).json({
              message: `Return not allowed for "${pName}" (Batch: ${item.batch_no}). Product expired ${formatDatePKT(expiryStr)}.`
            });
          }

          if (!isAdmin) {
            return res.status(400).json({
              message: `Return not allowed for "${pName}" (Batch: ${item.batch_no}). Product expires ${formatDatePKT(expiryStr)} — within 5 months of expiry. Return window has passed.`
            });
          }

          // Admin, not yet expired, but inside the 5-month window: allow, just warn.
          expiryWarnings.push(
            `"${pName}" (Batch: ${item.batch_no}) expires ${formatDatePKT(expiryStr)} — within 5 months of expiry. Returned anyway (admin override).`
          );
        }
      }
    }

    // ── Server-side guard: discount per line can't be negative or exceed that line's invoice amount ──
    for (const item of (recovery_items || [])) {
      const disc = parseFloat(item.discount_given || 0);
      const cap = parseFloat(item.original_total || 0);
      if (disc < 0 || disc > cap) {
        return res.status(400).json({ message: `Discount given for "${item.product_name || 'an item'}" must be between 0 and its invoice amount (${cap}).` });
      }
    }

    // ── Classify every return line (validates double-return guard + the
    //    source-invoice pending cap; no writes yet). Doing this before the
    //    net_collectible math below is what lets a 'source_pending' cross
    //    return be rejected up front, instead of partially applying. ──────
    const validReturnItems = allReturnItems.filter(i => i.qty_returned && parseInt(i.qty_returned) > 0);
    // Disallow returns that target a different (previous) invoice — returns
    // are only allowed against the current invoice in this workflow.
    for (const item of validReturnItems) {
      if (parseInt(item.sale_id, 10) !== parseInt(sale_id, 10)) {
        throw Object.assign(new Error('Returns against previous invoices are not allowed. Return items must reference the current invoice.'), { status: 400 });
      }
    }
    const classifiedReturns = [];
    for (const item of validReturnItems) {
      classifiedReturns.push(await classifyReturnLine(conn, item, currentSale));
    }

    // ── This event's discount / return amounts (not cumulative) ─────
    const eventDiscount = (recovery_items || []).reduce((s, i) => s + parseFloat(i.discount_given || 0), 0);
    // Only 'credit' lines reduce the CURRENT invoice's own total_return_amount —
    // 'shrink' lines already reduce their source invoice's total_amount directly,
    // and 'source_pending' lines reduce a DIFFERENT invoice's own pending balance.
    // (Counting every line here, regardless of branch, was the old bug: it
    // double-counted 'shrink' returns against total_amount AND net_collectible.)
    const eventReturnAmount = classifiedReturns
      .filter(c => c.branch === 'credit')
      .reduce((s, c) => s + c.retAmt, 0);
    // A 'shrink' return on the CURRENT invoice's own items (its first-ever
    // recovery event, before locking) reduces total_amount directly via
    // applyReturnLine — account for that here so net_collectible reflects the
    // post-shrink total rather than the stale pre-shrink figure.
    const selfShrinkAmount = classifiedReturns
      .filter(c => c.branch === 'shrink' && c.isCurrentInvoice)
      .reduce((s, c) => s + c.retAmt, 0);

    // ── Cumulative figures carried over from prior recovery events on this invoice ──
    const priorDiscount = parseFloat(currentSale.total_discount || 0);
    const priorReturn = parseFloat(currentSale.total_return_amount || 0);
    const priorRecovered = parseFloat(currentSale.total_recovered || 0);

    const newTotalDiscount = priorDiscount + eventDiscount;
    const newTotalReturn = priorReturn + eventReturnAmount;
    const effectiveTotalAmount = parseFloat(currentSale.total_amount) - selfShrinkAmount;
    const netCollectible = effectiveTotalAmount - newTotalDiscount - newTotalReturn;
    if (netCollectible < 0) {
      return res.status(400).json({ message: 'Discount and returns exceed invoice total' });
    }

    // A return can bring net_collectible below what's already been recovered
    // (e.g. a Quick Return against a fully-settled invoice, or any return
    // larger than what's currently still owed) — that means the customer is
    // now owed money back, which the return's own ledger credit already
    // handles. It does NOT mean this invoice has negative pending debt, so
    // floor it at 0 rather than letting a negative value block amount_recovered
    // validation below.
    const pendingBeforeThisPayment = Math.max(0, netCollectible - priorRecovered);

    // Amount recovered is always explicit — never auto-filled to "settle everything".
    let recoveredAmount = 0;
    if (amount_recovered !== undefined && amount_recovered !== null && amount_recovered !== '') {
      recoveredAmount = parseFloat(amount_recovered);
      if (Number.isNaN(recoveredAmount) || recoveredAmount < 0) {
        return res.status(400).json({ message: 'Recovered amount must be zero or greater' });
      }
      if (recoveredAmount > pendingBeforeThisPayment + 0.009) {
        return res.status(400).json({ message: `Recovered amount cannot exceed pending balance (${pendingBeforeThisPayment.toFixed(2)})` });
      }
    }

    const newTotalRecovered = priorRecovered + recoveredAmount;
    const pendingAmount = Math.max(0, netCollectible - newTotalRecovered);
    // Fully settled once nothing is left to collect — either via full cash recovery
    // or because discounts/returns brought the net collectible down to zero.
    const recoveryStatus = pendingAmount <= 0.009 ? 'completed' : 'pending';

    if (!(recovery_items || []).length && !allReturnItems.length && recoveredAmount <= 0) {
      return res.status(400).json({ message: 'Enter at least one discount, return, or recovered amount' });
    }

    // Insert this recovery event (kept as permanent payment history for the invoice).
    // total_discount / total_return_amount / net_collected below describe THIS event only;
    // net_collectible / pending_amount are the running invoice-level figures right after this event.
    const [result] = await conn.query(
      `INSERT INTO recoveries (sale_id, salesman_id, date, notes, total_discount, total_return_amount, net_collectible, net_collected, pending_amount)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [sale_id, salesman_id || null, date, notes || null, eventDiscount, eventReturnAmount, netCollectible, recoveredAmount, pendingAmount]
    );
    const recoveryId = result.insertId;

    // Insert recovery discount lines
    for (const item of (recovery_items || [])) {
      await conn.query(
        `INSERT INTO recovery_items (recovery_id, sale_item_id, product_id, batch_no, original_total, discount_given, final_amount)
         VALUES (?,?,?,?,?,?,?)`,
        [recoveryId, item.sale_item_id, item.product_id, item.batch_no,
         item.original_total, item.discount_given || 0, item.final_amount]
      );
    }

    // ── Process discount in ledger (explicit row) ──────────────────
    if (eventDiscount > 0) {
      await conn.query('UPDATE customers SET balance=balance-? WHERE id=?',
        [eventDiscount, currentSale.customer_id]);
      const [custAfterDisc] = await conn.query('SELECT balance FROM customers WHERE id=?', [currentSale.customer_id]);
      await conn.query(
        `INSERT INTO customer_ledger (customer_id, date, invoice_no, description, dr, cr, balance, reference_type, reference_id)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [currentSale.customer_id, date, currentSale.invoice_no,
         `Discount on Invoice ${currentSale.invoice_no}`,
         0, eventDiscount, custAfterDisc[0].balance, 'payment', recoveryId]
      );
    }

    // ── Process returns — each line was already classified above, so this is
    //    just applying the writes for whichever of the three branches it fell
    //    into (shrink / credit / source_pending). ─────────────────────────
    for (const classified of classifiedReturns) {
      await applyReturnLine(conn, classified, { date, currentSale, recoveryId });
    }

    // ── Record cash recovered in ledger (this installment) ───────────
    if (recoveredAmount > 0) {
      await conn.query('UPDATE customers SET balance=balance-? WHERE id=?',
        [recoveredAmount, currentSale.customer_id]);
      const [custRows] = await conn.query('SELECT balance FROM customers WHERE id=?', [currentSale.customer_id]);
      const payDesc = pendingAmount > 0
        ? `Cash Collected — Invoice ${currentSale.invoice_no} (Pending: ${pendingAmount.toFixed(2)})${notes ? ' (' + notes + ')' : ''}`
        : `Cash Collected — Invoice ${currentSale.invoice_no}${notes ? ' (' + notes + ')' : ''}`;
      await conn.query(
        `INSERT INTO customer_ledger (customer_id, date, invoice_no, description, dr, cr, balance, reference_type, reference_id)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [currentSale.customer_id, date, currentSale.invoice_no, payDesc,
         0, recoveredAmount, custRows[0].balance, 'payment', recoveryId]
      );
    }

    // ── Lock the invoice (no further edits to its line items) and update running totals.
    //    NOTE: locking the invoice is NOT the same as closing its recovery — recovery_status
    //    only flips to 'completed' once the full amount has actually been collected/returned.
    await conn.query(
      `UPDATE sales
       SET is_locked=1, total_discount=?, total_return_amount=?, net_collectible=?,
           total_recovered=?, pending_amount=?, recovery_status=?
       WHERE id=?`,
      [newTotalDiscount, newTotalReturn, netCollectible, newTotalRecovered, pendingAmount, recoveryStatus, sale_id]
    );

    await conn.commit();
    await logAudit(req, 'CREATE', 'recovery', recoveryId,
      `Recovery on invoice ${currentSale.invoice_no}: discount ${eventDiscount}, returns ${eventReturnAmount}, recovered ${recoveredAmount}, pending ${pendingAmount}, status ${recoveryStatus}`);
    res.status(201).json({
      id: recoveryId,
      net_collectible: netCollectible,
      amount_recovered: recoveredAmount,
      total_recovered: newTotalRecovered,
      pending_amount: pendingAmount,
      net_collected: recoveredAmount,
      recovery_status: recoveryStatus,
      expiry_warnings: expiryWarnings.length ? expiryWarnings : undefined,
    });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(err.status || 500).json({ message: err.message });
  } finally { conn.release(); }
});

// ── Edit an existing recovery entry — ADMIN ONLY, allowed even if the invoice
//    is already fully settled (recovery_status = 'completed'). ─────────────────
//
// Every side-effect of the ORIGINAL entry is reverted first:
//   - all customer_ledger rows this entry created directly (discount row,
//     cash-collected row, and locked-invoice return-credit rows) are deleted
//     and their balance impact is reversed
//   - inventory restocked by its return lines is taken back out
//   - for any return line whose source invoice was still unlocked at the time
//     (so the return had instead reduced that invoice's own qty/total and its
//     own ledger row), that invoice's qty/total and ledger row are restored
//
// The corrected values are then re-applied using the same rules as creating a
// brand-new entry (POST /). Finally every recovery row for the sale is walked
// in date order to rebuild net_collectible/pending_amount snapshots and the
// sale's own rollup columns, so payment history and reports never show a
// stale figure after a correction.
router.put('/:id', auth, async (req, res) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ message: 'Only an admin account can edit a recovery entry.' });
  }
  const conn = await db.getConnection();
  await conn.beginTransaction();
  try {
    const recoveryId = parseInt(req.params.id);
    const { date, notes, recovery_items, return_items, amount_recovered } = req.body;
    if (!date) return res.status(400).json({ message: 'Date required' });

    const [recRows] = await conn.query('SELECT * FROM recoveries WHERE id=?', [recoveryId]);
    if (!recRows.length) return res.status(404).json({ message: 'Recovery not found' });
    const saleId = recRows[0].sale_id;

    // Lock the sale row for the duration of this transaction, same as POST /.
    const [sRows] = await conn.query('SELECT * FROM sales WHERE id=? FOR UPDATE', [saleId]);
    if (!sRows.length) return res.status(404).json({ message: 'Sale not found' });
    const currentSale = sRows[0];

    const [oldReturnItems] = await conn.query('SELECT * FROM return_items WHERE recovery_id=?', [recoveryId]);

    // ── 1. Revert ledger rows this entry created directly, and reverse their
    //    net effect on the customer's balance. This also covers the ledger
    //    row a 'source_pending' return line writes (see applyReturnLine) —
    //    it's filed under this same recoveryId, and the source invoice always
    //    shares the current invoice's customer, so the blanket balance
    //    reversal below is correct for it too. ─────────────────────────────
    const [oldLedgerRows] = await conn.query(
      `SELECT id, dr, cr FROM customer_ledger WHERE reference_type='payment' AND reference_id=?`,
      [recoveryId]
    );
    let reverseBalance = 0;
    for (const lr of oldLedgerRows) reverseBalance += parseFloat(lr.cr || 0) - parseFloat(lr.dr || 0);
    if (Math.abs(reverseBalance) > 0.0001) {
      await conn.query('UPDATE customers SET balance=balance+? WHERE id=?', [reverseBalance, currentSale.customer_id]);
    }
    await conn.query(`DELETE FROM customer_ledger WHERE reference_type='payment' AND reference_id=?`, [recoveryId]);

    // ── 2. Revert every old return line, branching on the settlement_branch
    //    recorded at write time (no more guessing from ledger text). ────────
    for (const old of oldReturnItems) {
      // Undo the restock that happened when this return was originally processed.
      await conn.query('UPDATE inventory SET qty=qty-? WHERE product_id=? AND batch_no=?',
        [old.qty_returned, old.product_id, old.batch_no]);

      const [srcRows] = await conn.query('SELECT * FROM sales WHERE id=?', [old.sale_id]);
      if (!srcRows.length) continue;
      const srcSale = srcRows[0];
      const retAmt = parseFloat(old.return_amount || 0);

      if (old.settlement_branch === 'shrink') {
        // Restore the source invoice's sale_item qty/total, its rollup
        // columns, and its own ledger DR row.
        const [siRows] = await conn.query('SELECT * FROM sale_items WHERE id=?', [old.sale_item_id]);
        if (siRows.length) {
          const si = siRows[0];
          const restoredQty = parseInt(si.qty) + parseInt(old.qty_returned);
          const discFactor = 1 - parseFloat(si.discount_pct || 0) / 100;
          const taxFactor = 1 + parseFloat(si.tax_pct || 0) / 100;
          const restoredTotal = restoredQty * parseFloat(si.sale_rate) * discFactor * taxFactor;
          await conn.query('UPDATE sale_items SET qty=?, total=? WHERE id=?', [restoredQty, restoredTotal.toFixed(2), si.id]);

          const [sumRows] = await conn.query('SELECT SUM(total) as t FROM sale_items WHERE sale_id=?', [old.sale_id]);
          const restoredSaleTotal = parseFloat(sumRows[0].t || 0);
          await conn.query('UPDATE sales SET total_amount=?, net_collectible=?, pending_amount=? WHERE id=?',
            [restoredSaleTotal, restoredSaleTotal, restoredSaleTotal, old.sale_id]);

          const [ledgerRows] = await conn.query(
            'SELECT id FROM customer_ledger WHERE reference_type="sale" AND reference_id=?', [old.sale_id]);
          if (ledgerRows.length) {
            await conn.query('UPDATE customer_ledger SET dr=dr+?, balance=balance+? WHERE id=?',
              [retAmt, retAmt, ledgerRows[0].id]);
          } else {
            const [custRows] = await conn.query('SELECT balance FROM customers WHERE id=?', [srcSale.customer_id]);
            const newBal = parseFloat(custRows[0].balance) + retAmt;
            await conn.query(
              `INSERT INTO customer_ledger (customer_id, date, invoice_no, description, dr, cr, balance, reference_type, reference_id)
               VALUES (?,?,?,?,?,?,?,?,?)`,
              [srcSale.customer_id, srcSale.date, srcSale.invoice_no, `Invoice ${srcSale.invoice_no}`, retAmt, 0, newBal, 'sale', old.sale_id]
            );
          }
          await conn.query('UPDATE customers SET balance=balance+? WHERE id=?', [retAmt, srcSale.customer_id]);
        }
      } else if (old.settlement_branch === 'source_pending') {
        // Restore the SOURCE invoice's own return/collectible/pending figures
        // (the ledger balance side of this was already reverted in step 1).
        const restoredReturn = Math.max(0, parseFloat(srcSale.total_return_amount || 0) - retAmt);
        const restoredNet = parseFloat(srcSale.total_amount) - parseFloat(srcSale.total_discount || 0) - restoredReturn;
        const restoredPending = Math.max(0, restoredNet - parseFloat(srcSale.total_recovered || 0));
        const restoredStatus = restoredPending <= 0.009 ? 'completed' : 'pending';
        await conn.query(
          'UPDATE sales SET total_return_amount=?, net_collectible=?, pending_amount=?, recovery_status=? WHERE id=?',
          [restoredReturn, restoredNet, restoredPending, restoredStatus, srcSale.id]
        );
      }
      // branch === 'credit': fully reverted by step 1 already (its ledger row
      // and the balance it moved are tied to the current invoice, not srcSale).
    }

    // The invoice being edited may itself have been the target of one of the
    // "unlocked branch" reverts above (possible when a same-invoice return was
    // recorded on the invoice's very first — and therefore still-unlocked-at-the-
    // time — recovery event). Re-read its total_amount so later math is correct.
    const [freshSaleRows] = await conn.query('SELECT total_amount FROM sales WHERE id=?', [saleId]);
    currentSale.total_amount = freshSaleRows[0].total_amount;

    // ── 3. Wipe the old line items — replaced with the corrected set below. ──
    await conn.query('DELETE FROM recovery_items WHERE recovery_id=?', [recoveryId]);
    await conn.query('DELETE FROM return_items WHERE recovery_id=?', [recoveryId]);

    // ── 4. Re-apply the corrected values, same rules as POST /. ─────────────
    const allReturnItems = return_items || [];
    const expiryWarnings = [];
    for (const item of allReturnItems) {
      if (!item.qty_returned || parseInt(item.qty_returned) <= 0) continue;
      const [invRows] = await conn.query('SELECT exp_date FROM inventory WHERE product_id=? AND batch_no=?',
        [item.product_id, item.batch_no]);
      if (invRows.length && invRows[0].exp_date) {
        const expiryStr = String(invRows[0].exp_date).slice(0, 10);
        const threshold = addMonthsPKT(expiryStr, -5);
        if (todayPKT() > threshold) {
          const [pRows] = await conn.query('SELECT name FROM products WHERE id=?', [item.product_id]);
          const pName = pRows[0]?.name || `Product ID ${item.product_id}`;
          const isExpired = todayPKT().slice(0, 7) > expiryStr.slice(0, 7);
          if (isExpired) {
            throw Object.assign(new Error(
              `Return not allowed for "${pName}" (Batch: ${item.batch_no}). Product expired ${formatDatePKT(expiryStr)}.`
            ), { status: 400 });
          }
          // Admin-only endpoint — inside the 5-month window is allowed, just warn.
          expiryWarnings.push(
            `"${pName}" (Batch: ${item.batch_no}) expires ${formatDatePKT(expiryStr)} — within 5 months of expiry. Returned anyway (admin override).`
          );
        }
      }
    }

    // ── Server-side guard: discount per line can't be negative or exceed that line's invoice amount ──
    for (const item of (recovery_items || [])) {
      const disc = parseFloat(item.discount_given || 0);
      const cap = parseFloat(item.original_total || 0);
      if (disc < 0 || disc > cap) {
        throw Object.assign(new Error(
          `Discount given for "${item.product_name || 'an item'}" must be between 0 and its invoice amount (${cap}).`
        ), { status: 400 });
      }
    }

    // ── Classify every return line (double-return guard + pending cap; no
    //    writes yet). The old return_items for THIS recovery were already
    //    deleted in step 3, so the "already returned" sums used by the guard
    //    correctly exclude this entry's own old lines. ──────────────────────
    const validReturnItems = allReturnItems.filter(i => i.qty_returned && parseInt(i.qty_returned) > 0);
    // Disallow returns referencing a different invoice when editing — keep
    // returns strictly tied to the invoice being settled.
    for (const item of validReturnItems) {
      if (parseInt(item.sale_id, 10) !== parseInt(saleId, 10)) {
        throw Object.assign(new Error('Returns against previous invoices are not allowed. Return items must reference the current invoice.'), { status: 400 });
      }
    }
    const classifiedReturns = [];
    for (const item of validReturnItems) {
      classifiedReturns.push(await classifyReturnLine(conn, item, currentSale));
    }

    const eventDiscount = (recovery_items || []).reduce((s, i) => s + parseFloat(i.discount_given || 0), 0);
    // Same branch-aware rule as POST / — only 'credit' lines count toward this
    // invoice's own total_return_amount.
    const eventReturnAmount = classifiedReturns
      .filter(c => c.branch === 'credit')
      .reduce((s, c) => s + c.retAmt, 0);
    const recoveredAmount = parseFloat(amount_recovered || 0);
    if (Number.isNaN(recoveredAmount) || recoveredAmount < 0) {
      throw Object.assign(new Error('Recovered amount must be zero or greater'), { status: 400 });
    }

    for (const item of (recovery_items || [])) {
      await conn.query(
        `INSERT INTO recovery_items (recovery_id, sale_item_id, product_id, batch_no, original_total, discount_given, final_amount)
         VALUES (?,?,?,?,?,?,?)`,
        [recoveryId, item.sale_item_id, item.product_id, item.batch_no,
         item.original_total, item.discount_given || 0, item.final_amount]
      );
    }

    if (eventDiscount > 0) {
      await conn.query('UPDATE customers SET balance=balance-? WHERE id=?', [eventDiscount, currentSale.customer_id]);
      const [c] = await conn.query('SELECT balance FROM customers WHERE id=?', [currentSale.customer_id]);
      await conn.query(
        `INSERT INTO customer_ledger (customer_id, date, invoice_no, description, dr, cr, balance, reference_type, reference_id)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [currentSale.customer_id, date, currentSale.invoice_no, `Discount on Invoice ${currentSale.invoice_no} (Edited)`,
         0, eventDiscount, c[0].balance, 'payment', recoveryId]
      );
    }

    // ── Apply each pre-classified return line (shrink / credit / source_pending). ──
    for (const classified of classifiedReturns) {
      await applyReturnLine(conn, classified, { date, currentSale, recoveryId });
    }

    if (recoveredAmount > 0) {
      await conn.query('UPDATE customers SET balance=balance-? WHERE id=?', [recoveredAmount, currentSale.customer_id]);
      const [c3] = await conn.query('SELECT balance FROM customers WHERE id=?', [currentSale.customer_id]);
      const payDesc = `Cash Collected — Invoice ${currentSale.invoice_no} (Edited)${notes ? ' (' + notes + ')' : ''}`;
      await conn.query(
        `INSERT INTO customer_ledger (customer_id, date, invoice_no, description, dr, cr, balance, reference_type, reference_id)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [currentSale.customer_id, date, currentSale.invoice_no, payDesc, 0, recoveredAmount, c3[0].balance, 'payment', recoveryId]
      );
    }

    await conn.query(
      'UPDATE recoveries SET date=?, notes=?, total_discount=?, total_return_amount=?, net_collected=? WHERE id=?',
      [date, notes || null, eventDiscount, eventReturnAmount, recoveredAmount, recoveryId]
    );

    // ── 5. Rebuild net_collectible/pending_amount for every recovery on this
    //    sale, in chronological order, plus the sale's own rollup columns —
    //    keeps payment history and reports internally consistent after a
    //    mid-history correction. ─────────────────────────────────────────────
    const [allRecoveries] = await conn.query(
      'SELECT id, total_discount, total_return_amount, net_collected FROM recoveries WHERE sale_id=? ORDER BY date ASC, id ASC',
      [saleId]
    );
    let runDiscount = 0, runReturn = 0, runRecovered = 0, finalNet = 0, finalPending = 0;
    for (const r of allRecoveries) {
      runDiscount += parseFloat(r.total_discount || 0);
      runReturn += parseFloat(r.total_return_amount || 0);
      runRecovered += parseFloat(r.net_collected || 0);
      const netCollectible = parseFloat(currentSale.total_amount) - runDiscount - runReturn;
      if (netCollectible < -0.01) {
        throw Object.assign(new Error('Discount and returns exceed invoice total after this edit'), { status: 400 });
      }
      if (runRecovered - netCollectible > 0.01) {
        throw Object.assign(new Error('Amount recovered cannot exceed the pending balance for this invoice'), { status: 400 });
      }
      const pendingAmount = Math.max(0, netCollectible - runRecovered);
      await conn.query('UPDATE recoveries SET net_collectible=?, pending_amount=? WHERE id=?',
        [netCollectible, pendingAmount, r.id]);
      finalNet = netCollectible; finalPending = pendingAmount;
    }
    const recoveryStatus = finalPending <= 0.009 ? 'completed' : 'pending';

    await conn.query(
      `UPDATE sales SET total_discount=?, total_return_amount=?, net_collectible=?, total_recovered=?, pending_amount=?, recovery_status=? WHERE id=?`,
      [runDiscount, runReturn, finalNet, runRecovered, finalPending, recoveryStatus, saleId]
    );

    await conn.commit();
    await logAudit(req, 'UPDATE', 'recovery', recoveryId,
      `Recovery on invoice ${currentSale.invoice_no} edited by admin: discount ${eventDiscount}, returns ${eventReturnAmount}, recovered ${recoveredAmount}, pending ${finalPending}, status ${recoveryStatus}`);

    res.json({
      id: recoveryId,
      net_collectible: finalNet,
      amount_recovered: recoveredAmount,
      total_recovered: runRecovered,
      pending_amount: finalPending,
      net_collected: recoveredAmount,
      recovery_status: recoveryStatus,
      expiry_warnings: expiryWarnings.length ? expiryWarnings : undefined,
    });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(err.status || 500).json({ message: err.message });
  } finally { conn.release(); }
});

module.exports = router;