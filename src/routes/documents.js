// routes/documents.js
const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { uploadPdf }   = require('../middleware/upload');
const { uploadDocument, listDocuments, getDocument } = require('../controllers/documentController');

const router = Router();

// All document routes require authentication
router.use(authenticate);

router.post('/',    (req, res, next) => {
  uploadPdf(req, res, (err) => {
    if (err) return next(err);
    uploadDocument(req, res, next);
  });
});

router.get('/',     listDocuments);
router.get('/:id',  getDocument);

module.exports = router;
