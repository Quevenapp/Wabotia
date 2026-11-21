// Tabelas só do motor: dado do Wabotia que o Fagoo não tem (ex.: a
// classificação da reforma tributária). O esquema gerado do oráculo não as
// conhece; elas entram aqui, em DDL do SQLite escrito à mão, e:
// - vão no fim do ERP_DDL e mudam o ERP_DDL_HASH (schema/ddl.ts);
// - são criadas nos objetos já migrados pelo passo da versão em que nasceram
//   (`since`, schema/migrate.ts: createEngineTables no STEPS);
// - entram no backup (engine/dump.ts);
// - ficam fora do diferencial: o oráculo não as tem, o harness não as espelha
//   nem compara (tests/erp/harness usa ERP_TABLES, o gerado). O RPC que só o
//   motor tem é testado no SQLite, com as próprias asserções.
// Cada tabela é declarada também em structural.ts (o motivo e a decisão).
// Regras do DDL: nomes "<schema>__<tabela>" como no gerado; uuid e data em
// TEXT, decimal escalado em INTEGER, json em TEXT com json_valid, array como
// json; STRICT; CHECK nomeados "<schema>__<tabela>_<coluna>_check".

export interface EngineTable {
  /** Nome no SQLite ("<schema>__<tabela>"). */
  table: string;
  /** CREATE TABLE e índices (sem IF NOT EXISTS: o passo cria uma vez). */
  ddl: readonly string[];
  /** ERP_DDL_VERSION em que a tabela nasce (o passo since-1 → since a cria). */
  since: number;
  /** Sessão dona. */
  owner: string;
  /** Id da entrada em structural.ts. */
  structural: string;
}

const DIGITS = (n: number) => "[0-9]".repeat(n);
const ARRAY = (c: string) => `"${c}" TEXT NOT NULL DEFAULT '[]' CHECK (json_valid("${c}") AND json_type("${c}")='array')`;
// Expressões escritas por inteiro no DDL (o texto entra no ERP_DDL_HASH).
const HEX64 = (c: string) => `(length(${c}) = 64 AND ${c} NOT GLOB '*[^0-9a-f]*')`;
/** Chave de acesso: 44 posições, com letra no CNPJ alfanumérico (o padrão exato fica no código de entrada). */
const KEY44 = (c: string) => `(length(${c}) = 44 AND ${c} NOT GLOB '*[^0-9A-Z]*')`;
const JSON_OF = (c: string, type: "object" | "array") => `(json_valid(${c}) AND json_type(${c}) = '${type}')`;
const T_NATURE = "erp_fiscal_reform__nature_class";
const T_PRODUCT = "erp_fiscal_reform__product_class";
const T_RECEIVED = "erp_fiscal_vault__received";
const T_CHANGE = "erp_fiscal_vault__received_change";
const T_CURSOR = "erp_fiscal_vault__cursor";
const T_EMISSION = "erp_fiscal_vault__emission";
const T_EVENT = "erp_fiscal_vault__event";
const C_SETTINGS = "erp_fiscal_vault__commercial_settings";
const C_EMISSION = "erp_fiscal_vault__order_emission";
const C_REVISION = "erp_fiscal_vault__order_revision";
const C_COMMAND = "erp_fiscal_vault__order_command";
const C_CANCEL = "erp_fiscal_vault__order_cancel";
const C_EFFECT = "erp_fiscal_vault__order_effect";
const C_AUDIT = "erp_fiscal_vault__order_audit";
const commercial = (table: string, ddl: readonly string[]): EngineTable => ({ table, ddl, since: 10, owner: "com1-base", structural: "comercial-nfe" });
const immutable = (table: string) => [
  `CREATE TRIGGER "${table}_immutable_update" BEFORE UPDATE ON "${table}" BEGIN SELECT RAISE(ABORT, '40001:com1_history_immutable'); END`,
  `CREATE TRIGGER "${table}_immutable_delete" BEFORE DELETE ON "${table}" BEGIN SELECT RAISE(ABORT, '40001:com1_history_immutable'); END`,
];

// Coleta somente leitura: metadados em SQLite; credenciais exclusivamente no cofre.
const bling = (table: string, ddl: readonly string[]): EngineTable => ({ table, ddl, since: 11, owner: "org-base", structural: "receber-bling" });
const BLING_COUNT = (column: string, minimum = 0) => `(${column} BETWEEN ${minimum} AND 9007199254740991)`;
const BLING_ID = (column: string) => `(length(${column}) BETWEEN 1 AND 200 AND ${column} = trim(${column}))`;
const BLING_JSON = (column: string, type: "object" | "array", bytes = 65536) => `(${JSON_OF(column, type)} AND length(CAST(${column} AS BLOB)) <= ${bytes})`;
const BLING_HASH = (column: string) => `(length(${column}) = 64 AND ${column} NOT GLOB '*[^0-9a-f]*')`;
const blingImmutable = (table: string) => [
  `CREATE TRIGGER "${table}_immutable_update" BEFORE UPDATE ON "${table}" BEGIN SELECT RAISE(ABORT, 'BLING_COMMAND_CONFLICT'); END`,
  `CREATE TRIGGER "${table}_immutable_delete" BEFORE DELETE ON "${table}" BEGIN SELECT RAISE(ABORT, 'BLING_ARCHIVE_REFERENCED'); END`,
];

// Adoção revisada dos cadastros do acervo: só vínculo e revisão; o cadastro
// continua nas tabelas do domínio, escrito pelas mesmas RPCs das telas.
const adoption = (table: string, ddl: readonly string[]): EngineTable => ({ table, ddl, since: 12, owner: "bling-adota", structural: "adotar-bling" });
const ADOPTION_ENTITIES = "'contacts','sellers','product_categories','products','warehouses','payment_methods','financial_categories','ledger_accounts'";
// Fatia B2: documentos e contas em aberto viram documentos e títulos do ERP; os
// encerrados ficam no espelho histórico (só consulta). Tabelas novas porque o
// CHECK de entidade da versão 12 não se reescreve (migração só aditiva).
const adoptionB2 = (table: string, ddl: readonly string[]): EngineTable => ({ table, ddl, since: 13, owner: "bling-adota2", structural: "adotar-bling-b2" });
const ADOPTION_B2_ENTITIES = "'sales_proposals','sales_orders','purchase_orders','receivables','payables'";
// Fatia C (corte): a data a partir da qual o ERP passa a valer e o registro de
// cada etapa (parciais, saldos, estoque de abertura, pacote do contador,
// justificativas e conflitos), para refazer sem duplicar. Só tabelas novas.
const cutover = (table: string, ddl: readonly string[]): EngineTable => ({ table, ddl, since: 15, owner: "bling-corte", structural: "corte-bling" });
const CUTOVER_TABLES: readonly EngineTable[] = [
  cutover("wb_bling_cutover", [
    `CREATE TABLE "wb_bling_cutover" (
  id INTEGER NOT NULL PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  state TEXT NOT NULL CHECK (state IN ('confirmed','concluded')),
  cutover_on TEXT NOT NULL CHECK (length(cutover_on) = 10 AND cutover_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  confirmed_by TEXT NOT NULL CHECK (${BLING_ID("confirmed_by")}),
  confirmed_at INTEGER NOT NULL,
  concluded_by TEXT CHECK (concluded_by IS NULL OR ${BLING_ID("concluded_by")}),
  concluded_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (${BLING_COUNT("revision", 1)}),
  snapshot TEXT NOT NULL DEFAULT '{}' CHECK (${BLING_JSON("snapshot", "object", 262144)}),
  updated_at INTEGER NOT NULL,
  CONSTRAINT wb_bling_cutover_concluded_check CHECK ((state = 'concluded') = (concluded_at IS NOT NULL AND concluded_by IS NOT NULL))
) STRICT`,
  ]),
  cutover("wb_bling_cutover_item", [
    `CREATE TABLE "wb_bling_cutover_item" (
  kind TEXT NOT NULL CHECK (kind IN ('partial','balance','stock','package','package_part','justification','conflict')),
  key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 200 AND key = trim(key)),
  state TEXT NOT NULL CHECK (length(state) BETWEEN 1 AND 30 AND state NOT GLOB '*[^a-z_]*'),
  data TEXT NOT NULL DEFAULT '{}' CHECK (${BLING_JSON("data", "object", 65536)}),
  record_id TEXT CHECK (record_id IS NULL OR ${BLING_ID("record_id")}),
  actor_id TEXT NOT NULL CHECK (${BLING_ID("actor_id")}),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, key)
) STRICT`,
    `CREATE INDEX wb_bling_cutover_item_state ON wb_bling_cutover_item(kind, state, key)`,
  ]),
];

// Mão dupla com o Bling (versão 19): interruptores por entidade e sentido
// (todos desligados), a linha de base de cada registro sincronizado, a fila de
// saída retomável no alarme, as pendências e conflitos e o registro de quem
// ligou ou desligou. Só tabelas novas; nota fiscal e ordem de serviço ficam de
// fora pelo CHECK de entidade.
const twoWay = (table: string, ddl: readonly string[]): EngineTable => ({ table, ddl, since: 19, owner: "bling-volta", structural: "mao-dupla-bling" });
const TWO_WAY_ENTITIES = "'contacts','products','sales_proposals','sales_orders','purchase_orders','receivables','payables','stock_balances'";
const TWO_WAY_TABLES: readonly EngineTable[] = [
  twoWay("wb_bling_twoway", [
    `CREATE TABLE "wb_bling_twoway" (
  id INTEGER NOT NULL PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  pace_minutes INTEGER NOT NULL DEFAULT 15 CHECK (pace_minutes BETWEEN 5 AND 1440),
  scan TEXT NOT NULL DEFAULT '{}' CHECK (${BLING_JSON("scan", "object", 16384)}),
  last_in TEXT NOT NULL DEFAULT '{}' CHECK (${BLING_JSON("last_in", "object", 8192)}),
  last_out TEXT NOT NULL DEFAULT '{}' CHECK (${BLING_JSON("last_out", "object", 8192)}),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (${BLING_COUNT("revision", 1)}),
  updated_by TEXT CHECK (updated_by IS NULL OR ${BLING_ID("updated_by")}),
  updated_at INTEGER NOT NULL
) STRICT`,
  ]),
  twoWay("wb_bling_twoway_setting", [
    `CREATE TABLE "wb_bling_twoway_setting" (
  entity TEXT NOT NULL CHECK (entity IN (${TWO_WAY_ENTITIES})),
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  enabled_since INTEGER,
  watermark TEXT NOT NULL DEFAULT '{}' CHECK (${BLING_JSON("watermark", "object", 4096)}),
  updated_by TEXT NOT NULL CHECK (${BLING_ID("updated_by")}),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (entity, direction),
  CONSTRAINT wb_bling_twoway_setting_since_check CHECK (enabled = 0 OR enabled_since IS NOT NULL)
) STRICT`,
  ]),
  twoWay("wb_bling_twoway_state", [
    `CREATE TABLE "wb_bling_twoway_state" (
  entity TEXT NOT NULL CHECK (entity IN (${TWO_WAY_ENTITIES})),
  record_id TEXT NOT NULL CHECK (${BLING_ID("record_id")}),
  source_id TEXT CHECK (source_id IS NULL OR ${BLING_ID("source_id")}),
  erp_hash TEXT CHECK (erp_hash IS NULL OR ${BLING_HASH("erp_hash")}),
  bling_version INTEGER NOT NULL DEFAULT 0 CHECK (${BLING_COUNT("bling_version")}),
  bling_hash TEXT CHECK (bling_hash IS NULL OR ${BLING_HASH("bling_hash")}),
  echo_after INTEGER,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (entity, record_id)
) STRICT`,
    `CREATE INDEX wb_bling_twoway_state_source ON wb_bling_twoway_state(entity, source_id)`,
  ]),
  twoWay("wb_bling_twoway_outbox", [
    `CREATE TABLE "wb_bling_twoway_outbox" (
  id TEXT NOT NULL PRIMARY KEY CHECK (${BLING_ID("id")}),
  entity TEXT NOT NULL CHECK (entity IN (${TWO_WAY_ENTITIES})),
  record_id TEXT NOT NULL CHECK (${BLING_ID("record_id")}),
  op TEXT NOT NULL CHECK (op IN ('create','update','settle','stock')),
  priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 9),
  state TEXT NOT NULL CHECK (state IN ('pending','sending','uncertain','held','done','failed','superseded')),
  request TEXT NOT NULL CHECK (${BLING_JSON("request", "object", 262144)}),
  verify TEXT NOT NULL DEFAULT '{}' CHECK (${BLING_JSON("verify", "object", 65536)}),
  erp_hash TEXT CHECK (erp_hash IS NULL OR ${BLING_HASH("erp_hash")}),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (${BLING_COUNT("attempts")}),
  checks INTEGER NOT NULL DEFAULT 0 CHECK (${BLING_COUNT("checks")}),
  not_before INTEGER NOT NULL,
  remote_id TEXT CHECK (remote_id IS NULL OR ${BLING_ID("remote_id")}),
  error_code TEXT CHECK (error_code IS NULL OR (length(error_code) BETWEEN 1 AND 60 AND error_code NOT GLOB '*[^a-z_]*')),
  error_text TEXT CHECK (error_text IS NULL OR length(error_text) <= 600),
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  CONSTRAINT wb_bling_twoway_outbox_finished_check CHECK ((state IN ('done','superseded')) = (finished_at IS NOT NULL))
) STRICT`,
    `CREATE INDEX wb_bling_twoway_outbox_due ON wb_bling_twoway_outbox(state, not_before, priority, created_at)`,
    `CREATE INDEX wb_bling_twoway_outbox_record ON wb_bling_twoway_outbox(entity, record_id, state)`,
  ]),
  twoWay("wb_bling_twoway_issue", [
    `CREATE TABLE "wb_bling_twoway_issue" (
  key TEXT NOT NULL PRIMARY KEY CHECK (${BLING_ID("key")}),
  kind TEXT NOT NULL CHECK (kind IN ('conflict','failed','uncertain','blocked')),
  entity TEXT NOT NULL CHECK (entity IN (${TWO_WAY_ENTITIES})),
  record_id TEXT CHECK (record_id IS NULL OR ${BLING_ID("record_id")}),
  source_id TEXT CHECK (source_id IS NULL OR ${BLING_ID("source_id")}),
  outbox_id TEXT CHECK (outbox_id IS NULL OR ${BLING_ID("outbox_id")}),
  state TEXT NOT NULL CHECK (state IN ('open','resolved')),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 600),
  erp TEXT CHECK (erp IS NULL OR ${BLING_JSON("erp", "object", 16384)}),
  bling TEXT CHECK (bling IS NULL OR ${BLING_JSON("bling", "object", 16384)}),
  data TEXT NOT NULL DEFAULT '{}' CHECK (${BLING_JSON("data", "object", 16384)}),
  resolution TEXT CHECK (resolution IS NULL OR length(resolution) BETWEEN 1 AND 40),
  resolved_by TEXT CHECK (resolved_by IS NULL OR ${BLING_ID("resolved_by")}),
  resolved_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CONSTRAINT wb_bling_twoway_issue_resolved_check CHECK ((state = 'resolved') = (resolved_at IS NOT NULL AND resolution IS NOT NULL))
) STRICT`,
    `CREATE INDEX wb_bling_twoway_issue_open ON wb_bling_twoway_issue(state, kind, created_at)`,
  ]),
  twoWay("wb_bling_twoway_audit", [
    `CREATE TABLE "wb_bling_twoway_audit" (
  id TEXT NOT NULL PRIMARY KEY CHECK (${BLING_ID("id")}),
  actor_id TEXT NOT NULL CHECK (${BLING_ID("actor_id")}),
  action TEXT NOT NULL CHECK (action IN ('switch','pace')),
  entity TEXT CHECK (entity IS NULL OR entity IN (${TWO_WAY_ENTITIES})),
  direction TEXT CHECK (direction IS NULL OR direction IN ('inbound','outbound')),
  enabled INTEGER CHECK (enabled IS NULL OR enabled IN (0,1)),
  detail TEXT NOT NULL CHECK (length(detail) BETWEEN 1 AND 600),
  created_at INTEGER NOT NULL
) STRICT`,
    `CREATE INDEX wb_bling_twoway_audit_time ON wb_bling_twoway_audit(created_at, id)`,
    ...blingImmutable("wb_bling_twoway_audit"),
  ]),
];

// Fatia D do Bling (versão 24): o que o coletor passou a ler (listas de preços,
// naturezas, campos customizados e seus valores, contratos, NFS-e, lotes e
// fornecedores de produto) adotado com revisão. Só tabelas novas, com o nome
// das da adoção (os CHECKs de entidade das versões 12, 13 e 19 não se
// reescrevem). A mão dupla das listas e dos campos tem interruptores, registro
// e fila próprios; naturezas, NFS-e e contratos nunca voltam ao Bling.
const adoptionExtra = (table: string, ddl: readonly string[]): EngineTable => ({ table, ddl, since: 24, owner: "bling-d", structural: "adotar-bling-d" });
const EXTRA_ENTITIES = "'price_lists','operation_natures','custom_fields','custom_field_values','contracts','service_invoices','product_lots','product_suppliers'";
const EXTRA_TWO_WAY = "'price_lists','custom_fields_products','custom_fields_contacts'";
const EXTRA_TABLES: readonly EngineTable[] = [
  adoptionExtra("wb_bling_adoption_extra_link", [
    `CREATE TABLE "wb_bling_adoption_extra_link" (
  entity TEXT NOT NULL CHECK (entity IN (${EXTRA_ENTITIES})),
  source_id TEXT NOT NULL CHECK (${BLING_ID("source_id")}),
  record_id TEXT NOT NULL CHECK (${BLING_ID("record_id")}),
  source_version INTEGER NOT NULL CHECK (${BLING_COUNT("source_version", 1)}),
  source_hash TEXT NOT NULL CHECK (${BLING_HASH("source_hash")}),
  mode TEXT NOT NULL CHECK (mode IN ('created','linked','updated','archived')),
  erp_hash TEXT CHECK (erp_hash IS NULL OR ${BLING_HASH("erp_hash")}),
  data TEXT NOT NULL DEFAULT '{}' CHECK (${BLING_JSON("data", "object", 16384)}),
  adopted_by TEXT NOT NULL CHECK (${BLING_ID("adopted_by")}),
  adopted_at INTEGER NOT NULL,
  PRIMARY KEY (entity, source_id)
) STRICT`,
    `CREATE INDEX wb_bling_adoption_extra_link_record ON wb_bling_adoption_extra_link(entity, record_id)`,
  ]),
  adoptionExtra("wb_bling_adoption_extra_review", [
    `CREATE TABLE "wb_bling_adoption_extra_review" (
  entity TEXT NOT NULL CHECK (entity IN (${EXTRA_ENTITIES})),
  source_id TEXT NOT NULL CHECK (${BLING_ID("source_id")}),
  state TEXT NOT NULL CHECK (state IN ('pending','ignored')),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 40),
  detail TEXT CHECK (detail IS NULL OR length(detail) <= 600),
  candidates TEXT NOT NULL DEFAULT '[]' CHECK (${BLING_JSON("candidates", "array", 4096)}),
  source_version INTEGER NOT NULL CHECK (${BLING_COUNT("source_version", 1)}),
  source_hash TEXT NOT NULL CHECK (${BLING_HASH("source_hash")}),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (entity, source_id)
) STRICT`,
    `CREATE INDEX wb_bling_adoption_extra_review_state ON wb_bling_adoption_extra_review(entity, state, source_id)`,
  ]),
  adoptionExtra("wb_bling_adoption_extra_twoway", [
    `CREATE TABLE "wb_bling_adoption_extra_twoway" (
  entity TEXT NOT NULL CHECK (entity IN (${EXTRA_TWO_WAY})),
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  enabled_since INTEGER,
  next_scan_at INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT NOT NULL CHECK (${BLING_ID("updated_by")}),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (entity, direction),
  CONSTRAINT wb_bling_adoption_extra_twoway_since_check CHECK (enabled = 0 OR enabled_since IS NOT NULL)
) STRICT`,
  ]),
  adoptionExtra("wb_bling_adoption_extra_outbox", [
    `CREATE TABLE "wb_bling_adoption_extra_outbox" (
  id TEXT NOT NULL PRIMARY KEY CHECK (${BLING_ID("id")}),
  entity TEXT NOT NULL CHECK (entity IN (${EXTRA_TWO_WAY})),
  record_id TEXT NOT NULL CHECK (${BLING_ID("record_id")}),
  source_id TEXT NOT NULL CHECK (${BLING_ID("source_id")}),
  path TEXT NOT NULL CHECK (length(path) BETWEEN 2 AND 200),
  body TEXT NOT NULL CHECK (${BLING_JSON("body", "object", 262144)}),
  erp_hash TEXT NOT NULL CHECK (${BLING_HASH("erp_hash")}),
  state TEXT NOT NULL CHECK (state IN ('pending','sending','uncertain','done','failed','superseded')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (${BLING_COUNT("attempts")}),
  not_before INTEGER NOT NULL,
  error_text TEXT CHECK (error_text IS NULL OR length(error_text) <= 600),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  CONSTRAINT wb_bling_adoption_extra_outbox_finished_check CHECK ((state IN ('done','superseded')) = (finished_at IS NOT NULL))
) STRICT`,
    `CREATE INDEX wb_bling_adoption_extra_outbox_due ON wb_bling_adoption_extra_outbox(state, not_before, created_at)`,
    `CREATE INDEX wb_bling_adoption_extra_outbox_record ON wb_bling_adoption_extra_outbox(entity, record_id, state)`,
  ]),
  adoptionExtra("wb_bling_adoption_extra_audit", [
    `CREATE TABLE "wb_bling_adoption_extra_audit" (
  id TEXT NOT NULL PRIMARY KEY CHECK (${BLING_ID("id")}),
  actor_id TEXT NOT NULL CHECK (${BLING_ID("actor_id")}),
  entity TEXT NOT NULL CHECK (entity IN (${EXTRA_TWO_WAY})),
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  detail TEXT NOT NULL CHECK (length(detail) BETWEEN 1 AND 600),
  created_at INTEGER NOT NULL
) STRICT`,
    `CREATE INDEX wb_bling_adoption_extra_audit_time ON wb_bling_adoption_extra_audit(created_at, id)`,
    ...blingImmutable("wb_bling_adoption_extra_audit"),
  ]),
];

