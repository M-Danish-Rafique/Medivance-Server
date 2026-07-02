const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');
const { sanitizeInventoryRows } = require('../utils/purchaseRateAccess');

router.get('/', auth, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT i.id, i.product_id, i.batch_no, i.qty, i.purchase_rate, i.sale_rate,
             COALESCE(NULLIF(i.retail_price, 0), p.retail_price, 0) AS retail_price,
             i.exp_date, i.low_stock_threshold, i.created_at, i.updated_at,
             p.name AS product_name, p.pack_size, p.company_id, c.name AS company_name,
             p.show_purchase_rate
      FROM inventory i
      JOIN products p ON i.product_id = p.id
      LEFT JOIN companies c ON p.company_id = c.id
      ORDER BY p.name, i.batch_no
    `);
    const payload = await sanitizeInventoryRows(req, db, rows);
    res.json(payload);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/low-stock', auth, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT i.*, p.name as product_name, p.pack_size, p.show_purchase_rate
      FROM inventory i
      JOIN products p ON i.product_id = p.id
      WHERE i.qty <= i.low_stock_threshold AND i.qty > 0
      ORDER BY i.qty ASC
    `);
    const payload = await sanitizeInventoryRows(req, db, rows);
    res.json(payload);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/product/:product_id', auth, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT i.*, p.show_purchase_rate FROM inventory i JOIN products p ON p.id = i.product_id WHERE i.product_id=? ORDER BY batch_no',
      [req.params.product_id]
    );
    const payload = await sanitizeInventoryRows(req, db, rows);
    res.json(payload);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/check-batch', auth, async (req, res) => {
  try {
    const { product_id, batch_no } = req.query;
    const [rows] = await db.query(
      'SELECT * FROM inventory WHERE product_id=? AND batch_no=?',
      [product_id, batch_no]
    );
    res.json(rows.length > 0 ? rows[0] : null);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
