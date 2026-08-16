const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');
const { logAudit } = require('../middleware/auditLog');

const VALID_TYPES = ['warranty', 'warranty10', 'non-warranty'];

// List every invoice currently sitting in the Print Queue (i.e. not yet
// printed / exported and removed).
router.get('/', auth, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT pq.id, pq.sale_id, pq.invoice_no, pq.pdf_name, pq.invoice_type, pq.is_selected,
             pq.created_at,
             DATE_FORMAT(s.date, '%Y-%m-%d') AS sale_date,
             s.total_amount, s.customer_id, c.name AS customer_name
      FROM print_queue pq
      JOIN sales s ON pq.sale_id = s.id
      JOIN customers c ON s.customer_id = c.id
      ORDER BY pq.created_at DESC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Save Draft — persist edits to file name / invoice type / selection state
// for any number of rows in one request.
router.put('/bulk', auth, async (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ message: 'No rows provided' });
  }
  for (const r of rows) {
    if (!r.id) return res.status(400).json({ message: 'Row id is required' });
    if (!r.pdf_name || !String(r.pdf_name).trim()) return res.status(400).json({ message: 'PDF file name cannot be empty' });
    if (!VALID_TYPES.includes(r.invoice_type)) return res.status(400).json({ message: 'Invalid invoice type' });
  }
  const conn = await db.getConnection();
  await conn.beginTransaction();
  try {
    for (const r of rows) {
      await conn.query(
        'UPDATE print_queue SET pdf_name=?, invoice_type=?, is_selected=? WHERE id=?',
        [String(r.pdf_name).trim(), r.invoice_type, r.is_selected ? 1 : 0, r.id]
      );
    }
    await conn.commit();
    await logAudit(req, 'UPDATE', 'print_queue', null, `Saved draft for ${rows.length} print queue item(s)`);
    res.json({ message: 'Print queue updated' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: err.message });
  } finally { conn.release(); }
});

// Remove several rows at once — called after a successful export / print run.
router.post('/remove-bulk', auth, async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ message: 'No ids provided' });
  }
  try {
    await db.query(`DELETE FROM print_queue WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    await logAudit(req, 'DELETE', 'print_queue', null, `Removed ${ids.length} item(s) from print queue`);
    res.json({ message: 'Removed from print queue' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Remove a single row (e.g. the user decides not to queue this invoice).
router.delete('/:id', auth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT invoice_no FROM print_queue WHERE id=?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Not found in print queue' });
    await db.query('DELETE FROM print_queue WHERE id=?', [req.params.id]);
    await logAudit(req, 'DELETE', 'print_queue', req.params.id, `Removed invoice ${rows[0].invoice_no} from print queue`);
    res.json({ message: 'Removed from print queue' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;