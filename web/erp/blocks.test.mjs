// Classificação dos blocos do ERP: a do painel (web/erp/blocks.ts, endereços
// das telas) contra a do motor (src/erp/blocks.ts, rotas da erp-api), para as
// duas não se afastarem. Enquanto o motor não está neste checkout, vale a
// cópia fixa web/erp/motor-blocks.json; com ele aqui, a cópia tem de ser igual.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { blockOf, hiddenInWabotia } from "./blocks.ts";
import { panelRequestAllowed } from "./fetch-port.ts";
import { ERP_MODULE_IDS } from "../../src/erp/parts.ts";
import { BLING_OPERATIONS } from "../../src/erp/bling/schema.ts";
import { erpChunk } from "./chunks.ts";
import {
  PREFERENCE_PAGES,
  preferencePageHref,
} from "../../packages/erp-domain/src/preferences/catalog.mjs";

// Fotografia aditiva do contrato A4. O JSON da fase anterior fica preservado.
const v1=(...paths)=>paths.map(path=>`/v1/${path}`);
const pinned={fonte:'contrato A4 da fase 2',prefixos:{
  erp: v1("me", "cadastros", "empresa", "anexos-empresa", "anexos-cadastros/contatos", "anexos-cadastros/funcionarios", "usuarios", "seguranca", "registro-atividades", "gerenciador-arquivos", "inicio", "plataforma", "sistema", "preferencias", "preferencias-listas", "importacoes", "documentos", "duplicacao-documentos", "records", "receber-bling"),
  "erp-produtos": v1("cadastros/products", "cadastros/listas-precos", "cadastros/campos-customizados", "cadastros/taxonomias/categorias-produtos", "cadastros/taxonomias/grupos-produtos", "anexos-cadastros/produtos", "records/products", "preferencias/cadastros-produtos", "importacoes/produtos", "importacoes/campos-customizados", "importacoes/fornecedores-produtos", "importacoes/composicoes"),
  "erp-vendas": v1("documentos/sales_orders", "documentos/sales_proposals", "documentos/service_orders", "documentos/sacola-vendas", "duplicacao-documentos/sales_orders", "duplicacao-documentos/sales_proposals", "duplicacao-documentos/service_orders", "ordens-servico", "records/sales_orders", "records/sales_proposals", "meu-negocio", "sistema/top-produtos", "preferencias/vendas-vendas", "preferencias/vendas-propostas", "preferencias/servicos-os", "preferencias/meu-negocio", "importacoes/vendas"),
  "erp-compras": v1("documentos/purchase_orders", "duplicacao-documentos/purchase_orders", "records/purchase_orders", "recebimentos-compras", "preferencias/suprimentos-compras", "importacoes/pedidos-compra"),
  "erp-estoque": v1("estoque", "documentos-estoque", "reservas-estoque", "posicoes-estoque", "politica-estoque", "cadastros/warehouses", "preferencias/cadastros-lotes", "preferencias/suprimentos-estoque", "importacoes/lotes", "importacoes/movimentacoes-estoque"),
  "erp-financeiro": v1("financeiro", "anexos-financeiro", "transferencias-internas", "relatorios/vencimentos", "records/receivables", "records/payables", "preferencias/financas-pagar", "preferencias/financas-receber", "preferencias/contabilidade-contador", "importacoes/contas-pagar", "importacoes/contas-receber"),
  "erp-fiscal": v1("notas-fiscais", "rascunhos-fiscais", "preparacao-itens-fiscais", "preparacao-tributaria", "numeracao-fiscal", "complemento-fiscal", "notas-recebidas", "documentos/sales_orders/notas-fiscais", "cadastros/notas-fiscais", "estoque/notas-fiscais", "estoque/checkin", "estoque/relatorios/notas-entrada", "financeiro/notas-contas", "financeiro/notas", "financeiro/actions/invoice_finance_post", "financeiro/actions/invoice_finance_reverse", "preferencias/notas-nfce", "preferencias/notas-nfe", "preferencias/certificado-digital", "importacoes/notas-fiscais", "sistema/etiquetas/nota", "plataforma/novas-nfes", "records/nfe", "records/nfce"),
  "erp-cobranca": v1("cnab", "cobranca-operacional", "cobranca-operacional-v2", "retornos-operacionais", "conferencia-retornos", "boletos-itau", "retornos-itau109", "financeiro/remessa-candidatos", "financeiro/remessas", "financeiro/retornos", "financeiro/actions/remittance_exclude", "financeiro/actions/return_exclude"),
  "erp-pdv": v1("frente-caixa", "preferencias/vendas-frente-caixa"),
  externo: ["/integracao-externa", "/admin", "/oauth", "/mcp", ...v1("system", "importacao-cadastros", "importacao-financeira-origin", "conferencia-financeira-origin", "importacao-orcamentos-origin", "importacao-orcamentos-origin-v2", "historico-vendas-origin", "vendas-origin-prontidao", "compras-origin-prontidao", "integracao-origin", "preparacao-virada", "depositos-origin", "estoque-origin-observado", "saldo-abertura-estoque", "sincronizacao-origin", "espelho-origin", "xmls-sincronizados", "cobrancas-legadas-itau", "backup-import", "history", "estoque/espelho", "notas-fiscais/origin")],
}};
pinned.prefixos["erp-fiscal"].push(...v1("a1", "fiscal-authorization", "fiscal-danfe", "fiscal-reconciliation", "fiscal-signed", "fiscal-unsigned", "fiscal-wsdl"));
const motorFile = new URL("../../src/erp/blocks.ts", import.meta.url);
const motor = existsSync(motorFile) ? await import(motorFile.href) : null;
const PREFIXES = motor ? motor.ERP_BLOCK_PREFIXES : pinned.prefixos;
const ORDERED = Object.entries(PREFIXES)
  .flatMap(([block, list]) => list.map((prefix) => ({ prefix, block })))
  .sort((a, b) => b.prefix.length - a.prefix.length);
