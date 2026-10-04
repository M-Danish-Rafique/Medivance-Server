const { todayPKT } = require('./dateUtils');
const { monthBounds } = require('./payrollRun');

// ─── Advance salary ────────────────────────────────────────────────────────
// Shared by routes/hrEmployees.js (recording / removing an advance) and
// routes/salarySlips.js (deducting it), so both sides agree on which month an
// advance belongs to and on what a payslip's advance figure is.
//
// An advance is part of a month's salary paid early — not a loan. It is
// recorded against the PAY PERIOD it will be taken from:
//
//   the current PKT month, unless that month's Pay Run is already closed,
//   in which case the next month (product decision 2026-09-30 — runs are
//   often closed a few days before the month ends).
//
// That month's payslip deducts the SUM of its advances, always in full. The
// figure is never taken from a request body and cannot be edited on the
// payslip:
//
//   Net salary  = gross earnings - deductions
//   Net payable = net salary - advance            (salary_slips.net_pay)
//
// Net payable can never go below zero. An advance may be recorded or removed
// only while its month's Pay Run is not closed; when that month already has a
// payslip (run still open) the payslip is updated in the same transaction.
//
// Lock order, shared with the payslip writes so the two can never deadlock:
//   payroll run (shared) -> hr_employees row (exclusive) -> salary slip -> loans
//
// Every write to salary_advances happens under that employee-row lock, and
// every read of them inside a write transaction is a LOCKING read (`lock`).
// That matters under REPEATABLE READ: a plain SELECT reads the snapshot taken
// at the transaction's first plain read, which may predate the lock wait, and
// would silently miss an advance committed meanwhile (caught in testing: a
// payslip saved in parallel with advances ended out of step with them).

const PAISA = 0.005;

function money(value) {
  return Math.round((parseFloat(value) || 0) * 100) / 100;
}

/** 60000 -> "PKR 60,000.00". Every amount in an operator-facing message uses it. */
function fmtPKR(value) {
  return `PKR ${money(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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

function sumLines(lines) {
  return money(lines.reduce((total, line) => total + (parseFloat(line.amount) || 0), 0));
}

/** "2026-09" -> "2026-10", "2026-12" -> "2027-01". Calendar math only. */
function nextMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** "2026-10" -> "October 2026" — these strings are shown to the operator. */
function monthLabel(month) {
  const [year, mm] = String(month).split('-');
  return `${MONTH_NAMES[Number(mm) - 1] || mm} ${year}`;
}

async function loadRunStatus(conn, month, { lock = false } = {}) {
  const [[run]] = await conn.query(
    `SELECT id, status FROM payroll_runs WHERE month = ?${lock ? ' LOCK IN SHARE MODE' : ''}`,
    [month]
  );
  return run || null;
}

// Which pay period a NEW advance recorded today is deducted from.
// With `lock` the run rows are read with share locks, so this never opens the
// transaction's snapshot ahead of the employee lock (see the header).
// Returns { month, rolledForward, closedMonth } or { error }.
async function resolveAdvanceMonth(conn, { lock = false } = {}) {
  const current = todayPKT().slice(0, 7);
  const currentRun = await loadRunStatus(conn, current, { lock });
  if (!currentRun || currentRun.status !== 'Completed') {
    return { month: current, rolledForward: false, closedMonth: null };
  }

  const next = nextMonth(current);
  const nextRun = await loadRunStatus(conn, next, { lock });
  if (nextRun && nextRun.status === 'Completed') {
    // Not reachable through the UI (a run can only be started for a month
    // that has begun), but refuse rather than record into a frozen month.
    return {
      error: `The Pay Runs for ${monthLabel(current)} and ${monthLabel(next)} are both closed. Advance salary cannot be recorded.`,
    };
  }
  return { month: next, rolledForward: true, closedMonth: current };
}

/**
 * Total advance taken against `month`. Pass `lock` inside a write
 * transaction: the locking read always sees the latest committed rows.
 */
async function sumAdvances(conn, employeeId, month, { lock = false } = {}) {
  const [[row]] = await conn.query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM salary_advances
      WHERE employee_id = ? AND month = ?${lock ? ' FOR SHARE' : ''}`,
    [employeeId, month]
  );
  return money(row.total);
}

/** The month's advances as individual entries, oldest first. `lock` as above. */
async function listAdvances(conn, employeeId, month, { lock = false } = {}) {
  const [rows] = await conn.query(`
    SELECT id, amount, note, DATE_FORMAT(date_given, '%Y-%m-%d') AS date_given
      FROM salary_advances
     WHERE employee_id = ? AND month = ?
     ORDER BY date_given, id${lock ? ' FOR SHARE' : ''}
  `, [employeeId, month]);
  return rows.map(row => ({ ...row, amount: money(row.amount) }));
}

/** Live salary structure totals — the "by default" figures an advance is judged against. */
async function loadStructureTotals(conn, employeeId) {
  const [[row]] = await conn.query(`
    SELECT COALESCE(SUM(CASE WHEN type = 'Earning'   THEN amount ELSE 0 END), 0) AS gross,
           COALESCE(SUM(CASE WHEN type = 'Deduction' THEN amount ELSE 0 END), 0) AS deductions
      FROM salary_components
     WHERE employee_id = ?
  `, [employeeId]);
  const gross = money(row.gross);
  const deductions = money(row.deductions);
  return { gross, deductions, net: money(gross - deductions) };
}

