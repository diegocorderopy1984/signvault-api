/**
 * Signature Controller
 * POST /api/signatures/sign      - Sign a document
 * GET  /api/signatures           - List user's signatures
 * GET  /api/signatures/:id       - Get signature detail
 * GET  /api/signatures/:id/pdf   - Download signed PDF
 * GET  /api/signatures/:id/qr    - Download QR code PNG
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const prisma          = require('../prisma/client');
const { encrypt }     = require('../utils/crypto');
const { reverseGeocode, geolocateByIp, extractIp } = require('../utils/geolocation');
const { embedSignatureInPdf, saveQrCode, savePdf } = require('../services/pdfService');
const logger          = require('../utils/logger');

// ─── Sign Document ─────────────────────────────────────────────────────────────
async function signDocument(req, res, next) {
  try {
    const {
      documentId,
      signatureDataUrl,   // base64 PNG/JPEG data URL
      x = 50,
      y = 100,
      page = 1,
      width = 150,
      height = 60,
      // Geolocation from client
      latitude,
      longitude,
      accuracyMeters,
      address: clientAddress,
      geoSource = 'NONE',
    } = req.body;

    // ── Validate required fields ──────────────────────────────────────────────
    if (!documentId) {
      return res.status(400).json({ error: 'documentId es requerido.' });
    }
    if (!signatureDataUrl) {
      return res.status(400).json({ error: 'La firma (signatureDataUrl) es requerida.' });
    }
    if (!signatureDataUrl.startsWith('data:image/')) {
      return res.status(400).json({ error: 'Formato de firma inválido. Se esperaba data URL de imagen.' });
    }

    // ── Load document ─────────────────────────────────────────────────────────
    const document = await prisma.document.findUnique({ where: { id: documentId } });
    if (!document) {
      return res.status(404).json({ error: 'Documento no encontrado.' });
    }
    if (!fs.existsSync(document.storagePath)) {
      return res.status(404).json({ error: 'Archivo PDF no encontrado en disco.' });
    }

    const pdfBuffer = fs.readFileSync(document.storagePath);

    // ── Geolocation ───────────────────────────────────────────────────────────
    let finalLat     = latitude     ? parseFloat(latitude)     : null;
    let finalLon     = longitude    ? parseFloat(longitude)    : null;
    let finalAccuracy = accuracyMeters ? parseFloat(accuracyMeters) : null;
    let finalAddress  = clientAddress  || null;
    let finalGeoSource = geoSource;

    // If no GPS data, try IP geolocation
    if (!finalLat || !finalLon) {
      const ip = extractIp(req);
      const ipGeo = await geolocateByIp(ip);
      if (ipGeo) {
        finalLat       = ipGeo.lat;
        finalLon       = ipGeo.lon;
        finalAddress   = ipGeo.address;
        finalGeoSource = 'IP';
      }
    }

    // Reverse geocode if we have coords but no address
    if (finalLat && finalLon && !finalAddress) {
      finalAddress = await reverseGeocode(finalLat, finalLon);
    }

    // ── Collect device/network info ───────────────────────────────────────────
    const ip        = extractIp(req);
    const userAgent = req.headers['user-agent'] || '';
    const deviceInfo = JSON.stringify({
      platform: req.headers['sec-ch-ua-platform'] || '',
      mobile:   req.headers['sec-ch-ua-mobile']   || '',
      browser:  req.headers['sec-ch-ua']          || '',
    });

    // ── Encrypt signature image ───────────────────────────────────────────────
    const { encrypted: signatureDataEncrypted, iv: signatureIv } = encrypt(signatureDataUrl);

    // ── Generate verification code + QR ──────────────────────────────────────
    const verificationCode = uuidv4();
    const { path: qrPath, buffer: qrBuffer } = await saveQrCode(verificationCode);

    // ── Embed signature + QR into PDF ─────────────────────────────────────────
    const { pdfBuffer: signedPdfBuffer, sha256: sha256Signed } = await embedSignatureInPdf({
      pdfBuffer,
      signatureDataUrl,
      x: parseFloat(x),
      y: parseFloat(y),
      page: parseInt(page, 10),
      width: parseFloat(width),
      height: parseFloat(height),
      signerName: req.user.name,
      signedAt: new Date().toISOString(),
      verificationCode,
      qrBuffer,
    });

    // ── Save signed PDF ───────────────────────────────────────────────────────
    const signedFilename = `signed_${verificationCode}.pdf`;
    const signedPdfPath  = savePdf(signedPdfBuffer, signedFilename);

    // ── Persist signature to DB ───────────────────────────────────────────────
    const signature = await prisma.signature.create({
      data: {
        verificationCode,
        userId:     req.user.id,
        documentId: document.id,

        signedPdfPath,
        sha256Signed,

        signatureDataEncrypted,
        signatureIv,

        signatureX:      parseFloat(x),
        signatureY:      parseFloat(y),
        signaturePage:   parseInt(page, 10),
        signatureWidth:  parseFloat(width),
        signatureHeight: parseFloat(height),

        qrCodePath: qrPath,

        latitude:       finalLat,
        longitude:      finalLon,
        accuracyMeters: finalAccuracy,
        address:        finalAddress,
        geoSource:      finalGeoSource,

        ipAddress: ip,
        userAgent,
        deviceInfo,
      },
      include: {
        user:     { select: { id: true, name: true, email: true } },
        document: { select: { id: true, originalName: true, sha256Original: true } },
      },
    });

    // ── Immutable audit log ───────────────────────────────────────────────────
    await prisma.auditLog.create({
      data: {
        userId:      req.user.id,
        signatureId: signature.id,
        action:      'DOCUMENT_SIGNED',
        ipAddress:   ip,
        metadata:    JSON.stringify({
          documentId:        document.id,
          verificationCode,
          sha256Signed,
          geoSource:         finalGeoSource,
          latitude:          finalLat,
          longitude:         finalLon,
          accuracyMeters:    finalAccuracy,
        }),
      },
    });

    logger.info('Document signed', {
      signatureId: signature.id,
      userId: req.user.id,
      documentId: document.id,
      verificationCode,
    });

    // ── Return response ───────────────────────────────────────────────────────
    return res.status(201).json({
      signature: {
        id:               signature.id,
        verificationCode: signature.verificationCode,
        sha256Signed:     signature.sha256Signed,
        signedAt:         signature.signedAt,
        status:           signature.status,
        qrUrl:            `${process.env.PUBLIC_URL}/uploads/qr/qr_${verificationCode}.png`,
        verifyUrl:        `${process.env.FRONTEND_URL}/verificar/${verificationCode}`,
        downloadUrl:      `${process.env.PUBLIC_URL}/uploads/signed/${signedFilename}`,
        geolocation: {
          latitude:  finalLat,
          longitude: finalLon,
          accuracy:  finalAccuracy,
          address:   finalAddress,
          source:    finalGeoSource,
        },
        document: signature.document,
        user:     signature.user,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ─── List Signatures ───────────────────────────────────────────────────────────
async function listSignatures(req, res, next) {
  try {
    const page  = parseInt(req.query.page  || '1', 10);
    const limit = parseInt(req.query.limit || '20', 10);
    const skip  = (page - 1) * limit;

    const [signatures, total] = await Promise.all([
      prisma.signature.findMany({
        where:   { userId: req.user.id },
        include: {
          document: { select: { id: true, originalName: true, sha256Original: true, sizeBytes: true } },
        },
        orderBy: { signedAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.signature.count({ where: { userId: req.user.id } }),
    ]);

    // Strip encrypted signature data from list
    const safe = signatures.map(({ signatureDataEncrypted, signatureIv, ...s }) => ({
      ...s,
      qrUrl:       s.qrCodePath ? `${process.env.PUBLIC_URL}/uploads/qr/qr_${s.verificationCode}.png` : null,
      downloadUrl: s.signedPdfPath ? `${process.env.PUBLIC_URL}/uploads/signed/signed_${s.verificationCode}.pdf` : null,
      verifyUrl:   `${process.env.FRONTEND_URL}/verificar/${s.verificationCode}`,
    }));

    return res.json({ signatures: safe, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    next(err);
  }
}

// ─── Get Single Signature ──────────────────────────────────────────────────────
async function getSignature(req, res, next) {
  try {
    const signature = await prisma.signature.findFirst({
      where: { id: req.params.id, userId: req.user.id },
      include: {
        document: true,
        user: { select: { id: true, name: true, email: true } },
      },
    });

    if (!signature) {
      return res.status(404).json({ error: 'Firma no encontrada.' });
    }

    const { signatureDataEncrypted, signatureIv, ...safe } = signature;
    return res.json({
      signature: {
        ...safe,
        qrUrl:       `${process.env.PUBLIC_URL}/uploads/qr/qr_${signature.verificationCode}.png`,
        downloadUrl: `${process.env.PUBLIC_URL}/uploads/signed/signed_${signature.verificationCode}.pdf`,
        verifyUrl:   `${process.env.FRONTEND_URL}/verificar/${signature.verificationCode}`,
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { signDocument, listSignatures, getSignature };
