const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');

router.get('/', auth, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT cu.*, ci.name as city_name, a.name as area_name, t.name as territory_name
      FROM customers cu
      LEFT JOIN cities ci ON cu.city_id=ci.id
      LEFT JOIN areas a ON cu.area_id=a.id
      LEFT JOIN territories t ON cu.territory_id=t.id
      ORDER BY cu.name
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/:id', auth, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT cu.*, ci.name as city_name, a.name as area_name, t.name as territory_name
      FROM customers cu
      LEFT JOIN cities ci ON cu.city_id=ci.id
      LEFT JOIN areas a ON cu.area_id=a.id
      LEFT JOIN territories t ON cu.territory_id=t.id
      WHERE cu.id=?`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Customer not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/', auth, async (req, res) => {
  try {
    const { name, address, phone, license_no, license_expiry, city_id, area_id, territory_id } = req.body;
    if (!name) return res.status(400).json({ message: 'Customer name required' });
    const [result] = await db.query(
      'INSERT INTO customers (name, address, phone, license_no, license_expiry, city_id, area_id, territory_id) VALUES (?,?,?,?,?,?,?,?)',
      [name, address, phone, license_no || null, license_expiry || null, city_id || null, area_id || null, territory_id || null]
    );
    res.status(201).json({ id: result.insertId, ...req.body });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.put('/:id', auth, async (req, res) => {
  try {
    const { name, address, phone, license_no, license_expiry, city_id, area_id, territory_id } = req.body;
    await db.query(
      'UPDATE customers SET name=?, address=?, phone=?, license_no=?, license_expiry=?, city_id=?, area_id=?, territory_id=? WHERE id=?',
      [name, address, phone, license_no || null, license_expiry || null, city_id || null, area_id || null, territory_id || null, req.params.id]
    );
    res.json({ message: 'Updated successfully' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    await db.query('DELETE FROM customers WHERE id=?', [req.params.id]);
    res.json({ message: 'Deleted successfully' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/:id/balance', auth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT balance FROM customers WHERE id=?', [req.params.id]);
    res.json({ balance: rows[0]?.balance || 0 });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
