/**
 * Verify Controller
 * GET /api/verify/:code  – Public endpoint, no auth required
 * Verifies signature integrity by re-computing PDF hash
 */

const fs   = require('fs');
const prisma = require('../prisma/client');
const { sha256File } = require('../utils/crypto');
const { extractIp }  = require('../utils/geolocation');
const logger = require('../utils/logger');

async function verifySignature(req, res, next) {
  try {
    const { code } = req.params;

    if (!code || !/^[0-9a-f-]{36}$/i.test(code)) {
      return res.status(400).json({
        valid: false,
        result: 'NOT_FOUND',
        error: 'Código de verificación inválido.',
      });
    }

    // ── Find signature ────────────────────────────────────────────────────────
    const signature = await prisma.signature.findUnique({
      where: { verificationCode: code },
      include: {
        user:     { select: { id: true, name: true, email: true } },
        document: { select: { id: true, originalName: true, sha256Original: true } },
      },
    });

    const ip        = extractIp(req);
    const userAgent = req.headers['user-agent'] || '';

    if (!signature) {
      // Log the failed verification attempt
      await prisma.verification.create({
        data: {
          signatureId: '00000000-0000-0000-0000-000000000000', // placeholder
          ipAddress: ip,
          userAgent,
          result: 'NOT_FOUND',
        },
      }).catch(() => {}); // ignore if foreign key fails

      return res.status(404).json({
        valid: false,
        result: 'NOT_FOUND',
        message: 'No se encontró ninguna firma con ese código.',
      });
    }

    // ── Check revocation ──────────────────────────────────────────────────────
    if (signature.status === 'REVOKED') {
      await prisma.verification.create({
        data: { signatureId: signature.id, ipAddress: ip, userAgent, result: 'REVOKED' },
      });
      return res.json({
        valid: false,
        result: 'REVOKED',
        message: 'Esta firma ha sido revocada.',
        signature: buildPublicSignature(signature, 'REVOKED'),
      });
    }

    // ── Re-compute hash of signed PDF ─────────────────────────────────────────
    let currentHash = null;
    let hashMatch   = false;

    if (signature.signedPdfPath && fs.existsSync(signature.signedPdfPath)) {
      currentHash = await sha256File(signature.signedPdfPath);
      hashMatch   = currentHash === signature.sha256Signed;
    } else {
      // PDF file not found on disk (could be deleted or moved)
      await prisma.verification.create({
        data: { signatureId: signature.id, ipAddress: ip, userAgent, result: 'HASH_MISMATCH' },
      });
      return res.json({
        valid: false,
        result: 'HASH_MISMATCH',
        message: 'El archivo PDF firmado no está disponible para verificación.',
        signature: buildPublicSignature(signature, 'HASH_MISMATCH'),
      });
    }

    if (!hashMatch) {
      // Mark as tampered
      await prisma.signature.update({
        where: { id: signature.id },
        data:  { status: 'TAMPERED' },
      });
      await prisma.verification.create({
        data: { signatureId: signature.id, ipAddress: ip, userAgent, result: 'HASH_MISMATCH' },
      });
      await prisma.auditLog.create({
        data: {
          signatureId: signature.id,
          action: 'HASH_MISMATCH_DETECTED',
          ipAddress: ip,
          metadata: JSON.stringify({ expectedHash: signature.sha256Signed, actualHash: currentHash }),
        },
      });
      return res.json({
        valid: false,
        result: 'HASH_MISMATCH',
        message: 'El documento ha sido modificado después de ser firmado. La firma NO es válida.',
        signature: buildPublicSignature(signature, 'HASH_MISMATCH'),
        hashDetails: {
          expected: signature.sha256Signed,
          actual:   currentHash,
        },
      });
    }

    // ── Valid ─────────────────────────────────────────────────────────────────
    await prisma.verification.create({
      data: { signatureId: signature.id, ipAddress: ip, userAgent, result: 'VALID' },
    });

    logger.info('Signature verified VALID', { code, signatureId: signature.id, verifierIp: ip });

    return res.json({
      valid: true,
      result: 'VALID',
      message: 'Firma VÁLIDA. El documento no ha sido alterado.',
      signature: buildPublicSignature(signature, 'VALID'),
      hashDetails: {
        sha256: signature.sha256Signed,
        match:  true,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ─── Build safe public response ───────────────────────────────────────────────
function buildPublicSignature(signature, result) {
  const googleMapsUrl = (signature.latitude && signature.longitude)
    ? `https://www.google.com/maps?q=${signature.latitude},${signature.longitude}`
    : null;

  return {
    id:               signature.id,
    verificationCode: signature.verificationCode,
    status:           result === 'VALID' ? 'VALID' : signature.status,
    sha256Signed:     signature.sha256Signed,
    signedAt:         signature.signedAt,

    signer: {
      name:  signature.user.name,
      email: signature.user.email.replace(/(.{2}).*(@.*)/, '$1***$2'), // partial email
    },

    document: {
      originalName:   signature.document.originalName,
      sha256Original: signature.document.sha256Original,
    },

    geolocation: signature.latitude ? {
      latitude:     signature.latitude,
      longitude:    signature.longitude,
      accuracy:     signature.accuracyMeters,
      address:      signature.address,
      source:       signature.geoSource,
      googleMapsUrl,
    } : null,

    network: {
      ipAddress: signature.ipAddress
        ? signature.ipAddress.toString().replace(/(\d+\.\d+)\.\d+\.\d+/, '$1.*.*')
        : null, // partial IP for privacy
    },
  };
}

module.exports = { verifySignature };
