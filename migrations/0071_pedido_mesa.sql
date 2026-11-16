-- Pedido: pedido lançado numa conta de mesa (módulo Mesas). O pedido segue o
-- quadro da cozinha como os demais; o pagamento é o da conta da mesa
-- (payment_status 'tab' até a conta fechar).
ALTER TABLE pedido_orders ADD COLUMN tab_id TEXT;
-- Nome da mesa para o quadro e a comanda ("Mesa 5").
ALTER TABLE pedido_orders ADD COLUMN table_label TEXT;
CREATE INDEX IF NOT EXISTS pedido_orders_tab ON pedido_orders(profile_id, tab_id, payment_status);
