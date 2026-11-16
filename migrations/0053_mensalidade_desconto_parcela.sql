-- Desconto numa parcela aprovado pela equipe (pedido do cliente ao bot,
-- ctx.requestApproval): o valor cai, o desconto fica registrado e o pedido
-- que o concedeu impede aplicar duas vezes (gancho repetido).
ALTER TABLE mensalidade_installments ADD COLUMN discount_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mensalidade_installments ADD COLUMN discount_ref TEXT;
