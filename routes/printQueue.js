const express = require('express');
const router = express.Router();
const db = require('../config/db');
const auth = require('../middleware/auth');
const { logAudit } = require('../middleware/auditLog');
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const {
  drawPdfLogo,
  getPdfContentBottom,
  ensureSpace,
  measureRowHeight,
} = require('../utils/pdfHelpers');

const VALID_TYPES = ['warranty', 'warranty10', 'non-warranty'];

// ─── Unit conversion ────────────────────────────────────────────────────────
// InvoiceDocument.jsx's INVOICE_STYLES mixes mm (page padding), pt (font
// sizes — already usable as-is), and px (every other spacing/border value).
// PDFKit works in pt, so: 1mm = 2.834645669pt, 1css-px = 0.75pt (96px/in ÷
// 72pt/in). Every constant below is that CSS value run through the matching
// conversion, so this layout is the same design, not a re-guess of it.
const MM = 2.834645669;
const PX = 0.75;

// .invoice-page { padding: 8mm 10mm 12mm; }
const PAGE_MARGIN_TOP = 8 * MM;     // 22.68
const PAGE_MARGIN_SIDE = 10 * MM;   // 28.35
const PAGE_MARGIN_BOTTOM = 12 * MM; // 34.02

// .invoice-header
const HEADER_PAD_BOTTOM = 7 * PX;      // 5.25
const HEADER_BORDER_W = 1.5 * PX;      // 1.125
const HEADER_MARGIN_BOTTOM = 9 * PX;   // 6.75
const BRAND_ROW_GAP = 10 * PX;         // 7.5
const COMPANY_NAME_SIZE = 16;          // pt, as declared
const META_SIZE = 9;
const META_MARGIN_TOP = 4.0;    // measured/calibrated (was 2px*.75=1.5 — undershot by ~2.1pt against the reference render)
const DOC_TITLE_SIZE = 18;
const DOC_TITLE_LETTER_SPACING = 2 * PX; // 1.5
const DOC_TITLE_MARGIN_BOTTOM = 11.5;  // measured/calibrated (was 6px*.75=4.5 — undershot by ~7pt against the reference render)
const META_TABLE_SIZE = 9.2;
const META_ROW_PAD = 2.9;              // measured/calibrated (was 1px*.75=0.75 — this row's cadence undershot by ~4.2pt against the reference render)
const HEADER_RIGHT_W = 170;            // CSS min-width:160px(=120pt) is a floor; sized to comfortably fit content
const LOGO_SIZE = 36;                  // 48px logo ≈ 36pt, matches <CompanyLogo size={48}>

// .invoice-party-box
const PARTY_BORDER_W = 1 * PX;         // 0.75
const PARTY_PAD_V = 7.5;               // measured/calibrated (was 7px*.75=5.25)
const PARTY_PAD_H = 10 * PX;           // 7.5
const PARTY_MARGIN_BOTTOM = 9 * PX;    // 6.75
const PARTY_GAP = 24 * PX;             // 18
const PARTY_SIZE = 9;
// .party-row { margin-bottom: 2px } — applies to the "Customer:"/"Salesman:"/etc rows
const PARTY_ROW_MARGIN_BOTTOM = 4.3;   // measured/calibrated (was 2px*.75=1.5)
const PARTY_ROW_TIGHT_MARGIN_TOP = 3 * PX; // 2.25
// .party-detail { margin-bottom: 1px } — applies ONLY to the geo line / address
// lines under the customer name. This is a much smaller gap than .party-row's,
// and was previously (incorrectly) sharing PARTY_ROW_MARGIN_BOTTOM, which is
// what produced the oversized gap above/below the customer address.
const PARTY_DETAIL_MARGIN_BOTTOM = 1 * PX; // 0.75
const PARTY_CUSTOMER_FLEX = 1.6;
const PARTY_STAFF_FLEX = 0.9;

// .invoice-table
const TABLE_BODY_SIZE = 9;
const TABLE_HDR_SIZE = 8.2;
const TABLE_HDR_PAD_V = 6.1;           // measured/calibrated (was 5px*.75=3.75 — header row height undershot by ~4.9pt against the reference render)
const TABLE_HDR_PAD_H = 3 * PX;        // 2.25
const TABLE_BODY_PAD_V = 5.3;          // measured/calibrated (was 4px*.75=3 — row cadence undershot by ~2.8pt against the reference render)
const TABLE_BODY_PAD_H = 3 * PX;       // 2.25
const TABLE_BORDER_W = 1.5 * PX;       // 1.125
const TABLE_HDR_H = TABLE_HDR_PAD_V * 2 + TABLE_HDR_SIZE * 1.15;
const TABLE_MIN_ROW = TABLE_BODY_PAD_V * 2 + TABLE_BODY_SIZE * 1.15;

