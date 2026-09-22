// ─── Payroll session gate ──────────────────────────────────────────────────
// Shared by routes/payrollRuns.js and routes/salarySlips.js so both answer a
// missing or finalized session with exactly the same status and copy.
//
// A slip may only be created or edited while its month's run is Open:
//   no run   -> 409 NO_PAYROLL_RUN         ("start the session first")
//   Completed-> 409 PAYROLL_RUN_COMPLETED  ("finalized, can no longer change")
//
// 409 rather than 403: the client's axios interceptor logs the user out on any
// 403, and this is a business state, not an auth failure (P0-7).
//
// `lock: true` (slip writes, inside their transaction) takes a SHARED lock on
// the run row. Closing a run takes an EXCLUSIVE lock on the same row, so a
// close waits for in-flight slip writes and a slip write started after the
// close sees "Completed" — a slip can never land in a run that has closed.
// Concurrent slip writes only share the lock, so they do not serialise.
async function loadOpenRun(conn, month, { lock = false } = {}) {
  const [[run]] = await conn.query(
    `SELECT id, month, status FROM payroll_runs WHERE month = ?${lock ? ' LOCK IN SHARE MODE' : ''}`,
    [month]
  );

  if (!run) {
    return {
      error: {
        status: 409,
        body: {
          code: 'NO_PAYROLL_RUN',
          message: `No payroll session has been started for ${month}. Start the session first, then add salary slips.`,
        },
      },
    };
  }
  if (run.status !== 'Open') {
    return {
      error: {
        status: 409,
        body: {
          code: 'PAYROLL_RUN_COMPLETED',
          message: `Payroll for ${month} has been finalized, so its salary slips can no longer be added to or changed.`,
        },
      },
    };
  }
  return { run };
}

/** "2026-09" -> { first: "2026-09-01", last: "2026-09-30" }. Calendar math only. */
function monthBounds(month) {
  const [y, m] = month.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { first: `${month}-01`, last: `${month}-${String(days).padStart(2, '0')}` };
}

// ── Who is payable in a month ──────────────────────────────────────────────
// Active employees who had joined by the month's last day. Inactive employees
// have LEFT and are never paid through a run (product decision 2026-09-22) —
// a leaver's final salary is processed before they are marked Inactive. Their
// existing payslips stay in history untouched.
//
// This is the single definition behind the pending list, the "n of m
// processed" count and the close gate; salarySlips.js refuses a NEW slip for
// anyone outside it (employmentMonthError + the Inactive check).
// `e` must alias hr_employees; binds [last, first].
const ELIGIBLE_WHERE = `
  e.status = 'Active'
  AND e.date_of_joining <= ?
  AND (e.date_of_leaving IS NULL OR e.date_of_leaving >= ?)
`;

/** Eligible employees for `month` who have no slip in it yet. */
async function loadPendingEmployees(conn, month) {
  const { first, last } = monthBounds(month);
  const [rows] = await conn.query(`
    SELECT e.id, e.employee_id AS employee_code, e.name, e.status, e.is_field_employee,
           DATE_FORMAT(e.date_of_joining, '%Y-%m-%d') AS date_of_joining,
           DATE_FORMAT(e.date_of_leaving, '%Y-%m-%d') AS date_of_leaving,
           dep.name AS department_name,
           des.name AS designation_name,
           COALESCE(sc.gross, 0)      AS structure_earnings,
           COALESCE(sc.deductions, 0) AS structure_deductions,
           COALESCE(lo.outstanding, 0) AS loan_outstanding
      FROM hr_employees e
      JOIN departments  dep ON dep.id = e.department_id
      JOIN designations des ON des.id = e.designation_id
      LEFT JOIN salary_slips s ON s.employee_id = e.id AND s.month = ?
      LEFT JOIN (
        SELECT employee_id,
               SUM(CASE WHEN type = 'Earning'   THEN amount ELSE 0 END) AS gross,
               SUM(CASE WHEN type = 'Deduction' THEN amount ELSE 0 END) AS deductions
          FROM salary_components
         GROUP BY employee_id
      ) sc ON sc.employee_id = e.id
      LEFT JOIN (
        SELECT l.employee_id, SUM(l.principal_amount - COALESCE(r.repaid, 0)) AS outstanding
          FROM loans l
          LEFT JOIN (SELECT loan_id, SUM(amount) AS repaid FROM loan_repayments GROUP BY loan_id) r
                 ON r.loan_id = l.id
         GROUP BY l.employee_id
      ) lo ON lo.employee_id = e.id
     WHERE ${ELIGIBLE_WHERE}
       AND s.id IS NULL
     ORDER BY dep.name, e.name
  `, [month, last, first]);
  return rows;
}

/** How many employees are payable in `month` at all. */
async function countEligibleEmployees(conn, month) {
  const { first, last } = monthBounds(month);
  const [[row]] = await conn.query(
    `SELECT COUNT(*) AS n FROM hr_employees e WHERE ${ELIGIBLE_WHERE}`,
    [last, first]
  );
  return Number(row.n);
}

module.exports = { loadOpenRun, monthBounds, loadPendingEmployees, countEligibleEmployees };
