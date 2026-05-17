/**
 * Document Controller
 * POST /api/documents/upload  - Upload PDF, compute hash, store metadata
 * GET  /api/documents         - List user's documents
 * GET  /api/documents/:id     - Get single document
 */

const fs = require('fs');
const prisma = require('../prisma/client');
const { sha256File } = require('../utils/crypto');
const { extractIp } = require('../utils/geolocation');
const logger = require('../utils/logger');

// ─── Upload PDF ───────────────────────────────────────────────────────────────
async function uploadDocument(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Se requiere un archivo PDF.' });
    }

    const { path: filePath, originalname, size } = req.file;

    // Compute SHA-256 of the original PDF
    const sha256Original = await sha256File(filePath);

    // Persist to DB
    const document = await prisma.document.create({
      data: {
        originalName: originalname,
        storagePath: filePath,
        sha256Original,
        sizeBytes: size,
      },
    });

    await prisma.auditLog.create({
      data: {
        userId: req.user.id,
        action: 'DOCUMENT_UPLOADED',
        ipAddress: extractIp(req),
        metadata: JSON.stringify({
          documentId: document.id,
          originalName: originalname,
          sha256Original,
          sizeBytes: size,
        }),
      },
    });

    logger.info('Document uploaded', { documentId: document.id, userId: req.user.id });

    return res.status(201).json({
      document: {
        id: document.id,
        originalName: document.originalName,
        sha256Original: document.sha256Original,
        sizeBytes: document.sizeBytes,
        uploadedAt: document.uploadedAt,
      },
    });
  } catch (err) {
    // Clean up uploaded file on error
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    next(err);
  }
}

// ─── List Documents ───────────────────────────────────────────────────────────
async function listDocuments(req, res, next) {
  try {
    const page  = parseInt(req.query.page  || '1', 10);
    const limit = parseInt(req.query.limit || '20', 10);
    const skip  = (page - 1) * limit;

    // Only return documents that have at least one signature by this user
    const [documents, total] = await Promise.all([
      prisma.document.findMany({
        where: {
          signatures: { some: { userId: req.user.id } },
        },
        include: {
          signatures: {
            where: { userId: req.user.id },
            select: {
              id: true, verificationCode: true, signedAt: true, status: true,
            },
            orderBy: { signedAt: 'desc' },
          },
        },
        orderBy: { uploadedAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.document.count({
        where: { signatures: { some: { userId: req.user.id } } },
      }),
    ]);

    return res.json({ documents, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    next(err);
  }
}

// ─── Get Single Document ──────────────────────────────────────────────────────
async function getDocument(req, res, next) {
  try {
    const document = await prisma.document.findUnique({
      where: { id: req.params.id },
      include: {
        signatures: {
          where: { userId: req.user.id },
          select: {
            id: true, verificationCode: true, signedAt: true,
            status: true, sha256Signed: true,
          },
        },
      },
    });

    if (!document) {
      return res.status(404).json({ error: 'Documento no encontrado.' });
    }

    return res.json({ document });
  } catch (err) {
    next(err);
  }
}

module.exports = { uploadDocument, listDocuments, getDocument };
