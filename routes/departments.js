const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const auth    = require('../middleware/auth');
const requirePermission = require('../middleware/requirePermission');

// ─── Departments (HR lookup) ───────────────────────────────────────────────
// Single-field lookup CRUD, same shape as geography.js's cities. Gated on
// perm_hr_employees because the list is only ever consumed by the HR module.
const perm = requirePermission('perm_hr_employees', 'Workforce Management');

// GET / — list, with a live usage count so the UI can explain why a row
// cannot be deleted before the user tries.
router.get('/', auth, perm, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT d.id, d.name,
             (SELECT COUNT(*) FROM hr_employees e WHERE e.department_id = d.id) AS employee_count
        FROM departments d
       ORDER BY d.name
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/', auth, perm, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ message: 'Department name is required' });

    const [existing] = await db.query('SELECT id FROM departments WHERE LOWER(name)=LOWER(?)', [name]);
    if (existing.length) return res.status(409).json({ message: `"${name}" already exists as a department` });

    const [result] = await db.query('INSERT INTO departments (name) VALUES (?)', [name]);
    res.status(201).json({ id: result.insertId, name, employee_count: 0 });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'That department already exists' });
    res.status(500).json({ message: err.message });
  }
});

router.put('/:id', auth, perm, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ message: 'Department name is required' });

    const [existing] = await db.query(
      'SELECT id FROM departments WHERE LOWER(name)=LOWER(?) AND id<>?',
      [name, req.params.id]
    );
    if (existing.length) return res.status(409).json({ message: `"${name}" already exists as a department` });

    const [result] = await db.query('UPDATE departments SET name=? WHERE id=?', [name, req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Department not found' });
    res.json({ message: 'Department updated', id: Number(req.params.id), name });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'That department already exists' });
    res.status(500).json({ message: err.message });
  }
});

// DELETE /:id — blocked while any employee still sits in this department.
// hr_employees.department_id is NOT NULL with a restricting FK, so letting
// MySQL raise ER_ROW_IS_REFERENCED would surface as an opaque 500; the
// pre-check turns it into a message an HR user can act on.
router.delete('/:id', auth, perm, async (req, res) => {
  try {
    const [[usage]] = await db.query(
      'SELECT COUNT(*) AS cnt FROM hr_employees WHERE department_id = ?',
      [req.params.id]
    );
    if (usage.cnt > 0) {
      return res.status(409).json({
        message: `This department is assigned to ${usage.cnt} employee${usage.cnt === 1 ? '' : 's'}. Move them to another department first.`,
      });
    }

    const [result] = await db.query('DELETE FROM departments WHERE id=?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Department not found' });
    res.json({ message: 'Department deleted' });
  } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(409).json({ message: 'This department is still in use and cannot be deleted' });
    }
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
