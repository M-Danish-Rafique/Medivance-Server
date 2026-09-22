const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const auth    = require('../middleware/auth');
const { logAudit } = require('../middleware/auditLog');
const requirePermission = require('../middleware/requirePermission');
const { todayPKT } = require('../utils/dateUtils');

// ─── Attendance ────────────────────────────────────────────────────────────
// One row per (employee, date) — uq_employee_date makes a second entry for
// the same day impossible at the storage layer, and POST translates the
// resulting ER_DUP_ENTRY into a 409 the UI can explain.
//
// Area tagging reuses the existing `areas` table and only applies to field
// employees; area_ids sent for an office employee are rejected rather than
// quietly dropped, so a mis-wired client surfaces immediately.

const perm = requirePermission('perm_hr_attendance', 'Attendance');

const STATUSES = new Set(['P', 'A']);

function isValidDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function isValidMonthString(value) {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

// "On the books on date X": joined on or before X, and either still Active or
// not yet gone by X. Shared by the day sheet and the month's register list so
// the register's headcount and its "unmarked" figure can never disagree.
// `d` is the SQL expression for the date; `e` must alias hr_employees.
const onRollOn = (d) => `
  e.date_of_joining <= ${d}
  AND (e.status = 'Active' OR e.date_of_leaving IS NULL OR e.date_of_leaving >= ${d})
`;

/** "2026-09" -> ["2026-09-01", "2026-10-01"): pure string math, no clock. */
function monthBounds(month) {
  const [y, m] = month.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return [`${month}-01`, `${next}-01`];
}

// Shared SELECT for the record lists. Areas are collapsed with GROUP_CONCAT
// so one attendance row stays one JSON row; the client splits on ', '.
const RECORD_SELECT = `
  SELECT a.id, a.employee_id, a.status,
         DATE_FORMAT(a.date, '%Y-%m-%d') AS date,
         e.employee_id AS employee_code,
         e.name        AS employee_name,
         e.is_field_employee,
         e.status      AS employee_status,
         dep.name      AS department_name,
         des.name      AS designation_name,
         GROUP_CONCAT(ar.name ORDER BY ar.name SEPARATOR ', ') AS area_names,
         -- The ids travel alongside the names so the edit form can preselect
         -- the area checkboxes without a second request per row.
         GROUP_CONCAT(ar.id ORDER BY ar.name SEPARATOR ',') AS area_id_list
    FROM attendance_records a
    JOIN hr_employees e   ON e.id  = a.employee_id
    JOIN departments  dep ON dep.id = e.department_id
    JOIN designations des ON des.id = e.designation_id
    LEFT JOIN attendance_areas aa ON aa.attendance_id = a.id
    LEFT JOIN areas            ar ON ar.id = aa.area_id
`;

const RECORD_GROUP_BY = `
  GROUP BY a.id, a.employee_id, a.status, a.date,
           e.employee_id, e.name, e.is_field_employee, e.status,
           dep.name, des.name
`;

// ── GET / — every record, latest first ─────────────────────────────────────
// ?month=YYYY-MM and ?status=P|A narrow the list; both optional so the
// default response is still "all records ordered by date DESC".
router.get('/', auth, perm, async (req, res) => {
  try {
    const where  = [];
    const params = [];

    if (req.query.month) {
      if (!isValidMonthString(req.query.month)) {
        return res.status(400).json({ message: 'Month filter must look like 2026-09' });
      }
      where.push("DATE_FORMAT(a.date, '%Y-%m') = ?");
      params.push(req.query.month);
    }
    if (req.query.status) {
      if (!STATUSES.has(req.query.status)) {
        return res.status(400).json({ message: 'Status filter must be P or A' });
      }
      where.push('a.status = ?');
      params.push(req.query.status);
    }

    const [rows] = await db.query(`
      ${RECORD_SELECT}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ${RECORD_GROUP_BY}
      ORDER BY a.date DESC, e.name
    `, params);

    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET /summary — roster with per-employee P/A counts ─────────────────────
// Backs the "By Employee" tab. ?month=YYYY-MM scopes the counts; without it
// the counts are lifetime. Every Active employee appears, including those
// with no records yet (LEFT JOIN), so the roster is never missing people.
router.get('/summary', auth, perm, async (req, res) => {
  try {
    const month = req.query.month;
    if (month && !isValidMonthString(month)) {
      return res.status(400).json({ message: 'Month filter must look like 2026-09' });
    }

    const status = ['Active', 'Inactive', 'all'].includes(req.query.status) ? req.query.status : 'Active';

    // The month predicate lives in the JOIN condition, not WHERE, so an
    // employee with zero records in that month still returns a 0/0 row.
    const joinMonth = month ? "AND DATE_FORMAT(a.date, '%Y-%m') = ?" : '';
    const params = month ? [month] : [];

    let where = '';
    if (status !== 'all') { where = 'WHERE e.status = ?'; params.push(status); }

    const [rows] = await db.query(`
      SELECT e.id, e.employee_id AS employee_code, e.name, e.status, e.is_field_employee,
             dep.name AS department_name,
             des.name AS designation_name,
             COALESCE(SUM(a.status = 'P'), 0) AS present_days,
             COALESCE(SUM(a.status = 'A'), 0) AS absent_days,
             COUNT(a.id)                      AS recorded_days,
             DATE_FORMAT(MAX(a.date), '%Y-%m-%d') AS last_recorded_date
        FROM hr_employees e
        JOIN departments  dep ON dep.id = e.department_id
        JOIN designations des ON des.id = e.designation_id
        LEFT JOIN attendance_records a ON a.employee_id = e.id ${joinMonth}
        ${where}
       GROUP BY e.id, e.employee_id, e.name, e.status, e.is_field_employee, dep.name, des.name
       ORDER BY e.name
    `, params);

    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET /day-sheet?date= — the daily register ───────────────────────────────
// Every active employee for one date, each carrying whatever is already
// recorded for them that day. This is what the attendance screen is built
// around: attendance is taken for the whole workforce in one pass, not one
// person at a time.
router.get('/day-sheet', auth, perm, async (req, res) => {
  try {
    const date = String(req.query.date || '').trim().slice(0, 10);
    if (!isValidDateString(date)) {
      return res.status(400).json({ field: 'date', message: 'Pick a valid date' });
    }
    if (date > todayPKT()) {
      return res.status(400).json({ field: 'date', message: 'Attendance cannot be taken for a future date' });
    }

    // Employees who had left before this date are excluded, but anyone still
    // on the books on the day itself is included even if they have since been
    // deactivated — otherwise a leaver's final days become unrecordable.
    const [rows] = await db.query(`
      SELECT e.id, e.employee_id AS employee_code, e.name, e.is_field_employee, e.status,
             dep.name AS department_name,
             des.name AS designation_name,
             a.id     AS attendance_id,
             a.status AS attendance_status,
             GROUP_CONCAT(ar.id ORDER BY ar.name SEPARATOR ',')        AS area_id_list,
             GROUP_CONCAT(ar.name ORDER BY ar.name SEPARATOR ', ')     AS area_names
        FROM hr_employees e
        JOIN departments  dep ON dep.id = e.department_id
        JOIN designations des ON des.id = e.designation_id
        LEFT JOIN attendance_records a  ON a.employee_id = e.id AND a.date = ?
        LEFT JOIN attendance_areas   aa ON aa.attendance_id = a.id
        LEFT JOIN areas              ar ON ar.id = aa.area_id
       WHERE ${onRollOn('?')}
       GROUP BY e.id, e.employee_id, e.name, e.is_field_employee, e.status,
                dep.name, des.name, a.id, a.status
       ORDER BY dep.name, e.name
    `, [date, date, date]);

    const recorded = rows.filter(r => r.attendance_id).length;

    res.json({
      date,
      employees: rows,
      summary: {
        total: rows.length,
        recorded,
        present: rows.filter(r => r.attendance_status === 'P').length,
        absent:  rows.filter(r => r.attendance_status === 'A').length,
      },
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET /registers?month=YYYY-MM — the month's daily registers ─────────────
// A register is not a stored entity: it is simply the set of marks saved for
// one date, so a date appears here once at least one employee is marked on it
// and disappears again if every mark is cleared. Newest date first.
// `on_roll` uses the same predicate as /day-sheet, so `unmarked` here always
// equals the unmarked rows the register shows when it is opened.
router.get('/registers', auth, perm, async (req, res) => {
  try {
    const month = String(req.query.month || '');
    if (!isValidMonthString(month)) {
      return res.status(400).json({ field: 'month', message: 'Month must look like 2026-09' });
    }
    const [from, to] = monthBounds(month);

    const [rows] = await db.query(`
      SELECT DATE_FORMAT(d.date, '%Y-%m-%d') AS date,
             d.present, d.absent,
             (SELECT COUNT(*) FROM hr_employees e WHERE ${onRollOn('d.date')}) AS on_roll
        FROM (
          SELECT a.date,
                 SUM(a.status = 'P') AS present,
                 SUM(a.status = 'A') AS absent
            FROM attendance_records a
           WHERE a.date >= ? AND a.date < ?
           GROUP BY a.date
        ) d
       ORDER BY d.date DESC
    `, [from, to]);

    res.json({
      month,
      registers: rows.map(r => {
        const present = Number(r.present);
        const absent  = Number(r.absent);
        const onRoll  = Number(r.on_roll);
        return {
          date: r.date,
          present,
          absent,
          on_roll: onRoll,
          // Clamped: a record can outlive a later edit to someone's joining
          // or leaving date, which would otherwise drive this negative.
          unmarked: Math.max(0, onRoll - present - absent),
        };
      }),
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET /by-employee/:id — one employee's history ───────────────────────────
// The client also uses the `date` values here to disable already-recorded
// days in the New Attendance date picker, ahead of the server-side 409.
router.get('/by-employee/:id', auth, perm, async (req, res) => {
  try {
    const [[employee]] = await db.query(`
      SELECT e.id, e.employee_id AS employee_code, e.name, e.status, e.is_field_employee,
             dep.name AS department_name, des.name AS designation_name
        FROM hr_employees e
        JOIN departments  dep ON dep.id = e.department_id
        JOIN designations des ON des.id = e.designation_id
       WHERE e.id = ?
    `, [req.params.id]);
    if (!employee) return res.status(404).json({ message: 'Employee not found' });

    const [records] = await db.query(`
      ${RECORD_SELECT}
      WHERE a.employee_id = ?
      ${RECORD_GROUP_BY}
      ORDER BY a.date DESC
    `, [req.params.id]);

    const present = records.filter(r => r.status === 'P').length;

    res.json({
      employee,
      records,
      stats: {
        present_days:  present,
        absent_days:   records.length - present,
        recorded_days: records.length,
      },
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── POST / — record one day ────────────────────────────────────────────────
router.post('/', auth, perm, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const employeeId = parseInt(req.body.employee_id, 10);
    if (!Number.isFinite(employeeId) || employeeId <= 0) {
      await conn.rollback();
      return res.status(400).json({ field: 'employee_id', message: 'Choose an employee' });
    }

    const [[employee]] = await conn.query(
      'SELECT id, employee_id, name, is_field_employee, status FROM hr_employees WHERE id=?',
      [employeeId]
    );
    if (!employee) {
      await conn.rollback();
      return res.status(404).json({ field: 'employee_id', message: 'Employee not found' });
    }

    const date = String(req.body.date || '').trim().slice(0, 10);
    if (!isValidDateString(date)) {
      await conn.rollback();
      return res.status(400).json({ field: 'date', message: 'Pick a valid date' });
    }
    // PKT string comparison — both sides are zero-padded YYYY-MM-DD.
    if (date > todayPKT()) {
      await conn.rollback();
      return res.status(400).json({ field: 'date', message: 'Attendance cannot be recorded for a future date' });
    }

    const status = String(req.body.status || '');
    if (!STATUSES.has(status)) {
      await conn.rollback();
      return res.status(400).json({ field: 'status', message: 'Mark the day as Present or Absent' });
    }

    // Area tagging is field-employee-only, and only meaningful on a day the
    // employee was actually out. Rejected loudly rather than dropped.
    const areaIds = Array.isArray(req.body.area_ids)
      ? [...new Set(req.body.area_ids.map(v => parseInt(v, 10)).filter(n => Number.isFinite(n) && n > 0))]
      : [];

    if (areaIds.length && !employee.is_field_employee) {
      await conn.rollback();
      return res.status(400).json({
        field: 'area_ids',
        message: `${employee.name} is not a field employee, so areas cannot be tagged on their attendance.`,
      });
    }
    if (areaIds.length) {
      const [foundAreas] = await conn.query('SELECT id FROM areas WHERE id IN (?)', [areaIds]);
      if (foundAreas.length !== areaIds.length) {
        await conn.rollback();
        return res.status(400).json({ field: 'area_ids', message: 'One or more selected areas no longer exist' });
      }
    }

    const [result] = await conn.query(
      'INSERT INTO attendance_records (employee_id, date, status) VALUES (?,?,?)',
      [employeeId, date, status]
    );

    if (areaIds.length) {
      await conn.query(
        'INSERT INTO attendance_areas (attendance_id, area_id) VALUES ?',
        [areaIds.map(areaId => [result.insertId, areaId])]
      );
    }

    await conn.commit();
    await logAudit(req, 'CREATE', 'hr/attendance', result.insertId,
      `${employee.employee_id} (${employee.name}) marked ${status === 'P' ? 'Present' : 'Absent'} on ${date}`);

    res.status(201).json({ id: result.insertId, employee_id: employeeId, date, status, area_ids: areaIds });
  } catch (err) {
    await conn.rollback();
    // The unique index is the real guard; this turns it into readable copy.
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        field: 'date',
        message: 'Attendance for this employee is already recorded on that date. Pick another date.',
      });
    }
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
});

// ── POST /bulk — save the whole day register in one transaction ────────────
// Idempotent per (employee, date): an employee already marked is updated, one
// not yet marked is inserted, and `status: null` clears the mark entirely. The
// register can therefore be opened, corrected and saved again as many times as
// needed without ever producing a duplicate — the unique index guarantees it.
//
// Employees omitted from `records` are left untouched, so a partially filled
// register never wipes marks somebody else entered.
router.post('/bulk', auth, perm, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const date = String(req.body.date || '').trim().slice(0, 10);
    if (!isValidDateString(date)) {
      await conn.rollback();
      return res.status(400).json({ field: 'date', message: 'Pick a valid date' });
    }
    if (date > todayPKT()) {
      await conn.rollback();
      return res.status(400).json({ field: 'date', message: 'Attendance cannot be recorded for a future date' });
    }

    const incoming = Array.isArray(req.body.records) ? req.body.records : null;
    if (!incoming) {
      await conn.rollback();
      return res.status(400).json({ message: 'Expected a "records" array' });
    }
    if (incoming.length === 0) {
      await conn.rollback();
      return res.status(400).json({ message: 'Nothing to save — mark at least one employee.' });
    }

    // Resolve every referenced employee once, so the per-row checks below are
    // in-memory rather than a query each.
    const employeeIds = [...new Set(
      incoming.map(r => parseInt(r && r.employee_id, 10)).filter(n => Number.isFinite(n) && n > 0)
    )];
    if (employeeIds.length !== incoming.length) {
      await conn.rollback();
      return res.status(400).json({ message: 'The register contains an invalid or duplicated employee' });
    }

    const [employeeRows] = await conn.query(
      'SELECT id, employee_id, name, is_field_employee FROM hr_employees WHERE id IN (?)',
      [employeeIds]
    );
    const employeeById = new Map(employeeRows.map(e => [e.id, e]));
    if (employeeById.size !== employeeIds.length) {
      await conn.rollback();
      return res.status(400).json({ message: 'The register refers to an employee that no longer exists' });
    }

    const marks  = [];   // [employee_id, date, status]
    const clears = [];   // employee_id
    const areasByEmployee = new Map();

    for (const raw of incoming) {
      const employeeId = parseInt(raw.employee_id, 10);
      const employee   = employeeById.get(employeeId);
      const status     = raw.status === null || raw.status === undefined || raw.status === ''
        ? null
        : String(raw.status);

      if (status === null) { clears.push(employeeId); continue; }

      if (!STATUSES.has(status)) {
        await conn.rollback();
        return res.status(400).json({
          message: `${employee.name}: attendance must be marked Present or Absent`,
        });
      }

      const areaIds = Array.isArray(raw.area_ids)
        ? [...new Set(raw.area_ids.map(v => parseInt(v, 10)).filter(n => Number.isFinite(n) && n > 0))]
        : [];

      if (areaIds.length && !employee.is_field_employee) {
        await conn.rollback();
        return res.status(400).json({
          message: `${employee.name} is not field staff, so areas cannot be tagged on their attendance.`,
        });
      }
      if (areaIds.length && status === 'A') {
        await conn.rollback();
        return res.status(400).json({
          message: `${employee.name} is marked absent, so areas cannot be tagged for that day.`,
        });
      }

      marks.push([employeeId, date, status]);
      areasByEmployee.set(employeeId, areaIds);
    }

    const allAreaIds = [...new Set([...areasByEmployee.values()].flat())];
    if (allAreaIds.length) {
      const [foundAreas] = await conn.query('SELECT id FROM areas WHERE id IN (?)', [allAreaIds]);
      if (foundAreas.length !== allAreaIds.length) {
        await conn.rollback();
        return res.status(400).json({ message: 'One or more selected areas no longer exist' });
      }
    }

    if (clears.length) {
      // attendance_areas cascades with the record.
      await conn.query('DELETE FROM attendance_records WHERE date=? AND employee_id IN (?)', [date, clears]);
    }

    if (marks.length) {
      // The unique index on (employee_id, date) turns a re-save into an update
      // rather than a duplicate — this is what makes the register idempotent.
      await conn.query(`
        INSERT INTO attendance_records (employee_id, date, status) VALUES ?
        ON DUPLICATE KEY UPDATE status = VALUES(status)
      `, [marks]);

      const markedIds = marks.map(m => m[0]);
      const [saved] = await conn.query(
        'SELECT id, employee_id FROM attendance_records WHERE date=? AND employee_id IN (?)',
        [date, markedIds]
      );
      const attendanceIdByEmployee = new Map(saved.map(r => [r.employee_id, r.id]));

      // Areas are replaced as a whole set per record.
      await conn.query(
        'DELETE FROM attendance_areas WHERE attendance_id IN (?)',
        [saved.map(r => r.id)]
      );

      const areaRows = [];
      for (const [employeeId, areaIds] of areasByEmployee) {
        const attendanceId = attendanceIdByEmployee.get(employeeId);
        if (!attendanceId) continue;
        for (const areaId of areaIds) areaRows.push([attendanceId, areaId]);
      }
      if (areaRows.length) {
        await conn.query('INSERT INTO attendance_areas (attendance_id, area_id) VALUES ?', [areaRows]);
      }
    }

    await conn.commit();

    const presentCount = marks.filter(m => m[2] === 'P').length;
    const absentCount  = marks.length - presentCount;
    await logAudit(req, 'UPDATE', 'hr/attendance', null,
      `Daily register saved for ${date} — ${presentCount} present, ${absentCount} absent${clears.length ? `, ${clears.length} cleared` : ''}`);

    res.json({
      message: 'Daily register saved',
      date,
      saved: marks.length,
      cleared: clears.length,
      present: presentCount,
      absent: absentCount,
    });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
});

// ── PUT /:id — correct a record ────────────────────────────────────────────
// The P/A mark and the area tags are editable; `date` and `employee_id` are
// not. Moving a record to another day or person would either collide with
// uq_employee_date or silently rewrite someone else's history — deleting and
// re-entering it is the honest way to do that.
router.put('/:id', auth, perm, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[record]] = await conn.query(`
      SELECT a.id, a.employee_id, a.status,
             DATE_FORMAT(a.date, '%Y-%m-%d') AS date,
             e.employee_id AS employee_code, e.name, e.is_field_employee
        FROM attendance_records a
        JOIN hr_employees e ON e.id = a.employee_id
       WHERE a.id = ?
    `, [req.params.id]);

    if (!record) {
      await conn.rollback();
      return res.status(404).json({ message: 'Attendance record not found' });
    }

    const status = String(req.body.status || '');
    if (!STATUSES.has(status)) {
      await conn.rollback();
      return res.status(400).json({ field: 'status', message: 'Mark the day as Present or Absent' });
    }

    const areaIds = Array.isArray(req.body.area_ids)
      ? [...new Set(req.body.area_ids.map(v => parseInt(v, 10)).filter(n => Number.isFinite(n) && n > 0))]
      : [];

    if (areaIds.length && !record.is_field_employee) {
      await conn.rollback();
      return res.status(400).json({
        field: 'area_ids',
        message: `${record.name} is not a field employee, so areas cannot be tagged on their attendance.`,
      });
    }
    if (areaIds.length && status === 'A') {
      await conn.rollback();
      return res.status(400).json({
        field: 'area_ids',
        message: 'Areas cannot be tagged on a day the employee was absent.',
      });
    }
    if (areaIds.length) {
      const [foundAreas] = await conn.query('SELECT id FROM areas WHERE id IN (?)', [areaIds]);
      if (foundAreas.length !== areaIds.length) {
        await conn.rollback();
        return res.status(400).json({ field: 'area_ids', message: 'One or more selected areas no longer exist' });
      }
    }

    await conn.query('UPDATE attendance_records SET status=? WHERE id=?', [status, req.params.id]);

    // Areas are replaced as a whole set — the UI edits them as one multi-select,
    // so a diff would buy nothing.
    await conn.query('DELETE FROM attendance_areas WHERE attendance_id=?', [req.params.id]);
    if (areaIds.length) {
      await conn.query(
        'INSERT INTO attendance_areas (attendance_id, area_id) VALUES ?',
        [areaIds.map(areaId => [req.params.id, areaId])]
      );
    }

    await conn.commit();
    await logAudit(req, 'UPDATE', 'hr/attendance', req.params.id,
      `${record.employee_code} (${record.name}) on ${record.date} changed from ${record.status} to ${status}`);

    res.json({ message: 'Attendance updated', id: Number(req.params.id), status, area_ids: areaIds });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
});

// ── DELETE /:id — remove a record entered by mistake ───────────────────────
// Nothing derives from attendance (payroll does not read it), so a delete has
// no knock-on effects. attendance_areas cascades away with the row.
router.delete('/:id', auth, perm, async (req, res) => {
  try {
    const [[record]] = await db.query(`
      SELECT a.id, a.status, DATE_FORMAT(a.date, '%Y-%m-%d') AS date,
             e.employee_id AS employee_code, e.name
        FROM attendance_records a
        JOIN hr_employees e ON e.id = a.employee_id
       WHERE a.id = ?
    `, [req.params.id]);

    if (!record) return res.status(404).json({ message: 'Attendance record not found' });

    await db.query('DELETE FROM attendance_records WHERE id=?', [req.params.id]);
    await logAudit(req, 'DELETE', 'hr/attendance', req.params.id,
      `Removed ${record.status} on ${record.date} for ${record.employee_code} (${record.name})`);

    res.json({ message: 'Attendance record deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
