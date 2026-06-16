const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');

router.get('/', auth, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT p.*, c.name as company_name, pc.name as category_name,
             u.name as vol_uom_name, u.symbol as vol_uom_symbol
      FROM products p
      LEFT JOIN companies c ON p.company_id = c.id
      LEFT JOIN product_categories pc ON p.category_id = pc.id
      LEFT JOIN units_of_measurement u ON p.volume_uom_id = u.id
      ORDER BY p.name
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/:id', auth, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT p.*, c.name as company_name, pc.name as category_name,
             u.name as vol_uom_name, u.symbol as vol_uom_symbol
      FROM products p
      LEFT JOIN companies c ON p.company_id = c.id
      LEFT JOIN product_categories pc ON p.category_id = pc.id
      LEFT JOIN units_of_measurement u ON p.volume_uom_id = u.id
      WHERE p.id = ?`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Product not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/', auth, async (req, res) => {
  try {
    const { name, pack_size, purchase_rate, sale_rate, retail_price, company_id,
            category_id, volume, volume_uom_id, is_manufactured, tax_applicable, sale_tax_pct } = req.body;
    if (!name) return res.status(400).json({ message: 'Product name is required' });
    const [result] = await db.query(
      `INSERT INTO products (name, pack_size, purchase_rate, sale_rate, retail_price, company_id,
         category_id, volume, volume_uom_id, is_manufactured, tax_applicable, sale_tax_pct)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [name, pack_size, purchase_rate || 0, sale_rate || 0, retail_price || 0, company_id || null,
       category_id || null, volume || null, volume_uom_id || null,
       is_manufactured || 0, tax_applicable || 0, sale_tax_pct || 0]
    );
    res.status(201).json({ id: result.insertId, ...req.body });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.put('/:id', auth, async (req, res) => {
  try {
    const { name, pack_size, purchase_rate, sale_rate, retail_price, company_id,
            category_id, volume, volume_uom_id, is_manufactured, tax_applicable, sale_tax_pct } = req.body;
    await db.query(
      `UPDATE products SET name=?, pack_size=?, purchase_rate=?, sale_rate=?, retail_price=?,
         company_id=?, category_id=?, volume=?, volume_uom_id=?, is_manufactured=?,
         tax_applicable=?, sale_tax_pct=? WHERE id=?`,
      [name, pack_size, purchase_rate, sale_rate, retail_price, company_id || null,
       category_id || null, volume || null, volume_uom_id || null,
       is_manufactured || 0, tax_applicable || 0, sale_tax_pct || 0, req.params.id]
    );
    res.json({ message: 'Updated successfully' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    await db.query('DELETE FROM products WHERE id=?', [req.params.id]);
    res.json({ message: 'Deleted successfully' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
