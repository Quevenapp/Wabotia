// Desvios deliberados do oráculo (Fagoo), cada um com o motivo e a decisão.
// Dois tipos:
// - "seed" (o padrão): valor inicial de dados de referência e de
//   preferências (uma linha da semeadura);
// - "function": um trecho literal no corpo de uma função do oráculo, para o
//   que a pessoa vê e não pode levar o nome do Fagoo (ex.: o nome do arquivo
//   baixado, um rótulo). Regra (orquestração, 17/11): só texto que a pessoa
//   vê; nunca para mudar regra de negócio. Condição, cálculo, conversão,
//   permissão, validação e precisão do banco e do motor nunca entram aqui:
//   mudança de regra é porte com teste próprio, não desvio.
// Esquema nunca entra aqui.
//
// Como vale:
// - scripts/erp/gen-sqlite.mjs confere cada item contra o oráculo e para se o
//   Fagoo mudou. "seed": a linha existe e o valor ainda é `oracle`; com
//   `applied: true`, troca o valor na semeadura (seed.generated.ts).
//   "function": o trecho `oracle` aparece exatamente uma vez no corpo da
//   função;
// - o diferencial (tests/erp/harness/dual-fixture.mjs) aplica os mesmos itens
//   no Postgres antes de começar: os dois motores rodam com o valor do
//   Wabotia. "seed": troca a linha nos dois bancos. "function": CREATE OR
//   REPLACE da função no oráculo (só o Postgres desta fixture; o motor já
//   traz o valor no código portado).
// Só texto e JSON aqui: o gerador (Node) importa este arquivo direto.

export interface SeedDeviation {
  kind?: "seed";
  /** Identificador do desvio (vários itens podem ter o mesmo). */
  id: string;
  /** Tabela do SQLite (schema__tabela). */
  table: string;
  /** Chave primária da linha alterada (valores JSON: texto, número, booleano). */
  key: Record<string, string | number | boolean>;
  column: string;
  /** Valor no Fagoo (JSON, como o Postgres devolve). */
  oracle: unknown;
  /** Valor no Wabotia. */
  value: unknown;
  reason: string;
  decided: string;
  /** false: registrado, ainda não vale na semeadura nem no diferencial. */
  applied: boolean;
}

/** Trecho literal no corpo de uma função do oráculo (pg_get_functiondef). */
export interface FunctionDeviation {
  kind: "function";
  id: string;
  /** schema.nome da função (sem sobrecarga). */
  fn: string;
  /** Trecho do Fagoo, que precisa aparecer exatamente uma vez no corpo. */
  oracle: string;
  /** Trecho do Wabotia. */
  value: string;
  reason: string;
  decided: string;
  applied: boolean;
}

export type Deviation = SeedDeviation | FunctionDeviation;
/** Informativo: nunca aplicado ao oráculo, gerados ou esquema. */
export const MODULE_ORIGIN_DEVIATIONS = Object.freeze([{
  id: "f3-module-origin", policy: "wabotia-module-origin-v1", decided: "2026-11-19",
  scope: "Somente pedidos D1 imutáveis conferidos e alvos com âncoras ERP; sem papel ampliado.",
  behavior: "Execução comercial enumerada, efeitos conjuntos, recibos permanentes, documento vinculado protegido e exceção operacional de retorno à execução.",
  oracle: "Inalterado fora do escopo F3; não é FunctionDeviation.",
}]);
/**
 * Desvios deliberados de regra de negócio, como MODULE_ORIGIN_DEVIATIONS:
 * informativos, nunca aplicados ao oráculo, aos gerados nem ao esquema (não
 * são FunctionDeviation, que só vale para texto visível). O diferencial não
 * exercita o caso; o teste citado prova a regra e confere que o trecho do
 * oráculo continua o mesmo.
 */
