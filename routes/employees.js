const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');
const { logAudit } = require('../middleware/auditLog');
const {
  makeEmployeeCode, attachEmployeeCode, EMPLOYEE_STATUSES, setEmployeeStatus,
} = require('../utils/masterEmployees');

function normalizeCNIC(cnic) {
  return String(cnic || '').replace(/\D/g, '');
}

const ROLES = ['Salesman', 'Supplier'];

// The one definition of "in use": the person is on a sale (as salesman or
// Delivery By) or on a recovery. The list's in_use flag, the role-change guard
// on PUT and the DELETE 409 all use this, so they can never disagree. `e` is
// the employees alias. Three EXISTS rather than one OR, so each can use its
// column's index.
const IN_USE_SQL = `(
  EXISTS (SELECT 1 FROM sales s WHERE s.salesman_id = e.id)
  OR EXISTS (SELECT 1 FROM sales s WHERE s.delivery_by = e.id)
  OR EXISTS (SELECT 1 FROM recoveries r WHERE r.salesman_id = e.id)
)`;

// Locks the row first, then reads in_use. The lock is taken before the
// in_use read so that read sees any sale that committed while we waited
// (sales take a shared lock on the row, see assertSelectableEmployee).
async function loadForWrite(conn, id) {
  const [[locked]] = await conn.query('SELECT id FROM employees WHERE id = ? FOR UPDATE', [id]);
  if (!locked) return null;
  const [[row]] = await conn.query(
    `SELECT e.id, e.name, e.role, ${IN_USE_SQL} AS in_use FROM employees e WHERE e.id = ?`, [id]
  );
  return { ...row, in_use: !!row.in_use };
}

// Mirrors the Add / Edit Employee dialog (client/src/pages/employees/
// Employees.jsx validateForm). Answers { field, message } like the HR routes,
// so the dialog can put the message under the field.
function validateEmployeeFields(body) {
  const name = String(body.name || '').trim();
  const cnic = String(body.cnic || '').trim();
  const phone = String(body.phone || '').trim();
  const role = String(body.role || '');
  const cnicDigits = normalizeCNIC(cnic);
  const phoneDigits = phone.replace(/\D/g, '');

  if (!name) return { error: { field: 'name', message: 'Enter the full name.' } };
  if (name.length < 2) return { error: { field: 'name', message: 'The name must have at least 2 characters.' } };
  if (name.length > 80) return { error: { field: 'name', message: 'The name must have 80 characters or fewer.' } };
  if (cnic && cnicDigits.length !== 13) return { error: { field: 'cnic', message: 'The CNIC must have 13 digits.' } };
  if (phone && !(
    (phoneDigits.length === 11 && phoneDigits.startsWith('03'))
    || (phoneDigits.length === 12 && phoneDigits.startsWith('92'))
  )) {
    return { error: { field: 'phone', message: 'Enter 11 digits starting with 03, or 12 starting with 92.' } };
  }
  if (!ROLES.includes(role)) return { error: { field: 'role', message: 'Choose a role.' } };

  return { name, cnic: cnic || null, phone: phone || null, role, cnicDigits };
}

async function cnicTaken(conn, cnicDigits, excludeId) {
  if (!cnicDigits) return false;
  const params = [cnicDigits];
  let sql = 'SELECT id FROM employees WHERE REPLACE(REPLACE(REPLACE(cnic, "-", ""), " ", ""), "/", "") = ?';
  if (excludeId) { sql += ' AND id <> ?'; params.push(excludeId); }
  const [rows] = await conn.query(sql, params);
  return rows.length > 0;
}

const CNIC_TAKEN = { field: 'cnic', message: 'This CNIC is already registered to another employee.' };

