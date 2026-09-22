const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const auth    = require('../middleware/auth');
const { logAudit } = require('../middleware/auditLog');
const requirePermission = require('../middleware/requirePermission');
const { loadOpenRun, monthBounds } = require('../utils/payrollRun');
const { todayPKT } = require('../utils/dateUtils');

// ─── Salary slips ──────────────────────────────────────────────────────────
// A slip lives inside a monthly payroll session (`payroll_runs`):
//
//   run Open      -> the slip can be created and edited freely
//   run Completed -> the slip is frozen permanently; no create, no edit
//   always        -> no delete, during or after the run
//
// Once its run is Completed, later edits to salary_components, sales_targets
// or loans can never rewrite what the slip says: `earnings_json`,
// `deductions_json`, `target_amount`, `target_achieved` and `net_pay` are its
// own snapshot.
//
// Three values are always recomputed server-side on both create and edit and
// never taken from the request body, so a stale draft sitting in a browser tab
// cannot be saved as fact: `target_achieved`, `target_amount` and `net_pay`.
//
// Cost to Company is recorded once per MONTH on the Pay Run (payroll_runs,
// see routes/payrollRuns.js), never per slip.
//
// Every response splits deductions into `loan_recoveries` (lines tagged with a
// loan_id — advances are recorded as loans) and `other_deductions`.
//
// Loan repayments tagged on a deduction line are journalled into
// `loan_repayments`, which is the sole source of a loan's remaining balance
// (loans.principal_amount - SUM(loan_repayments.amount)). Editing a slip
// RE-journals them: the slip's own repayment rows are deleted first, so the
// balances the new lines are checked against are the ones that would exist if
// this slip had never been saved.

const perm = requirePermission('perm_hr_payroll', 'Payroll');

const PAISA = 0.005;

function money(value) {
  return Math.round((parseFloat(value) || 0) * 100) / 100;
}

function isValidMonthString(value) {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

// mysql2 usually hands back a parsed object for a JSON column, but a string
// slips through on some driver/server combinations — accept both.
function parseJsonColumn(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; }
    catch { return []; }
  }
  return [];
}

// ── Target achievement ─────────────────────────────────────────────────────
// What "achieved" means depends on what the employee actually does, which is
// recorded on the linked Master Data row's `role`:
//
//   Salesman  -> SUM(sales.net_collectible) for invoices DATED in the month.
//                net_collectible is seeded to total_amount when the invoice is
//                created and only adjusted by rebuildSaleFromRecoveries, so a
//                still-pending invoice counts in full (the whole pending
//                amount is part of his target) while recovery discounts and
//                returns reduce it.
//
//   Supplier  -> SUM(recoveries.net_collected) for recoveries DATED in the
//                month. A supplier's job is collection, not invoicing, so his
//                target is measured by what he brought in that month
//                regardless of which month the underlying invoice belongs to.
//
// Either way the month filter is applied to the source row's own `date`, so a
// September slip only ever counts September activity.
//
// Returns { achieved, basis, reason }:
//   achieved === null means "not computable" and the UI says why rather than
//   showing a misleading 0.
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** "2026-07" -> "July 2026" — the reason strings are shown to the operator. */
function monthLabel(month) {
  const [year, mm] = String(month).split('-');
  return `${MONTH_NAMES[Number(mm) - 1] || mm} ${year}`;
}

async function computeTargetAchieved(conn, employee, month) {
  if (!employee.is_field_employee) {
    return { achieved: null, basis: 'not_field_employee', reason: 'Not a field employee' };
  }
  if (!employee.master_employee_id) {
    return {
      achieved: null,
      basis: 'unlinked',
      reason: 'Not linked to Master Data — link this profile to a Salesman or Supplier record to track achievement',
    };
  }

  const [[master]] = await conn.query('SELECT id, name, role FROM employees WHERE id=?', [employee.master_employee_id]);
  if (!master) {
    return {
      achieved: null,
      basis: 'unlinked',
      reason: 'The linked Master Data record no longer exists',
    };
  }

  if (master.role === 'Supplier') {
    const [[row]] = await conn.query(`
      SELECT COALESCE(SUM(r.net_collected), 0) AS achieved
        FROM recoveries r
       WHERE r.salesman_id = ?
         AND DATE_FORMAT(r.date, '%Y-%m') = ?
    `, [employee.master_employee_id, month]);
    return {
      achieved: money(row.achieved),
      basis: 'recoveries',
      reason: `Recovered in ${monthLabel(month)} (as ${master.name})`,
    };
  }

  // Salesman (the only other value the master role ENUM allows).
  const [[row]] = await conn.query(`
    SELECT COALESCE(SUM(s.net_collectible), 0) AS achieved
      FROM sales s
     WHERE s.salesman_id = ?
       AND DATE_FORMAT(s.date, '%Y-%m') = ?
  `, [employee.master_employee_id, month]);
  return {
    achieved: money(row.achieved),
    basis: 'sales',
    reason: `Invoiced in ${monthLabel(month)}, net of returns and recovery discounts (as ${master.name})`,
  };
}

