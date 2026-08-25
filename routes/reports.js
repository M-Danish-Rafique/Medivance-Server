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

// â”€â”€â”€ Shared PDF constants â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// All three reports (Ledger, Sales, Recovery) use identical table typography
// so rows look consistent across the system.
//
const TABLE_FONT_SIZE     = 8.5;   // data rows
const TABLE_HDR_FONT_SIZE = 8.5;   // column headers  (same weight, Bold applied separately)
const TABLE_HDR_H         = 20;    // fixed header-row height
const TABLE_MIN_ROW       = 18;    // minimum data-row height
const TABLE_TOP_PAD       = 4;     // top padding inside every row (y + TOP_PAD when drawing)

// â”€â”€â”€ Supplier Ledger â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ Customer Ledger â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ PDF: Supplier Ledger â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ PDF: Customer Ledger â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ generateLedgerPDF â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function generateLedgerPDF(res, { type, entity, ledger, openingBalance, from_date, to_date, company }) {
  const doc = new PDFDocument({ margin: 40, size: 'A4', bufferPages: true });
  doc.pipe(res);

  const companyName    = company?.name    || 'Medivance';
  const companyAddress = company?.address || '';
  const companyContact = [company?.phone, company?.email].filter(Boolean).join('   |   ');

  const pageWidth    = doc.page.width;
  const left = 40, right = pageWidth - 40, contentWidth = right - left;

  // â”€â”€ Page header â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // â”€â”€ Entity details box â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // â”€â”€ Column layout â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // â”€â”€ Opening balance row â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    const balStr = `${Math.abs(runningBalance).toFixed(2)} ${runningBalance >= 0 ? 'Dr' : 'Cr'}`;
    doc.font('Helvetica-Bold').fontSize(TABLE_FONT_SIZE).fillColor('#000');
    doc.text('â€”',               cols.date.x,    y + TABLE_TOP_PAD, { width: cols.date.w,        lineBreak: false });
    doc.text('â€”',               cols.invoice.x, y + TABLE_TOP_PAD, { width: cols.invoice.w,     lineBreak: false });
    doc.text('Opening Balance', cols.desc.x,    y + TABLE_TOP_PAD, { width: cols.desc.w,        lineBreak: false });
    doc.text('â€”',               cols.dr.x,      y + TABLE_TOP_PAD, { width: cols.dr.w - 4,      align: 'right', lineBreak: false });
    doc.text('â€”',               cols.cr.x,      y + TABLE_TOP_PAD, { width: cols.cr.w - 4,      align: 'right', lineBreak: false });
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
    const invoiceStr = row.invoice_no  || 'â€”';
    const descStr    = row.description || 'â€”';
    const drStr      = dr > 0 ? dr.toFixed(2) : 'â€”';
    const crStr      = cr > 0 ? cr.toFixed(2) : 'â€”';
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

  // â”€â”€ Totals & closing balance â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€ Sales report data â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function fetchSalesReportData({ from_date, to_date, salesman_id }) {
  // NOTE: s.total_amount reflects the invoice's NET value â€” for invoices that had
  // a "current invoice" return processed against them (unlocked branch in
  // recoveries.js), total_amount is recalculated down to what's left after that
  // return. So total_amount is the correct NET figure, not the gross sale value.
  // Gross is reconstructed by adding back what was discounted/returned.

  let sql = `
    SELECT s.id, s.date, s.invoice_no, c.name AS customer_name,
           e.name AS salesman_name,
           s.total_amount AS gross_amount, 
           COALESCE(r_agg.total_return_amount, 0) AS return_amount,
           COALESCE(r_agg.total_discount, 0) AS discount,
           (s.total_amount - COALESCE(r_agg.total_return_amount, 0) - COALESCE(r_agg.total_discount, 0)) AS net_amount,
           COALESCE(r_agg.net_collected, 0) AS recovered_amount
    FROM sales s
    JOIN customers c ON s.customer_id = c.id
    LEFT JOIN employees e ON s.salesman_id = e.id
    LEFT JOIN (
      SELECT sale_id, SUM(total_return_amount) AS total_return_amount, SUM(total_discount) AS total_discount, SUM(net_collected) AS net_collected
      FROM recoveries GROUP BY sale_id
    ) r_agg ON r_agg.sale_id = s.id
    WHERE 1=1`;
  const params = [];
  if (from_date)   { sql += ' AND s.date >= ?'; params.push(from_date); }
  if (to_date)     { sql += ' AND s.date <= ?'; params.push(to_date);   }
  if (salesman_id) { sql += ' AND s.salesman_id = ?'; params.push(salesman_id); }
  sql += ' ORDER BY s.date ASC, s.id ASC';
  const [rows] = await db.query(sql, params);
  return rows;
}

