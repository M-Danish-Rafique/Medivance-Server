const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');
const { logAudit } = require('../middleware/auditLog');
const { todayPKT, formatDatePKT, addMonthsPKT } = require('../utils/dateUtils');

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

// ── Other pending (unpaid) invoices for a customer — used by the "(Other) Pending Invoices" tab ──
router.get('/pending-invoices/:customerId', auth, async (req, res) => {
  try {
    const exclude = req.query.exclude ? parseInt(req.query.exclude) : null;
    const params = [req.params.customerId];
    let sql = `
      SELECT s.id, s.invoice_no, s.date, s.total_amount, s.total_discount,
             s.total_return_amount, s.net_collectible, s.total_recovered,
             s.pending_amount, s.recovery_status
      FROM sales s
      WHERE s.customer_id=? AND s.recovery_status='pending'`;
    if (exclude) { sql += ' AND s.id != ?'; params.push(exclude); }
    sql += ' ORDER BY s.date ASC';
    const [rows] = await db.query(sql, params);
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
      `SELECT rt.*, p.name as product_name, s.invoice_no as source_invoice, si.qty as current_sold_qty
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

    if (currentSale.recovery_status === 'completed') {
      return res.status(400).json({ message: `Invoice ${currentSale.invoice_no} is already fully recovered.` });
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

    // ── This event's discount / return amounts (not cumulative) ─────
    const eventDiscount = (recovery_items || []).reduce((s, i) => s + parseFloat(i.discount_given || 0), 0);
    const eventReturnAmount = allReturnItems.reduce((s, i) => s + parseFloat(i.return_amount || 0), 0);

    // ── Cumulative figures carried over from prior recovery events on this invoice ──
    const priorDiscount = parseFloat(currentSale.total_discount || 0);
    const priorReturn = parseFloat(currentSale.total_return_amount || 0);
    const priorRecovered = parseFloat(currentSale.total_recovered || 0);

    const newTotalDiscount = priorDiscount + eventDiscount;
    const newTotalReturn = priorReturn + eventReturnAmount;
    const netCollectible = parseFloat(currentSale.total_amount) - newTotalDiscount - newTotalReturn;
    if (netCollectible < 0) {
      return res.status(400).json({ message: 'Discount and returns exceed invoice total' });
    }

    const pendingBeforeThisPayment = netCollectible - priorRecovered;

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

    // ── Process returns ─────────────────────────────────────────────
    for (const item of allReturnItems) {
      if (!item.qty_returned || parseInt(item.qty_returned) <= 0) continue;

      const qtyRet = parseInt(item.qty_returned);
      const retRate = parseFloat(item.return_rate || 0);
      const retAmt = qtyRet * retRate;

      const [srcSaleRows] = await conn.query('SELECT * FROM sales WHERE id=?', [item.sale_id]);
      if (!srcSaleRows.length) continue;
      const srcSale = srcSaleRows[0];

      await conn.query(
        `INSERT INTO return_items (recovery_id, sale_id, sale_item_id, product_id, batch_no, qty_returned, return_rate, return_amount)
         VALUES (?,?,?,?,?,?,?,?)`,
        [recoveryId, item.sale_id, item.sale_item_id, item.product_id,
         item.batch_no, qtyRet, retRate, retAmt]
      );

      // Restore inventory
      await conn.query(
        'UPDATE inventory SET qty=qty+? WHERE product_id=? AND batch_no=?',
        [qtyRet, item.product_id, item.batch_no]
      );

      if (!srcSale.is_locked) {
        // Unlocked: update source sale_item qty & invoice total
        const [siRows] = await conn.query('SELECT * FROM sale_items WHERE id=?', [item.sale_item_id]);
        if (siRows.length > 0) {
          const si = siRows[0];
          const newQty = Math.max(0, parseInt(si.qty) - qtyRet);
          if (newQty <= 0) {
            // Do NOT delete: return_items.sale_item_id (FK, no ON DELETE CASCADE)
            // already references this row from the INSERT above in this same
            // transaction, so a delete here would always violate fk_ret_sale_item.
            // Zero it out instead — preserves history/joins for return_items.
            await conn.query('UPDATE sale_items SET qty=0, total=0 WHERE id=?', [si.id]);
          } else {
            const discFactor = 1 - parseFloat(si.discount_pct || 0) / 100;
            const taxFactor = 1 + parseFloat(si.tax_pct || 0) / 100;
            const newTotal = newQty * parseFloat(si.sale_rate) * discFactor * taxFactor;
            await conn.query('UPDATE sale_items SET qty=?, total=? WHERE id=?', [newQty, newTotal.toFixed(2), si.id]);
          }

          // Recalculate source invoice total
          const [newItems] = await conn.query('SELECT SUM(total) as t FROM sale_items WHERE sale_id=?', [item.sale_id]);
          const newSaleTotal = parseFloat(newItems[0].t || 0);
          // srcSale is unlocked, meaning no recovery has happened against it yet, so its
          // net_collectible / pending_amount simply track its (now smaller) invoice total.
          await conn.query(
            'UPDATE sales SET total_amount=?, net_collectible=?, pending_amount=? WHERE id=?',
            [newSaleTotal, newSaleTotal, newSaleTotal, item.sale_id]
          );

          // Adjust source ledger DR entry (reduce it)
          const [ledgerRows] = await conn.query(
            'SELECT id, dr, cr FROM customer_ledger WHERE reference_type="sale" AND reference_id=?',
            [item.sale_id]
          );
          if (ledgerRows.length > 0) {
            const ledgerRow = ledgerRows[0];
            const newDr = parseFloat(ledgerRow.dr) - retAmt;
            if (newDr <= 0.009 && parseFloat(ledgerRow.cr || 0) <= 0.009) {
              // Full return: no dr or cr impact remains — drop the entry entirely.
              await conn.query('DELETE FROM customer_ledger WHERE id=?', [ledgerRow.id]);
            } else {
              await conn.query(
                'UPDATE customer_ledger SET dr=?, balance=balance-? WHERE id=?',
                [Math.max(0, newDr).toFixed(2), retAmt, ledgerRow.id]
              );
            }
          }
          await conn.query('UPDATE customers SET balance=balance-? WHERE id=?',
            [retAmt, srcSale.customer_id]);
        }
      } else {
        // Locked invoice: add explicit return credit row in ledger
        await conn.query('UPDATE customers SET balance=balance-? WHERE id=?',
          [retAmt, currentSale.customer_id]);
        const [custAfterRet] = await conn.query('SELECT balance FROM customers WHERE id=?', [currentSale.customer_id]);
        await conn.query(
          `INSERT INTO customer_ledger (customer_id, date, invoice_no, description, dr, cr, balance, reference_type, reference_id)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [currentSale.customer_id, date, srcSale.invoice_no,
           `Return — ${qtyRet} unit(s) of ${item.product_name || 'product'} from ${srcSale.invoice_no}`,
           0, retAmt, custAfterRet[0].balance, 'payment', recoveryId]
        );
      }
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
    res.status(500).json({ message: err.message });
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
    //    net effect on the customer's balance. ──────────────────────────────
    const [oldLedgerRows] = await conn.query(
      `SELECT id, dr, cr, description FROM customer_ledger WHERE reference_type='payment' AND reference_id=?`,
      [recoveryId]
    );
    // Descriptions of the locked-invoice return-credit rows mention the source
    // invoice number — used below to tell which old return lines went through
    // the "locked" branch (fully reverted here) vs the "unlocked" branch
    // (needs the source invoice's own qty/total/ledger row restored too).
    const lockedReturnDescriptions = oldLedgerRows
      .filter(r => r.description && r.description.startsWith('Return —'))
      .map(r => r.description);

    let reverseBalance = 0;
    for (const lr of oldLedgerRows) reverseBalance += parseFloat(lr.cr || 0) - parseFloat(lr.dr || 0);
    if (Math.abs(reverseBalance) > 0.0001) {
      await conn.query('UPDATE customers SET balance=balance+? WHERE id=?', [reverseBalance, currentSale.customer_id]);
    }
    await conn.query(`DELETE FROM customer_ledger WHERE reference_type='payment' AND reference_id=?`, [recoveryId]);

    // ── 2. Revert every old return line. ─────────────────────────────────────
    for (const old of oldReturnItems) {
      // Undo the restock that happened when this return was originally processed.
      await conn.query('UPDATE inventory SET qty=qty-? WHERE product_id=? AND batch_no=?',
        [old.qty_returned, old.product_id, old.batch_no]);

      const [srcRows] = await conn.query('SELECT * FROM sales WHERE id=?', [old.sale_id]);
      if (!srcRows.length) continue;
      const srcSale = srcRows[0];
      const wasLockedBranch = lockedReturnDescriptions.some(d => d.includes(srcSale.invoice_no));

      if (!wasLockedBranch) {
        // Was processed via the "unlocked" branch — restore the source invoice's
        // sale_item qty/total, its rollup columns, and its own ledger DR row.
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

          const retAmt = parseFloat(old.return_amount || 0);
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
      }
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

    const eventDiscount = (recovery_items || []).reduce((s, i) => s + parseFloat(i.discount_given || 0), 0);
    const eventReturnAmount = allReturnItems.reduce((s, i) => s + parseFloat(i.return_amount || 0), 0);
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

    for (const item of allReturnItems) {
      if (!item.qty_returned || parseInt(item.qty_returned) <= 0) continue;
      const qtyRet = parseInt(item.qty_returned);
      const retRate = parseFloat(item.return_rate || 0);
      const retAmt = qtyRet * retRate;

      const [srcSaleRows] = await conn.query('SELECT * FROM sales WHERE id=?', [item.sale_id]);
      if (!srcSaleRows.length) continue;
      const srcSale = srcSaleRows[0];

      await conn.query(
        `INSERT INTO return_items (recovery_id, sale_id, sale_item_id, product_id, batch_no, qty_returned, return_rate, return_amount)
         VALUES (?,?,?,?,?,?,?,?)`,
        [recoveryId, item.sale_id, item.sale_item_id, item.product_id, item.batch_no, qtyRet, retRate, retAmt]
      );

      await conn.query('UPDATE inventory SET qty=qty+? WHERE product_id=? AND batch_no=?',
        [qtyRet, item.product_id, item.batch_no]);

      if (!srcSale.is_locked) {
        const [siRows] = await conn.query('SELECT * FROM sale_items WHERE id=?', [item.sale_item_id]);
        if (siRows.length > 0) {
          const si = siRows[0];
          const newQty = Math.max(0, parseInt(si.qty) - qtyRet);
          if (newQty <= 0) {
            await conn.query('UPDATE sale_items SET qty=0, total=0 WHERE id=?', [si.id]);
          } else {
            const discFactor = 1 - parseFloat(si.discount_pct || 0) / 100;
            const taxFactor = 1 + parseFloat(si.tax_pct || 0) / 100;
            const newTotal = newQty * parseFloat(si.sale_rate) * discFactor * taxFactor;
            await conn.query('UPDATE sale_items SET qty=?, total=? WHERE id=?', [newQty, newTotal.toFixed(2), si.id]);
          }

          const [newItems] = await conn.query('SELECT SUM(total) as t FROM sale_items WHERE sale_id=?', [item.sale_id]);
          const newSaleTotal = parseFloat(newItems[0].t || 0);
          await conn.query(
            'UPDATE sales SET total_amount=?, net_collectible=?, pending_amount=? WHERE id=?',
            [newSaleTotal, newSaleTotal, newSaleTotal, item.sale_id]
          );

          const [ledgerRows] = await conn.query(
            'SELECT id, dr, cr FROM customer_ledger WHERE reference_type="sale" AND reference_id=?',
            [item.sale_id]
          );
          if (ledgerRows.length > 0) {
            const ledgerRow = ledgerRows[0];
            const newDr = parseFloat(ledgerRow.dr) - retAmt;
            if (newDr <= 0.009 && parseFloat(ledgerRow.cr || 0) <= 0.009) {
              await conn.query('DELETE FROM customer_ledger WHERE id=?', [ledgerRow.id]);
            } else {
              await conn.query(
                'UPDATE customer_ledger SET dr=?, balance=balance-? WHERE id=?',
                [Math.max(0, newDr).toFixed(2), retAmt, ledgerRow.id]
              );
            }
          }
          await conn.query('UPDATE customers SET balance=balance-? WHERE id=?', [retAmt, srcSale.customer_id]);
        }
      } else {
        await conn.query('UPDATE customers SET balance=balance-? WHERE id=?', [retAmt, currentSale.customer_id]);
        const [c2] = await conn.query('SELECT balance FROM customers WHERE id=?', [currentSale.customer_id]);
        await conn.query(
          `INSERT INTO customer_ledger (customer_id, date, invoice_no, description, dr, cr, balance, reference_type, reference_id)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [currentSale.customer_id, date, srcSale.invoice_no,
           `Return — ${qtyRet} unit(s) of ${item.product_name || 'product'} from ${srcSale.invoice_no} (Edited)`,
           0, retAmt, c2[0].balance, 'payment', recoveryId]
        );
      }
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