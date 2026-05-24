// routes/documents.js
const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { uploadPdf }   = require('../middleware/upload');
const { uploadDocument, listDocuments, getDocument, getDocumentPages } = require('../controllers/documentController');

const router = Router();

router.use(authenticate);

router.post('/', (req, res, next) => {
  uploadPdf(req, res, (err) => {
    if (err) return next(err);
    uploadDocument(req, res, next);
  });
});

router.get('/',          listDocuments);
router.get('/:id',       getDocument);
router.get('/:id/pages', getDocumentPages);

module.exports = router;