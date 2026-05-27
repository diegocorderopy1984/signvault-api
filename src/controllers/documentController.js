const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const prisma = require('../prisma/client');
const { sha256File } = require('../utils/crypto');
const { extractIp } = require('../utils/geolocation');
const logger = require('../utils/logger');

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

    const tempDir = path.join(process.cwd(), 'uploads', 'temp', document.id);
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    let pages = [];

    try {
      const { fromPath } = require('pdf2pic');
      const converter = fromPath(document.storagePath, {
        density: 150,
        saveFilename: 'page',
        savePath: tempDir,
        format: 'png',
        width: 800,
        height: 1200,
      });

      const results = await converter.bulk(-1, { responseType: 'base64' });

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.base64) {
          pages.push({
            page: i + 1,
            base64: `data:image/png;base64,${result.base64}`,
            width: 800,
            height: 1131,
          });
        }
      }
    } catch (err) {
      logger.warn('pdf2pic failed, using placeholder', { error: err.message });
      pages = [{
        page: 1,
        base64: null,
        width: 595,
        height: 842,
        placeholder: true,
      }];
    }

    try {
      if (fs.existsSync(tempDir)) {
        const files = fs.readdirSync(tempDir);
        files.forEach(f => {
          try { fs.unlinkSync(path.join(tempDir, f)); } catch {}
        });
        fs.rmdirSync(tempDir);
      }
    } catch {}

    return res.json({ pages, totalPages: pages.length });
  } catch (err) {
    next(err);
  }
}

async function listDocuments(req, res, next) {
  try {
    const page  = parseInt(req.query.page  || '1', 10);
    const limit = parseInt(req.query.limit || '20', 10);
    const skip  = (page - 1) * limit;
    const [documents, total] = await Promise.all([
      prisma.document.findMany({
        where: { signatures: { some: { userId: req.user.id } } },
        include: {
          signatures: {
            where: { userId: req.user.id },
            select: { id: true, verificationCode: true, signedAt: true, status: true },
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

async function getDocument(req, res, next) {
  try {
    const document = await prisma.document.findUnique({
      where: { id: req.params.id },
      include: {
        signatures: {
          where: { userId: req.user.id },
          select: { id: true, verificationCode: true, signedAt: true, status: true, sha256Signed: true },
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