const BASE_ENGINE_TABLES: readonly EngineTable[] = [
  {
    // Classificação de IBS/CBS por natureza de operação: o padrão (escopo any)
    // e as exceções por NCM, produto ou grupo, como as regras da natureza.
    table: T_NATURE,
    ddl: [
      `CREATE TABLE "${T_NATURE}" (
  "nature_id" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "product_scope" TEXT NOT NULL,
  ${ARRAY("ncms")},
  ${ARRAY("product_ids")},
  ${ARRAY("group_ids")},
  "cst" TEXT NOT NULL,
  "cclasstrib" TEXT NOT NULL,
  "updated_by" TEXT NOT NULL,
  "updated_at" INTEGER NOT NULL,
  PRIMARY KEY ("nature_id", "position"),
  CONSTRAINT "${T_NATURE}_position_check" CHECK (("position" >= 1) AND ("position" <= 50)),
  CONSTRAINT "${T_NATURE}_product_scope_check" CHECK ((product_scope IN ('any', 'ncm', 'products', 'groups'))),
  CONSTRAINT "${T_NATURE}_scope" CHECK ((((product_scope = 'any') AND (json_array_length(ncms) = 0) AND (json_array_length(product_ids) = 0) AND (json_array_length(group_ids) = 0)) OR ((product_scope = 'ncm') AND ((json_array_length(ncms) >= 1) AND (json_array_length(ncms) <= 10)) AND (json_array_length(product_ids) = 0) AND (json_array_length(group_ids) = 0)) OR ((product_scope = 'products') AND ((json_array_length(product_ids) >= 1) AND (json_array_length(product_ids) <= 10)) AND (json_array_length(ncms) = 0) AND (json_array_length(group_ids) = 0)) OR ((product_scope = 'groups') AND ((json_array_length(group_ids) >= 1) AND (json_array_length(group_ids) <= 10)) AND (json_array_length(ncms) = 0) AND (json_array_length(product_ids) = 0)))),
  CONSTRAINT "${T_NATURE}_cst_check" CHECK ((cst GLOB '${DIGITS(3)}')),
  CONSTRAINT "${T_NATURE}_cclasstrib_check" CHECK ((cclasstrib GLOB '${DIGITS(6)}')),
  CONSTRAINT "${T_NATURE}_nature_id_fkey" FOREIGN KEY ("nature_id") REFERENCES "erp_fiscal_invoices__nature" ("id")
) STRICT`,
    ],
    since: 7,
    owner: "G",
    structural: "reforma-classificacao",
  },
  {
    // Classificação de IBS/CBS do produto (e NBS do serviço): vence a da natureza.
    table: T_PRODUCT,
    ddl: [
      `CREATE TABLE "${T_PRODUCT}" (
  "product_id" TEXT NOT NULL PRIMARY KEY,
  "cst" TEXT NOT NULL,
  "cclasstrib" TEXT NOT NULL,
  "nbs" TEXT,
  "version" INTEGER NOT NULL,
  "updated_by" TEXT NOT NULL,
  "updated_at" INTEGER NOT NULL,
  CONSTRAINT "${T_PRODUCT}_cst_check" CHECK ((cst GLOB '${DIGITS(3)}')),
  CONSTRAINT "${T_PRODUCT}_cclasstrib_check" CHECK ((cclasstrib GLOB '${DIGITS(6)}')),
  CONSTRAINT "${T_PRODUCT}_nbs_check" CHECK ((nbs GLOB '${DIGITS(9)}')),
  CONSTRAINT "${T_PRODUCT}_version_check" CHECK ((("version" >= 1) AND ("version" <= 2147483647))),
  CONSTRAINT "${T_PRODUCT}_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "erp_catalog__product" ("record_id")
) STRICT`,
    ],
    since: 7,
    owner: "G",
    structural: "reforma-classificacao",
  },
  {
    // Nota que outra empresa emitiu contra o CNPJ, lida do cofre da NFapi por
    // cursor (GET /v1/nfe-recebidas). A linha é a última versão que o cofre deu.
    table: T_RECEIVED,
    ddl: [
      `CREATE TABLE "${T_RECEIVED}" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "environment" TEXT NOT NULL,
  "cnpj" TEXT NOT NULL,
  "access_key" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "emitter_document" TEXT,
  "emitter_name" TEXT,
  "emitter_ie" TEXT,
  "series" INTEGER,
  "number" INTEGER,
  "issued_at" INTEGER,
  "authorized_at" INTEGER,
  "protocol" TEXT,
  "operation_type" TEXT,
  "total" INTEGER,
  "situation" TEXT,
  "xml_available" INTEGER NOT NULL,
  "manifestation" TEXT,
  "manifestation_sequence" INTEGER,
  "manifestation_at" INTEGER,
  "manifestation_origin" TEXT,
  "auto_ack_refused" TEXT,
  "vault_sequence" INTEGER NOT NULL,
  "vault_received_at" INTEGER NOT NULL,
  "vault_updated_at" INTEGER NOT NULL,
  "xml_sha256" TEXT,
  "invoice_id" TEXT,
  "first_seen_at" INTEGER NOT NULL,
  "synced_at" INTEGER NOT NULL,
  CONSTRAINT "${T_RECEIVED}_id_check" CHECK ((id GLOB 'rcb_?*' AND length(id) <= 64)),
  CONSTRAINT "${T_RECEIVED}_environment_check" CHECK ((environment IN ('producao', 'homologacao'))),
  CONSTRAINT "${T_RECEIVED}_cnpj_check" CHECK ((length(cnpj) = 14 AND cnpj NOT GLOB '*[^0-9A-Z]*')),
  CONSTRAINT "${T_RECEIVED}_access_key_check" CHECK (${KEY44("access_key")}),
  CONSTRAINT "${T_RECEIVED}_role_check" CHECK ((role IN ('destinatario', 'terceiro'))),
  CONSTRAINT "${T_RECEIVED}_emitter_name_check" CHECK ((emitter_name IS NULL OR length(emitter_name) BETWEEN 1 AND 200)),
  CONSTRAINT "${T_RECEIVED}_operation_type_check" CHECK ((operation_type IS NULL OR operation_type IN ('entrada', 'saida'))),
  CONSTRAINT "${T_RECEIVED}_total_check" CHECK ((total IS NULL OR total >= 0)),
  CONSTRAINT "${T_RECEIVED}_situation_check" CHECK ((situation IS NULL OR situation IN ('autorizada', 'cancelada', 'denegada'))),
  CONSTRAINT "${T_RECEIVED}_xml_available_check" CHECK ((xml_available IN (0, 1))),
  CONSTRAINT "${T_RECEIVED}_manifestation_check" CHECK (((manifestation IS NULL) = (manifestation_sequence IS NULL) AND (manifestation IS NULL) = (manifestation_at IS NULL) AND (manifestation_origin IS NULL OR manifestation IS NOT NULL) AND (manifestation IS NULL OR (manifestation IN ('ciencia', 'confirmacao', 'desconhecimento', 'nao_realizada') AND manifestation_sequence BETWEEN 1 AND 20)))),
  CONSTRAINT "${T_RECEIVED}_auto_ack_refused_check" CHECK ((auto_ack_refused IS NULL OR ${JSON_OF("auto_ack_refused", "object")})),
  CONSTRAINT "${T_RECEIVED}_vault_sequence_check" CHECK ((vault_sequence >= 1)),
  CONSTRAINT "${T_RECEIVED}_xml_sha256_check" CHECK ((xml_sha256 IS NULL OR (xml_available = 1 AND ${HEX64("xml_sha256")}))),
  CONSTRAINT "${T_RECEIVED}_invoice_check" CHECK ((invoice_id IS NULL OR (environment = 'producao' AND role = 'destinatario' AND xml_sha256 IS NOT NULL))),
  CONSTRAINT "${T_RECEIVED}_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "erp_fiscal_invoices__invoice" ("id")
) STRICT`,
      `CREATE INDEX "${T_RECEIVED}_key" ON "${T_RECEIVED}" ("access_key")`,
      `CREATE INDEX "${T_RECEIVED}_list" ON "${T_RECEIVED}" ("environment", "role", "issued_at")`,
      `CREATE UNIQUE INDEX "${T_RECEIVED}_invoice" ON "${T_RECEIVED}" ("invoice_id") WHERE invoice_id IS NOT NULL`,
    ],
    since: 9,
    owner: "G",
    structural: "notas-recebidas-cofre",
  },
  {
    // Cada mudança de uma nota recebida (a sequência do cofre), só acréscimo.
    table: T_CHANGE,
    ddl: [
      `CREATE TABLE "${T_CHANGE}" (
  "received_id" TEXT NOT NULL,
  "vault_sequence" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "snapshot" TEXT NOT NULL,
  "recorded_at" INTEGER NOT NULL,
  PRIMARY KEY ("received_id", "vault_sequence"),
  CONSTRAINT "${T_CHANGE}_kind_check" CHECK ((kind IN ('nova', 'xml', 'cancelada', 'manifestada', 'outra'))),
  CONSTRAINT "${T_CHANGE}_vault_sequence_check" CHECK ((vault_sequence >= 1)),
  CONSTRAINT "${T_CHANGE}_snapshot_check" CHECK (${JSON_OF("snapshot", "object")}),
  CONSTRAINT "${T_CHANGE}_received_id_fkey" FOREIGN KEY ("received_id") REFERENCES "${T_RECEIVED}" ("id")
) STRICT`,
      `CREATE TRIGGER "${T_CHANGE}_immutable_update" BEFORE UPDATE ON "${T_CHANGE}" FOR EACH ROW BEGIN SELECT RAISE(ABORT, '40001:erp_fiscal_vault_received_change_immutable'); END`,
      `CREATE TRIGGER "${T_CHANGE}_immutable_delete" BEFORE DELETE ON "${T_CHANGE}" FOR EACH ROW BEGIN SELECT RAISE(ABORT, '40001:erp_fiscal_vault_received_change_immutable'); END`,
    ],
    since: 9,
    owner: "G",
    structural: "notas-recebidas-cofre",
  },
  {
    // O cursor de leitura das notas recebidas (a ultimaSequencia), por conexão
    // com o cofre (erp-emissor:<área>). A sequência é do cofre: se a vault_url
    // muda, o cursor recomeça do 0. A api_key nunca fica aqui (vai para o backup).
    table: T_CURSOR,
    ddl: [
      `CREATE TABLE "${T_CURSOR}" (
  "connection" TEXT NOT NULL PRIMARY KEY,
  "vault_url" TEXT NOT NULL,
  "last_sequence" INTEGER NOT NULL,
  "read_at" INTEGER NOT NULL,
  "error" TEXT,
  "updated_at" INTEGER NOT NULL,
  CONSTRAINT "${T_CURSOR}_connection_check" CHECK ((length(connection) BETWEEN 1 AND 100)),
  CONSTRAINT "${T_CURSOR}_vault_url_check" CHECK ((vault_url GLOB 'http*://?*' AND length(vault_url) <= 500)),
  CONSTRAINT "${T_CURSOR}_last_sequence_check" CHECK ((last_sequence >= 0)),
  CONSTRAINT "${T_CURSOR}_error_check" CHECK ((error IS NULL OR ${JSON_OF("error", "object")}))
) STRICT`,
    ],
    since: 9,
    owner: "G",
    structural: "notas-recebidas-cofre",
  },
  {
    // Emissão de NF-e/NFC-e pelo cofre: o pedido (body, nunca em log nem na
    // atividade), a referência e a situação. A nota de produção autorizada vira
    // nota do ERP pela importação (invoice_id); a de homologação fica só aqui.
    table: T_EMISSION,
    ddl: [
      `CREATE TABLE "${T_EMISSION}" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "draft_id" TEXT NOT NULL,
  "draft_version" INTEGER NOT NULL,
  "invoice_id" TEXT,
  "model" TEXT NOT NULL,
  "environment" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "body_hash" TEXT NOT NULL,
  "provider_id" TEXT,
  "status" TEXT NOT NULL,
  "series" INTEGER,
  "number" INTEGER,
  "access_key" TEXT,
  "protocol" TEXT,
  "issued_at" INTEGER,
  "authorized_at" INTEGER,
  "total" INTEGER,
  "messages" TEXT NOT NULL DEFAULT '[]',
  "xml_sha256" TEXT,
  "command_id" TEXT NOT NULL,
  "requested_by" TEXT NOT NULL,
  "via" TEXT,
  "created_at" INTEGER NOT NULL,
  "updated_at" INTEGER NOT NULL,
  CONSTRAINT "${T_EMISSION}_reference_key" UNIQUE ("reference"),
  CONSTRAINT "${T_EMISSION}_command_id_key" UNIQUE ("command_id"),
  CONSTRAINT "${T_EMISSION}_draft_key" UNIQUE ("draft_id", "draft_version"),
  CONSTRAINT "${T_EMISSION}_draft_version_check" CHECK ((draft_version >= 1)),
  CONSTRAINT "${T_EMISSION}_model_check" CHECK ((model IN ('55', '65'))),
  CONSTRAINT "${T_EMISSION}_environment_check" CHECK ((environment IN ('producao', 'homologacao'))),
  CONSTRAINT "${T_EMISSION}_reference_check" CHECK ((reference GLOB 'wb.?*' AND length(reference) <= 100)),
  CONSTRAINT "${T_EMISSION}_body_check" CHECK (${JSON_OF("body", "object")}),
  CONSTRAINT "${T_EMISSION}_body_hash_check" CHECK (${HEX64("body_hash")}),
  CONSTRAINT "${T_EMISSION}_status_check" CHECK ((status IN ('processando', 'autorizada', 'rejeitada', 'denegada', 'indefinida', 'cancelada'))),
  CONSTRAINT "${T_EMISSION}_access_key_check" CHECK ((access_key IS NULL OR ${KEY44("access_key")})),
  CONSTRAINT "${T_EMISSION}_authorized_check" CHECK ((status NOT IN ('autorizada', 'cancelada') OR (access_key IS NOT NULL AND protocol IS NOT NULL AND number IS NOT NULL))),
  CONSTRAINT "${T_EMISSION}_invoice_check" CHECK ((invoice_id IS NULL OR (environment = 'producao' AND status IN ('autorizada', 'cancelada')))),
  CONSTRAINT "${T_EMISSION}_total_check" CHECK ((total IS NULL OR total >= 0)),
  CONSTRAINT "${T_EMISSION}_messages_check" CHECK (${JSON_OF("messages", "array")}),
  CONSTRAINT "${T_EMISSION}_xml_sha256_check" CHECK ((xml_sha256 IS NULL OR ${HEX64("xml_sha256")})),
  CONSTRAINT "${T_EMISSION}_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "erp_fiscal_drafts__draft" ("id"),
  CONSTRAINT "${T_EMISSION}_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "erp_fiscal_invoices__invoice" ("id")
) STRICT`,
      `CREATE INDEX "${T_EMISSION}_status" ON "${T_EMISSION}" ("status", "updated_at")`,
      `CREATE UNIQUE INDEX "${T_EMISSION}_invoice" ON "${T_EMISSION}" ("invoice_id") WHERE invoice_id IS NOT NULL`,
    ],
    since: 9,
    owner: "G",
    structural: "emissao-cofre",
  },
  {
    // Evento fiscal pedido ao cofre: cancelamento, carta de correção,
    // inutilização e manifestação do destinatário. O alvo depende do tipo.
    table: T_EVENT,
    ddl: [
      `CREATE TABLE "${T_EVENT}" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "kind" TEXT NOT NULL,
  "invoice_id" TEXT,
  "emission_id" TEXT,
  "received_id" TEXT,
  "manifestation" TEXT,
  "model" TEXT,
  "environment" TEXT NOT NULL,
  "series" INTEGER,
  "number_from" INTEGER,
  "number_to" INTEGER,
  "sequence" INTEGER,
  "text" TEXT,
  "reference" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "body_hash" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'pedido',
  "protocol" TEXT,
  "registered_at" INTEGER,
  "repeated" INTEGER NOT NULL DEFAULT 0,
  "messages" TEXT NOT NULL DEFAULT '[]',
  "command_id" TEXT NOT NULL,
  "requested_by" TEXT NOT NULL,
  "via" TEXT,
  "created_at" INTEGER NOT NULL,
  "updated_at" INTEGER NOT NULL,
  CONSTRAINT "${T_EVENT}_reference_key" UNIQUE ("reference"),
  CONSTRAINT "${T_EVENT}_command_id_key" UNIQUE ("command_id"),
  CONSTRAINT "${T_EVENT}_kind_check" CHECK ((kind IN ('cancelamento', 'carta_correcao', 'inutilizacao', 'manifestacao'))),
  CONSTRAINT "${T_EVENT}_target_check" CHECK (((kind = 'manifestacao' AND received_id IS NOT NULL AND invoice_id IS NULL AND emission_id IS NULL) OR (kind IN ('cancelamento', 'carta_correcao') AND received_id IS NULL AND ((invoice_id IS NULL) <> (emission_id IS NULL))) OR (kind = 'inutilizacao' AND received_id IS NULL AND invoice_id IS NULL AND emission_id IS NULL AND model IS NOT NULL AND model IN ('55', '65') AND series IS NOT NULL AND number_from IS NOT NULL AND number_to IS NOT NULL))),
  CONSTRAINT "${T_EVENT}_range_check" CHECK ((((kind = 'inutilizacao') = (number_from IS NOT NULL)) AND ((number_from IS NULL) = (number_to IS NULL)) AND (number_from IS NULL OR (number_from >= 1 AND number_from <= number_to AND number_to <= 999999999)))),
  CONSTRAINT "${T_EVENT}_manifestation_check" CHECK ((((kind = 'manifestacao') = (manifestation IS NOT NULL)) AND (manifestation IS NULL OR manifestation IN ('ciencia', 'confirmacao', 'desconhecimento', 'nao_realizada')))),
  CONSTRAINT "${T_EVENT}_sequence_check" CHECK ((((kind IN ('carta_correcao', 'manifestacao')) = (sequence IS NOT NULL)) AND (sequence IS NULL OR sequence BETWEEN 1 AND 20))),
  CONSTRAINT "${T_EVENT}_text_check" CHECK (((kind IN ('cancelamento', 'inutilizacao') AND text IS NOT NULL AND length(text) BETWEEN 15 AND 255) OR (kind = 'carta_correcao' AND text IS NOT NULL AND length(text) BETWEEN 15 AND 1000) OR (kind = 'manifestacao' AND ((manifestation = 'nao_realizada') = (text IS NOT NULL)) AND (text IS NULL OR length(text) BETWEEN 15 AND 255)))),
  CONSTRAINT "${T_EVENT}_environment_check" CHECK ((environment IN ('producao', 'homologacao'))),
  CONSTRAINT "${T_EVENT}_state_check" CHECK ((state IN ('pedido', 'registrado', 'recusado', 'incerto'))),
  CONSTRAINT "${T_EVENT}_registered_check" CHECK ((state <> 'registrado' OR registered_at IS NOT NULL)),
  CONSTRAINT "${T_EVENT}_repeated_check" CHECK ((repeated IN (0, 1))),
  CONSTRAINT "${T_EVENT}_body_check" CHECK (${JSON_OF("body", "object")}),
  CONSTRAINT "${T_EVENT}_body_hash_check" CHECK (${HEX64("body_hash")}),
  CONSTRAINT "${T_EVENT}_messages_check" CHECK (${JSON_OF("messages", "array")}),
  CONSTRAINT "${T_EVENT}_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "erp_fiscal_invoices__invoice" ("id"),
  CONSTRAINT "${T_EVENT}_emission_id_fkey" FOREIGN KEY ("emission_id") REFERENCES "${T_EMISSION}" ("id"),
  CONSTRAINT "${T_EVENT}_received_id_fkey" FOREIGN KEY ("received_id") REFERENCES "${T_RECEIVED}" ("id")
) STRICT`,
      `CREATE INDEX "${T_EVENT}_invoice" ON "${T_EVENT}" ("invoice_id") WHERE invoice_id IS NOT NULL`,
      `CREATE INDEX "${T_EVENT}_emission" ON "${T_EVENT}" ("emission_id") WHERE emission_id IS NOT NULL`,
      `CREATE INDEX "${T_EVENT}_received" ON "${T_EVENT}" ("received_id") WHERE received_id IS NOT NULL`,
    ],
    since: 9,
    owner: "G",
    structural: "emissao-cofre",
  },
  // A fatia comercial não projeta produção nas tabelas fiscais legadas.
  // Instantes são microssegundos UTC, dinheiro é centavos e JSON é restrito.
  commercial(C_SETTINGS, [
    `CREATE TABLE "${C_SETTINGS}" (
  "id" INTEGER NOT NULL PRIMARY KEY DEFAULT 1,
  "version" INTEGER NOT NULL DEFAULT 1,
  "environment" TEXT NOT NULL DEFAULT 'homologacao',
  "stock_timing" TEXT NOT NULL DEFAULT 'existing',
  "finance_timing" TEXT NOT NULL DEFAULT 'existing',
  "series_homologacao" INTEGER,
  "series_producao" INTEGER,
  "connection_fingerprint" TEXT,
  "connection_public" TEXT,
  "production_enabled_at" INTEGER,
  "production_enabled_by" TEXT,
  "tax_limits_acknowledged_at" INTEGER,
  "tax_limits_acknowledged_by" TEXT,
  "updated_at" INTEGER NOT NULL,
  "updated_by" TEXT NOT NULL,
  CONSTRAINT "${C_SETTINGS}_singleton_check" CHECK (id = 1),
  CONSTRAINT "${C_SETTINGS}_version_check" CHECK (version BETWEEN 1 AND 2147483647),
  CONSTRAINT "${C_SETTINGS}_environment_check" CHECK (environment IN ('homologacao','producao')),
  CONSTRAINT "${C_SETTINGS}_stock_timing_check" CHECK (stock_timing IN ('existing','on_authorization')),
  CONSTRAINT "${C_SETTINGS}_finance_timing_check" CHECK (finance_timing IN ('existing','on_authorization')),
  CONSTRAINT "${C_SETTINGS}_series_check" CHECK ((series_homologacao IS NULL OR series_homologacao BETWEEN 0 AND 999) AND (series_producao IS NULL OR series_producao BETWEEN 0 AND 999)),
  CONSTRAINT "${C_SETTINGS}_connection_check" CHECK ((connection_fingerprint IS NULL OR ${HEX64("connection_fingerprint")}) AND (connection_public IS NULL OR ${JSON_OF("connection_public", "object")})),
  CONSTRAINT "${C_SETTINGS}_production_check" CHECK ((production_enabled_at IS NULL) = (production_enabled_by IS NULL) AND (environment <> 'producao' OR production_enabled_at IS NOT NULL)),
  CONSTRAINT "${C_SETTINGS}_acknowledgement_check" CHECK ((tax_limits_acknowledged_at IS NULL) = (tax_limits_acknowledged_by IS NULL))
) STRICT`,
  ]),
  commercial(C_EMISSION, [
    `CREATE TABLE "${C_EMISSION}" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "document_id" TEXT NOT NULL,
  "fiscal_version" INTEGER NOT NULL,
  "environment" TEXT NOT NULL,
  "environment_confirmed" INTEGER NOT NULL DEFAULT 0,
  "connection_fingerprint" TEXT,
  "reference" TEXT NOT NULL,
  "current_body_revision" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "provider_id" TEXT,
  "provider_status" TEXT,
  "messages" TEXT NOT NULL DEFAULT '[]',
  "series" INTEGER,
  "number" INTEGER,
  "access_key" TEXT,
  "protocol" TEXT,
  "issued_at" INTEGER,
  "authorized_at" INTEGER,
  "total" INTEGER,
  "created_at" INTEGER NOT NULL,
  "created_by" TEXT NOT NULL,
  "updated_at" INTEGER NOT NULL,
  CONSTRAINT "${C_EMISSION}_document_version_key" UNIQUE (document_id, fiscal_version),
  CONSTRAINT "${C_EMISSION}_reference_key" UNIQUE (reference),
  CONSTRAINT "${C_EMISSION}_version_check" CHECK (fiscal_version BETWEEN 1 AND 9999 AND version BETWEEN 1 AND 2147483647 AND current_body_revision BETWEEN 1 AND 2147483647),
  CONSTRAINT "${C_EMISSION}_environment_check" CHECK (environment IN ('homologacao','producao') AND environment_confirmed IN (0,1)),
  CONSTRAINT "${C_EMISSION}_connection_check" CHECK (connection_fingerprint IS NULL OR ${HEX64("connection_fingerprint")}),
  CONSTRAINT "${C_EMISSION}_reference_check" CHECK (reference = 'wb.' || document_id || '.v' || fiscal_version),
  CONSTRAINT "${C_EMISSION}_status_check" CHECK (status IN ('bloqueada','preparada','enviando','processando','incerta','rejeitada','autorizada','denegada','cancelada','arquivada')),
  CONSTRAINT "${C_EMISSION}_sent_check" CHECK (status IN ('bloqueada','preparada','arquivada') OR connection_fingerprint IS NOT NULL),
  CONSTRAINT "${C_EMISSION}_messages_check" CHECK (${JSON_OF("messages", "array")}),
  CONSTRAINT "${C_EMISSION}_number_check" CHECK ((series IS NULL OR series BETWEEN 0 AND 999) AND (number IS NULL OR number BETWEEN 1 AND 999999999)),
  CONSTRAINT "${C_EMISSION}_access_key_check" CHECK (access_key IS NULL OR ${KEY44("access_key")}),
  CONSTRAINT "${C_EMISSION}_total_check" CHECK (total IS NULL OR total >= 0),
  CONSTRAINT "${C_EMISSION}_authorized_check" CHECK (status NOT IN ('autorizada','cancelada') OR (environment_confirmed = 1 AND provider_id IS NOT NULL AND length(provider_id) > 0 AND access_key IS NOT NULL AND protocol IS NOT NULL AND length(protocol) > 0 AND series IS NOT NULL AND number IS NOT NULL AND authorized_at IS NOT NULL AND substr(access_key,21,2) = '55' AND substr(access_key,23,3) = printf('%03d',series) AND substr(access_key,26,9) = printf('%09d',number))),
  CONSTRAINT "${C_EMISSION}_document_fkey" FOREIGN KEY (document_id) REFERENCES "erp_documents__document" (id),
  CONSTRAINT "${C_EMISSION}_revision_fkey" FOREIGN KEY (id, current_body_revision) REFERENCES "${C_REVISION}" (emission_id, body_revision) DEFERRABLE INITIALLY DEFERRED
) STRICT`,
    `CREATE INDEX "${C_EMISSION}_list" ON "${C_EMISSION}" (environment, updated_at, id)`,
    `CREATE INDEX "${C_EMISSION}_status" ON "${C_EMISSION}" (status, updated_at)`,
    `CREATE UNIQUE INDEX "${C_EMISSION}_provider" ON "${C_EMISSION}" (connection_fingerprint, environment, provider_id) WHERE provider_id IS NOT NULL`,
    `CREATE TRIGGER "${C_EMISSION}_identity_guard" BEFORE UPDATE ON "${C_EMISSION}" WHEN NEW.id IS NOT OLD.id OR NEW.document_id IS NOT OLD.document_id OR NEW.fiscal_version IS NOT OLD.fiscal_version OR NEW.reference IS NOT OLD.reference OR NEW.environment IS NOT OLD.environment OR ((OLD.status NOT IN ('bloqueada','preparada') OR EXISTS(SELECT 1 FROM "${C_COMMAND}" WHERE emission_id = OLD.id AND action IN ('emit','resume'))) AND NEW.connection_fingerprint IS NOT OLD.connection_fingerprint) BEGIN SELECT RAISE(ABORT, '40001:com1_emission_identity_immutable'); END`,
    `CREATE TRIGGER "${C_EMISSION}_revision_guard" BEFORE UPDATE ON "${C_EMISSION}" WHEN NEW.current_body_revision IS NOT OLD.current_body_revision AND OLD.status NOT IN ('bloqueada','preparada','rejeitada') BEGIN SELECT RAISE(ABORT, '40001:com1_emission_body_frozen'); END`,
    `CREATE TRIGGER "${C_EMISSION}_authorization_guard" BEFORE UPDATE ON "${C_EMISSION}" WHEN (OLD.status = 'autorizada' AND NEW.status NOT IN ('autorizada','cancelada')) OR (OLD.status = 'cancelada' AND NEW.status <> 'cancelada') OR (OLD.status IN ('autorizada','cancelada') AND (NEW.provider_id IS NOT OLD.provider_id OR NEW.access_key IS NOT OLD.access_key OR NEW.protocol IS NOT OLD.protocol OR NEW.series IS NOT OLD.series OR NEW.number IS NOT OLD.number OR NEW.authorized_at IS NOT OLD.authorized_at)) BEGIN SELECT RAISE(ABORT, '40001:com1_authorization_immutable'); END`,
    `CREATE TRIGGER "${C_EMISSION}_immutable_delete" BEFORE DELETE ON "${C_EMISSION}" BEGIN SELECT RAISE(ABORT, '40001:com1_history_immutable'); END`,
  ]),
  commercial(C_REVISION, [
    `CREATE TABLE "${C_REVISION}" (
  "emission_id" TEXT NOT NULL,
  "body_revision" INTEGER NOT NULL,
  "source_document_version" INTEGER NOT NULL,
  "snapshot" TEXT NOT NULL,
  "tax_sources" TEXT NOT NULL,
  "commercial_hash" TEXT NOT NULL,
  "source_fingerprint" TEXT NOT NULL,
  "body" TEXT,
  "body_hash" TEXT,
  "calculation" TEXT NOT NULL,
  "blockers" TEXT NOT NULL,
  "prepared_by" TEXT NOT NULL,
  "prepared_at" INTEGER NOT NULL,
  PRIMARY KEY (emission_id, body_revision),
  CONSTRAINT "${C_REVISION}_version_check" CHECK (body_revision BETWEEN 1 AND 2147483647 AND source_document_version BETWEEN 1 AND 2147483647),
  CONSTRAINT "${C_REVISION}_snapshot_check" CHECK (${JSON_OF("snapshot", "object")}),
  CONSTRAINT "${C_REVISION}_sources_check" CHECK (${JSON_OF("tax_sources", "object")}),
  CONSTRAINT "${C_REVISION}_commercial_hash_check" CHECK (${HEX64("commercial_hash")}),
  CONSTRAINT "${C_REVISION}_source_fingerprint_check" CHECK (${HEX64("source_fingerprint")}),
  CONSTRAINT "${C_REVISION}_body_check" CHECK ((body IS NULL) = (body_hash IS NULL) AND (body IS NULL OR (${JSON_OF("body", "object")} AND ${HEX64("body_hash")}))),
  CONSTRAINT "${C_REVISION}_calculation_check" CHECK (${JSON_OF("calculation", "object")}),
  CONSTRAINT "${C_REVISION}_blockers_check" CHECK (${JSON_OF("blockers", "array")}),
  CONSTRAINT "${C_REVISION}_emission_fkey" FOREIGN KEY (emission_id) REFERENCES "${C_EMISSION}" (id)
) STRICT`,
    ...immutable(C_REVISION),
  ]),
  commercial(C_COMMAND, [
    `CREATE TABLE "${C_COMMAND}" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "action" TEXT NOT NULL,
  "person_id" TEXT NOT NULL,
  "session_id" TEXT,
  "args_hash" TEXT NOT NULL,
  "emission_id" TEXT,
  "body_revision" INTEGER,
  "state" TEXT NOT NULL,
  "token" TEXT,
  "lease_until" INTEGER,
  "request" TEXT,
  "result" TEXT,
  "error" TEXT,
  "proposed_by" TEXT,
  "confirmed_by" TEXT,
  "created_at" INTEGER NOT NULL,
  "updated_at" INTEGER NOT NULL,
  CONSTRAINT "${C_COMMAND}_action_check" CHECK (action IN ('config_save','prepare','emit','resume','cancel','cancel_xml','effect_apply','effect_reverse')),
  CONSTRAINT "${C_COMMAND}_args_hash_check" CHECK (${HEX64("args_hash")}),
  CONSTRAINT "${C_COMMAND}_state_check" CHECK (state IN ('claimed','pending','completed','failed')),
  CONSTRAINT "${C_COMMAND}_claim_check" CHECK ((token IS NULL) = (lease_until IS NULL) AND (state <> 'claimed' OR token IS NOT NULL)),
  CONSTRAINT "${C_COMMAND}_request_check" CHECK (request IS NULL OR ${JSON_OF("request", "object")}),
  CONSTRAINT "${C_COMMAND}_result_check" CHECK (result IS NULL OR ${JSON_OF("result", "object")}),
  CONSTRAINT "${C_COMMAND}_error_check" CHECK (error IS NULL OR ${JSON_OF("error", "object")}),
  CONSTRAINT "${C_COMMAND}_revision_check" CHECK (body_revision IS NULL OR emission_id IS NOT NULL),
  CONSTRAINT "${C_COMMAND}_emission_request_check" CHECK (action NOT IN ('emit','resume') OR (emission_id IS NOT NULL AND body_revision IS NOT NULL AND request IS NOT NULL)),
  CONSTRAINT "${C_COMMAND}_emission_fkey" FOREIGN KEY (emission_id) REFERENCES "${C_EMISSION}" (id),
  CONSTRAINT "${C_COMMAND}_revision_fkey" FOREIGN KEY (emission_id, body_revision) REFERENCES "${C_REVISION}" (emission_id, body_revision)
) STRICT`,
    `CREATE INDEX "${C_COMMAND}_emission" ON "${C_COMMAND}" (emission_id, created_at)`,
    `CREATE UNIQUE INDEX "${C_COMMAND}_token" ON "${C_COMMAND}" (token) WHERE token IS NOT NULL`,
    `CREATE TRIGGER "${C_COMMAND}_identity_guard" BEFORE UPDATE ON "${C_COMMAND}" WHEN NEW.id IS NOT OLD.id OR NEW.action IS NOT OLD.action OR NEW.person_id IS NOT OLD.person_id OR NEW.session_id IS NOT OLD.session_id OR NEW.args_hash IS NOT OLD.args_hash OR NEW.emission_id IS NOT OLD.emission_id OR NEW.body_revision IS NOT OLD.body_revision OR NEW.request IS NOT OLD.request OR NEW.proposed_by IS NOT OLD.proposed_by OR NEW.confirmed_by IS NOT OLD.confirmed_by OR NEW.token IS NOT OLD.token OR NEW.lease_until IS NOT OLD.lease_until BEGIN SELECT RAISE(ABORT, '40001:com1_command_identity_immutable'); END`,
    `CREATE TRIGGER "${C_COMMAND}_immutable_delete" BEFORE DELETE ON "${C_COMMAND}" BEGIN SELECT RAISE(ABORT, '40001:com1_history_immutable'); END`,
  ]),
  commercial(C_CANCEL, [
    `CREATE TABLE "${C_CANCEL}" (
  "emission_id" TEXT NOT NULL PRIMARY KEY,
  "justification" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "body_hash" TEXT NOT NULL,
  "command_id" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'pedido',
  "messages" TEXT NOT NULL DEFAULT '[]',
  "protocol" TEXT,
  "event_at" INTEGER,
  "repeated" INTEGER NOT NULL DEFAULT 0,
  "xml_status" TEXT NOT NULL DEFAULT 'pendente',
  "xml" TEXT,
  "xml_hash" TEXT,
  "created_at" INTEGER NOT NULL,
  "updated_at" INTEGER NOT NULL,
  CONSTRAINT "${C_CANCEL}_justification_check" CHECK (length(justification) BETWEEN 15 AND 255),
  CONSTRAINT "${C_CANCEL}_body_check" CHECK (${JSON_OF("body", "object")} AND ${HEX64("body_hash")}),
  CONSTRAINT "${C_CANCEL}_state_check" CHECK (state IN ('pedido','enviando','incerto','recusado','registrado')),
  CONSTRAINT "${C_CANCEL}_messages_check" CHECK (${JSON_OF("messages", "array")}),
  CONSTRAINT "${C_CANCEL}_event_check" CHECK (state <> 'registrado' OR (protocol IS NOT NULL AND length(protocol) > 0 AND event_at IS NOT NULL)),
  CONSTRAINT "${C_CANCEL}_repeated_check" CHECK (repeated IN (0,1)),
  CONSTRAINT "${C_CANCEL}_xml_check" CHECK ((xml_status = 'pendente' AND xml IS NULL AND xml_hash IS NULL) OR (xml_status = 'disponivel' AND xml IS NOT NULL AND length(CAST(xml AS BLOB)) BETWEEN 1 AND 10485760 AND xml_hash IS NOT NULL AND ${HEX64("xml_hash")})),
  CONSTRAINT "${C_CANCEL}_emission_fkey" FOREIGN KEY (emission_id) REFERENCES "${C_EMISSION}" (id),
  CONSTRAINT "${C_CANCEL}_command_fkey" FOREIGN KEY (command_id) REFERENCES "${C_COMMAND}" (id)
) STRICT`,
    `CREATE TRIGGER "${C_CANCEL}_registered_guard" BEFORE UPDATE ON "${C_CANCEL}" WHEN OLD.state = 'registrado' AND (NEW.state <> 'registrado' OR NEW.emission_id IS NOT OLD.emission_id OR NEW.body IS NOT OLD.body OR NEW.body_hash IS NOT OLD.body_hash OR NEW.justification IS NOT OLD.justification OR NEW.protocol IS NOT OLD.protocol OR NEW.event_at IS NOT OLD.event_at) BEGIN SELECT RAISE(ABORT, '40001:com1_cancellation_immutable'); END`,
    `CREATE TRIGGER "${C_CANCEL}_request_guard" BEFORE UPDATE ON "${C_CANCEL}" WHEN NEW.emission_id IS NOT OLD.emission_id OR (OLD.state IN ('enviando','incerto') AND (NEW.body IS NOT OLD.body OR NEW.body_hash IS NOT OLD.body_hash OR NEW.justification IS NOT OLD.justification)) OR (OLD.xml_status = 'disponivel' AND (NEW.xml_status IS NOT OLD.xml_status OR NEW.xml IS NOT OLD.xml OR NEW.xml_hash IS NOT OLD.xml_hash)) BEGIN SELECT RAISE(ABORT, '40001:com1_cancellation_immutable'); END`,
    `CREATE TRIGGER "${C_CANCEL}_immutable_delete" BEFORE DELETE ON "${C_CANCEL}" BEGIN SELECT RAISE(ABORT, '40001:com1_history_immutable'); END`,
  ]),
  commercial(C_EFFECT, [
    `CREATE TABLE "${C_EFFECT}" (
  "emission_id" TEXT NOT NULL,
  "axis" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "origin" TEXT,
  "ids" TEXT NOT NULL DEFAULT '{}',
  "fingerprint" TEXT,
  "reason" TEXT,
  "responsible_role" TEXT,
  "person_id" TEXT,
  "command_id" TEXT,
  "result" TEXT,
  "compensation_state" TEXT,
  "compensation_command_id" TEXT,
  "compensation_result" TEXT,
  "updated_at" INTEGER NOT NULL,
  PRIMARY KEY (emission_id, axis),
  CONSTRAINT "${C_EFFECT}_axis_check" CHECK (axis IN ('stock','finance')),
  CONSTRAINT "${C_EFFECT}_state_check" CHECK (state IN ('aplicado','reconhecido','pendente','pulado')),
  CONSTRAINT "${C_EFFECT}_ids_check" CHECK (${JSON_OF("ids", "object")}),
  CONSTRAINT "${C_EFFECT}_fingerprint_check" CHECK (fingerprint IS NULL OR ${HEX64("fingerprint")}),
  CONSTRAINT "${C_EFFECT}_applied_check" CHECK (state NOT IN ('aplicado','reconhecido') OR (fingerprint IS NOT NULL AND json(ids) <> '{}')),
  CONSTRAINT "${C_EFFECT}_pending_check" CHECK (state NOT IN ('pendente','pulado') OR (reason IS NOT NULL AND length(reason) > 0)),
  CONSTRAINT "${C_EFFECT}_result_check" CHECK (result IS NULL OR ${JSON_OF("result", "object")}),
  CONSTRAINT "${C_EFFECT}_compensation_check" CHECK (compensation_state IS NULL OR compensation_state IN ('pendente','revertido','compensacao_pendente')),
  CONSTRAINT "${C_EFFECT}_compensation_result_check" CHECK (compensation_result IS NULL OR ${JSON_OF("compensation_result", "object")}),
  CONSTRAINT "${C_EFFECT}_emission_fkey" FOREIGN KEY (emission_id) REFERENCES "${C_EMISSION}" (id),
  CONSTRAINT "${C_EFFECT}_command_fkey" FOREIGN KEY (command_id) REFERENCES "${C_COMMAND}" (id),
  CONSTRAINT "${C_EFFECT}_compensation_command_fkey" FOREIGN KEY (compensation_command_id) REFERENCES "${C_COMMAND}" (id)
) STRICT`,
    `CREATE INDEX "${C_EFFECT}_pending" ON "${C_EFFECT}" (axis, state, updated_at)`,
    `CREATE TRIGGER "${C_EFFECT}_applied_guard" BEFORE UPDATE ON "${C_EFFECT}" WHEN NEW.emission_id IS NOT OLD.emission_id OR NEW.axis IS NOT OLD.axis OR (OLD.state IN ('aplicado','reconhecido') AND (NEW.state NOT IN ('aplicado','reconhecido') OR NEW.ids IS NOT OLD.ids OR NEW.fingerprint IS NOT OLD.fingerprint)) OR (OLD.compensation_state = 'revertido' AND (NEW.compensation_state IS NOT OLD.compensation_state OR NEW.compensation_result IS NOT OLD.compensation_result)) BEGIN SELECT RAISE(ABORT, '40001:com1_effect_immutable'); END`,
    `CREATE TRIGGER "${C_EFFECT}_immutable_delete" BEFORE DELETE ON "${C_EFFECT}" BEGIN SELECT RAISE(ABORT, '40001:com1_history_immutable'); END`,
  ]),
  commercial(C_AUDIT, [
    `CREATE TABLE "${C_AUDIT}" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "person_id" TEXT NOT NULL,
  "session_id" TEXT,
  "proposed_by" TEXT,
  "confirmed_by" TEXT,
  "command_id" TEXT,
  "emission_id" TEXT,
  "environment" TEXT,
  "action" TEXT NOT NULL,
  "before_summary" TEXT,
  "after_summary" TEXT,
  "references" TEXT NOT NULL DEFAULT '{}',
  "created_at" INTEGER NOT NULL,
  CONSTRAINT "${C_AUDIT}_environment_check" CHECK (environment IS NULL OR environment IN ('homologacao','producao')),
  CONSTRAINT "${C_AUDIT}_action_check" CHECK (length(action) BETWEEN 1 AND 100),
  CONSTRAINT "${C_AUDIT}_before_check" CHECK (before_summary IS NULL OR ${JSON_OF("before_summary", "object")}),
  CONSTRAINT "${C_AUDIT}_after_check" CHECK (after_summary IS NULL OR ${JSON_OF("after_summary", "object")}),
  CONSTRAINT "${C_AUDIT}_references_check" CHECK (${JSON_OF('"references"', "object")}),
  CONSTRAINT "${C_AUDIT}_emission_fkey" FOREIGN KEY (emission_id) REFERENCES "${C_EMISSION}" (id),
  CONSTRAINT "${C_AUDIT}_command_fkey" FOREIGN KEY (command_id) REFERENCES "${C_COMMAND}" (id)
) STRICT`,
    `CREATE INDEX "${C_AUDIT}_emission" ON "${C_AUDIT}" (emission_id, created_at, id)`,
    `CREATE INDEX "${C_AUDIT}_command" ON "${C_AUDIT}" (command_id)`,
    ...immutable(C_AUDIT),
  ]),
  bling("wb_bling_control", [
    `CREATE TABLE "wb_bling_control" (
  id INTEGER NOT NULL PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (${BLING_COUNT("revision")}),
  generation INTEGER NOT NULL DEFAULT 1 CHECK (${BLING_COUNT("generation", 1)}),
  authorization_revision INTEGER NOT NULL DEFAULT 0 CHECK (${BLING_COUNT("authorization_revision")}),
  credential_revision INTEGER NOT NULL DEFAULT 0 CHECK (${BLING_COUNT("credential_revision")}),
  collect_enabled INTEGER NOT NULL DEFAULT 0 CHECK (collect_enabled IN (0,1)),
  state TEXT NOT NULL DEFAULT 'off' CHECK (state IN ('off','needs_authorization','ready','running','waiting_rate','waiting_retry','blocked_scope','blocked_capacity','purging')),
  account_id TEXT,
  account_public TEXT NOT NULL DEFAULT '{}' CHECK (${BLING_JSON("account_public", "object")}),
  selection TEXT NOT NULL DEFAULT '[]' CHECK (${BLING_JSON("selection", "array")}),
  date_selection TEXT NOT NULL DEFAULT '{}' CHECK (${BLING_JSON("date_selection", "object")}),
  permissions TEXT NOT NULL DEFAULT '{}' CHECK (${BLING_JSON("permissions", "object")}),
  approved_by TEXT,
  approved_at INTEGER,
  approval_hash TEXT,
  app_configured INTEGER NOT NULL DEFAULT 0 CHECK (app_configured IN (0,1)),
  credential_status TEXT NOT NULL DEFAULT 'missing' CHECK (credential_status IN ('missing','ready','expired','uncertain','disconnected')),
  credential_expires_at INTEGER,
  credential_scopes TEXT NOT NULL DEFAULT '[]' CHECK (${BLING_JSON("credential_scopes", "array")}),
  daily_call_limit INTEGER NOT NULL DEFAULT 20000 CHECK (daily_call_limit BETWEEN 1 AND 20000),
  calls_day TEXT,
  calls_today INTEGER NOT NULL DEFAULT 0 CHECK (${BLING_COUNT("calls_today")}),
  min_interval_ms INTEGER NOT NULL DEFAULT 700 CHECK (min_interval_ms >= 700),
  next_allowed_at INTEGER,
  archive_bytes INTEGER NOT NULL DEFAULT 0 CHECK (${BLING_COUNT("archive_bytes")}),
  xml_bytes INTEGER NOT NULL DEFAULT 0 CHECK (${BLING_COUNT("xml_bytes")}),
  observed_count INTEGER NOT NULL DEFAULT 0 CHECK (${BLING_COUNT("observed_count")}),
  updated_at INTEGER NOT NULL,
  CONSTRAINT wb_bling_control_approval_check CHECK ((approved_by IS NULL AND approved_at IS NULL AND approval_hash IS NULL) OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND approval_hash IS NOT NULL AND ${BLING_HASH("approval_hash")})),
  CONSTRAINT wb_bling_control_account_check CHECK (account_id IS NULL OR ${BLING_ID("account_id")}),
  CONSTRAINT wb_bling_control_enabled_check CHECK (collect_enabled = 0 OR (approved_by IS NOT NULL AND state NOT IN ('off','purging')))
) STRICT`,
  ]),
  bling("wb_bling_unit", [
    `CREATE TABLE "wb_bling_unit" (
  id TEXT NOT NULL PRIMARY KEY CHECK (${BLING_ID("id")}),
  attempt_id TEXT NOT NULL UNIQUE CHECK (${BLING_ID("attempt_id")}),
  command_id TEXT NOT NULL UNIQUE CHECK (${BLING_ID("command_id")}),
  request_hash TEXT NOT NULL CHECK (${BLING_HASH("request_hash")}),
  generation INTEGER NOT NULL CHECK (${BLING_COUNT("generation", 1)}),
  authorization_revision INTEGER NOT NULL CHECK (${BLING_COUNT("authorization_revision")}),
  credential_revision INTEGER NOT NULL CHECK (${BLING_COUNT("credential_revision")}),
  configuration_revision INTEGER NOT NULL DEFAULT 0 CHECK (${BLING_COUNT("configuration_revision")}),
  account_id TEXT CHECK (account_id IS NULL OR ${BLING_ID("account_id")}),
  parts_revision TEXT CHECK (parts_revision IS NULL OR length(parts_revision) BETWEEN 1 AND 200),
  kind TEXT NOT NULL CHECK (kind IN ('list','detail','stock','reference','finance_refresh','capture_repair','xml_fetch','xml_store','xml_verify','xml_commit','r2_delete','purge','oauth_state','oauth_exchange','oauth_refresh')),
  resource TEXT,
  entity TEXT,
  source_id TEXT CHECK (source_id IS NULL OR ${BLING_ID("source_id")}),
  phase TEXT NOT NULL DEFAULT 'queued' CHECK (phase IN ('queued','reserved','fetching','committed','waiting','blocked','superseded')),
  plan TEXT NOT NULL DEFAULT '{}' CHECK (${BLING_JSON("plan", "object")}),
  expected_checkpoint TEXT NOT NULL DEFAULT '{}' CHECK (${BLING_JSON("expected_checkpoint", "object")}),
  expected_checkpoint_version INTEGER NOT NULL DEFAULT 0 CHECK (${BLING_COUNT("expected_checkpoint_version")}),
  owner TEXT CHECK (owner IS NULL OR length(owner) BETWEEN 1 AND 200),
  fence TEXT CHECK (fence IS NULL OR length(fence) BETWEEN 1 AND 128),
  lease_until INTEGER,
  not_before INTEGER NOT NULL,
  page_ids TEXT NOT NULL DEFAULT '[]' CHECK (${BLING_JSON("page_ids", "array", 8192)} AND json_array_length(page_ids) <= 25),
  page_fingerprint TEXT CHECK (page_fingerprint IS NULL OR ${BLING_HASH("page_fingerprint")}),
  subcursor INTEGER NOT NULL DEFAULT 0 CHECK (subcursor BETWEEN 0 AND 25 AND subcursor <= json_array_length(page_ids)),
  progress TEXT NOT NULL DEFAULT '{}' CHECK (${BLING_JSON("progress", "object")}),
  response_hash TEXT CHECK (response_hash IS NULL OR ${BLING_HASH("response_hash")}),
  error_code TEXT CHECK (error_code IS NULL OR (length(error_code) BETWEEN 1 AND 100 AND error_code NOT GLOB '*[^A-Z0-9_]*')),
  state_hash TEXT,
  browser_hash TEXT,
  profile TEXT,
  session_id TEXT,
  actor_id TEXT,
  expires_at INTEGER,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  CONSTRAINT wb_bling_unit_lease_check CHECK ((owner IS NULL AND fence IS NULL AND lease_until IS NULL) OR (owner IS NOT NULL AND fence IS NOT NULL AND lease_until IS NOT NULL)),
  CONSTRAINT wb_bling_unit_active_check CHECK (phase NOT IN ('reserved','fetching') OR (owner IS NOT NULL AND (substr(kind,1,6) = 'oauth_' OR (account_id IS NOT NULL AND parts_revision IS NOT NULL)))),
  CONSTRAINT wb_bling_unit_terminal_check CHECK ((phase IN ('committed','superseded')) = (finished_at IS NOT NULL)),
  CONSTRAINT wb_bling_unit_oauth_check CHECK ((kind = 'oauth_state' AND state_hash IS NOT NULL AND ${BLING_HASH("state_hash")} AND browser_hash IS NOT NULL AND ${BLING_HASH("browser_hash")} AND profile IS NOT NULL AND session_id IS NOT NULL AND actor_id IS NOT NULL AND expires_at IS NOT NULL AND expires_at > created_at AND expires_at <= created_at + 600000) OR (kind <> 'oauth_state' AND state_hash IS NULL AND browser_hash IS NULL)),
  CONSTRAINT wb_bling_unit_resource_fkey FOREIGN KEY (resource) REFERENCES origin_sync__resource_state(resource)
) STRICT`,
    `CREATE INDEX wb_bling_unit_due ON wb_bling_unit(phase, not_before, id)`,
    `CREATE INDEX wb_bling_unit_lease ON wb_bling_unit(lease_until, id) WHERE owner IS NOT NULL`,
    `CREATE INDEX wb_bling_unit_source ON wb_bling_unit(generation, entity, source_id)`,
    `CREATE UNIQUE INDEX wb_bling_unit_oauth_state ON wb_bling_unit(state_hash) WHERE state_hash IS NOT NULL`,
    `CREATE TRIGGER wb_bling_unit_identity_update BEFORE UPDATE ON wb_bling_unit WHEN NEW.id IS NOT OLD.id OR NEW.attempt_id IS NOT OLD.attempt_id OR NEW.command_id IS NOT OLD.command_id OR NEW.request_hash IS NOT OLD.request_hash OR NEW.generation IS NOT OLD.generation OR NEW.kind IS NOT OLD.kind OR NEW.entity IS NOT OLD.entity OR NEW.source_id IS NOT OLD.source_id OR NEW.resource IS NOT OLD.resource OR NEW.expected_checkpoint IS NOT OLD.expected_checkpoint OR NEW.expected_checkpoint_version IS NOT OLD.expected_checkpoint_version OR NEW.authorization_revision IS NOT OLD.authorization_revision OR NEW.credential_revision IS NOT OLD.credential_revision OR NEW.plan IS NOT OLD.plan OR NEW.state_hash IS NOT OLD.state_hash OR NEW.browser_hash IS NOT OLD.browser_hash OR NEW.profile IS NOT OLD.profile OR NEW.session_id IS NOT OLD.session_id OR NEW.actor_id IS NOT OLD.actor_id OR NEW.configuration_revision IS NOT OLD.configuration_revision OR NEW.account_id IS NOT OLD.account_id OR NEW.parts_revision IS NOT OLD.parts_revision OR NEW.expires_at IS NOT OLD.expires_at BEGIN SELECT RAISE(ABORT, 'BLING_COMMAND_CONFLICT'); END`,
    `CREATE TRIGGER wb_bling_unit_terminal_update BEFORE UPDATE ON wb_bling_unit WHEN OLD.phase IN ('committed','superseded') BEGIN SELECT RAISE(ABORT, 'BLING_COMMAND_CONFLICT'); END`,
  ]),
  bling("wb_bling_receipt", [
    `CREATE TABLE "wb_bling_receipt" (
  command_id TEXT NOT NULL PRIMARY KEY CHECK (${BLING_ID("command_id")}),
  operation TEXT NOT NULL CHECK (${BLING_ID("operation")}),
  request_hash TEXT NOT NULL CHECK (${BLING_HASH("request_hash")}),
  generation INTEGER NOT NULL CHECK (${BLING_COUNT("generation", 1)}),
  unit_id TEXT,
  attempt_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('committed','rejected','superseded')),
  result TEXT NOT NULL CHECK (${BLING_JSON("result", "object")}),
  references_json TEXT NOT NULL DEFAULT '{}' CHECK (${BLING_JSON("references_json", "object")}),
  error_code TEXT CHECK (error_code IS NULL OR (length(error_code) BETWEEN 1 AND 100 AND error_code NOT GLOB '*[^A-Z0-9_]*')),
  created_at INTEGER NOT NULL,
  CONSTRAINT wb_bling_receipt_result_check CHECK ((state = 'rejected') = (error_code IS NOT NULL))
) STRICT`,
    `CREATE INDEX wb_bling_receipt_generation ON wb_bling_receipt(generation, created_at, command_id)`,
    `CREATE INDEX wb_bling_receipt_unit ON wb_bling_receipt(unit_id, attempt_id)`,
    ...blingImmutable("wb_bling_receipt"),
  ]),
  bling("wb_bling_extra_raw", [
    `CREATE TABLE "wb_bling_extra_raw" (
  entity TEXT NOT NULL CHECK (length(entity) BETWEEN 1 AND 100 AND entity NOT GLOB '*[^a-z_]*'),
  source_id TEXT NOT NULL CHECK (${BLING_ID("source_id")}),
  generation INTEGER NOT NULL CHECK (${BLING_COUNT("generation", 1)}),
  last_resource TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (${JSON_OF("payload", "object")}),
  document_links TEXT NOT NULL DEFAULT '[]' CHECK (${JSON_OF("document_links", "array")}),
  version_hash TEXT NOT NULL CHECK (${BLING_HASH("version_hash")}),
  version INTEGER NOT NULL DEFAULT 1 CHECK (${BLING_COUNT("version", 1)}),
  source_updated_at INTEGER,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  changed_at INTEGER NOT NULL,
  price_capture TEXT CHECK (price_capture IS NULL OR ${JSON_OF("price_capture", "object")}),
  PRIMARY KEY (entity, source_id),
  CONSTRAINT wb_bling_extra_raw_entity_check CHECK (entity NOT IN ('contacts','products','sales_orders','sales_proposals','purchase_orders','receivables','payables','nfe','nfce','payment_methods','sellers','service_orders','warehouses','product_categories','financial_categories','ledger_accounts','cash_entries','stock_balances')),
  CONSTRAINT wb_bling_extra_raw_resource_fkey FOREIGN KEY (last_resource) REFERENCES origin_sync__resource_state(resource)
) STRICT`,
    `CREATE INDEX wb_bling_extra_raw_seen ON wb_bling_extra_raw(entity, last_seen_at, source_id)`,
    `CREATE INDEX wb_bling_extra_raw_changed ON wb_bling_extra_raw(entity, changed_at, source_id)`,
    `CREATE TRIGGER wb_bling_extra_raw_identity_update BEFORE UPDATE ON wb_bling_extra_raw WHEN NEW.entity IS NOT OLD.entity OR NEW.source_id IS NOT OLD.source_id OR NEW.generation IS NOT OLD.generation BEGIN SELECT RAISE(ABORT, 'BLING_GENERATION_RETIRED'); END`,
    `CREATE TRIGGER wb_bling_extra_raw_version_update BEFORE UPDATE ON wb_bling_extra_raw WHEN (NEW.version_hash = OLD.version_hash AND NEW.version <> OLD.version) OR (NEW.version_hash <> OLD.version_hash AND NEW.version <> OLD.version + 1) BEGIN SELECT RAISE(ABORT, 'BLING_REVISION_CONFLICT'); END`,
  ]),
  bling("wb_bling_record_version", [
    `CREATE TABLE "wb_bling_record_version" (
  entity TEXT NOT NULL,
  source_id TEXT NOT NULL CHECK (${BLING_ID("source_id")}),
  version INTEGER NOT NULL CHECK (${BLING_COUNT("version", 1)}),
  generation INTEGER NOT NULL CHECK (${BLING_COUNT("generation", 1)}),
  semantic_hash TEXT NOT NULL CHECK (${BLING_HASH("semantic_hash")}),
  size_bytes INTEGER NOT NULL CHECK (${BLING_COUNT("size_bytes")}),
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  source_updated_at INTEGER,
  source_time_quality TEXT NOT NULL DEFAULT 'unknown' CHECK (source_time_quality IN ('remote','observed','unknown','invalid')),
  mapper_version TEXT,
  deleted_observed INTEGER NOT NULL DEFAULT 0 CHECK (deleted_observed IN (0,1)),
  deletion_evidence TEXT CHECK (deletion_evidence IS NULL OR ${BLING_JSON("deletion_evidence", "object")}),
  references_json TEXT NOT NULL DEFAULT '[]' CHECK (${BLING_JSON("references_json", "array")}),
  capture_revision INTEGER NOT NULL DEFAULT 0 CHECK (${BLING_COUNT("capture_revision")}),
  capture TEXT CHECK (capture IS NULL OR ${BLING_JSON("capture", "object", 131072)}),
  metadata TEXT NOT NULL DEFAULT '{}' CHECK (${BLING_JSON("metadata", "object")}),
  PRIMARY KEY (entity, source_id, version),
  CONSTRAINT wb_bling_record_version_deletion_check CHECK (deleted_observed = 0 OR deletion_evidence IS NOT NULL),
  CONSTRAINT wb_bling_record_version_capture_check CHECK ((capture_revision = 0 AND capture IS NULL) OR (capture_revision > 0 AND capture IS NOT NULL))
) STRICT`,
    `CREATE INDEX wb_bling_record_version_observed ON wb_bling_record_version(entity, last_seen_at, source_id, version)`,
    `CREATE INDEX wb_bling_record_version_generation ON wb_bling_record_version(generation, entity, source_id, version)`,
    `CREATE TRIGGER wb_bling_record_version_identity_update BEFORE UPDATE ON wb_bling_record_version WHEN NEW.entity IS NOT OLD.entity OR NEW.source_id IS NOT OLD.source_id OR NEW.version IS NOT OLD.version OR NEW.generation IS NOT OLD.generation OR NEW.semantic_hash IS NOT OLD.semantic_hash OR NEW.size_bytes IS NOT OLD.size_bytes BEGIN SELECT RAISE(ABORT, 'BLING_REVISION_CONFLICT'); END`,
    `CREATE TRIGGER wb_bling_record_version_immutable_delete BEFORE DELETE ON wb_bling_record_version BEGIN SELECT RAISE(ABORT, 'BLING_ARCHIVE_REFERENCED'); END`,
  ]),
  bling("wb_bling_audit", [
    `CREATE TABLE "wb_bling_audit" (
  id TEXT NOT NULL PRIMARY KEY CHECK (${BLING_ID("id")}),
  actor_id TEXT NOT NULL CHECK (${BLING_ID("actor_id")}),
  operation TEXT NOT NULL CHECK (${BLING_ID("operation")}),
  command_id TEXT,
  generation INTEGER NOT NULL CHECK (${BLING_COUNT("generation", 1)}),
  revision_before INTEGER CHECK (revision_before IS NULL OR ${BLING_COUNT("revision_before")}),
  revision_after INTEGER CHECK (revision_after IS NULL OR ${BLING_COUNT("revision_after")}),
  counts TEXT NOT NULL DEFAULT '{}' CHECK (${BLING_JSON("counts", "object")}),
  references_json TEXT NOT NULL DEFAULT '{}' CHECK (${BLING_JSON("references_json", "object")}),
  code TEXT CHECK (code IS NULL OR (length(code) BETWEEN 1 AND 100 AND code NOT GLOB '*[^A-Z0-9_]*')),
  created_at INTEGER NOT NULL
) STRICT`,
    `CREATE INDEX wb_bling_audit_command ON wb_bling_audit(command_id, created_at, id)`,
    `CREATE INDEX wb_bling_audit_generation ON wb_bling_audit(generation, created_at, id)`,
    ...blingImmutable("wb_bling_audit"),
  ]),
  // Versão 12: adoção dos cadastros coletados (vínculo, revisão, trabalho e recibos).
  adoption("wb_bling_adoption_link", [
    `CREATE TABLE "wb_bling_adoption_link" (
  entity TEXT NOT NULL CHECK (entity IN (${ADOPTION_ENTITIES})),
  source_id TEXT NOT NULL CHECK (${BLING_ID("source_id")}),
  record_id TEXT NOT NULL CHECK (${BLING_ID("record_id")}),
  source_version INTEGER NOT NULL CHECK (${BLING_COUNT("source_version", 1)}),
  source_hash TEXT NOT NULL CHECK (${BLING_HASH("source_hash")}),
  mode TEXT NOT NULL CHECK (mode IN ('created','linked','updated')),
  adopted_by TEXT NOT NULL CHECK (${BLING_ID("adopted_by")}),
  adopted_at INTEGER NOT NULL,
  PRIMARY KEY (entity, source_id),
  CONSTRAINT wb_bling_adoption_link_record_unique UNIQUE (entity, record_id)
) STRICT`,
  ]),
  adoption("wb_bling_adoption_review", [
    `CREATE TABLE "wb_bling_adoption_review" (
  entity TEXT NOT NULL CHECK (entity IN (${ADOPTION_ENTITIES})),
  source_id TEXT NOT NULL CHECK (${BLING_ID("source_id")}),
  state TEXT NOT NULL CHECK (state IN ('pending','ignored')),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 60 AND reason NOT GLOB '*[^a-z_]*'),
  detail TEXT CHECK (detail IS NULL OR length(detail) <= 200),
  candidates TEXT NOT NULL DEFAULT '[]' CHECK (${BLING_JSON("candidates", "array", 8192)}),
  source_version INTEGER NOT NULL CHECK (${BLING_COUNT("source_version", 1)}),
  source_hash TEXT NOT NULL CHECK (${BLING_HASH("source_hash")}),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (entity, source_id)
) STRICT`,
    `CREATE INDEX wb_bling_adoption_review_state ON wb_bling_adoption_review(entity, state, source_id)`,
  ]),
  adoption("wb_bling_adoption_job", [
    `CREATE TABLE "wb_bling_adoption_job" (
  id INTEGER NOT NULL PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  state TEXT NOT NULL CHECK (state IN ('running','paused','done')),
  entities TEXT NOT NULL CHECK (${BLING_JSON("entities", "array", 4096)}),
  cursor TEXT NOT NULL DEFAULT '{}' CHECK (${BLING_JSON("cursor", "object", 16384)}),
  counts TEXT NOT NULL DEFAULT '{}' CHECK (${BLING_JSON("counts", "object", 16384)}),
  actor_id TEXT NOT NULL CHECK (${BLING_ID("actor_id")}),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (${BLING_COUNT("revision", 1)}),
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  CONSTRAINT wb_bling_adoption_job_finished_check CHECK ((state = 'done') = (finished_at IS NOT NULL))
) STRICT`,
  ]),
  adoption("wb_bling_adoption_command", [
    `CREATE TABLE "wb_bling_adoption_command" (
  command_id TEXT NOT NULL PRIMARY KEY CHECK (${BLING_ID("command_id")}),
  operation TEXT NOT NULL CHECK (${BLING_ID("operation")}),
  actor_id TEXT NOT NULL CHECK (${BLING_ID("actor_id")}),
  request_hash TEXT NOT NULL CHECK (${BLING_HASH("request_hash")}),
  result TEXT NOT NULL CHECK (${BLING_JSON("result", "object")}),
  created_at INTEGER NOT NULL
) STRICT`,
    ...blingImmutable("wb_bling_adoption_command"),
  ]),
  // Versão 13: vínculo, pendências e espelho histórico de documentos e contas.
  adoptionB2("wb_bling_adoption_doc_link", [
    `CREATE TABLE "wb_bling_adoption_doc_link" (
  entity TEXT NOT NULL CHECK (entity IN (${ADOPTION_B2_ENTITIES})),
  source_id TEXT NOT NULL CHECK (${BLING_ID("source_id")}),
  record_id TEXT NOT NULL CHECK (${BLING_ID("record_id")}),
  source_version INTEGER NOT NULL CHECK (${BLING_COUNT("source_version", 1)}),
  source_hash TEXT NOT NULL CHECK (${BLING_HASH("source_hash")}),
  mode TEXT NOT NULL CHECK (mode IN ('created','linked','updated')),
  adopted_by TEXT NOT NULL CHECK (${BLING_ID("adopted_by")}),
  adopted_at INTEGER NOT NULL,
  PRIMARY KEY (entity, source_id),
  CONSTRAINT wb_bling_adoption_doc_link_record_unique UNIQUE (entity, record_id)
) STRICT`,
  ]),
  adoptionB2("wb_bling_adoption_doc_review", [
    `CREATE TABLE "wb_bling_adoption_doc_review" (
  entity TEXT NOT NULL CHECK (entity IN (${ADOPTION_B2_ENTITIES})),
  source_id TEXT NOT NULL CHECK (${BLING_ID("source_id")}),
  state TEXT NOT NULL CHECK (state IN ('pending','ignored')),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 60 AND reason NOT GLOB '*[^a-z_]*'),
  detail TEXT CHECK (detail IS NULL OR length(detail) <= 200),
  candidates TEXT NOT NULL DEFAULT '[]' CHECK (${BLING_JSON("candidates", "array", 8192)}),
  missing TEXT NOT NULL DEFAULT '[]' CHECK (${BLING_JSON("missing", "array", 16384)}),
  source_version INTEGER NOT NULL CHECK (${BLING_COUNT("source_version", 1)}),
  source_hash TEXT NOT NULL CHECK (${BLING_HASH("source_hash")}),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (entity, source_id)
) STRICT`,
    `CREATE INDEX wb_bling_adoption_doc_review_state ON wb_bling_adoption_doc_review(entity, state, source_id)`,
  ]),
  adoptionB2("wb_bling_adoption_history", [
    `CREATE TABLE "wb_bling_adoption_history" (
  entity TEXT NOT NULL CHECK (entity IN (${ADOPTION_B2_ENTITIES})),
  source_id TEXT NOT NULL CHECK (${BLING_ID("source_id")}),
  scope TEXT NOT NULL CHECK (scope IN ('fulfilled','cancelled','paid','partial','returned','deleted','other')),
  situation TEXT CHECK (situation IS NULL OR length(situation) <= 120),
  number TEXT CHECK (number IS NULL OR length(number) <= 80),
  contact_name TEXT CHECK (contact_name IS NULL OR length(contact_name) <= 200),
  issued_on TEXT CHECK (issued_on IS NULL OR (length(issued_on) = 10 AND issued_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
  total_cents INTEGER CHECK (total_cents IS NULL OR total_cents BETWEEN -999999999999999 AND 999999999999999),
  search TEXT NOT NULL DEFAULT '' CHECK (length(search) <= 400),
  source_version INTEGER NOT NULL CHECK (${BLING_COUNT("source_version", 1)}),
  source_hash TEXT NOT NULL CHECK (${BLING_HASH("source_hash")}),
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (entity, source_id)
) STRICT`,
    `CREATE INDEX wb_bling_adoption_history_date ON wb_bling_adoption_history(entity, issued_on, source_id)`,
  ]),
];

