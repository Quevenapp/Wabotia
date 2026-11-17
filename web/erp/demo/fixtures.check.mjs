// node --test web/erp/demo/fixtures.check.mjs
// Each fixture body passes the same validator the screen applies when it opens; then every screen is mounted with the real
// controller over fixtureRoute and must open without an unanswered GET or an error notice.
import test from "node:test";
import assert from "node:assert/strict";
import { fixtureRoute } from "./fixtures.ts";
import {
  parseProfile,
  parseStorage,
  parseNotifications,
} from "../../../packages/erp-domain/src/system-profile.mjs";
import { parsePreferencesPage } from "../../../packages/erp-domain/src/preferences/dto.mjs";
import { parseListPreferences } from "../../../packages/erp-domain/src/list-preferences.mjs";
import { parseStockPolicy } from "../../../packages/erp-domain/src/stock-opening-dto.mjs";
import { taxonomyItems } from "../app/lib/product-form-model.ts";
import { readSalesBag } from "../app/lib/sales-bag-model.ts";
import { stockWarehousePage } from "../app/lib/stock-positions-model.ts";
import { sellerOptions } from "../app/lib/finance-sellers.ts";
import { readSituations } from "../app/lib/document-situations-model.ts";
import { readListView } from "../app/lib/document-list-view-model.ts";
import { readDocumentListPage } from "../app/lib/document-list-model.ts";
import { parseStockTotals } from "../app/lib/stock-launch-model.ts";
import {
  financeListRoute,
  financeTitlePageApiPath,
  financeTitlePage,
} from "../app/lib/finance-list-route.ts";
import { referenceOptions } from "../app/lib/finance-title-drawer.ts";
import {
  contactPageQuery,
  EMPTY_LIST_FILTERS,
  EMPTY_LIST_PERIOD,
} from "../app/lib/contact-list-model.ts";
import { todaySP } from "../app/lib/real-finance-model.ts";

const actor = "b7e4c1d2-5a3f-4e8b-9c6d-2f1a0e9b8c7d";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const get = (path) => {
  const body = fixtureRoute(new URL(path, "https://erp.invalid"), actor);
  assert.notEqual(body, undefined, `no fixture for ${path}`);
  return structuredClone(body);
};

test("company chrome: perfil, armazenamento, notificações and Sistema › Interface", () => {
  const profile = parseProfile(get("/v1/sistema/perfil"));
  assert.equal(profile.user_id, actor);
  assert.equal(profile.role, "admin");
  parseStorage(get("/v1/sistema/armazenamento"));
  assert.ok(
    parseNotifications(get("/v1/sistema/notificacoes?aba=nao_lidas"), {
      tab: "nao_lidas",
    }).unread > 0,
  );
  parseNotifications(get("/v1/sistema/notificacoes?aba=todas"), {
    tab: "todas",
  });
  parsePreferencesPage(
    get("/v1/preferencias/sistema-interface"),
    "sistema-interface",
  );
});

test("preferences pages and list preferences opened by the screens", () => {
  for (const page of [
    "sistema-interface",
    "cadastros-produtos",
    "cadastros-contatos",
    "vendas-propostas",
    "vendas-vendas",
    "suprimentos-compras",
    "financas-receber",
    "financas-pagar",
  ])
    parsePreferencesPage(get(`/v1/preferencias/${page}`), page);
  for (const list of [
    "cadastros.contatos",
    "cadastros.produtos",
    "financeiro.contas_receber",
    "financeiro.contas_pagar",
  ])
    parseListPreferences(get(`/v1/preferencias-listas/${list}`), list);
});

