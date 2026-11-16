-- Pedido: desconto aprovado pela equipe (pedido de aprovação feito pelo
-- cliente ao bot, pedido_pedir_desconto). total_cents já vem com o desconto
-- (subtotal + entrega - desconto); quem aprovou fica no histórico e aqui.
ALTER TABLE pedido_orders ADD COLUMN discount_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pedido_orders ADD COLUMN discount_by TEXT;
