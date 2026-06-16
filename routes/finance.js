const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');

// Expense types
router.get('/expense-types', auth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM expense_types ORDER BY name');
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/expense-types', auth, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ message: 'Name required' });
    const [result] = await db.query('INSERT INTO expense_types (name) VALUES (?)', [name]);
    res.status(201).json({ id: result.insertId, name });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Expense type already exists' });
    res.status(500).json({ message: err.message });
  }
});

router.delete('/expense-types/:id', auth, async (req, res) => {
  try {
    await db.query('DELETE FROM expense_types WHERE id=?', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Finance transactions
router.get('/', auth, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT f.*, et.name as expense_type_name, s.name as supplier_name, c.name as customer_name
      FROM finance f
      LEFT JOIN expense_types et ON f.expense_type_id=et.id
      LEFT JOIN suppliers s ON f.supplier_id=s.id
      LEFT JOIN customers c ON f.customer_id=c.id
      ORDER BY f.date DESC, f.id DESC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/', auth, async (req, res) => {
  const conn = await db.getConnection();
  await conn.beginTransaction();
  try {
    const { date, category, description, expense_type_id, supplier_id, customer_id, amount, payment_type } = req.body;
    if (!date || !category || !amount) {
      return res.status(400).json({ message: 'Date, category and amount are required' });
    }

    const fullDescription = payment_type ? `${description || ''} [${payment_type}]` : description;

    const [result] = await conn.query(
      `INSERT INTO finance (date, category, description, expense_type_id, supplier_id, customer_id, amount, payment_type)
       VALUES (?,?,?,?,?,?,?,?)`,
      [date, category, fullDescription, expense_type_id || null, supplier_id || null, customer_id || null, amount, payment_type || null]
    );

    if (category === 'Payment to Supplier' && supplier_id) {
      // Payment reduces what we owe supplier (Cr in our books = reducing liability)
      await conn.query('UPDATE suppliers SET balance=balance-? WHERE id=?', [amount, supplier_id]);
      const [supRows] = await conn.query('SELECT balance FROM suppliers WHERE id=?', [supplier_id]);
      await conn.query(
        'INSERT INTO supplier_ledger (supplier_id, date, invoice_no, description, dr, cr, balance, reference_type, reference_id) VALUES (?,?,?,?,?,?,?,?,?)',
        [supplier_id, date, null, fullDescription, 0, amount, supRows[0].balance, 'payment', result.insertId]
      );
    } else if (category === 'Payment from Customer' && customer_id) {
      // Payment reduces what customer owes us
      await conn.query('UPDATE customers SET balance=balance-? WHERE id=?', [amount, customer_id]);
      const [custRows] = await conn.query('SELECT balance FROM customers WHERE id=?', [customer_id]);
      await conn.query(
        'INSERT INTO customer_ledger (customer_id, date, invoice_no, description, dr, cr, balance, reference_type, reference_id) VALUES (?,?,?,?,?,?,?,?,?)',
        [customer_id, date, null, fullDescription, 0, amount, custRows[0].balance, 'payment', result.insertId]
      );
    }

    await conn.commit();
    res.status(201).json({ id: result.insertId });
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
    const [rows] = await conn.query('SELECT * FROM finance WHERE id=?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Transaction not found' });
    const txn = rows[0];

    if (txn.category === 'Payment to Supplier' && txn.supplier_id) {
      await conn.query('UPDATE suppliers SET balance=balance+? WHERE id=?', [txn.amount, txn.supplier_id]);
      await conn.query('DELETE FROM supplier_ledger WHERE reference_type=? AND reference_id=?', ['payment', txn.id]);
    } else if (txn.category === 'Payment from Customer' && txn.customer_id) {
      await conn.query('UPDATE customers SET balance=balance+? WHERE id=?', [txn.amount, txn.customer_id]);
      await conn.query('DELETE FROM customer_ledger WHERE reference_type=? AND reference_id=?', ['payment', txn.id]);
    }

    await conn.query('DELETE FROM finance WHERE id=?', [req.params.id]);
    await conn.commit();
    res.json({ message: 'Deleted' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
});

module.exports = router;