// Balcão com NFC-e (modelo 65): a mesma máquina da NF-e comercial, em tabelas
// irmãs. O CHECK de autorização da v10 exige o modelo 55 na chave de acesso e
// não pode mudar sem reescrever a tabela; as irmãs nascem do mesmo DDL, só com
// o nome e o modelo trocados. A conexão com o cofre continua única
// (commercial_settings); counter_settings guarda só a natureza do cupom.
const COUNTER_PREFIX = "erp_fiscal_vault__counter_";
const counterTables: readonly EngineTable[] = BASE_ENGINE_TABLES
  .filter((t) => t.structural === "comercial-nfe" && t.table !== C_SETTINGS)
  .map((t) => ({
    table: t.table.replace("erp_fiscal_vault__order_", COUNTER_PREFIX),
    ddl: t.ddl.map((statement) => {
      const renamed = statement.replaceAll("erp_fiscal_vault__order_", COUNTER_PREFIX);
      return t.table === C_EMISSION ? renamed.replace("substr(access_key,21,2) = '55'", "substr(access_key,21,2) = '65'") : renamed;
    }),
    since: 14, owner: "nfce-balcao", structural: "cupom-nfce",
  }));
const C_COUNTER_SETTINGS = `${COUNTER_PREFIX}settings`;

