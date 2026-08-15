const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const auth    = require('../middleware/auth');
const PDFDocument = require('pdfkit');
const {
  drawPdfLogo,
  stampPdfFootersOnAllPages,
  getPdfContentBottom,
  ensureSpace,
  measureRowHeight,
  buildPdfColumns,
  drawReportHeader,
  drawFilterBox,
} = require('../utils/pdfHelpers');
const { formatDatePKT } = require('../utils/dateUtils');

// ─── Shared PDF constants ─────────────────────────────────────────────────────
//
// All three reports (Ledger, Sales, Recovery) use identical table typography
// so rows look consistent across the system.
//
const TABLE_FONT_SIZE     = 8.5;   // data rows
const TABLE_HDR_FONT_SIZE = 8.5;   // column headers  (same weight, Bold applied separately)
const TABLE_HDR_H         = 20;    // fixed header-row height
const TABLE_MIN_ROW       = 18;    // minimum data-row height
const TABLE_TOP_PAD       = 4;     // top padding inside every row (y + TOP_PAD when drawing)

// ─── Supplier Ledger ──────────────────────────────────────────────────────────

router.get('/supplier-ledger', auth, async (req, res) => {
  try {
    const { supplier_id, from_date, to_date } = req.query;
    if (!supplier_id) return res.status(400).json({ message: 'Supplier ID required' });

    const [supplier] = await db.query('SELECT * FROM suppliers WHERE id=?', [supplier_id]);
    if (supplier.length === 0) return res.status(404).json({ message: 'Supplier not found' });

    let sql = 'SELECT * FROM supplier_ledger WHERE supplier_id=?';
    const params = [supplier_id];
    if (from_date) { sql += ' AND date >= ?'; params.push(from_date); }
    if (to_date)   { sql += ' AND date <= ?'; params.push(to_date);   }
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

    res.json({ supplier: supplier[0], ledger, openingBalance });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ─── Customer Ledger ──────────────────────────────────────────────────────────

router.get('/customer-ledger', auth, async (req, res) => {
  try {
    const { customer_id, from_date, to_date } = req.query;
    if (!customer_id) return res.status(400).json({ message: 'Customer ID required' });

    const [customer] = await db.query(`
      SELECT cu.*, ci.name as city_name, a.name as area_name, t.name as territory_name
      FROM customers cu
      LEFT JOIN cities ci ON cu.city_id = ci.id
      LEFT JOIN areas  a  ON cu.area_id  = a.id
      LEFT JOIN territories t ON cu.territory_id = t.id
      WHERE cu.id = ?`, [customer_id]);
    if (customer.length === 0) return res.status(404).json({ message: 'Customer not found' });

    let sql = 'SELECT * FROM customer_ledger WHERE customer_id=?';
    const params = [customer_id];
    if (from_date) { sql += ' AND date >= ?'; params.push(from_date); }
    if (to_date)   { sql += ' AND date <= ?'; params.push(to_date);   }
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

// ─── PDF: Supplier Ledger ─────────────────────────────────────────────────────

router.get('/supplier-ledger/pdf', auth, async (req, res) => {
  try {
    const { supplier_id, from_date, to_date } = req.query;
    const [supplier] = await db.query('SELECT * FROM suppliers WHERE id=?', [supplier_id]);
    if (supplier.length === 0) return res.status(404).json({ message: 'Not found' });

    let sql = 'SELECT * FROM supplier_ledger WHERE supplier_id=?';
    const params = [supplier_id];
    if (from_date) { sql += ' AND date >= ?'; params.push(from_date); }
    if (to_date)   { sql += ' AND date <= ?'; params.push(to_date);   }
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

    const [[company]] = await db.query('SELECT * FROM company_settings WHERE id=1');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="supplier-ledger-${supplier_id}.pdf"`);
    generateLedgerPDF(res, { type: 'Supplier', entity: supplier[0], ledger, openingBalance, from_date, to_date, company });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ─── PDF: Customer Ledger ─────────────────────────────────────────────────────

router.get('/customer-ledger/pdf', auth, async (req, res) => {
  try {
    const { customer_id, from_date, to_date } = req.query;
    const [customer] = await db.query(`
      SELECT cu.*, ci.name as city_name FROM customers cu
      LEFT JOIN cities ci ON cu.city_id = ci.id WHERE cu.id = ?`, [customer_id]);
    if (customer.length === 0) return res.status(404).json({ message: 'Not found' });

    let sql = 'SELECT * FROM customer_ledger WHERE customer_id=?';
    const params = [customer_id];
    if (from_date) { sql += ' AND date >= ?'; params.push(from_date); }
    if (to_date)   { sql += ' AND date <= ?'; params.push(to_date);   }
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

    const [[company]] = await db.query('SELECT * FROM company_settings WHERE id=1');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="customer-ledger-${customer_id}.pdf"`);
    generateLedgerPDF(res, { type: 'Customer', entity: customer[0], ledger, openingBalance, from_date, to_date, company });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ─── generateLedgerPDF ────────────────────────────────────────────────────────

function generateLedgerPDF(res, { type, entity, ledger, openingBalance, from_date, to_date, company }) {
  const doc = new PDFDocument({ margin: 40, size: 'A4', bufferPages: true });
  doc.pipe(res);

  const companyName    = company?.name    || 'Medivance';
  const companyAddress = company?.address || '';
  const companyContact = [company?.phone, company?.email].filter(Boolean).join('   |   ');

  const pageWidth    = doc.page.width;
  const left = 40, right = pageWidth - 40, contentWidth = right - left;

  // ── Page header ─────────────────────────────────────────────────────────────
  doc.fillColor('#000');
  const logoOffset      = drawPdfLogo(doc, left, 38, 42);
  const headerTextX     = left + logoOffset;
  const headerTextWidth = contentWidth * 0.62 - logoOffset;

  doc.font('Helvetica-Bold').fontSize(18).text(companyName, headerTextX, 40, { width: headerTextWidth });
  let headerY = doc.y + 2;
  if (companyAddress) {
    doc.font('Helvetica').fontSize(8.5).text(companyAddress, headerTextX, headerY, { width: headerTextWidth });
    headerY = doc.y + 1;
  }
  if (companyContact) {
    doc.font('Helvetica').fontSize(8.5).text(companyContact, headerTextX, headerY, { width: headerTextWidth });
    headerY = doc.y;
  }

  doc.font('Helvetica-Bold').fontSize(15).text('LEDGER STATEMENT', left, 40, { width: contentWidth, align: 'right', lineBreak: false });
  doc.font('Helvetica').fontSize(9).text(`${type} Account`, left, doc.y + 2, { width: contentWidth, align: 'right', lineBreak: false });
  doc.font('Helvetica').fontSize(8).text(`Generated: ${formatDatePKT(new Date())}`, left, doc.y + 2, { width: contentWidth, align: 'right', lineBreak: false });
  doc.fillColor('#000');

  let y = Math.max(headerY, doc.y) + 14;

  // ── Entity details box ───────────────────────────────────────────────────────
  const boxTop = y;
  doc.font('Helvetica-Bold').fontSize(10).text(entity.name, left + 10, y + 8);
  let ey = doc.y + 4;
  if (entity.address) {
    doc.font('Helvetica').fontSize(8.5).text(entity.address, left + 10, ey, { width: contentWidth * 0.6 });
    ey = doc.y + 2;
  }
  const metaParts = [];
  if (entity.phone)      metaParts.push(`Phone: ${entity.phone}`);
  if (entity.license_no) metaParts.push(`License No: ${entity.license_no}`);
  if (entity.city_name)  metaParts.push(`City: ${entity.city_name}`);
  if (metaParts.length) {
    doc.font('Helvetica').fontSize(8.5).text(metaParts.join('    '), left + 10, ey, { width: contentWidth * 0.85 });
    ey = doc.y;
  }
  const boxHeight = Math.max(50, ey - boxTop + 8);
  doc.rect(left, boxTop, contentWidth, boxHeight).stroke('#000');
  y = boxTop + boxHeight + 10;

  if (from_date || to_date) {
    doc.font('Helvetica').fontSize(8.5)
      .text(`Statement Period: ${from_date || 'Beginning'}  to  ${to_date || 'Present'}`, left, y);
    y = doc.y + 8;
  }

  // ── Column layout ───────────────────────────────────────────────────────────
  const descW = contentWidth - 65 - 90 - 70 - 60 - 70;
  const cols = {
    date:    { x: left,                       w: 65  },
    invoice: { x: left + 65,                  w: 90  },
    desc:    { x: left + 155,                 w: descW },
    dr:      { x: left + 155 + descW,         w: 70  },
    cr:      { x: left + 155 + descW + 70,    w: 60  },
    balance: { x: left + 155 + descW + 130,   w: 70  },
  };

  const pageBottom = getPdfContentBottom(doc);

  function drawTableHeader(yy) {
    doc.moveTo(left, yy).lineTo(right, yy).lineWidth(1).strokeColor('#000').stroke();
    doc.font('Helvetica-Bold').fontSize(TABLE_HDR_FONT_SIZE).fillColor('#000');
    doc.text('Date',        cols.date.x,    yy + TABLE_TOP_PAD, { width: cols.date.w });
    doc.text('Invoice No',  cols.invoice.x, yy + TABLE_TOP_PAD, { width: cols.invoice.w });
    doc.text('Description', cols.desc.x,    yy + TABLE_TOP_PAD, { width: cols.desc.w });
    doc.text('Debit',       cols.dr.x,      yy + TABLE_TOP_PAD, { width: cols.dr.w - 4,      align: 'right' });
    doc.text('Credit',      cols.cr.x,      yy + TABLE_TOP_PAD, { width: cols.cr.w - 4,      align: 'right' });
    doc.text('Balance',     cols.balance.x, yy + TABLE_TOP_PAD, { width: cols.balance.w - 4, align: 'right' });
    doc.moveTo(left, yy + TABLE_HDR_H).lineTo(right, yy + TABLE_HDR_H).lineWidth(1).strokeColor('#000').stroke();
    return yy + TABLE_HDR_H;
  }

  let runningBalance = openingBalance;
  y = drawTableHeader(y);

  // ── Opening balance row ──────────────────────────────────────────────────────
  {
    const balStr = `${Math.abs(runningBalance).toFixed(2)} ${runningBalance >= 0 ? 'Dr' : 'Cr'}`;
    doc.font('Helvetica-Bold').fontSize(TABLE_FONT_SIZE).fillColor('#000');
    doc.text('—',               cols.date.x,    y + TABLE_TOP_PAD, { width: cols.date.w,        lineBreak: false });
    doc.text('—',               cols.invoice.x, y + TABLE_TOP_PAD, { width: cols.invoice.w,     lineBreak: false });
    doc.text('Opening Balance', cols.desc.x,    y + TABLE_TOP_PAD, { width: cols.desc.w,        lineBreak: false });
    doc.text('—',               cols.dr.x,      y + TABLE_TOP_PAD, { width: cols.dr.w - 4,      align: 'right', lineBreak: false });
    doc.text('—',               cols.cr.x,      y + TABLE_TOP_PAD, { width: cols.cr.w - 4,      align: 'right', lineBreak: false });
    doc.text(balStr,            cols.balance.x, y + TABLE_TOP_PAD, { width: cols.balance.w - 4, align: 'right', lineBreak: false });
    y += TABLE_MIN_ROW;
  }

  let totalDr = 0, totalCr = 0;

  for (const row of ledger) {
    const dr = parseFloat(row.dr) || 0;
    const cr = parseFloat(row.cr) || 0;
    runningBalance += dr - cr;
    totalDr += dr;
    totalCr += cr;

    const dateStr    = formatDatePKT(row.date);
    const invoiceStr = row.invoice_no  || '—';
    const descStr    = row.description || '—';
    const drStr      = dr > 0 ? dr.toFixed(2) : '—';
    const crStr      = cr > 0 ? cr.toFixed(2) : '—';
    const balStr     = `${Math.abs(runningBalance).toFixed(2)} ${runningBalance >= 0 ? 'Dr' : 'Cr'}`;

    // Set font before measuring so heightOfString uses the exact same metrics
    doc.font('Helvetica').fontSize(TABLE_FONT_SIZE);
    const rowH = measureRowHeight(doc, [
      { text: dateStr,    width: cols.date.w        },
      { text: invoiceStr, width: cols.invoice.w      },
      { text: descStr,    width: cols.desc.w         },
      { text: drStr,      width: cols.dr.w - 4       },
      { text: crStr,      width: cols.cr.w - 4       },
      { text: balStr,     width: cols.balance.w - 4  },
    ], TABLE_MIN_ROW);

    if (y + rowH > pageBottom) {
      doc.addPage();
      y = doc.page.margins.top;
      y = drawTableHeader(y);
    }

    doc.font('Helvetica').fontSize(TABLE_FONT_SIZE).fillColor('#000');
    doc.text(dateStr,    cols.date.x,    y + TABLE_TOP_PAD, { width: cols.date.w,        lineBreak: false });
    doc.text(invoiceStr, cols.invoice.x, y + TABLE_TOP_PAD, { width: cols.invoice.w,     lineBreak: false });
    doc.text(descStr,    cols.desc.x,    y + TABLE_TOP_PAD, { width: cols.desc.w         }); // wraps freely
    doc.text(drStr,      cols.dr.x,      y + TABLE_TOP_PAD, { width: cols.dr.w - 4,      align: 'right', lineBreak: false });
    doc.text(crStr,      cols.cr.x,      y + TABLE_TOP_PAD, { width: cols.cr.w - 4,      align: 'right', lineBreak: false });
    doc.text(balStr,     cols.balance.x, y + TABLE_TOP_PAD, { width: cols.balance.w - 4, align: 'right', lineBreak: false });

    y += rowH;
  }

  // Rule after last row
  doc.moveTo(left, y).lineTo(right, y).lineWidth(1).strokeColor('#000').stroke();
  y += 8;

  // ── Totals & closing balance ─────────────────────────────────────────────────
  y = ensureSpace(doc, y, 70);
  const closingBalStr = `${Math.abs(runningBalance).toFixed(2)} ${runningBalance >= 0 ? 'Dr' : 'Cr'}`;

  doc.font('Helvetica-Bold').fontSize(TABLE_FONT_SIZE).fillColor('#000');
  doc.text('Total',                cols.desc.x,    y, { width: cols.desc.w,         lineBreak: false });
  doc.text(totalDr.toFixed(2),     cols.dr.x,      y, { width: cols.dr.w - 4,      align: 'right', lineBreak: false });
  doc.text(totalCr.toFixed(2),     cols.cr.x,      y, { width: cols.cr.w - 4,      align: 'right', lineBreak: false });
  doc.text(closingBalStr,          cols.balance.x, y, { width: cols.balance.w - 4, align: 'right', lineBreak: false });

  y += 18;
  doc.font('Helvetica-Bold').fontSize(10)
    .text(
      `Closing Balance: PKR ${Math.abs(runningBalance).toFixed(2)} ${runningBalance >= 0 ? 'Receivable (Dr)' : 'Payable (Cr)'}`,
      left, y, { width: contentWidth, align: 'right', lineBreak: false }
    );

  stampPdfFootersOnAllPages(doc, { left, right, contentWidth, companyName });
  doc.flushPages();
  doc.end();
}

// ─── Sales report data ────────────────────────────────────────────────────────

async function fetchSalesReportData({ from_date, to_date, salesman_id }) {
  // NOTE: s.total_amount reflects the invoice's NET value — for invoices that had
  // a "current invoice" return processed against them (unlocked branch in
  // recoveries.js), total_amount is recalculated down to what's left after that
  // return. So total_amount is the correct NET figure, not the gross sale value.
  // Gross is reconstructed by adding back what was discounted/returned.
  let sql = `
    SELECT s.id, s.date, s.invoice_no, c.name AS customer_name,
           e.name AS salesman_name,
           s.total_amount AS net_amount,
           COALESCE(r.total_return_amount, 0) AS return_amount,
           COALESCE(r.total_discount, 0) AS discount,
           (s.total_amount + COALESCE(r.total_return_amount, 0) + COALESCE(r.total_discount, 0)) AS gross_amount,
           COALESCE(r.net_collected, 0) AS recovered_amount
    FROM sales s
    JOIN customers c ON s.customer_id = c.id
    LEFT JOIN employees e ON s.salesman_id = e.id
    LEFT JOIN recoveries r ON r.sale_id = s.id
    WHERE 1=1`;
  const params = [];
  if (from_date)   { sql += ' AND s.date >= ?'; params.push(from_date); }
  if (to_date)     { sql += ' AND s.date <= ?'; params.push(to_date);   }
  if (salesman_id) { sql += ' AND s.salesman_id = ?'; params.push(salesman_id); }
  sql += ' ORDER BY s.date ASC, s.id ASC';
  const [rows] = await db.query(sql, params);
  return rows;
}

// ─── Recovery report data ─────────────────────────────────────────────────────

async function fetchRecoveryReportData({ from_date, to_date, supplier_id }) {
  // NOTE: s.total_amount is the invoice's NET value (see fetchSalesReportData
  // above), so gross here is reconstructed by adding back what was recovered
  // in cash plus what was given away as discount/return for this recovery event.
  let sql = `
    SELECT
      r.id,
      r.date,
      c.name AS customer_name,
      s.invoice_no,
      (s.total_amount + COALESCE(r.total_return_amount, 0) + COALESCE(r.total_discount, 0)) AS gross_amount,
      COALESCE(r.net_collected, 0) AS recovered_amount,
      (COALESCE(r.total_discount, 0) + COALESCE(r.total_return_amount, 0)) AS return_discount,
      COALESCE(
        r.pending_amount,
        s.total_amount
          - COALESCE(r.net_collected, 0)
          - COALESCE(r.total_discount, 0)
          - COALESCE(r.total_return_amount, 0)
      ) AS net_pending
    FROM recoveries r
    JOIN sales s ON r.sale_id = s.id
    JOIN customers c ON s.customer_id = c.id
    WHERE 1=1
  `;

  const params = [];

  if (from_date) {
    sql += ' AND r.date >= ?';
    params.push(from_date);
  }

  if (to_date) {
    sql += ' AND r.date <= ?';
    params.push(to_date);
  }

  if (supplier_id) {
    sql += ' AND s.delivery_by = ?';
    params.push(supplier_id);
  }

  sql += ' ORDER BY r.date ASC, r.id ASC';

  const [rows] = await db.query(sql, params);
  return rows;
}


// ─── JSON endpoints ───────────────────────────────────────────────────────────

router.get('/sales-report', auth, async (req, res) => {
  try {
    const { from_date, to_date, salesman_id } = req.query;
    const rows = await fetchSalesReportData({ from_date, to_date, salesman_id: salesman_id || null });
    res.json({ rows });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/recovery-report', auth, async (req, res) => {
  try {
    const { from_date, to_date, supplier_id } = req.query;
    const rows = await fetchRecoveryReportData({
      from_date, to_date,
      supplier_id: supplier_id || null,
    });
    res.json({ rows });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ─── PDF endpoints ────────────────────────────────────────────────────────────

router.get('/sales-report/pdf', auth, async (req, res) => {
  try {
    const { from_date, to_date, salesman_id } = req.query;
    const rows = await fetchSalesReportData({ from_date, to_date, salesman_id: salesman_id || null });
    const [[company]] = await db.query('SELECT * FROM company_settings WHERE id=1');

    let salesmanLabel = 'All';
    if (salesman_id) {
      const [emp] = await db.query('SELECT name FROM employees WHERE id=?', [salesman_id]);
      salesmanLabel = emp[0]?.name || salesman_id;
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="sales-report.pdf"');
    generateSalesReportPDF(res, { rows, from_date, to_date, salesmanLabel, company });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/recovery-report/pdf', auth, async (req, res) => {
  try {
    const { from_date, to_date, supplier_id } = req.query;
    const rows = await fetchRecoveryReportData({
      from_date, to_date,
      supplier_id: supplier_id || null,
    });
    const [[company]] = await db.query('SELECT * FROM company_settings WHERE id=1');

    let supplierLabel = 'All';
    if (supplier_id) {
      const [sup] = await db.query('SELECT name FROM employees WHERE id=?', [supplier_id]);
      supplierLabel = sup[0]?.name || supplier_id;
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="recovery-report.pdf"');
    generateRecoveryReportPDF(res, { rows, from_date, to_date, supplierLabel, company });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ─── generateSalesReportPDF ───────────────────────────────────────────────────

function generateSalesReportPDF(res, { rows, from_date, to_date, salesmanLabel, company }) {
  const doc = new PDFDocument({ margin: 40, size: 'A4', bufferPages: true });
  doc.pipe(res);

  const companyName  = company?.name || 'Medivance';
  const left = 40, right = doc.page.width - 40, contentWidth = right - left;
  const footerOpts   = { left, right, contentWidth, companyName };

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
    { label: 'Sr',        w: 18 },
    { label: 'Date',      w: 54 },
    { label: 'Invoice',   w: 52 },
    { label: 'Customer',  w: 'flex' },
    { label: 'Gross',     w: 62, align: 'right' },
    { label: 'Return',    w: 58, align: 'right' },
    { label: 'Disc.',     w: 52, align: 'right' },
    { label: 'Net',       w: 62, align: 'right' },
    { label: 'Recovered', w: 62, align: 'right' },
  ]);

  const pageBottom = getPdfContentBottom(doc);

  function drawHdr(yy) {
    doc.moveTo(left, yy).lineTo(right, yy).lineWidth(1).strokeColor('#000').stroke();
    doc.font('Helvetica-Bold').fontSize(TABLE_HDR_FONT_SIZE).fillColor('#000');
    cols.forEach(c =>
      doc.text(c.label, c.x + 2, yy + TABLE_TOP_PAD, { width: c.w - 4, align: c.align, lineBreak: false })
    );
    doc.moveTo(left, yy + TABLE_HDR_H).lineTo(right, yy + TABLE_HDR_H).stroke();
    return yy + TABLE_HDR_H;
  }

  y = drawHdr(y);
  const totals = { gross: 0, ret: 0, disc: 0, net: 0, rec: 0 };

  rows.forEach((row, i) => {
    const gross = parseFloat(row.gross_amount)    || 0;
    const ret   = parseFloat(row.return_amount)   || 0;
    const disc  = parseFloat(row.discount)        || 0;
    const net   = parseFloat(row.net_amount)      || 0;
    const rec   = parseFloat(row.recovered_amount)|| 0;
    totals.gross += gross; totals.ret += ret; totals.disc += disc;
    totals.net   += net;   totals.rec += rec;

    const srStr      = String(i + 1);
    const dateStr    = formatDatePKT(row.date);
    const invoiceStr = row.invoice_no    || '—';
    const custStr    = row.customer_name || '—';
    const grossStr   = gross.toFixed(2);
    const retStr     = ret  > 0 ? ret.toFixed(2)  : '—';
    const discStr    = disc > 0 ? disc.toFixed(2) : '—';
    const netStr     = net.toFixed(2);
    const recStr     = rec  > 0 ? rec.toFixed(2)  : '—';

    // Must set font before measuring
    doc.font('Helvetica').fontSize(TABLE_FONT_SIZE);
    const rowH = measureRowHeight(doc, [
      { text: srStr,      width: cols[0].w - 4 },
      { text: dateStr,    width: cols[1].w - 4 },
      { text: invoiceStr, width: cols[2].w - 4 },
      { text: custStr,    width: cols[3].w - 4 },  // flex col – most likely to wrap
      { text: grossStr,   width: cols[4].w - 4 },
      { text: retStr,     width: cols[5].w - 4 },
      { text: discStr,    width: cols[6].w - 4 },
      { text: netStr,     width: cols[7].w - 4 },
      { text: recStr,     width: cols[8].w - 4 },
    ], TABLE_MIN_ROW);

    if (y + rowH > pageBottom) { doc.addPage(); y = doc.page.margins.top; y = drawHdr(y); }

    doc.font('Helvetica').fontSize(TABLE_FONT_SIZE).fillColor('#000');
    doc.text(srStr,      cols[0].x + 2, y + TABLE_TOP_PAD, { width: cols[0].w - 4, lineBreak: false });
    doc.text(dateStr,    cols[1].x + 2, y + TABLE_TOP_PAD, { width: cols[1].w - 4, lineBreak: false });
    doc.text(invoiceStr, cols[2].x + 2, y + TABLE_TOP_PAD, { width: cols[2].w - 4, lineBreak: false });
    doc.text(custStr,    cols[3].x + 2, y + TABLE_TOP_PAD, { width: cols[3].w - 4 }); // wraps freely
    doc.text(grossStr,   cols[4].x + 2, y + TABLE_TOP_PAD, { width: cols[4].w - 4, align: 'right', lineBreak: false });
    doc.text(retStr,     cols[5].x + 2, y + TABLE_TOP_PAD, { width: cols[5].w - 4, align: 'right', lineBreak: false });
    doc.text(discStr,    cols[6].x + 2, y + TABLE_TOP_PAD, { width: cols[6].w - 4, align: 'right', lineBreak: false });
    doc.text(netStr,     cols[7].x + 2, y + TABLE_TOP_PAD, { width: cols[7].w - 4, align: 'right', lineBreak: false });
    doc.text(recStr,     cols[8].x + 2, y + TABLE_TOP_PAD, { width: cols[8].w - 4, align: 'right', lineBreak: false });
    y += rowH;
  });

  doc.moveTo(left, y).lineTo(right, y).stroke();
  y += 8;
  y = ensureSpace(doc, y, 24);

  doc.font('Helvetica-Bold').fontSize(TABLE_FONT_SIZE);
  doc.text('TOTAL',                  cols[3].x + 2, y, { width: cols[3].w - 4,  lineBreak: false });
  doc.text(totals.gross.toFixed(2),  cols[4].x + 2, y, { width: cols[4].w - 4, align: 'right', lineBreak: false });
  doc.text(totals.ret.toFixed(2),    cols[5].x + 2, y, { width: cols[5].w - 4, align: 'right', lineBreak: false });
  doc.text(totals.disc.toFixed(2),   cols[6].x + 2, y, { width: cols[6].w - 4, align: 'right', lineBreak: false });
  doc.text(totals.net.toFixed(2),    cols[7].x + 2, y, { width: cols[7].w - 4, align: 'right', lineBreak: false });
  doc.text(totals.rec.toFixed(2),    cols[8].x + 2, y, { width: cols[8].w - 4, align: 'right', lineBreak: false });

  stampPdfFootersOnAllPages(doc, footerOpts);
  doc.flushPages();
  doc.end();
}

// ─── generateRecoveryReportPDF ────────────────────────────────────────────────

function generateRecoveryReportPDF(res, { rows, from_date, to_date, supplierLabel, company }) {
  const doc = new PDFDocument({ margin: 40, size: 'A4', bufferPages: true });
  doc.pipe(res);

  const companyName  = company?.name || 'Medivance';
  const left = 40, right = doc.page.width - 40, contentWidth = right - left;
  const footerOpts   = { left, right, contentWidth, companyName };

  let y = drawReportHeader(doc, {
    company, title: 'RECOVERY REPORT', subtitle: 'Recovery & Return Summary', left, right, contentWidth,
  });

  y = drawFilterBox(doc, {
    left, contentWidth, y,
    filters: [
      `Period: ${from_date || 'Beginning'}  to  ${to_date || 'Present'}`,
      `Supplier: ${supplierLabel}`,
    ],
  });

  const cols = buildPdfColumns(left, contentWidth, [
    { label: 'Sr',         w: 21 },
    { label: 'Date',       w: 56 },
    { label: 'Customer',   w: 'flex' },
    { label: 'Gross',      w: 72, align: 'right' },
    { label: 'Recovered',  w: 72, align: 'right' },
    { label: 'Ret / Disc', w: 72, align: 'right' },
    { label: 'Pending',    w: 72, align: 'right' },
  ]);

  const pageBottom = getPdfContentBottom(doc);

  function drawHdr(yy) {
    doc.moveTo(left, yy).lineTo(right, yy).lineWidth(1).strokeColor('#000').stroke();
    doc.font('Helvetica-Bold').fontSize(TABLE_HDR_FONT_SIZE).fillColor('#000');
    cols.forEach(c =>
      doc.text(c.label, c.x + 2, yy + TABLE_TOP_PAD, { width: c.w - 4, align: c.align, lineBreak: false })
    );
    doc.moveTo(left, yy + TABLE_HDR_H).lineTo(right, yy + TABLE_HDR_H).stroke();
    return yy + TABLE_HDR_H;
  }

  y = drawHdr(y);
  const totals = { gross: 0, rec: 0, rd: 0, pending: 0 };

  rows.forEach((row, i) => {
    const gross   = parseFloat(row.gross_amount)    || 0;
    const rec     = parseFloat(row.recovered_amount)|| 0;
    const rd      = parseFloat(row.return_discount) || 0;
    const pending = parseFloat(row.net_pending)     || 0;
    totals.gross += gross; totals.rec += rec; totals.rd += rd; totals.pending += pending;

    const srStr      = String(i + 1);
    const dateStr    = formatDatePKT(row.date);
    const custStr    = row.customer_name || '—';
    const grossStr   = gross.toFixed(2);
    const recStr     = rec.toFixed(2);
    const rdStr      = rd > 0 ? rd.toFixed(2) : '—';
    const pendingStr = pending.toFixed(2);

    // Must set font before measuring
    doc.font('Helvetica').fontSize(TABLE_FONT_SIZE);
    const rowH = measureRowHeight(doc, [
      { text: srStr,      width: cols[0].w - 4 },
      { text: dateStr,    width: cols[1].w - 4 },
      { text: custStr,    width: cols[2].w - 4 },  // flex col – most likely to wrap
      { text: grossStr,   width: cols[3].w - 4 },
      { text: recStr,     width: cols[4].w - 4 },
      { text: rdStr,      width: cols[5].w - 4 },
      { text: pendingStr, width: cols[6].w - 4 },
    ], TABLE_MIN_ROW);

    if (y + rowH > pageBottom) { doc.addPage(); y = doc.page.margins.top; y = drawHdr(y); }

    doc.font('Helvetica').fontSize(TABLE_FONT_SIZE).fillColor('#000');
    doc.text(srStr,      cols[0].x + 2, y + TABLE_TOP_PAD, { width: cols[0].w - 4, lineBreak: false });
    doc.text(dateStr,    cols[1].x + 2, y + TABLE_TOP_PAD, { width: cols[1].w - 4, lineBreak: false });
    doc.text(custStr,    cols[2].x + 2, y + TABLE_TOP_PAD, { width: cols[2].w - 4 }); // wraps freely
    doc.text(grossStr,   cols[3].x + 2, y + TABLE_TOP_PAD, { width: cols[3].w - 4, align: 'right', lineBreak: false });
    doc.text(recStr,     cols[4].x + 2, y + TABLE_TOP_PAD, { width: cols[4].w - 4, align: 'right', lineBreak: false });
    doc.text(rdStr,      cols[5].x + 2, y + TABLE_TOP_PAD, { width: cols[5].w - 4, align: 'right', lineBreak: false });
    doc.text(pendingStr, cols[6].x + 2, y + TABLE_TOP_PAD, { width: cols[6].w - 4, align: 'right', lineBreak: false });
    y += rowH;
  });

  doc.moveTo(left, y).lineTo(right, y).stroke();
  y += 8;
  y = ensureSpace(doc, y, 24);

  doc.font('Helvetica-Bold').fontSize(TABLE_FONT_SIZE);
  doc.text('TOTAL',                    cols[2].x + 2, y, { width: cols[2].w - 4,  lineBreak: false });
  doc.text(totals.gross.toFixed(2),    cols[3].x + 2, y, { width: cols[3].w - 4, align: 'right', lineBreak: false });
  doc.text(totals.rec.toFixed(2),      cols[4].x + 2, y, { width: cols[4].w - 4, align: 'right', lineBreak: false });
  doc.text(totals.rd.toFixed(2),       cols[5].x + 2, y, { width: cols[5].w - 4, align: 'right', lineBreak: false });
  doc.text(totals.pending.toFixed(2),  cols[6].x + 2, y, { width: cols[6].w - 4, align: 'right', lineBreak: false });

  stampPdfFootersOnAllPages(doc, footerOpts);
  doc.flushPages();
  doc.end();
}

// ─── Sale Summary (multi-level / layered) report ─────────────────────────────
//
// Lets the user pick up to 4 "layers" — an ordered, de-duplicated combination
// of Salesman / Company / Product / Customer — and returns sales aggregated
// (grouped) by that combination. Layer 1 is required; Layers 2-4 are optional
// ("skip further layers" in the UI just means fewer entries in `layers`).
//
// GRAIN NOTE: Salesman and Customer are attributes of the *invoice* (sales
// row), but Company and Product only exist at the *line-item* level (one
// invoice can carry products from several companies). So:
//   - If neither 'company' nor 'product' is requested, we aggregate at
//     invoice level directly off `sales` (fast, and avoids the row-duplication
//     risk of joining the un-aggregated `recoveries` table — see fix below).
//   - If 'company' or 'product' IS requested, we aggregate at sale_item level
//     and attribute return/discount/recovered amounts to each item via
//     `return_items` and `recovery_items` (both carry sale_item_id).
//
// ASSUMPTION TO VERIFY (Danish): item-level Return/Discount/Recovered here
// rely on `return_items` and `recovery_items` rows existing per sale_item.
// If a fully-paid same-day Quick Recovery settlement does NOT insert
// recovery_items rows for items with no discount/return, item-level
// "Recovered" will undercount for those items even though the invoice-level
// sales.total_recovered is correct. If that's the case, this needs a
// fallback proration step (recovered * item_gross / invoice_gross) for
// invoices that have no recovery_items rows at all — flag this and I'll wire
// it in.

const SALE_SUMMARY_ENTITIES = {
  salesman: { label: 'Salesman', grain: 'invoice' },
  customer: { label: 'Customer', grain: 'invoice' },
  company:  { label: 'Company',  grain: 'item' },
  product:  { label: 'Product',  grain: 'item' },
};

function parseSaleSummaryLayers(layersParam) {
  if (!layersParam) return [];
  const keys = String(layersParam).split(',').map(s => s.trim()).filter(Boolean);
  const seen = new Set();
  const layers = [];
  for (const k of keys) {
    if (!SALE_SUMMARY_ENTITIES[k]) throw new Error(`Invalid layer: ${k}`);
    if (seen.has(k)) throw new Error(`Duplicate layer: ${k}`);
    seen.add(k);
    layers.push(k);
  }
  if (layers.length === 0) throw new Error('At least one layer is required');
  if (layers.length > 4) throw new Error('A maximum of 4 layers is supported');
  return layers;
}

async function fetchSaleSummaryData({ from_date, to_date, layers }) {
  const itemLevel = layers.some(l => SALE_SUMMARY_ENTITIES[l].grain === 'item');

  // NOTE: no COALESCE-to-placeholder-text here — unassigned salesmen / products
  // with no company come through as NULL, and the UI/PDF render that as a plain
  // "—" like every other blank value in the system, instead of a noisy
  // "(Unassigned)" label.
  const labelExprs = {
    salesman: 'e_sm.name',
    customer: 'c.name',
    company:  'co.name',
    product:  'p.name',
  };

  const selectCols = layers.map((l, i) => `${labelExprs[l]} AS layer${i + 1}`).join(',\n      ');
  const groupCols  = layers.map((_, i) => `layer${i + 1}`).join(', ');
  // Blank/unassigned values (e.g. no salesman, no company) sort AFTER every
  // real value at that level, instead of MySQL's default of sorting NULL
  // first — so "—" rows land at the bottom of the report, not the top.
  const orderCols = layers.map((_, i) => `layer${i + 1} IS NULL, layer${i + 1}`).join(', ');

  const params = [];
  let sql;

  if (!itemLevel) {
    // Invoice-level: aggregate straight off `sales`. Using the sale's own
    // running totals (total_amount, total_return_amount, total_discount,
    // total_recovered) instead of joining `recoveries` avoids duplicating
    // rows for invoices with multiple recovery events.
    sql = `
      SELECT
        ${selectCols},
        SUM(s.total_amount + s.total_return_amount + s.total_discount) AS gross_amount,
        SUM(s.total_return_amount) AS return_amount,
        SUM(s.total_discount) AS discount,
        SUM(s.total_amount) AS net_amount,
        SUM(s.total_recovered) AS recovered_amount
      FROM sales s
      JOIN customers c ON s.customer_id = c.id
      LEFT JOIN employees e_sm ON s.salesman_id = e_sm.id
      WHERE 1=1`;
    if (from_date) { sql += ' AND s.date >= ?'; params.push(from_date); }
    if (to_date)   { sql += ' AND s.date <= ?'; params.push(to_date);   }
    sql += ` GROUP BY ${groupCols} ORDER BY ${orderCols}`;
  } else {
    // Item-level: aggregate off sale_items, attributing return/discount/
    // recovered amounts via return_items / recovery_items (see caveat above).
    sql = `
      SELECT
        ${selectCols},
        SUM(si.total) AS gross_amount,
        SUM(COALESCE(ri.ret, 0)) AS return_amount,
        SUM(COALESCE(rv.disc, 0)) AS discount,
        SUM(si.total - COALESCE(ri.ret, 0) - COALESCE(rv.disc, 0)) AS net_amount,
        SUM(COALESCE(rv.rec, 0)) AS recovered_amount
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.id
      JOIN customers c ON s.customer_id = c.id
      LEFT JOIN employees e_sm ON s.salesman_id = e_sm.id
      JOIN products p ON si.product_id = p.id
      LEFT JOIN companies co ON p.company_id = co.id
      LEFT JOIN (
        SELECT sale_item_id, SUM(return_amount) AS ret
        FROM return_items GROUP BY sale_item_id
      ) ri ON ri.sale_item_id = si.id
      LEFT JOIN (
        SELECT sale_item_id, SUM(discount_given) AS disc, SUM(final_amount) AS rec
        FROM recovery_items GROUP BY sale_item_id
      ) rv ON rv.sale_item_id = si.id
      WHERE 1=1`;
    if (from_date) { sql += ' AND s.date >= ?'; params.push(from_date); }
    if (to_date)   { sql += ' AND s.date <= ?'; params.push(to_date);   }
    sql += ` GROUP BY ${groupCols} ORDER BY ${orderCols}`;
  }

  const [rows] = await db.query(sql, params);
  return rows;
}

router.get('/sale-summary', auth, async (req, res) => {
  try {
    const { from_date, to_date, layers: layersParam } = req.query;
    const layers = parseSaleSummaryLayers(layersParam);
    const rows = await fetchSaleSummaryData({ from_date, to_date, layers });
    res.json({
      rows,
      layers: layers.map(l => ({ key: l, label: SALE_SUMMARY_ENTITIES[l].label })),
    });
  } catch (err) { res.status(400).json({ message: err.message }); }
});

router.get('/sale-summary/pdf', auth, async (req, res) => {
  try {
    const { from_date, to_date, layers: layersParam } = req.query;
    const layers = parseSaleSummaryLayers(layersParam);
    const rows = await fetchSaleSummaryData({ from_date, to_date, layers });
    const [[company]] = await db.query('SELECT * FROM company_settings WHERE id=1');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="sale-summary-report.pdf"');
    generateSaleSummaryPDF(res, {
      rows, from_date, to_date, company,
      layerLabels: layers.map(l => SALE_SUMMARY_ENTITIES[l].label),
    });
  } catch (err) { res.status(400).json({ message: err.message }); }
});

// ─── generateSaleSummaryPDF ───────────────────────────────────────────────────
//
// This report has a different shape than the other three (it's a grouped /
// hierarchical breakdown, not a flat list), so it gets its own layout logic
// rather than reusing the invoice-style column helpers used elsewhere:
//
//  - Column widths are derived as fractions of the actual page content width
//    and the LAST column absorbs any rounding remainder, so the table can
//    never run past the page edge (this was the cause of the overflow bug).
//  - Layer columns get progressively less width from left to right (Layer 1
//    widest, down to the narrowest deepest layer), reflecting that the
//    left-most grouping is the primary one.
//  - Repeated values in an outer layer column are shown once per group
//    (bold, top-aligned) instead of on every row, with the horizontal rule
//    for that column suppressed until the group ends — the classic
//    "grouped ledger" look. Every column still gets full vertical rules and
//    the always-changing columns (Sr + the 5 amount columns) still get a
//    horizontal rule on every row.
//  - A subtotal row is inserted whenever the outermost (Layer 1) group ends,
//    with a grand total row at the very end.
//
function generateSaleSummaryPDF(res, { rows, from_date, to_date, company, layerLabels }) {
  const doc = new PDFDocument({ margin: 40, size: 'A4', bufferPages: true });
  doc.pipe(res);

  const companyName  = company?.name || 'Medivance';
  const left = 40, right = doc.page.width - 40, contentWidth = right - left;
  const footerOpts   = { left, right, contentWidth, companyName };
  const nLayers = layerLabels.length;

  let y = drawReportHeader(doc, {
    company, title: 'SALE SUMMARY REPORT',
    left, right, contentWidth,
  });

  // "Grouped By" sits under the Period line, not as its own header subtitle —
  // plain comma-separated text (no arrow glyphs: PDFKit's default Helvetica
  // encoding doesn't have them and renders garbage characters instead).
  y = drawFilterBox(doc, {
    left, contentWidth, y,
    filters: [
      `Period: ${from_date || 'Beginning'}  to  ${to_date || 'Present'}`,
      `Grouped By: ${layerLabels.join(', ')}`,
    ],
  });

  // ── Column layout ────────────────────────────────────────────────────────
  // Black-and-white-print friendly, whole-number amounts, and layer columns
  // sized by actual content rather than a fixed per-level rule.
  const REDUCTION = 0.85; // amount columns are 85% of their earlier width
  const amtWidth = {
    gross: Math.round(contentWidth * 0.115 * REDUCTION),
    ret:   Math.round(contentWidth * 0.105 * REDUCTION),
    net:   Math.round(contentWidth * 0.115 * REDUCTION),
    disc:  Math.round(contentWidth * 0.09  * REDUCTION),
  };
  // Sr: measured to comfortably fit a 3-digit serial number (up to 999 rows)
  // instead of the 2-digit-only width it had before.
  doc.font('Helvetica').fontSize(TABLE_FONT_SIZE);
  const srWidth = Math.ceil(doc.widthOfString('888')) + 8;

  const amtFixedSum = srWidth + amtWidth.gross + amtWidth.ret + amtWidth.net + amtWidth.disc;
  // "Recovered" is the longest header word among the amount columns, so it
  // keeps a slightly larger reservation to stay on one line.
  const RECOVERED_MIN = Math.round(contentWidth * 0.125 * REDUCTION);
  // Constant base width per layer column — no more "Layer 1 widest" rule.
  // Layers that actually hold longer text (e.g. Product, Customer names)
  // earn extra width beyond the base; layers with short values (e.g.
  // Salesman) stay close to the base. This is driven by the real data in
  // `rows`, not an assumption about which entity is picked first.
  const LAYER_BASE_WIDTH = 52;
  const poolForLayers = Math.max(nLayers * LAYER_BASE_WIDTH, contentWidth - amtFixedSum - RECOVERED_MIN);

  function measureLayerContentWidths() {
    return layerLabels.map((lbl, i) => {
      doc.font(i === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(TABLE_FONT_SIZE);
      let maxDataW = 0;
      rows.forEach(row => {
        const val = row[`layer${i + 1}`];
        if (val) {
          const w = doc.widthOfString(String(val));
          if (w > maxDataW) maxDataW = w;
        }
      });
      doc.font('Helvetica-Bold').fontSize(TABLE_HDR_FONT_SIZE);
      const headerW = doc.widthOfString(lbl);
      return Math.max(maxDataW, headerW);
    });
  }

  const contentWeights = measureLayerContentWidths().map(w => w + 20); // +epsilon so an all-blank column still gets a fair share
  const weightSum = contentWeights.reduce((a, b) => a + b, 0) || 1;
  const baseSum = LAYER_BASE_WIDTH * nLayers;
  const extraPool = Math.max(0, poolForLayers - baseSum);
  let layerColWidths = contentWeights.map(w => LAYER_BASE_WIDTH + extraPool * (w / weightSum));
  layerColWidths = layerColWidths.map(w => Math.max(LAYER_BASE_WIDTH, Math.round(w)));

  // Recovered gets whatever's left so columns sum to EXACTLY contentWidth —
  // this is what makes the "off the page" bug structurally impossible.
  const usedSoFar = srWidth + layerColWidths.reduce((a, b) => a + b, 0) + amtWidth.gross + amtWidth.ret + amtWidth.net + amtWidth.disc;
  amtWidth.rec = contentWidth - usedSoFar;

  // Build column x-positions left to right.
  let cx = left;
  const cols = [];
  cols.push({ key: 'sr', label: 'Sr', x: cx, w: srWidth, align: 'left' }); cx += srWidth;
  layerLabels.forEach((lbl, i) => {
    cols.push({ key: `layer${i + 1}`, label: lbl, x: cx, w: layerColWidths[i], align: 'left' });
    cx += layerColWidths[i];
  });
  cols.push({ key: 'gross', label: 'Gross',     x: cx, w: amtWidth.gross, align: 'right' }); cx += amtWidth.gross;
  cols.push({ key: 'ret',   label: 'Return',    x: cx, w: amtWidth.ret,   align: 'right' }); cx += amtWidth.ret;
  cols.push({ key: 'net',   label: 'Net',       x: cx, w: amtWidth.net,   align: 'right' }); cx += amtWidth.net;
  cols.push({ key: 'disc',  label: 'Dis',       x: cx, w: amtWidth.disc,  align: 'right' }); cx += amtWidth.disc;
  cols.push({ key: 'rec',   label: 'Recovered', x: cx, w: amtWidth.rec,   align: 'right' }); cx += amtWidth.rec;

  const layerColStart = 1;               // index of first layer column in `cols`
  const amtColStart = 1 + nLayers;       // index of first amount column in `cols`
  const pageBottom = getPdfContentBottom(doc);
  // Black only, everywhere — this report gets printed on black-and-white
  // office printers, so anything light gray/tinted risks disappearing.
  // Weight/line-thickness (not color) is what signals hierarchy.
  const LINE_COLOR = '#000000';

  function drawVerticalGrid(yTop, yBottom) {
    // Outer frame — a rule before Sr and after Recovered — is unconditional.
    // Internal dividers (after Sr, after each layer except the last) only
    // appear once there are 2+ layers, same rule as the web UI.
    doc.strokeColor(LINE_COLOR).lineWidth(0.5);
    doc.moveTo(left, yTop).lineTo(left, yBottom).stroke();
    doc.moveTo(right, yTop).lineTo(right, yBottom).stroke();
    if (nLayers <= 1) return;
    const srEdge = cols[0].x + cols[0].w;
    doc.moveTo(srEdge, yTop).lineTo(srEdge, yBottom).stroke();
    for (let li = 0; li < nLayers - 1; li++) {
      const edge = cols[layerColStart + li].x + cols[layerColStart + li].w;
      doc.moveTo(edge, yTop).lineTo(edge, yBottom).stroke();
    }
  }

  function drawHdr(yy) {
    doc.font('Helvetica-Bold').fontSize(TABLE_HDR_FONT_SIZE);
    // Dynamic header height: never clip a wrapped header label, even in
    // edge cases (e.g. 4 layers picked at once, squeezing column widths).
    const hdrH = measureRowHeight(
      doc, cols.map(c => ({ text: c.label, width: c.w - 8 })), TABLE_HDR_H
    );
    // No fill (transparent) and no internal vertical rules between header
    // labels — just a frame: black rule above/below, plus a vertical edge
    // at the very start (before Sr) and very end (after Recovered).
    doc.strokeColor(LINE_COLOR).lineWidth(1);
    doc.moveTo(left, yy).lineTo(right, yy).stroke();
    doc.moveTo(left, yy).lineTo(left, yy + hdrH).stroke();
    doc.moveTo(right, yy).lineTo(right, yy + hdrH).stroke();
    doc.font('Helvetica-Bold').fontSize(TABLE_HDR_FONT_SIZE).fillColor('#000');
    cols.forEach(c =>
      doc.text(c.label, c.x + 4, yy + TABLE_TOP_PAD, { width: c.w - 8, align: c.align })
    );
    doc.moveTo(left, yy + hdrH).lineTo(right, yy + hdrH).stroke();
    return yy + hdrH;
  }

  // ── Precompute, per row & layer, whether this row starts / ends a group ──
  // (page-break agnostic — purely based on the sorted data itself). Used
  // only to merge repeated values into one visual cell; subtotals are a
  // UI-only feature now (kept out of the printed PDF per feedback).
  const rowKey = (row, i) => Array.from({ length: i + 1 }, (_, k) => row[`layer${k + 1}`] || '').join('\u241F');
  const isGroupStart = rows.map((row, r) =>
    Array.from({ length: nLayers }, (_, i) => r === 0 || rowKey(row, i) !== rowKey(rows[r - 1], i))
  );
  const isGroupEnd = rows.map((row, r) =>
    Array.from({ length: nLayers }, (_, i) => r === rows.length - 1 || rowKey(row, i) !== rowKey(rows[r + 1], i))
  );

  y = drawHdr(y);
  const grandTotal = { gross: 0, ret: 0, disc: 0, net: 0, rec: 0 };
  let forcedReopen = new Array(nLayers).fill(false);

  // Whole numbers only — no decimals.
  const fmtAmt = n => Math.round(n).toString();
  function amountStrs(gross, ret, net, disc, rec) {
    return {
      grossStr: fmtAmt(gross),
      retStr:   ret  > 0 ? fmtAmt(ret)  : '\u2014',
      netStr:   fmtAmt(net),
      discStr:  disc > 0 ? fmtAmt(disc) : '\u2014',
      recStr:   rec  > 0 ? fmtAmt(rec)  : '\u2014',
    };
  }

  function buildLayerCells(r, reopen) {
    return Array.from({ length: nLayers }, (_, i) =>
      (isGroupStart[r][i] || reopen[i]) ? (rows[r][`layer${i + 1}`] || '\u2014') : ''
    );
  }

  rows.forEach((row, r) => {
    const gross = parseFloat(row.gross_amount)     || 0;
    const ret   = parseFloat(row.return_amount)    || 0;
    const disc  = parseFloat(row.discount)         || 0;
    const net   = parseFloat(row.net_amount)       || 0;
    const rec   = parseFloat(row.recovered_amount) || 0;
    grandTotal.gross += gross; grandTotal.ret += ret; grandTotal.disc += disc;
    grandTotal.net   += net;   grandTotal.rec += rec;

    const srStr = String(r + 1);
    let layerCells = buildLayerCells(r, forcedReopen);
    const { grossStr, retStr, netStr, discStr, recStr } = amountStrs(gross, ret, net, disc, rec);

    doc.font('Helvetica').fontSize(TABLE_FONT_SIZE);
    let measureCells = [
      { text: srStr, width: cols[0].w - 8 },
      ...layerCells.map((s, li) => ({ text: s, width: cols[layerColStart + li].w - 8 })),
      { text: grossStr, width: cols[amtColStart].w - 8 },
      { text: retStr,   width: cols[amtColStart + 1].w - 8 },
      { text: netStr,   width: cols[amtColStart + 2].w - 8 },
      { text: discStr,  width: cols[amtColStart + 3].w - 8 },
      { text: recStr,   width: cols[amtColStart + 4].w - 8 },
    ];
    let rowH = measureRowHeight(doc, measureCells, TABLE_MIN_ROW);

    if (y + rowH > pageBottom) {
      // The page is ending here. If a layer's group is still open (its
      // closing rule hasn't been drawn yet because the group hasn't ended
      // in the data), close it off now at the current page boundary —
      // otherwise the last row on this page is left without a bottom rule
      // for that column, and it visually "leaks" into whatever prints
      // below it. The group's value simply reprints at the top of the
      // next page (via forcedReopen below), same as a normal group break.
      doc.strokeColor(LINE_COLOR).lineWidth(0.5);
      for (let li = 0; li < nLayers; li++) {
        if (!isGroupStart[r][li]) {
          doc.moveTo(cols[layerColStart + li].x, y).lineTo(cols[layerColStart + li].x + cols[layerColStart + li].w, y).stroke();
        }
      }
      doc.addPage(); y = doc.page.margins.top; y = drawHdr(y);
      // Any layer still mid-group when the page broke gets its label
      // reprinted at the top of the new page, so the reader never loses
      // track of which group they're looking at.
      forcedReopen = Array.from({ length: nLayers }, (_, i) => !isGroupStart[r][i]);
      layerCells = buildLayerCells(r, forcedReopen);
      measureCells = [
        { text: srStr, width: cols[0].w - 8 },
        ...layerCells.map((s, li) => ({ text: s, width: cols[layerColStart + li].w - 8 })),
        { text: grossStr, width: cols[amtColStart].w - 8 },
        { text: retStr,   width: cols[amtColStart + 1].w - 8 },
        { text: netStr,   width: cols[amtColStart + 2].w - 8 },
        { text: discStr,  width: cols[amtColStart + 3].w - 8 },
        { text: recStr,   width: cols[amtColStart + 4].w - 8 },
      ];
      rowH = measureRowHeight(doc, measureCells, TABLE_MIN_ROW);
    }

    doc.font('Helvetica').fontSize(TABLE_FONT_SIZE).fillColor('#000');
    doc.text(srStr, cols[0].x + 4, y + TABLE_TOP_PAD, { width: cols[0].w - 8, lineBreak: false });
    layerCells.forEach((s, li) => {
      if (!s) return; // merged into the group's opening row — leave blank
      // Layer 1 (the primary/outermost grouping) is bolded for visual
      // hierarchy; deeper layers stay regular weight. Bold, not color.
      doc.font(li === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(TABLE_FONT_SIZE).fillColor('#000');
      doc.text(s, cols[layerColStart + li].x + 4, y + TABLE_TOP_PAD, { width: cols[layerColStart + li].w - 8 });
    });
    doc.font('Helvetica').fontSize(TABLE_FONT_SIZE).fillColor('#000');
    doc.text(grossStr, cols[amtColStart].x + 4, y + TABLE_TOP_PAD, { width: cols[amtColStart].w - 8, align: 'right', lineBreak: false });
    doc.text(retStr,   cols[amtColStart + 1].x + 4, y + TABLE_TOP_PAD, { width: cols[amtColStart + 1].w - 8, align: 'right', lineBreak: false });
    doc.text(netStr,   cols[amtColStart + 2].x + 4, y + TABLE_TOP_PAD, { width: cols[amtColStart + 2].w - 8, align: 'right', lineBreak: false });
    doc.text(discStr,  cols[amtColStart + 3].x + 4, y + TABLE_TOP_PAD, { width: cols[amtColStart + 3].w - 8, align: 'right', lineBreak: false });
    doc.text(recStr,   cols[amtColStart + 4].x + 4, y + TABLE_TOP_PAD, { width: cols[amtColStart + 4].w - 8, align: 'right', lineBreak: false });

    // Vertical grid for this row's full height, always.
    drawVerticalGrid(y, y + rowH);
    // Horizontal rule: always under Sr + amount columns; under a layer
    // column only once its group has actually ended (so a multi-row group
    // reads as one continuous merged cell instead of being sliced up).
    doc.strokeColor(LINE_COLOR).lineWidth(0.5);
    doc.moveTo(cols[0].x, y + rowH).lineTo(cols[0].x + cols[0].w, y + rowH).stroke();
    layerCells.forEach((_, li) => {
      if (isGroupEnd[r][li]) {
        doc.moveTo(cols[layerColStart + li].x, y + rowH).lineTo(cols[layerColStart + li].x + cols[layerColStart + li].w, y + rowH).stroke();
      }
    });
    doc.moveTo(cols[amtColStart].x, y + rowH).lineTo(right, y + rowH).stroke();

    y += rowH;
    forcedReopen = new Array(nLayers).fill(false);
  });

  // ── Grand total ───────────────────────────────────────────────────────────
  if (y + TABLE_MIN_ROW + 10 > pageBottom) { doc.addPage(); y = doc.page.margins.top; y = drawHdr(y); }
  y += 4;
  doc.strokeColor(LINE_COLOR).lineWidth(1.25);
  doc.moveTo(left, y).lineTo(right, y).stroke();
  y += 6;
  const gt = amountStrs(grandTotal.gross, grandTotal.ret, grandTotal.net, grandTotal.disc, grandTotal.rec);
  doc.font('Helvetica-Bold').fontSize(TABLE_FONT_SIZE + 0.5).fillColor('#000');
  const totalLabelWidth = cols[amtColStart].x - cols[0].x;
  doc.text('GRAND TOTAL', cols[0].x + 4, y, { width: totalLabelWidth - 8, lineBreak: false });
  doc.text(gt.grossStr, cols[amtColStart].x + 4, y, { width: cols[amtColStart].w - 8, align: 'right', lineBreak: false });
  doc.text(gt.retStr,   cols[amtColStart + 1].x + 4, y, { width: cols[amtColStart + 1].w - 8, align: 'right', lineBreak: false });
  doc.text(gt.netStr,   cols[amtColStart + 2].x + 4, y, { width: cols[amtColStart + 2].w - 8, align: 'right', lineBreak: false });
  doc.text(gt.discStr,  cols[amtColStart + 3].x + 4, y, { width: cols[amtColStart + 3].w - 8, align: 'right', lineBreak: false });
  doc.text(gt.recStr,   cols[amtColStart + 4].x + 4, y, { width: cols[amtColStart + 4].w - 8, align: 'right', lineBreak: false });

  stampPdfFootersOnAllPages(doc, footerOpts);
  doc.flushPages();
  doc.end();
}

module.exports = router;