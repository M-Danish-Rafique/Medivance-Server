const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const auth    = require('../middleware/auth');
const { logAudit } = require('../middleware/auditLog');
const requirePermission = require('../middleware/requirePermission');
const { nowPKT } = require('../utils/dateUtils');
const { loadPendingEmployees, countEligibleEmployees } = require('../utils/payrollRun');

// ─── Payroll runs (monthly payroll sessions) ────────────────────────────────
// One run per month. The operator opens it, adds a slip per employee,
// corrects whatever needs correcting, then completes it. Completing is the
// point of no return: every slip in that month becomes permanently read-only.
//
//   Open      -> slips can be added and edited
//   Completed -> slips are frozen; nothing can be added or edited
//
// Deliberately absent:
//   * no reopen — "once the salaries are finalized, the edit option is gone"
//   * no slip delete, during or after a run (see salarySlips.js)
//   * no run delete once it holds slips — the FK from salary_slips.month
//     refuses it at the DB level
//
// Cost to Company is ONE figure per month, recorded on the run when it is
// closed (payroll_runs.cost_to_company, migration add_payroll_ctc.sql). The
// close request may carry the operator's figure; without one the calculated
// figure is stored: gross earnings less deductions, EXCLUDING loan repayments
// (they settle money already lent) and never reduced by advance salary (the
// same salary, paid earlier) — product decision 2026-10-01, which replaced the
// earlier "CTC = gross" rule. NULL = not recorded (open, or closed before the
// column).
//
// `total_net` below is the sum of salary_slips.net_pay, i.e. net PAYABLE —
// the cash still to disburse after each month's advances.
//
// A run can only be closed once EVERY employee payable in its month has a
// slip. Someone who should not be paid gets a zero-pay slip stating why, so
// the month's record is complete by construction (product decision 2026-09-22).

const perm = requirePermission('perm_hr_payroll', 'Payroll');

