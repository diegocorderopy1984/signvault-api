/**
 * Document Controller
 * POST /api/documents/upload  - Upload PDF, compute hash, store metadata
 * GET  /api/documents         - List user's documents
 * GET  /api/documents/:id     - Get single document
 * GET  /api/documents/:id/pages - Get PDF pages as base64 images
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const sharp = require('sharp');
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
    const sha256Original = await sha256File(filePath);

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
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    next(err);
  }
}

// ─── Get PDF Pages as Images ──────────────────────────────────────────────────
async function getDocumentPages(req, res, next) {
  try {
    const document = await prisma.document.findUnique({
      where: { id: req.params.id },
    });

    if (!document) {
      return res.status(404).json({ error: 'Documento no encontrado.' });
    }

    if (!fs.existsSync(document.storagePath)) {
      return res.status(404).json({ error: 'Archivo PDF no encontrado.' });
    }

    // Create temp directory for page images
    const tempDir = path.join(process.cwd(), 'uploads', 'temp', document.id);
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // Convert PDF pages to PNG using pdftoppm (poppler)
    // Falls back to a placeholder if poppler not available
    let pages = [];

    try {
      // Try pdftoppm first (Linux/Railway has this)
      const outputPrefix = path.join(tempDir, 'page');
      execSync(`pdftoppm -png -r 150 "${document.storagePath}" "${outputPrefix}"`, {
        timeout: 30000,
      });

      // Read generated images
      const files = fs.readdirSync(tempDir)
        .filter(f => f.endsWith('.png'))
        .sort();

      for (let i = 0; i < files.length; i++) {
        const filePath = path.join(tempDir, files[i]);
        const imgBuffer = fs.readFileSync(filePath);

        // Resize to max width 800px for mobile
        const resized = await sharp(imgBuffer)
          .resize({ width: 800, withoutEnlargement: true })
          .png({ quality: 85 })
          .toBuffer();

        const base64 = resized.toString('base64');
        const dimensions = await sharp(resized).metadata();

        pages.push({
          page: i + 1,
          base64: `data:image/png;base64,${base64}`,
          width: dimensions.width,
          height: dimensions.height,
        });

        // Clean up temp file
        fs.unlinkSync(filePath);
      }
    } catch (err) {
      logger.warn('pdftoppm failed, using placeholder', { error: err.message });

      // Fallback: return placeholder with PDF dimensions
      pages = [{
        page: 1,
        base64: null,
        width: 595,
        height: 842,
        placeholder: true,
      }];
    }

    // Clean up temp dir
    try { fs.rmdirSync(tempDir); } catch {}

    return res.json({ pages, totalPages: pages.length });
  } catch (err) {
    next(err);
  }
}

// ─── List Documents ───────────────────────────────────────────────────────────
async function listDocuments(req, res, next) {
  try {
    const page  = parseInt(req.query.page  || '1', 10);
    const limit = parseInt(req.query.limit || '20', 10);
    const skip  = (page - 1) * limit;

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

module.exports = { uploadDocument, listDocuments, getDocument, getDocumentPages };