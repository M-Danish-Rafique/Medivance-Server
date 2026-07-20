const path = require('path');
const fs   = require('fs');
const { getPublicDir } = require('./paths');
const { formatDatePKT, formatDateTimePKT } = require('./dateUtils');

const LOGO_DARK_PATH  = path.join(getPublicDir(), 'logo-dark.png');
const LOGO_LIGHT_PATH = path.join(getPublicDir(), 'logo-light.png');

/**
 * Height (pt) of the footer band at the bottom of every page.
 * getPdfContentBottom() keeps table rows above this zone.
 */
const PDF_FOOTER_HEIGHT = 32;

// ─── Logo ─────────────────────────────────────────────────────────────────────

function getLogoPath(variant = 'dark') {
  const primary  = variant === 'light' ? LOGO_LIGHT_PATH : LOGO_DARK_PATH;
  if (fs.existsSync(primary)) return primary;
  const fallback = variant === 'light' ? LOGO_DARK_PATH  : LOGO_LIGHT_PATH;
  return fs.existsSync(fallback) ? fallback : null;
}

/**
 * Draws the company logo at (x, y) inside a fit box of `size × size` pt.
 * Returns the horizontal offset consumed so callers can position text after it.
 * Returns 0 if no logo file is found.
 */
function drawPdfLogo(doc, x, y, size = 42, variant = 'dark') {
  const logoPath = getLogoPath(variant);
  if (!logoPath) return 0;
  try {
    doc.image(logoPath, x, y, { fit: [size, size] });
    return size + 10;
  } catch {
    return 0;
  }
}

// ─── Footer Y helpers ─────────────────────────────────────────────────────────

/** Absolute Y of the footer rule line from the top of the page. */
function getPdfFooterY(doc) {
  return doc.page.height - PDF_FOOTER_HEIGHT;
}

/**
 * Absolute Y below which NO table content should be drawn.
 * Leaves 14 pt of breathing room above the footer rule line.
 */
function getPdfContentBottom(doc) {
  return doc.page.height - PDF_FOOTER_HEIGHT - 14;
}

// ─── Row height measurement ───────────────────────────────────────────────────

/**
 * Returns the actual height a table row will occupy.
 *
 * Pass every cell as { text, width } where `width` is exactly the value you
 * pass to doc.text() (after any padding subtraction).  The function uses
 * PDFKit's own heightOfString() so the result always matches rendering.
 *
 * Works correctly for 1-line, 2-line, 3-line, and longer content.
 *
 * @param {PDFDocument} doc        Must have the correct font/size already set.
 * @param {Array<{text:string, width:number}>} cells
 * @param {number} minHeight       Floor (default 18 pt).
 * @returns {number}
 */
function measureRowHeight(doc, cells, minHeight = 18) {
  let maxTextH = 0;
  for (const { text, width } of cells) {
    if (!text || width <= 0) continue;
    const h = doc.heightOfString(String(text), { width });
    if (h > maxTextH) maxTextH = h;
  }
  // 4 pt top-pad (matches the `y + 4` used in draw calls) + text + 4 pt bottom pad
  return Math.max(minHeight, maxTextH + 8);
}

// ─── Footer drawing ───────────────────────────────────────────────────────────

/**
 * Draws the footer on the CURRENT page using fully absolute coordinates.
 *
 * KEY FIX: PDFKit's auto-page-break fires whenever a text call's Y position
 * exceeds (page.height − margins.bottom).  Because the footer rule sits in the
 * bottom margin zone (footerY > page.height − 40), every doc.text() call there
 * would silently insert a new page — which is exactly what caused the footer
 * to split across pages.
 *
 * The fix: zero out margins.bottom before the footer draw calls and restore it
 * afterward.  This disables the auto-break for just those calls, allowing the
 * text to render at the intended absolute position without any page insertion.
 */
function drawPdfFooterAtBottom(doc, { left, right, contentWidth, companyName }) {
  const footerY = getPdfFooterY(doc);   // e.g. 809.89 on A4
  const textY   = footerY + 5;         // e.g. 814.89 — inside the bottom margin zone

  // ── Disable auto-page-break for the footer zone ──────────────────────────
  const savedMarginBottom   = doc.page.margins.bottom;
  doc.page.margins.bottom   = 0;   // prevents PDFKit from firing a page-break at textY

  // Rule line
  doc
    .strokeColor('#000')
    .fillColor('#000')
    .moveTo(left, footerY)
    .lineTo(right, footerY)
    .lineWidth(0.5)
    .stroke();

  const printedAt = `Printed At: ${formatDateTimePKT(new Date())}`;
  const poweredBy = `Powered by ${companyName} Distribution System`;

  doc.font('Helvetica').fontSize(7.5).fillColor('#444');

  // Both calls use the same absolute textY — they cannot split across pages
  doc.text(printedAt, left, textY, {
    width:     contentWidth * 0.55,
    lineBreak: false,
  });
  doc.text(poweredBy, left, textY, {
    width:     contentWidth,
    align:     'right',
    lineBreak: false,
  });

  // ── Restore margin ────────────────────────────────────────────────────────
  doc.page.margins.bottom = savedMarginBottom;
}

