const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();
const db = require('./config/db');
const { genericAuditMiddleware } = require('./middleware/auditLog');
const { corsOptions } = require('./config/cors');
const { getPublicDir } = require('./utils/paths');

const app = express();
app.use(cors(corsOptions()));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));


// Serve public assets (logos for PDF generation)
const publicDir = getPublicDir();
app.use(express.static(publicDir));
app.get('/logo-light.png', (_req, res) => {
  res.sendFile(path.join(publicDir, 'logo-light.png'));
});
app.get('/logo-dark.png', (_req, res) => {
  res.sendFile(path.join(publicDir, 'logo-dark.png'));
});

// Catch-all audit logger for any mutating request not already logged explicitly
app.use(genericAuditMiddleware());

app.use('/api/auth', require('./routes/auth'));
app.use('/api/companies', require('./routes/companies'));
app.use('/api/products', require('./routes/products'));
app.use('/api/employees', require('./routes/employees'));
app.use('/api/geography', require('./routes/geography'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/suppliers', require('./routes/suppliers'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/purchases', require('./routes/purchases'));
app.use('/api/sales', require('./routes/sales'));
app.use('/api/print-queue', require('./routes/printQueue'));
app.use('/api/finance', require('./routes/finance'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/recoveries', require('./routes/recoveries'));
app.use('/api/raw-materials', require('./routes/rawMaterials'));
app.use('/api/manufacturing', require('./routes/manufacturing'));
app.use('/api/tax-ledger', require('./routes/taxLedger'));
app.use('/api/admin', require('./routes/admin'));

app.get('/api/dashboard', require('./middleware/auth'), async (req, res) => {
  try {
    const db = require('./config/db');
    const [[{ monthly_sales }]] = await db.query("SELECT COALESCE(SUM(total_amount),0) as monthly_sales FROM sales WHERE MONTH(date)=MONTH(CURDATE()) AND YEAR(date)=YEAR(CURDATE())");
    const [[{ monthly_purchases }]] = await db.query("SELECT COALESCE(SUM(total_amount),0) as monthly_purchases FROM purchases WHERE MONTH(date)=MONTH(CURDATE()) AND YEAR(date)=YEAR(CURDATE())");
    const [[{ today_sale }]] = await db.query("SELECT COALESCE(SUM(total_amount),0) as today_sale FROM sales WHERE date=CURDATE()");
    const [[{ today_recovery }]] = await db.query("SELECT COALESCE(SUM(net_collected),0) as today_recovery FROM recoveries WHERE date=CURDATE()");
    const [[{ total_receivable }]] = await db.query("SELECT COALESCE(SUM(balance),0) as total_receivable FROM customers WHERE balance > 0");
    const [[{ total_payable }]] = await db.query("SELECT COALESCE(SUM(balance),0) as total_payable FROM suppliers WHERE balance > 0");
    const [low_stock] = await db.query('SELECT COUNT(*) as cnt FROM inventory WHERE qty <= low_stock_threshold AND qty > 0');
    const [[{ pending_tax }]] = await db.query('SELECT COALESCE(SUM(tax_amount),0) as pending_tax FROM tax_ledger WHERE submitted_to_fbr=0');
    // Inventory position — stock valued at cost (asset) and at sale rate
    // (estimated retail). Gross profit derived client-side to avoid a
    // divide-by-zero on an empty warehouse.
    const [[inv_totals]] = await db.query(`
      SELECT COALESCE(SUM(qty * purchase_rate), 0) AS inventory_asset_value,
             COALESCE(SUM(qty * sale_rate),     0) AS estimated_retail_value
        FROM inventory
    `);
    // Top 5 products by units sold. Gross profit contribution uses the
    // frozen cost basis on each line (`purchase_rate_snapshot`) so the
    // number matches the Profit report exactly, even when inventory rates
    // have drifted since the sale.
    const [top_products] = await db.query(`
      SELECT p.name,
             SUM(si.qty) AS total_qty,
             SUM(
               si.total - si.recovery_discount - COALESCE(ret.ret_amt, 0)
               - (COALESCE(si.qty, 0) + COALESCE(si.bonus, 0) - COALESCE(si.returned_qty, 0))
                 * COALESCE(si.purchase_rate_snapshot, 0)
             ) AS gross_profit
        FROM sale_items si
        JOIN products p ON si.product_id = p.id
        LEFT JOIN (
          SELECT sale_item_id, SUM(COALESCE(return_amount, 0)) AS ret_amt
            FROM return_items
           GROUP BY sale_item_id
        ) ret ON ret.sale_item_id = si.id
       GROUP BY p.id, p.name
       ORDER BY total_qty DESC
       LIMIT 5
    `);
    // Rolling 12-month sales / purchases trajectory for the dual-axis chart.
    // Both series are aggregated separately then merged onto a month spine
    // in JS so gaps render as 0 instead of leaving holes in the timeline.
    const [salesByMonth] = await db.query(`
      SELECT DATE_FORMAT(date, '%Y-%m') AS month,
             COALESCE(SUM(total_amount), 0) AS amount
        FROM sales
       WHERE date >= DATE_SUB(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 11 MONTH)
       GROUP BY month
    `);
    const [purchasesByMonth] = await db.query(`
      SELECT DATE_FORMAT(date, '%Y-%m') AS month,
             COALESCE(SUM(total_amount), 0) AS amount
        FROM purchases
       WHERE date >= DATE_SUB(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 11 MONTH)
       GROUP BY month
    `);
    const salesMap    = new Map(salesByMonth.map(r    => [r.month, parseFloat(r.amount)]));
    const purchaseMap = new Map(purchasesByMonth.map(r => [r.month, parseFloat(r.amount)]));
    const trajectory = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      trajectory.push({
        month:     key,
        sales:     salesMap.get(key)    || 0,
        purchases: purchaseMap.get(key) || 0,
      });
    }

    res.json({
      monthly_sales: parseFloat(monthly_sales),
      monthly_purchases: parseFloat(monthly_purchases),
      today_sale: parseFloat(today_sale),
      today_recovery: parseFloat(today_recovery),
      total_receivable: parseFloat(total_receivable),
      total_payable: parseFloat(total_payable),
      low_stock_count: low_stock[0].cnt,
      pending_tax: parseFloat(pending_tax),
      inventory_asset_value:  parseFloat(inv_totals.inventory_asset_value),
      estimated_retail_value: parseFloat(inv_totals.estimated_retail_value),
      estimated_gross_profit: parseFloat(inv_totals.estimated_retail_value) - parseFloat(inv_totals.inventory_asset_value),
      top_products,
      trajectory,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

app.get('/api/health', (req, res) => res.json({
  status: 'ok',
  app: 'Medivance',
  env: process.env.NODE_ENV || 'development',
}));

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Medivance Server running on port ${PORT}`);
});
