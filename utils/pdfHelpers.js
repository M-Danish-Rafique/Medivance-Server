const path = require('path');
const fs = require('fs');
const { getPublicDir } = require('./paths');

const LOGO_DARK_PATH = path.join(getPublicDir(), 'logo-dark.png');
const LOGO_LIGHT_PATH = path.join(getPublicDir(), 'logo-light.png');
const PDF_FOOTER_HEIGHT = 32;

function getLogoPath(variant = 'dark') {
  const p = variant === 'light' ? LOGO_LIGHT_PATH : LOGO_DARK_PATH;
  if (fs.existsSync(p)) return p;
  const alt = variant === 'light' ? LOGO_DARK_PATH : LOGO_LIGHT_PATH;
  return fs.existsSync(alt) ? alt : null;
}

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

function getPdfFooterY(doc) {
  return doc.page.height - PDF_FOOTER_HEIGHT;
}

function getPdfContentBottom(doc) {
  return doc.page.height - PDF_FOOTER_HEIGHT - 14;
}

/** Draw footer at a fixed position at the bottom of the current page. */
function drawPdfFooterAtBottom(doc, { left, right, contentWidth, companyName }) {
  const footerY = getPdfFooterY(doc);
  const savedY = doc.y;
  const savedX = doc.x;

  doc.strokeColor('#000').fillColor('#000');
  doc.moveTo(left, footerY).lineTo(right, footerY).lineWidth(0.5).stroke();

  const textY = footerY + 5;
  const printedAt = `Printed At: ${new Date().toLocaleString('en-PK')}`;
  const poweredBy = `Powered by ${companyName} Distribution System`;

  doc.font('Helvetica').fontSize(7.5);
  doc.text(printedAt, left, textY, { width: contentWidth * 0.55, lineBreak: false });
  doc.text(poweredBy, left, textY, { width: contentWidth, align: 'right', lineBreak: false });

  doc.x = savedX;
  doc.y = savedY;
}

/** Stamp fixed footer on every buffered page (call before doc.end()). */
function stampPdfFootersOnAllPages(doc, footerOpts) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    drawPdfFooterAtBottom(doc, footerOpts);
  }
}

function ensureSpace(doc, y, neededHeight) {
  const pageBottom = getPdfContentBottom(doc);
  if (y + neededHeight > pageBottom) {
    doc.addPage();
    return 40;
  }
  return y;
}

function buildPdfColumns(left, contentWidth, specs) {
  const fixedTotal = specs.reduce((sum, col) => sum + (typeof col.w === 'number' ? col.w : 0), 0);
  const flexCount = specs.filter((col) => col.w === 'flex').length;
  const flexWidth = flexCount > 0 ? (contentWidth - fixedTotal) / flexCount : 0;
  let x = left;
  return specs.map((spec) => {
    const w = spec.w === 'flex' ? flexWidth : spec.w;
    const col = { label: spec.label, align: spec.align || 'left', w, x };
    x += w;
    return col;
  });
}

function drawReportHeader(doc, { company, title, subtitle, left, right, contentWidth }) {
  const companyName = company?.name || 'Medivance';
  const companyAddress = company?.address || '';
  const companyContact = [company?.phone, company?.email].filter(Boolean).join('   |   ');

  doc.fillColor('#000');
  const logoOffset = drawPdfLogo(doc, left, 38, 42);
  const headerTextX = left + logoOffset;
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
  doc.font('Helvetica').fontSize(8).text(`Generated: ${new Date().toLocaleDateString('en-GB')}`, left, doc.y + 2, { width: contentWidth, align: 'right', lineBreak: false });
  doc.fillColor('#000');

  return Math.max(headerY, doc.y) + 14;
}

function drawFilterBox(doc, { left, contentWidth, y, filters }) {
  const boxTop = y;
  doc.font('Helvetica').fontSize(8.5);
  let ey = y + 8;
  filters.filter(Boolean).forEach((line) => {
    doc.text(line, left + 10, ey, { width: contentWidth - 20, lineBreak: false });
    ey += 12;
  });
  const boxHeight = Math.max(28, ey - boxTop + 4);
  doc.rect(left, boxTop, contentWidth, boxHeight).stroke('#000');
  return boxTop + boxHeight + 10;
}

module.exports = {
  getLogoPath,
  drawPdfLogo,
  drawPdfFooterAtBottom,
  stampPdfFootersOnAllPages,
  getPdfContentBottom,
  ensureSpace,
  buildPdfColumns,
  drawReportHeader,
  drawFilterBox,
};
