const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const prisma          = require('../prisma/client');
const { encrypt }     = require('../utils/crypto');
const { reverseGeocode, geolocateByIp, extractIp } = require('../utils/geolocation');
const { embedSignatureInPdf, saveQrCode, savePdf } = require('../services/pdfService');
const logger          = require('../utils/logger');

async function signDocument(req, res, next) {
  try {
    const {
      documentId,
      signatureDataUrl,
      x = 50,
      y = 100,
      page = 1,
      width = 150,
      height = 60,
      placements,
      latitude,
      longitude,
      accuracyMeters,
      address: clientAddress,
      geoSource = 'NONE',
    } = req.body;

    if (!documentId) {
      return res.status(400).json({ error: 'documentId es requerido.' });
    }
    if (!signatureDataUrl) {
      return res.status(400).json({ error: 'La firma (signatureDataUrl) es requerida.' });
    }
    if (!signatureDataUrl.startsWith('data:image/')) {
      return res.status(400).json({ error: 'Formato de firma inválido.' });
    }

    const document = await prisma.document.findUnique({ where: { id: documentId } });
    if (!document) {
      return res.status(404).json({ error: 'Documento no encontrado.' });
    }
    if (!fs.existsSync(document.storagePath)) {
      return res.status(404).json({ error: 'Archivo PDF no encontrado en disco.' });
    }

    let pdfBuffer = fs.readFileSync(document.storagePath);

    // ── Geolocation ───────────────────────────────────────────────────────────
    let finalLat      = latitude      ? parseFloat(latitude)      : null;
    let finalLon      = longitude     ? parseFloat(longitude)     : null;
    let finalAccuracy = accuracyMeters ? parseFloat(accuracyMeters) : null;
    let finalAddress  = clientAddress  || null;
    let finalGeoSource = geoSource;

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

    if (finalLat && finalLon && !finalAddress) {
      finalAddress = await reverseGeocode(finalLat, finalLon);
    }

    const ip        = extractIp(req);
    const userAgent = req.headers['user-agent'] || '';
    const deviceInfo = JSON.stringify({
      platform: req.headers['sec-ch-ua-platform'] || '',
      mobile:   req.headers['sec-ch-ua-mobile']   || '',
      browser:  req.headers['sec-ch-ua']          || '',
    });

    const { encrypted: signatureDataEncrypted, iv: signatureIv } = encrypt(signatureDataUrl);
    const verificationCode = uuidv4();
    const { path: qrPath, buffer: qrBuffer } = await saveQrCode(verificationCode);

    // ── Determine placements ──────────────────────────────────────────────────
    // Support multiple placements or single placement
    let signaturePlacements = [];

    if (placements && Array.isArray(placements) && placements.length > 0) {
      signaturePlacements = placements;
    } else {
      signaturePlacements = [{
        page: parseInt(page, 10),
        x: parseFloat(x),
        y: parseFloat(y),
        width: parseFloat(width),
        height: parseFloat(height),
      }];
    }

    // ── Embed signature on each placement ────────────────────────────────────
    let currentPdfBuffer = pdfBuffer;
    let sha256Signed = null;

    for (let i = 0; i < signaturePlacements.length; i++) {
      const placement = signaturePlacements[i];
      const isLast = i === signaturePlacements.length - 1;

      const result = await embedSignatureInPdf({
        pdfBuffer: currentPdfBuffer,
        signatureDataUrl,
        x:      parseFloat(placement.x),
        y:      parseFloat(placement.y),
        page:   parseInt(placement.page, 10),
        width:  parseFloat(placement.width || width),
        height: parseFloat(placement.height || height),
        signerName: req.user.name,
        signedAt: new Date().toISOString(),
        verificationCode,
        // Only embed QR on last page
        qrBuffer: isLast ? qrBuffer : null,
      });

      currentPdfBuffer = result.pdfBuffer;
      if (isLast) {
        sha256Signed = result.sha256;
      }
    }

    // ── Save signed PDF ───────────────────────────────────────────────────────
    const signedFilename = `signed_${verificationCode}.pdf`;
    const signedPdfPath  = savePdf(currentPdfBuffer, signedFilename);

    // Use first placement for DB storage
    const primaryPlacement = signaturePlacements[0];

    const signature = await prisma.signature.create({
      data: {
        verificationCode,
        userId:     req.user.id,
        documentId: document.id,

        signedPdfPath,
        sha256Signed,

        signatureDataEncrypted,
        signatureIv,

        signatureX:      parseFloat(primaryPlacement.x),
        signatureY:      parseFloat(primaryPlacement.y),
        signaturePage:   parseInt(primaryPlacement.page, 10),
        signatureWidth:  parseFloat(primaryPlacement.width || width),
        signatureHeight: parseFloat(primaryPlacement.height || height),

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
          placements:        signaturePlacements,
        }),
      },
    });

    logger.info('Document signed', {
      signatureId: signature.id,
      userId: req.user.id,
      documentId: document.id,
      verificationCode,
      totalPlacements: signaturePlacements.length,
    });

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
        totalPlacements:  signaturePlacements.length,
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

module.exports = { uploadDocument, listDocuments, getDocument, getDocumentPages };