// .invoice-summary-panel
const SUMMARY_BORDER_W = 1.5 * PX;     // 1.125
const SUMMARY_PAD_V = 7 * PX;          // 5.25
const SUMMARY_PAD_H = 2 * PX;          // 1.5
const SUMMARY_MARGIN_TOP = 5 * PX;     // 3.75
const SUMMARY_SIZE = 9.2;
const SUMMARY_GAP = 12 * PX;           // 9
const SUMMARY_COL_LEFT_FLEX = 1.15;
const SUMMARY_COL_MID_FLEX = 0.95;
const SUMMARY_COL_RIGHT_FLEX = 1.15;
const SUMMARY_COL_MID_PAD_H = 10 * PX; // 7.5
const SUMMARY_REF_MARGIN_TOP = 4 * PX; // 3
const SUMMARY_WORDS_MARGIN_TOP = 5 * PX; // 3.75
const SUMMARY_WORDS_SIZE = 9.5;
const SUMMARY_LINE_H = SUMMARY_SIZE * 1.55; // measured/calibrated (was ×1.4)
// .summary-net's own divider — the frontend declares it as a plain 1px hr,
// but per explicit request this should read visually "bold" alongside the
// bold Net Amount row, so it's bumped to match the other emphasis borders
// (TABLE_BORDER_W / HEADER_BORDER_W) rather than the thin 1px literal.
const SUMMARY_NET_BORDER_W = 1.5 * PX; // 1.125
const SUMMARY_NET_MARGIN_TOP = 3 * PX; // 2.25
const SUMMARY_NET_PAD_TOP = 4 * PX;    // 3

// .warranty-section
const WARRANTY_MARGIN_TOP = 7 * PX;    // 5.25
const WARRANTY_SIZE = 8.5;
const WARRANTY_LINE_HEIGHT = 1.42;
const WARRANTY_EXPIRY_MARGIN_BOTTOM = 4 * PX; // 3
const WARRANTY_ROW_GAP = 14 * PX;      // 10.5
const WARRANTY_ROW_MARGIN_BOTTOM = 6 * PX; // 4.5
const WARRANTY_TEXT_FLEX = 1.65;
const WARRANTY_SIGN_FLEX = 0.75;
const WARRANTY_HEADING_MARGIN = 2 * PX; // 1.5
const WARRANTY_NOTE_MARGIN_TOP = 3 * PX; // 2.25
const WARRANTY_SIGN_PAD_TOP = 100 * PX; // 75
const WARRANTY_SIGN_SIZE = 9;
// Same "bold" treatment as SUMMARY_NET_BORDER_W — this is the line the
// bold company name sits under, so it's bumped to match.
const WARRANTY_SIGN_LINE_W = 1.5 * PX; // 1.125
const WARRANTY_SIGN_LINE_MARGIN_BOTTOM = 4 * PX; // 3
const DRAP_BORDER_W = 1 * PX;          // 0.75
// .drap-box { padding: 5px 8px; } — top/bottom vs left/right padding.
// DRAP_PAD_H (left/right) is a literal, uncalibrated conversion and is left
// as-is (the request was explicitly "top and bottom only, not left/right").
// DRAP_PAD_V (top/bottom) is bumped the same way every other *_PAD_V in this
// file was bumped — the literal px→pt conversion consistently undershoots
// the browser's rendered padding by roughly 1.4–1.8x across this whole file.
const DRAP_PAD_V = 7;                  // calibrated (was 5px*.75=3.75)
const DRAP_PAD_H = 8 * PX;             // 6 — unchanged, left/right only

// .invoice-page-footer
const FOOTER_BOTTOM = 6 * MM;          // 17.01, distance from page bottom edge
const FOOTER_BORDER_W = 1 * PX;        // 0.75
const FOOTER_PAD_TOP = 5 * PX;         // 3.75
const FOOTER_SIZE = 8;

// ─── number -> words (mirrors InvoiceDocument.jsx exactly — pure,
// data-independent formatting, safe to duplicate) ───────────────────────────
function numberToWords(num) {
  const ones = ['', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE',
    'TEN', 'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN', 'SEVENTEEN', 'EIGHTEEN', 'NINETEEN'];
  const tens = ['', '', 'TWENTY', 'THIRTY', 'FORTY', 'FIFTY', 'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY'];
  function helper(n) {
    if (n === 0) return '';
    if (n < 20) return ones[n] + ' ';
    if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : '') + ' ';
    if (n < 1000) return ones[Math.floor(n / 100)] + ' HUNDRED ' + helper(n % 100);
    if (n < 100000) return helper(Math.floor(n / 1000)) + 'THOUSAND ' + helper(n % 1000);
    if (n < 10000000) return helper(Math.floor(n / 100000)) + 'LAKH ' + helper(n % 100000);
    return helper(Math.floor(n / 10000000)) + 'CRORE ' + helper(n % 10000000);
  }
  const n = Math.floor(num);
  if (n === 0) return 'ZERO';
  return helper(n).trim();
}

// Matches InvoiceDocument.jsx's fmtNum exactly (toLocaleString with 2 decimals,
// which includes thousand-separator commas) — the backend was previously using
// toFixed(2), which drops the commas the frontend always shows.
const fmt2 = n => (parseFloat(n) || 0).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtInt = n => String(Math.round(parseFloat(n) || 0));

