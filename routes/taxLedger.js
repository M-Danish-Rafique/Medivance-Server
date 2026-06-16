const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');

// Get tax ledger with filters
router.get('/', auth, async (req, res) => {
  try {
    const { from_date, to_date, submitted } = req.query;
    let sql = `
      SELECT tl.*, p.name as product_name, p.sale_tax_pct,
             s.invoice_no, c.name as customer_name
      FROM tax_ledger tl
      JOIN products p ON tl.product_id=p.id
      LEFT JOIN sales s ON tl.sale_id=s.id
      LEFT JOIN customers c ON s.customer_id=c.id
      WHERE 1=1
    `;
    const params = [];
    if (from_date) { sql += ' AND tl.sale_date >= ?'; params.push(from_date); }
    if (to_date) { sql += ' AND tl.sale_date <= ?'; params.push(to_date); }
    if (submitted === '0') { sql += ' AND tl.submitted_to_fbr = 0'; }
    if (submitted === '1') { sql += ' AND tl.submitted_to_fbr = 1'; }
    sql += ' ORDER BY tl.sale_date DESC, tl.id DESC';

    const [rows] = await db.query(sql, params);

    // Summary
    const totalTaxable = rows.reduce((s, r) => s + parseFloat(r.taxable_amount || 0), 0);
    const totalTax = rows.reduce((s, r) => s + parseFloat(r.tax_amount || 0), 0);
    const pendingTax = rows.filter(r => !r.submitted_to_fbr).reduce((s, r) => s + parseFloat(r.tax_amount || 0), 0);

    res.json({ rows, summary: { totalTaxable, totalTax, pendingTax, count: rows.length } });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Mark as submitted to FBR
router.post('/submit-fbr', auth, async (req, res) => {
  try {
    const { ids, submission_date } = req.body;
    if (!ids || !ids.length) return res.status(400).json({ message: 'No IDs provided' });
    await db.query(
      'UPDATE tax_ledger SET submitted_to_fbr=1, fbr_submission_date=? WHERE id IN (?)',
      [submission_date || new Date().toISOString().split('T')[0], ids]
    );
    res.json({ message: `${ids.length} records marked as submitted` });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// FBR PDF report (returns data for frontend to render)
router.get('/report', auth, async (req, res) => {
  try {
    const { from_date, to_date } = req.query;
    const params = [];
    let where = 'WHERE 1=1';
    if (from_date) { where += ' AND tl.sale_date >= ?'; params.push(from_date); }
    if (to_date) { where += ' AND tl.sale_date <= ?'; params.push(to_date); }

    const [rows] = await db.query(`
      SELECT tl.*, p.name as product_name, p.sale_tax_pct,
             s.invoice_no, c.name as customer_name
      FROM tax_ledger tl
      JOIN products p ON tl.product_id=p.id
      LEFT JOIN sales s ON tl.sale_id=s.id
      LEFT JOIN customers c ON s.customer_id=c.id
      ${where}
      ORDER BY tl.sale_date ASC
    `, params);

    // Group by product
    const byProduct = {};
    for (const r of rows) {
      if (!byProduct[r.product_id]) {
        byProduct[r.product_id] = { product_name: r.product_name, tax_rate: r.tax_rate, taxable: 0, tax: 0, rows: [] };
      }
      byProduct[r.product_id].taxable += parseFloat(r.taxable_amount);
      byProduct[r.product_id].tax += parseFloat(r.tax_amount);
      byProduct[r.product_id].rows.push(r);
    }

    res.json({
      from_date, to_date,
      rows,
      by_product: Object.values(byProduct),
      totals: {
        taxable: rows.reduce((s, r) => s + parseFloat(r.taxable_amount || 0), 0),
        tax: rows.reduce((s, r) => s + parseFloat(r.tax_amount || 0), 0),
      }
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
