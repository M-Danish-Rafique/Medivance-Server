const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');
const PDFDocument = require('pdfkit');
const { drawPdfLogo, drawPdfFooterAtBottom, ensureSpace } = require('../utils/pdfHelpers');

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
  const doc = new PDFDocument({ margin: 40, size: 'A4' });
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

  const pageBottom = doc.page.height - 72;

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

  drawPdfFooterAtBottom(doc, { left, right, contentWidth, companyName });

  doc.end();
}

module.exports = router;