test("cadastros: access, contacts, products and their side reads", () => {
  const access = get("/v1/cadastros");
  assert.equal(access.data_mode, "erp_native");
  assert.ok(
    access.read.includes("contacts") && access.read.includes("products"),
  );
  const query = contactPageQuery({
    page: 1,
    sort: "created_desc",
    query: "",
    type: "",
    filters: EMPTY_LIST_FILTERS,
    period: EMPTY_LIST_PERIOD,
  });
  const contacts = get(`/v1/cadastros/contatos?${query}`);
  assert.equal(contacts.entity, "contacts");
  assert.equal(contacts.page, 1);
  assert.ok(Number.isSafeInteger(contacts.total));
  assert.ok(
    contacts.items.length >= 6 &&
      contacts.items.every((item) => UUID.test(item.id)),
  );
  const products = get(
    "/v1/cadastros/products?page=1&size=100&situation=latest",
  );
  assert.equal(products.entity, "products");
  assert.equal(products.page, 1);
  assert.ok(products.items.length >= 8);
  for (const item of products.items)
    assert.match(item.stock.quantity, /^-?\d+\.\d+$/);
  const types = get("/v1/cadastros/tipos-contato");
  assert.ok(Array.isArray(types.items));
  for (const [slug, kind] of [
    ["categorias-produtos", "categories"],
    ["grupos-produtos", "product_groups"],
    ["grupos-tags", "tag_groups"],
    ["tags", "tags"],
  ])
    taxonomyItems(get(`/v1/cadastros/taxonomias/${slug}`), kind);
  const ids = contacts.items.map((item) => item.id);
  const tags = get(
    `/v1/cadastros/contatos/tags?ids=${encodeURIComponent(ids.join(","))}`,
  );
  assert.deepEqual(
    tags.items.map((set) => set.contact_id),
    ids,
  );
  for (const set of tags.items)
    assert.ok(
      Number.isInteger(set.version) &&
        Array.isArray(set.tag_ids) &&
        Array.isArray(set.tags),
    );
  assert.ok(Array.isArray(get("/v1/cadastros/listas-precos").items));
  readSalesBag(get("/v1/documentos/sacola-vendas"));
  assert.equal(
    stockWarehousePage(get("/v1/posicoes-estoque/depositos?limit=100")).items
      .length,
    2,
  );
  assert.ok(sellerOptions(get("/v1/cadastros/vendedores/opcoes")).length > 0);
  const warehouses = get("/v1/cadastros/warehouses?limit=100");
  assert.ok(Array.isArray(warehouses.items) && warehouses.has_more === false);
});

test("documentos: access, situações, listagem and the proposal and order lists", () => {
  const access = get("/v1/documentos");
  assert.equal(access.data_mode, "erp_native");
  assert.equal(access.operational_effects, false);
  for (const kind of ["sales_proposals", "sales_orders", "purchase_orders"]) {
    readSituations(get(`/v1/documentos/${kind}/situacoes`), kind);
    if (kind !== "purchase_orders")
      readListView(get(`/v1/documentos/${kind}/preferencias-listagem`), kind);
    const page = readDocumentListPage(
      get(`/v1/documentos/${kind}?limit=100&page=1`),
      kind,
      1,
      "date_desc",
    );
    assert.ok(page.items.length >= 3 && page.items.length <= 5, kind);
  }
});

test("estoque: política de estoque and totals (all warehouses and each warehouse)", () => {
  parseStockPolicy(get("/v1/politica-estoque"));
  const totals = parseStockTotals(get("/v1/estoque/totais"), null);
  for (const warehouse of totals.warehouses)
    parseStockTotals(
      get(`/v1/estoque/totais?warehouse_id=${warehouse.id}`),
      warehouse.id,
    );
});

test("financeiro: access, title pages of every Opção and the account and category options", () => {
  const access = get("/v1/financeiro");
  assert.equal(access.read, true);
  assert.equal(typeof access.write, "boolean");
  const today = todaySP();
  for (const area of ["receivable", "payable"])
    for (const option of ["open", "overdue", "issued", "settled"])
      for (const order of ["due_asc", "due_desc"]) {
        const route = financeListRoute(
          new URLSearchParams({ area, opcao: option, order }),
        );
        const page = financeTitlePage(
          get(financeTitlePageApiPath(route, today)),
          route,
          today,
        );
        if (option === "open")
          assert.ok(page.items.length >= 4 && page.items.length <= 6, area);
      }
  referenceOptions(get("/v1/financeiro/accounts?limit=100"), "accounts", null);
  referenceOptions(
    get("/v1/financeiro/categories?limit=100"),
    "categories",
    null,
  );
});

test("no QA marker strings and only lowercase v4 uuids", () => {
  const bodies = [
    "/v1/sistema/perfil",
    "/v1/cadastros/contatos?page=1",
    "/v1/cadastros/products?page=1",
    "/v1/documentos/sales_orders?page=1",
    "/v1/financeiro/titles?page=1&kind=receivable&option=issued",
    "/v1/estoque/totais",
  ]
    .map((path) => JSON.stringify(get(path)))
    .join("");
  assert.doesNotMatch(
    bodies,
    /QA_SYNTHETIC_|qa-synthetic|LOCAL_QA_ONLY|senha-de-teste|brufap\.erp\.demo\./,
  );
  for (const id of bodies.match(
    /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
  ))
    assert.match(id, id === actor ? /./ : UUID);
});

