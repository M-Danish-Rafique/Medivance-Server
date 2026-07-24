const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');

// Checks whether a customer with the same (name, city, area, territory)
// combination already exists. Uses the null-safe equality operator (<=>)
// so that NULL city/area/territory values are compared correctly instead
// of always evaluating to false as they would with plain '='.
async function findDuplicateCustomer(db, { name, city_id, area_id, territory_id }, excludeId = null) {
  let query = `
    SELECT id FROM customers
    WHERE name = ?
      AND city_id <=> ?
      AND area_id <=> ?
      AND territory_id <=> ?
  `;
  const params = [name, city_id || null, area_id || null, territory_id || null];
  if (excludeId) {
    query += ' AND id != ?';
    params.push(excludeId);
  }
  const [rows] = await db.query(query, params);
  return rows.length > 0;
}

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
    const { name, address, phone, license_no, license_expiry, city_id, area_id, territory_id, is_licensed } = req.body;
    if (!name) return res.status(400).json({ message: 'Customer name required' });

    const isDuplicate = await findDuplicateCustomer(db, { name, city_id, area_id, territory_id });
    if (isDuplicate) {
      return res.status(409).json({ message: 'A customer with this name already exists in the selected City, Area and Territory.' });
    }

    const [result] = await db.query(
      'INSERT INTO customers (name, address, phone, license_no, license_expiry, city_id, area_id, territory_id, is_licensed) VALUES (?,?,?,?,?,?,?,?,?)',
      [name, address, phone, license_no || null, license_expiry || null, city_id || null, area_id || null, territory_id || null, is_licensed ? 1 : 0]
    );
    res.status(201).json({ id: result.insertId, ...req.body, is_licensed: is_licensed ? 1 : 0 });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.put('/:id', auth, async (req, res) => {
  try {
    const { name, address, phone, license_no, license_expiry, city_id, area_id, territory_id, is_licensed } = req.body;

    const isDuplicate = await findDuplicateCustomer(db, { name, city_id, area_id, territory_id }, req.params.id);
    if (isDuplicate) {
      return res.status(409).json({ message: 'A customer with this name already exists in the selected City, Area and Territory.' });
    }

    await db.query(
      'UPDATE customers SET name=?, address=?, phone=?, license_no=?, license_expiry=?, city_id=?, area_id=?, territory_id=?, is_licensed=? WHERE id=?',
      [name, address, phone, license_no || null, license_expiry || null, city_id || null, area_id || null, territory_id || null, is_licensed ? 1 : 0, req.params.id]
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