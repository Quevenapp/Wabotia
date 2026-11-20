-- Ordem de Serviço, parte 3 (docs/ORDEM-DE-SERVICO.md, "Orçamento"): o
-- comercial da ordem. Só colunas novas; nada é apagado nem reescrito.

-- Desconto no total do orçamento, em centavos. O desconto de cada linha fica
-- no próprio item (quote_items[].discount_cents). quote_total_cents passa a
-- ser o total líquido: soma das linhas menos os descontos.
ALTER TABLE os_orders ADD COLUMN quote_discount_cents INTEGER NOT NULL DEFAULT 0;

-- Condições combinadas no orçamento (JSON): pagador, forma de pagamento e
-- parcelas (quantidade, primeira data, intervalo). Sem Financeiro ligado,
-- guarda só pagador e forma; o total combinado é quote_total_cents.
ALTER TABLE os_orders ADD COLUMN quote_terms_json TEXT;

-- Resposta registrada à mão (JSON): nome de quem aprovou ou recusou, quando,
-- por onde (telefone, balcão...) e o motivo da recusa. decided_* continuam
-- sendo o registro do sistema (quem lançou e o instante do lançamento).
ALTER TABLE os_orders ADD COLUMN decision_detail_json TEXT;
