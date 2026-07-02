const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const auth = require('../middleware/auth');
const { logAudit, rotateLogsIfDue, invalidateLoggingCache } = require('../middleware/auditLog');

// ── Admin-only guard ──────────────────────────────────────────────────────────
function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ message: 'Admin access required' });
  next();
}

// ════════════════════════════════════════════════════════
// COMPANY SETTINGS
// ════════════════════════════════════════════════════════

// Public — company branding (name/logo) is needed on the login screen too
router.get('/company', async (req, res) => {
  try {
    const [[row]] = await db.query('SELECT * FROM company_settings WHERE id=1');
    res.json(row || {});
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.put('/company', auth, adminOnly, async (req, res) => {
  try {
    const { name, address, phone, email, logo_url } = req.body;
    await db.query(
      `INSERT INTO company_settings (id, name, address, phone, email, logo_url) VALUES (1,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE name=VALUES(name), address=VALUES(address),
         phone=VALUES(phone), email=VALUES(email), logo_url=VALUES(logo_url)`,
      [name, address || null, phone || null, email || null, logo_url || null]
    );
    await logAudit(req, 'UPDATE', 'company_settings', 1, `Updated company details to "${name}"`);
    const [[updated]] = await db.query('SELECT * FROM company_settings WHERE id=1');
    res.json(updated);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ════════════════════════════════════════════════════════
// USER MANAGEMENT
// ════════════════════════════════════════════════════════

router.get('/users', auth, adminOnly, async (req, res) => {
  try {
    const [users] = await db.query(`
      SELECT u.id, u.username, u.full_name, u.role, u.is_active, u.created_at,
             up.perm_companies, up.perm_products, up.perm_employees, up.perm_geography,
             up.perm_customers, up.perm_suppliers,
             up.perm_purchase, up.perm_view_purchase_rate, up.perm_sale, up.perm_inventory, up.perm_recovery,
             up.perm_mfg_products, up.perm_mfg_raw_materials, up.perm_mfg_batches, up.perm_mfg_yields,
             up.perm_finance, up.perm_reports, up.perm_tax_ledger
      FROM users u
      LEFT JOIN user_permissions up ON u.id = up.user_id
      ORDER BY u.id ASC
    `);
    res.json(users);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/users', auth, adminOnly, async (req, res) => {
  const conn = await db.getConnection();
  await conn.beginTransaction();
  try {
    const { username, password, full_name, permissions = {} } = req.body;
    if (!username || !password || !full_name)
      return res.status(400).json({ message: 'username, password, and full_name are required' });

    const [existing] = await conn.query('SELECT id FROM users WHERE username=?', [username]);
    if (existing.length) return res.status(400).json({ message: 'Username already taken' });

    const hash = await bcrypt.hash(password, 10);
    const [result] = await conn.query(
      'INSERT INTO users (username, password, full_name, role, is_active) VALUES (?,?,?,?,1)',
      [username, hash, full_name, 'user']
    );
    const userId = result.insertId;

    await conn.query(
      `INSERT INTO user_permissions (user_id,
         perm_companies, perm_products, perm_employees, perm_geography, perm_customers, perm_suppliers,
         perm_purchase, perm_view_purchase_rate, perm_sale, perm_inventory, perm_recovery,
         perm_mfg_products, perm_mfg_raw_materials, perm_mfg_batches, perm_mfg_yields,
         perm_finance, perm_reports, perm_tax_ledger)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [userId,
        permissions.perm_companies ? 1 : 0, permissions.perm_products ? 1 : 0,
        permissions.perm_employees ? 1 : 0, permissions.perm_geography ? 1 : 0,
        permissions.perm_customers ? 1 : 0, permissions.perm_suppliers ? 1 : 0,
        permissions.perm_purchase ? 1 : 0, permissions.perm_view_purchase_rate ? 1 : 0,
        permissions.perm_sale ? 1 : 0, permissions.perm_inventory ? 1 : 0, permissions.perm_recovery ? 1 : 0,
        permissions.perm_mfg_products ? 1 : 0, permissions.perm_mfg_raw_materials ? 1 : 0,
        permissions.perm_mfg_batches ? 1 : 0, permissions.perm_mfg_yields ? 1 : 0,
        permissions.perm_finance ? 1 : 0, permissions.perm_reports ? 1 : 0,
        permissions.perm_tax_ledger ? 1 : 0
      ]
    );

    await conn.commit();
    await logAudit(req, 'CREATE', 'users', userId, `Created user "${username}" (${full_name})`);
    res.status(201).json({ id: userId, username, full_name, role: 'user' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: err.message });
  } finally { conn.release(); }
});

router.put('/users/:id', auth, adminOnly, async (req, res) => {
  const conn = await db.getConnection();
  await conn.beginTransaction();
  try {
    const uid = req.params.id;
    const { full_name, password, is_active, permissions = {} } = req.body;

    const [existing] = await conn.query('SELECT * FROM users WHERE id=?', [uid]);
    if (!existing.length) return res.status(404).json({ message: 'User not found' });

    // Prevent disabling self
    if (parseInt(uid) === req.user.id && is_active === 0)
      return res.status(400).json({ message: 'Cannot deactivate your own account' });

    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await conn.query('UPDATE users SET full_name=?, password=?, is_active=? WHERE id=?',
        [full_name, hash, is_active ?? 1, uid]);
    } else {
      await conn.query('UPDATE users SET full_name=?, is_active=? WHERE id=?',
        [full_name, is_active ?? 1, uid]);
    }

    await conn.query(
      `INSERT INTO user_permissions (user_id,
         perm_companies, perm_products, perm_employees, perm_geography, perm_customers, perm_suppliers,
         perm_purchase, perm_view_purchase_rate, perm_sale, perm_inventory, perm_recovery,
         perm_mfg_products, perm_mfg_raw_materials, perm_mfg_batches, perm_mfg_yields,
         perm_finance, perm_reports, perm_tax_ledger)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         perm_companies=VALUES(perm_companies), perm_products=VALUES(perm_products),
         perm_employees=VALUES(perm_employees), perm_geography=VALUES(perm_geography),
         perm_customers=VALUES(perm_customers), perm_suppliers=VALUES(perm_suppliers),
         perm_purchase=VALUES(perm_purchase), perm_view_purchase_rate=VALUES(perm_view_purchase_rate), perm_sale=VALUES(perm_sale),
         perm_inventory=VALUES(perm_inventory), perm_recovery=VALUES(perm_recovery),
         perm_mfg_products=VALUES(perm_mfg_products), perm_mfg_raw_materials=VALUES(perm_mfg_raw_materials),
         perm_mfg_batches=VALUES(perm_mfg_batches), perm_mfg_yields=VALUES(perm_mfg_yields),
         perm_finance=VALUES(perm_finance), perm_reports=VALUES(perm_reports),
         perm_tax_ledger=VALUES(perm_tax_ledger)`,
      [uid,
        permissions.perm_companies ? 1 : 0, permissions.perm_products ? 1 : 0,
        permissions.perm_employees ? 1 : 0, permissions.perm_geography ? 1 : 0,
        permissions.perm_customers ? 1 : 0, permissions.perm_suppliers ? 1 : 0,
        permissions.perm_purchase ? 1 : 0, permissions.perm_view_purchase_rate ? 1 : 0,
        permissions.perm_sale ? 1 : 0, permissions.perm_inventory ? 1 : 0, permissions.perm_recovery ? 1 : 0,
        permissions.perm_mfg_products ? 1 : 0, permissions.perm_mfg_raw_materials ? 1 : 0,
        permissions.perm_mfg_batches ? 1 : 0, permissions.perm_mfg_yields ? 1 : 0,
        permissions.perm_finance ? 1 : 0, permissions.perm_reports ? 1 : 0,
        permissions.perm_tax_ledger ? 1 : 0
      ]
    );

    await conn.commit();
    await logAudit(req, 'UPDATE', 'users', uid, `Updated user ID ${uid} "${full_name}"`);
    res.json({ message: 'User updated' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: err.message });
  } finally { conn.release(); }
});

router.delete('/users/:id', auth, adminOnly, async (req, res) => {
  try {
    const uid = req.params.id;
    if (parseInt(uid) === req.user.id)
      return res.status(400).json({ message: 'Cannot delete your own account' });
    const [rows] = await db.query('SELECT username FROM users WHERE id=?', [uid]);
    if (!rows.length) return res.status(404).json({ message: 'User not found' });
    await db.query('DELETE FROM users WHERE id=?', [uid]);
    await logAudit(req, 'DELETE', 'users', uid, `Deleted user "${rows[0].username}"`);
    res.json({ message: 'User deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ════════════════════════════════════════════════════════
// AUDIT LOGS
// ════════════════════════════════════════════════════════

router.get('/logs', auth, adminOnly, async (req, res) => {
  try {
    const { user_id, module, action, from, to, page = 1, limit = 50 } = req.query;
    const conditions = [];
    const params = [];
    if (user_id) { conditions.push('user_id=?'); params.push(user_id); }
    if (module)  { conditions.push('module=?');  params.push(module); }
    if (action)  { conditions.push('action=?');  params.push(action); }
    if (from)    { conditions.push('created_at >= ?'); params.push(from); }
    if (to)      { conditions.push('created_at <= ?'); params.push(to + ' 23:59:59'); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const [[{ total }]] = await db.query(`SELECT COUNT(*) as total FROM audit_logs ${where}`, params);
    const [rows] = await db.query(
      `SELECT id, user_id, username, action, module, record_id, description, ip_address,
              DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') as created_at
       FROM audit_logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );
    res.json({ total, page: parseInt(page), limit: parseInt(limit), rows });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/logs/policy', auth, adminOnly, async (req, res) => {
  try {
    const [[row]] = await db.query(
      `SELECT id, logging_enabled, retention_days, auto_rotate_enabled,
              DATE_FORMAT(last_rotated_at, '%Y-%m-%d %H:%i:%s') as last_rotated_at
       FROM log_rotation_policy WHERE id=1`);
    res.json(row || { logging_enabled: 1, retention_days: 90, auto_rotate_enabled: 1 });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.put('/logs/policy', auth, adminOnly, async (req, res) => {
  try {
    const { logging_enabled, retention_days, auto_rotate_enabled } = req.body;
    await db.query(
      `INSERT INTO log_rotation_policy (id, logging_enabled, retention_days, auto_rotate_enabled) VALUES (1,?,?,?)
       ON DUPLICATE KEY UPDATE logging_enabled=VALUES(logging_enabled), retention_days=VALUES(retention_days), auto_rotate_enabled=VALUES(auto_rotate_enabled)`,
      [logging_enabled ? 1 : 0, parseInt(retention_days) || 90, auto_rotate_enabled ? 1 : 0]
    );
    invalidateLoggingCache();
    await logAudit(req, 'UPDATE', 'log_policy', 1,
      `Set logging ${logging_enabled ? 'ENABLED' : 'DISABLED'}, retention to ${retention_days} days`, true);
    res.json({ message: 'Policy updated' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/logs/rotate', auth, adminOnly, async (req, res) => {
  try {
    const result = await rotateLogsIfDue();
    await logAudit(req, 'ROTATE', 'audit_logs', null, `Manual log rotation: deleted ${result.deleted} entries`);
    res.json(result);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
