// Classificação dos blocos do ERP: a do painel (web/erp/blocks.ts, endereços
// das telas) contra a do motor (src/erp/blocks.ts, rotas da erp-api), para as
// duas não se afastarem. Enquanto o motor não está neste checkout, vale a
// cópia fixa web/erp/motor-blocks.json; com ele aqui, a cópia tem de ser igual.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { blockOf, hiddenInWabotia } from "./blocks.ts";
import { erpChunk } from "./chunks.ts";
import {
  PREFERENCE_PAGES,
  preferencePageHref,
} from "../../packages/erp-domain/src/preferences/catalog.mjs";

const pinned = JSON.parse(
  readFileSync(new URL("./motor-blocks.json", import.meta.url), "utf8"),
);
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
      )?.block ?? "erp");

test("a cópia fixa da classificação do motor é igual à do motor, quando ele está aqui", (t) => {
  if (!motor) return t.skip(`motor ausente; cópia de ${pinned.fonte}`);
  assert.deepEqual(
    JSON.parse(JSON.stringify(motor.ERP_BLOCK_PREFIXES)),
    pinned.prefixos,
    "src/erp/blocks.ts mudou: confira os pares abaixo e atualize web/erp/motor-blocks.json",
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

test("cada página de preferências fica no bloco da rota /v1/preferencias dela", () => {
  assert.ok(PREFERENCE_PAGES.length >= 20);
  for (const page of PREFERENCE_PAGES) {
    const screen = preferencePageHref(page),
      api = `/v1/preferencias/${page.id}`,
      expected = motorBlockOf(api);
    // Nenhuma página que ficou chama rota externa (o motor responde 404).
    if (expected === "externo") {
      assert.ok(hiddenInWabotia(screen), `${screen} → ${api} é externo`);
      continue;
    }
    assert.equal(blockOf(screen), expected, `${screen} → ${api}`);
  }
});

// Arquivos de grupo do núcleo (web/erp/chunks.ts) com rota literal de um bloco
// opcional: cada um só chama a rota com o bloco ligado.
const GATED = {
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
  const seen = new Set();
  for (const { file, id, source } of sources) {
    const blocks = new Set(
      [...source.matchAll(/['"`](\/v1\/[A-Za-z0-9_\-/.]+)/g)]
        .map((match) => motorBlockOf(match[1]))
        .filter((block) => block !== "erp"),
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
