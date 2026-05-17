-- ============================================================
-- SignVault - Database Schema
-- PostgreSQL 14+
-- Run with: psql -U postgres -d signvault -f schema.sql
-- ============================================================

-- Create database (run as superuser if needed)
-- CREATE DATABASE signvault;

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─── Enums ───────────────────────────────────────────────────────────────────

CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');
CREATE TYPE "GeoSource" AS ENUM ('GPS', 'IP', 'NONE');
CREATE TYPE "SignatureStatus" AS ENUM ('VALID', 'REVOKED', 'TAMPERED');
CREATE TYPE "VerificationResult" AS ENUM ('VALID', 'HASH_MISMATCH', 'NOT_FOUND', 'REVOKED');

-- ─── Users ───────────────────────────────────────────────────────────────────

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email         VARCHAR(255) UNIQUE NOT NULL,
  name          VARCHAR(255) NOT NULL,
  password_hash TEXT NOT NULL,
  role          "Role" NOT NULL DEFAULT 'USER',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);

-- ─── Documents ───────────────────────────────────────────────────────────────

CREATE TABLE documents (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  original_name   VARCHAR(500) NOT NULL,
  storage_path    TEXT NOT NULL,
  sha256_original CHAR(64) NOT NULL,    -- SHA-256 hex string
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  mime_type       VARCHAR(100) NOT NULL DEFAULT 'application/pdf',
  size_bytes      INTEGER NOT NULL
);

CREATE INDEX idx_documents_sha256 ON documents(sha256_original);

-- ─── Signatures ──────────────────────────────────────────────────────────────

CREATE TABLE signatures (
  id                        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  verification_code         UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),

  user_id                   UUID NOT NULL REFERENCES users(id),
  document_id               UUID NOT NULL REFERENCES documents(id),

  -- Signed PDF
  signed_pdf_path           TEXT,
  sha256_signed             CHAR(64),                    -- immutable after insert

  -- Signature image (AES-256-CBC encrypted)
  signature_data_encrypted  TEXT,
  signature_iv              VARCHAR(32),                 -- 16 bytes hex

  -- Placement on PDF
  signature_x               DOUBLE PRECISION,
  signature_y               DOUBLE PRECISION,
  signature_page            INTEGER DEFAULT 1,
  signature_width           DOUBLE PRECISION,
  signature_height          DOUBLE PRECISION,

  -- QR code
  qr_code_path              TEXT,

  -- Timestamp (immutable)
  signed_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Geolocation
  latitude                  DOUBLE PRECISION,
  longitude                 DOUBLE PRECISION,
  accuracy_meters           DOUBLE PRECISION,
  address                   TEXT,
  geo_source                "GeoSource" NOT NULL DEFAULT 'NONE',

  -- Network / device
  ip_address                INET,
  user_agent                TEXT,
  device_info               JSONB,

  -- Status
  status                    "SignatureStatus" NOT NULL DEFAULT 'VALID'
);

CREATE INDEX idx_signatures_user       ON signatures(user_id);
CREATE INDEX idx_signatures_document   ON signatures(document_id);
CREATE INDEX idx_signatures_code       ON signatures(verification_code);
CREATE INDEX idx_signatures_signed_at  ON signatures(signed_at DESC);

-- Prevent hash tampering via rule
CREATE RULE no_update_sha256 AS
  ON UPDATE TO signatures
  WHERE OLD.sha256_signed IS NOT NULL AND NEW.sha256_signed <> OLD.sha256_signed
  DO INSTEAD NOTHING;

-- ─── Verifications ───────────────────────────────────────────────────────────

CREATE TABLE verifications (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  signature_id  UUID NOT NULL REFERENCES signatures(id),
  verified_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address    INET,
  user_agent    TEXT,
  result        "VerificationResult" NOT NULL
);

CREATE INDEX idx_verifications_signature ON verifications(signature_id);
CREATE INDEX idx_verifications_at        ON verifications(verified_at DESC);

-- ─── Audit Log (immutable) ───────────────────────────────────────────────────

CREATE TABLE audit_logs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID REFERENCES users(id),
  signature_id  UUID REFERENCES signatures(id),
  action        VARCHAR(100) NOT NULL,
  metadata      JSONB,
  ip_address    INET,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Make audit logs append-only
CREATE RULE no_update_audit AS ON UPDATE TO audit_logs DO INSTEAD NOTHING;
CREATE RULE no_delete_audit AS ON DELETE TO audit_logs DO INSTEAD NOTHING;

CREATE INDEX idx_audit_user      ON audit_logs(user_id);
CREATE INDEX idx_audit_signature ON audit_logs(signature_id);
CREATE INDEX idx_audit_created   ON audit_logs(created_at DESC);

-- ─── Updated_at trigger ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─── Seed: Admin user (password: Admin1234!) ─────────────────────────────────
-- bcrypt hash of 'Admin1234!' with 12 rounds
-- Replace with your own hash in production!
INSERT INTO users (email, name, password_hash, role)
VALUES (
  'admin@signvault.app',
  'Admin SignVault',
  '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TiGiPkTrDjM/jEiYyHXCrOsPjhB2',
  'ADMIN'
) ON CONFLICT DO NOTHING;