// â”€â”€â”€ Recovery report data â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function fetchRecoveryReportData({ from_date, to_date, supplier_id }) {
  // NOTE: s.total_amount is the invoice's NET value (see fetchSalesReportData
  // above), so gross here is reconstructed by adding back what was recovered
  // in cash plus what was given away as discount/return for this recovery event.
  let sql = `
    SELECT
      r.id,
      r.date,
      r.sale_id,
      c.name AS customer_name,
      s.invoice_no,
      s.total_amount AS sale_total_amount,
      COALESCE(r.total_return_amount, 0) AS total_return_amount,
      COALESCE(r.total_discount, 0) AS total_discount,
      COALESCE(r.net_collected, 0) AS net_collected,
      COALESCE(r.pending_amount, NULL) AS pending_amount
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

  // Post-process: compute sequential gross/net per sale_id (ordered by date)
  const bySale = new Map();
  for (const r of rows) {
    const key = String(r.sale_id || '');
    if (!bySale.has(key)) bySale.set(key, []);
    bySale.get(key).push(r);
  }

  const out = [];
  for (const [saleId, recs] of bySale.entries()) {
    // sort by date then id just to be safe
    recs.sort((a, b) => new Date(a.date) - new Date(b.date) || a.id - b.id);
    let prevPending = parseFloat(recs[0].sale_total_amount) || 0; // initial gross = sale total
    for (const r of recs) {
      const discount = parseFloat(r.total_discount) || 0;
      const ret = parseFloat(r.total_return_amount) || 0;
      const recov = parseFloat(r.net_collected) || 0;
      const gross = prevPending;
      const net_pending = gross - discount - ret - recov;
      prevPending = net_pending;

      out.push({
        id: r.id,
        date: r.date,
        sale_id: saleId,
        invoice_no: r.invoice_no,
        customer_name: r.customer_name,
        gross_amount: gross,
        discount: discount,
        return_amount: ret,
        recovered_amount: recov,
        net_pending: net_pending,
      });
    }
  }

  return out;
}


// â”€â”€â”€ JSON endpoints â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ PDF endpoints â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ generateSalesReportPDF â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
    { label: 'Disc.',     w: 58, align: 'right' },
    { label: 'Return',    w: 52, align: 'right' },
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
    const disc  = parseFloat(row.discount)        || 0;
    const ret   = parseFloat(row.return_amount)   || 0;
    const net   = parseFloat(row.net_amount)      || 0;
    const rec   = parseFloat(row.recovered_amount)|| 0;
    totals.gross += gross; totals.ret += ret; totals.disc += disc;
    totals.net   += net;   totals.rec += rec;

    const srStr      = String(i + 1);
    const dateStr    = formatDatePKT(row.date);
    const invoiceStr = row.invoice_no    || 'â€”';
    const custStr    = row.customer_name || 'â€”';
    const grossStr   = gross.toFixed(2);
    const discStr    = disc > 0 ? disc.toFixed(2) : 'â€”';
    const retStr     = ret  > 0 ? ret.toFixed(2)  : 'â€”';
    const netStr     = net.toFixed(2);
    const recStr     = rec  > 0 ? rec.toFixed(2)  : 'â€”';

    // Must set font before measuring
    doc.font('Helvetica').fontSize(TABLE_FONT_SIZE);
    const rowH = measureRowHeight(doc, [
      { text: srStr,      width: cols[0].w - 4 },
      { text: dateStr,    width: cols[1].w - 4 },
      { text: invoiceStr, width: cols[2].w - 4 },
      { text: custStr,    width: cols[3].w - 4 },  // flex col â€“ most likely to wrap
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
    doc.text(discStr,    cols[5].x + 2, y + TABLE_TOP_PAD, { width: cols[5].w - 4, align: 'right', lineBreak: false });
    doc.text(retStr,     cols[6].x + 2, y + TABLE_TOP_PAD, { width: cols[6].w - 4, align: 'right', lineBreak: false });
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
  doc.text(totals.disc.toFixed(2),   cols[5].x + 2, y, { width: cols[5].w - 4, align: 'right', lineBreak: false });
  doc.text(totals.ret.toFixed(2),    cols[6].x + 2, y, { width: cols[6].w - 4, align: 'right', lineBreak: false });
  doc.text(totals.net.toFixed(2),    cols[7].x + 2, y, { width: cols[7].w - 4, align: 'right', lineBreak: false });
  doc.text(totals.rec.toFixed(2),    cols[8].x + 2, y, { width: cols[8].w - 4, align: 'right', lineBreak: false });

  stampPdfFootersOnAllPages(doc, footerOpts);
  doc.flushPages();
  doc.end();
}

// â”€â”€â”€ generateRecoveryReportPDF â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
    { label: 'Sr',             w: 21 },
    { label: 'Date',           w: 56 },
    { label: 'Invoice',        w: 60 },
    { label: 'Customer',       w: 'flex' },
    { label: 'Gross Pending',  w: 64, align: 'right' },
    { label: 'Disc.',          w: 58, align: 'right' },
    { label: 'Return',         w: 58, align: 'right' },
    { label: 'Recovered',      w: 64, align: 'right' },
    { label: 'Pending',        w: 72, align: 'right' },
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
  const totals = { gross: 0, rec: 0, disc: 0, ret: 0, pending: 0 };

  rows.forEach((row, i) => {
    const gross   = parseFloat(row.gross_amount)    || 0;
    const disc    = parseFloat(row.discount)        || 0;
    const ret     = parseFloat(row.return_amount)   || 0;
    const rec     = parseFloat(row.recovered_amount)|| 0;
    const pending = parseFloat(row.net_pending)     || 0;
    totals.gross += gross; totals.rec += rec; totals.ret += ret; totals.disc += disc; totals.pending += pending;

    const srStr      = String(i + 1);
    const dateStr    = formatDatePKT(row.date);
    const invoiceStr = row.invoice_no || 'â€”';
    const custStr    = row.customer_name || 'â€”';
    const grossStr   = gross.toFixed(2);
    const discStr    = disc > 0 ? disc.toFixed(2) : 'â€”';
    const retStr     = ret  > 0 ? ret.toFixed(2)  : 'â€”';
    const recStr     = rec.toFixed(2);
    const pendingStr = pending.toFixed(2);

    // Must set font before measuring
    doc.font('Helvetica').fontSize(TABLE_FONT_SIZE);
    const rowH = measureRowHeight(doc, [
      { text: srStr,      width: cols[0].w - 4 },
      { text: dateStr,    width: cols[1].w - 4 },
      { text: invoiceStr, width: cols[2].w - 4 },
      { text: custStr,    width: cols[3].w - 4 },  // flex col â€“ most likely to wrap
      { text: grossStr,   width: cols[4].w - 4 },
      { text: discStr,    width: cols[5].w - 4 },
      { text: retStr,     width: cols[6].w - 4 },
      { text: recStr,     width: cols[7].w - 4 },
      { text: pendingStr, width: cols[8].w - 4 },
    ], TABLE_MIN_ROW);

    if (y + rowH > pageBottom) { doc.addPage(); y = doc.page.margins.top; y = drawHdr(y); }

    doc.font('Helvetica').fontSize(TABLE_FONT_SIZE).fillColor('#000');
    doc.text(srStr,      cols[0].x + 2, y + TABLE_TOP_PAD, { width: cols[0].w - 4, lineBreak: false });
    doc.text(dateStr,    cols[1].x + 2, y + TABLE_TOP_PAD, { width: cols[1].w - 4, lineBreak: false });
    doc.text(invoiceStr, cols[2].x + 2, y + TABLE_TOP_PAD, { width: cols[2].w - 4, lineBreak: false });
    doc.text(custStr,    cols[3].x + 2, y + TABLE_TOP_PAD, { width: cols[3].w - 4 }); // wraps freely
    doc.text(grossStr,   cols[4].x + 2, y + TABLE_TOP_PAD, { width: cols[4].w - 4, align: 'right', lineBreak: false });
    doc.text(discStr,    cols[5].x + 2, y + TABLE_TOP_PAD, { width: cols[5].w - 4, align: 'right', lineBreak: false });
    doc.text(retStr,     cols[6].x + 2, y + TABLE_TOP_PAD, { width: cols[6].w - 4, align: 'right', lineBreak: false });
    doc.text(recStr,     cols[7].x + 2, y + TABLE_TOP_PAD, { width: cols[7].w - 4, align: 'right', lineBreak: false });
    doc.text(pendingStr, cols[8].x + 2, y + TABLE_TOP_PAD, { width: cols[8].w - 4, align: 'right', lineBreak: false });
    y += rowH;
  });

  doc.moveTo(left, y).lineTo(right, y).stroke();
  y += 8;
  y = ensureSpace(doc, y, 24);

  doc.font('Helvetica-Bold').fontSize(TABLE_FONT_SIZE);
  doc.text('TOTAL',                    cols[3].x + 2, y, { width: cols[3].w - 4,  lineBreak: false });
  doc.text(totals.gross.toFixed(2),    cols[4].x + 2, y, { width: cols[4].w - 4, align: 'right', lineBreak: false });
  doc.text(totals.disc.toFixed(2),     cols[5].x + 2, y, { width: cols[5].w - 4, align: 'right', lineBreak: false });
  doc.text(totals.ret.toFixed(2),      cols[6].x + 2, y, { width: cols[6].w - 4, align: 'right', lineBreak: false });
  doc.text(totals.rec.toFixed(2),      cols[7].x + 2, y, { width: cols[7].w - 4, align: 'right', lineBreak: false });
  doc.text(totals.pending.toFixed(2),  cols[8].x + 2, y, { width: cols[8].w - 4, align: 'right', lineBreak: false });

  stampPdfFootersOnAllPages(doc, footerOpts);
  doc.flushPages();
  doc.end();
}

// â”€â”€â”€ Sale Summary (multi-level / layered) report â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Lets the user pick up to 4 "layers" â€” an ordered, de-duplicated combination
// of Salesman / Company / Product / Customer â€” and returns sales aggregated
// (grouped) by that combination. Layer 1 is required; Layers 2-4 are optional
// ("skip further layers" in the UI just means fewer entries in `layers`).
//
// Single source of truth (post 2026-08 refactor)
// ----------------------------------------------
// Every layer combination now aggregates off `sale_items`, using the
// per-line cumulatives maintained by the recovery flow:
//
//   sale_items.total              â†’ gross_amount    (tax-inclusive line total)
//   sale_items.recovery_discount  â†’ discount        (invariant 4: SUM = sales.total_discount)
//   sale_items.recovered_amount   â†’ recovered_amount(invariant 5: SUM = sales.total_recovered)
//   return_items via subquery     â†’ return_amount   (per sale_item, no duplication)
//
// This kills the drift that the previous two-branch design had: the
// invoice-level path (salesman / customer) and the item-level path
// (company / product) used different sources for Return and Recovered
// and disagreed by the amount of cross-invoice returns + un-attributed
// cash. Now every layer produces the same numbers by construction because
// the underlying per-line columns are what the recovery flow keeps in
// sync with `sales.total_*` on every write (see recoveries.js invariants).
//
// Salesman and Customer live on `sales`, so they're pulled via the
// mandatory JOIN to sales; Product and Company live on `products`, pulled
// via sale_items.product_id â†’ products â†’ companies. No conditional SQL
// paths â€” one query serves every layer combination.

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
  // Salesman/Customer come off the sales row; Product/Company come off
  // the sale_items â†’ products join. Both are always available because
  // the query aggregates at sale_item grain regardless of which layers
  // were requested. Unassigned salesmen / uncategorized products render
  // as NULL â†’ the UI/PDF prints "â€”".
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
  // first â€” so "â€”" rows land at the bottom of the report, not the top.
  const orderCols = layers.map((_, i) => `layer${i + 1} IS NULL, layer${i + 1}`).join(', ');

  const params = [];
  let sql = `
    SELECT
      ${selectCols},
      SUM(si.total)                             AS gross_amount,
      SUM(COALESCE(ri.ret, 0))                  AS return_amount,
      SUM(si.recovery_discount)                 AS discount,
      SUM(si.total
          - COALESCE(ri.ret, 0)
          - si.recovery_discount)               AS net_amount,
      SUM(si.recovered_amount)                  AS recovered_amount
    FROM sale_items si
    JOIN sales      s    ON si.sale_id     = s.id
    JOIN customers  c    ON s.customer_id  = c.id
    LEFT JOIN employees e_sm ON s.salesman_id = e_sm.id
    JOIN products   p    ON si.product_id  = p.id
    LEFT JOIN companies co ON p.company_id = co.id
    LEFT JOIN (
      SELECT sale_item_id, SUM(return_amount) AS ret
        FROM return_items
       GROUP BY sale_item_id
    ) ri ON ri.sale_item_id = si.id
    WHERE 1=1`;
  if (from_date) { sql += ' AND s.date >= ?'; params.push(from_date); }
  if (to_date)   { sql += ' AND s.date <= ?'; params.push(to_date);   }
  sql += ` GROUP BY ${groupCols} ORDER BY ${orderCols}`;

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

// â”€â”€â”€ generateSaleSummaryPDF â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
//    for that column suppressed until the group ends â€” the classic
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

  // "Grouped By" sits under the Period line, not as its own header subtitle â€”
  // plain comma-separated text (no arrow glyphs: PDFKit's default Helvetica
  // encoding doesn't have them and renders garbage characters instead).
  y = drawFilterBox(doc, {
    left, contentWidth, y,
    filters: [
      `Period: ${from_date || 'Beginning'}  to  ${to_date || 'Present'}`,
      `Grouped By: ${layerLabels.join(', ')}`,
    ],
  });

  // â”€â”€ Column layout â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Black-and-white-print friendly, whole-number amounts, and layer columns
  // sized by actual content rather than a fixed per-level rule.
  const REDUCTION = 0.85; // amount columns are 85% of their earlier width
  const amtWidth = {
    gross: Math.round(contentWidth * 0.115 * REDUCTION),
    disc:  Math.round(contentWidth * 0.105 * REDUCTION),
    ret:   Math.round(contentWidth * 0.095 * REDUCTION),
    net:   Math.round(contentWidth * 0.115 * REDUCTION),
  };
  // Sr: measured to comfortably fit a 3-digit serial number (up to 999 rows)
  // instead of the 2-digit-only width it had before.
  doc.font('Helvetica').fontSize(TABLE_FONT_SIZE);
  const srWidth = Math.ceil(doc.widthOfString('888')) + 8;

  const amtFixedSum = srWidth + amtWidth.gross + amtWidth.disc + amtWidth.ret + amtWidth.net;
  // "Recovered" is the longest header word among the amount columns, so it
  // keeps a slightly larger reservation to stay on one line.
  const RECOVERED_MIN = Math.round(contentWidth * 0.125 * REDUCTION);
  // Constant base width per layer column â€” no more "Layer 1 widest" rule.
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

  // Recovered gets whatever's left so columns sum to EXACTLY contentWidth â€”
  // this is what makes the "off the page" bug structurally impossible.
  const usedSoFar = srWidth + layerColWidths.reduce((a, b) => a + b, 0) + amtWidth.gross + amtWidth.disc + amtWidth.ret + amtWidth.net;
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
  cols.push({ key: 'disc',  label: 'Disc',      x: cx, w: amtWidth.disc,  align: 'right' }); cx += amtWidth.disc;
  cols.push({ key: 'ret',   label: 'Return',    x: cx, w: amtWidth.ret,   align: 'right' }); cx += amtWidth.ret;
  cols.push({ key: 'net',   label: 'Net',       x: cx, w: amtWidth.net,   align: 'right' }); cx += amtWidth.net;
  cols.push({ key: 'rec',   label: 'Recovered', x: cx, w: amtWidth.rec,   align: 'right' }); cx += amtWidth.rec;

  const layerColStart = 1;               // index of first layer column in `cols`
  const amtColStart = 1 + nLayers;       // index of first amount column in `cols`
  const pageBottom = getPdfContentBottom(doc);
  // Black only, everywhere â€” this report gets printed on black-and-white
  // office printers, so anything light gray/tinted risks disappearing.
  // Weight/line-thickness (not color) is what signals hierarchy.
  const LINE_COLOR = '#000000';

  function drawVerticalGrid(yTop, yBottom) {
    // Outer frame â€” a rule before Sr and after Recovered â€” is unconditional.
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
    // labels â€” just a frame: black rule above/below, plus a vertical edge
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

  // â”€â”€ Precompute, per row & layer, whether this row starts / ends a group â”€â”€
  // (page-break agnostic â€” purely based on the sorted data itself). Used
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

  // Whole numbers only â€” no decimals.
  const fmtAmt = n => Math.round(n).toString();
  function amountStrs(gross, ret, net, disc, rec) {
    return {
      grossStr: fmtAmt(gross),
      discStr:  disc > 0 ? fmtAmt(disc) : '\u2014',
      retStr:   ret  > 0 ? fmtAmt(ret)  : '\u2014',
      netStr:   fmtAmt(net),
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
    const { grossStr, discStr, retStr, netStr, recStr } = amountStrs(gross, ret, net, disc, rec);

    doc.font('Helvetica').fontSize(TABLE_FONT_SIZE);
    let measureCells = [
      { text: srStr, width: cols[0].w - 8 },
      ...layerCells.map((s, li) => ({ text: s, width: cols[layerColStart + li].w - 8 })),
      { text: grossStr, width: cols[amtColStart].w - 8 },
      { text: discStr,  width: cols[amtColStart + 1].w - 8 },
      { text: retStr,   width: cols[amtColStart + 2].w - 8 },
      { text: netStr,   width: cols[amtColStart + 3].w - 8 },
      { text: recStr,   width: cols[amtColStart + 4].w - 8 },
    ];
    let rowH = measureRowHeight(doc, measureCells, TABLE_MIN_ROW);

    if (y + rowH > pageBottom) {
      // The page is ending here. If a layer's group is still open (its
      // closing rule hasn't been drawn yet because the group hasn't ended
      // in the data), close it off now at the current page boundary â€”
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
        { text: discStr,  width: cols[amtColStart + 1].w - 8 },
        { text: retStr,   width: cols[amtColStart + 2].w - 8 },
        { text: netStr,   width: cols[amtColStart + 3].w - 8 },
        { text: recStr,   width: cols[amtColStart + 4].w - 8 },
      ];
      rowH = measureRowHeight(doc, measureCells, TABLE_MIN_ROW);
    }

    doc.font('Helvetica').fontSize(TABLE_FONT_SIZE).fillColor('#000');
    doc.text(srStr, cols[0].x + 4, y + TABLE_TOP_PAD, { width: cols[0].w - 8, lineBreak: false });
    layerCells.forEach((s, li) => {
      if (!s) return; // merged into the group's opening row â€” leave blank
      // Layer 1 (the primary/outermost grouping) is bolded for visual
      // hierarchy; deeper layers stay regular weight. Bold, not color.
      doc.font(li === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(TABLE_FONT_SIZE).fillColor('#000');
      doc.text(s, cols[layerColStart + li].x + 4, y + TABLE_TOP_PAD, { width: cols[layerColStart + li].w - 8 });
    });
    doc.font('Helvetica').fontSize(TABLE_FONT_SIZE).fillColor('#000');
    doc.text(grossStr, cols[amtColStart].x + 4, y + TABLE_TOP_PAD, { width: cols[amtColStart].w - 8, align: 'right', lineBreak: false });
    doc.text(discStr,  cols[amtColStart + 1].x + 4, y + TABLE_TOP_PAD, { width: cols[amtColStart + 1].w - 8, align: 'right', lineBreak: false });
    doc.text(retStr,   cols[amtColStart + 2].x + 4, y + TABLE_TOP_PAD, { width: cols[amtColStart + 2].w - 8, align: 'right', lineBreak: false });
    doc.text(netStr,   cols[amtColStart + 3].x + 4, y + TABLE_TOP_PAD, { width: cols[amtColStart + 3].w - 8, align: 'right', lineBreak: false });
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

  // â”€â”€ Grand total â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
  doc.text(gt.discStr,  cols[amtColStart + 1].x + 4, y, { width: cols[amtColStart + 1].w - 8, align: 'right', lineBreak: false });
  doc.text(gt.retStr,   cols[amtColStart + 2].x + 4, y, { width: cols[amtColStart + 2].w - 8, align: 'right', lineBreak: false });
  doc.text(gt.netStr,   cols[amtColStart + 3].x + 4, y, { width: cols[amtColStart + 3].w - 8, align: 'right', lineBreak: false });
  doc.text(gt.recStr,   cols[amtColStart + 4].x + 4, y, { width: cols[amtColStart + 4].w - 8, align: 'right', lineBreak: false });

  stampPdfFootersOnAllPages(doc, footerOpts);
  doc.flushPages();
  doc.end();
}


// â”€â”€â”€ Sale & Stock Report â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Product-level "how much did we have, buy, sell, take back, and end with"
// report over a date window, with an optional company filter.
//
// Columns (all consolidated across batches for a product):
//   Sr | Product | Pack Size | Opening | Purchase | Adjustment |
//   Gross Sale | Return | Net Sale (Unit) | Net Sale (Value) | Closing
//
// Balance identity (always holds by construction)
// -----------------------------------------------
//   Closing = Opening + Purchase + Adjustment âˆ’ Gross Sale + Return
//
//   "Purchase" is a physical INFLOW column â€” units purchased in the period
//   plus units yielded from manufacturing (mfg_yield_items with
//   added_to_inventory=1). Both are treated the same by the balance
//   identity because they add sellable stock to inventory.
//
//   "Adjustment" is a SIGNED column carrying the NET manual/adjustment
//   movement in the period (Add Inventory Manually, Edit Inventory Â±, and
//   the rare `adjustment` ref_type). Positive = stock added, negative =
//   stock removed. Split into its own column so the identity holds and
//   nothing gets silently swept into Opening/Closing.
//
// Key rules
// ---------
//  1. Batches are NEVER split. One row per product.
//  2. `Gross Sale (qty)`   = SUM(sale_items.qty + bonus)  where sales.date âˆˆ window.
//     Bonus units come off the shelves, so they count.
//  3. `Return (qty)`       = SUM(return_items.qty_returned) where recoveries.date âˆˆ window.
//     A return may hit an invoice from any earlier period.
//  4. `Purchase (qty)`     = SUM(purchase_items.qty + bonus) where purchases.date âˆˆ window
//                          + SUM(mfg_yield_items.units_manufactured) where mfg_yields.created_at âˆˆ window
//                            AND mfg_yield_items.added_to_inventory = 1.
//  5. `Adjustment (qty)`   = SUM(qty_in - qty_out) from inventory_movements
//                            where movement_date âˆˆ window
//                            AND ref_type IN ('inventory_manual','adjustment').
//  6. `Net Sale (Value)`   = SUM(sale_items.total)         [sales.date filter]
//                          âˆ’ SUM(recovery_items.discount_given) [recoveries.date filter]
//                          âˆ’ SUM(return_items.return_amount)    [recoveries.date filter]
//     This deliberately does NOT do (net_units Ã— standard_rate) â€” that
//     approach silently drops line-level and recovery-time discounts.
//  7. `Opening Stock` at from_date is reconstructed from CURRENT physical
//     stock by rolling back every activity from from_date onwards, using
//     SOURCE TABLES (sales, returns, purchases, mfg_yields) â€” not the
//     inventory_movements journal. This makes the report reliable across
//     the 2026-08-22 refactor boundary, since source tables carry the
//     full historical record while the journal only covers post-refactor
//     movements. Manual `inventory_manual` and `adjustment` corrections
//     still come from inventory_movements (it's the only source of truth
//     for those):
//        opening = current_stock
//                + sales_since_D             [add back what was sold]
//                âˆ’ returns_since_D           [subtract returns received]
//                âˆ’ purchases_since_D         [subtract purchases received]
//                âˆ’ mfg_since_D               [subtract manufacturing yields]
//                âˆ’ manual_net_since_D        [subtract net manual movements]
//  8. `Closing Stock` is derived from the same source aggregates, so the
//     balance identity above is EXACT â€” no drift between rows and totals.
//     When to_date = today, Closing exactly matches current physical stock.
//
// Required inputs
// ---------------
//  Both from_date and to_date are REQUIRED. An unbounded window produces
//  nonsensical numbers (opening = current physical stock, gross = every
//  sale ever), which is exactly the shipping bug this rewrite fixes.
//
// Idle-product filter
// -------------------
//  Products with zero opening AND zero activity in the window are hidden
//  so the operator sees only movers/holders.
//
// SQL naming convention (defensive)
// ---------------------------------
//  Every derived-table column is given a UNIQUE alias that is NOT reused
//  as an outer SELECT alias anywhere in the statement. This is deliberate:
//  if a derived table's column has the same name as an outer SELECT alias,
//  MySQL's HAVING clause resolution can pick either one (server-version
//  and sql_mode dependent), which caused a "purchase_qty always 0"
//  regression. Aliases: `qty_after_*` for roll-back subqueries,
//  `qty_in_*` for in-period aggregates, `val_*` for values.

async function fetchSaleAndStockReportData({ from_date, to_date, company_id }) {
  if (!from_date || !to_date) {
    const err = new Error('from_date and to_date are required');
    err.status = 400;
    throw err;
  }

  const params = [];
  //   openingCutoff â€” used 5x (sales_since, returns_since, purchases_since,
  //                            mfg_since, manual_net_since)
  //   winFrom/winTo â€” used 7x (gross, return, purchase, mfg, manual (in
  //                            period), gross_value, discount_value,
  //                            return_value)
  const openingCutoff = from_date;
  const winFrom       = from_date;
  const winTo         = to_date;

  // Roll-back subqueries (one push per subquery param) â€” one placeholder per ?
  // in the SQL below, in top-to-bottom order.
  params.push(openingCutoff);                    // sRB   sales_since
  params.push(openingCutoff);                    // reRB  returns_since
  params.push(openingCutoff);                    // puRB  purchases_since
  params.push(openingCutoff);                    // mfRB  mfg_since
  params.push(openingCutoff);                    // mnRB  manual_since
  params.push(winFrom, winTo);                   // sIn   gross_qty (in period)
  params.push(winFrom, winTo);                   // reIn  return_qty (in period)
  params.push(winFrom, winTo);                   // puIn  purchase_qty (in period)
  params.push(winFrom, winTo);                   // mfIn  mfg_qty (in period)
  params.push(winFrom, winTo);                   // mnIn  manual_qty (in period)
  params.push(winFrom, winTo);                   // gvIn  gross_value
  params.push(winFrom, winTo);                   // dgIn  discount_value
  params.push(winFrom, winTo);                   // rvIn  return_value

  let sql = `
    SELECT
      p.id                                              AS product_id,
      p.name                                            AS product_name,
      p.pack_size                                       AS pack_size,
      p.company_id                                      AS company_id,
      co.name                                           AS company_name,
      (
        COALESCE(inv.total_qty,           0)
        + COALESCE(sRB.qty_after_sale,    0)
        - COALESCE(reRB.qty_after_ret,    0)
        - COALESCE(puRB.qty_after_pur,    0)
        - COALESCE(mfRB.qty_after_mfg,    0)
        - COALESCE(mnRB.qty_after_manual, 0)
      )                                                 AS opening_stock,
      COALESCE(sIn.qty_in_gross,           0)           AS gross_qty,
      COALESCE(reIn.qty_in_return,         0)           AS return_qty,
      (COALESCE(puIn.qty_in_purchase,      0)
        + COALESCE(mfIn.qty_in_mfg,        0))          AS purchase_qty,
      COALESCE(mnIn.qty_in_manual,         0)           AS adjustment_qty,
      COALESCE(gvIn.val_gross,             0)           AS gross_value,
      COALESCE(dgIn.val_discount,          0)           AS discount_value,
      COALESCE(rvIn.val_return,            0)           AS return_value
    FROM products p
    LEFT JOIN companies co ON co.id = p.company_id
    LEFT JOIN (
      SELECT product_id, SUM(qty) AS total_qty
        FROM inventory
       GROUP BY product_id
    ) inv ON inv.product_id = p.id

    /* -- Roll-back subqueries: everything on or after from_date, per product.
       Alias suffix "RB" (roll-back). Every projected column has a UNIQUE
       name that is NOT reused as an outer SELECT alias -- defensive against
       MySQL HAVING/reference ambiguity that has caused zeroed columns on
       some deployments. */

    LEFT JOIN (
      SELECT si.product_id,
             SUM(COALESCE(si.qty, 0) + COALESCE(si.bonus, 0)) AS qty_after_sale
        FROM sale_items si
        JOIN sales sh ON sh.id = si.sale_id
       WHERE sh.date >= ?
       GROUP BY si.product_id
    ) sRB ON sRB.product_id = p.id
    LEFT JOIN (
      SELECT ri.product_id, SUM(COALESCE(ri.qty_returned, 0)) AS qty_after_ret
        FROM return_items ri
        JOIN recoveries  rh ON rh.id = ri.recovery_id
       WHERE rh.date >= ?
       GROUP BY ri.product_id
    ) reRB ON reRB.product_id = p.id
    LEFT JOIN (
      SELECT pi.product_id,
             SUM(COALESCE(pi.qty, 0) + COALESCE(pi.bonus, 0)) AS qty_after_pur
        FROM purchase_items pi
        JOIN purchases ph ON ph.id = pi.purchase_id
       WHERE ph.date >= ?
       GROUP BY pi.product_id
    ) puRB ON puRB.product_id = p.id
    LEFT JOIN (
      SELECT myi.product_id, SUM(COALESCE(myi.units_manufactured, 0)) AS qty_after_mfg
        FROM mfg_yield_items myi
        JOIN mfg_yields      myh ON myh.id = myi.yield_id
       WHERE DATE(myh.created_at) >= ?
         AND myi.added_to_inventory = 1
       GROUP BY myi.product_id
    ) mfRB ON mfRB.product_id = p.id
    LEFT JOIN (
      SELECT im.product_id,
             SUM(COALESCE(im.qty_in, 0) - COALESCE(im.qty_out, 0)) AS qty_after_manual
        FROM inventory_movements im
       WHERE im.movement_date >= ?
         AND im.ref_type IN ('inventory_manual', 'adjustment')
       GROUP BY im.product_id
    ) mnRB ON mnRB.product_id = p.id

    /* -- In-period aggregates, per product. Alias suffix "In". Every
       projected column uses a UNIQUE name distinct from outer aliases. */

    LEFT JOIN (
      SELECT si.product_id,
             SUM(COALESCE(si.qty, 0) + COALESCE(si.bonus, 0)) AS qty_in_gross
        FROM sale_items si
        JOIN sales sh ON sh.id = si.sale_id
       WHERE sh.date BETWEEN ? AND ?
       GROUP BY si.product_id
    ) sIn ON sIn.product_id = p.id
    LEFT JOIN (
      SELECT ri.product_id, SUM(COALESCE(ri.qty_returned, 0)) AS qty_in_return
        FROM return_items ri
        JOIN recoveries  rh ON rh.id = ri.recovery_id
       WHERE rh.date BETWEEN ? AND ?
       GROUP BY ri.product_id
    ) reIn ON reIn.product_id = p.id
    LEFT JOIN (
      SELECT pi.product_id,
             SUM(COALESCE(pi.qty, 0) + COALESCE(pi.bonus, 0)) AS qty_in_purchase
        FROM purchase_items pi
        JOIN purchases ph ON ph.id = pi.purchase_id
       WHERE ph.date BETWEEN ? AND ?
       GROUP BY pi.product_id
    ) puIn ON puIn.product_id = p.id
    LEFT JOIN (
      SELECT myi.product_id, SUM(COALESCE(myi.units_manufactured, 0)) AS qty_in_mfg
        FROM mfg_yield_items myi
        JOIN mfg_yields      myh ON myh.id = myi.yield_id
       WHERE DATE(myh.created_at) BETWEEN ? AND ?
         AND myi.added_to_inventory = 1
       GROUP BY myi.product_id
    ) mfIn ON mfIn.product_id = p.id
    LEFT JOIN (
      SELECT im.product_id,
             SUM(COALESCE(im.qty_in, 0) - COALESCE(im.qty_out, 0)) AS qty_in_manual
        FROM inventory_movements im
       WHERE im.movement_date BETWEEN ? AND ?
         AND im.ref_type IN ('inventory_manual', 'adjustment')
       GROUP BY im.product_id
    ) mnIn ON mnIn.product_id = p.id

    /* -- Value aggregates. Alias prefix "val_". */

    LEFT JOIN (
      SELECT si.product_id, SUM(COALESCE(si.total, 0)) AS val_gross
        FROM sale_items si
        JOIN sales sh ON sh.id = si.sale_id
       WHERE sh.date BETWEEN ? AND ?
       GROUP BY si.product_id
    ) gvIn ON gvIn.product_id = p.id
    LEFT JOIN (
      SELECT rci.product_id, SUM(COALESCE(rci.discount_given, 0)) AS val_discount
        FROM recovery_items rci
        JOIN recoveries    rh ON rh.id = rci.recovery_id
       WHERE rh.date BETWEEN ? AND ?
       GROUP BY rci.product_id
    ) dgIn ON dgIn.product_id = p.id
    LEFT JOIN (
      SELECT ri.product_id, SUM(COALESCE(ri.return_amount, 0)) AS val_return
        FROM return_items ri
        JOIN recoveries  rh ON rh.id = ri.recovery_id
       WHERE rh.date BETWEEN ? AND ?
       GROUP BY ri.product_id
    ) rvIn ON rvIn.product_id = p.id
    WHERE 1 = 1
  `;
  if (company_id) { sql += ' AND p.company_id = ?'; params.push(company_id); }
  // HAVING references outer SELECT aliases only; each alias is unique
  // across the whole statement so MySQL cannot resolve to a subquery
  // column by accident.
  sql += `
    HAVING opening_stock  <> 0
        OR gross_qty       > 0
        OR return_qty      > 0
        OR purchase_qty    > 0
        OR adjustment_qty <> 0
    ORDER BY p.name ASC
  `;

  const [rows] = await db.query(sql, params);
  // Round money to 2 decimals per AGENTS.md convention; qtys are integers.
  const money2 = (n) => Math.round(parseFloat(n || 0) * 100) / 100;
  return rows.map(r => {
    const opening   = parseInt(r.opening_stock,  10) || 0;
    const purchase  = parseInt(r.purchase_qty,   10) || 0;
    const adjust    = parseInt(r.adjustment_qty, 10) || 0;
    const gross     = parseInt(r.gross_qty,      10) || 0;
    const ret       = parseInt(r.return_qty,     10) || 0;
    const gross_v   = parseFloat(r.gross_value)    || 0;
    const disc_v    = parseFloat(r.discount_value) || 0;
    const ret_v     = parseFloat(r.return_value)   || 0;
    return {
      product_id:     r.product_id,
      product_name:   r.product_name,
      pack_size:      r.pack_size || '',
      company_id:     r.company_id,
      company_name:   r.company_name || '',
      opening_stock:  opening,
      purchase_qty:   purchase,
      adjustment_qty: adjust,
      gross_qty:      gross,
      return_qty:     ret,
      net_sale_unit:  gross - ret,
      net_sale_value: money2(gross_v - disc_v - ret_v),
      closing_stock:  opening + purchase + adjust - gross + ret,
    };
  });
}

router.get('/sale-stock-report', auth, async (req, res) => {
  try {
    const { from_date, to_date, company_id } = req.query;
    const rows = await fetchSaleAndStockReportData({
      from_date, to_date,
      company_id: company_id || null,
    });
    res.json({ rows });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
});

router.get('/sale-stock-report/pdf', auth, async (req, res) => {
  try {
    const { from_date, to_date, company_id, stock_mode } = req.query;
    const rows = await fetchSaleAndStockReportData({
      from_date, to_date,
      company_id: company_id || null,
    });
    const [[company]] = await db.query('SELECT * FROM company_settings WHERE id=1');
    let companyLabel = 'All Companies';
    if (company_id) {
      const [c] = await db.query('SELECT name FROM companies WHERE id=?', [company_id]);
      companyLabel = c[0]?.name || String(company_id);
    }
    // Whitelist the mode; anything else falls back to 'split' (the pre-toggle
    // behaviour so old bookmarks keep working).
    const mode = ['none', 'split', 'combined'].includes(stock_mode) ? stock_mode : 'split';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="sale-stock-report.pdf"');
    generateSaleAndStockReportPDF(res, { rows, from_date, to_date, companyLabel, company, mode });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
});

// â”€â”€â”€ generateSaleAndStockReportPDF â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Same typography and structure as the other reports (same font/row height,
// same header + filter box + column-based table + total row). Numeric
// columns are right-aligned; product name flexes.
//
// `mode` (from the UI Split/Combined/None toggle) drives which inflow
// columns are drawn:
//   'none'     â†’ neither Pur nor Adj (compact "sales-only" view)
//   'split'    â†’ separate Pur and Adj columns
//   'combined' â†’ single "Pur+Adj" column (their signed sum)
//
// Column labels are deliberately terse (Pack, Pur, Adj, Gross, Net) so
// numeric widths dominate the layout rather than headers wrapping.
function generateSaleAndStockReportPDF(res, {
  rows, from_date, to_date, companyLabel, company, mode = 'none',
}) {
  const doc = new PDFDocument({ margin: 40, size: 'A4', bufferPages: true });
  doc.pipe(res);

  const companyName = company?.name || 'Medivance';
  const left = 40, right = doc.page.width - 40, contentWidth = right - left;
  const footerOpts  = { left, right, contentWidth, companyName };

  let y = drawReportHeader(doc, {
    company, title: 'SALE & STOCK REPORT',
    subtitle: 'Inventory & Revenue Performance',
    left, right, contentWidth,
  });

  y = drawFilterBox(doc, {
    left, contentWidth, y,
    filters: [
      `Period: ${from_date}  to  ${to_date}`,
      `Company: ${companyLabel}`,
    ],
  });

  // Column definitions â€” keyed so we can conditionally insert/remove
  // in-flow columns without index math drifting.
  const inflowDefs =
    mode === 'split'    ? [
      { key: 'pur',    label: 'Pur.',      w: 42, align: 'right' },
      { key: 'adj',    label: 'Adj.',      w: 42, align: 'right' },
    ]
    : mode === 'combined' ? [
      { key: 'inflow', label: 'Pur./Adj.',  w: 58, align: 'right' },
    ]
    : [];

  const colDefs = [
    { key: 'sr',    label: 'Sr',          w: 22 },
    { key: 'name',  label: 'Product',     w: 'flex' },
    { key: 'pack',  label: 'Pack',        w: 40 },
    { key: 'open',  label: 'Opening',     w: 48, align: 'right' },
    ...inflowDefs,
    { key: 'gross', label: 'Gross',       w: 48, align: 'right' },
    { key: 'ret',   label: 'Return',      w: 46, align: 'right' },
    { key: 'netu',  label: 'Net',         w: 44, align: 'right' },
    { key: 'netv',  label: 'Net (Value)', w: 68, align: 'right' },
    { key: 'close', label: 'Closing',     w: 48, align: 'right' },
  ];

  const cols   = buildPdfColumns(left, contentWidth, colDefs);
  const colBy  = Object.fromEntries(colDefs.map((d, i) => [d.key, cols[i]]));

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
  const totals = { opening: 0, purchase: 0, adjust: 0, gross: 0, ret: 0, netU: 0, netV: 0, closing: 0 };

  // Format a signed integer, blank when zero â€” matches on-screen "â€”"
  // convention but keeps PDF cells clean (no em-dash noise).
  const fmtQty  = (n) => (n === 0 ? '' : String(n));
  const fmtSign = (n) => (n === 0 ? '' : (n > 0 ? String(n) : String(n))); // signed already

  rows.forEach((row, i) => {
    totals.opening  += row.opening_stock;
    totals.purchase += row.purchase_qty;
    totals.adjust   += row.adjustment_qty;
    totals.gross    += row.gross_qty;
    totals.ret      += row.return_qty;
    totals.netU     += row.net_sale_unit;
    totals.netV     += row.net_sale_value;
    totals.closing  += row.closing_stock;

    const inflowSum = (row.purchase_qty || 0) + (row.adjustment_qty || 0);
    const cellText = {
      sr:     String(i + 1),
      name:   row.product_name || '',
      pack:   row.pack_size    || '',
      open:   String(row.opening_stock),
      pur:    fmtQty(row.purchase_qty),
      adj:    fmtSign(row.adjustment_qty),
      inflow: fmtSign(inflowSum),
      gross:  fmtQty(row.gross_qty),
      ret:    fmtQty(row.return_qty),
      netu:   String(row.net_sale_unit),
      netv:   Number(row.net_sale_value).toFixed(2),
      close:  String(row.closing_stock),
    };

    doc.font('Helvetica').fontSize(TABLE_FONT_SIZE);
    const rowH = measureRowHeight(doc,
      colDefs.map(d => ({ text: cellText[d.key], width: colBy[d.key].w - 4 })),
      TABLE_MIN_ROW,
    );

    if (y + rowH > pageBottom) { doc.addPage(); y = doc.page.margins.top; y = drawHdr(y); }

    doc.font('Helvetica').fontSize(TABLE_FONT_SIZE).fillColor('#000');
    colDefs.forEach(d => {
      const c = colBy[d.key];
      const opts = { width: c.w - 4, lineBreak: d.key === 'name' ? undefined : false };
      if (d.align) opts.align = d.align;
      doc.text(cellText[d.key], c.x + 2, y + TABLE_TOP_PAD, opts);
    });
    y += rowH;
  });

  doc.moveTo(left, y).lineTo(right, y).stroke();
  y += 8;
  y = ensureSpace(doc, y, 24);

  // TOTAL row â€” label spans Product cell; numerics sit under their columns.
  const totalCells = {
    open:   String(totals.opening),
    pur:    fmtQty(totals.purchase),
    adj:    fmtSign(totals.adjust),
    inflow: fmtSign(totals.purchase + totals.adjust),
    gross:  String(totals.gross),
    ret:    String(totals.ret),
    netu:   String(totals.netU),
    netv:   Number(totals.netV).toFixed(2),
    close:  String(totals.closing),
  };

  doc.font('Helvetica-Bold').fontSize(TABLE_FONT_SIZE);
  doc.text('TOTAL', colBy.name.x + 2, y, { width: colBy.name.w - 4, lineBreak: false });
  Object.keys(totalCells).forEach(key => {
    const c = colBy[key];
    if (!c) return; // column not present in this mode (pur/adj/inflow)
    doc.text(totalCells[key], c.x + 2, y, { width: c.w - 4, align: 'right', lineBreak: false });
  });

  stampPdfFootersOnAllPages(doc, footerOpts);
  doc.flushPages();
  doc.end();
}

// ─── Batch Activity Report ──────────────────────────────────────────────────
//
// Per-(product, batch) activity register: every sale line drawn from the
// specified batch within the date window, alongside its customer, ship-to
// address, gross line value, return value, and received (= gross − return).
// Feeds both a modern on-screen layout (executive header card + summary
// TL;DR metrics + zebra-striped, borderless table) and a PDF that mirrors
// that shape for print/share.
//
// Semantics used here (kept intentionally simple to match spec):
//   Gross    = sale_items.total                          (line total, tax-in)
//   Return   = SUM(return_items.return_amount) per sale_item
//   Received = Gross − Return                            (per row + totals)
//
// "Received" is defined here strictly as Gross − Return per the report
// spec — it is NOT the recovered cash (which lives on
// sales.total_recovered / sale_items.recovered_amount and is the concept
// used elsewhere in the app). This report is about "what did the batch
// physically flow out for, net of returns", not about cash collection.

async function fetchBatchActivityData({ product_id, batch_no, from_date, to_date }) {
  if (!product_id || !batch_no) {
    const err = new Error('product_id and batch_no are required');
    err.status = 400;
    throw err;
  }

  // Product + batch meta. Batch row is optional — a fully consumed batch
  // may no longer exist in inventory, but its history in sale_items still
  // matters. In that case status falls through to 'Closed'.
  const [[product]] = await db.query(
    `SELECT p.id, p.name, p.pack_size, COALESCE(co.name, '') AS company_name
       FROM products p
       LEFT JOIN companies co ON co.id = p.company_id
      WHERE p.id = ?`, [product_id]
  );
  if (!product) {
    const err = new Error('Product not found');
    err.status = 404;
    throw err;
  }

  const [invRows] = await db.query(
    `SELECT batch_no, qty, exp_date, sale_rate, retail_price
       FROM inventory WHERE product_id = ? AND batch_no = ?`,
    [product_id, batch_no]
  );
  const invRow = invRows[0] || null;

  // Active/Closed: matches isBatchActive() in backend/inventory.js — qty>0
  // AND expiry (year+month) not yet past. If no inventory row exists at
  // all, the batch is treated as Closed.
  let status = 'Closed';
  if (invRow) {
    const qty = parseFloat(invRow.qty) || 0;
    let expired = false;
    if (invRow.exp_date) {
      const expYM = String(invRow.exp_date).slice(0, 7);
      // Use PKT for the "today" boundary since batch expiry decisions are
      // day-of-month-agnostic and PKT is the app's authoritative TZ.
      const todayYM = require('../utils/dateUtils').todayPKT().slice(0, 7);
      expired = expYM < todayYM;
    }
    status = (qty > 0 && !expired) ? 'Active' : 'Closed';
  }

  // Activity rows. Ship-to = customer.address, falling back to the
  // area/city composition so a blank address doesn't leave a dead cell.
  const params = [product_id, batch_no];
  let sql = `
    SELECT
      s.id            AS sale_id,
      s.date          AS date,
      s.invoice_no    AS invoice_no,
      cu.name         AS customer_name,
      COALESCE(NULLIF(TRIM(cu.address), ''),
               NULLIF(TRIM(CONCAT_WS(', ', a.name, ci.name)), ''),
               '')    AS ship_to,
      si.total        AS gross,
      COALESCE(ri.ret, 0) AS return_amount
    FROM sale_items si
    JOIN sales     s  ON s.id = si.sale_id
    JOIN customers cu ON cu.id = s.customer_id
    LEFT JOIN cities ci ON ci.id = cu.city_id
    LEFT JOIN areas  a  ON a.id  = cu.area_id
    LEFT JOIN (
      SELECT sale_item_id, SUM(return_amount) AS ret
        FROM return_items
       GROUP BY sale_item_id
    ) ri ON ri.sale_item_id = si.id
    WHERE si.product_id = ? AND si.batch_no = ?
  `;
  if (from_date) { sql += ' AND s.date >= ?'; params.push(from_date); }
  if (to_date)   { sql += ' AND s.date <= ?'; params.push(to_date);   }
  sql += ' ORDER BY s.date ASC, s.id ASC';

  const [raw] = await db.query(sql, params);

  const money2 = (n) => Math.round(parseFloat(n || 0) * 100) / 100;
  const rows = raw.map(r => {
    const gross = money2(r.gross);
    const ret   = money2(r.return_amount);
    return {
      sale_id:       r.sale_id,
      date:          r.date,
      invoice_no:    r.invoice_no,
      customer_name: r.customer_name || '',
      ship_to:       r.ship_to || '',
      gross,
      return_amount: ret,
      received:      money2(gross - ret),
    };
  });

  const totals = rows.reduce((t, r) => ({
    gross:    money2(t.gross    + r.gross),
    ret:      money2(t.ret      + r.return_amount),
    received: money2(t.received + r.received),
  }), { gross: 0, ret: 0, received: 0 });

  return {
    meta: {
      product_id:    product.id,
      product_name:  product.name,
      pack_size:     product.pack_size || '',
      company_name:  product.company_name || '',
      batch_no:      batch_no,
      exp_date:      invRow ? invRow.exp_date : null,
      current_qty:   invRow ? (parseInt(invRow.qty, 10) || 0) : 0,
      status,
      from_date:     from_date || null,
      to_date:       to_date   || null,
    },
    rows,
    totals,
  };
}

router.get('/batch-activity', auth, async (req, res) => {
  try {
    const { product_id, batch_no, from_date, to_date } = req.query;
    const data = await fetchBatchActivityData({ product_id, batch_no, from_date, to_date });
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
});

router.get('/batch-activity/pdf', auth, async (req, res) => {
  try {
    const { product_id, batch_no, from_date, to_date } = req.query;
    const data = await fetchBatchActivityData({ product_id, batch_no, from_date, to_date });
    const [[company]] = await db.query('SELECT * FROM company_settings WHERE id=1');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="batch-activity-${String(batch_no).replace(/[^a-z0-9]+/gi, '-')}.pdf"`
    );
    generateBatchActivityPDF(res, { data, company });
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message });
  }
});

