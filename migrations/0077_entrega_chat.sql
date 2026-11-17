-- Entrega: entregador por QR (sem login) e conversa da entrega.
-- courier_kind: person (pessoa da equipe com o papel entrega:courier) ou qr
-- (credencial trocada pelo QR da entrega, courier_id = "cred:<id>").
ALTER TABLE entrega_deliveries ADD COLUMN courier_kind TEXT;

-- Conversa da entrega: canal store (entregador e loja, interna) e customer
-- (entregador e cliente; sai pelo WhatsApp da loja). O entregador nunca vê o
-- telefone do cliente: só o texto. Apagada com a posição, na retenção.
CREATE TABLE entrega_messages(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  profile_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  sender TEXT NOT NULL,
  author TEXT NOT NULL,
  author_name TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX entrega_messages_delivery ON entrega_messages(delivery_id,seq);
