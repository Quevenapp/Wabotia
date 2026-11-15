-- Suporte pago: a liberação fica presa ao protocolo e à sessão da conversa em
-- que foi dada, e tem prazo máximo absoluto (docs/SUPORTE.md, "Validade").
-- Liberação "até o protocolo fechar" sem protocolo amarrado (as anteriores a
-- esta migração) não vale mais e é encerrada pela rotina periódica.
ALTER TABLE suporte_releases ADD COLUMN ticket_id TEXT;
ALTER TABLE suporte_releases ADD COLUMN conv_session TEXT;
-- Fim absoluto (ms), qualquer que seja a forma.
ALTER TABLE suporte_releases ADD COLUMN expires_at INTEGER;
CREATE INDEX IF NOT EXISTS suporte_releases_active ON suporte_releases(profile_id, status, created);
CREATE INDEX IF NOT EXISTS suporte_releases_ref ON suporte_releases(profile_id, ref_id, status);