function money(value) {
  return Math.round((parseFloat(value) || 0) * 100) / 100;
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

function isValidMonthString(value) {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

// ── GET / — every run, newest month first ──────────────────────────────────
// Carries the slip count and total net pay so the UI can show a session's
// progress without a second request, plus how many active employees still have
// no slip in that month.
router.get('/', auth, perm, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT r.id, r.month, r.status, r.opened_at, r.completed_at, r.cost_to_company,
             ou.full_name AS opened_by_name,
             cu.full_name AS completed_by_name,
             COALESCE(s.slip_count, 0) AS slip_count,
             COALESCE(s.total_net,   0) AS total_net
        FROM payroll_runs r
        LEFT JOIN users ou ON ou.id = r.opened_by
        LEFT JOIN users cu ON cu.id = r.completed_by
        LEFT JOIN (
          SELECT month, COUNT(*) AS slip_count, SUM(net_pay) AS total_net
            FROM salary_slips
           GROUP BY month
        ) s ON s.month = r.month
       ORDER BY r.month DESC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET /roster?month=YYYY-MM — who is still to be paid ─────────────────────
// Backs the Pending tab: every employee payable in the month (see
// ELIGIBLE_WHERE in utils/payrollRun.js) who has no slip yet, with their live
// salary structure and outstanding loan balance so the operator can see what
// each payslip will start from. `eligible` is the denominator for "n of m
// processed". Read-only; works with or without a run for the month.
router.get('/roster', auth, perm, async (req, res) => {
  try {
    const month = String(req.query.month || '');
    if (!isValidMonthString(month)) {
      return res.status(400).json({ field: 'month', message: 'Month must look like 2026-09' });
    }
    const [pending, eligible] = await Promise.all([
      loadPendingEmployees(db, month),
      countEligibleEmployees(db, month),
    ]);
    res.json({ month, eligible, pending });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── POST / — open a session for a month ────────────────────────────────────
router.post('/', auth, perm, async (req, res) => {
  try {
    const month = req.body.month;
    if (!isValidMonthString(month)) {
      return res.status(400).json({ field: 'month', message: 'Choose a month (e.g. 2026-09)' });
    }

    const [[existing]] = await db.query('SELECT id, status FROM payroll_runs WHERE month=?', [month]);
    if (existing) {
      return res.status(409).json({
        existing_run_id: existing.id,
        message: existing.status === 'Open'
          ? `A payroll session for ${month} is already open.`
          : `Payroll for ${month} has already been finalized.`,
      });
    }

    const [result] = await db.query(
      'INSERT INTO payroll_runs (month, status, opened_by) VALUES (?, ?, ?)',
      [month, 'Open', req.user.id]
    );

    await logAudit(req, 'CREATE', 'hr/payroll-runs', result.insertId, `Opened payroll session for ${month}`);

    res.status(201).json({ id: result.insertId, month, status: 'Open', slip_count: 0, total_net: 0 });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'A payroll session for that month already exists.' });
    }
    res.status(500).json({ message: err.message });
  }
});

// ── PUT /:id/complete — finalize the session ───────────────────────────────
// Irreversible. The run row is locked so two operators cannot both complete it
// and double-log the event.
router.put('/:id/complete', auth, perm, async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [[run]] = await conn.query(
      'SELECT id, month, status FROM payroll_runs WHERE id=? FOR UPDATE',
      [req.params.id]
    );
    if (!run) {
      await conn.rollback();
      return res.status(404).json({ message: 'Payroll session not found' });
    }
    if (run.status === 'Completed') {
      await conn.rollback();
      return res.status(409).json({ message: `Payroll for ${run.month} has already been finalized.` });
    }

    const [[counts]] = await conn.query(
      'SELECT COUNT(*) AS slip_count FROM salary_slips WHERE month = ?',
      [run.month]
    );
    if (counts.slip_count === 0) {
      await conn.rollback();
      return res.status(400).json({
        message: `There are no salary slips in the ${run.month} session yet. Add at least one before finalizing.`,
      });
    }

    // Everyone payable must be processed first. Read under the run's
    // exclusive lock, so no slip can be added between this check and the
    // status change (slip writes take a shared lock on the same row).
    const pending = await loadPendingEmployees(conn, run.month);
    if (pending.length) {
      await conn.rollback();
      const names = pending.slice(0, 5).map(p => p.name).join(', ');
      return res.status(409).json({
        code: 'PAYROLL_RUN_INCOMPLETE',
        pending_count: pending.length,
        message: `${pending.length} employee${pending.length === 1 ? ' has' : 's have'} not been processed for ${run.month} yet (${names}${pending.length > 5 ? ', …' : ''}). Process every employee before closing — give anyone who should not be paid a zero-pay payslip.`,
      });
    }

    // Monthly Cost to Company, calculated from the slips' own snapshots (read
    // under the run's exclusive lock, so the slip set cannot change): gross
    // earnings less deductions, EXCLUDING loan repayments (lines tagged with a
    // loan_id — they return money lent earlier) and never reduced by advance
    // salary (the same salary, paid early). Product decision 2026-10-01;
    // mirrored by monthTotals.ctc in SalarySlips.jsx. The operator's figure
    // replaces it when one is sent.
    const [slipRows] = await conn.query(
      'SELECT earnings_json, deductions_json FROM salary_slips WHERE month = ?',
      [run.month]
    );
    const lineSum = (lines) => lines.reduce((t, line) => t + (parseFloat(line.amount) || 0), 0);
    const calculatedCtc = money(slipRows.reduce((total, row) => (
      total
        + lineSum(parseJsonColumn(row.earnings_json))
        - lineSum(parseJsonColumn(row.deductions_json).filter(line => !line.loan_id))
    ), 0));

    let costToCompany = calculatedCtc;
    const rawCtc = req.body ? req.body.cost_to_company : undefined;
    if (rawCtc !== undefined && rawCtc !== null && rawCtc !== '') {
      const parsed = parseFloat(rawCtc);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 999999999999.99) {
        await conn.rollback();
        return res.status(400).json({ field: 'cost_to_company', message: 'Cost to company must be zero or more' });
      }
      costToCompany = money(parsed);
    }

    await conn.query(
      'UPDATE payroll_runs SET status=?, completed_at=?, completed_by=?, cost_to_company=? WHERE id=?',
      ['Completed', nowPKT(), req.user.id, costToCompany, run.id]
    );

    await conn.commit();
    await logAudit(req, 'STATUS_CHANGE', 'hr/payroll-runs', run.id,
      `Finalized payroll for ${run.month} — ${counts.slip_count} slip${counts.slip_count === 1 ? '' : 's'} locked, cost to company ${costToCompany}${costToCompany !== calculatedCtc ? ` (calculated ${calculatedCtc})` : ''}`);

    res.json({
      message: `Payroll for ${run.month} finalized`,
      id: run.id,
      month: run.month,
      status: 'Completed',
      slip_count: counts.slip_count,
      cost_to_company: costToCompany,
      calculated_cost_to_company: calculatedCtc,
    });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
});

module.exports = router;
