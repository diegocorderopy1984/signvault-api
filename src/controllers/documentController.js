const fs = require('fs');
const path = require('path');
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

    let pages = [];

    try {
      const pdfjsLib = require('pdfjs-dist');
      const { createCanvas } = require('canvas');
      const data = new Uint8Array(fs.readFileSync(document.storagePath));
      const loadingTask = pdfjsLib.getDocument({ data });
      const pdfDocument = await loadingTask.promise;
      const numPages = pdfDocument.numPages;

      for (let i = 1; i <= numPages; i++) {
        const page = await pdfDocument.getPage(i);
        const viewport = page.getViewport({ scale: 1.5 });

        const canvas = createCanvas(viewport.width, viewport.height);
        const context = canvas.getContext('2d');

        await page.render({
          canvasContext: context,
          viewport,
        }).promise;

        const base64 = canvas.toDataURL('image/png');
        pages.push({
          page: i,
          base64,
          width: Math.round(viewport.width),
          height: Math.round(viewport.height),
        });
      }
    } catch (err) {
      logger.warn('pdfjs failed, using placeholder', { error: err.message });
      pages = [{
        page: 1,
        base64: null,
        width: 595,
        height: 842,
        placeholder: true,
      }];
    }

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