const motorBlockOf = (path) =>
  motor
    ? motor.erpBlockOf(path)
    : (ORDERED.find(
        ({ prefix }) => path === prefix || path.startsWith(prefix + "/"),
      )?.block ?? null);

test("a cópia fixa da classificação do motor é igual à do motor, quando ele está aqui", (t) => {
  if (!motor) return t.skip(`motor ausente; cópia de ${pinned.fonte}`);
  assert.deepEqual(
    JSON.parse(JSON.stringify(motor.ERP_BLOCK_PREFIXES)),
    pinned.prefixos,
    "src/erp/blocks.ts mudou: confira os pares abaixo e atualize a fotografia A4 neste teste",
  );
});

// Tela do painel → rota principal da erp-api que ela chama.
const SCREENS = [
  // Fiscal
  ["/historico-fiscal?modelo=55", "/v1/notas-fiscais"],
  ["/notas-entrada", "/v1/notas-fiscais"],
  ["/naturezas-operacao", "/v1/notas-fiscais/naturezas"],
  ["/inutilizacoes-nfe", "/v1/notas-fiscais/eventos"],
  ["/cartas-correcao", "/v1/notas-fiscais/eventos"],
  ["/checkin-recebimentos", "/v1/estoque/checkin/notas"],
  ["/notas-recebidas", "/v1/notas-recebidas"],
  ["/numeracao-fiscal", "/v1/numeracao-fiscal"],
  ["/preferencias/importacoes/notas-fiscais", "/v1/importacoes/notas-fiscais"],
  // Cobrança bancária
  ["/cobranca-empresa", "/v1/cnab"],
  ["/cobranca-operacional", "/v1/cobranca-operacional"],
  ["/retornos-operacionais", "/v1/retornos-operacionais"],
  ["/financeiro-empresa?area=remessas", "/v1/financeiro/remessas"],
  ["/financeiro-empresa?area=retornos", "/v1/financeiro/retornos"],
  // Caixa / PDV
  ["/frente-caixa-empresa", "/v1/frente-caixa"],
  // Núcleo
  ["/receber-bling", "/v1/receber-bling"],
  ["/financeiro-empresa?area=borderos", "/v1/financeiro/borderos"],
  ["/financeiro-empresa", "/v1/financeiro/titulos"],
  ["/documentos-empresa?tipo=sales_orders", "/v1/documentos/sales_orders"],
  ["/estoque-empresa", "/v1/estoque/saldos"],
  ["/cadastros-empresa", "/v1/cadastros/contacts"],
  ["/preferencias/importacoes/produtos", "/v1/importacoes/produtos"],
];

