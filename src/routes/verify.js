// routes/verify.js  – PUBLIC, no auth required
const { Router } = require('express');
const { verifySignature } = require('../controllers/verifyController');

const router = Router();

// GET /api/verify/:code
router.get('/:code', verifySignature);

module.exports = router;
