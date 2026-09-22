const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const auth    = require('../middleware/auth');
const { logAudit } = require('../middleware/auditLog');
const requirePermission = require('../middleware/requirePermission');
const { todayPKT, addMonthsPKT } = require('../utils/dateUtils');

// ─── HR employee profiles ──────────────────────────────────────────────────
// Separate from Master Data `employees`, which stays exactly as-is: it is
// referenced by sales.salesman_id, sales.delivery_by and
// recoveries.salesman_id and its role ENUM drives Sale/Purchase attribution.
// An HR profile may *point at* a master row via master_employee_id (nullable,
// ON DELETE SET NULL) — that link is what makes sales-target achievement
// computable for field staff.
//
// There is deliberately no DELETE endpoint. Deactivation (status=Inactive +
// date_of_leaving + reason_for_leaving) is the real exit path; a hard delete
// would cascade away salary slips, loan repayments and attendance history,
// and payroll records have to survive the employee leaving.

const perm = requirePermission('perm_hr_employees', 'Workforce Management');

// The roster list is the one endpoint the Attendance and Payroll screens need
// in order to populate their employee pickers, so it accepts any HR flag. It
// returns names and job titles only — never salary, CNIC or bank details,
// which stay behind `perm` on GET /:id.
const permRoster = requirePermission.any(
  ['perm_hr_employees', 'perm_hr_attendance', 'perm_hr_payroll'],
  'Workforce Management'
);

// How far back a leaving date may be backdated. There is no forward window:
// an employee is deactivated only once they have actually gone, so a future
// leaving date is rejected outright.
const LEAVING_DATE_WINDOW_MONTHS = 3;

// ── Helpers ────────────────────────────────────────────────────────────────

// Sequential, system-generated, never editable: EMP-0001, EMP-0002, …
// Master Data's makeEmployeeCode() encodes the role (EMP-SM-001) because that
// table only holds Salesmen and Suppliers; HR profiles span every department,
// so the role segment would be meaningless here and the sequence is flat.
// Generated "last row + 1" like generateInvoiceNo in sales.js, with
// uq_hr_employee_id as the backstop against a concurrent duplicate.
function makeHrEmployeeCode(sequence) {
  return `EMP-${String(sequence).padStart(4, '0')}`;
}

async function generateEmployeeCode(conn) {
  const [[row]] = await conn.query(
    "SELECT MAX(CAST(SUBSTRING(employee_id, 5) AS UNSIGNED)) AS max_seq FROM hr_employees WHERE employee_id LIKE 'EMP-%'"
  );
  return makeHrEmployeeCode((row && row.max_seq ? Number(row.max_seq) : 0) + 1);
}

function normalizeCNIC(cnic) {
  return String(cnic || '').replace(/\D/g, '');
}

// Trim to a string, or null when there is nothing meaningful left. Used for
// every optional text column so the DB stores NULL rather than ''.
function nullableText(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
}

function nullableId(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Business dates are PKT 'YYYY-MM-DD' strings throughout this app — never
// `new Date()`. This only validates the shape and that the calendar day is
// real (rejects 2026-02-31).
function isValidDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function nullableDate(value) {
  const text = nullableText(value);
  if (text === null) return null;
  return text.slice(0, 10);
}

// Money arrives from MySQL DECIMAL as a string; normalise to a 2dp Number.
function money(value) {
  return Math.round((parseFloat(value) || 0) * 100) / 100;
}

// A slip's earnings/deductions sides are stored as a JSON snapshot, frozen at
// the time the slip was written. mysql2 usually hands back a parsed array but
// a string slips through on some driver/server combinations, so both are
// accepted — same helper as routes/salarySlips.js, which owns these columns.
function parseSlipLines(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; }
    catch { return []; }
  }
  return [];
}

function sumSlipLines(value) {
  return money(parseSlipLines(value).reduce((total, line) => total + (parseFloat(line.amount) || 0), 0));
}

const GENDERS = new Set(['Male', 'Female', 'Other']);