/** A saved payslip's figures, recomputed from its own JSON snapshot. */
function slipTotals(slip, advanceAmount = slip.advance_amount) {
  const earnings   = sumLines(parseJsonColumn(slip.earnings_json));
  const deductions = sumLines(parseJsonColumn(slip.deductions_json));
  const netSalary  = money(earnings - deductions);
  const advance    = money(advanceAmount);
  return {
    total_earnings:   earnings,
    total_deductions: deductions,
    net_salary:       netSalary,
    advance_amount:   advance,
    net_pay:          money(netSalary - advance),
  };
}

// Whether an advance can be taken by this employee against `month`, as a
// sentence the UI can show, or null.
function advanceEligibilityError(employee, month) {
  if (employee.status !== 'Active') {
    return `${employee.name} is inactive. Advance salary can be recorded only for active employees.`;
  }
  const { last } = monthBounds(month);
  if (employee.date_of_joining && employee.date_of_joining > last) {
    return `${employee.name} joins on ${employee.date_of_joining}. There is no ${monthLabel(month)} salary to advance.`;
  }
  return null;
}

// Everything the "Record advance" form needs, and everything POST validates
// against. With `lock`, the run row is share-locked and the employee and slip
// rows are locked for update, in the module's lock order.
//
// Returns { error } or {
//   month, rolled_forward, closed_month, blocked,
//   structure: { gross, deductions, net },
//   month_total, advances[],
//   slip: null | { id, total_earnings, total_deductions, net_salary, advance_amount, net_pay }
// }
async function loadAdvanceContext(conn, employeeId, { lock = false } = {}) {
  const resolved = await resolveAdvanceMonth(conn, { lock });
  if (resolved.error) return { error: { status: 409, body: { message: resolved.error } } };
  const { month } = resolved;

  if (lock) {
    const run = await loadRunStatus(conn, month, { lock: true });
    if (run && run.status === 'Completed') {
      return {
        error: {
          status: 409,
          body: {
            code: 'PAYROLL_RUN_COMPLETED',
            message: `The ${monthLabel(month)} Pay Run was closed while this form was open. Open the form again to record the advance against the next month.`,
          },
        },
      };
    }
  }

  const [[employee]] = await conn.query(`
    SELECT id, employee_id, name, status,
           DATE_FORMAT(date_of_joining, '%Y-%m-%d') AS date_of_joining
      FROM hr_employees WHERE id = ?${lock ? ' FOR UPDATE' : ''}
  `, [employeeId]);
  if (!employee) return { error: { status: 404, body: { message: 'Employee not found' } } };

  const [[slip]] = await conn.query(
    `SELECT id, earnings_json, deductions_json, advance_amount
       FROM salary_slips WHERE employee_id = ? AND month = ?${lock ? ' FOR UPDATE' : ''}`,
    [employeeId, month]
  );

  const [structure, advances] = await Promise.all([
    loadStructureTotals(conn, employeeId),
    listAdvances(conn, employeeId, month, { lock }),
  ]);

  return {
    employee,
    month,
    rolled_forward: resolved.rolledForward,
    closed_month: resolved.closedMonth,
    blocked: advanceEligibilityError(employee, month),
    structure,
    month_total: sumLines(advances),
    advances,
    slip: slip ? { id: slip.id, ...slipTotals(slip) } : null,
  };
}

// Re-derive a payslip's advance after an advance was recorded or removed.
// The caller holds the run (shared) and employee locks. Refuses — without
// writing — when the payslip's net payable would go below zero.
//
// Returns { slip: null } | { slip: { id, before, after } } | { error }.
async function syncSlipAdvance(conn, employeeId, month) {
  const [[slip]] = await conn.query(
    `SELECT id, earnings_json, deductions_json, advance_amount, net_pay
       FROM salary_slips WHERE employee_id = ? AND month = ? FOR UPDATE`,
    [employeeId, month]
  );
  if (!slip) return { slip: null };

  const advance = await sumAdvances(conn, employeeId, month, { lock: true });
  const after = slipTotals(slip, advance);
  if (after.net_pay < -PAISA) {
    return {
      error: {
        status: 400,
        body: {
          field: 'amount',
          code: 'NET_PAYABLE_NEGATIVE',
          message: `The ${monthLabel(month)} payslip is already processed with a net salary of ${fmtPKR(after.net_salary)}. `
            + `Total advances of ${fmtPKR(advance)} would leave a negative net payable. Reduce a deduction on the payslip or record a smaller amount.`,
        },
      },
    };
  }

  await conn.query(
    'UPDATE salary_slips SET advance_amount = ?, net_pay = ? WHERE id = ?',
    [after.advance_amount, after.net_pay, slip.id]
  );
  return {
    slip: {
      id: slip.id,
      before: { advance_amount: money(slip.advance_amount), net_pay: money(slip.net_pay) },
      after:  { advance_amount: after.advance_amount, net_pay: after.net_pay },
    },
  };
}

module.exports = {
  PAISA,
  fmtPKR,
  nextMonth,
  monthLabel,
  resolveAdvanceMonth,
  sumAdvances,
  listAdvances,
  loadStructureTotals,
  loadAdvanceContext,
  syncSlipAdvance,
};
