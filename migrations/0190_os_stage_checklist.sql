-- Ordem de Serviço, pendências da parte 6 (docs/ORDEM-DE-SERVICO.md,
-- "Checklist por etapa"): o modelo define, por etapa, os itens do checklist
-- (texto, obrigatório ou não, com foto obrigatória ou não). O que a equipe
-- marcou fica na própria ordem, por etapa e por item, com quem e quando, e a
-- foto é um documento da ordem. Cada marcação também entra no histórico.
-- Só coluna nova.

ALTER TABLE os_orders ADD COLUMN checklist_json TEXT;
