-- Consentimento de notificação por finalidade. As linhas antigas são do
-- fluxo de protocolo; "*" é o REVOGAR do cliente, que vale para todas.
-- Módulos registram as suas (billing, scheduling, order, booking) quando o
-- cliente contrata, agenda, pede ou reserva, com origem e data.
ALTER TABLE consents ADD COLUMN purpose TEXT NOT NULL DEFAULT 'protocol';
ALTER TABLE consents ADD COLUMN source TEXT NOT NULL DEFAULT '';
ALTER TABLE consents ADD COLUMN module_id TEXT;
CREATE INDEX consents_purpose ON consents(conversation_id,purpose,created);
