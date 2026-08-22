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
const { todayPKT, formatDatePKT, addMonthsPKT } = require('../utils/dateUtils');

// Paisa tolerance & 4-decimal rounding (matches purchase.js & sales.js).
const PAISA  = 0.005;
const money4 = (n) => Math.round(parseFloat(n || 0) * 10000) / 10000;

// Admin-aware wrapper around sanitizeInventoryRows. Admins always see
// purchase_rate regardless of products.show_purchase_rate — matches the
// frontend's `user?.role === 'admin' || can(perm_view_purchase_rate)`
// pattern in Sale.js / Purchase.js / Inventory.js / Products.js.
async function sanitizeInventoryRowsWithAdminBypass(req, dbConn, rows) {
  if (req.user?.role === 'admin') return rows;
  return sanitizeInventoryRows(req, dbConn, rows);
}

// One-line journal helper. `refType` uses the enum shipped with the
// migration: 'purchase' | 'sale' | 'return' | 'inventory_manual' |
// 'manufacturing' | 'adjustment'.
async function recordInventoryMovement(conn, {
  productId, batchNo, date, refType, refId, qtyIn, qtyOut, rateAtMovement, note,
}) {
  await conn.query(
    `INSERT INTO inventory_movements
       (product_id, batch_no, movement_date, ref_type, ref_id,
        qty_in, qty_out, rate_at_movement, note)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [productId, batchNo || '', date, refType, refId,
     qtyIn || 0, qtyOut || 0, rateAtMovement ?? null, note || null]
  );
}

// ─── Shared PDF constants (matches Ledger/Sales/Recovery report typography) ──
const TABLE_FONT_SIZE     = 8.5;
const TABLE_HDR_FONT_SIZE = 8.5;
const TABLE_HDR_H         = 20;
const TABLE_MIN_ROW       = 18;
const TABLE_TOP_PAD       = 4;
const COMPANY_ROW_H       = 20;

// ─── Active-batch helpers ─────────────────────────────────────────────────
// "Active" batch = qty > 0 AND not expired.
// Expiry is judged by YEAR+MONTH only (never the day-of-month), per business
// rule: a batch expiring anytime in the current month is still valid; it only
// becomes invalid once the calendar rolls into the following month (PKT).
function toYearMonth(dateVal) {
  if (!dateVal) return null;
  if (dateVal instanceof Date) {
    // DATE columns come back as JS Date objects from mysql2 — read the UTC
    // fields since the driver stores calendar dates at UTC midnight and a
    // local getMonth()/getDate() could roll the date backward/forward a day.
    const y = dateVal.getUTCFullYear();
    const m = String(dateVal.getUTCMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }
  return String(dateVal).slice(0, 7); // 'YYYY-MM-DD...' -> 'YYYY-MM'
}

function isBatchExpired(expDate) {
  if (!expDate) return false; // no expiry recorded — treat as not expired
  const expYM = toYearMonth(expDate);
  const todayYM = todayPKT().slice(0, 7);
  return expYM < todayYM;
}

function isBatchActive(row) {
  return parseFloat(row.qty) > 0 && !isBatchExpired(row.exp_date);
}

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
    const payload = await sanitizeInventoryRowsWithAdminBypass(req, db, rows);
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
    const payload = await sanitizeInventoryRowsWithAdminBypass(req, db, rows);
    res.json(payload);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Product IDs that currently have at least one "active" batch (qty > 0 and
// not expired, judged by year+month only). Used to power the New Sale
// product picker so users can't select a product with nothing sellable.
router.get('/active-products', auth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT product_id, qty, exp_date FROM inventory');
    const activeIds = [...new Set(
      rows.filter(isBatchActive).map(r => r.product_id)
    )];
    res.json(activeIds);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/product/:product_id', auth, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT i.*, p.show_purchase_rate FROM inventory i JOIN products p ON p.id = i.product_id WHERE i.product_id=? ORDER BY batch_no',
      [req.params.product_id]
    );
    // ?active_only=1 restricts to sellable batches: qty > 0 and not expired
    // (expiry judged by year+month only). Existing callers that manage/edit
    // batches (including expired/zero-qty ones) keep working unchanged since
    // this filter only applies when explicitly requested.
    const { active_only } = req.query;
    const filtered = active_only ? rows.filter(isBatchActive) : rows;
    const payload = await sanitizeInventoryRowsWithAdminBypass(req, db, filtered);
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

// Batch lookup used by the Inventory manual-add form. If the (product,
// batch) pair already exists in inventory, the response includes every
// field the form should lock — rate/exp/sale/retail all come from the
// existing row, only qty is left for the operator to input. Admins get
// the same lock (business rule, not a permission thing).
router.get('/batch-lookup', auth, async (req, res) => {
  try {
    const { product_id, batch_no } = req.query;
    if (!product_id || !batch_no) return res.json({ exists: false });
    const [rows] = await db.query(
      `SELECT id, qty, purchase_rate, sale_rate, retail_price, exp_date,
              low_stock_threshold
         FROM inventory WHERE product_id=? AND batch_no=?`,
      [product_id, batch_no]
    );
    if (!rows.length) return res.json({ exists: false });
    const row = rows[0];
    res.json({
      exists: true,
      qty:                 parseInt(row.qty, 10),
      purchase_rate:       parseFloat(row.purchase_rate),
      sale_rate:           parseFloat(row.sale_rate),
      retail_price:        parseFloat(row.retail_price),
      exp_date:            row.exp_date,
      low_stock_threshold: row.low_stock_threshold,
    });
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

// Manual inventory entry — used to migrate stock from a previous system
// and to top up existing batches without going through Purchase.
//
// Rule when the (product, batch) pair ALREADY exists in inventory: only
// the qty is user-editable. Rate, expiry, sale rate, and retail price
// come from the existing inventory row and are enforced server-side
// regardless of what the client sent — protects against an operator
// silently overwriting a batch's rate via the manual-add form.
// (See Q6 in the audit: rate changes on an existing batch must go
// through Purchase with the weighted-average preview, or through the
// Inventory Edit modal with an explicit rate-change confirmation.)
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
      const { product_id, batch_no, qty } = item;

      if (!product_id || !batch_no) {
        throw new Error(`Row ${rowNum}: Product and Batch No are required`);
      }
      const addQty = parseFloat(qty);
      if (!addQty || addQty <= 0) {
        throw new Error(`Row ${rowNum}: Qty must be greater than 0`);
      }

      const [existing] = await conn.query(
        'SELECT * FROM inventory WHERE product_id=? AND batch_no=? FOR UPDATE',
        [product_id, batch_no]
      );

      if (existing.length > 0) {
        // Existing batch — lock the rate/exp fields to what's already in
        // inventory. Any values the client tried to send are DISCARDED.
        const existingRow = existing[0];
        await conn.query(
          `UPDATE inventory
             SET qty = qty + ?,
                 updated_at = NOW()
           WHERE id=?`,
          [addQty, existingRow.id]
        );
        await recordInventoryMovement(conn, {
          productId:      product_id,
          batchNo:        batch_no,
          date:           todayPKT(),
          refType:        'inventory_manual',
          refId:          existingRow.id,
          qtyIn:          addQty,
          qtyOut:         0,
          rateAtMovement: existingRow.purchase_rate,
          note:           'Manual add — existing batch top-up (rate/exp locked)',
        });
        results.push({ product_id, batch_no, action: 'topped_up',
                       new_qty: parseInt(existingRow.qty, 10) + addQty });
      } else {
        const { purchase_rate, sale_rate, retail_price, exp_date, low_stock_threshold } = item;
        const [insertResult] = await conn.query(
          `INSERT INTO inventory
             (product_id, batch_no, qty, purchase_rate, sale_rate, retail_price, exp_date, low_stock_threshold)
           VALUES (?,?,?,?,?,?,?,?)`,
          [
            product_id, batch_no, addQty,
            purchase_rate || 0, sale_rate || 0, retail_price || 0,
            exp_date || null, low_stock_threshold || 10
          ]
        );
        await recordInventoryMovement(conn, {
          productId:      product_id,
          batchNo:        batch_no,
          date:           todayPKT(),
          refType:        'inventory_manual',
          refId:          insertResult.insertId,
          qtyIn:          addQty,
          qtyOut:         0,
          rateAtMovement: purchase_rate || null,
          note:           'Manual add — new batch',
        });
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
    res.status(err.status || 500).json({ message: err.message });
  } finally {
    conn.release();
  }
});

// Edit / update an existing inventory batch.
//
// All fields are editable INCLUDING purchase_rate (previously locked —
// but per Q6, admins need to be able to correct a landed cost when a
// vendor invoice is amended, and this is the surgical path for that).
// Any change to purchase_rate / sale_rate / retail_price requires the
// client to send `confirm_rate_change: true` in the body — without it,
// the server responds 409 with the current values so the UI can render
// a confirmation modal.
router.put('/:id', auth, async (req, res) => {
  const conn = await db.getConnection();
  await conn.beginTransaction();
  try {
    const { id } = req.params;
    let {
      batch_no, qty, exp_date, sale_rate, retail_price, low_stock_threshold,
      purchase_rate, confirm_rate_change,
    } = req.body;

    const [existingRows] = await conn.query(
      'SELECT * FROM inventory WHERE id=? FOR UPDATE', [id]);
    if (existingRows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: 'Inventory batch not found' });
    }
    const existing = existingRows[0];

    // ---- Rule 1: batch_no required & unique per product ----
    batch_no = (batch_no || '').trim();
    if (!batch_no) {
      await conn.rollback();
      return res.status(400).json({ message: 'Batch No is required' });
    }
    const [dupe] = await conn.query(
      'SELECT id FROM inventory WHERE product_id=? AND batch_no=? AND id<>?',
      [existing.product_id, batch_no, id]
    );
    if (dupe.length > 0) {
      await conn.rollback();
      return res.status(400).json({ message: 'Another batch with this Batch No already exists for this product' });
    }

    // ---- Rule 2: qty must be >= 0 ----
    if (qty === undefined || qty === null || qty === '' || parseFloat(qty) < 0) {
      await conn.rollback();
      return res.status(400).json({ message: 'Qty must not be less than 0' });
    }

    // ---- Rule 3: exp_date must not be within 3 months of today (PKT) ----
    if (exp_date) {
      const minExpStr = addMonthsPKT(todayPKT(), 3);
      const expStr = String(exp_date).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(expStr)) {
        await conn.rollback();
        return res.status(400).json({ message: 'Invalid Expiry Date' });
      }
      if (expStr < minExpStr) {
        await conn.rollback();
        return res.status(400).json({ message: 'Expiry Date must be more than 3 months from today' });
      }
    }

    // ---- Rule 4: purchase_rate <= sale_rate <= retail_price ----
    const newPurchaseRate = purchase_rate !== undefined && purchase_rate !== null && purchase_rate !== ''
      ? parseFloat(purchase_rate) : parseFloat(existing.purchase_rate) || 0;
    const newSaleRate = sale_rate !== undefined && sale_rate !== null && sale_rate !== ''
      ? parseFloat(sale_rate) : parseFloat(existing.sale_rate) || 0;
    const newRetailPrice = retail_price !== undefined && retail_price !== null && retail_price !== ''
      ? parseFloat(retail_price) : parseFloat(existing.retail_price) || 0;

    if (isNaN(newPurchaseRate) || isNaN(newSaleRate) || isNaN(newRetailPrice)) {
      await conn.rollback();
      return res.status(400).json({ message: 'Rates must be valid numbers' });
    }
    if (newPurchaseRate < 0) {
      await conn.rollback();
      return res.status(400).json({ message: 'Purchase Rate cannot be negative' });
    }
    if (newSaleRate < newPurchaseRate) {
      await conn.rollback();
      return res.status(400).json({
        message: `Sale Rate cannot be less than Purchase Rate (${newPurchaseRate})`
      });
    }
    if (newRetailPrice < newSaleRate) {
      await conn.rollback();
      return res.status(400).json({ message: 'Retail Price cannot be less than Sale Rate' });
    }

    // ---- Rate-change confirmation gate ----
    // Any rate that has moved between the existing row and the new payload
    // triggers the confirmation requirement. UI shows a modal explaining
    // the change; second submit carries `confirm_rate_change: true`.
    const purchaseRateChanged = Math.abs(money4(existing.purchase_rate) - money4(newPurchaseRate)) > 0.00005;
    const saleRateChanged     = Math.abs(parseFloat(existing.sale_rate)     - newSaleRate)     > PAISA;
    const retailPriceChanged  = Math.abs(parseFloat(existing.retail_price)  - newRetailPrice)  > PAISA;
    if ((purchaseRateChanged || saleRateChanged || retailPriceChanged) && !confirm_rate_change) {
      await conn.rollback();
      return res.status(409).json({
        message: 'Rate change confirmation required.',
        requires_confirmation: 'confirm_rate_change',
        preview: {
          existing: {
            purchase_rate: parseFloat(existing.purchase_rate),
            sale_rate:     parseFloat(existing.sale_rate),
            retail_price:  parseFloat(existing.retail_price),
          },
          new: {
            purchase_rate: newPurchaseRate,
            sale_rate:     newSaleRate,
            retail_price:  newRetailPrice,
          },
          changed: {
            purchase_rate: purchaseRateChanged,
            sale_rate:     saleRateChanged,
            retail_price:  retailPriceChanged,
          },
        },
      });
    }

    // ---- Rule 5: low_stock_threshold must not be below 1 ----
    let lowStockThreshold = existing.low_stock_threshold;
    if (low_stock_threshold !== undefined && low_stock_threshold !== null && low_stock_threshold !== '') {
      lowStockThreshold = parseInt(low_stock_threshold, 10);
      if (isNaN(lowStockThreshold) || lowStockThreshold < 1) {
        await conn.rollback();
        return res.status(400).json({ message: 'Low Stock Threshold must be at least 1' });
      }
    }

    const newQty = parseInt(qty, 10);
    const oldQty = parseInt(existing.qty, 10);

    await conn.query(
      `UPDATE inventory
         SET batch_no=?, qty=?, exp_date=?, purchase_rate=?, sale_rate=?, retail_price=?,
             low_stock_threshold=?, updated_at=NOW()
       WHERE id=?`,
      [batch_no, newQty, exp_date || null,
       newPurchaseRate, newSaleRate, newRetailPrice,
       lowStockThreshold, id]
    );

    // Journal the qty delta if it moved. rate_at_movement uses the NEW
    // rate for a stock-up, the OLD rate for a stock-down (the units
    // leaving carried the old cost).
    if (newQty !== oldQty) {
      const delta = newQty - oldQty;
      await recordInventoryMovement(conn, {
        productId: existing.product_id,
        batchNo:   batch_no,
        date:      todayPKT(),
        refType:   'inventory_manual',
        refId:     parseInt(id, 10),
        qtyIn:     delta > 0 ? delta  : 0,
        qtyOut:    delta < 0 ? -delta : 0,
        rateAtMovement: delta > 0 ? newPurchaseRate : parseFloat(existing.purchase_rate),
        note:      `Inventory edit — qty ${oldQty} → ${newQty}`,
      });
    }

    await conn.commit();
    await logAudit(
      req, 'UPDATE', 'inventory', id,
      `Updated inventory batch ${batch_no} (qty: ${oldQty} → ${newQty}` +
      (purchaseRateChanged ? `, purchase_rate: ${existing.purchase_rate} → ${newPurchaseRate}` : '') +
      (saleRateChanged     ? `, sale_rate: ${existing.sale_rate} → ${newSaleRate}`             : '') +
      (retailPriceChanged  ? `, retail_price: ${existing.retail_price} → ${newRetailPrice}`    : '') +
      ')'
    );

    res.json({ message: 'Inventory updated successfully' });
  } catch (err) {
    await conn.rollback();
    res.status(err.status || 500).json({ message: err.message });
  } finally { conn.release(); }
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
      `Date: ${formatDatePKT(new Date())}`,
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
    const expStr      = row.exp_date ? formatDatePKT(row.exp_date) : '—';
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