// ── Attendance for the month (information only) ────────────────────────────
// Payroll does not deduct for absence automatically (product decision
// 2026-09-22); the draft simply shows what the daily register says so the
// operator can decide. `days_to_date` counts only the days this person was on
// the books in the month, up to today, so "unmarked" never includes days
// before they joined, after they left, or still in the future.
function daysBetweenInclusive(from, to) {
  const toUtc = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((toUtc(to) - toUtc(from)) / 86400000) + 1;
}

async function attendanceSummary(conn, employee, month) {
  const { first, last } = monthBounds(month);
  const from = employee.date_of_joining && employee.date_of_joining > first ? employee.date_of_joining : first;
  let to = last;
  if (employee.date_of_leaving && employee.date_of_leaving < to) to = employee.date_of_leaving;
  const today = todayPKT();
  if (today < to) to = today;
  const days = to >= from ? daysBetweenInclusive(from, to) : 0;

  const [[row]] = await conn.query(`
    SELECT COALESCE(SUM(status = 'P'), 0) AS present,
           COALESCE(SUM(status = 'A'), 0) AS absent
      FROM attendance_records
     WHERE employee_id = ? AND date BETWEEN ? AND ?
  `, [employee.id, first, last]);
  const present = Number(row.present);
  const absent  = Number(row.absent);
  return { present, absent, days_to_date: days, unmarked: Math.max(0, days - present - absent) };
}

// Load the employee columns every payroll path needs.
async function loadPayrollEmployee(conn, id) {
  const [[employee]] = await conn.query(`
    SELECT e.id, e.employee_id, e.name, e.father_name, e.cnic, e.status,
           e.is_field_employee, e.master_employee_id,
           DATE_FORMAT(e.date_of_joining, '%Y-%m-%d') AS date_of_joining,
           DATE_FORMAT(e.date_of_leaving, '%Y-%m-%d') AS date_of_leaving,
           e.bank_name, e.account_title, e.account_number, e.iban,
           dep.name AS department_name,
           des.name AS designation_name
      FROM hr_employees e
      JOIN departments  dep ON dep.id = e.department_id
      JOIN designations des ON des.id = e.designation_id
     WHERE e.id = ?
  `, [id]);
  return employee || null;
}

// A slip only makes sense for a month the employee was actually on the books
// for part of. Partial months (joined mid-month) are allowed. Inactive
// employees have left and get no NEW slip at all (product decision 2026-09-22)
// — the same rule as ELIGIBLE_WHERE in utils/payrollRun.js. Editing a slip
// that already exists is unaffected.
function employmentMonthError(employee, month) {
  if (employee.status !== 'Active') {
    return `${employee.name} has left (Inactive), so no new payslip can be processed for them.`;
  }
  const joinedMonth = (employee.date_of_joining || '').slice(0, 7);
  if (joinedMonth && month < joinedMonth) {
    return `${employee.name} joined on ${employee.date_of_joining}, so there is no salary for ${month}.`;
  }
  const leftMonth = (employee.date_of_leaving || '').slice(0, 7);
  if (leftMonth && month > leftMonth) {
    return `${employee.name} left on ${employee.date_of_leaving}, so there is no salary for ${month}.`;
  }
  return null;
}

