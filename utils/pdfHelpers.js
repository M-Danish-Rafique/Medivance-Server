const path = require('path');
const fs = require('fs');
const { getPublicDir } = require('./paths');

const LOGO_DARK_PATH = path.join(getPublicDir(), 'logo-dark.png');
const LOGO_LIGHT_PATH = path.join(getPublicDir(), 'logo-light.png');

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

/** Draw footer inline after content — avoids orphaning text onto extra pages. */
function drawPdfFooterInline(doc, { left, right, contentWidth, y, companyName }) {
  const footerBlockHeight = 22;
  const pageBottom = doc.page.height - 40;

  if (y + footerBlockHeight > pageBottom) {
    doc.addPage();
    y = 40;
  }

  doc.strokeColor('#000').fillColor('#000');
  doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).stroke();

  const textY = y + 5;
  const printedAt = `Printed At: ${new Date().toLocaleString('en-PK')}`;
  const poweredBy = `Powered by ${companyName} Distribution System`;

  doc.font('Helvetica').fontSize(7.5);
  doc.text(printedAt, left, textY, { width: contentWidth * 0.55, lineBreak: false });
  doc.text(poweredBy, left, textY, { width: contentWidth, align: 'right', lineBreak: false });

  return y + footerBlockHeight;
}

function ensureSpace(doc, y, neededHeight) {
  const pageBottom = doc.page.height - 50;
  if (y + neededHeight > pageBottom) {
    doc.addPage();
    return 40;
  }
  return y;
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
  drawPdfFooterInline,
  ensureSpace,
  drawReportHeader,
  drawFilterBox,
};