// Nota de serviço (NFS-e do Sistema Nacional) a partir da ordem de serviço:
// a mesma máquina, em tabelas irmãs. A NFS-e não tem chave de 44 dígitos do
// modelo 55, série numérica até 999 nem protocolo: a série vai até 5 dígitos,
// o número da DPS até 15, a chave nacional tem até 50 caracteres e o número da
// NFS-e (numeroNfse) ocupa a coluna protocol. Só o CHECK de número, chave e
// autorização muda; o resto nasce do DDL da versão 10 com o nome trocado.
const SERVICE_PREFIX = "erp_fiscal_vault__service_";
const C_SERVICE_EMISSION = `${SERVICE_PREFIX}emission`;
function replaceConstraint(statement: string, name: string, check: string): string {
  const pattern = new RegExp(`^  CONSTRAINT "${name}" CHECK \\(.*\\),$`, "m");
  if (!pattern.test(statement)) throw new Error(`Restrição ${name} não encontrada no DDL da versão 10.`);
  return statement.replace(pattern, `  CONSTRAINT "${name}" CHECK (${check}),`);
}
const serviceEmission = (statement: string): string => {
  if (!statement.startsWith(`CREATE TABLE "${C_SERVICE_EMISSION}"`)) return statement;
  let ddl = replaceConstraint(statement, `${C_SERVICE_EMISSION}_number_check`,
    "(series IS NULL OR series BETWEEN 0 AND 99999) AND (number IS NULL OR number BETWEEN 1 AND 999999999999999)");
  ddl = replaceConstraint(ddl, `${C_SERVICE_EMISSION}_access_key_check`,
    "access_key IS NULL OR (length(access_key) BETWEEN 44 AND 50 AND access_key NOT GLOB '*[^0-9A-Z]*')");
  return replaceConstraint(ddl, `${C_SERVICE_EMISSION}_authorized_check`,
    "status NOT IN ('autorizada','cancelada') OR (environment_confirmed = 1 AND provider_id IS NOT NULL AND length(provider_id) > 0 AND protocol IS NOT NULL AND length(protocol) > 0 AND series IS NOT NULL AND number IS NOT NULL AND authorized_at IS NOT NULL)");
};
const serviceTables: readonly EngineTable[] = BASE_ENGINE_TABLES
  .filter((t) => t.structural === "comercial-nfe" && t.table !== C_SETTINGS)
  .map((t) => ({
    table: t.table.replace("erp_fiscal_vault__order_", SERVICE_PREFIX),
    ddl: t.ddl.map((statement) => serviceEmission(statement.replaceAll("erp_fiscal_vault__order_", SERVICE_PREFIX))),
    since: 16, owner: "os5-fiscal", structural: "nota-servico-os",
  }));