/**
 * Stamps the footer on EVERY buffered page.
 * Call after all content, before doc.end():
 *
 *   stampPdfFootersOnAllPages(doc, footerOpts);
 *   doc.flushPages();
 *   doc.end();
 */
function stampPdfFootersOnAllPages(doc, footerOpts) {
  const { start, count } = doc.bufferedPageRange();
  for (let i = 0; i < count; i++) {
    doc.switchToPage(start + i);
    drawPdfFooterAtBottom(doc, footerOpts);
  }
}

// ─── Space guard ─────────────────────────────────────────────────────────────

/**
 * If fewer than `neededHeight` points remain before the footer zone, adds a
 * new page and returns the top-margin Y.  Otherwise returns y unchanged.
 */
function ensureSpace(doc, y, neededHeight) {
  if (y + neededHeight > getPdfContentBottom(doc)) {
    doc.addPage();
    return doc.page.margins.top;
  }
  return y;
}

// ─── Column builder ───────────────────────────────────────────────────────────

/**
 * Converts a column spec array into a positioned layout.
 * Exactly one column may use w:'flex' to absorb the remaining width.
 */
function buildPdfColumns(left, contentWidth, specs) {
  const fixedTotal = specs.reduce((s, c) => s + (typeof c.w === 'number' ? c.w : 0), 0);
  const flexCount  = specs.filter(c => c.w === 'flex').length;
  const flexWidth  = flexCount > 0 ? (contentWidth - fixedTotal) / flexCount : 0;

  let x = left;
  return specs.map(spec => {
    const w   = spec.w === 'flex' ? flexWidth : spec.w;
    const col = { label: spec.label, align: spec.align || 'left', w, x };
    x += w;
    return col;
  });
}

// ─── Report header ────────────────────────────────────────────────────────────

/**
 * Draws the standard two-column report header (logo + company info left,
 * title block right).  Returns the Y where body content should start.
 */
function drawReportHeader(doc, { company, title, subtitle, left, right, contentWidth }) {
  const companyName    = company?.name    || 'Medivance';
  const companyAddress = company?.address || '';
  const companyContact = [company?.phone, company?.email].filter(Boolean).join('   |   ');

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

  doc.font('Helvetica-Bold').fontSize(15).text(title, left, 40, { width: contentWidth, align: 'right', lineBreak: false });
  if (subtitle) {
    doc.font('Helvetica').fontSize(9).text(subtitle, left, doc.y + 2, { width: contentWidth, align: 'right', lineBreak: false });
  }
  doc.font('Helvetica').fontSize(8).text(
    `Generated: ${formatDatePKT(new Date())}`,
    left, doc.y + 2,
    { width: contentWidth, align: 'right', lineBreak: false }
  );
  doc.fillColor('#000');

  return Math.max(headerY, doc.y) + 14;
}

// ─── Filter box ───────────────────────────────────────────────────────────────

/**
 * Draws a bordered filter-summary box and returns the Y below it.
 * Falsy entries in `filters` are skipped.
 */
function drawFilterBox(doc, { left, contentWidth, y, filters }) {
  const boxTop = y;
  const lines  = filters.filter(Boolean);

  doc.font('Helvetica').fontSize(8.5);
  let ey = y + 8;
  lines.forEach(line => {
    doc.text(line, left + 10, ey, { width: contentWidth - 20, lineBreak: false });
    ey += 12;
  });

  const boxHeight = Math.max(28, ey - boxTop + 4);
  doc.rect(left, boxTop, contentWidth, boxHeight).stroke('#000');
  return boxTop + boxHeight + 10;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  getLogoPath,
  drawPdfLogo,
  drawPdfFooterAtBottom,
  stampPdfFootersOnAllPages,
  getPdfFooterY,
  getPdfContentBottom,
  measureRowHeight,
  ensureSpace,
  buildPdfColumns,
  drawReportHeader,
  drawFilterBox,
};