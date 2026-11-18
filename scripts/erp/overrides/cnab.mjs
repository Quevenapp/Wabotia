// Decisões do conversor do domínio cnab (docs/ERP-PORTE.md). Só a sessão dona
// do domínio edita; o gerador junta todos em scripts/erp/overrides.mjs.
// Coluna: { codec, scale, precision, status: "evidência" | "assumido", evidence }.
export const columns = {};

/** Tabelas que não vêm para o objeto, com o motivo. */
export const discardTables = {};

/**
 * Pendências do esquema gerado (CHECK sem tradução, gatilho em PL/pgSQL) que o
 * domínio cumpre em TS. Cada item diz onde (where) e qual teste prova (test,
 * caminho do arquivo; o teste precisa exercitar a recusa nos dois motores).
 * tests/erp/schema-parity.test.mjs só conta o que ninguém cobre, recusa item
 * que não está pendente e item sem arquivo de teste; ao cobrir, baixe os tetos
 * de lá. Chaves: checks "schema.tabela.restrição"; triggers "schema__tabela.gatilho".
 */
export const covered = {
  "checks": {},
  "triggers": {}
};

/**
 * Gatilhos de imutabilidade em PL/pgSQL que viram gatilhos do SQLite (escrito
 * pela N a pedido da G; scripts/erp/overrides.mjs, `sqlTriggers`). O motor não
 * muda o campo guardado nem apaga essas linhas; o gatilho segura a regra no
 * banco, como no Postgres. Teste: tests/erp/cnab-sql-triggers.test.mjs.
 */
const PURPOSE = {
  when: "NEW.purpose IS NOT OLD.purpose",
  code: "40001",
  message: "erp_cnab_purpose_immutable",
  reason: "erp_cnab.purpose_immutable: NEW.purpose is distinct from OLD.purpose → 40001",
};
const EVIDENCE = {
  when: "OLD.purpose = 'operational'",
  code: "42501",
  message: "erp_cnab_operational_evidence_immutable",
  reason: "erp_cnab.operational_evidence_immutable: TG_TABLE_NAME in ('return_file','return_event') and OLD.purpose='operational' → 42501",
};
export const sqlTriggers = {
  "erp_cnab__remittance.cnab_remittance_purpose_immutable": PURPOSE,
  "erp_cnab__return_file.cnab_return_purpose_immutable": PURPOSE,
  "erp_cnab__return_event.cnab_event_purpose_immutable": PURPOSE,
  "erp_cnab__return_file.operational_return_file_immutable": EVIDENCE,
  "erp_cnab__return_event.operational_return_event_immutable": EVIDENCE,
  "erp_cnab__return_occurrence.operational_occurrence_immutable": {
    when: `EXISTS (SELECT 1 FROM "erp_cnab__return_file" WHERE "id" = OLD.file_id AND "purpose" = 'operational')`,
    code: "42501",
    message: "erp_cnab_operational_evidence_immutable",
    reason: "erp_cnab.operational_occurrence_immutable: exists(return_file where id=OLD.file_id and purpose='operational') → 42501",
  },
};
