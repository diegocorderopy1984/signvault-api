const logger = require('../utils/logger');

/**
 * Global Express error handler.
 * Handles Prisma errors, validation errors, and generic errors.
 */
function errorHandler(err, req, res, _next) {
  logger.error(err.message, { stack: err.stack, path: req.path });

  // Prisma unique constraint
  if (err.code === 'P2002') {
    return res.status(409).json({
      error: 'Ya existe un registro con esos datos.',
      field: err.meta?.target,
    });
  }

  // Prisma not found
  if (err.code === 'P2025') {
    return res.status(404).json({ error: 'Registro no encontrado.' });
  }

  // Multer file size
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: `El archivo es demasiado grande. Máximo: ${process.env.MAX_FILE_SIZE_MB || 20}MB.`,
    });
  }

  // Multer wrong type
  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({ error: 'Tipo de archivo no permitido.' });
  }

  // Generic
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: status === 500 ? 'Error interno del servidor.' : err.message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
}

module.exports = { errorHandler };
