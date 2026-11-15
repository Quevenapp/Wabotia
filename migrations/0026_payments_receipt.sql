-- Cobrança de módulo que manda o próprio comprovante (ctx.charge com
-- receipt: false): o núcleo não envia o "Pagamento recebido".
ALTER TABLE payments ADD COLUMN receipt INTEGER NOT NULL DEFAULT 1;