// Validate the conditional "Inactive requires an exit record" rule. Runs in
// the handler, not as a DB constraint: both columns must stay NULLable
// because they are legitimately empty for every Active employee, so MySQL
// alone cannot express "required only when status = 'Inactive'".
//
// `previousDate` is what is already stored (or null). The date window is
// checked only when the leaving date is being SET or CHANGED — re-checking an
// unchanged historical date on every save would make an employee's profile
// permanently un-editable about three months after they left, and the only way
// out would be entering a date that isn't true. Presence and non-emptiness of
// BOTH fields are still enforced on every save where the status is Inactive, so
// an existing exit record can never be blanked.
//
// Returns { error: { field, message } } or { dateOfLeaving, reason }.
function validateExitRecord(body, previousDate = null) {
  const rawDate   = body.date_of_leaving;
  const rawReason = body.reason_for_leaving;

  if (rawDate === undefined || rawDate === null || String(rawDate).trim() === '') {
    return { error: { field: 'date_of_leaving', message: 'Date of Leaving is required to deactivate an employee' } };
  }
  if (rawReason === undefined || rawReason === null || String(rawReason).trim() === '') {
    return { error: { field: 'reason_for_leaving', message: 'Reason for Leaving is required to deactivate an employee' } };
  }

  const dateOfLeaving = String(rawDate).trim().slice(0, 10);
  if (!isValidDateString(dateOfLeaving)) {
    return { error: { field: 'date_of_leaving', message: 'Date of Leaving must be a real date in YYYY-MM-DD format' } };
  }

  if (dateOfLeaving !== previousDate) {
    const today  = todayPKT();
    const oldest = addMonthsPKT(today, -LEAVING_DATE_WINDOW_MONTHS);
    // Plain string comparison is safe: all of these are zero-padded YYYY-MM-DD.
    if (dateOfLeaving > today) {
      return {
        error: {
          field: 'date_of_leaving',
          message: 'Date of Leaving cannot be in the future — deactivate the employee once they have actually left',
        },
      };
    }
    if (dateOfLeaving < oldest) {
      return {
        error: {
          field: 'date_of_leaving',
          message: `Date of Leaving cannot be backdated more than ${LEAVING_DATE_WINDOW_MONTHS} months (no earlier than ${oldest})`,
        },
      };
    }
  }

  return { dateOfLeaving, reason: String(rawReason).trim() };
}