/** Cadastro fiscal do serviço (código de tributação nacional e municipal, NBS,
 * alíquota e retenção do ISS, apuração do Simples e município de prestação),
 * com o padrão e as exceções por serviço do catálogo. O que é do emitente
 * (inscrição municipal, série da DPS, regime especial, certificado) fica no cofre. */
const C_SERVICE_SETTINGS = `${SERVICE_PREFIX}settings`;
// Compra pela nota recebida (versão 17, só tabelas novas): o índice de cada
// nota que chegou para a empresa (do cofre ou importada à mão; o XML fica no
// R2 da área, aqui só a chave e o SHA-256), a entrada que a conferência deu
// (estoque, custo e contas a pagar pelas rotinas das telas, uma entrada ativa
// por nota) e o interruptor do administrador para manifestar. O vínculo
// "código do fornecedor → produto" é o erp_catalog.product_supplier e a
// conversão de unidade é o erp_stock.unit_conversion, que já existiam.
// Instantes em microssegundos (relógio do motor), dinheiro em centavos.
const I_NOTE = "erp_purchase_inbound__note";
const I_ENTRY = "erp_purchase_inbound__entry";
const I_SETTINGS = "erp_purchase_inbound__settings";
const inbound = (table: string, ddl: readonly string[]): EngineTable => ({ table, ddl, since: 17, owner: "compra-nota", structural: "compra-nota-recebida" });
const inboundTables: readonly EngineTable[] = [
  inbound(I_NOTE, [
    `CREATE TABLE "${I_NOTE}" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "source" TEXT NOT NULL,
  "received_id" TEXT,
  "environment" TEXT NOT NULL,
  "access_key" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'destinatario',
  "emitter_document" TEXT,
  "emitter_name" TEXT,
  "series" INTEGER,
  "number" INTEGER,
  "issued_on" TEXT,
  "total_cents" INTEGER,
  "situation" TEXT NOT NULL DEFAULT 'autorizada',
  "nature" TEXT,
  ${ARRAY("cfops")},
  "purpose" TEXT,
  "xml_key" TEXT,
  "xml_sha256" TEXT,
  "xml_size" INTEGER,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by" TEXT,
  "created_at" INTEGER NOT NULL,
  "updated_at" INTEGER NOT NULL,
  CONSTRAINT "${I_NOTE}_access_key_key" UNIQUE ("access_key"),
  CONSTRAINT "${I_NOTE}_source_check" CHECK ((source IN ('cofre', 'manual') AND (source = 'manual' OR received_id IS NOT NULL))),
  CONSTRAINT "${I_NOTE}_environment_check" CHECK ((environment IN ('producao', 'homologacao'))),
  CONSTRAINT "${I_NOTE}_access_key_check" CHECK (${KEY44("access_key")}),
  CONSTRAINT "${I_NOTE}_role_check" CHECK ((role IN ('destinatario', 'terceiro'))),
  CONSTRAINT "${I_NOTE}_emitter_name_check" CHECK ((emitter_name IS NULL OR length(emitter_name) BETWEEN 1 AND 200)),
  CONSTRAINT "${I_NOTE}_issued_on_check" CHECK ((issued_on IS NULL OR issued_on GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]')),
  CONSTRAINT "${I_NOTE}_total_check" CHECK ((total_cents IS NULL OR total_cents >= 0)),
  CONSTRAINT "${I_NOTE}_situation_check" CHECK ((situation IN ('autorizada', 'cancelada', 'denegada'))),
  CONSTRAINT "${I_NOTE}_nature_check" CHECK ((nature IS NULL OR length(nature) <= 120)),
  CONSTRAINT "${I_NOTE}_purpose_check" CHECK ((purpose IS NULL OR purpose IN ('compra', 'devolucao', 'bonificacao', 'remessa', 'outra'))),
  CONSTRAINT "${I_NOTE}_xml_check" CHECK ((((xml_key IS NULL) = (xml_sha256 IS NULL)) AND ((xml_key IS NULL) = (xml_size IS NULL)) AND (xml_sha256 IS NULL OR ${HEX64("xml_sha256")}) AND (xml_size IS NULL OR xml_size BETWEEN 1 AND 1048576) AND (xml_key IS NULL OR length(xml_key) <= 300))),
  CONSTRAINT "${I_NOTE}_version_check" CHECK ((version BETWEEN 1 AND 2147483647)),
  CONSTRAINT "${I_NOTE}_received_id_fkey" FOREIGN KEY ("received_id") REFERENCES "${T_RECEIVED}" ("id")
) STRICT`,
    `CREATE UNIQUE INDEX "${I_NOTE}_received" ON "${I_NOTE}" ("received_id") WHERE received_id IS NOT NULL`,
    `CREATE INDEX "${I_NOTE}_list" ON "${I_NOTE}" ("environment", "issued_on")`,
  ]),
  inbound(I_ENTRY, [
    `CREATE TABLE "${I_ENTRY}" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "note_id" TEXT NOT NULL,
  "command_id" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'active',
  "supplier_id" TEXT,
  "order_id" TEXT,
  "stock_status" TEXT NOT NULL,
  "finance_status" TEXT NOT NULL,
  ${ARRAY("movement_ids")},
  ${ARRAY("title_ids")},
  "snapshot" TEXT NOT NULL,
  "result" TEXT NOT NULL,
  "actor" TEXT NOT NULL,
  "via" TEXT,
  "created_at" INTEGER NOT NULL,
  "reversed_at" INTEGER,
  "reversed_by" TEXT,
  "reversal_reason" TEXT,
  "reversal_command_id" TEXT,
  "reversal" TEXT,
  CONSTRAINT "${I_ENTRY}_command_id_key" UNIQUE ("command_id"),
  CONSTRAINT "${I_ENTRY}_reversal_command_id_key" UNIQUE ("reversal_command_id"),
  CONSTRAINT "${I_ENTRY}_state_check" CHECK ((state IN ('active', 'reversed'))),
  CONSTRAINT "${I_ENTRY}_stock_status_check" CHECK ((stock_status IN ('done', 'part_disabled', 'not_chosen', 'role_missing', 'nothing'))),
  CONSTRAINT "${I_ENTRY}_finance_status_check" CHECK ((finance_status IN ('done', 'part_disabled', 'not_chosen', 'role_missing', 'nothing'))),
  CONSTRAINT "${I_ENTRY}_snapshot_check" CHECK (${JSON_OF("snapshot", "object")}),
  CONSTRAINT "${I_ENTRY}_result_check" CHECK (${JSON_OF("result", "object")}),
  CONSTRAINT "${I_ENTRY}_reversal_check" CHECK ((((state = 'reversed') = (reversed_at IS NOT NULL)) AND ((reversed_at IS NULL) = (reversed_by IS NULL)) AND ((reversed_at IS NULL) = (reversal_reason IS NULL)) AND ((reversed_at IS NULL) = (reversal_command_id IS NULL)) AND ((reversed_at IS NULL) = (reversal IS NULL)) AND (reversal_reason IS NULL OR length(reversal_reason) BETWEEN 3 AND 500) AND (reversal IS NULL OR ${JSON_OF("reversal", "object")}))),
  CONSTRAINT "${I_ENTRY}_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "${I_NOTE}" ("id"),
  CONSTRAINT "${I_ENTRY}_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "erp_catalog__contact" ("record_id"),
  CONSTRAINT "${I_ENTRY}_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "erp_documents__document" ("id")
) STRICT`,
    // Uma entrada ativa por nota: dar entrada duas vezes não duplica nada.
    `CREATE UNIQUE INDEX "${I_ENTRY}_active" ON "${I_ENTRY}" ("note_id") WHERE state = 'active'`,
    `CREATE INDEX "${I_ENTRY}_note" ON "${I_ENTRY}" ("note_id")`,
  ]),
  inbound(I_SETTINGS, [
    `CREATE TABLE "${I_SETTINGS}" (
  "id" INTEGER NOT NULL PRIMARY KEY DEFAULT 1,
  "version" INTEGER NOT NULL DEFAULT 1,
  "manifest_enabled" INTEGER NOT NULL DEFAULT 0,
  "updated_at" INTEGER NOT NULL,
  "updated_by" TEXT NOT NULL,
  CONSTRAINT "${I_SETTINGS}_singleton_check" CHECK (id = 1),
  CONSTRAINT "${I_SETTINGS}_version_check" CHECK (version BETWEEN 1 AND 2147483647),
  CONSTRAINT "${I_SETTINGS}_manifest_enabled_check" CHECK (manifest_enabled IN (0, 1))
) STRICT`,
  ]),
];

// Depois da nota autorizada (versão 18, só acréscimo). O cofre numera,
// assina e transmite; aqui fica o pedido que o ERP fez, o resultado e o que
// a nota mudou no estoque e nas contas (a devolução), cada efeito uma vez só.
const C_CORRECTION = "erp_fiscal_vault__order_correction";
const C_VOID = "erp_fiscal_vault__void_range";
const C_RETURN = "erp_fiscal_vault__order_return";
const EVENT_STATE = "('enviando','incerto','recusado','registrado')";
const eventTable = (table: string, ddl: readonly string[]): EngineTable => ({ table, ddl, since: 18, owner: "fiscal-eventos", structural: "eventos-nfe" });
const EVENT_TABLES: readonly EngineTable[] = [
  eventTable(C_CORRECTION, [
    `CREATE TABLE "${C_CORRECTION}" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "emission_id" TEXT NOT NULL,
  "command_id" TEXT NOT NULL,
  "person_id" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "text_hash" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'enviando',
  "expected_sequence" INTEGER NOT NULL,
  "sequence" INTEGER,
  "protocol" TEXT,
  "event_at" TEXT,
  "messages" TEXT NOT NULL DEFAULT '[]',
  "xml" TEXT,
  "xml_hash" TEXT,
  "created_at" INTEGER NOT NULL,
  "updated_at" INTEGER NOT NULL,
  CONSTRAINT "${C_CORRECTION}_command_key" UNIQUE (command_id),
  CONSTRAINT "${C_CORRECTION}_text_check" CHECK (length(text) BETWEEN 15 AND 1000 AND ${HEX64("text_hash")}),
  CONSTRAINT "${C_CORRECTION}_state_check" CHECK (state IN ${EVENT_STATE}),
  CONSTRAINT "${C_CORRECTION}_sequence_check" CHECK (expected_sequence BETWEEN 1 AND 20 AND (sequence IS NULL OR sequence BETWEEN 1 AND 20)),
  CONSTRAINT "${C_CORRECTION}_registered_check" CHECK (state <> 'registrado' OR sequence IS NOT NULL),
  CONSTRAINT "${C_CORRECTION}_messages_check" CHECK (${JSON_OF("messages", "array")}),
  CONSTRAINT "${C_CORRECTION}_xml_check" CHECK ((xml IS NULL AND xml_hash IS NULL) OR (xml IS NOT NULL AND length(CAST(xml AS BLOB)) BETWEEN 1 AND 10485760 AND ${HEX64("xml_hash")})),
  CONSTRAINT "${C_CORRECTION}_emission_fkey" FOREIGN KEY (emission_id) REFERENCES "${C_EMISSION}" (id)
) STRICT`,
    `CREATE INDEX "${C_CORRECTION}_emission" ON "${C_CORRECTION}" (emission_id, created_at)`,
    `CREATE UNIQUE INDEX "${C_CORRECTION}_sequence" ON "${C_CORRECTION}" (emission_id, sequence) WHERE sequence IS NOT NULL`,
    `CREATE TRIGGER "${C_CORRECTION}_registered_guard" BEFORE UPDATE ON "${C_CORRECTION}" WHEN NEW.id IS NOT OLD.id OR NEW.emission_id IS NOT OLD.emission_id OR NEW.command_id IS NOT OLD.command_id OR NEW.text IS NOT OLD.text OR NEW.text_hash IS NOT OLD.text_hash OR NEW.expected_sequence IS NOT OLD.expected_sequence OR (OLD.state = 'registrado' AND (NEW.state <> 'registrado' OR NEW.sequence IS NOT OLD.sequence OR NEW.protocol IS NOT OLD.protocol)) OR (OLD.xml IS NOT NULL AND (NEW.xml IS NOT OLD.xml OR NEW.xml_hash IS NOT OLD.xml_hash)) BEGIN SELECT RAISE(ABORT, '40001:nfe_correction_immutable'); END`,
    `CREATE TRIGGER "${C_CORRECTION}_immutable_delete" BEFORE DELETE ON "${C_CORRECTION}" BEGIN SELECT RAISE(ABORT, '40001:com1_history_immutable'); END`,
  ]),
  eventTable(C_VOID, [
    `CREATE TABLE "${C_VOID}" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "command_id" TEXT NOT NULL,
  "person_id" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "environment" TEXT NOT NULL,
  "series" INTEGER NOT NULL,
  "first_number" INTEGER NOT NULL,
  "last_number" INTEGER NOT NULL,
  "justification" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'enviando',
  "provider_ref" TEXT,
  "protocol" TEXT,
  "repeated" INTEGER NOT NULL DEFAULT 0,
  "messages" TEXT NOT NULL DEFAULT '[]',
  "created_at" INTEGER NOT NULL,
  "updated_at" INTEGER NOT NULL,
  CONSTRAINT "${C_VOID}_command_key" UNIQUE (command_id),
  CONSTRAINT "${C_VOID}_model_check" CHECK (model IN ('nfe','nfce') AND environment IN ('homologacao','producao')),
  CONSTRAINT "${C_VOID}_range_check" CHECK (series BETWEEN 0 AND 889 AND first_number BETWEEN 1 AND 999999999 AND last_number BETWEEN first_number AND 999999999),
  CONSTRAINT "${C_VOID}_justification_check" CHECK (length(justification) BETWEEN 15 AND 255),
  CONSTRAINT "${C_VOID}_state_check" CHECK (state IN ${EVENT_STATE} AND repeated IN (0,1)),
  CONSTRAINT "${C_VOID}_registered_check" CHECK (state <> 'registrado' OR (provider_ref IS NOT NULL AND length(provider_ref) > 0)),
  CONSTRAINT "${C_VOID}_messages_check" CHECK (${JSON_OF("messages", "array")})
) STRICT`,
    `CREATE INDEX "${C_VOID}_list" ON "${C_VOID}" (environment, model, created_at)`,
    `CREATE TRIGGER "${C_VOID}_registered_guard" BEFORE UPDATE ON "${C_VOID}" WHEN NEW.id IS NOT OLD.id OR NEW.command_id IS NOT OLD.command_id OR NEW.model IS NOT OLD.model OR NEW.environment IS NOT OLD.environment OR NEW.series IS NOT OLD.series OR NEW.first_number IS NOT OLD.first_number OR NEW.last_number IS NOT OLD.last_number OR NEW.justification IS NOT OLD.justification OR (OLD.state = 'registrado' AND (NEW.state <> 'registrado' OR NEW.provider_ref IS NOT OLD.provider_ref)) BEGIN SELECT RAISE(ABORT, '40001:nfe_void_immutable'); END`,
    `CREATE TRIGGER "${C_VOID}_immutable_delete" BEFORE DELETE ON "${C_VOID}" BEGIN SELECT RAISE(ABORT, '40001:com1_history_immutable'); END`,
  ]),
  eventTable(C_RETURN, [
    `CREATE TABLE "${C_RETURN}" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "emission_id" TEXT NOT NULL,
  "command_id" TEXT NOT NULL,
  "person_id" TEXT NOT NULL,
  "environment" TEXT NOT NULL,
  "connection_fingerprint" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "items" TEXT NOT NULL,
  "finance_option" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "body_hash" TEXT NOT NULL,
  "total" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'preparada',
  "provider_id" TEXT,
  "series" INTEGER,
  "number" INTEGER,
  "access_key" TEXT,
  "protocol" TEXT,
  "authorized_at" TEXT,
  "messages" TEXT NOT NULL DEFAULT '[]',
  "stock_state" TEXT NOT NULL DEFAULT 'pendente',
  "stock_result" TEXT,
  "finance_state" TEXT NOT NULL DEFAULT 'pendente',
  "finance_result" TEXT,
  "created_at" INTEGER NOT NULL,
  "updated_at" INTEGER NOT NULL,
  CONSTRAINT "${C_RETURN}_command_key" UNIQUE (command_id),
  CONSTRAINT "${C_RETURN}_reference_key" UNIQUE (reference),
  CONSTRAINT "${C_RETURN}_reference_check" CHECK (reference = 'wb.' || id || '.v1'),
  CONSTRAINT "${C_RETURN}_environment_check" CHECK (environment IN ('homologacao','producao') AND ${HEX64("connection_fingerprint")}),
  CONSTRAINT "${C_RETURN}_items_check" CHECK (${JSON_OF("items", "array")} AND json_array_length(items) BETWEEN 1 AND 990),
  CONSTRAINT "${C_RETURN}_finance_option_check" CHECK (finance_option IN ('credito','pagar')),
  CONSTRAINT "${C_RETURN}_body_check" CHECK (${JSON_OF("body", "object")} AND ${HEX64("body_hash")} AND total >= 0),
  CONSTRAINT "${C_RETURN}_status_check" CHECK (status IN ('preparada','enviando','processando','incerta','rejeitada','denegada','autorizada','cancelada')),
  CONSTRAINT "${C_RETURN}_authorized_check" CHECK (status NOT IN ('autorizada','cancelada') OR (provider_id IS NOT NULL AND access_key IS NOT NULL AND ${KEY44("access_key")} AND protocol IS NOT NULL AND number IS NOT NULL AND series IS NOT NULL)),
  CONSTRAINT "${C_RETURN}_messages_check" CHECK (${JSON_OF("messages", "array")}),
  CONSTRAINT "${C_RETURN}_effect_check" CHECK (stock_state IN ('pendente','aplicado','pulado') AND finance_state IN ('pendente','aplicado','pulado') AND (stock_result IS NULL OR ${JSON_OF("stock_result", "object")}) AND (finance_result IS NULL OR ${JSON_OF("finance_result", "object")})),
  CONSTRAINT "${C_RETURN}_emission_fkey" FOREIGN KEY (emission_id) REFERENCES "${C_EMISSION}" (id)
) STRICT`,
    `CREATE INDEX "${C_RETURN}_emission" ON "${C_RETURN}" (emission_id, created_at)`,
    `CREATE TRIGGER "${C_RETURN}_identity_guard" BEFORE UPDATE ON "${C_RETURN}" WHEN NEW.id IS NOT OLD.id OR NEW.emission_id IS NOT OLD.emission_id OR NEW.command_id IS NOT OLD.command_id OR NEW.reference IS NOT OLD.reference OR NEW.environment IS NOT OLD.environment OR NEW.connection_fingerprint IS NOT OLD.connection_fingerprint OR NEW.items IS NOT OLD.items OR NEW.body IS NOT OLD.body OR NEW.body_hash IS NOT OLD.body_hash OR NEW.total IS NOT OLD.total OR (OLD.status = 'autorizada' AND NEW.status NOT IN ('autorizada','cancelada')) OR (OLD.status IN ('autorizada','cancelada') AND (NEW.provider_id IS NOT OLD.provider_id OR NEW.access_key IS NOT OLD.access_key OR NEW.number IS NOT OLD.number)) OR (OLD.stock_state = 'aplicado' AND (NEW.stock_state <> 'aplicado' OR NEW.stock_result IS NOT OLD.stock_result)) OR (OLD.finance_state = 'aplicado' AND (NEW.finance_state <> 'aplicado' OR NEW.finance_result IS NOT OLD.finance_result)) BEGIN SELECT RAISE(ABORT, '40001:nfe_return_immutable'); END`,
    `CREATE TRIGGER "${C_RETURN}_immutable_delete" BEFORE DELETE ON "${C_RETURN}" BEGIN SELECT RAISE(ABORT, '40001:com1_history_immutable'); END`,
  ]),
];
/** Versão 20: campos próprios de contato (definição, valor por contato e o
 * registro das alterações, inclusive quando o administrador libera um campo
 * sensível). Tabelas novas porque o CHECK module='products' de
 * erp_catalog.custom_field não se reescreve (migração só aditiva). */
