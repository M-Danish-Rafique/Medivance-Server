const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');
const { logAudit } = require('../middleware/auditLog');

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
      `SELECT rt.*, p.name as product_name, s.invoice_no as source_invoice
       FROM return_items rt
       JOIN products p ON rt.product_id = p.id
       JOIN sales s ON rt.sale_id = s.id
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
    const allReturnItems = return_items || [];
    for (const item of allReturnItems) {
      if (!item.qty_returned || parseInt(item.qty_returned) <= 0) continue;
      // Get expiry date from inventory for this product+batch
      const [invRows] = await conn.query(
        'SELECT exp_date FROM inventory WHERE product_id=? AND batch_no=?',
        [item.product_id, item.batch_no]
      );
      if (invRows.length > 0 && invRows[0].exp_date) {
        const expiry = new Date(invRows[0].exp_date);
        const now = new Date();
        // 5 months before expiry threshold
        const threshold = new Date(expiry);
        threshold.setMonth(threshold.getMonth() - 5);
        if (now > threshold) {
          // Get product name for error message
          const [pRows] = await conn.query('SELECT name FROM products WHERE id=?', [item.product_id]);
          const pName = pRows[0]?.name || `Product ID ${item.product_id}`;
          return res.status(400).json({
            message: `Return not allowed for "${pName}" (Batch: ${item.batch_no}). Product expires ${expiry.toLocaleDateString('en-GB')} — within 5 months of expiry. Return window has passed.`
          });
        }
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

    let recoveredAmount = pendingBeforeThisPayment; // default: settle whatever is still outstanding
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
    });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ message: err.message });
  } finally { conn.release(); }
});

module.exports = router;