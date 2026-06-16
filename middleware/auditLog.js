const db = require('../config/db');

/**
 * Returns the current time as a MySQL DATETIME string in Pakistan Standard
 * Time (PKT, UTC+5, no DST), regardless of the server's local timezone.
 */
function nowPKT() {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000; // shift to true UTC
  const pkt = new Date(utcMs + 5 * 60 * 60 * 1000); // PKT = UTC+5
  return pkt.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Check whether audit logging is currently enabled (master switch).
 * Cached briefly to avoid hitting the DB on every single request.
 */
let _cache = { value: true, ts: 0 };
async function isLoggingEnabled() {
  const now = Date.now();
  if (now - _cache.ts < 5000) return _cache.value; // 5s cache
  try {
    const [[policy]] = await db.query('SELECT logging_enabled FROM log_rotation_policy WHERE id=1');
    _cache = { value: policy ? !!policy.logging_enabled : true, ts: now };
  } catch (e) {
    _cache = { value: true, ts: now };
  }
  return _cache.value;
}

/**
 * Write an audit log entry.
 * Can be called from any route: await logAudit(req, 'CREATE', 'sale', saleId, 'Created invoice S26-00001')
 */
async function logAudit(req, action, module, recordId = null, description = null, force = false) {
  if (req) req._auditLogged = true; // prevent generic middleware from double-logging
  try {
    if (!force && !(await isLoggingEnabled())) return;
    const userId = req?.user?.id || null;
    const username = req?.user?.username || 'system';
    const ip = req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req?.socket?.remoteAddress || null;
    await db.query(
      `INSERT INTO audit_logs (user_id, username, action, module, record_id, description, ip_address, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [userId, username, action, module, recordId ? String(recordId) : null, description, ip, nowPKT()]
    );
  } catch (e) {
    // Never let logging crash the request
    console.error('[AuditLog] Failed to write log:', e.message);
  }
}

/**
 * Express middleware factory.
 * Usage: router.post('/', auth, auditMiddleware('sale', 'CREATE'), handler)
 * Runs AFTER the handler by hooking res.json to capture the response.
 */
function auditMiddleware(module, action, getDesc = null) {
  return (req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      const statusOk = res.statusCode >= 200 && res.statusCode < 300;
      if (statusOk) {
        const recordId = body?.id || body?.invoice_no || req.params?.id || null;
        const desc = getDesc ? getDesc(req, body) : `${action} ${module}${recordId ? ` [${recordId}]` : ''}`;
        logAudit(req, action, module, recordId, desc);
      }
      return originalJson(body);
    };
    next();
  };
}

/**
 * Generic catch-all audit logger, mounted at the app level.
 * Logs any mutating request (POST/PUT/PATCH/DELETE) that succeeded and
 * wasn't already logged explicitly via logAudit() inside its route handler.
 */
function genericAuditMiddleware() {
  return (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode >= 200 && res.statusCode < 300 && !req._auditLogged && req.user) {
        const parts = req.path.split('/').filter(Boolean); // e.g. ['api','manufacturing','batches','5']
        let module = parts[1] || 'unknown';
        let recordIdFromPath = null;
        if (module === 'manufacturing' || module === 'admin') {
          module = `${module}/${parts[2] || ''}`.replace(/\/$/, '');
          recordIdFromPath = parts[3];
        } else {
          recordIdFromPath = parts[2];
        }
        const action = req.method === 'POST' ? 'CREATE' : req.method === 'DELETE' ? 'DELETE' : 'UPDATE';
        const recordId = body?.id || body?.invoice_no || recordIdFromPath || null;
        const description = `${action} ${module}${recordId ? ` [${recordId}]` : ''} (${req.method} ${req.originalUrl})`;
        logAudit(req, action, module, recordId, description);
      }
      return originalJson(body);
    };
    next();
  };
}

/**
 * Run log rotation: delete entries older than retention_days.
 * Called by the /api/admin/logs/rotate endpoint.
 */
async function rotateLogsIfDue() {
  try {
    const [[policy]] = await db.query('SELECT * FROM log_rotation_policy WHERE id=1');
    if (!policy || !policy.auto_rotate_enabled) return { deleted: 0, skipped: true };
    const days = parseInt(policy.retention_days) || 90;
    const [result] = await db.query(
      'DELETE FROM audit_logs WHERE created_at < DATE_SUB(?, INTERVAL ? DAY)',
      [nowPKT(), days]
    );
    await db.query('UPDATE log_rotation_policy SET last_rotated_at=? WHERE id=1', [nowPKT()]);
    return { deleted: result.affectedRows, days };
  } catch (e) {
    console.error('[LogRotation]', e.message);
    return { deleted: 0, error: e.message };
  }
}

function invalidateLoggingCache() {
  _cache = { value: true, ts: 0 };
}

module.exports = { logAudit, auditMiddleware, genericAuditMiddleware, rotateLogsIfDue, nowPKT, invalidateLoggingCache };
