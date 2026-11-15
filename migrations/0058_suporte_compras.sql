-- Suporte pago: uma compra por sessão e pacote, com uma cobrança valendo por
-- vez (trocar a forma cancela a anterior), e pendência para a equipe quando
-- entra dinheiro em dobro ou um estorno (docs/SUPORTE.md, "Compras").
ALTER TABLE suporte_purchases ADD COLUMN charge_seq INTEGER NOT NULL DEFAULT 0;
-- duplicate_payment | refunded: a equipe precisa agir (estornar, conferir).
ALTER TABLE suporte_purchases ADD COLUMN attention TEXT;
CREATE INDEX IF NOT EXISTS suporte_purchases_conversation ON suporte_purchases(conversation_id, status);
