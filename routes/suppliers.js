const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');

router.get('/', auth, async (req, res) => {
  try {
    const { type } = req.query;
    let sql = 'SELECT * FROM suppliers';
    const params = [];
    if (type) { sql += ' WHERE supplier_type=? OR supplier_type="both"'; params.push(type); }
    sql += ' ORDER BY name';
    const [suppliers] = await db.query(sql, params);
    for (const s of suppliers) {
      const [products] = await db.query(`
        SELECT p.id, p.name FROM supplier_products sp
        JOIN products p ON sp.product_id=p.id WHERE sp.supplier_id=?`, [s.id]);
      const [companies] = await db.query(`
        SELECT c.id, c.name FROM supplier_companies sc
        JOIN companies c ON sc.company_id=c.id WHERE sc.supplier_id=?`, [s.id]);
      s.products = products;
      s.companies = companies;
    }
    res.json(suppliers);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/:id', auth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM suppliers WHERE id=?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Supplier not found' });
    const s = rows[0];
    const [products] = await db.query(`
      SELECT p.id, p.name FROM supplier_products sp
      JOIN products p ON sp.product_id=p.id WHERE sp.supplier_id=?`, [s.id]);
    const [companies] = await db.query(`
      SELECT c.id, c.name FROM supplier_companies sc
      JOIN companies c ON sc.company_id=c.id WHERE sc.supplier_id=?`, [s.id]);
    s.products = products;
    s.companies = companies;
    res.json(s);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/', auth, async (req, res) => {
  try {
    const { name, address, phone, supplier_type, product_ids = [], company_ids = [] } = req.body;
    if (!name) return res.status(400).json({ message: 'Supplier name required' });
    const conn = await db.getConnection();
    await conn.beginTransaction();
    try {
      const [result] = await conn.query('INSERT INTO suppliers (name, address, phone, supplier_type) VALUES (?,?,?,?)', [name, address, phone, supplier_type || 'product']);
      const sid = result.insertId;
      for (const pid of product_ids) {
        await conn.query('INSERT IGNORE INTO supplier_products (supplier_id, product_id) VALUES (?,?)', [sid, pid]);
      }
      for (const cid of company_ids) {
        await conn.query('INSERT IGNORE INTO supplier_companies (supplier_id, company_id) VALUES (?,?)', [sid, cid]);
      }
      await conn.commit();
      res.status(201).json({ id: sid, name, address, phone });
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.put('/:id', auth, async (req, res) => {
  try {
    const { name, address, phone, supplier_type, product_ids = [], company_ids = [] } = req.body;
    const conn = await db.getConnection();
    await conn.beginTransaction();
    try {
      await conn.query('UPDATE suppliers SET name=?, address=?, phone=?, supplier_type=? WHERE id=?', [name, address, phone, supplier_type || 'product', req.params.id]);
      await conn.query('DELETE FROM supplier_products WHERE supplier_id=?', [req.params.id]);
      await conn.query('DELETE FROM supplier_companies WHERE supplier_id=?', [req.params.id]);
      for (const pid of product_ids) {
        await conn.query('INSERT IGNORE INTO supplier_products (supplier_id, product_id) VALUES (?,?)', [req.params.id, pid]);
      }
      for (const cid of company_ids) {
        await conn.query('INSERT IGNORE INTO supplier_companies (supplier_id, company_id) VALUES (?,?)', [req.params.id, cid]);
      }
      await conn.commit();
      res.json({ message: 'Updated successfully' });
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    await db.query('DELETE FROM suppliers WHERE id=?', [req.params.id]);
    res.json({ message: 'Deleted successfully' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/:id/balance', auth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT balance FROM suppliers WHERE id=?', [req.params.id]);
    res.json({ balance: rows[0]?.balance || 0 });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