test("cada tela fica no bloco da rota que ela chama", () => {
  for (const [screen, api] of SCREENS)
    assert.equal(blockOf(screen), motorBlockOf(api), `${screen} → ${api}`);
});

test("todas as operações do Bling dependem só da Base, inclusive quando as partes operacionais estão desligadas", async () => {
  const baseOnly = Object.fromEntries(ERP_MODULE_IDS.map(id => [id, id === "erp"]));
  const operations = Object.values(BLING_OPERATIONS).filter(operation => operation.permission !== "oauth_callback");
  assert.equal(operations.length, 17);
  assert.equal(blockOf("/receber-bling"), "erp");
  for (const operation of operations) {
    const path = `/v1/receber-bling${operation.path === "/" ? "" : operation.path}`.replace(/:[a-zA-Z_]+/g, "id");
    assert.equal(motorBlockOf(path), "erp", operation.name);
    assert.equal(await panelRequestAllowed(path, operation.method, undefined, baseOnly), true, operation.name);
    assert.equal(await panelRequestAllowed(path, operation.method, undefined, { ...baseOnly, erp: false }), false, operation.name);
  }
});

test("cada página de preferências fica no bloco da rota /v1/preferencias dela", () => {
  assert.ok(PREFERENCE_PAGES.length >= 20);
  for (const page of PREFERENCE_PAGES) {
    const screen = preferencePageHref(page),
      api = `/v1/preferencias/${page.id}`,
      expected = motorBlockOf(api);
    // Nenhuma página que ficou chama rota externa (o motor responde 404).
    if (expected === "externo" || hiddenInWabotia(screen)) {
      assert.ok(hiddenInWabotia(screen), `${screen} → ${api} é externo`);
      continue;
    }
    assert.equal(blockOf(screen), expected, `${screen} → ${api}`);
  }
});

// As cinco partes novas compartilham os arquivos físicos legados do núcleo.
// Seus nove portões operacionais são exercitados em test/f2-parts.test.mjs.
// Arquivos de grupo do núcleo (web/erp/chunks.ts) com rota literal de um bloco
// opcional: cada um só chama a rota com o bloco ligado.
const GATED = {
  "components/CertificateA1.tsx": "custódia antiga não é montada: RealAccess usa a configuração do cofre externo; suas rotas continuam exigindo Fiscal",
  "components/ContactEditor.tsx": "natureza de operação só com o Fiscal ligado",
  "components/FiscalOrderTaxEstimate.tsx":
    "RealDocuments só mostra com o Fiscal ligado",
  "components/PartialInvoiceDialog.tsx":
    "abre pelas ações fiscal_* da lista de documentos, que somem sem o Fiscal",
  "components/FinanceRemittances.tsx":
    "só em /financeiro-empresa?area=remessas, endereço do bloco Cobrança",
  "components/FinanceReturns.tsx":
    "só em /financeiro-empresa?area=retornos, endereço do bloco Cobrança",
  "components/PdvCashSummary.tsx":
    "FinanceCashControl não passa a porta do PDV com o bloco desligado",
  "components/PdvOrderOrigin.tsx":
    "RealDocuments só mostra com o Caixa / PDV ligado",
  "lib/real-access.ts":
    "controlador: lista as rotas permitidas e só chama quando uma tela pede",
};
// Arquivos com rota literal externa (404 no motor) e por que nenhuma tela a chama.
const EXTERNAL = {
  "components/RealFinance.tsx":
    "conferência de origem do título desligada (ORIGIN_FINANCE_IMPORT)",
  "components/WabotiaPairing.tsx":
    "tela escondida no Wabotia (hiddenInWabotia)",
  "lib/system-updates.ts":
    "telas de atualização escondidas no Wabotia (hiddenInWabotia)",
  "lib/real-access.ts": "controlador",
};
// Clientes de rota externa que só o controlador importa (as telas saíram, item 17).
const CONTROLLER_ONLY = [
  "lib/backup-import.ts",
  "lib/financial-import-request.ts",
  "lib/itau-legacy-readiness-request.ts",
  "lib/origin-purchase-readiness-request.ts",
  "lib/origin-sales-history-request.ts",
  "lib/origin-sales-readiness-request.ts",
  "lib/origin-stock-observations-request.ts",
  "lib/origin-warehouse-import-request.ts",
  "lib/proposal-import-request.ts",
];
// Ajudantes desses clientes, sem rota literal (montam o caminho por expressão).
const CONTROLLER_HELPERS = ["lib/backup-import-client.ts"];

