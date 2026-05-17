/**
 * SignVault PDF Service
 * Embeds signature image + QR code into PDF using pdf-lib
 */

const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { sha256Buffer } = require('../utils/crypto');
const logger = require('../utils/logger');

/**
 * Generate QR code PNG buffer for a verification URL.
 * @param {string} verificationCode UUID
 * @returns {Promise<Buffer>}
 */
async function generateQrBuffer(verificationCode) {
  const url = `${process.env.FRONTEND_URL}/verificar/${verificationCode}`;
  return QRCode.toBuffer(url, {
    type: 'png',
    width: 200,
    margin: 2,
    color: { dark: '#1E40AF', light: '#FFFFFF' },
    errorCorrectionLevel: 'H',
  });
}

/**
 * Save QR code PNG to disk and return its path.
 * @param {string} verificationCode
 * @returns {Promise<{ path: string, buffer: Buffer }>}
 */
async function saveQrCode(verificationCode) {
  const buffer = await generateQrBuffer(verificationCode);
  const filename = `qr_${verificationCode}.png`;
  const filePath = path.join(process.cwd(), 'uploads', 'qr', filename);
  fs.writeFileSync(filePath, buffer);
  return { path: filePath, buffer };
}

/**
 * Embed a signature image and QR code into a PDF.
 *
 * @param {object} params
 * @param {Buffer}  params.pdfBuffer         - Original PDF bytes
 * @param {string}  params.signatureDataUrl  - Base64 data URL of the signature (PNG/JPEG)
 * @param {number}  params.x                 - X position (pt from left, 0-based)
 * @param {number}  params.y                 - Y position (pt from bottom, 0-based)
 * @param {number}  params.page              - 1-based page number
 * @param {number}  params.width             - Signature width in points
 * @param {number}  params.height            - Signature height in points
 * @param {string}  params.signerName        - Name to display below signature
 * @param {string}  params.signedAt          - ISO date string
 * @param {string}  params.verificationCode  - UUID for QR generation
 * @param {Buffer}  params.qrBuffer          - QR PNG buffer (pre-generated)
 *
 * @returns {Promise<{ pdfBuffer: Buffer, sha256: string }>}
 */
async function embedSignatureInPdf({
  pdfBuffer,
  signatureDataUrl,
  x,
  y,
  page: pageNumber = 1,
  width = 150,
  height = 60,
  signerName,
  signedAt,
  verificationCode,
  qrBuffer,
}) {
  try {
    const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    const pages = pdfDoc.getPages();
    const pageIndex = Math.max(0, pageNumber - 1);
    const targetPage = pages[pageIndex] || pages[0];
    const { height: pageHeight } = targetPage.getSize();

    // ── Embed signature image ─────────────────────────────────────────────────
    let sigImage;
    if (signatureDataUrl) {
      const base64Data = signatureDataUrl.split(',')[1];
      const imgBuffer = Buffer.from(base64Data, 'base64');
      const isJpeg = signatureDataUrl.startsWith('data:image/jpeg');
      sigImage = isJpeg
        ? await pdfDoc.embedJpg(imgBuffer)
        : await pdfDoc.embedPng(imgBuffer);

      // PDF coordinate system: Y=0 is bottom. Convert from canvas coords.
      const pdfY = pageHeight - y - height;

      targetPage.drawImage(sigImage, {
        x,
        y: pdfY,
        width,
        height,
        opacity: 1,
      });
    }

    // ── Embed QR code ─────────────────────────────────────────────────────────
    if (qrBuffer) {
      const qrImage = await pdfDoc.embedPng(qrBuffer);
      const qrSize = 80;
      // Place QR at bottom-right corner of the page
      const { width: pageWidth } = targetPage.getSize();
      const qrX = pageWidth - qrSize - 20;
      const qrY = 20;

      targetPage.drawImage(qrImage, {
        x: qrX,
        y: qrY,
        width: qrSize,
        height: qrSize,
      });

      // ── Signature metadata text ───────────────────────────────────────────
      const font = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
      const fontSize = 6;
      const textColor = rgb(0.4, 0.4, 0.4);
      const dateStr = new Date(signedAt).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });

      targetPage.drawText(`Firmado digitalmente por: ${signerName}`, {
        x: qrX - 120,
        y: qrY + 60,
        size: fontSize,
        font,
        color: textColor,
        maxWidth: 110,
      });
      targetPage.drawText(`Fecha: ${dateStr}`, {
        x: qrX - 120,
        y: qrY + 50,
        size: fontSize,
        font,
        color: textColor,
      });
      targetPage.drawText(`ID: ${verificationCode.slice(0, 8)}...`, {
        x: qrX - 120,
        y: qrY + 40,
        size: fontSize,
        font,
        color: textColor,
      });
      targetPage.drawText('Verificar en: signvault.app/verificar', {
        x: qrX - 120,
        y: qrY + 30,
        size: fontSize,
        font,
        color: rgb(0.12, 0.25, 0.69),
      });
    }

    const signedBytes = await pdfDoc.save();
    const signedBuffer = Buffer.from(signedBytes);
    const hash = sha256Buffer(signedBuffer);

    return { pdfBuffer: signedBuffer, sha256: hash };
  } catch (err) {
    logger.error('Error embedding signature in PDF', { error: err.message });
    throw err;
  }
}

/**
 * Save a PDF buffer to disk.
 * @param {Buffer} buffer
 * @param {string} filename
 * @returns {string} file path
 */
function savePdf(buffer, filename) {
  const filePath = path.join(process.cwd(), 'uploads', 'signed', filename);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

module.exports = { embedSignatureInPdf, generateQrBuffer, saveQrCode, savePdf };
