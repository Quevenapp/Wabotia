-- Ordem de Serviço, parte 5 (docs/ORDEM-DE-SERVICO.md, "Notas fiscais"):
-- situação conhecida das notas da ordem (nota de serviço NFS-e e nota de
-- peças NF-e), anotada pelo serviço da nota sempre que a tela consulta,
-- emite, retoma ou cancela. A nota é do ERP (cofre da NFapi); esta tabela só
-- deixa a ordem conferir, sem chamar o ERP, o modelo que marca "exigir nota
-- para entregar". Tabela nova.

CREATE TABLE os_fiscal_notes (
  profile_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('nfse', 'nfe')),
  emission_id TEXT,
  status TEXT NOT NULL,
  number TEXT,
  environment TEXT,
  updated INTEGER NOT NULL,
  PRIMARY KEY (profile_id, order_id, kind)
);
