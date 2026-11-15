-- Pagamentos aprovados em duplicidade da mesma cobrança (revisão M8): o link
-- pago duas vezes chega com outro id do provedor. A lista guarda
-- [{id, amount_cents, at}] para a equipe estornar; cada um publica
-- payment.duplicate uma vez.
ALTER TABLE payments ADD COLUMN duplicate_payments TEXT;
