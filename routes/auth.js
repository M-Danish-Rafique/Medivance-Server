const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { logAudit } = require('../middleware/auditLog');

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ message: 'Username and password are required' });
    }

    const [rows] = await db.query('SELECT * FROM users WHERE username = ? AND is_active = 1', [username]);
    if (rows.length === 0) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const user = rows[0];
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Fetch permissions
    const [[perms]] = await db.query('SELECT * FROM user_permissions WHERE user_id=?', [user.id]);

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, full_name: user.full_name },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    // Audit login (respects logging enabled/disabled toggle)
    const { logAudit } = require('../middleware/auditLog');
    await logAudit(
      { user: { id: user.id, username: user.username }, headers: req.headers, socket: req.socket },
      'LOGIN', 'auth', null, `User "${user.username}" logged in`
    );

    res.json({
      token,
      user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role },
      permissions: perms || {}
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/auth/verify
router.get('/verify', require('../middleware/auth'), async (req, res) => {
  const [[perms]] = await db.query('SELECT * FROM user_permissions WHERE user_id=?', [req.user.id]);
  res.json({ valid: true, user: req.user, permissions: perms || {} });
});

module.exports = router;
