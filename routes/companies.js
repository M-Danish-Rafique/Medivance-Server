const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');

// Generate company ID: MVC-XXXX
async function generateCompanyId() {
  const [rows] = await db.query('SELECT id FROM companies ORDER BY created_at DESC LIMIT 1');
  if (rows.length === 0) return 'MVC-0001';
  const last = rows[0].id;
  const num = parseInt(last.split('-')[1]) + 1;
  return `MVC-${String(num).padStart(4, '0')}`;
}

// GET all companies
router.get('/', auth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM companies ORDER BY name');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET single company
router.get('/:id', auth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM companies WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Company not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST create company
router.post('/', auth, async (req, res) => {
  try {
    const { name, address, phone } = req.body;
    if (!name) return res.status(400).json({ message: 'Company name is required' });
    const [existing] = await db.query('SELECT id FROM companies WHERE LOWER(name)=LOWER(?)', [name]);
    if (existing.length) return res.status(409).json({ message: 'Company already exists' });
    const id = await generateCompanyId();
    await db.query('INSERT INTO companies (id, name, address, phone) VALUES (?, ?, ?, ?)', [id, name, address, phone]);
    res.status(201).json({ id, name, address, phone });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Company already exists' });
    res.status(500).json({ message: err.message });
  }
});

// PUT update company
router.put('/:id', auth, async (req, res) => {
  try {
    const { name, address, phone } = req.body;
    if (!name) return res.status(400).json({ message: 'Company name is required' });
    const [existing] = await db.query('SELECT id FROM companies WHERE LOWER(name)=LOWER(?) AND id<>?', [name, req.params.id]);
    if (existing.length) return res.status(409).json({ message: 'Company name already exists' });
    await db.query('UPDATE companies SET name=?, address=?, phone=? WHERE id=?', [name, address, phone, req.params.id]);
    res.json({ message: 'Updated successfully' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Company name already exists' });
    res.status(500).json({ message: err.message });
  }
});

// DELETE company
router.delete('/:id', auth, async (req, res) => {
  try {
    await db.query('DELETE FROM companies WHERE id=?', [req.params.id]);
    res.json({ message: 'Deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