export interface RuleDeviation {
  id: string;
  /** Função do oráculo e migração onde está a definição vigente. */
  fn: string;
  oracle_file: string;
  /** Trecho do Fagoo que mostra a regra original. */
  oracle: string;
  behavior: string;
  reason: string;
  decided: string;
  tests: readonly { file: string; test: string }[];
}
export const ERP_RULE_DEVIATIONS: readonly RuleDeviation[] = Object.freeze([{
  id: "titulo-cobranca-bancaria",
  fn: "public.erp_finance_execute",
  oracle_file: "202610160058_itau_net_credit.sql",
  oracle: "if v_title.settled_cents<>0 then raise exception 'erp_finance_active_payments' using errcode='40001'; end if;",
  behavior:
    "Cancelar conta (title_cancel e todo escritor que marca cancelled) é recusado com erp_finance_billed_locked quando a conta tem " +
    "vínculo de cobrança bancária (erp_cnab.billing_title). A guarda fica em titleUpdateGuards (domains/finance/internal.ts), ponto único " +
    "de todos os escritores. O vínculo só se encerra pela exclusão da remessa (apaga o vínculo) ou pela baixa (settled_cents).",
  reason:
    "No Fagoo o title_cancel só confere settled_cents: a dívida some do ERP enquanto o boleto continua no banco, e o pagamento depois " +
    "cai em conta não aberta na conciliação (revisão de dinheiro, estoque e nota, achado 3).",
  decided: "orquestração, 20/11/2026 (junção candidata, correções da revisão)",
  tests: [{ file: "tests/erp/comnfe/revisao-dinheiro.test.mjs", test: "achado 3: title_cancel recusa título com cobrança bancária, de pedido ou avulso" }],
}]);
export const isFunctionDeviation = (d: Deviation): d is FunctionDeviation => d.kind === "function";
const seedOnly = (list: readonly Deviation[]) => list.filter((d): d is SeedDeviation => !isFunctionDeviation(d));

/** Quantas vezes o trecho aparece no corpo (sem sobreposição). */
const occurrences = (text: string, part: string) => (part ? text.split(part).length - 1 : 0);

/** Confere o desvio de função contra o corpo atual: null quando o trecho aparece exatamente uma vez. */
export function checkFunctionDeviation(definition: string | null, d: FunctionDeviation): string | null {
  if (definition === null) return `${d.id} ${d.fn}: a função não existe no oráculo`;
  const n = occurrences(definition, d.oracle);
  return n === 1 ? null : `${d.id} ${d.fn}: o trecho ${JSON.stringify(d.oracle)} aparece ${n} vezes (esperado: 1)`;
}

/**
 * O desvio já está no corpo (o trecho do Fagoo some e o do Wabotia aparece
 * exatamente uma vez): aplicar de novo no mesmo banco não faz nada.
 */
export const functionDeviationApplied = (definition: string | null, d: FunctionDeviation) =>
  definition !== null && occurrences(definition, d.oracle) === 0 && occurrences(definition, d.value) === 1;

/** O corpo com o trecho do Wabotia no lugar do Fagoo; lança se o trecho não aparece exatamente uma vez. */
export function applyFunctionDeviation(definition: string | null, d: FunctionDeviation): string {
  const problem = checkFunctionDeviation(definition, d);
  if (problem) throw new Error(`Desvio de função desatualizado: ${problem}`);
  return definition!.replace(d.oracle, () => d.value);
}

/** SQL que devolve o corpo da função (uma linha; sem sobrecarga). Parâmetros: schema, nome. */
export const FUNCTION_DEFINITION_SQL =
  "select pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=$1 and p.proname=$2";

const TELAS_2_CASAS =
  'Usuário (16/11): "casas decimais usamos apenas 02" e "pode deixar padrão 02 casas". Opção (a): o padrão ' +
  "das preferências vai a 2, com o limite de entrada no servidor valendo; quem precisar de mais sobe a " +
  "preferência. O banco e o motor seguem com a precisão do Fagoo (preço até 10, quantidade 6, custo 10). " +
  "decimais_peso fica em 3. Conferido para o preço de entrada: o limite só vale no que se digita (preço do " +
  "pedido de compra, erp_documents.check_preference_rules; preço e custo do lançamento e do balanço de " +
  "estoque, erp_stock.entry_price_check). A importação de XML de nota de entrada (erp_fiscal_invoice_import, " +
  "vUnCom com até 10 casas), o recebimento de compra e o custo médio não passam por ele.";