const CF_FIELD = "erp_catalog__contact_field", CF_VALUE = "erp_catalog__contact_field_value", CF_AUDIT = "erp_catalog__contact_field_audit";
// Padrão GLOB curto: o SQLite do objeto recusa padrão longo ("pattern too complex").
const CF_UUID = (c: string) => `(length(${c}) = 36 AND ${c} NOT GLOB '*[^0-9a-f-]*' AND substr(${c},9,1) = '-' AND substr(${c},14,1) = '-' AND substr(${c},19,1) = '-' AND substr(${c},24,1) = '-')`;
const CF_BOOL = (c: string) => `"${c}" INTEGER NOT NULL DEFAULT 0 CHECK ("${c}" IN (0,1))`;
const contactField = (table: string, ddl: readonly string[]): EngineTable => ({ table, ddl, since: 20, owner: "contato-campos", structural: "campos-contato" });
const CONTACT_FIELD_TABLES: readonly EngineTable[] = [
  contactField(CF_FIELD, [
    `CREATE TABLE "${CF_FIELD}" (
  "id" TEXT NOT NULL PRIMARY KEY CHECK (${CF_UUID("id")}),
  "name" TEXT NOT NULL,
  "name_key" TEXT NOT NULL,
  "field_type" TEXT NOT NULL,
  ${CF_BOOL("required")},
  "roles" TEXT NOT NULL CHECK (${JSON_OF("roles", "array")} AND json_array_length(roles) BETWEEN 1 AND 4),
  "options" TEXT NOT NULL DEFAULT '[]' CHECK (${JSON_OF("options", "array")} AND json_array_length(options) <= 50 AND length(CAST(options AS BLOB)) <= 16384),
  ${CF_BOOL("sensitive")},
  ${CF_BOOL("exposed")},
  "exposed_at" INTEGER,
  "exposed_by" TEXT,
  ${CF_BOOL("list_column")},
  ${CF_BOOL("list_filter")},
  "position" INTEGER NOT NULL CHECK (position BETWEEN 1 AND 100000),
  "active" INTEGER NOT NULL DEFAULT 1 CHECK ("active" IN (0,1)),
  "version" INTEGER NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 2147483647),
  "created_by" TEXT NOT NULL,
  "updated_by" TEXT NOT NULL,
  "created_at" INTEGER NOT NULL,
  "updated_at" INTEGER NOT NULL,
  CONSTRAINT "${CF_FIELD}_name_check" CHECK (length(name) BETWEEN 1 AND 60 AND name = trim(name)),
  CONSTRAINT "${CF_FIELD}_name_key_key" UNIQUE ("name_key"),
  CONSTRAINT "${CF_FIELD}_field_type_check" CHECK (field_type IN ('text', 'number', 'date', 'list', 'boolean')),
  CONSTRAINT "${CF_FIELD}_options_check" CHECK ((field_type = 'list') = (json_array_length(options) >= 1)),
  CONSTRAINT "${CF_FIELD}_exposed_check" CHECK ((exposed = 0 OR sensitive = 1) AND ((exposed = 1) = (exposed_at IS NOT NULL AND exposed_by IS NOT NULL)))
) STRICT`,
  ]),
  contactField(CF_VALUE, [
    `CREATE TABLE "${CF_VALUE}" (
  "contact_id" TEXT NOT NULL,
  "field_id" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "updated_by" TEXT NOT NULL,
  "updated_at" INTEGER NOT NULL,
  PRIMARY KEY ("contact_id", "field_id"),
  CONSTRAINT "${CF_VALUE}_value_check" CHECK (length(value) BETWEEN 1 AND 255),
  CONSTRAINT "${CF_VALUE}_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "erp_catalog__contact" ("record_id"),
  CONSTRAINT "${CF_VALUE}_field_id_fkey" FOREIGN KEY ("field_id") REFERENCES "${CF_FIELD}" ("id")
) STRICT`,
    `CREATE INDEX "${CF_VALUE}_field_value" ON "${CF_VALUE}"("field_id", "value")`,
  ]),
  contactField(CF_AUDIT, [
    `CREATE TABLE "${CF_AUDIT}" (
  "id" INTEGER PRIMARY KEY,
  "field_id" TEXT,
  "contact_id" TEXT,
  "actor" TEXT NOT NULL,
  "command_id" TEXT,
  "action" TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'expose', 'unexpose', 'values')),
  "before_data" TEXT CHECK (before_data IS NULL OR (json_valid(before_data) AND length(CAST(before_data AS BLOB)) <= 65536)),
  "after_data" TEXT CHECK (after_data IS NULL OR (json_valid(after_data) AND length(CAST(after_data AS BLOB)) <= 65536)),
  "created_at" INTEGER NOT NULL
) STRICT`,
    `CREATE INDEX "${CF_AUDIT}_field" ON "${CF_AUDIT}"("field_id", "id")`,
    `CREATE TRIGGER "${CF_AUDIT}_immutable_update" BEFORE UPDATE ON "${CF_AUDIT}" BEGIN SELECT RAISE(ABORT, '55000:erp_contact_field_audit_immutable'); END`,
    `CREATE TRIGGER "${CF_AUDIT}_immutable_delete" BEFORE DELETE ON "${CF_AUDIT}" BEGIN SELECT RAISE(ABORT, '55000:erp_contact_field_audit_immutable'); END`,
  ]),
];
/** Categoria de despesa (do primeiro nível) que entra em Custos no DRE gerencial:
 * o grupo de DRE gravado nela continua Despesas Operacionais (o CHECK do
 * oráculo não tem custos); esta linha só a separa no DRE. */
const C_DRE_COST = "erp_finance__dre_cost";
/** Pagamento da equipe: a conta a pagar (salário, comissão, adiantamento ou
 * vale) e a pessoa dela (funcionário do cadastro ou vendedor), com o período a
 * que se refere e, na comissão, a base e o percentual conferidos. */
const C_TEAM_PAYMENT = "erp_finance__team_payment";
const DATE10 = (c: string) => `${c} GLOB '${DIGITS(4)}-${DIGITS(2)}-${DIGITS(2)}'`;
const REPORT_TABLES: readonly EngineTable[] = [
  {
    table: C_DRE_COST,
    ddl: [
      `CREATE TABLE "${C_DRE_COST}" (
  "category_id" TEXT NOT NULL PRIMARY KEY,
  "actor" TEXT NOT NULL,
  "updated_at" INTEGER NOT NULL,
  CONSTRAINT "${C_DRE_COST}_category_fkey" FOREIGN KEY (category_id) REFERENCES "erp_finance__category" (id)
) STRICT`,
    ],
    since: 21, owner: "erp-relatorios", structural: "relatorios-dre-equipe",
  },
  {
    table: C_TEAM_PAYMENT,
    ddl: [
      `CREATE TABLE "${C_TEAM_PAYMENT}" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "title_id" TEXT NOT NULL,
  "person_kind" TEXT NOT NULL,
  "employee_id" TEXT,
  "seller_id" TEXT,
  "pay_kind" TEXT NOT NULL,
  "period_from" TEXT NOT NULL,
  "period_to" TEXT NOT NULL,
  "base_cents" INTEGER,
  "rate" TEXT,
  "actor" TEXT NOT NULL,
  "command_id" TEXT NOT NULL,
  "created_at" INTEGER NOT NULL,
  CONSTRAINT "${C_TEAM_PAYMENT}_title_key" UNIQUE (title_id),
  CONSTRAINT "${C_TEAM_PAYMENT}_title_fkey" FOREIGN KEY (title_id) REFERENCES "erp_finance__title" (id),
  CONSTRAINT "${C_TEAM_PAYMENT}_employee_fkey" FOREIGN KEY (employee_id) REFERENCES "erp_catalog__employee" (id),
  CONSTRAINT "${C_TEAM_PAYMENT}_seller_fkey" FOREIGN KEY (seller_id) REFERENCES "erp_catalog__seller" (id),
  CONSTRAINT "${C_TEAM_PAYMENT}_person_check" CHECK ((person_kind = 'employee' AND employee_id IS NOT NULL AND seller_id IS NULL) OR (person_kind = 'seller' AND seller_id IS NOT NULL AND employee_id IS NULL)),
  CONSTRAINT "${C_TEAM_PAYMENT}_pay_kind_check" CHECK (pay_kind IN ('salario','comissao','adiantamento','vale') AND (pay_kind <> 'comissao' OR person_kind = 'seller')),
  CONSTRAINT "${C_TEAM_PAYMENT}_period_check" CHECK (${DATE10("period_from")} AND ${DATE10("period_to")} AND period_from <= period_to),
  CONSTRAINT "${C_TEAM_PAYMENT}_base_check" CHECK ((base_cents IS NULL OR base_cents >= 0) AND (rate IS NULL OR rate GLOB '[0-9]*.[0-9][0-9][0-9][0-9]'))
) STRICT`,
      `CREATE INDEX "${C_TEAM_PAYMENT}_period_idx" ON "${C_TEAM_PAYMENT}" (period_from, period_to)`,
    ],
    since: 21, owner: "erp-relatorios", structural: "relatorios-dre-equipe",
  },
];
/** Versão 22: o pacote do contador (src/erp/contador/package.ts). Um pacote por
 * ambiente e período (o id vem deles), montado aos poucos no alarme; cada
 * parte registra os arquivos que gravou no R2 e as linhas da planilha. */
const C_CONTADOR_PACKAGE = "erp_contador__package";
const C_CONTADOR_PART = "erp_contador__part";
const contador = (table: string, ddl: readonly string[]): EngineTable => ({ table, ddl, since: 22, owner: "contador-xml", structural: "contador-pacote" });
const CONTADOR_TABLES: readonly EngineTable[] = [
  contador(C_CONTADOR_PACKAGE, [
    `CREATE TABLE "${C_CONTADOR_PACKAGE}" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "environment" TEXT NOT NULL,
  "period_from" TEXT NOT NULL,
  "period_to" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "run" TEXT NOT NULL,
  "phase" TEXT NOT NULL,
  "cursor" TEXT NOT NULL DEFAULT '{}' CHECK (${JSON_OF("cursor", "object")}),
  "counts" TEXT NOT NULL DEFAULT '{}' CHECK (${JSON_OF("counts", "object")}),
  ${ARRAY("warnings")},
  "zip_offset" INTEGER NOT NULL DEFAULT 0,
  "parts" INTEGER NOT NULL DEFAULT 0,
  "entries" INTEGER NOT NULL DEFAULT 0,
  "bytes" INTEGER NOT NULL DEFAULT 0,
  "filename" TEXT,
  "error" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "retry_at" INTEGER NOT NULL DEFAULT 0,
  ${ARRAY("stale")},
  "requested_by" TEXT,
  "created_at" INTEGER NOT NULL,
  "updated_at" INTEGER NOT NULL,
  "finished_at" INTEGER,
  CONSTRAINT "${C_CONTADOR_PACKAGE}_id_check" CHECK (length(id) = 16 AND id NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT "${C_CONTADOR_PACKAGE}_environment_check" CHECK (environment IN ('producao', 'homologacao')),
  CONSTRAINT "${C_CONTADOR_PACKAGE}_period_check" CHECK (period_from GLOB '${DIGITS(4)}-${DIGITS(2)}-${DIGITS(2)}' AND period_to GLOB '${DIGITS(4)}-${DIGITS(2)}-${DIGITS(2)}' AND period_from <= period_to),
  CONSTRAINT "${C_CONTADOR_PACKAGE}_state_check" CHECK (state IN ('running', 'done', 'failed')),
  CONSTRAINT "${C_CONTADOR_PACKAGE}_phase_check" CHECK (phase IN ('emitidas', 'inutilizacoes', 'recebidas', 'bling', 'fechamento')),
  CONSTRAINT "${C_CONTADOR_PACKAGE}_sizes_check" CHECK (zip_offset >= 0 AND parts >= 0 AND entries BETWEEN 0 AND 65535 AND bytes >= 0 AND attempts >= 0),
  CONSTRAINT "${C_CONTADOR_PACKAGE}_text_check" CHECK ((error IS NULL OR length(error) <= 500) AND (filename IS NULL OR length(filename) <= 120) AND length(CAST(stale AS BLOB)) <= 131072)
) STRICT`,
    `CREATE INDEX "${C_CONTADOR_PACKAGE}_running" ON "${C_CONTADOR_PACKAGE}" (state, retry_at)`,
  ]),
  contador(C_CONTADOR_PART, [
    `CREATE TABLE "${C_CONTADOR_PART}" (
  "package_id" TEXT NOT NULL,
  "run" TEXT NOT NULL,
  "seq" INTEGER NOT NULL,
  "object_key" TEXT,
  "size" INTEGER NOT NULL,
  ${ARRAY("entries")},
  ${ARRAY("rows")},
  "created_at" INTEGER NOT NULL,
  CONSTRAINT "${C_CONTADOR_PART}_pkey" PRIMARY KEY (package_id, run, seq),
  CONSTRAINT "${C_CONTADOR_PART}_seq_check" CHECK (seq >= 1 AND size >= 0 AND (object_key IS NULL OR length(object_key) <= 300)),
  CONSTRAINT "${C_CONTADOR_PART}_package_fkey" FOREIGN KEY (package_id) REFERENCES "${C_CONTADOR_PACKAGE}" (id)
) STRICT`,
  ]),
];

/** Ordem de produção (parte Produção, src/erp/domains/production): a ordem, a
 * lista de insumos dela (vinda da composição e editável), os apontamentos
 * (conclusão total ou parcial, com os dois lançamentos do Estoque: a saída dos
 * insumos e a entrada do acabado com o custo) e os comandos (repetição segura).
 * Quantidades em texto na escala 6; custos em texto na escala 10. */
