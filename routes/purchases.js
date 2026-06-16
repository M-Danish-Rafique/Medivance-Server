const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');
const { logAudit } = require('../middleware/auditLog');

function getPurchasePrefix(dateValue) {
  const date = dateValue ? new Date(dateValue) : new Date();
  if (isNaN(date.getTime())) return 'P' + String(new Date().getFullYear()).slice(-2);
  const year = date.getFullYear();
  return `P${String(year).slice(-2)}`;
}

async function generatePurchaseId(dateValue) {
  const prefix = getPurchasePrefix(dateValue);
  const [rows] = await db.query('SELECT purchase_id FROM purchases WHERE purchase_id LIKE ? ORDER BY purchase_id DESC LIMIT 1', [`${prefix}-%`]);
  if (rows.length === 0) return `${prefix}-00001`;
  const num = parseInt(rows[0].purchase_id.split('-')[1]) + 1;
  return `${prefix}-${String(num).padStart(5, '0')}`;
}

router.get('/', auth, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT p.*, s.name as supplier_name FROM purchases p
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

router.post('/', auth, async (req, res) => {
  const conn = await db.getConnection();
  await conn.beginTransaction();
  try {
    const { supplier_id, invoice_no, date, items } = req.body;
    if (!supplier_id || !date || !items || items.length === 0) {
      return res.status(400).json({ message: 'Supplier, date and items are required' });
    }

    const purchase_id = await generatePurchaseId(date);
    const total_amount = items.reduce((sum, i) => sum + parseFloat(i.total || 0), 0);

    const [result] = await conn.query(
      'INSERT INTO purchases (purchase_id, supplier_id, invoice_no, date, total_amount) VALUES (?,?,?,?,?)',
      [purchase_id, supplier_id, invoice_no, date, total_amount]
    );
    const pId = result.insertId;

    for (const item of items) {
      await conn.query(
        `INSERT INTO purchase_items
        (purchase_id, product_id, batch_no, pack_size, purchase_rate, qty, bonus, discount_pct, tax_pct, sale_tax_pct, exp_date, retail_price, total)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [pId, item.product_id, item.batch_no, item.pack_size, item.purchase_rate,
         item.qty, item.bonus || 0, item.discount_pct || 0, item.tax_pct || 0,
         item.sale_tax_pct || 0, item.exp_date || null, item.retail_price || 0, item.total]
      );

      const totalQty = parseInt(item.qty) + parseInt(item.bonus || 0);
      const [existing] = await conn.query(
        'SELECT * FROM inventory WHERE product_id=? AND batch_no=?',
        [item.product_id, item.batch_no]
      );
      if (existing.length > 0) {
        await conn.query(
          'UPDATE inventory SET qty=qty+?, purchase_rate=?, sale_rate=?, retail_price=?, exp_date=?, updated_at=NOW() WHERE product_id=? AND batch_no=?',
          [totalQty, item.purchase_rate, item.sale_rate || existing[0].sale_rate, item.retail_price, item.exp_date || null, item.product_id, item.batch_no]
        );
      } else {
        await conn.query(
          'INSERT INTO inventory (product_id, batch_no, qty, purchase_rate, sale_rate, retail_price, exp_date) VALUES (?,?,?,?,?,?,?)',
          [item.product_id, item.batch_no, totalQty, item.purchase_rate, item.sale_rate || 0, item.retail_price || 0, item.exp_date || null]
        );
      }
    }

    await conn.query('UPDATE suppliers SET balance=balance+? WHERE id=?', [total_amount, supplier_id]);
    const [supRows] = await conn.query('SELECT balance FROM suppliers WHERE id=?', [supplier_id]);
    const newBalance = supRows[0].balance;
    await conn.query(
      'INSERT INTO supplier_ledger (supplier_id, date, invoice_no, description, dr, cr, balance, reference_type, reference_id) VALUES (?,?,?,?,?,?,?,?,?)',
      [supplier_id, date, invoice_no || purchase_id, 'Purchase', total_amount, 0, newBalance, 'purchase', pId]
    );

    await conn.commit();
    await logAudit(req, 'CREATE', 'purchase', pId, `Created purchase ${purchase_id} from supplier ${supplier_id} — PKR ${total_amount}`);
    res.status(201).json({ id: pId, purchase_id, total_amount });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
});

router.delete('/:id', auth, async (req, res) => {
  const conn = await db.getConnection();
  await conn.beginTransaction();
  try {
    const [pRows] = await conn.query('SELECT * FROM purchases WHERE id=?', [req.params.id]);
    if (pRows.length === 0) return res.status(404).json({ message: 'Purchase not found' });
    const purchase = pRows[0];

    const [items] = await conn.query('SELECT * FROM purchase_items WHERE purchase_id=?', [req.params.id]);
    for (const item of items) {
      const totalQty = parseInt(item.qty) + parseInt(item.bonus || 0);
      await conn.query(
        'UPDATE inventory SET qty=qty-? WHERE product_id=? AND batch_no=?',
        [totalQty, item.product_id, item.batch_no]
      );
    }

    await conn.query('UPDATE suppliers SET balance=balance-? WHERE id=?', [purchase.total_amount, purchase.supplier_id]);
    await conn.query('DELETE FROM supplier_ledger WHERE reference_type=? AND reference_id=?', ['purchase', req.params.id]);
    await conn.query('DELETE FROM purchases WHERE id=?', [req.params.id]);

    await conn.commit();
    await logAudit(req, 'DELETE', 'purchase', req.params.id, `Deleted purchase ID ${req.params.id}`);
    res.json({ message: 'Purchase deleted' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
});

module.exports = router;

// PUT — update purchase (reverses old inventory/ledger, applies new)
router.put('/:id', auth, async (req, res) => {
  const conn = await db.getConnection();
  await conn.beginTransaction();
  try {
    const { supplier_id, invoice_no, date, items } = req.body;
    const [pRows] = await conn.query('SELECT * FROM purchases WHERE id=?', [req.params.id]);
    if (pRows.length === 0) return res.status(404).json({ message: 'Purchase not found' });
    const old = pRows[0];

    // 1. Reverse old inventory
    const [oldItems] = await conn.query('SELECT * FROM purchase_items WHERE purchase_id=?', [req.params.id]);
    for (const it of oldItems) {
      const totalQty = parseInt(it.qty) + parseInt(it.bonus || 0);
      await conn.query('UPDATE inventory SET qty=qty-? WHERE product_id=? AND batch_no=?',
        [totalQty, it.product_id, it.batch_no]);
    }

    // 2. Reverse supplier ledger entry
    await conn.query('UPDATE suppliers SET balance=balance-? WHERE id=?', [old.total_amount, old.supplier_id]);
    await conn.query('DELETE FROM supplier_ledger WHERE reference_type="purchase" AND reference_id=?', [req.params.id]);

    // 3. Delete old items
    await conn.query('DELETE FROM purchase_items WHERE purchase_id=?', [req.params.id]);

    // 4. Insert new items
    const total_amount = items.reduce((s, i) => s + parseFloat(i.total || 0), 0);
    await conn.query(
      'UPDATE purchases SET supplier_id=?, invoice_no=?, date=?, total_amount=? WHERE id=?',
      [supplier_id, invoice_no || null, date, total_amount, req.params.id]
    );

    for (const item of items) {
      await conn.query(
        `INSERT INTO purchase_items
        (purchase_id, product_id, batch_no, pack_size, purchase_rate, qty, bonus,
         discount_pct, tax_pct, sale_tax_pct, exp_date, retail_price, total)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [req.params.id, item.product_id, item.batch_no, item.pack_size,
         item.purchase_rate, item.qty, item.bonus || 0,
         item.discount_pct || 0, item.tax_pct || 0, item.sale_tax_pct || 0,
         item.exp_date || null, item.retail_price || 0, item.total]
      );

      const totalQty = parseInt(item.qty) + parseInt(item.bonus || 0);
      const [existing] = await conn.query(
        'SELECT * FROM inventory WHERE product_id=? AND batch_no=?',
        [item.product_id, item.batch_no]
      );
      if (existing.length > 0) {
        await conn.query(
          'UPDATE inventory SET qty=qty+?, purchase_rate=?, retail_price=?, exp_date=?, updated_at=NOW() WHERE product_id=? AND batch_no=?',
          [totalQty, item.purchase_rate, item.retail_price, item.exp_date || null, item.product_id, item.batch_no]
        );
      } else {
        await conn.query(
          'INSERT INTO inventory (product_id, batch_no, qty, purchase_rate, sale_rate, retail_price, exp_date) VALUES (?,?,?,?,?,?,?)',
          [item.product_id, item.batch_no, totalQty, item.purchase_rate,
           item.sale_rate || 0, item.retail_price || 0, item.exp_date || null]
        );
      }
    }

    // 5. Re-add supplier ledger
    await conn.query('UPDATE suppliers SET balance=balance+? WHERE id=?', [total_amount, supplier_id]);
    const [supRows] = await conn.query('SELECT balance FROM suppliers WHERE id=?', [supplier_id]);
    await conn.query(
      `INSERT INTO supplier_ledger (supplier_id, date, invoice_no, description, dr, cr, balance, reference_type, reference_id)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [supplier_id, date, invoice_no || old.purchase_id, 'Purchase (Edited)',
       total_amount, 0, supRows[0].balance, 'purchase', req.params.id]
    );

    await conn.commit();
    await logAudit(req, 'UPDATE', 'purchase', req.params.id, `Updated purchase ID ${req.params.id}`);
    res.json({ message: 'Purchase updated successfully' });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ message: err.message });
  } finally { conn.release(); }
});
