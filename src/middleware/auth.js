/**
 * JWT Authentication Middleware
 */
const jwt = require('jsonwebtoken');
const prisma = require('../prisma/client');

/**
 * Verifies the Bearer JWT token in the Authorization header.
 * Attaches req.user = { id, email, name, role } on success.
 */
async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token de autenticación requerido.' });
    }

    const token = authHeader.slice(7);
    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({
        error: err.name === 'TokenExpiredError'
          ? 'Token expirado. Por favor iniciá sesión de nuevo.'
          : 'Token inválido.',
      });
    }

    // Verify user still exists in DB
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, name: true, role: true },
    });

    if (!user) {
      return res.status(401).json({ error: 'Usuario no encontrado.' });
    }

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Require ADMIN role.
 */
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Acceso denegado. Se requieren permisos de administrador.' });
  }
  next();
}

module.exports = { authenticate, requireAdmin };
