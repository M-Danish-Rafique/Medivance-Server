const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');
const { sanitizeInventoryRows } = require('../utils/purchaseRateAccess');
const { logAudit } = require('../middleware/auditLog');
const PDFDocument = require('pdfkit');
const {
  stampPdfFootersOnAllPages,
  getPdfContentBottom,
  ensureSpace,
  measureRowHeight,
  buildPdfColumns,
  drawReportHeader,
  drawFilterBox,
} = require('../utils/pdfHelpers');

// ─── Shared PDF constants (matches Ledger/Sales/Recovery report typography) ──
const TABLE_FONT_SIZE     = 8.5;
const TABLE_HDR_FONT_SIZE = 8.5;
const TABLE_HDR_H         = 20;
const TABLE_MIN_ROW       = 18;
const TABLE_TOP_PAD       = 4;
const COMPANY_ROW_H       = 20;

router.get('/', auth, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT i.id, i.product_id, i.batch_no, i.qty, i.purchase_rate, i.sale_rate,
             COALESCE(NULLIF(i.retail_price, 0), p.retail_price, 0) AS retail_price,
             i.exp_date, i.low_stock_threshold, i.created_at, i.updated_at,
             p.name AS product_name, p.pack_size, p.company_id, c.name AS company_name,
             p.show_purchase_rate
      FROM inventory i
      JOIN products p ON i.product_id = p.id
      LEFT JOIN companies c ON p.company_id = c.id
      ORDER BY p.name, i.batch_no
    `);
    const payload = await sanitizeInventoryRows(req, db, rows);
    res.json(payload);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/low-stock', auth, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT i.*, p.name as product_name, p.pack_size, p.show_purchase_rate
      FROM inventory i
      JOIN products p ON i.product_id = p.id
      WHERE i.qty <= i.low_stock_threshold AND i.qty > 0
      ORDER BY i.qty ASC
    `);
    const payload = await sanitizeInventoryRows(req, db, rows);
    res.json(payload);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/product/:product_id', auth, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT i.*, p.show_purchase_rate FROM inventory i JOIN products p ON p.id = i.product_id WHERE i.product_id=? ORDER BY batch_no',
      [req.params.product_id]
    );
    const payload = await sanitizeInventoryRows(req, db, rows);
    res.json(payload);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/check-batch', auth, async (req, res) => {
  try {
    const { product_id, batch_no } = req.query;
    const [rows] = await db.query(
      'SELECT * FROM inventory WHERE product_id=? AND batch_no=?',
      [product_id, batch_no]
    );
    res.json(rows.length > 0 ? rows[0] : null);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Print Inventory (PDF) — grouped by company (A→Z), then product (A→Z), then batch.
// Optional company_id restricts the report to a single company's products.
// Date is not a real filter yet — the report always stamps today's date.
router.get('/print/pdf', auth, async (req, res) => {
  try {
    const { company_id } = req.query;

    let sql = `
      SELECT i.batch_no, i.qty, i.exp_date,
             COALESCE(NULLIF(i.retail_price, 0), p.retail_price, 0) AS retail_price,
             p.name AS product_name, p.pack_size, p.company_id,
             COALESCE(c.name, 'Unassigned') AS company_name
      FROM inventory i
      JOIN products p ON i.product_id = p.id
      LEFT JOIN companies c ON p.company_id = c.id
      WHERE 1=1
    `;
    const params = [];
    if (company_id) { sql += ' AND p.company_id = ?'; params.push(company_id); }
    sql += ' ORDER BY company_name ASC, p.name ASC, i.batch_no ASC';

    const [rows] = await db.query(sql, params);
    const [[company]] = await db.query('SELECT * FROM company_settings WHERE id=1');

    let companyLabel = 'All Companies';
    if (company_id) {
      const [c] = await db.query('SELECT name FROM companies WHERE id=?', [company_id]);
      companyLabel = c[0]?.name || 'Unknown';
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="inventory-report.pdf"');
    generateInventoryPDF(res, { rows, companyLabel, company });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Manual inventory entry — used to migrate stock from a previous system.
// Unlike POST /purchases, this ONLY writes to the inventory table: no purchase /
// purchase_items record is created, and no supplier ledger / balance is touched.
router.post('/manual', auth, async (req, res) => {
  const conn = await db.getConnection();
  await conn.beginTransaction();
  try {
    const { items } = req.body;
    if (!items || items.length === 0) {
      await conn.rollback();
      return res.status(400).json({ message: 'At least one item is required' });
    }

    const results = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const rowNum = i + 1;
      const { product_id, batch_no, qty, purchase_rate, sale_rate, retail_price, exp_date, low_stock_threshold } = item;

      if (!product_id || !batch_no) {
        throw new Error(`Row ${rowNum}: Product and Batch No are required`);
      }
      if (!qty || parseFloat(qty) <= 0) {
        throw new Error(`Row ${rowNum}: Qty must be greater than 0`);
      }

      const [existing] = await conn.query(
        'SELECT * FROM inventory WHERE product_id=? AND batch_no=?',
        [product_id, batch_no]
      );

      if (existing.length > 0) {
        // Batch already exists — add the migrated qty on top rather than overwrite it
        await conn.query(
          `UPDATE inventory
           SET qty = qty + ?,
               purchase_rate = ?,
               sale_rate = ?,
               retail_price = ?,
               exp_date = ?,
               low_stock_threshold = COALESCE(?, low_stock_threshold),
               updated_at = NOW()
           WHERE product_id=? AND batch_no=?`,
          [
            qty,
            purchase_rate || existing[0].purchase_rate,
            sale_rate || existing[0].sale_rate,
            retail_price || existing[0].retail_price,
            exp_date || existing[0].exp_date,
            low_stock_threshold || null,
            product_id, batch_no
          ]
        );
        results.push({ product_id, batch_no, action: 'updated' });
      } else {
        await conn.query(
          `INSERT INTO inventory
           (product_id, batch_no, qty, purchase_rate, sale_rate, retail_price, exp_date, low_stock_threshold)
           VALUES (?,?,?,?,?,?,?,?)`,
          [
            product_id, batch_no, qty,
            purchase_rate || 0, sale_rate || 0, retail_price || 0,
            exp_date || null, low_stock_threshold || 10
          ]
        );
        results.push({ product_id, batch_no, action: 'created' });
      }
    }

    await conn.commit();
    await logAudit(
      req, 'CREATE', 'inventory', null,
      `Manually added inventory — ${items.length} batch${items.length > 1 ? 'es' : ''} (migration entry, no purchase record created)`
    );
    res.status(201).json({ message: 'Inventory added successfully', results });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
});

// Edit / update an existing inventory batch.
// Only batch_no, qty, exp_date, sale_rate, retail_price, and low_stock_threshold
// are editable. product_id and purchase_rate can never be changed from here.
router.put('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    let { batch_no, qty, exp_date, sale_rate, retail_price, low_stock_threshold } = req.body;

    const [existingRows] = await db.query('SELECT * FROM inventory WHERE id=?', [id]);
    if (existingRows.length === 0) {
      return res.status(404).json({ message: 'Inventory batch not found' });
    }
    const existing = existingRows[0];

    // ---- Rule 1: batch_no required & unique per product ----
    batch_no = (batch_no || '').trim();
    if (!batch_no) {
      return res.status(400).json({ message: 'Batch No is required' });
    }
    const [dupe] = await db.query(
      'SELECT id FROM inventory WHERE product_id=? AND batch_no=? AND id<>?',
      [existing.product_id, batch_no, id]
    );
    if (dupe.length > 0) {
      return res.status(400).json({ message: 'Another batch with this Batch No already exists for this product' });
    }

    // ---- Rule 2: qty must be greater than 0 ----
    if (qty === undefined || qty === null || qty === '' || parseFloat(qty) < 0) {
      return res.status(400).json({ message: 'Qty must not be less than 0' });
    }

    // ---- Rule 3: exp_date must not be within 3 months of today ----
    if (exp_date) {
      const minExp = new Date();
      minExp.setHours(0, 0, 0, 0);
      minExp.setMonth(minExp.getMonth() + 3);
      const newExp = new Date(exp_date);
      if (isNaN(newExp.getTime())) {
        return res.status(400).json({ message: 'Invalid Expiry Date' });
      }
      if (newExp < minExp) {
        return res.status(400).json({ message: 'Expiry Date must be more than 3 months from today' });
      }
    }

    // ---- Rule 4: purchase_rate <= sale_rate <= retail_price ----
    // purchase_rate itself is never edited here, so we compare against the
    // authoritative value already stored in the database (never trust a client-sent one).
    const purchaseRate = parseFloat(existing.purchase_rate) || 0;
    const saleRate = sale_rate !== undefined && sale_rate !== null && sale_rate !== ''
      ? parseFloat(sale_rate) : parseFloat(existing.sale_rate) || 0;
    const retailPrice = retail_price !== undefined && retail_price !== null && retail_price !== ''
      ? parseFloat(retail_price) : parseFloat(existing.retail_price) || 0;

    if (isNaN(saleRate) || isNaN(retailPrice)) {
      return res.status(400).json({ message: 'Sale Rate and Retail Price must be valid numbers' });
    }
    if (saleRate < purchaseRate) {
      return res.status(400).json({ message: `Sale Rate cannot be less than Purchase Rate (${purchaseRate})` });
    }
    if (retailPrice < saleRate) {
      return res.status(400).json({ message: 'Retail Price cannot be less than Sale Rate' });
    }

    // ---- Rule 5: low_stock_threshold must not be below 1 ----
    let lowStockThreshold = existing.low_stock_threshold;
    if (low_stock_threshold !== undefined && low_stock_threshold !== null && low_stock_threshold !== '') {
      lowStockThreshold = parseInt(low_stock_threshold, 10);
      if (isNaN(lowStockThreshold) || lowStockThreshold < 1) {
        return res.status(400).json({ message: 'Low Stock Threshold must be at least 1' });
      }
    }

    await db.query(
      `UPDATE inventory
       SET batch_no=?, qty=?, exp_date=?, sale_rate=?, retail_price=?, low_stock_threshold=?, updated_at=NOW()
       WHERE id=?`,
      [batch_no, qty, exp_date || null, saleRate, retailPrice, lowStockThreshold, id]
    );

    await logAudit(
      req, 'UPDATE', 'inventory', id,
      `Updated inventory batch ${batch_no} (qty: ${existing.qty} → ${qty})`
    );

    res.json({ message: 'Inventory updated successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── generateInventoryPDF ─────────────────────────────────────────────────────

function generateInventoryPDF(res, { rows, companyLabel, company }) {
  const doc = new PDFDocument({ margin: 40, size: 'A4', bufferPages: true });
  doc.pipe(res);

  const companyName = company?.name || 'Medivance';
  const left = 40, right = doc.page.width - 40, contentWidth = right - left;
  const footerOpts = { left, right, contentWidth, companyName };

  let y = drawReportHeader(doc, {
    company, title: 'INVENTORY REPORT', subtitle: 'Current Stock Listing', left, right, contentWidth,
  });

  y = drawFilterBox(doc, {
    left, contentWidth, y,
    filters: [
      `Company: ${companyLabel}`,
      `Date: ${new Date().toLocaleDateString('en-GB')}`,
    ],
  });

  const cols = buildPdfColumns(left, contentWidth, [
    { label: 'Product',  w: 'flex' },
    { label: 'Pack',     w: 55 },
    { label: 'Batch No', w: 68 },
    { label: 'Expiry',   w: 62 },
    { label: 'Retail',   w: 62, align: 'right' },
    { label: 'Qty',      w: 42, align: 'right' },
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

  // Section separator row — one per company, company names sort ascending (A→Z)
  // because the SQL query already ORDERs BY company_name ASC.
  function drawCompanyRow(yy, name) {
    doc.rect(left, yy, contentWidth, COMPANY_ROW_H).fill('#eef2f7');
    doc.fillColor('#1e293b').font('Helvetica-Bold').fontSize(9.5)
      .text(name.toUpperCase(), left + 6, yy + 5, { width: contentWidth - 12, lineBreak: false });
    doc.fillColor('#000');
    return yy + COMPANY_ROW_H;
  }

  y = drawHdr(y);

  if (rows.length === 0) {
    doc.font('Helvetica').fontSize(9.5).fillColor('#666')
      .text('No inventory records found for the selected filters.', left, y + 14, { width: contentWidth, align: 'center' });
    doc.fillColor('#000');
  }

  let currentCompany = null;
  let batchCount = 0;
  let totalQty = 0;

  rows.forEach((row) => {
    const rowCompany = row.company_name || 'Unassigned';

    if (rowCompany !== currentCompany) {
      if (y + COMPANY_ROW_H + TABLE_MIN_ROW > pageBottom) {
        doc.addPage();
        y = doc.page.margins.top;
        y = drawHdr(y);
      }
      y = drawCompanyRow(y, rowCompany);
      currentCompany = rowCompany;
    }

    const qty    = parseFloat(row.qty) || 0;
    const retail = parseFloat(row.retail_price) || 0;
    batchCount += 1;
    totalQty   += qty;

    const productStr = row.product_name || '—';
    const packStr     = row.pack_size || '—';
    const batchStr    = row.batch_no || '—';
    const expStr      = row.exp_date ? new Date(row.exp_date).toLocaleDateString('en-GB') : '—';
    const retailStr   = retail.toFixed(2);
    const qtyStr      = String(qty);

    doc.font('Helvetica').fontSize(TABLE_FONT_SIZE);
    const rowH = measureRowHeight(doc, [
      { text: productStr, width: cols[0].w - 4 },
      { text: packStr,    width: cols[1].w - 4 },
      { text: batchStr,   width: cols[2].w - 4 },
      { text: expStr,     width: cols[3].w - 4 },
      { text: retailStr,  width: cols[4].w - 4 },
      { text: qtyStr,     width: cols[5].w - 4 },
    ], TABLE_MIN_ROW);

    if (y + rowH > pageBottom) {
      doc.addPage();
      y = doc.page.margins.top;
      y = drawHdr(y);
      y = drawCompanyRow(y, currentCompany); // keep the section context visible after a page break
    }

    doc.font('Helvetica').fontSize(TABLE_FONT_SIZE).fillColor('#000');
    doc.text(productStr, cols[0].x + 2, y + TABLE_TOP_PAD, { width: cols[0].w - 4 }); // wraps freely
    doc.text(packStr,    cols[1].x + 2, y + TABLE_TOP_PAD, { width: cols[1].w - 4, lineBreak: false });
    doc.text(batchStr,   cols[2].x + 2, y + TABLE_TOP_PAD, { width: cols[2].w - 4, lineBreak: false });
    doc.text(expStr,     cols[3].x + 2, y + TABLE_TOP_PAD, { width: cols[3].w - 4, lineBreak: false });
    doc.text(retailStr,  cols[4].x + 2, y + TABLE_TOP_PAD, { width: cols[4].w - 4, align: 'right', lineBreak: false });
    doc.text(qtyStr,     cols[5].x + 2, y + TABLE_TOP_PAD, { width: cols[5].w - 4, align: 'right', lineBreak: false });

    y += rowH;
  });

  if (rows.length > 0) {
    doc.moveTo(left, y).lineTo(right, y).stroke();
    y += 8;
    y = ensureSpace(doc, y, 24);

    doc.font('Helvetica-Bold').fontSize(TABLE_FONT_SIZE);
    doc.text(`Total Batches: ${batchCount}`, cols[0].x + 2, y, {
      width: cols[0].w + cols[1].w + cols[2].w + cols[3].w - 4, lineBreak: false,
    });
    doc.text(String(totalQty), cols[5].x + 2, y, { width: cols[5].w - 4, align: 'right', lineBreak: false });
  }

  stampPdfFootersOnAllPages(doc, footerOpts);
  doc.flushPages();
  doc.end();
}

module.exports = router;