// Derive each loan's outstanding balance from the repayment journal.
// `forUpdate` locks the loan rows so two slips saved at the same moment
// cannot both deduct the same remaining balance.
async function loadOutstandingLoans(conn, employeeId, { forUpdate = false } = {}) {
  if (forUpdate) {
    // FOR UPDATE cannot be combined with the aggregate below, so the rows are
    // locked first and the balances derived in a second read.
    await conn.query('SELECT id FROM loans WHERE employee_id=? FOR UPDATE', [employeeId]);
  }
  const [loans] = await conn.query(`
    SELECT l.id, l.title, l.principal_amount,
           DATE_FORMAT(l.date_issued, '%Y-%m-%d') AS date_issued,
           COALESCE(SUM(lr.amount), 0) AS repaid_amount,
           l.principal_amount - COALESCE(SUM(lr.amount), 0) AS remaining_balance
      FROM loans l
      LEFT JOIN loan_repayments lr ON lr.loan_id = l.id
     WHERE l.employee_id = ?
     GROUP BY l.id, l.title, l.principal_amount, l.date_issued
     HAVING remaining_balance > 0
     ORDER BY l.date_issued, l.id
  `, [employeeId]);
  return loans;
}

// Validate one side of the slip (earnings or deductions) into storable rows.
// Deduction rows may carry `loan_id` to tag themselves as a loan repayment.
function normaliseLines(rawLines, side) {
  if (!Array.isArray(rawLines)) {
    return { error: { field: side, message: `Expected a "${side}" array` } };
  }
  const lines = [];
  for (let i = 0; i < rawLines.length; i++) {
    const raw   = rawLines[i] || {};
    const title = String(raw.title || '').trim();
    const amount = money(raw.amount);

    // Blank rows the user added and never filled in are dropped rather than
    // rejected — the UI lets you append an empty row freely.
    if (!title && Math.abs(amount) < PAISA && !raw.loan_id) continue;

    if (!title) {
      return { error: { field: `${side}.${i}.title`, message: `Row ${i + 1}: give this ${side === 'earnings' ? 'earning' : 'deduction'} a title` } };
    }
    if (!Number.isFinite(amount) || amount < 0) {
      return { error: { field: `${side}.${i}.amount`, message: `Row ${i + 1} ("${title}"): amount cannot be negative` } };
    }

    const line = { title, amount };
    if (side === 'deductions' && raw.loan_id) {
      const loanId = parseInt(raw.loan_id, 10);
      if (!Number.isFinite(loanId) || loanId <= 0) {
        return { error: { field: `${side}.${i}.loan_id`, message: `Row ${i + 1} ("${title}"): invalid loan reference` } };
      }
      line.loan_id = loanId;
    }
    lines.push(line);
  }
  return { lines };
}

function sumLines(lines) {
  return money(lines.reduce((total, line) => total + (parseFloat(line.amount) || 0), 0));
}

// The breakdown every slip response carries, derived from the slip's own JSON
// snapshot so it can never disagree with the lines.
function slipFigures(earnings, deductions) {
  const totalEarnings   = sumLines(earnings);
  const totalDeductions = sumLines(deductions);
  const loanRecoveries  = sumLines(deductions.filter(line => line.loan_id));
  return {
    total_earnings:   totalEarnings,
    total_deductions: totalDeductions,
    loan_recoveries:  loanRecoveries,
    other_deductions: money(totalDeductions - loanRecoveries),
  };
}

