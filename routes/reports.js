const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');
const PDFDocument = require('pdfkit');
const {
  drawPdfLogo, stampPdfFootersOnAllPages, getPdfContentBottom,
  ensureSpace, buildPdfColumns, drawReportHeader, drawFilterBox,
} = require('../utils/pdfHelpers');

// Supplier Ledger
router.get('/supplier-ledger', auth, async (req, res) => {
  try {
    const { supplier_id, from_date, to_date } = req.query;
    if (!supplier_id) return res.status(400).json({ message: 'Supplier ID required' });

    const [supplier] = await db.query('SELECT * FROM suppliers WHERE id=?', [supplier_id]);
    if (supplier.length === 0) return res.status(404).json({ message: 'Supplier not found' });

    let sql = 'SELECT * FROM supplier_ledger WHERE supplier_id=?';
    const params = [supplier_id];
    if (from_date) { sql += ' AND date >= ?'; params.push(from_date); }
    if (to_date) { sql += ' AND date <= ?'; params.push(to_date); }
    sql += ' ORDER BY date ASC, id ASC';

    const [ledger] = await db.query(sql, params);

    // Opening balance (before from_date)
    let openingBalance = 0;
    if (from_date) {
      const [ob] = await db.query(
        'SELECT COALESCE(SUM(dr)-SUM(cr),0) as ob FROM supplier_ledger WHERE supplier_id=? AND date < ?',
        [supplier_id, from_date]
      );
      openingBalance = parseFloat(ob[0].ob) || 0;
    }

    res.json({ supplier: supplier[0], ledger, openingBalance });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Customer Ledger
router.get('/customer-ledger', auth, async (req, res) => {
  try {
    const { customer_id, from_date, to_date } = req.query;
    if (!customer_id) return res.status(400).json({ message: 'Customer ID required' });

    const [customer] = await db.query(`
      SELECT cu.*, ci.name as city_name, a.name as area_name, t.name as territory_name
      FROM customers cu
      LEFT JOIN cities ci ON cu.city_id=ci.id
      LEFT JOIN areas a ON cu.area_id=a.id
      LEFT JOIN territories t ON cu.territory_id=t.id
      WHERE cu.id=?`, [customer_id]);
    if (customer.length === 0) return res.status(404).json({ message: 'Customer not found' });

    let sql = 'SELECT * FROM customer_ledger WHERE customer_id=?';
    const params = [customer_id];
    if (from_date) { sql += ' AND date >= ?'; params.push(from_date); }
    if (to_date) { sql += ' AND date <= ?'; params.push(to_date); }
    sql += ' ORDER BY date ASC, id ASC';

    const [ledger] = await db.query(sql, params);

    let openingBalance = 0;
    if (from_date) {
      const [ob] = await db.query(
        'SELECT COALESCE(SUM(dr)-SUM(cr),0) as ob FROM customer_ledger WHERE customer_id=? AND date < ?',
        [customer_id, from_date]
      );
      openingBalance = parseFloat(ob[0].ob) || 0;
    }

    res.json({ customer: customer[0], ledger, openingBalance });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// PDF: Supplier Ledger
router.get('/supplier-ledger/pdf', auth, async (req, res) => {
  try {
    const { supplier_id, from_date, to_date } = req.query;
    const [supplier] = await db.query('SELECT * FROM suppliers WHERE id=?', [supplier_id]);
    if (supplier.length === 0) return res.status(404).json({ message: 'Not found' });

    let sql = 'SELECT * FROM supplier_ledger WHERE supplier_id=?';
    const params = [supplier_id];
    if (from_date) { sql += ' AND date >= ?'; params.push(from_date); }
    if (to_date) { sql += ' AND date <= ?'; params.push(to_date); }
    sql += ' ORDER BY date ASC, id ASC';
    const [ledger] = await db.query(sql, params);

    let openingBalance = 0;
    if (from_date) {
      const [ob] = await db.query(
        'SELECT COALESCE(SUM(dr)-SUM(cr),0) as ob FROM supplier_ledger WHERE supplier_id=? AND date < ?',
        [supplier_id, from_date]
      );
      openingBalance = parseFloat(ob[0].ob) || 0;
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="supplier-ledger-${supplier_id}.pdf"`);

    const [[companySettings]] = await db.query('SELECT * FROM company_settings WHERE id=1');

    generateLedgerPDF(res, {
      type: 'Supplier',
      entity: supplier[0],
      ledger,
      openingBalance,
      from_date,
      to_date,
      company: companySettings
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// PDF: Customer Ledger
router.get('/customer-ledger/pdf', auth, async (req, res) => {
  try {
    const { customer_id, from_date, to_date } = req.query;
    const [customer] = await db.query(`
      SELECT cu.*, ci.name as city_name FROM customers cu
      LEFT JOIN cities ci ON cu.city_id=ci.id WHERE cu.id=?`, [customer_id]);
    if (customer.length === 0) return res.status(404).json({ message: 'Not found' });

    let sql = 'SELECT * FROM customer_ledger WHERE customer_id=?';
    const params = [customer_id];
    if (from_date) { sql += ' AND date >= ?'; params.push(from_date); }
    if (to_date) { sql += ' AND date <= ?'; params.push(to_date); }
    sql += ' ORDER BY date ASC, id ASC';
    const [ledger] = await db.query(sql, params);

    let openingBalance = 0;
    if (from_date) {
      const [ob] = await db.query(
        'SELECT COALESCE(SUM(dr)-SUM(cr),0) as ob FROM customer_ledger WHERE customer_id=? AND date < ?',
        [customer_id, from_date]
      );
      openingBalance = parseFloat(ob[0].ob) || 0;
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="customer-ledger-${customer_id}.pdf"`);

    const [[companySettings]] = await db.query('SELECT * FROM company_settings WHERE id=1');

    generateLedgerPDF(res, {
      type: 'Customer',
      entity: customer[0],
      ledger,
      openingBalance,
      from_date,
      to_date,
      company: companySettings
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

function generateLedgerPDF(res, { type, entity, ledger, openingBalance, from_date, to_date, company }) {
  const doc = new PDFDocument({ margin: 40, size: 'A4', bufferPages: true });
  doc.pipe(res);

  const companyName = company?.name || 'Medivance';
  const companyAddress = company?.address || '';
  const companyContact = [company?.phone, company?.email].filter(Boolean).join('   |   ');

  const pageWidth = doc.page.width;
  const left = 40, right = pageWidth - 40;
  const contentWidth = right - left;

  // ── Header ──────────────────────────────────────────────────────────────
  doc.fillColor('#000');
  const logoOffset = drawPdfLogo(doc, left, 38, 42);
  const headerTextX = left + logoOffset;
  const headerTextWidth = contentWidth * 0.62 - logoOffset;

  doc.font('Helvetica-Bold').fontSize(18).text(companyName, headerTextX, 40, { width: headerTextWidth });
  let headerY = doc.y + 2;
  if (companyAddress) { doc.font('Helvetica').fontSize(8.5).text(companyAddress, headerTextX, headerY, { width: headerTextWidth }); headerY = doc.y + 1; }
  if (companyContact) { doc.font('Helvetica').fontSize(8.5).text(companyContact, headerTextX, headerY, { width: headerTextWidth }); headerY = doc.y; }

  doc.font('Helvetica-Bold').fontSize(15).text('LEDGER STATEMENT', left, 40, { width: contentWidth, align: 'right', lineBreak: false });
  doc.font('Helvetica').fontSize(9).text(`${type} Account`, left, doc.y + 2, { width: contentWidth, align: 'right', lineBreak: false });
  doc.font('Helvetica').fontSize(8).text(`Generated: ${new Date().toLocaleDateString('en-GB')}`, left, doc.y + 2, { width: contentWidth, align: 'right', lineBreak: false });
  doc.fillColor('#000');

  let y = Math.max(headerY, doc.y) + 14;

  // ── Entity details box ────────────────────────────────────────────────
  const boxTop = y;
  doc.font('Helvetica-Bold').fontSize(10).text(entity.name, left + 10, y + 8);
  let ey = doc.y + 4;
  if (entity.address) { doc.font('Helvetica').fontSize(8.5).text(entity.address, left + 10, ey, { width: contentWidth * 0.6 }); ey = doc.y + 2; }
  const metaParts = [];
  if (entity.phone) metaParts.push(`Phone: ${entity.phone}`);
  if (entity.license_no) metaParts.push(`License No: ${entity.license_no}`);
  if (entity.city_name) metaParts.push(`City: ${entity.city_name}`);
  if (metaParts.length) { doc.font('Helvetica').fontSize(8.5).text(metaParts.join('    '), left + 10, ey, { width: contentWidth * 0.85 }); ey = doc.y; }
  const boxHeight = Math.max(50, ey - boxTop + 8);
  doc.rect(left, boxTop, contentWidth, boxHeight).stroke('#000');

  y = boxTop + boxHeight + 10;

  if (from_date || to_date) {
    doc.font('Helvetica').fontSize(8.5)
      .text(`Statement Period: ${from_date || 'Beginning'}  to  ${to_date || 'Present'}`, left, y);
    y = doc.y + 8;
  }

  // ── Table column layout ───────────────────────────────────────────────
  const cols = {
    date:    { x: left,       w: 65,  align: 'left'  },
    invoice: { x: left + 65,  w: 90,  align: 'left'  },
    desc:    { x: left + 155, w: contentWidth - 155 - 70 - 60 - 70, align: 'left' },
    dr:      { x: 0, w: 70, align: 'right' },
    cr:      { x: 0, w: 60, align: 'right' },
    balance: { x: 0, w: 70, align: 'right' },
  };
  cols.dr.x = cols.desc.x + cols.desc.w;
  cols.cr.x = cols.dr.x + cols.dr.w;
  cols.balance.x = cols.cr.x + cols.cr.w;

  const rowHeight = 18;
  const headerHeight = 20;

  function drawTableHeader(yy) {
    doc.moveTo(left, yy).lineTo(right, yy).lineWidth(1).strokeColor('#000').stroke();
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#000');
    doc.text('Date', cols.date.x, yy + 5, { width: cols.date.w });
    doc.text('Invoice No', cols.invoice.x, yy + 5, { width: cols.invoice.w });
    doc.text('Description', cols.desc.x, yy + 5, { width: cols.desc.w });
    doc.text('Debit', cols.dr.x, yy + 5, { width: cols.dr.w - 6, align: 'right' });
    doc.text('Credit', cols.cr.x, yy + 5, { width: cols.cr.w - 6, align: 'right' });
    doc.text('Balance', cols.balance.x, yy + 5, { width: cols.balance.w - 4, align: 'right' });
    doc.moveTo(left, yy + headerHeight).lineTo(right, yy + headerHeight).lineWidth(1).strokeColor('#000').stroke();
    return yy + headerHeight;
  }

  const pageBottom = getPdfContentBottom(doc);

  // Opening balance shown as the first row of the table
  let runningBalance = openingBalance;

  y = drawTableHeader(y);

  // Opening balance row (always shown as the starting point of the statement)
  {
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#000');
    doc.text('—', cols.date.x, y + 4, { width: cols.date.w });
    doc.text('—', cols.invoice.x, y + 4, { width: cols.invoice.w });
    doc.text('Opening Balance', cols.desc.x, y + 4, { width: cols.desc.w });
    doc.text('—', cols.dr.x, y + 4, { width: cols.dr.w - 6, align: 'right' });
    doc.text('—', cols.cr.x, y + 4, { width: cols.cr.w - 6, align: 'right' });
    doc.text(`${Math.abs(runningBalance).toFixed(2)} ${runningBalance >= 0 ? 'Dr' : 'Cr'}`, cols.balance.x, y + 4, { width: cols.balance.w - 4, align: 'right' });
    y += rowHeight;
  }

  let totalDr = 0, totalCr = 0;

  for (const row of ledger) {
    if (y + rowHeight > pageBottom) {
      doc.addPage();
      y = 40;
      y = drawTableHeader(y);
    }

    const dr = parseFloat(row.dr) || 0;
    const cr = parseFloat(row.cr) || 0;
    runningBalance += dr - cr;
    totalDr += dr;
    totalCr += cr;

    doc.font('Helvetica').fontSize(8.5).fillColor('#000');
    doc.text(new Date(row.date).toLocaleDateString('en-GB'), cols.date.x, y + 4, { width: cols.date.w });
    doc.text(row.invoice_no || '—', cols.invoice.x, y + 4, { width: cols.invoice.w });
    doc.text(row.description || '—', cols.desc.x, y + 4, { width: cols.desc.w, ellipsis: true });
    doc.text(dr > 0 ? dr.toFixed(2) : '—', cols.dr.x, y + 4, { width: cols.dr.w - 6, align: 'right' });
    doc.text(cr > 0 ? cr.toFixed(2) : '—', cols.cr.x, y + 4, { width: cols.cr.w - 6, align: 'right' });
    doc.text(`${Math.abs(runningBalance).toFixed(2)} ${runningBalance >= 0 ? 'Dr' : 'Cr'}`, cols.balance.x, y + 4, { width: cols.balance.w - 4, align: 'right' });

    y += rowHeight;
  }

  // Single line after the table ends
  doc.moveTo(left, y).lineTo(right, y).lineWidth(1).strokeColor('#000').stroke();
  y += 8;

  // ── Totals & closing balance ─────────────────────────────────────────
  y = ensureSpace(doc, y, 70);

  doc.font('Helvetica-Bold').fontSize(9).fillColor('#000');
  doc.text('Total', cols.desc.x, y, { width: cols.desc.w, lineBreak: false });
  doc.text(totalDr.toFixed(2), cols.dr.x, y, { width: cols.dr.w - 6, align: 'right', lineBreak: false });
  doc.text(totalCr.toFixed(2), cols.cr.x, y, { width: cols.cr.w - 6, align: 'right', lineBreak: false });
  doc.text(`${Math.abs(runningBalance).toFixed(2)} ${runningBalance >= 0 ? 'Dr' : 'Cr'}`, cols.balance.x, y, { width: cols.balance.w - 4, align: 'right', lineBreak: false });

  y += 18;
  doc.font('Helvetica-Bold').fontSize(10)
    .text(`Closing Balance: PKR ${Math.abs(runningBalance).toFixed(2)} ${runningBalance >= 0 ? 'Receivable (Dr)' : 'Payable (Cr)'}`, left, y, { width: contentWidth, align: 'right', lineBreak: false });

  y = doc.y + 12;

  stampPdfFootersOnAllPages(doc, { left, right, contentWidth, companyName });
  doc.flushPages();
  doc.end();
}

// ── Sales Report data ───────────────────────────────────────────────────────
async function fetchSalesReportData({ from_date, to_date, salesman_id }) {
  let sql = `
    SELECT s.id, s.date, s.invoice_no, c.name AS customer_name,
           e.name AS salesman_name,
           s.total_amount AS gross_amount,
           COALESCE(r.total_return_amount, 0) AS return_amount,
           COALESCE(r.total_discount, 0) AS discount,
           (s.total_amount - COALESCE(r.total_return_amount, 0) - COALESCE(r.total_discount, 0)) AS net_amount,
           COALESCE(r.net_collected, 0) AS recovered_amount
    FROM sales s
    JOIN customers c ON s.customer_id = c.id
    LEFT JOIN employees e ON s.salesman_id = e.id
    LEFT JOIN recoveries r ON r.sale_id = s.id
    WHERE 1=1`;
  const params = [];
  if (from_date) { sql += ' AND s.date >= ?'; params.push(from_date); }
  if (to_date) { sql += ' AND s.date <= ?'; params.push(to_date); }
  if (salesman_id) { sql += ' AND s.salesman_id = ?'; params.push(salesman_id); }
  sql += ' ORDER BY s.date ASC, s.id ASC';
  const [rows] = await db.query(sql, params);
  return rows;
}

// ── Recovery Report data ────────────────────────────────────────────────────
async function fetchRecoveryReportData({ from_date, to_date, salesman_id, supplier_id }) {
  let sql = `
    SELECT r.id, r.date, c.name AS customer_name, e.name AS salesman_name,
           s.invoice_no, s.total_amount AS gross_amount,
           COALESCE(r.net_collected, 0) AS recovered_amount,
           (COALESCE(r.total_discount, 0) + COALESCE(r.total_return_amount, 0)) AS return_discount,
           COALESCE(r.pending_amount,
             s.total_amount - COALESCE(r.net_collected, 0) - COALESCE(r.total_discount, 0) - COALESCE(r.total_return_amount, 0)
           ) AS net_pending
    FROM recoveries r
    JOIN sales s ON r.sale_id = s.id
    JOIN customers c ON s.customer_id = c.id
    LEFT JOIN employees e ON r.salesman_id = e.id
    WHERE 1=1`;
  const params = [];
  if (from_date) { sql += ' AND r.date >= ?'; params.push(from_date); }
  if (to_date) { sql += ' AND r.date <= ?'; params.push(to_date); }
  if (salesman_id) { sql += ' AND r.salesman_id = ?'; params.push(salesman_id); }
  if (supplier_id) {
    sql += ` AND EXISTS (
      SELECT 1 FROM sale_items si
      JOIN supplier_products sp ON sp.product_id = si.product_id
      WHERE si.sale_id = s.id AND sp.supplier_id = ?
    )`;
    params.push(supplier_id);
  }
  sql += ' ORDER BY r.date ASC, r.id ASC';
  const [rows] = await db.query(sql, params);
  return rows;
}

router.get('/sales-report', auth, async (req, res) => {
  try {
    const { from_date, to_date, salesman_id } = req.query;
    const rows = await fetchSalesReportData({ from_date, to_date, salesman_id: salesman_id || null });
    res.json({ rows });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/recovery-report', auth, async (req, res) => {
  try {
    const { from_date, to_date, salesman_id, supplier_id } = req.query;
    const rows = await fetchRecoveryReportData({
      from_date, to_date,
      salesman_id: salesman_id || null,
      supplier_id: supplier_id || null,
    });
    res.json({ rows });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/sales-report/pdf', auth, async (req, res) => {
  try {
    const { from_date, to_date, salesman_id } = req.query;
    const rows = await fetchSalesReportData({ from_date, to_date, salesman_id: salesman_id || null });
    const [[companySettings]] = await db.query('SELECT * FROM company_settings WHERE id=1');

    let salesmanLabel = 'All';
    if (salesman_id) {
      const [emp] = await db.query('SELECT name FROM employees WHERE id=?', [salesman_id]);
      salesmanLabel = emp[0]?.name || salesman_id;
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="sales-report.pdf"');

    generateSalesReportPDF(res, { rows, from_date, to_date, salesmanLabel, company: companySettings });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/recovery-report/pdf', auth, async (req, res) => {
  try {
    const { from_date, to_date, salesman_id, supplier_id } = req.query;
    const rows = await fetchRecoveryReportData({
      from_date, to_date,
      salesman_id: salesman_id || null,
      supplier_id: supplier_id || null,
    });
    const [[companySettings]] = await db.query('SELECT * FROM company_settings WHERE id=1');

    let salesmanLabel = 'All';
    if (salesman_id) {
      const [emp] = await db.query('SELECT name FROM employees WHERE id=?', [salesman_id]);
      salesmanLabel = emp[0]?.name || salesman_id;
    }
    let supplierLabel = 'All';
    if (supplier_id) {
      const [sup] = await db.query('SELECT name FROM suppliers WHERE id=?', [supplier_id]);
      supplierLabel = sup[0]?.name || supplier_id;
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="recovery-report.pdf"');

    generateRecoveryReportPDF(res, {
      rows, from_date, to_date, salesmanLabel, supplierLabel, company: companySettings,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

function generateSalesReportPDF(res, { rows, from_date, to_date, salesmanLabel, company }) {
  const doc = new PDFDocument({ margin: 40, size: 'A4', bufferPages: true });
  doc.pipe(res);

  const companyName = company?.name || 'Medivance';
  const left = 40, right = doc.page.width - 40, contentWidth = right - left;
  const footerOpts = { left, right, contentWidth, companyName };
  const fontSize = 9;
  const headerFontSize = 9.5;

  let y = drawReportHeader(doc, {
    company, title: 'SALES REPORT', subtitle: 'Distribution Sales Summary', left, right, contentWidth,
  });

  y = drawFilterBox(doc, {
    left, contentWidth, y,
    filters: [
      `Period: ${from_date || 'Beginning'}  to  ${to_date || 'Present'}`,
      `Salesman: ${salesmanLabel}`,
    ],
  });

  const cols = buildPdfColumns(left, contentWidth, [
    { label: 'Sr', w: 28 },
    { label: 'Date', w: 64 },
    { label: 'Invoice', w: 72 },
    { label: 'Customer', w: 'flex' },
    { label: 'Gross', w: 62, align: 'right' },
    { label: 'Return', w: 58, align: 'right' },
    { label: 'Disc.', w: 52, align: 'right' },
    { label: 'Net', w: 62, align: 'right' },
    { label: 'Recovered', w: 62, align: 'right' },
  ]);

  const rowH = 18, hdrH = 20, pageBottom = getPdfContentBottom(doc);

  function drawHdr(yy) {
    doc.moveTo(left, yy).lineTo(right, yy).lineWidth(1).strokeColor('#000').stroke();
    doc.font('Helvetica-Bold').fontSize(headerFontSize).fillColor('#000');
    cols.forEach((c) => doc.text(c.label, c.x + 2, yy + 5, { width: c.w - 4, align: c.align, lineBreak: false }));
    doc.moveTo(left, yy + hdrH).lineTo(right, yy + hdrH).stroke();
    return yy + hdrH;
  }

  y = drawHdr(y);
  let totals = { gross: 0, ret: 0, disc: 0, net: 0, rec: 0 };

  rows.forEach((row, i) => {
    if (y + rowH > pageBottom) { doc.addPage(); y = 40; y = drawHdr(y); }
    const gross = parseFloat(row.gross_amount) || 0;
    const ret = parseFloat(row.return_amount) || 0;
    const disc = parseFloat(row.discount) || 0;
    const net = parseFloat(row.net_amount) || 0;
    const rec = parseFloat(row.recovered_amount) || 0;
    totals.gross += gross; totals.ret += ret; totals.disc += disc; totals.net += net; totals.rec += rec;

    doc.font('Helvetica').fontSize(fontSize);
    doc.text(String(i + 1), cols[0].x + 2, y + 4, { width: cols[0].w - 4, lineBreak: false });
    doc.text(new Date(row.date).toLocaleDateString('en-GB'), cols[1].x + 2, y + 4, { width: cols[1].w - 4, lineBreak: false });
    doc.text(row.invoice_no || '—', cols[2].x + 2, y + 4, { width: cols[2].w - 4, lineBreak: false });
    doc.text(row.customer_name || '—', cols[3].x + 2, y + 4, { width: cols[3].w - 4, ellipsis: true });
    doc.text(gross.toFixed(2), cols[4].x + 2, y + 4, { width: cols[4].w - 4, align: 'right', lineBreak: false });
    doc.text(ret > 0 ? ret.toFixed(2) : '—', cols[5].x + 2, y + 4, { width: cols[5].w - 4, align: 'right', lineBreak: false });
    doc.text(disc > 0 ? disc.toFixed(2) : '—', cols[6].x + 2, y + 4, { width: cols[6].w - 4, align: 'right', lineBreak: false });
    doc.text(net.toFixed(2), cols[7].x + 2, y + 4, { width: cols[7].w - 4, align: 'right', lineBreak: false });
    doc.text(rec > 0 ? rec.toFixed(2) : '—', cols[8].x + 2, y + 4, { width: cols[8].w - 4, align: 'right', lineBreak: false });
    y += rowH;
  });

  doc.moveTo(left, y).lineTo(right, y).stroke();
  y += 8;
  y = ensureSpace(doc, y, 24);
  doc.font('Helvetica-Bold').fontSize(fontSize);
  doc.text('TOTAL', cols[3].x + 2, y, { width: cols[3].w - 4, lineBreak: false });
  doc.text(totals.gross.toFixed(2), cols[4].x + 2, y, { width: cols[4].w - 4, align: 'right', lineBreak: false });
  doc.text(totals.ret.toFixed(2), cols[5].x + 2, y, { width: cols[5].w - 4, align: 'right', lineBreak: false });
  doc.text(totals.disc.toFixed(2), cols[6].x + 2, y, { width: cols[6].w - 4, align: 'right', lineBreak: false });
  doc.text(totals.net.toFixed(2), cols[7].x + 2, y, { width: cols[7].w - 4, align: 'right', lineBreak: false });
  doc.text(totals.rec.toFixed(2), cols[8].x + 2, y, { width: cols[8].w - 4, align: 'right', lineBreak: false });

  stampPdfFootersOnAllPages(doc, footerOpts);
  doc.flushPages();
  doc.end();
}

function generateRecoveryReportPDF(res, { rows, from_date, to_date, salesmanLabel, supplierLabel, company }) {
  const doc = new PDFDocument({ margin: 40, size: 'A4', bufferPages: true });
  doc.pipe(res);

  const companyName = company?.name || 'Medivance';
  const left = 40, right = doc.page.width - 40, contentWidth = right - left;
  const footerOpts = { left, right, contentWidth, companyName };
  const fontSize = 9;
  const headerFontSize = 9.5;

  let y = drawReportHeader(doc, {
    company, title: 'RECOVERY REPORT', subtitle: 'Recovery & Return Summary', left, right, contentWidth,
  });

  y = drawFilterBox(doc, {
    left, contentWidth, y,
    filters: [
      `Period: ${from_date || 'Beginning'}  to  ${to_date || 'Present'}`,
      `Salesman: ${salesmanLabel}`,
      `Supplier: ${supplierLabel}`,
    ],
  });

  const cols = buildPdfColumns(left, contentWidth, [
    { label: 'Sr', w: 28 },
    { label: 'Date', w: 64 },
    { label: 'Customer', w: 'flex' },
    { label: 'Gross', w: 72, align: 'right' },
    { label: 'Recovered', w: 72, align: 'right' },
    { label: 'Ret / Disc', w: 72, align: 'right' },
    { label: 'Pending', w: 72, align: 'right' },
  ]);

  const rowH = 18, hdrH = 20, pageBottom = getPdfContentBottom(doc);

  function drawHdr(yy) {
    doc.moveTo(left, yy).lineTo(right, yy).lineWidth(1).strokeColor('#000').stroke();
    doc.font('Helvetica-Bold').fontSize(headerFontSize).fillColor('#000');
    cols.forEach((c) => doc.text(c.label, c.x + 2, yy + 5, { width: c.w - 4, align: c.align, lineBreak: false }));
    doc.moveTo(left, yy + hdrH).lineTo(right, yy + hdrH).stroke();
    return yy + hdrH;
  }

  y = drawHdr(y);
  let totals = { gross: 0, rec: 0, rd: 0, pending: 0 };

  rows.forEach((row, i) => {
    if (y + rowH > pageBottom) { doc.addPage(); y = 40; y = drawHdr(y); }
    const gross = parseFloat(row.gross_amount) || 0;
    const rec = parseFloat(row.recovered_amount) || 0;
    const rd = parseFloat(row.return_discount) || 0;
    const pending = parseFloat(row.net_pending) || 0;
    totals.gross += gross; totals.rec += rec; totals.rd += rd; totals.pending += pending;

    doc.font('Helvetica').fontSize(fontSize);
    doc.text(String(i + 1), cols[0].x + 2, y + 4, { width: cols[0].w - 4, lineBreak: false });
    doc.text(new Date(row.date).toLocaleDateString('en-GB'), cols[1].x + 2, y + 4, { width: cols[1].w - 4, lineBreak: false });
    doc.text(row.customer_name || '—', cols[2].x + 2, y + 4, { width: cols[2].w - 4, ellipsis: true });
    doc.text(gross.toFixed(2), cols[3].x + 2, y + 4, { width: cols[3].w - 4, align: 'right', lineBreak: false });
    doc.text(rec.toFixed(2), cols[4].x + 2, y + 4, { width: cols[4].w - 4, align: 'right', lineBreak: false });
    doc.text(rd > 0 ? rd.toFixed(2) : '—', cols[5].x + 2, y + 4, { width: cols[5].w - 4, align: 'right', lineBreak: false });
    doc.text(pending.toFixed(2), cols[6].x + 2, y + 4, { width: cols[6].w - 4, align: 'right', lineBreak: false });
    y += rowH;
  });

  doc.moveTo(left, y).lineTo(right, y).stroke();
  y += 8;
  y = ensureSpace(doc, y, 24);
  doc.font('Helvetica-Bold').fontSize(fontSize);
  doc.text('TOTAL', cols[2].x + 2, y, { width: cols[2].w - 4, lineBreak: false });
  doc.text(totals.gross.toFixed(2), cols[3].x + 2, y, { width: cols[3].w - 4, align: 'right', lineBreak: false });
  doc.text(totals.rec.toFixed(2), cols[4].x + 2, y, { width: cols[4].w - 4, align: 'right', lineBreak: false });
  doc.text(totals.rd.toFixed(2), cols[5].x + 2, y, { width: cols[5].w - 4, align: 'right', lineBreak: false });
  doc.text(totals.pending.toFixed(2), cols[6].x + 2, y, { width: cols[6].w - 4, align: 'right', lineBreak: false });

  stampPdfFootersOnAllPages(doc, footerOpts);
  doc.flushPages();
  doc.end();
}

module.exports = router;
