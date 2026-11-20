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
];

export const ERP_ENGINE_DDL: readonly string[] = ERP_ENGINE_TABLES.flatMap((t) => t.ddl);

/** Passo de migração: cria as tabelas do motor que nascem na versão `version`. */
export function createEngineTables(sql: { exec(query: string): { rowsWritten: number } }, version: number): number {
  let written = 0;
  for (const t of ERP_ENGINE_TABLES) if (t.since === version) for (const s of t.ddl) written += sql.exec(s).rowsWritten;
  return written;
}
