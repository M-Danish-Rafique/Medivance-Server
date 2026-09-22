const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const auth    = require('../middleware/auth');
const requirePermission = require('../middleware/requirePermission');

// ─── Designations (HR lookup) ──────────────────────────────────────────────
// Mirror of departments.js — kept as its own file rather than a shared
// factory, matching this codebase's convention of duplicating small route
// bodies per resource (see geography.js's cities/areas/territories).
const perm = requirePermission('perm_hr_employees', 'Workforce Management');

router.get('/', auth, perm, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT d.id, d.name,
             (SELECT COUNT(*) FROM hr_employees e WHERE e.designation_id = d.id) AS employee_count
        FROM designations d
       ORDER BY d.name
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/', auth, perm, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ message: 'Designation name is required' });

    const [existing] = await db.query('SELECT id FROM designations WHERE LOWER(name)=LOWER(?)', [name]);
    if (existing.length) return res.status(409).json({ message: `"${name}" already exists as a designation` });

    const [result] = await db.query('INSERT INTO designations (name) VALUES (?)', [name]);
    res.status(201).json({ id: result.insertId, name, employee_count: 0 });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'That designation already exists' });
    res.status(500).json({ message: err.message });
  }
});

router.put('/:id', auth, perm, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ message: 'Designation name is required' });

    const [existing] = await db.query(
      'SELECT id FROM designations WHERE LOWER(name)=LOWER(?) AND id<>?',
      [name, req.params.id]
    );
    if (existing.length) return res.status(409).json({ message: `"${name}" already exists as a designation` });

    const [result] = await db.query('UPDATE designations SET name=? WHERE id=?', [name, req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Designation not found' });
    res.json({ message: 'Designation updated', id: Number(req.params.id), name });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'That designation already exists' });
    res.status(500).json({ message: err.message });
  }
});

router.delete('/:id', auth, perm, async (req, res) => {
  try {
    const [[usage]] = await db.query(
      'SELECT COUNT(*) AS cnt FROM hr_employees WHERE designation_id = ?',
      [req.params.id]
    );
    if (usage.cnt > 0) {
      return res.status(409).json({
        message: `This designation is held by ${usage.cnt} employee${usage.cnt === 1 ? '' : 's'}. Reassign them first.`,
      });
    }

    const [result] = await db.query('DELETE FROM designations WHERE id=?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Designation not found' });
    res.json({ message: 'Designation deleted' });
  } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(409).json({ message: 'This designation is still in use and cannot be deleted' });
    }
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