// Shared validation for the columns POST and PUT both write.
async function validateCoreFields(conn, body, { employeeId = null } = {}) {
  const name            = nullableText(body.name);
  const mobile          = nullableText(body.mobile);
  const dateOfJoining   = nullableDate(body.date_of_joining);
  const departmentId    = nullableId(body.department_id);
  const designationId   = nullableId(body.designation_id);

  if (!name)          return { error: { field: 'name',   message: 'Employee name is required' } };
  if (!mobile)        return { error: { field: 'mobile', message: 'Mobile number is required' } };
  if (!dateOfJoining || !isValidDateString(dateOfJoining)) {
    return { error: { field: 'date_of_joining', message: 'Date of Joining must be a real date in YYYY-MM-DD format' } };
  }
  if (!departmentId)  return { error: { field: 'department_id',  message: 'Department is required' } };
  if (!designationId) return { error: { field: 'designation_id', message: 'Designation is required' } };

  const [[dept]] = await conn.query('SELECT id FROM departments WHERE id=?', [departmentId]);
  if (!dept) return { error: { field: 'department_id', message: 'That department no longer exists' } };

  const [[desig]] = await conn.query('SELECT id FROM designations WHERE id=?', [designationId]);
  if (!desig) return { error: { field: 'designation_id', message: 'That designation no longer exists' } };

  const gender = nullableText(body.gender);
  if (gender && !GENDERS.has(gender)) {
    return { error: { field: 'gender', message: 'Gender must be Male, Female or Other' } };
  }

  const dateOfBirth = nullableDate(body.date_of_birth);
  if (dateOfBirth && !isValidDateString(dateOfBirth)) {
    return { error: { field: 'date_of_birth', message: 'Date of Birth must be a real date in YYYY-MM-DD format' } };
  }

  const cnicDigits = normalizeCNIC(body.cnic);
  if (cnicDigits && cnicDigits.length !== 13) {
    return { error: { field: 'cnic', message: 'CNIC must be 13 digits (XXXXX-XXXXXXX-X)' } };
  }

  const email = nullableText(body.email);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: { field: 'email', message: 'Enter a valid email address, e.g. name@company.com' } };
  }

  const reportingManagerId = nullableId(body.reporting_manager_id);
  if (reportingManagerId) {
    if (employeeId && reportingManagerId === Number(employeeId)) {
      return { error: { field: 'reporting_manager_id', message: 'An employee cannot report to themselves' } };
    }
    const [[mgr]] = await conn.query('SELECT id FROM hr_employees WHERE id=?', [reportingManagerId]);
    if (!mgr) return { error: { field: 'reporting_manager_id', message: 'That reporting manager no longer exists' } };
  }

  const cityId = nullableId(body.city_id);
  if (cityId) {
    const [[city]] = await conn.query('SELECT id FROM cities WHERE id=?', [cityId]);
    if (!city) return { error: { field: 'city_id', message: 'That city no longer exists' } };
  }

  return {
    name,
    father_name:          nullableText(body.father_name),
    cnic:                 nullableText(body.cnic),
    date_of_birth:        dateOfBirth,
    gender:               gender || null,
    email,
    mobile,
    alternate_mobile:     nullableText(body.alternate_mobile),
    address:              nullableText(body.address),
    city_id:              cityId,
    date_of_joining:      dateOfJoining,
    department_id:        departmentId,
    designation_id:       designationId,
    reporting_manager_id: reportingManagerId,
    is_field_employee:    body.is_field_employee ? 1 : 0,
    bank_name:            nullableText(body.bank_name),
    account_title:        nullableText(body.account_title),
    account_number:       nullableText(body.account_number),
    iban:                 nullableText(body.iban),
  };
}

// One HR profile may link to at most one Master Data row and vice versa —
// two profiles sharing a salesman would double-count that salesman's sales
// against two different salary slips.
async function assertMasterLinkFree(conn, masterEmployeeId, excludeHrId) {
  if (!masterEmployeeId) return null;

  const [[master]] = await conn.query('SELECT id, name, cnic, phone, role FROM employees WHERE id=?', [masterEmployeeId]);
  if (!master) {
    return { error: { field: 'master_employee_id', message: 'That Master Data employee no longer exists' } };
  }

  const params = [masterEmployeeId];
  let sql = 'SELECT employee_id, name FROM hr_employees WHERE master_employee_id=?';
  if (excludeHrId) { sql += ' AND id<>?'; params.push(excludeHrId); }
  const [[clash]] = await conn.query(sql, params);
  if (clash) {
    return {
      error: {
        field: 'master_employee_id',
        message: `${master.name} is already linked to HR profile ${clash.employee_id} (${clash.name}). Each Master Data record can back only one HR profile.`,
      },
    };
  }
  return { master };
}