const P_ORDER = "erp_production__order";
const P_INPUT = "erp_production__order_input";
const P_COMPLETION = "erp_production__completion";
const P_COMPLETION_INPUT = "erp_production__completion_input";
const P_COMMAND = "erp_production__command";
const QTY6 = (c: string) => `(${c} GLOB '[0-9]*.${DIGITS(6)}' AND ${c} NOT GLOB '*[^0-9.]*')`;
const DEC10 = (c: string) => `(${c} GLOB '[0-9]*.${DIGITS(10)}' AND ${c} NOT GLOB '*[^0-9.]*')`;
const PRODUCTION_TABLES: readonly EngineTable[] = [
  {
    table: P_ORDER,
    ddl: [
      `CREATE TABLE "${P_ORDER}" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "number" INTEGER NOT NULL,
  "product_id" TEXT NOT NULL,
  "quantity" TEXT NOT NULL,
  "produced" TEXT NOT NULL DEFAULT '0.000000',
  "unit" TEXT,
  "source_warehouse_id" TEXT NOT NULL,
  "target_warehouse_id" TEXT NOT NULL,
  "planned_on" TEXT,
  "responsible" TEXT,
  "notes" TEXT,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "origin" TEXT NOT NULL DEFAULT 'manual',
  "sales_order_ids" TEXT NOT NULL DEFAULT '[]',
  "cancel_reason" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" INTEGER NOT NULL,
  "created_by" TEXT NOT NULL,
  "updated_at" INTEGER NOT NULL,
  "updated_by" TEXT NOT NULL,
  CONSTRAINT "${P_ORDER}_number_key" UNIQUE (number),
  CONSTRAINT "${P_ORDER}_product_fkey" FOREIGN KEY (product_id) REFERENCES "erp_catalog__record" (id),
  CONSTRAINT "${P_ORDER}_source_fkey" FOREIGN KEY (source_warehouse_id) REFERENCES "erp_catalog__record" (id),
  CONSTRAINT "${P_ORDER}_target_fkey" FOREIGN KEY (target_warehouse_id) REFERENCES "erp_catalog__record" (id),
  CONSTRAINT "${P_ORDER}_status_check" CHECK (status IN ('draft','released','in_progress','done','cancelled')),
  CONSTRAINT "${P_ORDER}_origin_check" CHECK (origin IN ('manual','plan')),
  CONSTRAINT "${P_ORDER}_quantity_check" CHECK (${QTY6("quantity")} AND ${QTY6("produced")}),
  CONSTRAINT "${P_ORDER}_planned_check" CHECK (planned_on IS NULL OR ${DATE10("planned_on")}),
  CONSTRAINT "${P_ORDER}_sales_check" CHECK (${JSON_OF("sales_order_ids", "array")}),
  CONSTRAINT "${P_ORDER}_number_check" CHECK (number > 0 AND version > 0)
) STRICT`,
      `CREATE INDEX "${P_ORDER}_status_idx" ON "${P_ORDER}" (status, planned_on)`,
      `CREATE INDEX "${P_ORDER}_product_idx" ON "${P_ORDER}" (product_id)`,
    ],
    since: 23, owner: "producao", structural: "ordem-producao",
  },
  {
    table: P_INPUT,
    ddl: [
      `CREATE TABLE "${P_INPUT}" (
  "order_id" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "product_id" TEXT NOT NULL,
  "per_unit" TEXT NOT NULL,
  "loss_percent" TEXT NOT NULL DEFAULT '0.000000',
  "from_composition" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "${P_INPUT}_pkey" PRIMARY KEY (order_id, position),
  CONSTRAINT "${P_INPUT}_product_key" UNIQUE (order_id, product_id),
  CONSTRAINT "${P_INPUT}_order_fkey" FOREIGN KEY (order_id) REFERENCES "${P_ORDER}" (id),
  CONSTRAINT "${P_INPUT}_product_fkey" FOREIGN KEY (product_id) REFERENCES "erp_catalog__record" (id),
  CONSTRAINT "${P_INPUT}_quantity_check" CHECK (${QTY6("per_unit")} AND ${QTY6("loss_percent")} AND position > 0 AND from_composition IN (0,1))
) STRICT`,
    ],
    since: 23, owner: "producao", structural: "ordem-producao",
  },
  {
    table: P_COMPLETION,
    ddl: [
      `CREATE TABLE "${P_COMPLETION}" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "order_id" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "quantity" TEXT NOT NULL,
  "occurred_on" TEXT NOT NULL,
  "lot_id" TEXT,
  "inputs_cost" TEXT NOT NULL,
  "extra_cost" TEXT NOT NULL,
  "unit_cost" TEXT NOT NULL,
  "note" TEXT,
  "issue_movement_id" TEXT,
  "receipt_movement_id" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'active',
  "reversed_at" INTEGER,
  "reversed_by" TEXT,
  "reverse_reason" TEXT,
  "actor" TEXT NOT NULL,
  "command_id" TEXT NOT NULL,
  "created_at" INTEGER NOT NULL,
  CONSTRAINT "${P_COMPLETION}_position_key" UNIQUE (order_id, position),
  CONSTRAINT "${P_COMPLETION}_command_key" UNIQUE (command_id),
  CONSTRAINT "${P_COMPLETION}_order_fkey" FOREIGN KEY (order_id) REFERENCES "${P_ORDER}" (id),
  CONSTRAINT "${P_COMPLETION}_issue_fkey" FOREIGN KEY (issue_movement_id) REFERENCES "erp_stock__movement" (id),
  CONSTRAINT "${P_COMPLETION}_receipt_fkey" FOREIGN KEY (receipt_movement_id) REFERENCES "erp_stock__movement" (id),
  CONSTRAINT "${P_COMPLETION}_lot_fkey" FOREIGN KEY (lot_id) REFERENCES "erp_stock__lot" (id),
  CONSTRAINT "${P_COMPLETION}_state_check" CHECK ((state = 'active' AND reversed_at IS NULL) OR (state = 'reversed' AND reversed_at IS NOT NULL AND reverse_reason IS NOT NULL)),
  CONSTRAINT "${P_COMPLETION}_value_check" CHECK (${QTY6("quantity")} AND ${DEC10("inputs_cost")} AND ${DEC10("extra_cost")} AND ${DEC10("unit_cost")} AND ${DATE10("occurred_on")})
) STRICT`,
    ],
    since: 23, owner: "producao", structural: "ordem-producao",
  },
  {
    table: P_COMPLETION_INPUT,
    ddl: [
      `CREATE TABLE "${P_COMPLETION_INPUT}" (
  "completion_id" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "product_id" TEXT NOT NULL,
  "quantity" TEXT NOT NULL,
  "unit_cost" TEXT,
  "total_cost" TEXT NOT NULL,
  CONSTRAINT "${P_COMPLETION_INPUT}_pkey" PRIMARY KEY (completion_id, position),
  CONSTRAINT "${P_COMPLETION_INPUT}_completion_fkey" FOREIGN KEY (completion_id) REFERENCES "${P_COMPLETION}" (id),
  CONSTRAINT "${P_COMPLETION_INPUT}_product_fkey" FOREIGN KEY (product_id) REFERENCES "erp_catalog__record" (id),
  CONSTRAINT "${P_COMPLETION_INPUT}_value_check" CHECK (${QTY6("quantity")} AND (unit_cost IS NULL OR ${DEC10("unit_cost")}) AND ${DEC10("total_cost")})
) STRICT`,
    ],
    since: 23, owner: "producao", structural: "ordem-producao",
  },
  {
    table: P_COMMAND,
    ddl: [
      `CREATE TABLE "${P_COMMAND}" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "actor" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "result" TEXT NOT NULL,
  "created_at" INTEGER NOT NULL,
  CONSTRAINT "${P_COMMAND}_result_check" CHECK (json_valid(result))
) STRICT`,
    ],
    since: 23, owner: "producao", structural: "ordem-producao",
  },
];
/** Versão 25: Expedição (src/erp/domains/shipping/). A situação do pedido na
 * expedição (a separar, em separação, separado, embalado, expedido) fica aqui,
 * sem tocar na situação comercial do pedido; a lista de separação junta os
 * itens de vários pedidos; a diferença de quantidade vira pendência (e uma
 * ocorrência no pedido); os volumes guardam embalagem, medidas e pesos; a
 * devolução física registra o que voltou e o movimento de entrada no estoque.
 * Medidas em milímetros e pesos em gramas (INTEGER); quantidades na escala 6
 * dos itens do pedido. */
const S_PACKAGE = "erp_shipping__package", S_ORDER = "erp_shipping__order", S_LIST = "erp_shipping__pick_list", S_LINE = "erp_shipping__pick_line";
const S_PENDING = "erp_shipping__pending", S_VOLUME = "erp_shipping__volume", S_RETURN = "erp_shipping__return", S_COMMAND = "erp_shipping__command";
const S_MM = (c: string) => `"${c}" INTEGER CHECK ("${c}" IS NULL OR "${c}" BETWEEN 1 AND 100000)`;
const S_GRAMS = (c: string) => `"${c}" INTEGER CHECK ("${c}" IS NULL OR "${c}" BETWEEN 0 AND 100000000)`;
const S_QTY = (c: string) => `"${c}" INTEGER NOT NULL DEFAULT 0 CHECK ("${c}" BETWEEN 0 AND 999999999999000000)`;
const shipping = (table: string, ddl: readonly string[]): EngineTable => ({ table, ddl, since: 25, owner: "logistica", structural: "expedicao" });
const SHIPPING_TABLES: readonly EngineTable[] = [
  shipping(S_PACKAGE, [
    `CREATE TABLE "${S_PACKAGE}" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  ${S_MM("length_mm")},
  ${S_MM("width_mm")},
  ${S_MM("height_mm")},
  ${S_GRAMS("empty_weight_g")},
  "active" INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  "version" INTEGER NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 2147483647),
  "created_by" TEXT NOT NULL,
  "updated_by" TEXT NOT NULL,
  "created_at" INTEGER NOT NULL,
  "updated_at" INTEGER NOT NULL
) STRICT`,
  ]),
  shipping(S_LIST, [
    `CREATE TABLE "${S_LIST}" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "number" INTEGER NOT NULL UNIQUE CHECK (number BETWEEN 1 AND 2147483647),
  "status" TEXT NOT NULL CHECK (status IN ('open','done','cancelled')),
  "filters" TEXT NOT NULL DEFAULT '{}' CHECK (${JSON_OF("filters", "object")} AND length(CAST(filters AS BLOB)) <= 4096),
  "version" INTEGER NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 2147483647),
  "created_by" TEXT NOT NULL,
  "created_at" INTEGER NOT NULL,
  "finished_by" TEXT,
  "finished_at" INTEGER,
  CONSTRAINT "${S_LIST}_finished_check" CHECK ((status = 'open') = (finished_at IS NULL))
) STRICT`,
  ]),
  shipping(S_ORDER, [
    `CREATE TABLE "${S_ORDER}" (
  "document_id" TEXT NOT NULL PRIMARY KEY,
  "status" TEXT NOT NULL CHECK (status IN ('to_pick','picking','picked','packed','shipped')),
  "pick_list_id" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 2147483647),
  "tracking_code" TEXT CHECK (tracking_code IS NULL OR length(tracking_code) BETWEEN 1 AND 200),
  "transport_at" INTEGER,
  "shipped_by" TEXT,
  "shipped_at" INTEGER,
  "delivery_id" TEXT CHECK (delivery_id IS NULL OR length(delivery_id) BETWEEN 1 AND 100),
  "delivery_at" INTEGER,
  "updated_by" TEXT NOT NULL,
  "created_at" INTEGER NOT NULL,
  "updated_at" INTEGER NOT NULL,
  CONSTRAINT "${S_ORDER}_shipped_check" CHECK ((status = 'shipped') = (shipped_at IS NOT NULL)),
  CONSTRAINT "${S_ORDER}_document_fkey" FOREIGN KEY (document_id) REFERENCES "erp_documents__document" (id),
  CONSTRAINT "${S_ORDER}_list_fkey" FOREIGN KEY (pick_list_id) REFERENCES "${S_LIST}" (id)
) STRICT`,
  ]),
  shipping(S_LINE, [
    `CREATE TABLE "${S_LINE}" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "pick_list_id" TEXT NOT NULL,
  "document_id" TEXT NOT NULL,
  "line_key" TEXT NOT NULL CHECK (length(line_key) BETWEEN 1 AND 100),
  "position" INTEGER NOT NULL CHECK (position BETWEEN 1 AND 250),
  "product_id" TEXT,
  "warehouse_id" TEXT,
  "location" TEXT CHECK (location IS NULL OR length(location) <= 100),
  "description" TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 200),
  "code" TEXT CHECK (code IS NULL OR length(code) <= 100),
  "gtin" TEXT CHECK (gtin IS NULL OR length(gtin) <= 14),
  "unit" TEXT CHECK (unit IS NULL OR length(unit) <= 16),
  ${S_QTY("quantity")},
  ${S_QTY("picked")},
  "updated_by" TEXT,
  "updated_at" INTEGER,
  CONSTRAINT "${S_LINE}_line_key" UNIQUE (pick_list_id, document_id, line_key),
  CONSTRAINT "${S_LINE}_list_fkey" FOREIGN KEY (pick_list_id) REFERENCES "${S_LIST}" (id),
  CONSTRAINT "${S_LINE}_document_fkey" FOREIGN KEY (document_id) REFERENCES "erp_documents__document" (id)
) STRICT`,
    `CREATE INDEX "${S_LINE}_document_idx" ON "${S_LINE}" (document_id)`,
  ]),
  shipping(S_PENDING, [
    `CREATE TABLE "${S_PENDING}" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "document_id" TEXT NOT NULL,
  "pick_list_id" TEXT NOT NULL,
  "line_key" TEXT NOT NULL CHECK (length(line_key) BETWEEN 1 AND 100),
  "product_id" TEXT,
  "description" TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 200),
  ${S_QTY("quantity")},
  ${S_QTY("picked")},
  "status" TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  "note" TEXT CHECK (note IS NULL OR length(note) <= 500),
  "created_by" TEXT NOT NULL,
  "created_at" INTEGER NOT NULL,
  "resolved_by" TEXT,
  "resolved_at" INTEGER,
  CONSTRAINT "${S_PENDING}_missing_check" CHECK (picked < quantity),
  CONSTRAINT "${S_PENDING}_resolved_check" CHECK ((status = 'resolved') = (resolved_at IS NOT NULL)),
  CONSTRAINT "${S_PENDING}_line_key" UNIQUE (pick_list_id, document_id, line_key),
  CONSTRAINT "${S_PENDING}_document_fkey" FOREIGN KEY (document_id) REFERENCES "erp_documents__document" (id),
  CONSTRAINT "${S_PENDING}_list_fkey" FOREIGN KEY (pick_list_id) REFERENCES "${S_LIST}" (id)
) STRICT`,
    `CREATE INDEX "${S_PENDING}_document_idx" ON "${S_PENDING}" (document_id, status)`,
  ]),
  shipping(S_VOLUME, [
    `CREATE TABLE "${S_VOLUME}" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "document_id" TEXT NOT NULL,
  "number" INTEGER NOT NULL CHECK (number BETWEEN 1 AND 999),
  "package_id" TEXT,
  ${S_MM("length_mm")},
  ${S_MM("width_mm")},
  ${S_MM("height_mm")},
  ${S_GRAMS("net_weight_g")},
  ${S_GRAMS("gross_weight_g")},
  "items" TEXT NOT NULL DEFAULT '[]' CHECK (${JSON_OF("items", "array")} AND length(CAST(items AS BLOB)) <= 65536),
  "created_by" TEXT NOT NULL,
  "created_at" INTEGER NOT NULL,
  CONSTRAINT "${S_VOLUME}_number_key" UNIQUE (document_id, number),
  CONSTRAINT "${S_VOLUME}_document_fkey" FOREIGN KEY (document_id) REFERENCES "erp_documents__document" (id),
  CONSTRAINT "${S_VOLUME}_package_fkey" FOREIGN KEY (package_id) REFERENCES "${S_PACKAGE}" (id)
) STRICT`,
  ]),
  shipping(S_RETURN, [
    `CREATE TABLE "${S_RETURN}" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "number" INTEGER NOT NULL UNIQUE CHECK (number BETWEEN 1 AND 2147483647),
  "document_id" TEXT NOT NULL,
  "reason" TEXT NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  "warehouse_id" TEXT,
  "items" TEXT NOT NULL CHECK (${JSON_OF("items", "array")} AND json_array_length(items) BETWEEN 1 AND 250 AND length(CAST(items AS BLOB)) <= 65536),
  "movement_id" TEXT,
  "command_id" TEXT NOT NULL UNIQUE,
  "created_by" TEXT NOT NULL,
  "created_at" INTEGER NOT NULL,
  CONSTRAINT "${S_RETURN}_document_fkey" FOREIGN KEY (document_id) REFERENCES "erp_documents__document" (id)
) STRICT`,
    `CREATE INDEX "${S_RETURN}_document_idx" ON "${S_RETURN}" (document_id, created_at)`,
  ]),
  shipping(S_COMMAND, [
    `CREATE TABLE "${S_COMMAND}" (
  "command_id" TEXT NOT NULL PRIMARY KEY,
  "actor" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL CHECK (${HEX64("request_hash")}),
  "result" TEXT NOT NULL CHECK (${JSON_OF("result", "object")}),
  "created_at" INTEGER NOT NULL
) STRICT`,
  ]),
];
/** Versão 26: o cálculo da reforma tributária (IBS, CBS e IS). A configuração
 * da empresa (opção do Simples pelo regime regular e alíquotas informadas
 * para os anos ainda não publicados) e o Imposto Seletivo do produto. A
 * classificação de IBS/CBS continua nas tabelas da versão 7. */
const R_SETTINGS = "erp_fiscal_reform__settings", R_SELECTIVE = "erp_fiscal_reform__product_selective";
const reformCalc = (table: string, ddl: readonly string[]): EngineTable => ({ table, ddl, since: 26, owner: "reforma-tributaria", structural: "reforma-calculo" });
const REFORM_CALC_TABLES: readonly EngineTable[] = [
  reformCalc(R_SETTINGS, [
    `CREATE TABLE "${R_SETTINGS}" (
  "id" INTEGER NOT NULL PRIMARY KEY DEFAULT 1,
  "version" INTEGER NOT NULL DEFAULT 1,
  "simples_regular" INTEGER NOT NULL DEFAULT 0,
  "rates" TEXT NOT NULL DEFAULT '{}',
  "updated_by" TEXT NOT NULL,
  "updated_at" INTEGER NOT NULL,
  CONSTRAINT "${R_SETTINGS}_singleton_check" CHECK (id = 1),
  CONSTRAINT "${R_SETTINGS}_version_check" CHECK (version BETWEEN 1 AND 2147483647),
  CONSTRAINT "${R_SETTINGS}_simples_regular_check" CHECK (simples_regular IN (0,1)),
  CONSTRAINT "${R_SETTINGS}_rates_check" CHECK (${JSON_OF("rates", "object")} AND length(CAST(rates AS BLOB)) <= 4096)
) STRICT`,
  ]),
  reformCalc(R_SELECTIVE, [
    `CREATE TABLE "${R_SELECTIVE}" (
  "product_id" TEXT NOT NULL PRIMARY KEY,
  "cst" TEXT NOT NULL,
  "cclasstrib" TEXT NOT NULL,
  "rate" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "updated_by" TEXT NOT NULL,
  "updated_at" INTEGER NOT NULL,
  CONSTRAINT "${R_SELECTIVE}_cst_check" CHECK ((cst GLOB '${DIGITS(3)}')),
  CONSTRAINT "${R_SELECTIVE}_cclasstrib_check" CHECK ((cclasstrib GLOB '${DIGITS(6)}')),
  CONSTRAINT "${R_SELECTIVE}_rate_check" CHECK (length(rate) BETWEEN 1 AND 8 AND rate NOT GLOB '*[^0-9.]*'),
  CONSTRAINT "${R_SELECTIVE}_version_check" CHECK ((("version" >= 1) AND ("version" <= 2147483647))),
  CONSTRAINT "${R_SELECTIVE}_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "erp_catalog__product" ("record_id")
) STRICT`,
  ]),
];
// Lojas e filiais da mesma empresa (versão 27; a 26 é de outra frente): o
// cadastro das lojas e os vínculos (depósito, conta financeira ou caixa,
// documento e conta a pagar ou receber), a restrição da pessoa e a loja em uso.
// Nada nas tabelas antigas muda: sem vínculo, o registro é da loja principal.
const ST_STORE = "erp_store__store", ST_WAREHOUSE = "erp_store__warehouse", ST_ACCOUNT = "erp_store__account", ST_DOCUMENT = "erp_store__document";
const ST_TITLE = "erp_store__title", ST_PERSON = "erp_store__person", ST_SELECTION = "erp_store__selection", ST_COMMAND = "erp_store__command", ST_AUDIT = "erp_store__audit";
const store = (table: string, ddl: readonly string[]): EngineTable => ({ table, ddl, since: 27, owner: "multiloja", structural: "lojas" });
const STORE_UUID = (c: string) => `(length(${c}) = 36 AND ${c} = lower(${c}))`;
const storeLink = (table: string, key: string, extra = "") => store(table, [
  `CREATE TABLE "${table}" (
  "${key}" TEXT NOT NULL PRIMARY KEY CHECK (${STORE_UUID(key)}),
  "store_id" TEXT NOT NULL,${extra}
  "updated_by" TEXT NOT NULL,
  "updated_at" INTEGER NOT NULL,
  CONSTRAINT "${table}_store_fkey" FOREIGN KEY (store_id) REFERENCES "${ST_STORE}" (id)
) STRICT`,
  `CREATE INDEX "${table}_store_idx" ON "${table}" (store_id)`,
]);
const STORE_TABLES: readonly EngineTable[] = [
  store(ST_STORE, [
    `CREATE TABLE "${ST_STORE}" (
  "id" TEXT NOT NULL PRIMARY KEY CHECK (${STORE_UUID("id")}),
  "name" TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80 AND name = trim(name)),
  "is_main" INTEGER NOT NULL DEFAULT 0 CHECK (is_main IN (0,1)),
  "active" INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  "address" TEXT NOT NULL DEFAULT '{}' CHECK (${JSON_OF("address", "object")} AND length(CAST(address AS BLOB)) <= 4096),
  "phone" TEXT CHECK (phone IS NULL OR (length(phone) BETWEEN 8 AND 20 AND phone NOT GLOB '*[^0-9]*')),
  "cnpj" TEXT CHECK (cnpj IS NULL OR (length(cnpj) = 14 AND cnpj NOT GLOB '*[^0-9A-Z]*')),
  "default_warehouse_id" TEXT,
  "fiscal_series" INTEGER CHECK (fiscal_series IS NULL OR fiscal_series BETWEEN 0 AND 999),
  "version" INTEGER NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 2147483647),
  "created_at" INTEGER NOT NULL,
  "updated_at" INTEGER NOT NULL,
  "updated_by" TEXT NOT NULL,
  CONSTRAINT "${ST_STORE}_main_active_check" CHECK (is_main = 0 OR active = 1)
) STRICT`,
    `CREATE UNIQUE INDEX "${ST_STORE}_main_key" ON "${ST_STORE}" (is_main) WHERE is_main = 1`,
    `CREATE UNIQUE INDEX "${ST_STORE}_name_key" ON "${ST_STORE}" (lower(name))`,
  ]),
  storeLink(ST_WAREHOUSE, "warehouse_id"),
  storeLink(ST_ACCOUNT, "account_id"),
  storeLink(ST_DOCUMENT, "document_id", `
  "source" TEXT NOT NULL CHECK (source IN ('chosen','default','warehouse','account')),`),
  storeLink(ST_TITLE, "title_id", `
  "source" TEXT NOT NULL CHECK (source IN ('chosen','default','document','account')),`),
  store(ST_PERSON, [
    `CREATE TABLE "${ST_PERSON}" (
  "user_id" TEXT NOT NULL CHECK (${STORE_UUID("user_id")}),
  "store_id" TEXT NOT NULL,
  "updated_by" TEXT NOT NULL,
  "updated_at" INTEGER NOT NULL,
  PRIMARY KEY (user_id, store_id),
  CONSTRAINT "${ST_PERSON}_store_fkey" FOREIGN KEY (store_id) REFERENCES "${ST_STORE}" (id)
) STRICT`,
  ]),
  store(ST_SELECTION, [
    `CREATE TABLE "${ST_SELECTION}" (
  "user_id" TEXT NOT NULL PRIMARY KEY CHECK (${STORE_UUID("user_id")}),
  "store_id" TEXT,
  "updated_at" INTEGER NOT NULL,
  CONSTRAINT "${ST_SELECTION}_store_fkey" FOREIGN KEY (store_id) REFERENCES "${ST_STORE}" (id)
) STRICT`,
  ]),
  store(ST_COMMAND, [
    `CREATE TABLE "${ST_COMMAND}" (
  "command_id" TEXT NOT NULL PRIMARY KEY,
  "actor" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL CHECK (${HEX64("request_hash")}),
  "result" TEXT NOT NULL CHECK (${JSON_OF("result", "object")}),
  "created_at" INTEGER NOT NULL
) STRICT`,
  ]),
  store(ST_AUDIT, [
    `CREATE TABLE "${ST_AUDIT}" (
  "id" INTEGER PRIMARY KEY,
  "command_id" TEXT NOT NULL,
  "actor" TEXT NOT NULL,
  "action" TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 40),
  "target" TEXT NOT NULL,
  "before_data" TEXT CHECK (before_data IS NULL OR json_valid(before_data)),
  "after_data" TEXT CHECK (after_data IS NULL OR json_valid(after_data)),
  "created_at" INTEGER NOT NULL
) STRICT`,
    `CREATE INDEX "${ST_AUDIT}_target_idx" ON "${ST_AUDIT}" (target, created_at)`,
  ]),
];


