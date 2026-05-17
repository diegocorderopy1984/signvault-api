// routes/auth.js
const { Router } = require('express');
const { register, login, me } = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');
const router = Router();

router.post('/register', register);
router.post('/login',    login);
router.get('/me',        authenticate, me);

module.exports = router;
