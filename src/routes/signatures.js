// routes/signatures.js
const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { signDocument, listSignatures, getSignature } = require('../controllers/signatureController');

const router = Router();

router.use(authenticate);

router.post('/',     signDocument);
router.get('/',      listSignatures);
router.get('/:id',   getSignature);

module.exports = router;