// ─── generateBatchActivityPDF ──────────────────────────────────────────────
//
// Layout mirrors the on-screen report so print output matches what the
// operator saw when they clicked Download:
//
//   1. Standard report header (company + title).
//   2. Executive metadata card — Product / Batch / Company · Pack /
//      Date Range / Status / Generated On — 3-column grid inside a
//      light-bordered box (no harsh black frames).
//   3. Summary metrics strip — Total Gross | Total Returns | Net
//      Received — bold, callout-style, so the exec sees totals without
//      hunting the table.
//   4. Data table — Seq / Date / Invoice / Customer / Ship-To / Gross /
//      Return / Received — subtle horizontal dividers, NO vertical
//      grid, zebra-striped rows (very light tint), bold total row at
//      the bottom.
function generateBatchActivityPDF(res, { data, company }) {
  const doc = new PDFDocument({ margin: 40, size: 'A4', bufferPages: true });
  doc.pipe(res);

  const { meta, rows, totals } = data;
  const companyName = company?.name || 'Medivance';
  const left = 40, right = doc.page.width - 40, contentWidth = right - left;
  const footerOpts  = { left, right, contentWidth, companyName };

  // Palette — light, print-friendly. Grays for structure, no color-coded
  // semantics (the report gets photocopied/printed on b/w hardware).
  const GRAY_LINE   = '#d7dee6';   // horizontal dividers
  const GRAY_LABEL  = '#6b7280';   // metadata labels
  const GRAY_TEXT   = '#111827';   // metadata values
  const ZEBRA_TINT  = '#f7f9fb';   // alternating row background

  let y = drawReportHeader(doc, {
    company, title: 'BATCH ACTIVITY REPORT',
    subtitle: 'Product · Batch · Sales Activity',
    left, right, contentWidth,
  });

  // ── 1) Executive metadata card ───────────────────────────────────────
  // 3-column key/value grid inside a soft-bordered rectangle. Keeps the
  // "at-a-glance" info visually separated from the table below.
  const metaCol = contentWidth / 3;
  const metaRowH = 26;
  const metaBoxH = metaRowH * 2 + 16; // two rows + top/bottom padding

  doc.strokeColor(GRAY_LINE).lineWidth(0.75);
  doc.roundedRect(left, y, contentWidth, metaBoxH, 6).stroke();

  const drawMeta = (col, row, label, value) => {
    const cx = left + col * metaCol + 12;
    const cy = y + 10 + row * metaRowH;
    doc.font('Helvetica').fontSize(7.5).fillColor(GRAY_LABEL)
       .text(String(label).toUpperCase(), cx, cy, { width: metaCol - 24, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(10).fillColor(GRAY_TEXT)
       .text(String(value ?? '—'), cx, cy + 10, { width: metaCol - 24, lineBreak: false, ellipsis: true });
  };

  const productLine  = meta.product_name + (meta.pack_size ? `  ·  ${meta.pack_size}` : '');
  const companyLine  = meta.company_name || '—';
  const dateRange    = `${meta.from_date || 'Beginning'}  →  ${meta.to_date || 'Present'}`;
  const generatedOn  = formatDatePKT(new Date());
  const expDateStr   = meta.exp_date ? formatDatePKT(meta.exp_date) : '—';

  drawMeta(0, 0, 'Product',       productLine);
  drawMeta(1, 0, 'Batch Number',  meta.batch_no);
  drawMeta(2, 0, 'Company',       companyLine);
  drawMeta(0, 1, 'Date Range',    dateRange);
  drawMeta(1, 1, 'Batch Expiry',  expDateStr);
  drawMeta(2, 1, 'Status',        meta.status);

  y += metaBoxH + 6;

  // Generated-on note under the card, right-aligned, unobtrusive.
  doc.font('Helvetica').fontSize(8).fillColor(GRAY_LABEL)
     .text(`Report generated on ${generatedOn}`, left, y, { width: contentWidth, align: 'right', lineBreak: false });
  y += 16;
  doc.fillColor('#000');

  // ── 2) Summary metrics strip (TL;DR callouts) ────────────────────────
  const metricCount = 3;
  const metricGap = 8;
  const metricW = (contentWidth - metricGap * (metricCount - 1)) / metricCount;
  const metricH = 46;
  const drawMetric = (i, label, value) => {
    const mx = left + i * (metricW + metricGap);
    doc.strokeColor(GRAY_LINE).lineWidth(0.75);
    doc.roundedRect(mx, y, metricW, metricH, 6).stroke();
    doc.font('Helvetica').fontSize(8).fillColor(GRAY_LABEL)
       .text(String(label).toUpperCase(), mx + 12, y + 8, { width: metricW - 24, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(15).fillColor(GRAY_TEXT)
       .text(value, mx + 12, y + 22, { width: metricW - 24, lineBreak: false });
  };
  const fmtMoney = (n) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  drawMetric(0, 'Total Gross',   fmtMoney(totals.gross));
  drawMetric(1, 'Total Returns', fmtMoney(totals.ret));
  drawMetric(2, 'Net Received',  fmtMoney(totals.received));
  y += metricH + 14;
  doc.fillColor('#000');

  // ── 3) Data table ────────────────────────────────────────────────────
  // Widths match the spec's percentages (Seq 4 / Date 8 / Invoice 10 /
  // Customer 20 / Ship-To 27 / Gross 10 / Return 10 / Received 10 = 99;
  // the tiny remainder is absorbed by Ship-To via buildPdfColumns's flex).
  const cols = buildPdfColumns(left, contentWidth, [
    { key: 'seq',     label: 'Seq',        w: Math.round(contentWidth * 0.04), align: 'right' },
    { key: 'date',    label: 'Date',       w: Math.round(contentWidth * 0.09) },
    { key: 'invoice', label: 'Invoice No', w: Math.round(contentWidth * 0.10) },
    { key: 'cust',    label: 'Customer',   w: Math.round(contentWidth * 0.20) },
    { key: 'ship',    label: 'Ship-To',    w: 'flex' },
    { key: 'gross',   label: 'Gross',      w: Math.round(contentWidth * 0.10), align: 'right' },
    { key: 'return',  label: 'Return',     w: Math.round(contentWidth * 0.10), align: 'right' },
    { key: 'recv',    label: 'Received',   w: Math.round(contentWidth * 0.10), align: 'right' },
  ]);

  const pageBottom = getPdfContentBottom(doc);

  function drawHdr(yy) {
    // Modern: single subtle divider under headers, no top rule, no vertical rules.
    doc.font('Helvetica-Bold').fontSize(TABLE_HDR_FONT_SIZE).fillColor(GRAY_LABEL);
    cols.forEach(c =>
      doc.text(String(c.label).toUpperCase(), c.x + 2, yy + TABLE_TOP_PAD,
        { width: c.w - 4, align: c.align, lineBreak: false })
    );
    doc.strokeColor(GRAY_LINE).lineWidth(0.75);
    doc.moveTo(left, yy + TABLE_HDR_H).lineTo(right, yy + TABLE_HDR_H).stroke();
    doc.fillColor('#000');
    return yy + TABLE_HDR_H;
  }

  y = drawHdr(y);

  if (rows.length === 0) {
    doc.font('Helvetica-Oblique').fontSize(TABLE_FONT_SIZE).fillColor(GRAY_LABEL)
       .text('No activity for this batch in the selected period.',
             left, y + 12, { width: contentWidth, align: 'center', lineBreak: false });
    y += 30;
  } else {
    rows.forEach((row, i) => {
      const seqStr     = String(i + 1);
      const dateStr    = formatDatePKT(row.date); // standardized display
      const invoiceStr = row.invoice_no || '—';
      const custStr    = row.customer_name || '—';
      const shipStr    = row.ship_to || '—';
      const grossStr   = fmtMoney(row.gross);
      const retStr     = row.return_amount > 0 ? fmtMoney(row.return_amount) : '—';
      const recvStr    = fmtMoney(row.received);

      // Measure using ship-to (the wrapping-prone column) as the driver;
      // customer can wrap too but is narrower. Keeps every row tall enough
      // to hold its own address without clipping.
      doc.font('Helvetica').fontSize(TABLE_FONT_SIZE);
      const rowH = measureRowHeight(doc, [
        { text: custStr, width: cols[3].w - 4 },
        { text: shipStr, width: cols[4].w - 4 },
      ], TABLE_MIN_ROW);

      if (y + rowH > pageBottom) {
        doc.addPage();
        y = doc.page.margins.top;
        y = drawHdr(y);
      }

      // Zebra stripe — very light tint on even rows.
      if (i % 2 === 1) {
        doc.save();
        doc.rect(left, y, contentWidth, rowH).fill(ZEBRA_TINT);
        doc.restore();
      }

      doc.font('Helvetica').fontSize(TABLE_FONT_SIZE).fillColor(GRAY_TEXT);
      doc.text(seqStr,     cols[0].x + 2, y + TABLE_TOP_PAD, { width: cols[0].w - 4, align: 'right', lineBreak: false });
      doc.text(dateStr,    cols[1].x + 2, y + TABLE_TOP_PAD, { width: cols[1].w - 4, lineBreak: false });
      // Invoice column: monospace-ish (Courier) so serials line up vertically.
      doc.font('Courier').fontSize(TABLE_FONT_SIZE)
         .text(invoiceStr, cols[2].x + 2, y + TABLE_TOP_PAD, { width: cols[2].w - 4, lineBreak: false });
      doc.font('Helvetica').fontSize(TABLE_FONT_SIZE);
      doc.text(custStr,    cols[3].x + 2, y + TABLE_TOP_PAD, { width: cols[3].w - 4 });
      doc.text(shipStr,    cols[4].x + 2, y + TABLE_TOP_PAD, { width: cols[4].w - 4 });
      doc.text(grossStr,   cols[5].x + 2, y + TABLE_TOP_PAD, { width: cols[5].w - 4, align: 'right', lineBreak: false });
      doc.text(retStr,     cols[6].x + 2, y + TABLE_TOP_PAD, { width: cols[6].w - 4, align: 'right', lineBreak: false });
      doc.text(recvStr,    cols[7].x + 2, y + TABLE_TOP_PAD, { width: cols[7].w - 4, align: 'right', lineBreak: false });

      // Subtle horizontal divider under each row (no vertical rules ever).
      doc.strokeColor(GRAY_LINE).lineWidth(0.5);
      doc.moveTo(left, y + rowH).lineTo(right, y + rowH).stroke();
      y += rowH;
    });
  }

  // ── 4) Bolded bottom total row ───────────────────────────────────────
  y = ensureSpace(doc, y + 6, 22);
  doc.strokeColor(GRAY_LINE).lineWidth(1);
  doc.moveTo(left, y - 4).lineTo(right, y - 4).stroke();
  doc.font('Helvetica-Bold').fontSize(TABLE_FONT_SIZE + 0.5).fillColor(GRAY_TEXT);
  // "TOTAL" spans up to the Ship-To column so it visually anchors under
  // the descriptive columns and stops just before the numeric block.
  const labelStartX = cols[0].x + 2;
  const labelWidth  = cols[5].x - labelStartX - 4;
  doc.text('TOTAL', labelStartX, y + TABLE_TOP_PAD, { width: labelWidth, lineBreak: false });
  doc.text(fmtMoney(totals.gross),    cols[5].x + 2, y + TABLE_TOP_PAD, { width: cols[5].w - 4, align: 'right', lineBreak: false });
  doc.text(fmtMoney(totals.ret),      cols[6].x + 2, y + TABLE_TOP_PAD, { width: cols[6].w - 4, align: 'right', lineBreak: false });
  doc.text(fmtMoney(totals.received), cols[7].x + 2, y + TABLE_TOP_PAD, { width: cols[7].w - 4, align: 'right', lineBreak: false });

  stampPdfFootersOnAllPages(doc, footerOpts);
  doc.flushPages();
  doc.end();
}


module.exports = router;
