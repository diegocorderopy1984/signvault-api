// routes/users.js
const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const prisma = require('../prisma/client');

const router = Router();
router.use(authenticate);

// GET /api/users/stats – dashboard stats
router.get('/stats', async (req, res, next) => {
  try {
    const [totalSignatures, validSignatures, recentSignatures] = await Promise.all([
      prisma.signature.count({ where: { userId: req.user.id } }),
      prisma.signature.count({ where: { userId: req.user.id, status: 'VALID' } }),
      prisma.signature.findMany({
        where: { userId: req.user.id },
        include: { document: { select: { originalName: true } } },
        orderBy: { signedAt: 'desc' },
        take: 5,
      }),
    ]);

    const safe = recentSignatures.map(({ signatureDataEncrypted, signatureIv, ...s }) => ({
      ...s,
      verifyUrl: `${process.env.FRONTEND_URL}/verificar/${s.verificationCode}`,
      downloadUrl: `${process.env.PUBLIC_URL}/uploads/signed/signed_${s.verificationCode}.pdf`,
    }));

    res.json({ totalSignatures, validSignatures, recentSignatures: safe });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
