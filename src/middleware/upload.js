const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const MAX_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '20', 10);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(process.cwd(), 'uploads', 'documents'));
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  },
});

function fileFilter(req, file, cb) {
  if (file.mimetype === 'application/pdf') {
    cb(null, true);
  } else {
    const err = new Error('Solo se permiten archivos PDF.');
    err.code = 'LIMIT_UNEXPECTED_FILE';
    cb(err, false);
  }
}

const uploadPdf = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_MB * 1024 * 1024 },
}).single('pdf');

module.exports = { uploadPdf };