export const ERP_DEVIATIONS: readonly Deviation[] = [
  {
    id: "origin-fora",
    table: "erp_sync__settings",
    key: { singleton: true },
    column: "enabled",
    oracle: true,
    value: false,
    reason:
      "O Origin sai da instalação principal (PLANO-FAGOO.md, item 17): o ERP é portado com o Origin desligado. " +
      "No Fagoo a migração 202610220009 liga a sincronização de fábrica (enabled=true); aqui ela nasce desligada, " +
      "e erp_sync.enqueue não grava a fila. O contrato genérico de integração vem na última etapa.",
    decided: "usuário, 16/11/2026 (item 17)",
    applied: true,
  },
  {
    id: "telas-2-casas",
    table: "erp_preferences__definition",
    key: { key: "empresa.decimais_preco_saida" },
    column: "default_value",
    oracle: 10,
    value: 2,
    reason: TELAS_2_CASAS,
    decided: "usuário, 16/11/2026",
    applied: true,
  },
  {
    id: "telas-2-casas",
    table: "erp_preferences__definition",
    key: { key: "empresa.decimais_preco_entrada" },
    column: "default_value",
    oracle: 10,
    value: 2,
    reason: TELAS_2_CASAS,
    decided: "usuário, 16/11/2026",
    applied: true,
  },
  {
    id: "telas-2-casas",
    table: "erp_preferences__definition",
    key: { key: "empresa.decimais_quantidade" },
    column: "default_value",
    oracle: 6,
    value: 2,
    reason: TELAS_2_CASAS,
    decided: "usuário, 16/11/2026",
    applied: true,
  },
  {
    kind: "function",
    id: "exportacao-wabotia",
    fn: "public.erp_platform_export_link",
    oracle: "'brufap-exportacao-'",
    value: "'wabotia-exportacao-'",
    reason:
      "O arquivo da exportação da empresa vai para a pasta de downloads da pessoa: o nome não leva o nome do " +
      "Fagoo. O resto do link (validade, tamanho, SHA-256, chave do objeto) segue igual; o adaptador da erp-api " +
      "(platform.mjs, parseExportLink) confere o formato novo.",
    decided: "orquestração, 17/11/2026",
    applied: true,
  },
];

/**
 * Contrato condicional da fase 2, exclusivamente informativo. Não é Deviation:
 * nem o gerador de SQLite nem applyDeviationsBoth o aplicam ao Postgres.
 * O diferencial continua comparando as nove partes explicitamente ligadas.
 */
