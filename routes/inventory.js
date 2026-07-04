const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');
const { sanitizeInventoryRows } = require('../utils/purchaseRateAccess');
const { logAudit } = require('../middleware/auditLog');

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

// Manual inventory entry — used to migrate stock from a previous system.
// Unlike POST /purchases, this ONLY writes to the inventory table: no purchase /
// purchase_items record is created, and no supplier ledger / balance is touched.
router.post('/manual', auth, async (req, res) => {
  const conn = await db.getConnection();
  await conn.beginTransaction();
  try {
    const { items } = req.body;
    if (!items || items.length === 0) {
      await conn.rollback();
      return res.status(400).json({ message: 'At least one item is required' });
    }

    const results = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const rowNum = i + 1;
      const { product_id, batch_no, qty, purchase_rate, sale_rate, retail_price, exp_date, low_stock_threshold } = item;

      if (!product_id || !batch_no) {
        throw new Error(`Row ${rowNum}: Product and Batch No are required`);
      }
      if (!qty || parseFloat(qty) <= 0) {
        throw new Error(`Row ${rowNum}: Qty must be greater than 0`);
      }

      const [existing] = await conn.query(
        'SELECT * FROM inventory WHERE product_id=? AND batch_no=?',
        [product_id, batch_no]
      );

      if (existing.length > 0) {
        // Batch already exists — add the migrated qty on top rather than overwrite it
        await conn.query(
          `UPDATE inventory
           SET qty = qty + ?,
               purchase_rate = ?,
               sale_rate = ?,
               retail_price = ?,
               exp_date = ?,
               low_stock_threshold = COALESCE(?, low_stock_threshold),
               updated_at = NOW()
           WHERE product_id=? AND batch_no=?`,
          [
            qty,
            purchase_rate || existing[0].purchase_rate,
            sale_rate || existing[0].sale_rate,
            retail_price || existing[0].retail_price,
            exp_date || existing[0].exp_date,
            low_stock_threshold || null,
            product_id, batch_no
          ]
        );
        results.push({ product_id, batch_no, action: 'updated' });
      } else {
        await conn.query(
          `INSERT INTO inventory
           (product_id, batch_no, qty, purchase_rate, sale_rate, retail_price, exp_date, low_stock_threshold)
           VALUES (?,?,?,?,?,?,?,?)`,
          [
            product_id, batch_no, qty,
            purchase_rate || 0, sale_rate || 0, retail_price || 0,
            exp_date || null, low_stock_threshold || 10
          ]
        );
        results.push({ product_id, batch_no, action: 'created' });
      }
    }

    await conn.commit();
    await logAudit(
      req, 'CREATE', 'inventory', null,
      `Manually added inventory — ${items.length} batch${items.length > 1 ? 'es' : ''} (migration entry, no purchase record created)`
    );
    res.status(201).json({ message: 'Inventory added successfully', results });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
});

module.exports = router;