// ─── PDF: Invoice (Print Queue) ────────────────────────────────────────────
//
// The request body is already fully computed by the browser (same
// computeInvoiceRows the on-screen Preview uses) — this route only draws
// it, using the exact same measurements as INVOICE_STYLES (converted from
// its mm/px/pt values to PDFKit's pt), so this output matches Preview's
// design rather than approximating it.
router.post('/render-pdf', auth, async (req, res) => {
  try {
    const payload = req.body;
    if (!payload || !payload.invoice_no || !Array.isArray(payload.rows)) {
      return res.status(400).json({ message: 'Invalid invoice payload' });
    }
    res.setHeader('Content-Type', 'application/pdf');
    generateInvoicePDF(res, payload);
  } catch (err) {
    console.error('Print Queue: failed to render PDF —', err.message);
    if (!res.headersSent) res.status(500).json({ message: `Error generating PDF: ${err.message}` });
  }
});

// ─── Font family ────────────────────────────────────────────────────────────
// INVOICE_STYLES specifies font-family: Arial, Helvetica, sans-serif. PDFKit's
// built-in "Helvetica" is a different font file — visually close, not
// identical (compare the R, G, t, 1). To render the actual same font,
// this embeds real Arial TTFs if they're present at
// backend/assets/fonts/{Arial.ttf,Arial-Bold.ttf,Arial-Italic.ttf,Arial-BoldItalic.ttf}
// (copy them from C:\Windows\Fonts\ — arial.ttf, arialbd.ttf, ariali.ttf,
// arialbi.ttf — renamed to match). If those files aren't present, this
// silently falls back to PDFKit's Helvetica rather than crashing, so the
// route keeps working either way — but the file-family match is exact only
// once the real TTFs are in place.
const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const FONT_FILES = {
  Regular: 'Arial.ttf',
  Bold: 'Arial-Bold.ttf',
  Italic: 'Arial-Italic.ttf',
  BoldItalic: 'Arial-BoldItalic.ttf',
};
let loggedFontStatus = false;

function loadInvoiceFonts(doc) {
  const names = { Regular: 'Helvetica', Bold: 'Helvetica-Bold', Italic: 'Helvetica-Oblique', BoldItalic: 'Helvetica-BoldOblique' };
  let embeddedCount = 0;
  for (const key of Object.keys(FONT_FILES)) {
    const filePath = path.join(FONT_DIR, FONT_FILES[key]);
    if (fs.existsSync(filePath)) {
      const regName = `Invoice-${key}`;
      doc.registerFont(regName, filePath);
      names[key] = regName;
      embeddedCount++;
    }
  }
  if (!loggedFontStatus) {
    loggedFontStatus = true;
    if (embeddedCount === 0) {
      console.warn(`Print Queue: Arial TTFs not found in ${FONT_DIR} — falling back to PDFKit's built-in Helvetica (visually close, not pixel-identical to Arial). See routes/printQueue.js for the exact file names expected.`);
    } else if (embeddedCount < 4) {
      console.warn(`Print Queue: only ${embeddedCount}/4 Arial TTFs found in ${FONT_DIR} — some weights/styles will fall back to Helvetica.`);
    }
  }
  return names;
}