// Versão 28: o tipo das importações por planilha que o CHECK de kind de
// erp_preferences__import_job (gerado) não aceita e não se reescreve: dados
// fiscais dos produtos, naturezas e regras fiscais e saldos iniciais das
// contas. O lote continua em import_job (com um tipo de apoio), import_row e
// import_command; esta linha diz o tipo real e vale sobre o de apoio.
const IMPORT_JOB_KIND = "erp_preferences__import_job_kind";
const IMPORT_TABLES: readonly EngineTable[] = [
  {
    table: IMPORT_JOB_KIND,
    ddl: [
      `CREATE TABLE "${IMPORT_JOB_KIND}" (
  "job_id" TEXT NOT NULL PRIMARY KEY,
  "kind" TEXT NOT NULL,
  "created_at" INTEGER NOT NULL,
  CONSTRAINT "${IMPORT_JOB_KIND}_kind_check" CHECK (kind IN ('product_taxes','natures','opening_balances')),
  CONSTRAINT "${IMPORT_JOB_KIND}_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "erp_preferences__import_job" ("id")
) STRICT`,
    ],
    since: 28, owner: "planilha-fiscal", structural: "importacao-fiscal",
  },
];
/** Versão 31: Contratos de serviço (parte Contratos; src/erp/domains/contracts/).
 * O contrato (cliente, objeto, vigência, periodicidade, vencimento, forma,
 * categoria, vendedor, reajuste e renovação), as linhas com validade (o
 * aditivo e o reajuste fecham as linhas de antes e abrem as novas a partir de
 * uma data), a fatura de cada período (uma só por período: a chave única
 * impede a repetição quando o alarme roda de novo) ligada à conta a receber do
 * Financeiro, o histórico, a tabela de índices que a pessoa mantém, os anexos
 * (o arquivo fica no R2 da área), os avisos (renovação e reajuste), o vínculo
 * com o contrato do Bling e os comandos. Valores em centavos; quantidades na
 * escala 6; percentuais na escala 4 (texto). */
const K_CONTRACT = "erp_contract__contract", K_ITEM = "erp_contract__item", K_INVOICE = "erp_contract__invoice", K_EVENT = "erp_contract__event";
const K_RATE = "erp_contract__index_rate", K_FILE = "erp_contract__attachment", K_NOTICE = "erp_contract__notice", K_BLING = "erp_contract__bling_link";
const K_COMMAND = "erp_contract__command";
const K_DATE = (c: string, nullable = false) => `(${nullable ? `${c} IS NULL OR ` : ""}${DATE10(c)})`;
const K_PCT = (c: string) => `((${c} GLOB '[0-9]*.${DIGITS(4)}' OR ${c} GLOB '-[0-9]*.${DIGITS(4)}') AND ${c} NOT GLOB '*[^0-9.-]*')`;
const K_CENTS = (c: string) => `(${c} BETWEEN 0 AND 99999999999)`;
const contract = (table: string, ddl: readonly string[]): EngineTable => ({ table, ddl, since: 31, owner: "contratos", structural: "contratos" });
const CONTRACT_TABLES: readonly EngineTable[] = [
  contract(K_CONTRACT, [
    `CREATE TABLE "${K_CONTRACT}" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "number" INTEGER NOT NULL,
  "contact_id" TEXT NOT NULL,
  "object" TEXT NOT NULL,
  "starts_on" TEXT NOT NULL,
  "ends_on" TEXT,
  "term_months" INTEGER,
  "periodicity" TEXT NOT NULL,
  "due_day" INTEGER NOT NULL,
  "payment_method_id" TEXT,
  "category_id" TEXT,
  "seller_id" TEXT,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "billing_enabled" INTEGER NOT NULL DEFAULT 0,
  "billing_send" INTEGER NOT NULL DEFAULT 0,
  "billing_nfse" INTEGER NOT NULL DEFAULT 0,
  "next_period_on" TEXT,
  "adjustment_index" TEXT,
  "adjustment_percent" TEXT,
  "adjustment_month" INTEGER,
  "adjustment_notify" INTEGER NOT NULL DEFAULT 0,
  "last_adjustment_month" TEXT,
  "renewal_notice_days" INTEGER NOT NULL DEFAULT 30,
  "renewal_noticed_for" TEXT,
  "ended_on" TEXT,
  "end_reason" TEXT,
  "notes" TEXT,
  "origin" TEXT NOT NULL DEFAULT 'manual',
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" INTEGER NOT NULL,
  "created_by" TEXT NOT NULL,
  "updated_at" INTEGER NOT NULL,
  "updated_by" TEXT NOT NULL,
  CONSTRAINT "${K_CONTRACT}_number_key" UNIQUE (number),
  CONSTRAINT "${K_CONTRACT}_contact_fkey" FOREIGN KEY (contact_id) REFERENCES "erp_catalog__record" (id),
  CONSTRAINT "${K_CONTRACT}_payment_fkey" FOREIGN KEY (payment_method_id) REFERENCES "erp_catalog__payment_method" (id),
  CONSTRAINT "${K_CONTRACT}_category_fkey" FOREIGN KEY (category_id) REFERENCES "erp_finance__category" (id),
  CONSTRAINT "${K_CONTRACT}_seller_fkey" FOREIGN KEY (seller_id) REFERENCES "erp_catalog__seller" (id),
  CONSTRAINT "${K_CONTRACT}_status_check" CHECK (status IN ('draft','active','suspended','ended')),
  CONSTRAINT "${K_CONTRACT}_periodicity_check" CHECK (periodicity IN ('monthly','bimonthly','quarterly','semiannual','annual')),
  CONSTRAINT "${K_CONTRACT}_origin_check" CHECK (origin IN ('manual','bling')),
  CONSTRAINT "${K_CONTRACT}_dates_check" CHECK (${K_DATE("starts_on")} AND ${K_DATE("ends_on", true)} AND (ends_on IS NULL OR ends_on >= starts_on) AND ${K_DATE("next_period_on", true)} AND ${K_DATE("ended_on", true)} AND ${K_DATE("renewal_noticed_for", true)}),
  CONSTRAINT "${K_CONTRACT}_numbers_check" CHECK (number > 0 AND version > 0 AND due_day BETWEEN 1 AND 31 AND (term_months IS NULL OR term_months BETWEEN 1 AND 600) AND renewal_notice_days BETWEEN 0 AND 365),
  CONSTRAINT "${K_CONTRACT}_flags_check" CHECK (billing_enabled IN (0,1) AND billing_send IN (0,1) AND billing_nfse IN (0,1) AND adjustment_notify IN (0,1)),
  CONSTRAINT "${K_CONTRACT}_adjustment_check" CHECK ((adjustment_index IS NULL AND adjustment_month IS NULL AND adjustment_percent IS NULL) OR (adjustment_index IN ('ipca','igpm','inpc','fixed') AND adjustment_month BETWEEN 1 AND 12 AND ((adjustment_index = 'fixed') = (adjustment_percent IS NOT NULL)) AND (adjustment_percent IS NULL OR ${K_PCT("adjustment_percent")}))),
  CONSTRAINT "${K_CONTRACT}_last_adjustment_check" CHECK (last_adjustment_month IS NULL OR last_adjustment_month GLOB '${DIGITS(4)}-${DIGITS(2)}'),
  CONSTRAINT "${K_CONTRACT}_text_check" CHECK (length(object) BETWEEN 1 AND 4000 AND (notes IS NULL OR length(notes) <= 4000) AND (end_reason IS NULL OR length(end_reason) <= 400))
) STRICT`,
    `CREATE INDEX "${K_CONTRACT}_status_idx" ON "${K_CONTRACT}" (status, next_period_on)`,
    `CREATE INDEX "${K_CONTRACT}_contact_idx" ON "${K_CONTRACT}" (contact_id)`,
  ]),
  contract(K_ITEM, [
    `CREATE TABLE "${K_ITEM}" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "contract_id" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "product_id" TEXT,
  "description" TEXT NOT NULL,
  "quantity" TEXT NOT NULL,
  "unit_cents" INTEGER NOT NULL,
  "valid_from" TEXT NOT NULL,
  "valid_until" TEXT,
  "event_id" TEXT,
  CONSTRAINT "${K_ITEM}_contract_fkey" FOREIGN KEY (contract_id) REFERENCES "${K_CONTRACT}" (id),
  CONSTRAINT "${K_ITEM}_product_fkey" FOREIGN KEY (product_id) REFERENCES "erp_catalog__record" (id),
  CONSTRAINT "${K_ITEM}_value_check" CHECK (${QTY6("quantity")} AND ${K_CENTS("unit_cents")} AND position > 0 AND length(description) BETWEEN 1 AND 400),
  CONSTRAINT "${K_ITEM}_dates_check" CHECK (${K_DATE("valid_from")} AND ${K_DATE("valid_until", true)} AND (valid_until IS NULL OR valid_until >= valid_from))
) STRICT`,
    `CREATE INDEX "${K_ITEM}_contract_idx" ON "${K_ITEM}" (contract_id, valid_from)`,
  ]),
  contract(K_INVOICE, [
    `CREATE TABLE "${K_INVOICE}" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "contract_id" TEXT NOT NULL,
  "period_start" TEXT NOT NULL,
  "period_end" TEXT NOT NULL,
  "due_on" TEXT NOT NULL,
  "amount_cents" INTEGER NOT NULL,
  "title_id" TEXT NOT NULL,
  "origin" TEXT NOT NULL,
  "charge_status" TEXT NOT NULL DEFAULT 'none',
  "charge_sent_at" INTEGER,
  "nfse_status" TEXT NOT NULL DEFAULT 'none',
  "items" TEXT NOT NULL DEFAULT '[]',
  "created_at" INTEGER NOT NULL,
  "created_by" TEXT,
  CONSTRAINT "${K_INVOICE}_period_key" UNIQUE (contract_id, period_start),
  CONSTRAINT "${K_INVOICE}_title_key" UNIQUE (title_id),
  CONSTRAINT "${K_INVOICE}_contract_fkey" FOREIGN KEY (contract_id) REFERENCES "${K_CONTRACT}" (id),
  CONSTRAINT "${K_INVOICE}_title_fkey" FOREIGN KEY (title_id) REFERENCES "erp_finance__title" (id),
  CONSTRAINT "${K_INVOICE}_origin_check" CHECK (origin IN ('alarm','manual')),
  CONSTRAINT "${K_INVOICE}_charge_check" CHECK (charge_status IN ('none','pending','sent')),
  CONSTRAINT "${K_INVOICE}_nfse_check" CHECK (nfse_status IN ('none','pending','not_configured','issued')),
  CONSTRAINT "${K_INVOICE}_value_check" CHECK (${K_CENTS("amount_cents")} AND amount_cents > 0 AND ${K_DATE("period_start")} AND ${K_DATE("period_end")} AND ${K_DATE("due_on")} AND period_end >= period_start AND ${JSON_OF("items", "array")})
) STRICT`,
    `CREATE INDEX "${K_INVOICE}_due_idx" ON "${K_INVOICE}" (due_on)`,
  ]),
  contract(K_EVENT, [
    `CREATE TABLE "${K_EVENT}" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "contract_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "effective_on" TEXT,
  "summary" TEXT NOT NULL,
  "data" TEXT NOT NULL DEFAULT '{}',
  "actor" TEXT,
  "created_at" INTEGER NOT NULL,
  CONSTRAINT "${K_EVENT}_contract_fkey" FOREIGN KEY (contract_id) REFERENCES "${K_CONTRACT}" (id),
  CONSTRAINT "${K_EVENT}_kind_check" CHECK (kind IN ('created','edited','activated','suspended','resumed','ended','billing','invoice','adjustment','amendment','renewal','renewal_notice','adjustment_notice','attachment','bling')),
  CONSTRAINT "${K_EVENT}_data_check" CHECK (${JSON_OF("data", "object")} AND ${K_DATE("effective_on", true)} AND length(summary) BETWEEN 1 AND 600)
) STRICT`,
    `CREATE INDEX "${K_EVENT}_contract_idx" ON "${K_EVENT}" (contract_id, created_at)`,
  ]),
  contract(K_RATE, [
    `CREATE TABLE "${K_RATE}" (
  "index_code" TEXT NOT NULL,
  "month" TEXT NOT NULL,
  "percent" TEXT NOT NULL,
  "updated_at" INTEGER NOT NULL,
  "updated_by" TEXT NOT NULL,
  CONSTRAINT "${K_RATE}_pkey" PRIMARY KEY (index_code, month),
  CONSTRAINT "${K_RATE}_index_check" CHECK (index_code IN ('ipca','igpm','inpc')),
  CONSTRAINT "${K_RATE}_value_check" CHECK (month GLOB '${DIGITS(4)}-${DIGITS(2)}' AND ${K_PCT("percent")})
) STRICT`,
  ]),
  contract(K_FILE, [
    `CREATE TABLE "${K_FILE}" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "contract_id" TEXT NOT NULL,
  "filename" TEXT NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "sha256" TEXT NOT NULL,
  "storage_key" TEXT NOT NULL,
  "created_at" INTEGER NOT NULL,
  "created_by" TEXT NOT NULL,
  "deleted_at" INTEGER,
  "deleted_by" TEXT,
  CONSTRAINT "${K_FILE}_contract_fkey" FOREIGN KEY (contract_id) REFERENCES "${K_CONTRACT}" (id),
  CONSTRAINT "${K_FILE}_value_check" CHECK (length(filename) BETWEEN 1 AND 200 AND size_bytes BETWEEN 1 AND 10485760 AND ${HEX64("sha256")} AND length(storage_key) BETWEEN 1 AND 400),
  CONSTRAINT "${K_FILE}_deleted_check" CHECK ((deleted_at IS NULL) = (deleted_by IS NULL))
) STRICT`,
    `CREATE INDEX "${K_FILE}_contract_idx" ON "${K_FILE}" (contract_id)`,
  ]),
  contract(K_NOTICE, [
    `CREATE TABLE "${K_NOTICE}" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "contract_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "created_at" INTEGER NOT NULL,
  "closed_at" INTEGER,
  "closed_by" TEXT,
  CONSTRAINT "${K_NOTICE}_reference_key" UNIQUE (contract_id, kind, reference),
  CONSTRAINT "${K_NOTICE}_contract_fkey" FOREIGN KEY (contract_id) REFERENCES "${K_CONTRACT}" (id),
  CONSTRAINT "${K_NOTICE}_kind_check" CHECK (kind IN ('renewal','adjustment_due','customer_adjustment')),
  CONSTRAINT "${K_NOTICE}_status_check" CHECK (status IN ('pending','done','dismissed') AND ((status = 'pending') = (closed_at IS NULL))),
  CONSTRAINT "${K_NOTICE}_text_check" CHECK (length(message) BETWEEN 1 AND 1000 AND length(reference) BETWEEN 1 AND 40)
) STRICT`,
    `CREATE INDEX "${K_NOTICE}_status_idx" ON "${K_NOTICE}" (status, created_at)`,
  ]),
  contract(K_BLING, [
    `CREATE TABLE "${K_BLING}" (
  "source_id" TEXT NOT NULL PRIMARY KEY,
  "contract_id" TEXT NOT NULL,
  "source_version" INTEGER NOT NULL,
  "adopted_at" INTEGER NOT NULL,
  "adopted_by" TEXT NOT NULL,
  CONSTRAINT "${K_BLING}_contract_key" UNIQUE (contract_id),
  CONSTRAINT "${K_BLING}_contract_fkey" FOREIGN KEY (contract_id) REFERENCES "${K_CONTRACT}" (id),
  CONSTRAINT "${K_BLING}_source_check" CHECK (length(source_id) BETWEEN 1 AND 40 AND source_version > 0)
) STRICT`,
  ]),
  contract(K_COMMAND, [
    `CREATE TABLE "${K_COMMAND}" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "actor" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "result" TEXT NOT NULL,
  "created_at" INTEGER NOT NULL,
  CONSTRAINT "${K_COMMAND}_result_check" CHECK (json_valid(result))
) STRICT`,
  ]),
];
export const ERP_ENGINE_TABLES: readonly EngineTable[] = [
  ...BASE_ENGINE_TABLES,
  ...counterTables,
  {
    table: C_COUNTER_SETTINGS,
    ddl: [
      `CREATE TABLE "${C_COUNTER_SETTINGS}" (
  "id" INTEGER NOT NULL PRIMARY KEY DEFAULT 1,
  "version" INTEGER NOT NULL DEFAULT 1,
  "nature_id" TEXT,
  "updated_at" INTEGER NOT NULL,
  "updated_by" TEXT NOT NULL,
  CONSTRAINT "${C_COUNTER_SETTINGS}_singleton_check" CHECK (id = 1),
  CONSTRAINT "${C_COUNTER_SETTINGS}_version_check" CHECK (version BETWEEN 1 AND 2147483647),
  CONSTRAINT "${C_COUNTER_SETTINGS}_nature_fkey" FOREIGN KEY (nature_id) REFERENCES "erp_fiscal_invoices__nature" (id)
) STRICT`,
    ],
    since: 14, owner: "nfce-balcao", structural: "cupom-nfce",
  },
  // Versão 15: o corte do Bling (data confirmada e o que cada etapa gravou).
  ...CUTOVER_TABLES,
  // Versão 16: a nota de serviço da ordem (NFS-e) e o cadastro fiscal do serviço.
  ...serviceTables,
  {
    table: C_SERVICE_SETTINGS,
    ddl: [
      `CREATE TABLE "${C_SERVICE_SETTINGS}" (
  "id" INTEGER NOT NULL PRIMARY KEY DEFAULT 1,
  "version" INTEGER NOT NULL DEFAULT 1,
  "national_code" TEXT,
  "municipal_code" TEXT,
  "nbs" TEXT,
  "iss_rate" TEXT,
  "iss_withheld" INTEGER NOT NULL DEFAULT 0,
  "simples_apportionment" INTEGER,
  "municipality_code" TEXT,
  "parts_nature_id" TEXT,
  "items" TEXT NOT NULL DEFAULT '{}' CHECK (${JSON_OF("items", "object")}),
  "updated_at" INTEGER NOT NULL,
  "updated_by" TEXT NOT NULL,
  CONSTRAINT "${C_SERVICE_SETTINGS}_singleton_check" CHECK (id = 1),
  CONSTRAINT "${C_SERVICE_SETTINGS}_version_check" CHECK (version BETWEEN 1 AND 2147483647),
  CONSTRAINT "${C_SERVICE_SETTINGS}_codes_check" CHECK ((national_code IS NULL OR national_code GLOB '${DIGITS(6)}') AND (municipal_code IS NULL OR municipal_code GLOB '${DIGITS(3)}') AND (nbs IS NULL OR nbs GLOB '${DIGITS(9)}') AND (municipality_code IS NULL OR municipality_code GLOB '${DIGITS(7)}')),
  CONSTRAINT "${C_SERVICE_SETTINGS}_iss_check" CHECK ((iss_rate IS NULL OR (iss_rate GLOB '[0-9].[0-9][0-9]')) AND iss_withheld IN (0,1) AND (simples_apportionment IS NULL OR simples_apportionment IN (1,2,3))),
  CONSTRAINT "${C_SERVICE_SETTINGS}_items_size_check" CHECK (length(CAST(items AS BLOB)) <= 262144),
  CONSTRAINT "${C_SERVICE_SETTINGS}_nature_fkey" FOREIGN KEY (parts_nature_id) REFERENCES "erp_fiscal_invoices__nature" (id)
) STRICT`,
    ],
    since: 16, owner: "os5-fiscal", structural: "nota-servico-os",
  },
  // Versão 17: a compra pela nota recebida (nota, entrada e configuração).
  ...inboundTables,
  // Versão 18: o que vem depois da NF-e autorizada (carta de correção,
  // inutilização de numeração e devolução de venda).
  ...EVENT_TABLES,
  // Versão 19: mão dupla com o Bling (as versões 17 e 18 são de outras frentes).
  ...TWO_WAY_TABLES,
  // Versão 20: campos próprios de contato (Cadastros).
  ...CONTACT_FIELD_TABLES,
  // Versão 21: o DRE gerencial e o pagamento da equipe (src/erp/domains/finance/rpc/erp_finance_dre.ts e erp_finance_team.ts).
  ...REPORT_TABLES,
  // Versão 22: o pacote do contador (src/erp/contador/package.ts).
  ...CONTADOR_TABLES,
  // Versão 23: a ordem de produção (parte Produção; a 22 é de outra frente).
  ...PRODUCTION_TABLES,
  // Versão 24: fatia D do Bling (as versões 22 e 23 são de outras frentes).
  ...EXTRA_TABLES,
  // Versão 25: Expedição (as versões 22 a 24 são de outras frentes).
  ...SHIPPING_TABLES,
  // Versão 26: o cálculo da reforma tributária (configuração e Imposto Seletivo do produto).
  ...REFORM_CALC_TABLES,
  // Versão 27: lojas e filiais da mesma empresa (a 26 é de outra frente).
  ...STORE_TABLES,
  // Versão 28: o tipo das importações fiscal e de saldos iniciais (26 e 27 são de outras frentes).
  ...IMPORT_TABLES,
  // Versão 31: contratos de serviço (parte Contratos; 29 e 30 são de outras frentes).
  ...CONTRACT_TABLES,
];

export const ERP_ENGINE_DDL: readonly string[] = ERP_ENGINE_TABLES.flatMap((t) => t.ddl);

/** Passo de migração: cria as tabelas do motor que nascem na versão `version`. */
export function createEngineTables(sql: { exec(query: string): { rowsWritten: number } }, version: number): number {
  let written = 0;
  for (const t of ERP_ENGINE_TABLES) if (t.since === version) for (const s of t.ddl) written += sql.exec(s).rowsWritten;
  return written;
}