// End to end: the screen components with the real controller (web/erp/app/lib/real-access.ts) over fixtureRoute.
const SCREENS = [
  [
    "RealCatalog.tsx",
    "/cadastros-reais?cadastro=contacts",
    { initialEntity: "contacts" },
    /6 cadastros encontrados|Colégio Monteiro Lobato/,
  ],
  [
    "RealCatalog.tsx",
    "/cadastros-reais?cadastro=products",
    { initialEntity: "products" },
    /Caderno universitário/,
  ],
  [
    "RealDocuments.tsx",
    "/documentos-empresa?tipo=sales_proposals",
    { initialKind: "sales_proposals" },
    /1042/,
  ],
  [
    "RealDocuments.tsx",
    "/documentos-empresa?tipo=sales_orders",
    { initialKind: "sales_orders" },
    /2318/,
  ],
  ["RealStock.tsx", "/estoque-empresa", {}, /Valor de Venda do Estoque/],
  [
    "RealFinance.tsx",
    "/financeiro-empresa?area=receivable",
    { initialTab: "receivable" },
    /Escritório Contábil Paulista/,
  ],
  [
    "RealFinance.tsx",
    "/financeiro-empresa?area=payable",
    { initialTab: "payable" },
    /Aluguel da loja/,
  ],
];
test(
  "screens open with their normal content (no unanswered GET, no error notice)",
  { timeout: 300000 },
  async () => {
    const { mountComponent } =
      await import("../test/helpers/component-recovery-harness.mjs");
    const { createAccessController } =
      await import("../app/lib/real-access.ts");
    globalThis.window ??= {
      addEventListener() {},
      removeEventListener() {},
      open() {},
      matchMedia: () => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
      }),
    };
    globalThis.document ??= {
      activeElement: null,
      documentElement: { dataset: {} },
      addEventListener() {},
      removeEventListener() {},
      querySelector: () => null,
      getElementById: () => null,
      body: { append() {}, classList: { add() {}, remove() {} } },
    };
    for (const [file, location, props, expected] of SCREENS) {
      const missing = [];
      const auth = {
        getSession: async () => ({
          data: { session: { access_token: "demo", user: { id: actor } } },
          error: null,
        }),
        onAuthStateChange: () => ({
          data: { subscription: { unsubscribe() {} } },
        }),
        signOut: async () => ({ error: null }),
      };
      const fetcher = async (input, init = {}) => {
        const url = new URL(input);
        if (url.pathname === "/v1/me")
          return Response.json({
            user_id: actor,
            role: "admin",
            resources: [
              "contacts",
              "products",
              "sales_orders",
              "purchase_orders",
              "sales_proposals",
              "receivables",
              "payables",
            ],
            data_mode: "staging_readonly",
            capabilities: {
              originIntegration: false,
              originHistory: false,
              originConnection: false,
            },
          });
        const body =
          (init.method ?? "GET") === "GET"
            ? fixtureRoute(url, actor)
            : undefined;
        if (body === undefined) {
          missing.push(`${init.method ?? "GET"} ${url.pathname}${url.search}`);
          return Response.json(
            { error: { code: "ERP_SIMULATED_MISSING" } },
            { status: 404 },
          );
        }
        return Response.json(body);
      };
      const controller = createAccessController(
        auth,
        "https://erp.invalid",
        fetcher,
      );
      const stop = controller.start();
      for (let i = 0; i < 50 && controller.getSnapshot().phase !== "ready"; i++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(controller.getSnapshot().phase, "ready");
      const view = await mountComponent(
        file,
        { controller, ...props },
        { location, expandChildren: true },
      );
      try {
        await new Promise((resolve) => setTimeout(resolve, 30));
        await view.flush();
        const text = view.text();
        assert.deepEqual(missing, [], `${location}: unanswered GET`);
        assert.doesNotMatch(
          text,
          /Não foi possível|indisponível|access_request_failed|Tentar novamente/,
          location,
        );
        assert.match(text, expected, location);
      } finally {
        view.unmount();
        stop?.();
      }
    }
  },
);