function generateInvoicePDF(res, data) {
  const doc = new PDFDocument({
    size: 'A4',
    bufferPages: true,
    margins: { top: PAGE_MARGIN_TOP, bottom: PAGE_MARGIN_BOTTOM, left: PAGE_MARGIN_SIDE, right: PAGE_MARGIN_SIDE },
  });
  doc.pipe(res);
  const F = loadInvoiceFonts(doc);

  const company = data.company || {};
  const companyName    = company.name    || 'Medivance';
  const companyAddress = company.address || '';
  const companyContact = [company.phone && `Ph: ${company.phone}`, company.email && `Email: ${company.email}`].filter(Boolean).join(' , ');

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const contentWidth = right - left;
  const pageBottom = getPdfContentBottom(doc);

  doc.fillColor('#000');

  // ── Header ────────────────────────────────────────────────────────────────
  const headerTop = PAGE_MARGIN_TOP;
  const rightColX = right - HEADER_RIGHT_W;
  const leftColW = rightColX - left - BRAND_ROW_GAP;

  // Frontend: .invoice-brand-row { display:flex; align-items:center; gap:10px }
  // — the logo's vertical CENTER lines up with the vertical center of the
  // (multi-line) text block beside it, not its top edge. Previously the logo
  // was drawn top-aligned at headerTop while the text block is 2-3 lines
  // tall, which is what made the logo look too high / off-center compared
  // to the reference render. Measure the text block's height first (without
  // drawing), then vertically center the logo against it.
  const measureW = Math.max(10, leftColW - LOGO_SIZE - BRAND_ROW_GAP);
  doc.font(F.Bold).fontSize(COMPANY_NAME_SIZE);
  let textBlockH = doc.heightOfString(companyName, { width: measureW });
  if (companyAddress) {
    doc.font(F.Regular).fontSize(META_SIZE);
    textBlockH += META_MARGIN_TOP + doc.heightOfString(companyAddress, { width: measureW });
  }
  if (companyContact) {
    doc.font(F.Regular).fontSize(META_SIZE);
    textBlockH += META_MARGIN_TOP + doc.heightOfString(companyContact, { width: measureW });
  }
  const logoY = headerTop + Math.max(0, (textBlockH - LOGO_SIZE) / 2);
  const logoDrawn = drawPdfLogo(doc, left, logoY, LOGO_SIZE) > 0; // returns size+10 if drawn, 0 if no logo file
  // drawPdfLogo's own return value bakes in a fixed 10pt gap (size+10) meant
  // as a generic default — the frontend's actual gap is .invoice-brand-row's
  // gap:10px (=7.5pt via BRAND_ROW_GAP). Using the helper's returned offset
  // directly here (as a previous pass did) added BRAND_ROW_GAP on top of that
  // already-baked-in 10pt, double-counting the gap and landing the text
  // ~2.5pt further from the logo than the reference render. Compute the
  // offset ourselves from the known LOGO_SIZE + BRAND_ROW_GAP instead, and
  // only use the helper's return value to detect whether a logo exists.
  const brandOffset = logoDrawn ? LOGO_SIZE + BRAND_ROW_GAP : 0;
  const brandTextX = left + brandOffset;
  const brandTextW = leftColW - brandOffset;

  doc.font(F.Bold).fontSize(COMPANY_NAME_SIZE).text(companyName, brandTextX, headerTop, { width: brandTextW });
  let leftHeaderY = doc.y + META_MARGIN_TOP;
  if (companyAddress) {
    doc.font(F.Regular).fontSize(META_SIZE).text(companyAddress, brandTextX, leftHeaderY, { width: brandTextW });
    leftHeaderY = doc.y + META_MARGIN_TOP;
  }
  if (companyContact) {
    doc.font(F.Regular).fontSize(META_SIZE).text(companyContact, brandTextX, leftHeaderY, { width: brandTextW });
    leftHeaderY = doc.y;
  }

  doc.font(F.Bold).fontSize(DOC_TITLE_SIZE)
    .text('INVOICE', rightColX, headerTop, { width: HEADER_RIGHT_W, align: 'right', lineBreak: false, characterSpacing: DOC_TITLE_LETTER_SPACING });
  let rightHeaderY = doc.y + DOC_TITLE_MARGIN_BOTTOM;

  function metaRow(yy, label, value) {
    doc.font(F.Regular).fontSize(META_TABLE_SIZE);
    const labelW = doc.widthOfString(label);
    doc.font(F.Bold).fontSize(META_TABLE_SIZE);
    const valueW = doc.widthOfString(value);
    const gap = 4 * PX; // .invoice-meta-row { gap: 4px }
    const rowX = right - (labelW + gap + valueW);
    doc.font(F.Regular).fontSize(META_TABLE_SIZE).text(label, rowX, yy, { lineBreak: false });
    doc.font(F.Bold).fontSize(META_TABLE_SIZE).text(value, rowX + labelW + gap, yy, { lineBreak: false });
    return yy + META_TABLE_SIZE * 1.15 + META_ROW_PAD * 2;
  }
  rightHeaderY = metaRow(rightHeaderY, 'Invoice No:', data.invoice_no);
  rightHeaderY = metaRow(rightHeaderY, 'Date:', data.date_label || '');
  rightHeaderY = metaRow(rightHeaderY, 'Page:', '1 of 1');

  let y = Math.max(leftHeaderY, rightHeaderY) + HEADER_PAD_BOTTOM;
  doc.moveTo(left, y).lineTo(right, y).lineWidth(HEADER_BORDER_W).strokeColor('#000').stroke();
  y += HEADER_MARGIN_BOTTOM;

  // ── Party box ────────────────────────────────────────────────────────────
  const boxTop = y;
  const innerLeft = left + PARTY_PAD_H;
  const innerAvail = contentWidth - PARTY_PAD_H * 2 - PARTY_GAP;
  const custW = innerAvail * PARTY_CUSTOMER_FLEX / (PARTY_CUSTOMER_FLEX + PARTY_STAFF_FLEX);
  const staffW = innerAvail * PARTY_STAFF_FLEX / (PARTY_CUSTOMER_FLEX + PARTY_STAFF_FLEX);
  const staffX = innerLeft + custW + PARTY_GAP;
  const contentTop = boxTop + PARTY_PAD_V;

  doc.font(F.Bold).fontSize(PARTY_SIZE)
    .text(`Customer: ${data.customer_name}${data.customer_id ? ` (${data.customer_id})` : ''}`, innerLeft, contentTop, { width: custW });
  let leftY = doc.y + PARTY_ROW_MARGIN_BOTTOM;
  // geo_line / customer_address are ".party-detail" (margin-bottom:1px) in the
  // frontend, NOT ".party-row" (margin-bottom:2px) — using the row margin here
  // was what produced the oversized gap above/below the customer address.
  if (data.geo_line) {
    doc.font(F.Regular).fontSize(PARTY_SIZE).text(data.geo_line, innerLeft, leftY, { width: custW, lineGap: PARTY_SIZE * 0.35 });
    leftY = doc.y + PARTY_DETAIL_MARGIN_BOTTOM;
  }
  if (data.customer_address) {
    doc.font(F.Regular).fontSize(PARTY_SIZE).text(data.customer_address, innerLeft, leftY, { width: custW, lineGap: PARTY_SIZE * 0.35 });
    leftY = doc.y + PARTY_DETAIL_MARGIN_BOTTOM;
  }
  if (data.license_no) {
    doc.font(F.Bold).fontSize(PARTY_SIZE).text(`License No: ${data.license_no}`, innerLeft, leftY + PARTY_ROW_TIGHT_MARGIN_TOP, { width: custW });
    leftY = doc.y;
  }

  doc.font(F.Bold).fontSize(PARTY_SIZE).text(`Salesman: ${data.salesman_name || 'Office'}`, staffX, contentTop, { width: staffW, align: 'right' });
  let rightY = doc.y + PARTY_ROW_MARGIN_BOTTOM;
  doc.font(F.Bold).fontSize(PARTY_SIZE).text(`Delivery By: ${data.delivery_by_name || '\u2014'}`, staffX, rightY, { width: staffW, align: 'right' });
  rightY = doc.y;

  const boxHeight = Math.max(leftY, rightY) - boxTop + PARTY_PAD_V;
  doc.lineWidth(PARTY_BORDER_W).strokeColor('#000').rect(left, boxTop, contentWidth, boxHeight).stroke();
  y = boxTop + boxHeight + PARTY_MARGIN_BOTTOM;

  // ── Line items table ─────────────────────────────────────────────────────
  const isWarranty = !!data.is_warranty;
  const colMeta = [
    { key: 'prd_id', label: 'PRD ID' },
    { key: 'qty', label: 'QTY' },
    { key: 'bonus', label: 'BNS' },
    { key: 'product_name', label: 'PRODUCT NAME', flex: true, align: 'left' },
    { key: 'pack_size', label: 'PACK' },
    { key: 'batch_no', label: 'BATCH NO' },
    { key: 'exp_date_label', label: 'EXP DATE' },
    { key: 'rate', label: 'RATE' },
    { key: 'amount', label: 'AMOUNT' },
    { key: 'disc_pct', label: 'DISC%' },
  ];
  if (!isWarranty) colMeta.push({ key: 'tax_pct', label: 'TAX%' });
  colMeta.push({ key: 'inv_amount', label: 'INV. AMOUNT', bold: true });

  // Build every row's display strings up front — needed so column widths
  // can be measured against the real data before anything is drawn.
  const allCellStrs = data.rows.map(row => {
    const idStr = isWarranty ? fmtInt(row.prd_id) : String(row.prd_id ?? '');
    const strs = {
      prd_id: idStr, qty: String(row.qty ?? ''), bonus: String(row.bonus || 0),
      product_name: row.product_name || '', pack_size: row.pack_size || '\u2014',
      batch_no: row.batch_no || '\u2014', exp_date_label: row.exp_date_label || '',
      rate: fmt2(row.rate), amount: fmt2(row.amount),
      disc_pct: row.disc_pct > 0 ? row.disc_pct.toFixed(2) : '0.00',
      inv_amount: fmt2(row.inv_amount),
    };
    if (!isWarranty) strs.tax_pct = row.tax_pct > 0 ? row.tax_pct.toFixed(2) : '0.00';
    return strs;
  });

  // Measure every fixed (non-flex) column's widest content — header label
  // at header font/weight, every row's value at body font/weight — so the
  // column is guaranteed wide enough for both and never wraps.
  const COL_PAD_H = TABLE_BODY_PAD_H; // header and body share the same horizontal padding
  let fixedWidthTotal = 0;
  colMeta.forEach(c => {
    if (c.flex) return;
    doc.font(F.Bold).fontSize(TABLE_HDR_SIZE);
    let maxW = doc.widthOfString(c.label);
    doc.font(c.bold ? F.Bold : F.Regular).fontSize(TABLE_BODY_SIZE);
    for (const strs of allCellStrs) {
      const w = doc.widthOfString(strs[c.key] || '');
      if (w > maxW) maxW = w;
    }
    c.w = Math.ceil(maxW) + COL_PAD_H * 2 + 2; // +2pt safety margin against sub-pixel rounding
    fixedWidthTotal += c.w;
  });
  const PRODUCT_NAME_MIN_W = 90;
  const productNameCol = colMeta.find(c => c.flex);
  productNameCol.w = Math.max(PRODUCT_NAME_MIN_W, contentWidth - fixedWidthTotal);

  let cx = left;
  const cols = colMeta.map(c => {
    const col = { key: c.key, label: c.label, x: cx, w: c.w, align: c.align || 'center', bold: !!c.bold };
    cx += c.w;
    return col;
  });

  function drawTableHeader(yy) {
    doc.moveTo(left, yy).lineTo(right, yy).lineWidth(TABLE_BORDER_W).strokeColor('#000').stroke();
    doc.font(F.Bold).fontSize(TABLE_HDR_SIZE).fillColor('#000');
    cols.forEach(c => doc.text(c.label, c.x + TABLE_HDR_PAD_H, yy + TABLE_HDR_PAD_V, { width: c.w - TABLE_HDR_PAD_H * 2, align: c.align, lineBreak: false }));
    doc.moveTo(left, yy + TABLE_HDR_H).lineTo(right, yy + TABLE_HDR_H).lineWidth(TABLE_BORDER_W).strokeColor('#000').stroke();
    return yy + TABLE_HDR_H;
  }

  y = drawTableHeader(y);

  for (const strs of allCellStrs) {
    doc.font(F.Regular).fontSize(TABLE_BODY_SIZE);
    const rowH = measureRowHeight(doc, cols.map(c => ({ text: strs[c.key] || '', width: c.w - TABLE_BODY_PAD_H * 2 })), TABLE_MIN_ROW);

    if (y + rowH > pageBottom) {
      doc.addPage();
      y = doc.page.margins.top;
      y = drawTableHeader(y);
    }

    doc.font(F.Regular).fontSize(TABLE_BODY_SIZE).fillColor('#000');
    cols.forEach(c => {
      doc.font(c.bold ? F.Bold : F.Regular).fontSize(TABLE_BODY_SIZE);
      doc.text(strs[c.key] || '', c.x + TABLE_BODY_PAD_H, y + TABLE_BODY_PAD_V, {
        width: c.w - TABLE_BODY_PAD_H * 2,
        align: c.align,
        lineBreak: c.flex,
      });
    });
    y += rowH;
  }

  // NOTE: no line is drawn here. In the frontend, only .invoice-table's
  // thead has border-top/border-bottom — the table body has no bottom
  // border of its own. The line that visually divides the table from the
  // summary panel below is .invoice-summary-panel's own border-top (drawn
  // further down). Drawing a table-bottom line here AND the summary panel's
  // top border was what produced the two stacked hrs.
  y += SUMMARY_MARGIN_TOP;

  // ── Summary panel (3 columns) ────────────────────────────────────────────
  y = ensureSpace(doc, y, 110);
  doc.moveTo(left, y).lineTo(right, y).lineWidth(SUMMARY_BORDER_W).strokeColor('#000').stroke();
  const sumTop = y + SUMMARY_PAD_V;

  const sumAvail = contentWidth - SUMMARY_PAD_H * 2 - SUMMARY_GAP * 2;
  const flexSum = SUMMARY_COL_LEFT_FLEX + SUMMARY_COL_MID_FLEX + SUMMARY_COL_RIGHT_FLEX;
  const sLeftW = sumAvail * SUMMARY_COL_LEFT_FLEX / flexSum;
  const sMidW = sumAvail * SUMMARY_COL_MID_FLEX / flexSum;
  const sRightW = sumAvail * SUMMARY_COL_RIGHT_FLEX / flexSum;
  const sLeftX = left + SUMMARY_PAD_H;
  const sMidX = sLeftX + sLeftW + SUMMARY_GAP;
  const sRightX = sMidX + sMidW + SUMMARY_GAP;
  const sMidInnerX = sMidX + SUMMARY_COL_MID_PAD_H;
  const sMidInnerW = sMidW - SUMMARY_COL_MID_PAD_H * 2;

  // Frontend: <div><strong>Total Items :</strong> {count} of {count}</div>
  // — only the LABEL is inside <strong>; the count itself is plain weight.
  // Same for "Refference # :" below. Previously the whole line was drawn
  // bold, which is why the values looked bold when they shouldn't.
  doc.font(F.Bold).fontSize(SUMMARY_SIZE)
    .text('Total Items : ', sLeftX, sumTop, { continued: true });
  doc.font(F.Regular).fontSize(SUMMARY_SIZE)
    .text(`${data.rows.length} of ${data.rows.length}`, { width: sLeftW });
  let lY = doc.y + SUMMARY_REF_MARGIN_TOP;
  if (isWarranty && data.reference_no != null) {
    doc.font(F.Bold).fontSize(SUMMARY_SIZE)
      .text('Refference # : ', sLeftX, lY, { continued: true });
    doc.font(F.Regular).fontSize(SUMMARY_SIZE)
      .text(`${fmtInt(data.reference_no)}`, { width: sLeftW });
    lY = doc.y + SUMMARY_REF_MARGIN_TOP;
  }
  doc.font(F.Bold).fontSize(SUMMARY_WORDS_SIZE).text(numberToWords(Math.floor(data.net_amount)), sLeftX, lY + (SUMMARY_WORDS_MARGIN_TOP - SUMMARY_REF_MARGIN_TOP), { width: sLeftW, characterSpacing: 0.2 });
  lY = doc.y;

  // Frontend: .summary-line span:last-child { font-weight:600 } — every
  // ordinary summary line has an unbold label and a bold value. But
  // .summary-net span { font-weight:700 !important } forces BOTH the label
  // and the value bold for the Net Amount row. Previously `bold` was
  // accepted as a parameter here but never actually used, so the Net Amount
  // label always rendered unbold regardless of the flag.
  function sumLine(x, w, yy, label, value, bold) {
    const labelFont = bold ? F.Bold : F.Regular;
    doc.font(labelFont).fontSize(SUMMARY_SIZE);
    const labelW = doc.widthOfString(label) + 2;
    doc.font(labelFont).fontSize(SUMMARY_SIZE).text(label, x, yy, { width: labelW, lineBreak: false });
    doc.font(F.Bold).fontSize(SUMMARY_SIZE).text(value, x, yy, { width: w, align: 'right', lineBreak: false });
    return yy + SUMMARY_LINE_H;
  }

  let mY = sumTop;
  mY = sumLine(sMidInnerX, sMidInnerW, mY, 'Current Amount :', fmtInt(data.net_amount));
  mY = sumLine(sMidInnerX, sMidInnerW, mY, 'Previous :', fmtInt(data.prev_balance));
  mY = sumLine(sMidInnerX, sMidInnerW, mY, 'Paid :', '0');
  mY = sumLine(sMidInnerX, sMidInnerW, mY, 'Balance :', fmtInt(data.total_balance));

  let rY = sumTop;
  rY = sumLine(sRightX, sRightW, rY, 'Gross Amount :', fmt2(data.gross_amount));
  rY = sumLine(sRightX, sRightW, rY, 'Discount :', fmt2(data.total_disc_amount));
  rY = sumLine(sRightX, sRightW, rY, 'Sp. Discount :', '0.00');
  rY = sumLine(sRightX, sRightW, rY, 'GST :', fmt2(isWarranty ? 0 : data.total_tax_amount));
  rY = sumLine(sRightX, sRightW, rY, 'Advance Inc Tax :', '0.00');
  rY = sumLine(sRightX, sRightW, rY, 'Printing Charges :', '0.00');
  doc.moveTo(sRightX, rY + SUMMARY_NET_MARGIN_TOP).lineTo(sRightX + sRightW, rY + SUMMARY_NET_MARGIN_TOP).lineWidth(SUMMARY_NET_BORDER_W).strokeColor('#000').stroke();
  rY = sumLine(sRightX, sRightW, rY + SUMMARY_NET_MARGIN_TOP + SUMMARY_NET_PAD_TOP, 'Net Amount :', fmt2(data.net_amount), true);

  y = Math.max(lY, mY, rY) + SUMMARY_PAD_V;
  doc.moveTo(left, y).lineTo(right, y).lineWidth(SUMMARY_BORDER_W).strokeColor('#000').stroke();

  // ── Warranty / DRAP section (only for warranty-type invoices) ───────────────
  if (isWarranty) {
    y += WARRANTY_MARGIN_TOP;
    y = ensureSpace(doc, y, 170);
    doc.font(F.BoldItalic).fontSize(WARRANTY_SIZE)
      .text('* EXPIRY CLAIMS WILL BE ACCEPTED SIX(6) MONTHS BEFORE EXPIRY.', left, y, { width: contentWidth, lineGap: WARRANTY_SIZE * (WARRANTY_LINE_HEIGHT - 1) });
    y = doc.y + WARRANTY_EXPIRY_MARGIN_BOTTOM;

    const wFlexSum = WARRANTY_TEXT_FLEX + WARRANTY_SIGN_FLEX;
    const wAvail = contentWidth - WARRANTY_ROW_GAP;
    const wTextW = wAvail * WARRANTY_TEXT_FLEX / wFlexSum;
    const signW = wAvail * WARRANTY_SIGN_FLEX / wFlexSum;
    const signX = left + wTextW + WARRANTY_ROW_GAP;
    const rowTop = y;

    const lineGap = WARRANTY_SIZE * (WARRANTY_LINE_HEIGHT - 1);
    doc.font(F.Regular).fontSize(WARRANTY_SIZE).text('Form 2A (See Rules 19 & 30)', left, y, { width: wTextW, lineGap });
    doc.font(F.Bold).fontSize(WARRANTY_SIZE).text('Warranty under section 23(1)(i) of the Drug Act 1976.', left, doc.y + WARRANTY_HEADING_MARGIN, { width: wTextW, lineGap });

    // Frontend: "...carrying on business at Company Address <strong>{address}</strong>
    // under the name <strong>{name}</strong> and being an authorised agent..."
    // — address and name are bold INLINE inside an otherwise-regular
    // paragraph. Previously the whole paragraph was drawn in one Regular
    // .text() call, so the company name/address never came out bold here.
    // Built as a chain of continued:true segments so it still wraps/justifies
    // as one paragraph, just with two bold runs inside it.
    doc.font(F.Regular).fontSize(WARRANTY_SIZE).text(
      'I being a person resident in Pakistan carrying on business at Company Address ',
      left, doc.y + WARRANTY_HEADING_MARGIN,
      { width: wTextW, align: 'justify', lineGap, continued: true }
    );
    doc.font(F.Bold).fontSize(WARRANTY_SIZE).text(companyAddress, { continued: true });
    doc.font(F.Regular).fontSize(WARRANTY_SIZE).text(' under the name ', { continued: true });
    doc.font(F.Bold).fontSize(WARRANTY_SIZE).text(companyName, { continued: true });
    doc.font(F.Regular).fontSize(WARRANTY_SIZE).text(
      ' and being an authorised agent, do hereby give this warranty that the drugs sold by me donot contravene in anyway the provisions of section 23 of the drug act 1976.',
      { continued: false }
    );

    doc.font(F.Regular).fontSize(WARRANTY_SIZE).text(
      'Note: This warranty does not apply to Unani, Homeopathic, Bio Chemic System of Medicine and General Items, if',
      left, doc.y + WARRANTY_NOTE_MARGIN_TOP, { width: wTextW, lineGap }
    );
    const drugBlockBottom = doc.y;

    const signLineY = rowTop + WARRANTY_SIGN_PAD_TOP;
    const signLineInset = signW * (1 - 0.78) / 2;
    doc.moveTo(signX + signLineInset, signLineY).lineTo(signX + signW - signLineInset, signLineY)
      .lineWidth(WARRANTY_SIGN_LINE_W).strokeColor('#000').stroke();

    // Frontend: For <strong>{company.name}</strong> — "For " is regular
    // weight, the company name itself is bold.
    //
    // NOTE: `align:'center'` combined with `continued:true` is unreliable in
    // PDFKit — the second segment's cursor handoff doesn't respect the
    // centered start position the way it does for a single-font line, so
    // "For " and companyName ended up drawn on top of each other instead of
    // side by side. Centering is computed manually here instead (measure
    // both segments at their real fonts, find the combined width, derive the
    // start x), and align is dropped entirely from the continued run.
    doc.font(F.Regular).fontSize(WARRANTY_SIGN_SIZE);
    const forLabel = 'For ';
    const forW = doc.widthOfString(forLabel);
    doc.font(F.Bold).fontSize(WARRANTY_SIGN_SIZE);
    const signNameW = doc.widthOfString(companyName);
    const signStartX = signX + Math.max(0, (signW - (forW + signNameW)) / 2);
    doc.font(F.Regular).fontSize(WARRANTY_SIGN_SIZE)
      .text(forLabel, signStartX, signLineY + WARRANTY_SIGN_LINE_MARGIN_BOTTOM, { lineBreak: false, continued: true });
    doc.font(F.Bold).fontSize(WARRANTY_SIGN_SIZE).text(companyName, { lineBreak: false, continued: false });

    y = Math.max(drugBlockBottom, signLineY + WARRANTY_SIGN_LINE_MARGIN_BOTTOM + WARRANTY_SIGN_SIZE * 1.2) + WARRANTY_ROW_MARGIN_BOTTOM;

    y = ensureSpace(doc, y, 80);
    const drapTop = y;
    doc.font(F.Bold).fontSize(WARRANTY_SIZE)
      .text('Warranty under DRAP Act, 2012', left + DRAP_PAD_H, y + DRAP_PAD_V, { width: contentWidth - DRAP_PAD_H * 2, lineGap });

    // Frontend: "...supplied by me under the name <strong>{name}</strong> at
    // <strong>{address}</strong> do not contravene..." — same inline-bold
    // treatment as the Form 2A paragraph above, applied here too.
    doc.font(F.Regular).fontSize(WARRANTY_SIZE).text(
      'It is hereby certified and undertake that above mentioned finished products of specified Batch no. / Lot no. supplied by me under the name ',
      left + DRAP_PAD_H, doc.y + WARRANTY_HEADING_MARGIN,
      { width: contentWidth - DRAP_PAD_H * 2, align: 'justify', lineGap, continued: true }
    );
    doc.font(F.Bold).fontSize(WARRANTY_SIZE).text(companyName, { continued: true });
    doc.font(F.Regular).fontSize(WARRANTY_SIZE).text(' at ', { continued: true });
    doc.font(F.Bold).fontSize(WARRANTY_SIZE).text(companyAddress, { continued: true });
    doc.font(F.Regular).fontSize(WARRANTY_SIZE).text(
      ' do not contravene any provision of the DRAP Act, 2012 and rules framed there under. The authorized agent (with valid distribution authority letter) shall pass on this warranty to the retailers in his area of jurisdiction during the supply',
      { continued: false }
    );

    const drapBottom = doc.y + DRAP_PAD_V;
    doc.lineWidth(DRAP_BORDER_W).strokeColor('#000').rect(left, drapTop, contentWidth, drapBottom - drapTop).stroke();
    y = drapBottom;
  }

  // ── Footer — pinned near the bottom of the final page, like the CSS
  // position:absolute footer (bottom:6mm), rather than flowing with content ──
  //
  // This position is deliberately below doc.page.margins.bottom (the CSS
  // footer sits inside the page's own bottom padding, not inside the
  // content area above it). PDFKit's .text() auto-inserts a new page
  // whenever the given y falls outside the current margin-constrained
  // area — which this always would, by design — so the margin is relaxed
  // just for these two calls, then restored.
  const footerLineY = doc.page.height - FOOTER_BOTTOM - (FOOTER_PAD_TOP + FOOTER_SIZE * 1.2);
  const safeFooterLineY = Math.max(footerLineY, y + 6); // never overlap content that ran long
  const originalBottomMargin = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;

  doc.moveTo(left, safeFooterLineY).lineTo(right, safeFooterLineY).lineWidth(FOOTER_BORDER_W).strokeColor('#000').stroke();
  const printedLabel = data.printed_at_label ? `Printed At: ${data.printed_at_label}` : 'Printed At: \u2014';
  doc.font(F.Regular).fontSize(FOOTER_SIZE).text(printedLabel, left, safeFooterLineY + FOOTER_PAD_TOP, { width: contentWidth * 0.6, lineBreak: false });
  doc.font(F.Regular).fontSize(FOOTER_SIZE).text(`Powered by ${companyName} Distribution System`, left, safeFooterLineY + FOOTER_PAD_TOP, { width: contentWidth, align: 'right', lineBreak: false });

  doc.page.margins.bottom = originalBottomMargin;
  doc.flushPages();
  doc.end();
}

// ─── List every invoice currently sitting in the Print Queue ───────────────
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

// ─── Save Draft ──────────────────────────────────────────────────────────
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

// ─── Remove several rows at once ────────────────────────────────────────
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

// ─── Remove a single row ────────────────────────────────────────────────
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