// Famílias fiscais do porte classificadas na aceitação. Não herdam Base.
const FISCAL_GATEWAYS = new Set([
  "/v1/a1", "/v1/a1/commands", "/v1/a1/configure", "/v1/a1/disable", "/v1/a1/rewrap",
  "/v1/fiscal-authorization", "/v1/fiscal-authorization/reviewed", "/v1/fiscal-danfe",
  "/v1/fiscal-reconciliation", "/v1/fiscal-signed", "/v1/fiscal-unsigned", "/v1/fiscal-wsdl",
]);
// Prefixo interpolado no cliente de anexos; conferir cada entidade concreta.
const literalPaths = path => path.replace(/\/$/, "") === "/v1/anexos-cadastros"
  ? ["contatos", "funcionarios", "produtos"].map(entity => `/v1/anexos-cadastros/${entity}`)
  : [path.replace(/\/$/, "")];

const APP = new URL("./app/", import.meta.url);
const sources = ["components", "lib"].flatMap((folder) =>
  readdirSync(new URL(folder, APP))
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => {
      const url = new URL(`${folder}/${name}`, APP);
      return {
        file: `${folder}/${name}`,
        id: url.pathname,
        source: readFileSync(url, "utf8"),
      };
    }),
);

test("rotas de bloco opcional ou externas só nos arquivos do bloco ou nos conferidos", () => {
  const seen = new Set(), gateways = new Set();
  for (const { file, id, source } of sources) {
    const blocks = new Set(
      [...source.matchAll(/['"`](\/v1\/[A-Za-z0-9_\-/.]+)/g)]
        .flatMap((match) => literalPaths(match[1]))
        .map((path) => {
          const block = motorBlockOf(path);
          assert.notEqual(block, null, `${file}: rota sem classificação ${path}`);
          if (FISCAL_GATEWAYS.has(path)) {
            assert.equal(block, "erp-fiscal", path);
            gateways.add(path);
          }
          return block;
        })
        .filter((block) => block !== "erp" && !["erp-produtos", "erp-vendas", "erp-compras", "erp-estoque", "erp-financeiro"].includes(block)),
    );
    const chunk = erpChunk(id) ?? "";
    for (const block of blocks) {
      if (block === "externo") {
        const allowed =
          EXTERNAL[file] ?? (CONTROLLER_ONLY.includes(file) && "controlador");
        assert.ok(allowed, `${file} chama rota externa`);
      } else if (!chunk.startsWith(`${block}-`)) {
        assert.ok(GATED[file], `${file} (${chunk}) chama rota de ${block}`);
      }
      seen.add(file);
    }
  }
  assert.deepEqual(gateways, FISCAL_GATEWAYS, "as famílias fiscais devem corresponder aos consumidores");
  for (const file of [
    ...Object.keys(GATED),
    ...Object.keys(EXTERNAL),
    ...CONTROLLER_ONLY,
  ])
    assert.ok(
      seen.has(file),
      `${file} não chama mais rota opcional ou externa: tire da lista`,
    );
});

test("famílias fiscais classificadas não fazem chamadas no painel com Fiscal desligado", async () => {
  const modules = { ...Object.fromEntries(ERP_MODULE_IDS.map(id => [id, true])), "erp-fiscal": false };
  for (const path of FISCAL_GATEWAYS) {
    assert.equal(motorBlockOf(path), "erp-fiscal", path);
    for (const method of ["GET", "POST"])
      assert.equal(await panelRequestAllowed(path, method, undefined, modules), false, `${method} ${path}`);
  }
});

test("clientes de rota externa sem tela são importados só pelo controlador", () => {
  const quiet = [...CONTROLLER_ONLY, ...CONTROLLER_HELPERS];
  for (const file of quiet) {
    const name = file.replace(/^lib\//, "").replace(/\.ts$/, "");
    const importers = sources
      .filter(
        ({ file: other, source }) =>
          other !== file &&
          new RegExp(`['"]\\.{1,2}/(lib/)?${name}(\\.ts)?['"]`).test(source),
      )
      .map(({ file: other }) => other);
    assert.deepEqual(
      importers.filter((other) => !quiet.includes(other)),
      ["lib/real-access.ts"],
      file,
    );
  }
});
