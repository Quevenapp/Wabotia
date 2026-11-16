-- Entrega: código de confirmação (4 dígitos) que o cliente recebe com o aviso
-- de saída e informa ao entregador. Só com `confirm_code.enabled` na chave
-- `entrega` (desligado por padrão). Apagado com a posição (retention_hours).
ALTER TABLE entrega_deliveries ADD COLUMN confirm_code TEXT;
ALTER TABLE entrega_deliveries ADD COLUMN confirm_attempts INTEGER NOT NULL DEFAULT 0;
