const { nowPKT } = require('./dateUtils');

// ─── Master Data employees (`employees`) ───────────────────────────────────
// Salesmen and Suppliers (a Supplier is the delivery / recovery person). They
// are referenced by sales.salesman_id, sales.delivery_by and
// recoveries.salesman_id, and an HR profile may point at one through
// hr_employees.master_employee_id.
//
// Status rules (product decision 2026-10-07):
//   - An Inactive person is never offered as a choice in a picker, and a write
//     cannot newly assign them.
//   - History is never hidden: no historical query filters on status.
//   - A value already saved on the record being edited may stay.

function getRoleCode(role) {
  const codes = { Salesman: 'SM', Supplier: 'SP' };
  return codes[role] || String(role || '').slice(0, 2).toUpperCase();
}

// Derived at read time from role + id, never stored: EMP-SM-003.
function makeEmployeeCode(role, id) {
  return `EMP-${getRoleCode(role)}-${String(id).padStart(3, '0')}`;
}

function attachEmployeeCode(row) {
  return { ...row, employee_code: makeEmployeeCode(row.role, row.id) };
}

function toEmployeeId(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Refuses an id that does not exist, or that is Inactive and not one of
// `keepIds` (the values the caller is allowed to keep as they are). Runs inside
// the caller's transaction with a shared lock, so a deactivation cannot commit
// between this check and the write that uses the id. Returns the normalised id
// (or null when none was given).
async function assertSelectableEmployee(conn, value, { label, keepIds = [] }) {
  const id = toEmployeeId(value);
  if (!id) return null;

  const [[row]] = await conn.query(
    'SELECT id, name, status FROM employees WHERE id = ? FOR SHARE', [id]
  );
  if (!row) {
    throw Object.assign(
      new Error(`The selected ${label} no longer exists. Choose another ${label}.`),
      { status: 422 }
    );
  }
  if (row.status === 'Inactive' && !keepIds.map(toEmployeeId).includes(id)) {
    throw Object.assign(
      new Error(`${row.name} is inactive. Choose an active ${label}.`),
      { status: 422, code: 'EMPLOYEE_INACTIVE' }
    );
  }
  return id;
}

const EMPLOYEE_STATUSES = ['Active', 'Inactive'];

// Sets one Master Data row's status inside the caller's transaction. Shared by
// PUT /employees/:id/status and by the HR sync (PUT /hr/employees/:id with
// sync_master), so both record deactivated_at / deactivated_by the same way.
// Returns null when the row does not exist; `changed` is false when the row
// already had that status (nothing is written).
async function setEmployeeStatus(conn, id, status, userId) {
  const [[row]] = await conn.query(
    'SELECT id, name, role, status FROM employees WHERE id = ? FOR UPDATE', [id]
  );
  if (!row) return null;
  if (row.status === status) return { ...attachEmployeeCode(row), changed: false };

  if (status === 'Inactive') {
    await conn.query(
      "UPDATE employees SET status = 'Inactive', deactivated_at = ?, deactivated_by = ? WHERE id = ?",
      [nowPKT(), userId || null, id]
    );
  } else {
    await conn.query(
      "UPDATE employees SET status = 'Active', deactivated_at = NULL, deactivated_by = NULL WHERE id = ?",
      [id]
    );
  }
  return { ...attachEmployeeCode({ ...row, status }), changed: true };
}

module.exports = {
  EMPLOYEE_STATUSES,
  setEmployeeStatus,
  makeEmployeeCode,
  attachEmployeeCode,
  toEmployeeId,
  assertSelectableEmployee,
};