// Active rows only by default, so every picker that reads this list hides
// Inactive people without any client change, and one that was missed fails
// safe. ?include_inactive=1 returns everyone (the Master Data screen itself)
// plus what that screen needs, computed in this one query:
//   in_use              on a sale or recovery (IN_USE_SQL, same as DELETE)
//   hr_link             { id, employee_id, name, status, designation_name } or null
//                       (status lets the screen point to HR when the two disagree;
//                       Master Data never writes HR status)
//   deactivated_by_name, deactivated_on ('YYYY-MM-DD', PKT)
// Every row carries its status.
router.get('/', auth, async (req, res) => {
  try {
    const { role } = req.query;
    const includeInactive = ['1', 'true'].includes(String(req.query.include_inactive || ''));
    const where = [];
    const params = [];
    if (role) { where.push('e.role = ?'); params.push(role); }
    if (!includeInactive) where.push("e.status = 'Active'");
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    if (!includeInactive) {
      const [rows] = await db.query(`SELECT e.* FROM employees e ${whereSql} ORDER BY e.name`, params);
      return res.json(rows.map(attachEmployeeCode));
    }

    // hr_employees.master_employee_id is one-to-one by application rule
    // (assertMasterLinkFree), not by a UNIQUE key, so the link is taken from
    // a derived table with one row per master id; a stray duplicate can
    // never repeat an employee in this list.
    const [rows] = await db.query(`
      SELECT e.*,
             ${IN_USE_SQL} AS in_use,
             DATE_FORMAT(e.deactivated_at, '%Y-%m-%d') AS deactivated_on,
             COALESCE(u.full_name, u.username) AS deactivated_by_name,
             h.id          AS hr_id,
             h.employee_id AS hr_employee_id,
             h.name        AS hr_name,
             h.status      AS hr_status,
             des.name      AS hr_designation_name
        FROM employees e
        LEFT JOIN users u ON u.id = e.deactivated_by
        LEFT JOIN (
          SELECT master_employee_id, MIN(id) AS hr_id
            FROM hr_employees
           WHERE master_employee_id IS NOT NULL
           GROUP BY master_employee_id
        ) link ON link.master_employee_id = e.id
        LEFT JOIN hr_employees h   ON h.id = link.hr_id
        LEFT JOIN designations des ON des.id = h.designation_id
        ${whereSql}
       ORDER BY e.name
    `, params);

    res.json(rows.map(({ hr_id, hr_employee_id, hr_name, hr_status, hr_designation_name, ...row }) => ({
      ...attachEmployeeCode(row),
      in_use: !!row.in_use,
      hr_link: hr_id
        ? {
          id: hr_id, employee_id: hr_employee_id, name: hr_name, status: hr_status,
          designation_name: hr_designation_name,
        }
        : null,
    })));
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
    const fields = validateEmployeeFields(req.body);
    if (fields.error) return res.status(400).json(fields.error);
    if (await cnicTaken(db, fields.cnicDigits, null)) return res.status(409).json(CNIC_TAKEN);

    const [result] = await db.query(
      'INSERT INTO employees (name, cnic, phone, role) VALUES (?,?,?,?)',
      [fields.name, fields.cnic, fields.phone, fields.role]
    );
    const employee_code = makeEmployeeCode(fields.role, result.insertId);
    res.status(201).json({
      id: result.insertId, employee_code, name: fields.name, cnic: fields.cnic,
      phone: fields.phone, role: fields.role, status: 'Active',
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// The role cannot change once the person is in use: their code (EMP-SM-…)
// is derived from it and is what sales, recoveries and HR already show.
router.put('/:id', auth, async (req, res) => {
  const fields = validateEmployeeFields(req.body);
  if (fields.error) return res.status(400).json(fields.error);

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const current = await loadForWrite(conn, req.params.id);
    if (!current) {
      await conn.rollback();
      return res.status(404).json({ message: 'Employee not found.' });
    }
    if (fields.role !== current.role && current.in_use) {
      await conn.rollback();
      return res.status(409).json({
        field: 'role',
        code: 'EMPLOYEE_IN_USE',
        message: "Employee role can't change after linking sales or recoveries.",
      });
    }
    if (await cnicTaken(conn, fields.cnicDigits, current.id)) {
      await conn.rollback();
      return res.status(409).json(CNIC_TAKEN);
    }

    await conn.query(
      'UPDATE employees SET name=?, cnic=?, phone=?, role=? WHERE id=?',
      [fields.name, fields.cnic, fields.phone, fields.role, current.id]
    );
    await conn.commit();
    res.json({ message: 'Updated successfully', employee_code: makeEmployeeCode(fields.role, current.id) });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
});

// Deactivate / reactivate. Never touches HR: a Salesman who moves to an office
// job is still employed, so HR status is changed only from HR (which may in
// turn sync this record, see PUT /hr/employees/:id).
router.put('/:id/status', auth, async (req, res) => {
  const status = String(req.body.status || '');
  if (!EMPLOYEE_STATUSES.includes(status)) {
    return res.status(400).json({ message: 'Status must be Active or Inactive.' });
  }
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const employee = await setEmployeeStatus(conn, req.params.id, status, req.user?.id);
    if (!employee) {
      await conn.rollback();
      return res.status(404).json({ message: 'Employee not found.' });
    }
    await conn.commit();
    if (employee.changed) {
      await logAudit(req, 'STATUS_CHANGE', 'employees', employee.id,
        `${employee.employee_code} (${employee.name}) set to ${status}`);
    }
    const { changed, ...row } = employee;
    res.json({ ...row, changed });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
});

// Master Data employees are referenced by three columns across two modules.
// Those FKs are ON DELETE SET NULL, so MySQL would happily delete the row and
// silently orphan historical invoices and recoveries — the attribution on
// those documents would just disappear. So the references are checked first
// and the delete is refused; deactivation is the way to retire such a person.
//
// hr_employees.master_employee_id is deliberately NOT part of this guard: it
// is also ON DELETE SET NULL, and an HR profile losing its Master Data link
// is a recoverable soft-orphan (the profile survives, payroll just can't
// compute sales-target achievement until it is re-linked).
router.delete('/:id', auth, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const employee = await loadForWrite(conn, req.params.id);
    if (!employee) {
      await conn.rollback();
      return res.status(404).json({ message: 'Employee not found.' });
    }
    if (employee.in_use) {
      await conn.rollback();
      return res.status(409).json({
        code: 'EMPLOYEE_IN_USE',
        message: `${employee.name} appears on sales or recoveries, so they can't be deleted. Deactivate them instead.`,
      });
    }
    await conn.query('DELETE FROM employees WHERE id=?', [employee.id]);
    await conn.commit();
    res.json({ message: 'Deleted successfully' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
});

module.exports = router;
