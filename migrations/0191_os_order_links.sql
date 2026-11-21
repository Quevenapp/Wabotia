-- Ordem de Serviço, pendências da parte 6: ligações entre ordens e com a
-- ordem de serviço antiga do ERP.
-- * reopened_as / reopened_from: o orçamento aprovado que já tinha gerado
--   documento no ERP foi reaberto. O ERP não volta um documento aprovado para
--   análise; a ordem antiga é cancelada pela compensação da fase 3 (pedido e
--   contas em aberto cancelados no ERP) e o orçamento continua numa ordem nova,
--   ligada à antiga.
-- * erp_document: a ordem nova foi trazida de uma ordem de serviço antiga do
--   ERP (anterior ao módulo). other_id é o documento do ERP; a linha marca a
--   antiga como migrada (uma ordem do ERP vira no máximo uma ordem nova).
-- Só tabela nova.

CREATE TABLE os_order_links (
  profile_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('reopened_as', 'reopened_from', 'erp_document')),
  other_id TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (profile_id, order_id, kind)
);
CREATE UNIQUE INDEX os_order_links_other ON os_order_links(profile_id, kind, other_id);
