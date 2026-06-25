const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');
const { logAudit } = require('../middleware/auditLog');

router.get('/', auth, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT r.*, s.invoice_no, s.date as sale_date, s.total_amount as invoice_total,
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

router.get('/:id', auth, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT r.*, s.invoice_no, s.date as sale_date, s.total_amount as invoice_total,
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

    const [sRows] = await conn.query('SELECT * FROM sales WHERE id=?', [sale_id]);
    if (sRows.length === 0) return res.status(404).json({ message: 'Sale not found' });
    const currentSale = sRows[0];

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

    const totalDiscount = (recovery_items || []).reduce((s, i) => s + parseFloat(i.discount_given || 0), 0);
    const totalReturnAmount = allReturnItems.reduce((s, i) => s + parseFloat(i.return_amount || 0), 0);
    const netCollectible = parseFloat(currentSale.total_amount) - totalDiscount - totalReturnAmount;
    if (netCollectible < 0) {
      return res.status(400).json({ message: 'Discount and returns exceed invoice total' });
    }

    let recoveredAmount = netCollectible;
    if (amount_recovered !== undefined && amount_recovered !== null && amount_recovered !== '') {
      recoveredAmount = parseFloat(amount_recovered);
      if (Number.isNaN(recoveredAmount) || recoveredAmount < 0) {
        return res.status(400).json({ message: 'Recovered amount must be zero or greater' });
      }
      if (recoveredAmount > netCollectible) {
        return res.status(400).json({ message: `Recovered amount cannot exceed net collectible (${netCollectible.toFixed(2)})` });
      }
    }
    const pendingAmount = netCollectible - recoveredAmount;

    // Insert recovery header
    const [result] = await conn.query(
      `INSERT INTO recoveries (sale_id, salesman_id, date, notes, total_discount, total_return_amount, net_collectible, net_collected, pending_amount)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [sale_id, salesman_id || null, date, notes || null, totalDiscount, totalReturnAmount, netCollectible, recoveredAmount, pendingAmount]
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
    if (totalDiscount > 0) {
      await conn.query('UPDATE customers SET balance=balance-? WHERE id=?',
        [totalDiscount, currentSale.customer_id]);
      const [custAfterDisc] = await conn.query('SELECT balance FROM customers WHERE id=?', [currentSale.customer_id]);
      await conn.query(
        `INSERT INTO customer_ledger (customer_id, date, invoice_no, description, dr, cr, balance, reference_type, reference_id)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [currentSale.customer_id, date, currentSale.invoice_no,
         `Discount on Invoice ${currentSale.invoice_no}`,
         0, totalDiscount, custAfterDisc[0].balance, 'payment', recoveryId]
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
          const newQty = parseInt(si.qty) - qtyRet;
          if (newQty <= 0) {
            await conn.query('DELETE FROM sale_items WHERE id=?', [item.sale_item_id]);
          } else {
            const discFactor = 1 - parseFloat(si.discount_pct || 0) / 100;
            const taxFactor = 1 + parseFloat(si.tax_pct || 0) / 100;
            const newTotal = newQty * parseFloat(si.sale_rate) * discFactor * taxFactor;
            await conn.query('UPDATE sale_items SET qty=?, total=? WHERE id=?', [newQty, newTotal.toFixed(2), si.id]);
          }

          // Recalculate source invoice total
          const [newItems] = await conn.query('SELECT SUM(total) as t FROM sale_items WHERE sale_id=?', [item.sale_id]);
          const newSaleTotal = parseFloat(newItems[0].t || 0);
          await conn.query('UPDATE sales SET total_amount=? WHERE id=?', [newSaleTotal, item.sale_id]);

          // Adjust source ledger DR entry (reduce it)
          await conn.query(
            'UPDATE customer_ledger SET dr=dr-?, balance=balance-? WHERE reference_type="sale" AND reference_id=?',
            [retAmt, retAmt, item.sale_id]
          );
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

    // ── Record cash recovered in ledger (partial or full) ───────────
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

    // Lock the current invoice
    await conn.query('UPDATE sales SET is_locked=1 WHERE id=?', [sale_id]);

    await conn.commit();
    await logAudit(req, 'CREATE', 'recovery', recoveryId,
      `Recovery on invoice ${currentSale.invoice_no}: discount ${totalDiscount}, returns ${totalReturnAmount}, recovered ${recoveredAmount}, pending ${pendingAmount}`);
    res.status(201).json({
      id: recoveryId,
      net_collectible: netCollectible,
      amount_recovered: recoveredAmount,
      pending_amount: pendingAmount,
      net_collected: recoveredAmount,
    });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ message: err.message });
  } finally { conn.release(); }
});

module.exports = router;
