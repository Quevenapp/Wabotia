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

export const ERP_ENGINE_TABLES: readonly EngineTable[] = [
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
];

export const ERP_ENGINE_DDL: readonly string[] = ERP_ENGINE_TABLES.flatMap((t) => t.ddl);

/** Passo de migração: cria as tabelas do motor que nascem na versão `version`. */
export function createEngineTables(sql: { exec(query: string): { rowsWritten: number } }, version: number): number {
  let written = 0;
  for (const t of ERP_ENGINE_TABLES) if (t.since === version) for (const s of t.ddl) written += sql.exec(s).rowsWritten;
  return written;
}