// ── GET / — list, optionally one month ─────────────────────────────────────
// Returns the full snapshot rows (including the JSON sides) because the set
// is small — one row per employee per month — and the batch print view needs
// every slip anyway, which would otherwise be N requests.
router.get('/', auth, perm, async (req, res) => {
  try {
    const params = [];
    let where = '';
    if (req.query.month) {
      if (!isValidMonthString(req.query.month)) {
        return res.status(400).json({ message: 'Month filter must look like 2026-09' });
      }
      where = 'WHERE s.month = ?';
      params.push(req.query.month);
    }

    const [rows] = await db.query(`
      SELECT s.id, s.employee_id, s.month, s.earnings_json, s.deductions_json,
             s.target_amount, s.target_achieved, s.net_pay, s.generated_at,
             e.employee_id AS employee_code,
             e.name        AS employee_name,
             e.is_field_employee,
             dep.name      AS department_name,
             des.name      AS designation_name
        FROM salary_slips s
        JOIN hr_employees e   ON e.id  = s.employee_id
        JOIN departments  dep ON dep.id = e.department_id
        JOIN designations des ON des.id = e.designation_id
        ${where}
       ORDER BY s.month DESC, e.name
    `, params);

    res.json(rows.map(row => {
      const earnings   = parseJsonColumn(row.earnings_json);
      const deductions = parseJsonColumn(row.deductions_json);
      return {
        ...row,
        earnings,
        deductions,
        ...slipFigures(earnings, deductions),
      };
    }));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET /draft — build a draft, write nothing ──────────────────────────────
router.get('/draft', auth, perm, async (req, res) => {
  try {
    const employeeId = parseInt(req.query.employee_id, 10);
    const month      = req.query.month;

    if (!Number.isFinite(employeeId) || employeeId <= 0) {
      return res.status(400).json({ field: 'employee_id', message: 'Choose an employee' });
    }
    if (!isValidMonthString(month)) {
      return res.status(400).json({ field: 'month', message: 'Choose a month (e.g. 2026-09)' });
    }

    // Fail here rather than letting the operator fill in a draft that POST
    // would then refuse. Read-only, so it runs on the pool, not a transaction.
    const runCheck = await loadOpenRun(db, month);
    if (runCheck.error) return res.status(runCheck.error.status).json(runCheck.error.body);

    const employee = await loadPayrollEmployee(db, employeeId);
    if (!employee) return res.status(404).json({ message: 'Employee not found' });

    const employmentError = employmentMonthError(employee, month);
    if (employmentError) return res.status(400).json({ field: 'month', message: employmentError });

    // A slip already exists -> tell the caller instead of handing back a
    // draft they would only be refused on save.
    const [[existing]] = await db.query(
      'SELECT id FROM salary_slips WHERE employee_id=? AND month=?',
      [employeeId, month]
    );
    if (existing) {
      return res.status(409).json({
        existing_slip_id: existing.id,
        message: `A salary slip for ${employee.name} already exists for ${month}. Open it from the list to view or print it.`,
      });
    }

    const [components] = await db.query(
      'SELECT type, title, amount FROM salary_components WHERE employee_id=? ORDER BY id',
      [employeeId]
    );

    const earnings = components
      .filter(c => c.type === 'Earning')
      .map(c => ({ title: c.title, amount: money(c.amount) }));

    const deductions = components
      .filter(c => c.type === 'Deduction')
      .map(c => ({ title: c.title, amount: money(c.amount) }));

    // One pre-filled, editable deduction line per outstanding loan, defaulted
    // to the whole remaining balance. `loan_remaining` rides along so the UI
    // can show the consequence of editing the figure.
    const loans = await loadOutstandingLoans(db, employeeId);
    for (const loan of loans) {
      deductions.push({
        title: `Loan repayment — ${loan.title}`,
        amount: money(loan.remaining_balance),
        loan_id: loan.id,
        loan_remaining: money(loan.remaining_balance),
      });
    }

    const [[targetRow]] = await db.query(
      'SELECT target_amount FROM sales_targets WHERE employee_id=?',
      [employeeId]
    );
    const targetAmount = employee.is_field_employee && targetRow ? money(targetRow.target_amount) : null;

    const target = await computeTargetAchieved(db, employee, month);

    const totalEarnings   = sumLines(earnings);
    const totalDeductions = sumLines(deductions);
    const attendance = await attendanceSummary(db, employee, month);

    res.json({
      employee,
      month,
      attendance,
      earnings,
      deductions,
      target_amount:   targetAmount,
      target_achieved: target.achieved,
      target_basis:    target.basis,
      target_reason:   target.reason,
      total_earnings:   totalEarnings,
      total_deductions: totalDeductions,
      net_pay: money(totalEarnings - totalDeductions),
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET /:id — one saved slip, for viewing / printing ──────────────────────
router.get('/:id', auth, perm, async (req, res) => {
  try {
    const [[row]] = await db.query(`
      SELECT s.*,
             e.employee_id AS employee_code,
             e.name        AS employee_name,
             e.father_name,
             e.cnic,
             e.is_field_employee,
             DATE_FORMAT(e.date_of_joining, '%Y-%m-%d') AS date_of_joining,
             DATE_FORMAT(e.date_of_leaving, '%Y-%m-%d') AS date_of_leaving,
             e.bank_name, e.account_title, e.account_number, e.iban,
             dep.name AS department_name,
             des.name AS designation_name
        FROM salary_slips s
        JOIN hr_employees e   ON e.id  = s.employee_id
        JOIN departments  dep ON dep.id = e.department_id
        JOIN designations des ON des.id = e.designation_id
       WHERE s.id = ?
    `, [req.params.id]);

    if (!row) return res.status(404).json({ message: 'Salary slip not found' });

    const earnings   = parseJsonColumn(row.earnings_json);
    const deductions = parseJsonColumn(row.deductions_json);

    // Whether this slip can still be corrected is a property of its payroll
    // session, so the run travels with the slip rather than forcing the client
    // to correlate two responses.
    const [[run]] = await db.query(
      'SELECT id, month, status, completed_at FROM payroll_runs WHERE month = ?',
      [row.month]
    );

    // Loan balances as they would be WITHOUT this slip. That is the figure the
    // edit screen needs: it caps a repayment line and drives the "left after
    // this slip" hint. Using the plain remaining balance would double-count
    // this slip's own repayment and reject an unchanged line.
    const [loanContext] = await db.query(`
      SELECT l.id, l.title, l.principal_amount,
             l.principal_amount - COALESCE(SUM(lr.amount), 0) AS remaining_excluding_slip
        FROM loans l
        LEFT JOIN loan_repayments lr
               ON lr.loan_id = l.id AND lr.salary_slip_id <> ?
       WHERE l.employee_id = ?
       GROUP BY l.id, l.title, l.principal_amount
       ORDER BY l.date_issued, l.id
    `, [row.id, row.employee_id]);

    const attendance = await attendanceSummary(db, {
      id: row.employee_id,
      date_of_joining: row.date_of_joining,
      date_of_leaving: row.date_of_leaving,
    }, row.month);

    res.json({
      ...row,
      earnings,
      deductions,
      ...slipFigures(earnings, deductions),
      attendance,
      payroll_run: run || null,
      is_editable: !!run && run.status === 'Open',
      loan_context: loanContext.map(loan => ({
        id: loan.id,
        title: loan.title,
        principal_amount: money(loan.principal_amount),
        remaining_excluding_slip: money(loan.remaining_excluding_slip),
      })),
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});


// ── Shared write path for POST (create) and PUT (edit) ─────────────────────
// Validates the submitted lines, re-journals loan repayments, and recomputes
// every figure that must not come from the caller. Runs inside the caller's
// transaction, after the payroll-run gate has passed.
//
// `slipId` is null on create, or the slip being edited. On an edit the slip's
// existing loan_repayments rows are deleted FIRST, so the balances the new
// repayment lines are validated against are the ones that would exist if this
// slip had never been saved — otherwise raising a repayment from 5,000 to
// 6,000 would be measured against a balance the slip itself had already
// reduced, and would be rejected for no reason.
//
// Returns { error: { status, body } } or the values to write.
async function buildSlipWrite(conn, { employee, month, body, slipId = null }) {
  const earningsResult = normaliseLines(body.earnings, 'earnings');
  if (earningsResult.error) return { error: { status: 400, body: earningsResult.error } };

  const deductionsResult = normaliseLines(body.deductions, 'deductions');
  if (deductionsResult.error) return { error: { status: 400, body: deductionsResult.error } };

  const earnings = earningsResult.lines;
  // A loan repayment the operator zeroed out means "not this month", so the
  // line is dropped entirely rather than kept on the slip as a 0.00 row that
  // also journals nothing.
  const deductions = deductionsResult.lines.filter(line => !(line.loan_id && line.amount <= PAISA));

  if (earnings.length === 0) {
    return { error: { status: 400, body: { field: 'earnings', message: 'A salary slip needs at least one earning line' } } };
  }

  // ── Loan repayment lines ───────────────────────────────────────────────
  const repaymentLines = deductions.filter(line => line.loan_id);

  if (slipId) {
    // Clear this slip's own journal entries before deriving balances. The row
    // lock taken below still serialises concurrent writers.
    await conn.query('DELETE FROM loan_repayments WHERE salary_slip_id = ?', [slipId]);
  }

  if (repaymentLines.length) {
    const loans = await loadOutstandingLoans(conn, employee.id, { forUpdate: true });
    const outstandingById = new Map(loans.map(loan => [loan.id, loan]));

    // Two lines against one loan would each pass an individual balance check
    // while together overdrawing it, so they are totalled per loan.
    const perLoanTotal = new Map();
    for (const line of repaymentLines) {
      perLoanTotal.set(line.loan_id, money((perLoanTotal.get(line.loan_id) || 0) + line.amount));
    }

    for (const [loanId, total] of perLoanTotal) {
      const loan = outstandingById.get(loanId);
      if (!loan) {
        return {
          error: {
            status: 400,
            body: {
              field: 'deductions',
              message: 'A loan on this slip has already been fully repaid elsewhere. Rebuild the draft to pick up the current balances.',
            },
          },
        };
      }
      if (total - money(loan.remaining_balance) > PAISA) {
        return {
          error: {
            status: 400,
            body: {
              field: 'deductions',
              message: `Repayment of ${total} for "${loan.title}" exceeds its remaining balance of ${money(loan.remaining_balance)}.`,
            },
          },
        };
      }
    }
  }

  // ── Values that are never taken from the request body ──────────────────
  // target_achieved is recomputed with the same query /draft uses, so a draft
  // that went stale in the browser cannot be saved as fact.
  const target = await computeTargetAchieved(conn, employee, month);

  // target_amount is snapshotted from the live sales_targets row rather than
  // the payload — the target itself is only editable on the employee page,
  // never inside payroll.
  const [[targetRow]] = await conn.query(
    'SELECT target_amount FROM sales_targets WHERE employee_id=?',
    [employee.id]
  );
  const targetAmount = employee.is_field_employee && targetRow ? money(targetRow.target_amount) : null;

  const totalEarnings   = sumLines(earnings);
  const totalDeductions = sumLines(deductions);
  const netPay          = money(totalEarnings - totalDeductions);

  if (netPay < 0) {
    return {
      error: {
        status: 400,
        body: {
          field: 'deductions',
          message: `Deductions (${totalDeductions}) exceed earnings (${totalEarnings}), which would leave a negative net pay. Reduce a deduction — a loan repayment can be spread across months.`,
        },
      },
    };
  }

  // The stored JSON keeps `loan_id` on repayment lines so a printed slip can
  // always be traced back to the loan it paid down, but drops the transient
  // `loan_remaining` display hint the draft carries.
  const earningsJson   = earnings.map(({ title, amount }) => ({ title, amount }));
  const deductionsJson = deductions.map(({ title, amount, loan_id }) => (
    loan_id ? { title, amount, loan_id } : { title, amount }
  ));

  return {
    earningsJson,
    deductionsJson,
    repaymentRows: repaymentLines.map(line => [line.loan_id, line.amount]),
    targetAmount,
    targetAchieved: target.achieved,
    totalEarnings,
    totalDeductions,
    netPay,
  };
}

// ── POST / — add a slip to the open session ────────────────────────────────
router.post('/', auth, perm, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const employeeId = parseInt(req.body.employee_id, 10);
    const month      = req.body.month;

    if (!Number.isFinite(employeeId) || employeeId <= 0) {
      await conn.rollback();
      return res.status(400).json({ field: 'employee_id', message: 'Choose an employee' });
    }
    if (!isValidMonthString(month)) {
      await conn.rollback();
      return res.status(400).json({ field: 'month', message: 'Choose a month (e.g. 2026-09)' });
    }

    // The session gate. A slip cannot exist for a month with no run, and a
    // finalized run accepts nothing further.
    const runCheck = await loadOpenRun(conn, month, { lock: true });
    if (runCheck.error) {
      await conn.rollback();
      return res.status(runCheck.error.status).json(runCheck.error.body);
    }

    const employee = await loadPayrollEmployee(conn, employeeId);
    if (!employee) {
      await conn.rollback();
      return res.status(404).json({ message: 'Employee not found' });
    }

    const employmentError = employmentMonthError(employee, month);
    if (employmentError) {
      await conn.rollback();
      return res.status(400).json({ field: 'month', message: employmentError });
    }

    const write = await buildSlipWrite(conn, { employee, month, body: req.body });
    if (write.error) {
      await conn.rollback();
      return res.status(write.error.status).json(write.error.body);
    }

    const [result] = await conn.query(`
      INSERT INTO salary_slips
        (employee_id, month, earnings_json, deductions_json, target_amount, target_achieved, net_pay)
      VALUES (?,?,?,?,?,?,?)
    `, [
      employeeId, month,
      JSON.stringify(write.earningsJson), JSON.stringify(write.deductionsJson),
      write.targetAmount, write.targetAchieved, write.netPay,
    ]);

    const slipId = result.insertId;

    if (write.repaymentRows.length) {
      await conn.query(
        'INSERT INTO loan_repayments (loan_id, salary_slip_id, amount) VALUES ?',
        [write.repaymentRows.map(([loanId, amount]) => [loanId, slipId, amount])]
      );
    }

    await conn.commit();
    await logAudit(req, 'CREATE', 'hr/salary-slips', slipId,
      `Salary slip for ${employee.employee_id} (${employee.name}) ${month} — net ${write.netPay}`);

    res.status(201).json({
      id: slipId,
      employee_id: employeeId,
      month,
      earnings: write.earningsJson,
      deductions: write.deductionsJson,
      target_amount: write.targetAmount,
      target_achieved: write.targetAchieved,
      net_pay: write.netPay,
      ...slipFigures(write.earningsJson, write.deductionsJson),
    });
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        message: 'A salary slip for this employee and month already exists. Open it from the list instead.',
      });
    }
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
});

// ── PUT /:id — correct a slip while its session is still open ──────────────
// `employee_id` and `month` are fixed for the life of the slip: they are the
// slip's identity (uq_employee_month) and the month is the FK to its payroll
// run. Only the earnings and deductions can change, and the target/net figures
// are recomputed from them.
router.put('/:id', auth, perm, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // Locked so a concurrent complete-session or second edit cannot interleave
    // with the repayment re-journalling below.
    const [[slip]] = await conn.query(
      'SELECT id, employee_id, month FROM salary_slips WHERE id=? FOR UPDATE',
      [req.params.id]
    );
    if (!slip) {
      await conn.rollback();
      return res.status(404).json({ message: 'Salary slip not found' });
    }

    const runCheck = await loadOpenRun(conn, slip.month, { lock: true });
    if (runCheck.error) {
      await conn.rollback();
      return res.status(runCheck.error.status).json(runCheck.error.body);
    }

    const employee = await loadPayrollEmployee(conn, slip.employee_id);
    if (!employee) {
      await conn.rollback();
      return res.status(404).json({ message: 'Employee not found' });
    }

    const write = await buildSlipWrite(conn, {
      employee,
      month: slip.month,
      body: req.body,
      slipId: slip.id,
    });
    if (write.error) {
      await conn.rollback();
      return res.status(write.error.status).json(write.error.body);
    }

    await conn.query(`
      UPDATE salary_slips
         SET earnings_json=?, deductions_json=?, target_amount=?, target_achieved=?, net_pay=?
       WHERE id=?
    `, [
      JSON.stringify(write.earningsJson), JSON.stringify(write.deductionsJson),
      write.targetAmount, write.targetAchieved, write.netPay, slip.id,
    ]);

    // buildSlipWrite already removed this slip's old repayment rows; re-insert
    // the new set so every affected loan's pending amount lands correctly.
    if (write.repaymentRows.length) {
      await conn.query(
        'INSERT INTO loan_repayments (loan_id, salary_slip_id, amount) VALUES ?',
        [write.repaymentRows.map(([loanId, amount]) => [loanId, slip.id, amount])]
      );
    }

    await conn.commit();
    await logAudit(req, 'UPDATE', 'hr/salary-slips', slip.id,
      `Edited salary slip for ${employee.employee_id} (${employee.name}) ${slip.month} — net ${write.netPay}`);

    res.json({
      message: 'Salary slip updated',
      id: slip.id,
      employee_id: slip.employee_id,
      month: slip.month,
      earnings: write.earningsJson,
      deductions: write.deductionsJson,
      target_amount: write.targetAmount,
      target_achieved: write.targetAchieved,
      net_pay: write.netPay,
      ...slipFigures(write.earningsJson, write.deductionsJson),
    });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
});

// There is deliberately no DELETE. A salary slip cannot be removed during its
// session or after it, so payroll history is complete by construction. A wrong
// slip is corrected with PUT while the session is still open.

module.exports = router;
