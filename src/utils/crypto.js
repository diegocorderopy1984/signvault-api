/**
 * SignVault Crypto Utilities
 * - AES-256-CBC for encrypting signature images
 * - SHA-256 for document hashing
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';
const KEY_HEX   = process.env.ENCRYPTION_KEY;

if (!KEY_HEX || KEY_HEX.length !== 64) {
  console.error('⚠️  ENCRYPTION_KEY must be a 64-char hex string (32 bytes). Set it in .env');
}

const getKey = () => Buffer.from(KEY_HEX, 'hex');

// ─── AES-256-CBC Encrypt ──────────────────────────────────────────────────────
/**
 * Encrypts a string (e.g. base64 signature image) with AES-256-CBC.
 * @param {string} plaintext
 * @returns {{ encrypted: string, iv: string }} base64 ciphertext + hex IV
 */
function encrypt(plaintext) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return {
    encrypted: encrypted.toString('base64'),
    iv: iv.toString('hex'),
  };
}

// ─── AES-256-CBC Decrypt ──────────────────────────────────────────────────────
/**
 * Decrypts AES-256-CBC ciphertext.
 * @param {string} encryptedBase64
 * @param {string} ivHex
 * @returns {string} plaintext
 */
function decrypt(encryptedBase64, ivHex) {
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedBase64, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

// ─── SHA-256 Hash ─────────────────────────────────────────────────────────────
/**
 * Computes SHA-256 hash of a Buffer.
 * @param {Buffer} buffer
 * @returns {string} hex string
 */
function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Computes SHA-256 hash of a file at the given path.
 * @param {string} filePath
 * @returns {Promise<string>} hex string
 */
async function sha256File(filePath) {
  const fs = require('fs');
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

module.exports = { encrypt, decrypt, sha256Buffer, sha256File };