export interface ErpPartBehavior {
  id: string;
  rule: string;
  disabled_when: string;
  reason: string;
  tests: readonly { file: string; test: string }[];
}
export const ERP_PART_BEHAVIORS: readonly ErpPartBehavior[] = [
  {
    id: "parts-posting", rule: "Pular nova postagem e autoFinance antes de validar depósito, categoria ou prévia.",
    disabled_when: "Estoque ou Financeiro desligado.", reason: "A venda e a compra continuam comerciais sem suas integrações opcionais (A1.1).",
    tests: [{ file: "tests/erp/unico/f2-documentos.test.mjs", test: "proposta, compra e OS nascem sem depósito/categoria; compra automática pula antes da prévia" }],
  },
  {
    id: "parts-maintenance", rule: "Conservar flags e guardas históricas; permitir somente compensações vinculadas, com prévia, versão, papel e recibo originais.",
    disabled_when: "Destino ou origem do efeito histórico desligado.", reason: "Desligar não deve impedir desfazer; liquidação, reserva e saldo continuam bloqueadores reais (A1.1/A4).",
    tests: [{ file: "tests/erp/unico/f2-integracoes.test.mjs", test: "baixa histórica bloqueia estorno; manutenção desfaz baixa e postagem sem reabrir criação" }],
  },
  {
    id: "parts-commission", rule: "Congelar comissão anterior e impedir criação/recálculo por produtores diretos ou adiados; cancelamento compensa a anterior.",
    disabled_when: "Financeiro ou origem comercial desligado.", reason: "A guarda deve alcançar confirmação, edição, vendedor, título, nota e devolução (A1.2).",
    tests: [{ file: "tests/erp/unico/f2-documentos.test.mjs", test: "comissão congelada na confirmação, edição e troca de vendedor; cancelamento compensa a anterior" },
      { file: "tests/erp/unico/f2-integracoes.test.mjs", test: "comissão por nota e títulos históricos: estorno desligado conserva os vínculos" }],
  },
  {
    id: "parts-reenable", rule: "Religar e ler não recompõem efeitos; replay conserva a decisão anterior; uma ação nova usa estado e preferências atuais.",
    disabled_when: "Uma ação anterior pulou integração que foi religada.", reason: "parts não integra o hash do comando; nenhuma varredura comercial compensatória (A1.3).",
    tests: [{ file: "tests/erp/unico/f2-documentos.test.mjs", test: "religar não recompõe; nova edição elegível lança contas e replay conserva a decisão" }],
  },
  {
    id: "parts-composed", rule: "Exigir todos os domínios da operação e resolver referências persistidas no motor, inclusive em chamadas internas.",
    disabled_when: "Qualquer requisito de A1.4/A4 desligado.", reason: "Uma rota ou corpo genérico não pode trocar o dono nem abrir efeitos indiretos.",
    tests: [{ file: "tests/erp/unico/f2-base.test.mjs", test: "resolução persistida não deixa parâmetro trocar o dono" },
      { file: "tests/erp/unico/f2-integracoes.test.mjs", test: "produtores diretos recusam criação antes de validar ou gravar efeitos" }],
  },
  {
    id: "parts-fields", rule: "Preservar campo omitido ou idêntico; recusar alteração e null; cópia não leva vínculos operacionais indisponíveis.",
    disabled_when: "Parte responsável pelo campo desligada.", reason: "Ocultar um campo não autoriza apagá-lo; parcelas e condições comerciais continuam (A1.5).",
    tests: [{ file: "tests/erp/unico/f2-documentos.test.mjs", test: "campos suspensos omitidos e iguais são preservados; troca e limpeza são recusadas" },
      { file: "tests/erp/unico/f2-catalogo.test.mjs", test: "contato comum e importação isolados; vínculos anteriores preservados em gravação completa" }],
  },
  {
    id: "parts-credit-cost", rule: "Suspender limite operacional de crédito e captura de custo fora de Vendas + Compras + Estoque; preservar histórico sem margem corrente.",
    disabled_when: "Financeiro suspenso para crédito; Compras, Vendas ou Estoque suspenso para custo.", reason: "Fonte indisponível não representa dívida ou custo zero (A1.4–6).",
    tests: [{ file: "tests/erp/unico/f2-documentos.test.mjs", test: "custo exige Vendas, Compras e Estoque, sem consultar fonte suspensa e sem apagar histórico" },
      { file: "tests/erp/unico/f2-documentos.test.mjs", test: "limite operacional de crédito suspenso antes de qualquer consulta" }],
  },
  {
    id: "parts-dtos", rule: "Omitir capacidades e retornar null nas seções permitidas pelo DTO; unavailable_parts só no modo dividido; preservar flags históricas.",
    disabled_when: "Domínio consultado desligado.", reason: "Ausência não é zero nem inexistência de lançamento (A1.6).",
    tests: [{ file: "tests/f2-dtos.test.ts", test: "home preserva o DTO completo e diferencia ausência de zero" },
      { file: "tests/erp/unico/f2-consultas.test.mjs", test: "parser comercial: histórico financeiro ausente, flags históricas e recibos part_disabled" }],
  },
  {
    id: "parts-settings", rule: "Filtrar fontes de relatórios e notificações; conservar definições, favoritos e campos ocultos salvos.",
    disabled_when: "Fonte da definição ou preferência desligada.", reason: "As escolhas reaparecem ao religar; a execução verifica a parte antes da preferência (A5/A6).",
    tests: [{ file: "tests/erp/unico/f2-consultas.test.mjs", test: "relatório salvo prevalece sobre corpo e verifica base, colunas e filtros persistidos" },
      { file: "tests/erp/unico/f2-consultas.test.mjs", test: "favoritos ocultos e rótulos sobrevivem a edição e replay; religamento só lê" }],
  },
  {
    id: "parts-envelope", rule: "Produção exige fotografia completa, válida e vinculada à área; revisão antiga falha antes de efeitos. Ausência = ligado apenas no motor direto.",
    disabled_when: "Fotografia ausente, expirada, superada ou parte requerida desligada.", reason: "O objeto não lê D1; o Worker transporta a autorização sem confiar no corpo comercial (A6).",
    tests: [{ file: "tests/f2-base.test.ts", test: "entrada de produção exige mapa completo; revisão antiga falha antes do motor comercial" },
      { file: "tests/erp/unico/f2-paridade.test.mjs", test: "ausência e nove partes ligadas produzem os mesmos DTOs, erros e tabelas" }],
  },
  {
    id: "parts-background", rule: "Revalidar KV entre unidades e após awaits; tarefa suspensa fica pendente sem tentativa ou alarme contínuo.",
    disabled_when: "Autorização expirada, Base desligada ou requisito da tarefa desligado.", reason: "A transação síncrona iniciada termina com sua fotografia; não há transação D1 + SQLite (A7).",
    tests: [{ file: "tests/f2-fundo.test.ts", test: "desligamento durante yield termina unidade síncrona, devolve claim sem tentativa e não agenda ciclo vazio" },
      { file: "tests/f2-fundo.test.ts", test: "perda de entrega e de ACK ficam pendentes; repetição confirma sem duplicar ou regredir" }],
  },
  {
    id: "parts-navigation-models", rule: "Somente Base abre Clientes; navegação e modelos usam dependências explícitas sem conceder papéis ou integrar módulos nativos automaticamente.",
    disabled_when: "Parte do destino ou dependência de uma seleção desligada.", reason: "Dividir operação e exposição, mantendo tabelas e escolhas existentes (A2/A3/A5/A8).",
    tests: [{ file: "tests/f2-painel.test.ts", test: "abre Clientes com Base, visão geral com outras partes e destinos nativos isolados" },
      { file: "tests/f2-modelos.test.ts", test: "seleção incompleta do PDV mostra requisitos transitivos, não escreve nem liga ocultamente" },
      { file: "tests/erp/unico/f2-base.test.mjs", test: "migração aditiva preserva escolhas e revisões na reexecução, triggers e ACK antigo" }],
  },
];

