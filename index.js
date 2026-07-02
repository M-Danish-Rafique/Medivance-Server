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
    const [recent_sales] = await db.query(`SELECT s.invoice_no, s.date, s.total_amount, c.name as customer_name FROM sales s JOIN customers c ON s.customer_id=c.id ORDER BY s.date DESC LIMIT 5`);
    const [top_products] = await db.query(`SELECT p.name, SUM(si.qty) as total_qty FROM sale_items si JOIN products p ON si.product_id=p.id GROUP BY p.id, p.name ORDER BY total_qty DESC LIMIT 5`);

    res.json({
      monthly_sales: parseFloat(monthly_sales),
      monthly_purchases: parseFloat(monthly_purchases),
      today_sale: parseFloat(today_sale),
      today_recovery: parseFloat(today_recovery),
      total_receivable: parseFloat(total_receivable),
      total_payable: parseFloat(total_payable),
      low_stock_count: low_stock[0].cnt,
      pending_tax: parseFloat(pending_tax),
      recent_sales,
      top_products
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
