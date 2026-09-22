const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');

function getRoleCode(role) {
  const codes = { Salesman: 'SM', Supplier: 'SP' };
  return codes[role] || String(role || '').slice(0, 2).toUpperCase();
}

function makeEmployeeCode(role, sequence) {
  return `EMP-${getRoleCode(role)}-${String(sequence).padStart(3, '0')}`;
}

function attachEmployeeCode(row) {
  return { ...row, employee_code: makeEmployeeCode(row.role, row.id) };
}

function normalizeCNIC(cnic) {
  return String(cnic || '').replace(/\D/g, '');
}

router.get('/', auth, async (req, res) => {
  try {
    const { role } = req.query;
    let sql = 'SELECT * FROM employees';
    const params = [];
    if (role) { sql += ' WHERE role = ?'; params.push(role); }
    sql += ' ORDER BY name';
    const [rows] = await db.query(sql, params);
    res.json(rows.map(attachEmployeeCode));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/:id', auth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM employees WHERE id=?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Employee not found' });
    res.json(attachEmployeeCode(rows[0]));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/', auth, async (req, res) => {
  try {
    const { name, cnic, phone, role } = req.body;
    if (!name || !role) return res.status(400).json({ message: 'Name and role are required' });
    const normalized = normalizeCNIC(cnic);
    if (normalized) {
      const [existing] = await db.query(
        'SELECT id FROM employees WHERE REPLACE(REPLACE(REPLACE(cnic, "-", ""), " ", ""), "/", "") = ?',
        [normalized]
      );
      if (existing.length) return res.status(409).json({ message: 'CNIC already registered' });
    }
    const [result] = await db.query('INSERT INTO employees (name, cnic, phone, role) VALUES (?,?,?,?)', [name, cnic, phone, role]);
    const employee_code = makeEmployeeCode(role, result.insertId);
    res.status(201).json({ id: result.insertId, employee_code, name, cnic, phone, role });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.put('/:id', auth, async (req, res) => {
  try {
    const { name, cnic, phone, role } = req.body;
    if (!name || !role) return res.status(400).json({ message: 'Name and role are required' });
    const normalized = normalizeCNIC(cnic);
    if (normalized) {
      const [existing] = await db.query(
        'SELECT id FROM employees WHERE REPLACE(REPLACE(REPLACE(cnic, "-", ""), " ", ""), "/", "") = ? AND id<>?',
        [normalized, req.params.id]
      );
      if (existing.length) return res.status(409).json({ message: 'CNIC already registered' });
    }
    await db.query('UPDATE employees SET name=?, cnic=?, phone=?, role=? WHERE id=?', [name, cnic, phone, role, req.params.id]);
    res.json({ message: 'Updated successfully', employee_code: makeEmployeeCode(role, parseInt(req.params.id, 10)) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Master Data employees are referenced by three columns across two modules.
// Those FKs are ON DELETE SET NULL, so MySQL would happily delete the row and
// silently orphan historical invoices and recoveries — the attribution on
// those documents would just disappear. So the references are checked first
// and the delete is refused with a message naming the modules involved.
//
// hr_employees.master_employee_id is deliberately NOT part of this guard: it
// is also ON DELETE SET NULL, and an HR profile losing its Master Data link
// is a recoverable soft-orphan (the profile survives, payroll just can't
// compute sales-target achievement until it is re-linked).
router.delete('/:id', auth, async (req, res) => {
  try {
    const id = req.params.id;

    const [[sales]] = await db.query(
      'SELECT COUNT(*) AS cnt FROM sales WHERE salesman_id = ? OR delivery_by = ?',
      [id, id]
    );
    const [[recoveries]] = await db.query(
      'SELECT COUNT(*) AS cnt FROM recoveries WHERE salesman_id = ?',
      [id]
    );

    if (sales.cnt > 0 || recoveries.cnt > 0) {
      const holders = [];
      if (sales.cnt > 0)      holders.push(`Sale (${sales.cnt} invoice${sales.cnt === 1 ? '' : 's'})`);
      if (recoveries.cnt > 0) holders.push(`Recovery & Return (${recoveries.cnt} record${recoveries.cnt === 1 ? '' : 's'})`);
      return res.status(409).json({
        message: `This employee is still referenced by ${holders.join(' and ')}. Reassign those records to another employee before deleting.`,
      });
    }

    const [result] = await db.query('DELETE FROM employees WHERE id=?', [id]);
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Employee not found' });
    res.json({ message: 'Deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
