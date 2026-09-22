const db = require('../config/db');

// ─── Server-side module permission gate ────────────────────────────────────
// Historically the `perm_*` flags were client-side only (the Sidebar hides
// links, but a direct URL / curl reaches every route — see
// production-readiness.md P0-5). Workforce Management carries salaries, CNICs
// and bank accounts, so its routers enforce their flags here as well.
//
// The JWT payload is a snapshot taken at login and does NOT carry the
// permission flags, so they are read from `user_permissions` per request.
// These are low-traffic HR endpoints and `uq_user_permissions` makes the
// lookup a single index hit, so no cache is worth the staleness it buys.
//
// Status code: deliberately NOT 403. The client's axios interceptor treats
// 401 *and* 403 as "token dead" and hard-redirects to /login, so answering a
// permission denial with 403 would eject the user's whole session instead of
// showing them a message (production-readiness.md P0-7). 400 + a stable
// `code` keeps the session alive and lets the UI render real copy.
const PERMISSION_DENIED_STATUS = 400;

// Whitelist — the flag name is interpolated into the SELECT, so it can never
// come straight from a caller. Anything not listed here is a programming
// error and fails closed.
const KNOWN_FLAGS = new Set([
  'perm_hr_employees',
  'perm_hr_attendance',
  'perm_hr_payroll',
]);

function buildGate(flags, moduleLabel) {
  for (const flag of flags) {
    if (!KNOWN_FLAGS.has(flag)) {
      throw new Error(`requirePermission: unknown permission flag "${flag}"`);
    }
  }
  const label = moduleLabel || 'this module';
  const columns = flags.join(', ');

  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({ message: 'Access token required' });
      }
      // Admins bypass every module flag, exactly like AuthContext's `can()`.
      if (req.user.role === 'admin') return next();

      const [[row]] = await db.query(
        `SELECT ${columns} FROM user_permissions WHERE user_id = ?`,
        [req.user.id]
      );

      const allowed = !!row && flags.some(flag => !!row[flag]);
      if (!allowed) {
        return res.status(PERMISSION_DENIED_STATUS).json({
          code: 'PERMISSION_DENIED',
          message: `You do not have access to ${label}. Ask an administrator to enable it for your account.`,
        });
      }
      next();
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  };
}

function requirePermission(flag, moduleLabel) {
  return buildGate([flag], moduleLabel);
}

// Pass when the user holds ANY of the listed flags. Used for the HR employee
// roster: Attendance and Payroll both need to list employees to populate their
// pickers, but neither should require full access to HR profiles (which carry
// salaries, CNICs and bank details) to do it.
requirePermission.any = (flags, moduleLabel) => buildGate(flags, moduleLabel);

module.exports = requirePermission;
module.exports.PERMISSION_DENIED_STATUS = PERMISSION_DENIED_STATUS;
