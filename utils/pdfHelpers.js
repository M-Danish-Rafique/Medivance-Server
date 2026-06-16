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

/** Draw company logo; returns width used (logo size + gap), or 0 if no logo. */
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

/** Draw footer pinned to the bottom of the current PDF page. */
function drawPdfFooterAtBottom(doc, { left, right, contentWidth, companyName }) {
  const footerY = doc.page.height - 32;
  doc.strokeColor('#000').fillColor('#000');
  doc.moveTo(left, footerY).lineTo(right, footerY).lineWidth(0.5).stroke();
  doc.font('Helvetica').fontSize(7.5);
  const printedAt = `Printed At: ${new Date().toLocaleString('en-PK')}`;
  const poweredBy = `Powered by ${companyName} Distribution System`;
  doc.text(printedAt, left, footerY + 5, { width: contentWidth * 0.55, lineBreak: false });
  doc.text(poweredBy, left, footerY + 5, { width: contentWidth, align: 'right', lineBreak: false });
}

/** Ensure content fits above the fixed footer zone. */
function ensureSpace(doc, y, neededHeight) {
  const pageBottom = doc.page.height - 48;
  if (y + neededHeight > pageBottom) {
    doc.addPage();
    return 40;
  }
  return y;
}

module.exports = { getLogoPath, drawPdfLogo, drawPdfFooterAtBottom, ensureSpace };