interface SeedTable {
  table: string;
  columns: string[];
  rows: unknown[][];
}

/** Valor JSON → forma da coluna no SQLite (json: texto; booleano: 0/1; o resto como está). */
export const liteValue = (codec: string, value: unknown) =>
  codec === "json" || codec.startsWith("array:")
    ? JSON.stringify(value)
    : codec === "bool" && typeof value === "boolean"
      ? value
        ? 1
        : 0
      : value;

/** Linhas da semeadura que casam com a chave do desvio. */
function matching(t: SeedTable | undefined, d: SeedDeviation, codecOf: (table: string, column: string) => string) {
  if (!t) return { col: -1, hits: [] as unknown[][] };
  const col = t.columns.indexOf(d.column);
  const keys = Object.entries(d.key).map(([k, v]) => [t.columns.indexOf(k), liteValue(codecOf(d.table, k), v)] as const);
  const hits = col >= 0 && keys.every(([i]) => i >= 0) ? t.rows.filter((r) => keys.every(([i, v]) => r[i] === v)) : [];
  return { col, hits };
}

/**
 * Confere cada desvio de semeadura contra a do oráculo: linha única e valor do
 * Fagoo igual a `oracle`. Os de função são conferidos contra o corpo da função
 * (checkFunctionDeviation), com o oráculo aberto.
 */
export function checkDeviations(
  seed: readonly SeedTable[],
  deviations: readonly Deviation[],
  codecOf: (table: string, column: string) => string,
) {
  const problems: string[] = [];
  for (const d of seedOnly(deviations)) {
    const { col, hits } = matching(
      seed.find((x) => x.table === d.table),
      d,
      codecOf,
    );
    if (hits.length !== 1) problems.push(`${d.id} ${d.table} ${JSON.stringify(d.key)}: ${hits.length} linhas`);
    else if (hits[0][col] !== liteValue(codecOf(d.table, d.column), d.oracle))
      problems.push(`${d.id} ${d.table} ${JSON.stringify(d.key)}: o Fagoo tem ${String(hits[0][col])}, o desvio espera ${JSON.stringify(d.oracle)}`);
  }
  return problems;
}

/**
 * Semeadura com os desvios dados trocados (só os de semeadura). Cada desvio
 * precisa achar exatamente uma linha; senão lança (desvio desatualizado).
 */
export function applyDeviations<T extends SeedTable>(
  seed: readonly T[],
  deviations: readonly Deviation[],
  codecOf: (table: string, column: string) => string,
): T[] {
  const out = seed.map((t) => ({ ...t, rows: t.rows.map((r) => [...r]) }));
  for (const d of seedOnly(deviations)) {
    const { col, hits } = matching(
      out.find((x) => x.table === d.table),
      d,
      codecOf,
    );
    if (hits.length !== 1) throw new Error(`Desvio ${d.id} (${d.table} ${JSON.stringify(d.key)}): ${hits.length} linhas na semeadura.`);
    hits[0][col] = liteValue(codecOf(d.table, d.column), d.value);
  }
  return out;
}