// ── GET / — list for the table view ────────────────────────────────────────
// Defaults to Active; ?status=Inactive or ?status=all switch the segment.
router.get('/', auth, permRoster, async (req, res) => {
  try {
    const requested = String(req.query.status || 'Active');
    const status = ['Active', 'Inactive', 'all'].includes(requested) ? requested : 'Active';

    const params = [];
    let where = '';
    if (status !== 'all') { where = 'WHERE e.status = ?'; params.push(status); }

    // is_field_employee is not shown in the table, but the Attendance and
    // Salary Slip pages reuse this list to decide whether to offer area
    // tagging / a sales target, so it rides along rather than forcing an
    // extra round trip per employee.
    const [rows] = await db.query(`
      SELECT e.id, e.employee_id, e.name, e.status, e.is_field_employee,
             e.master_employee_id,
             dep.name  AS department_name,
             des.name  AS designation_name
        FROM hr_employees e
        JOIN departments  dep ON dep.id = e.department_id
        JOIN designations des ON des.id = e.designation_id
        ${where}
       ORDER BY e.name
    `, params);

    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET /:id — full profile ────────────────────────────────────────────────
router.get('/:id', auth, perm, async (req, res) => {
  try {
    const id = req.params.id;

    // DATE columns are re-selected as 'YYYY-MM-DD' strings (same trick as
    // sales.js / purchases.js) so mysql2 doesn't hand the client a JS Date
    // that the browser would then re-interpret in its own timezone.
    const [[employee]] = await db.query(`
      SELECT e.*,
             DATE_FORMAT(e.date_of_birth,   '%Y-%m-%d') AS date_of_birth,
             DATE_FORMAT(e.date_of_joining, '%Y-%m-%d') AS date_of_joining,
             DATE_FORMAT(e.date_of_leaving, '%Y-%m-%d') AS date_of_leaving,
             dep.name AS department_name,
             des.name AS designation_name,
             c.name   AS city_name,
             mgr.name AS reporting_manager_name,
             mgr.employee_id AS reporting_manager_code,
             m.name   AS master_employee_name,
             m.role   AS master_employee_role
        FROM hr_employees e
        JOIN departments  dep ON dep.id = e.department_id
        JOIN designations des ON des.id = e.designation_id
        LEFT JOIN cities       c   ON c.id   = e.city_id
        LEFT JOIN hr_employees mgr ON mgr.id = e.reporting_manager_id
        LEFT JOIN employees    m   ON m.id   = e.master_employee_id
       WHERE e.id = ?
    `, [id]);

    if (!employee) return res.status(404).json({ message: 'Employee not found' });

    const [components] = await db.query(
      'SELECT id, type, title, amount FROM salary_components WHERE employee_id=? ORDER BY type DESC, id',
      [id]
    );

    const [[target]] = await db.query(
      'SELECT target_amount, updated_at FROM sales_targets WHERE employee_id=?',
      [id]
    );

    // remaining_balance is derived here and nowhere stored, so it can never
    // drift from the loan_repayments journal.
    const [loans] = await db.query(`
      SELECT l.id, l.title, l.principal_amount, l.created_at,
             DATE_FORMAT(l.date_issued, '%Y-%m-%d') AS date_issued,
             COALESCE(SUM(lr.amount), 0) AS repaid_amount,
             l.principal_amount - COALESCE(SUM(lr.amount), 0) AS remaining_balance
        FROM loans l
        LEFT JOIN loan_repayments lr ON lr.loan_id = l.id
       WHERE l.employee_id = ?
       GROUP BY l.id, l.title, l.principal_amount, l.date_issued, l.created_at
       ORDER BY l.date_issued DESC, l.id DESC
    `, [id]);

    const [slipRows] = await db.query(
      `SELECT id, month, earnings_json, deductions_json, net_pay, generated_at
         FROM salary_slips
        WHERE employee_id=?
        ORDER BY month DESC`,
      [id]
    );
    // The JSON sides themselves are not returned: the profile shows the two
    // totals, and the full breakdown belongs to the payslip document.
    const slips = slipRows.map(({ earnings_json, deductions_json, ...slip }) => ({
      ...slip,
      total_earnings:   sumSlipLines(earnings_json),
      total_deductions: sumSlipLines(deductions_json),
    }));

    res.json({
      ...employee,
      salary_components: components,
      sales_target: target ? money(target.target_amount) : null,
      sales_target_updated_at: target ? target.updated_at : null,
      loans,
      salary_slips: slips,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── POST / — create ────────────────────────────────────────────────────────
// `employee_id` is generated here and is the only place it is ever written.
// Anything the caller sends under that key is ignored outright.
router.post('/', auth, perm, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const masterEmployeeId = nullableId(req.body.master_employee_id);
    const linkCheck = await assertMasterLinkFree(conn, masterEmployeeId, null);
    if (linkCheck && linkCheck.error) {
      await conn.rollback();
      return res.status(409).json(linkCheck.error);
    }

    // "Import from Master Data": anything the form left blank falls back to
    // the master row, so a quick import still produces a usable profile.
    const master = linkCheck ? linkCheck.master : null;
    const body = { ...req.body };
    if (master) {
      if (!nullableText(body.name))   body.name   = master.name;
      if (!nullableText(body.cnic))   body.cnic   = master.cnic;
      if (!nullableText(body.mobile)) body.mobile = master.phone;
    }

    const fields = await validateCoreFields(conn, body);
    if (fields.error) {
      await conn.rollback();
      return res.status(400).json(fields.error);
    }

    // A new profile is always Active — the exit record only exists once an
    // employee actually leaves, and PUT is where that transition happens.
    const employeeCode = await generateEmployeeCode(conn);

    const [result] = await conn.query(`
      INSERT INTO hr_employees
        (employee_id, master_employee_id, name, father_name, cnic, date_of_birth, gender,
         email, mobile, alternate_mobile, address, city_id,
         date_of_joining, department_id, designation_id, status, reporting_manager_id,
         date_of_leaving, reason_for_leaving, is_field_employee,
         bank_name, account_title, account_number, iban)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'Active', ?, NULL, NULL, ?,?,?,?,?)
    `, [
      employeeCode, masterEmployeeId, fields.name, fields.father_name, fields.cnic,
      fields.date_of_birth, fields.gender, fields.email, fields.mobile,
      fields.alternate_mobile, fields.address, fields.city_id,
      fields.date_of_joining, fields.department_id, fields.designation_id,
      fields.reporting_manager_id, fields.is_field_employee,
      fields.bank_name, fields.account_title, fields.account_number, fields.iban,
    ]);

    await conn.commit();
    await logAudit(req, 'CREATE', 'hr/employees', result.insertId, `Created HR employee ${employeeCode} (${fields.name})`);

    res.status(201).json({ id: result.insertId, employee_id: employeeCode, name: fields.name });
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Employee ID collision — please retry' });
    }
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
});

// ── PUT /:id — update ──────────────────────────────────────────────────────
router.put('/:id', auth, perm, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const id = req.params.id;
    const [[existing]] = await conn.query(`
      SELECT e.*,
             DATE_FORMAT(e.date_of_joining, '%Y-%m-%d') AS date_of_joining,
             DATE_FORMAT(e.date_of_leaving, '%Y-%m-%d') AS date_of_leaving
        FROM hr_employees e WHERE e.id = ?
    `, [id]);
    if (!existing) {
      await conn.rollback();
      return res.status(404).json({ message: 'Employee not found' });
    }

    // employee_id is system-generated and permanently read-only. A payload
    // that tries to change it is rejected outright rather than silently
    // ignored, so a buggy client is caught instead of quietly doing nothing.
    if (req.body.employee_id !== undefined && String(req.body.employee_id) !== existing.employee_id) {
      await conn.rollback();
      return res.status(400).json({
        field: 'employee_id',
        message: 'Employee ID is system-generated and cannot be changed',
      });
    }

    const masterEmployeeId = req.body.master_employee_id === undefined
      ? existing.master_employee_id
      : nullableId(req.body.master_employee_id);

    if (masterEmployeeId !== existing.master_employee_id) {
      const linkCheck = await assertMasterLinkFree(conn, masterEmployeeId, Number(id));
      if (linkCheck && linkCheck.error) {
        await conn.rollback();
        return res.status(409).json(linkCheck.error);
      }
    }

    const fields = await validateCoreFields(conn, req.body, { employeeId: id });
    if (fields.error) {
      await conn.rollback();
      return res.status(400).json(fields.error);
    }

    // Status transition. The exit record is validated strictly whenever the
    // target status is Inactive — including Inactive -> Inactive edits, so a
    // later save can never blank out an exit record that is already there.
    const requestedStatus = req.body.status === undefined ? existing.status : String(req.body.status);
    if (!['Active', 'Inactive'].includes(requestedStatus)) {
      await conn.rollback();
      return res.status(400).json({ field: 'status', message: 'Status must be Active or Inactive' });
    }

    let dateOfLeaving    = null;
    let reasonForLeaving = null;

    if (requestedStatus === 'Inactive') {
      // Fall back to what is already stored so an unrelated edit (e.g. a
      // phone number) on an Inactive employee doesn't have to resend it.
      const exitBody = {
        date_of_leaving: req.body.date_of_leaving !== undefined
          ? req.body.date_of_leaving
          : existing.date_of_leaving,
        reason_for_leaving: req.body.reason_for_leaving !== undefined
          ? req.body.reason_for_leaving
          : existing.reason_for_leaving,
      };

      const exit = validateExitRecord(exitBody, existing.date_of_leaving);
      if (exit.error) {
        await conn.rollback();
        return res.status(400).json(exit.error);
      }
      if (exit.dateOfLeaving < fields.date_of_joining) {
        await conn.rollback();
        return res.status(400).json({
          field: 'date_of_leaving',
          message: `Date of Leaving cannot be before the Date of Joining (${fields.date_of_joining})`,
        });
      }
      dateOfLeaving    = exit.dateOfLeaving;
      reasonForLeaving = exit.reason;
    }
    // Reactivating clears the exit record — an Active employee with a leaving
    // date on file would be contradictory.

    await conn.query(`
      UPDATE hr_employees SET
        master_employee_id=?, name=?, father_name=?, cnic=?, date_of_birth=?, gender=?,
        email=?, mobile=?, alternate_mobile=?, address=?, city_id=?,
        date_of_joining=?, department_id=?, designation_id=?, status=?, reporting_manager_id=?,
        date_of_leaving=?, reason_for_leaving=?, is_field_employee=?,
        bank_name=?, account_title=?, account_number=?, iban=?
      WHERE id=?
    `, [
      masterEmployeeId, fields.name, fields.father_name, fields.cnic, fields.date_of_birth,
      fields.gender, fields.email, fields.mobile, fields.alternate_mobile, fields.address,
      fields.city_id, fields.date_of_joining, fields.department_id, fields.designation_id,
      requestedStatus, fields.reporting_manager_id, dateOfLeaving, reasonForLeaving,
      fields.is_field_employee, fields.bank_name, fields.account_title,
      fields.account_number, fields.iban, id,
    ]);

    await conn.commit();

    const statusChanged = requestedStatus !== existing.status;
    await logAudit(
      req, statusChanged ? 'STATUS_CHANGE' : 'UPDATE', 'hr/employees', id,
      statusChanged
        ? `${existing.employee_id} (${fields.name}) set to ${requestedStatus}${dateOfLeaving ? ` from ${dateOfLeaving}` : ''}`
        : `Updated HR employee ${existing.employee_id} (${fields.name})`
    );

    res.json({ message: 'Employee updated', id: Number(id), employee_id: existing.employee_id, status: requestedStatus });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
});

// ── PUT /:id/salary-components — replace the whole set ──────────────────────
// Replace rather than merge: the UI edits the list as one unit, and a diff
// would have to invent stable ids for rows the user just typed. Already
// generated salary slips are untouched — they hold their own JSON snapshot.
router.put('/:id/salary-components', auth, perm, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const id = req.params.id;
    const [[employee]] = await conn.query('SELECT id, employee_id, name FROM hr_employees WHERE id=?', [id]);
    if (!employee) {
      await conn.rollback();
      return res.status(404).json({ message: 'Employee not found' });
    }

    const incoming = Array.isArray(req.body.components) ? req.body.components : null;
    if (!incoming) {
      await conn.rollback();
      return res.status(400).json({ message: 'Expected a "components" array' });
    }

    const rows = [];
    for (let i = 0; i < incoming.length; i++) {
      const raw = incoming[i] || {};
      const title = nullableText(raw.title);
      const type  = String(raw.type || '');
      if (!title) {
        await conn.rollback();
        return res.status(400).json({ field: `components.${i}.title`, message: `Row ${i + 1}: every salary component needs a title` });
      }
      if (type !== 'Earning' && type !== 'Deduction') {
        await conn.rollback();
        return res.status(400).json({ field: `components.${i}.type`, message: `Row ${i + 1} ("${title}"): type must be Earning or Deduction` });
      }
      const amount = money(raw.amount);
      if (!Number.isFinite(amount) || amount < 0) {
        await conn.rollback();
        return res.status(400).json({ field: `components.${i}.amount`, message: `Row ${i + 1} ("${title}"): amount cannot be negative` });
      }
      rows.push([id, type, title, amount]);
    }

    await conn.query('DELETE FROM salary_components WHERE employee_id=?', [id]);
    if (rows.length) {
      await conn.query('INSERT INTO salary_components (employee_id, type, title, amount) VALUES ?', [rows]);
    }

    await conn.commit();
    await logAudit(req, 'UPDATE', 'hr/employees', id,
      `Salary structure for ${employee.employee_id} (${employee.name}) set to ${rows.length} component${rows.length === 1 ? '' : 's'}`);

    const [components] = await db.query(
      'SELECT id, type, title, amount FROM salary_components WHERE employee_id=? ORDER BY type DESC, id',
      [id]
    );
    res.json({ message: 'Salary structure saved', components });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
});

// ── POST /:id/loans — issue a loan / advance ────────────────────────────────
router.post('/:id/loans', auth, perm, async (req, res) => {
  try {
    const id = req.params.id;
    const [[employee]] = await db.query('SELECT id, employee_id, name FROM hr_employees WHERE id=?', [id]);
    if (!employee) return res.status(404).json({ message: 'Employee not found' });

    const title = nullableText(req.body.title);
    if (!title) return res.status(400).json({ field: 'title', message: 'Give the loan a title, e.g. "Eid advance"' });

    const principal = money(req.body.principal_amount);
    if (!Number.isFinite(principal) || principal <= 0) {
      return res.status(400).json({ field: 'principal_amount', message: 'Loan amount must be greater than zero' });
    }

    const dateIssued = nullableDate(req.body.date_issued) || todayPKT();
    if (!isValidDateString(dateIssued)) {
      return res.status(400).json({ field: 'date_issued', message: 'Date Issued must be a real date in YYYY-MM-DD format' });
    }

    const [result] = await db.query(
      'INSERT INTO loans (employee_id, title, principal_amount, date_issued) VALUES (?,?,?,?)',
      [id, title, principal, dateIssued]
    );

    await logAudit(req, 'CREATE', 'hr/employees', id,
      `Loan "${title}" of ${principal} issued to ${employee.employee_id} (${employee.name})`);

    res.status(201).json({
      id: result.insertId,
      title,
      principal_amount: principal,
      date_issued: dateIssued,
      repaid_amount: 0,
      remaining_balance: principal,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── PUT /:id/sales-target — set the single live target ──────────────────────
// One row per employee, no month dimension: the month-specific figure is
// snapshotted onto each salary slip at generation time.
router.put('/:id/sales-target', auth, perm, async (req, res) => {
  try {
    const id = req.params.id;
    const [[employee]] = await db.query(
      'SELECT id, employee_id, name, is_field_employee FROM hr_employees WHERE id=?', [id]
    );
    if (!employee) return res.status(404).json({ message: 'Employee not found' });

    if (!employee.is_field_employee) {
      return res.status(400).json({
        field: 'target_amount',
        message: `${employee.name} is not marked as a field employee, so a sales target does not apply. Enable "Field Employee" on their profile first.`,
      });
    }

    const amount = money(req.body.target_amount);
    if (!Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({ field: 'target_amount', message: 'Sales target cannot be negative' });
    }

    await db.query(`
      INSERT INTO sales_targets (employee_id, target_amount) VALUES (?,?)
      ON DUPLICATE KEY UPDATE target_amount = VALUES(target_amount)
    `, [id, amount]);

    await logAudit(req, 'UPDATE', 'hr/employees', id,
      `Sales target for ${employee.employee_id} (${employee.name}) set to ${amount}`);

    res.json({ message: 'Sales target saved', target_amount: amount });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
