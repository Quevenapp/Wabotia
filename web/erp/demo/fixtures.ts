// Respostas fictícias (papelaria) das telas do ERP que ainda não tinham simulação: barra da empresa, Cadastros,
// Documentos, Estoque, Financeiro e Preferências. Cada corpo segue o validador que a tela usa ao abrir
// (web/erp/app/lib/*-model.ts e packages/erp-domain/src/*.mjs); conferido por fixtures.check.mjs.
import { storedPreferencePage } from "../../../packages/erp-domain/src/preferences/catalog.mjs";
import {
  storedFields,
  preferenceClone,
} from "../../../packages/erp-domain/src/preferences/core.mjs";
import {
  pageHasDirectory,
  pageSituationKinds,
} from "../../../packages/erp-domain/src/preferences/dto.mjs";

const TZ = "America/Sao_Paulo";
const today = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T12:00:00Z`) + days * 86400000)
    .toISOString()
    .slice(0, 10);
/** Instante ISO (UTC) de um dia de São Paulo, às `hour` horas locais (UTC-3). */
const at = (day: string, hour = 9, minute = 0) =>
  new Date(
    Date.parse(`${day}T00:00:00Z`) + ((hour + 3) * 60 + minute) * 60000,
  ).toISOString();

/** UUID v4 estável para cada nome (mesmo id em todas as respostas). */
function uid(name: string) {
  let h = 2166136261;
  for (const c of `papelaria:${name}`)
    h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  let s = h >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) & 15;
  };
  const hex = (n: number) =>
    Array.from({ length: n }, () => next().toString(16)).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${"89ab"[next() & 3]}${hex(3)}-${hex(12)}`;
}

const NATIVE = { data_mode: "erp_native" } as const;

// ---------------------------------------------------------------- Barra da empresa

function profile(actor: string) {
  return {
    scope: "access_profile",
    ...NATIVE,
    user_id: actor,
    role: "admin",
    name: "Marina Albuquerque",
    email: "marina@papelariaestrela.com.br",
    company: {
      legal_name: "Papelaria Estrela do Bairro Ltda",
      trade_name: "Papelaria Estrela",
    },
  };
}

function storage() {
  const groups = [
    ["anexos", "18874368", 42],
    ["fiscal", "7340032", 96],
    ["cobranca", "524288", 6],
    ["backup", "0", 0],
    ["certificado", "8192", 1],
    ["outros", "1048576", 3],
  ] as const;
  return {
    scope: "storage_usage",
    ...NATIVE,
    total_bytes: String(groups.reduce((t, g) => t + Number(g[1]), 0)),
    objects: groups.reduce((t, g) => t + g[2], 0),
    limit_bytes: "1073741824",
    groups: groups.map(([group, bytes, objects]) => ({
      group,
      bytes,
      objects,
    })),
    as_of: new Date().toISOString(),
  };
}

function notifications(tab: string) {
  const day = today();
  const items = [
    {
      id: "41",
      type: "contas_receber_atrasadas",
      day,
      quantity: 2,
      amount: "679.95",
      created_at: at(day, 7),
      read: false,
    },
    {
      id: "40",
      type: "estoque_abaixo_minimo",
      day,
      quantity: 2,
      amount: null,
      created_at: at(day, 7),
      read: false,
    },
    {
      id: "38",
      type: "pagamento_recebido",
      day: addDays(day, -2),
      quantity: 1,
      amount: "64.30",
      created_at: at(addDays(day, -2), 18),
      read: true,
    },
  ];
  const shown = tab === "todas" ? items : items.filter((n) => !n.read);
  return {
    scope: "notifications",
    ...NATIVE,
    tab,
    role: "admin",
    business_date: day,
    unread: items.filter((n) => !n.read).length,
    items: shown,
  };
}

// ---------------------------------------------------------------- Preferências

/**
 * Padrões do motor que diferem do catálogo do Fagoo (src/erp/schema/deviations.ts, decisão de 16/11):
 * 2 casas para preço e quantidade. Vão como valor gravado (versão 1): na versão 0 o validador da tela
 * só aceita o padrão do catálogo.
 */
const MOTOR_DEFAULTS: Record<string, unknown> = {
  "empresa.decimais_quantidade": 2,
  "empresa.decimais_preco_entrada": 2,
  "empresa.decimais_preco_saida": 2,
};

/** GET /v1/preferencias/:página com os valores padrão (do motor ou do catálogo; nada salvo ainda). */
function preferencesPage(pageId: string, actor: string) {
  const page = storedPreferencePage(pageId);
  if (!page) return undefined;
  const kinds = pageSituationKinds(page);
  return {
    scope: "preferences_page",
    ...NATIVE,
    page: page.id,
    owner: page.scope,
    role: "admin",
    can_manage: true,
    items: storedFields(page).map((f: { key: string; default: unknown }) =>
      Object.hasOwn(MOTOR_DEFAULTS, f.key)
        ? {
            key: f.key,
            value: MOTOR_DEFAULTS[f.key],
            version: 1,
            updated_at: "2026-11-16T12:00:00.000Z",
          }
        : {
            key: f.key,
            value: preferenceClone(f.default),
            version: 0,
            updated_at: null,
          },
    ),
    directory: pageHasDirectory(page)
      ? [{ user_id: actor, role: "admin", label: "Marina Albuquerque" }]
      : null,
    ...(kinds.length ? { situations: [] } : {}),
  };
}

/** GET /v1/preferencias-listas/:lista: listagem padrão (nada salvo). */
const listPreferences = (listId: string) => ({
  scope: "list_preferences",
  ...NATIVE,
  list_id: listId,
  version: 0,
  columns: null,
  filters: null,
  updated_at: null,
});

// ---------------------------------------------------------------- Cadastros

const created = (daysAgo: number) => at(addDays(today(), -daysAgo), 10);

const CONTACTS = [
  {
    key: "c1",
    name: "Colégio Monteiro Lobato",
    code: "CLI-001",
    trade_name: "Colégio Monteiro Lobato",
    person_type: "J",
    document: "47.381.526/0001-22",
    email: "compras@colegiomonteiro.edu.br",
    phone: "(11) 3271-4410",
    mobile: null,
    city: "São Paulo",
    state: "SP",
    roles: ["customer"],
    days: 210,
  },
  {
    key: "c2",
    name: "Escritório Contábil Paulista",
    code: "CLI-002",
    trade_name: "Contábil Paulista",
    person_type: "J",
    document: "28.094.673/0001-77",
    email: "financeiro@contabilpaulista.com.br",
    phone: "(11) 3051-2288",
    mobile: "(11) 98412-3301",
    city: "São Paulo",
    state: "SP",
    roles: ["customer"],
    days: 160,
  },
  {
    key: "c3",
    name: "Juliana Ferreira Santos",
    code: "CLI-003",
    trade_name: null,
    person_type: "F",
    document: "318.406.725-44",
    email: "juliana.fs@email.com.br",
    phone: null,
    mobile: "(11) 97155-0842",
    city: "Osasco",
    state: "SP",
    roles: ["customer"],
    days: 95,
  },
  {
    key: "c4",
    name: "Ricardo Almeida Prado",
    code: "CLI-004",
    trade_name: null,
    person_type: "F",
    document: "742.159.380-23",
    email: null,
    phone: null,
    mobile: "(11) 99630-1175",
    city: "São Paulo",
    state: "SP",
    roles: ["customer"],
    days: 40,
  },
  {
    key: "s1",
    name: "Distribuidora Papel & Cia Ltda",
    code: "FOR-001",
    trade_name: "Papel & Cia",
    person_type: "J",
    document: "61.503.729/0001-75",
    email: "vendas@papelecia.com.br",
    phone: "(11) 2408-5520",
    mobile: null,
    city: "Guarulhos",
    state: "SP",
    roles: ["supplier"],
    days: 300,
  },
  {
    key: "s2",
    name: "Canetas Brasil Indústria e Comércio",
    code: "FOR-002",
    trade_name: "Canetas Brasil",
    person_type: "J",
    document: "39.472.158/0001-08",
    email: "pedidos@canetasbrasil.com.br",
    phone: "(19) 3422-7700",
    mobile: null,
    city: "Campinas",
    state: "SP",
    roles: ["supplier"],
    days: 280,
  },
  {
    key: "s3",
    name: "Imobiliária Jardim das Flores Ltda",
    code: "FOR-003",
    trade_name: "Imobiliária Jardim das Flores",
    person_type: "J",
    document: "52.618.394/0001-40",
    email: "aluguel@jardimdasflores.com.br",
    phone: "(11) 3884-6120",
    mobile: null,
    city: "São Paulo",
    state: "SP",
    roles: ["supplier"],
    days: 330,
  },
];

function contactRow(c: (typeof CONTACTS)[number]) {
  const stamp = created(c.days);
  return {
    id: uid(`contato:${c.key}`),
    entity: "contacts",
    version: 2,
    active: true,
    situation: "A",
    name: c.name,
    code: c.code,
    trade_name: c.trade_name,
    person_type: c.person_type,
    document: c.document,
    email: c.email,
    phone: c.phone,
    mobile: c.mobile,
    city: c.city,
    state: c.state,
    roles: c.roles,
    types: c.roles,
    crt: null,
    seller_id: null,
    seller_name: null,
    next_visit: null,
    is_seller: false,
    created_at: stamp,
    updated_at: stamp,
    source: null,
  };
}

const PRODUCTS = [
  {
    key: "p1",
    name: "Caderno universitário 10 matérias 200 folhas",
    code: "CAD-200",
    unit: "UN",
    price: "32.9000",
    cost: "18.4000",
    gtin: "7891234567895",
    stock: "48.000000",
    min: "10.000000",
    days: 200,
  },
  {
    key: "p2",
    name: "Caneta esferográfica azul 1.0 mm (cx 50)",
    code: "CAN-AZ50",
    unit: "CX",
    price: "54.0000",
    cost: "29.5000",
    gtin: null,
    stock: "12.000000",
    min: "5.000000",
    days: 190,
  },
  {
    key: "p3",
    name: "Papel sulfite A4 75 g (resma 500 folhas)",
    code: "SUL-A4",
    unit: "RS",
    price: "29.9000",
    cost: "21.7000",
    gtin: null,
    stock: "85.000000",
    min: "30.000000",
    days: 185,
  },
  {
    key: "p4",
    name: "Lápis preto nº 2 (cx 12)",
    code: "LAP-HB12",
    unit: "CX",
    price: "14.5000",
    cost: "7.2000",
    gtin: null,
    stock: "3.000000",
    min: "8.000000",
    days: 150,
  },
  {
    key: "p5",
    name: "Borracha branca macia",
    code: "BOR-01",
    unit: "UN",
    price: "2.5000",
    cost: "0.9000",
    gtin: null,
    stock: "140.000000",
    min: "40.000000",
    days: 120,
  },
  {
    key: "p6",
    name: "Pasta catálogo 50 envelopes",
    code: "PAS-CAT50",
    unit: "UN",
    price: "24.9000",
    cost: "13.1000",
    gtin: null,
    stock: "17.000000",
    min: "6.000000",
    days: 90,
  },
  {
    key: "p7",
    name: "Grampeador de mesa 26/6",
    code: "GRA-266",
    unit: "UN",
    price: "39.9000",
    cost: "22.0000",
    gtin: null,
    stock: "0.000000",
    min: "4.000000",
    days: 60,
  },
  {
    key: "p8",
    name: "Marca-texto amarelo",
    code: "MAR-AM",
    unit: "UN",
    price: "4.9000",
    cost: "2.1000",
    gtin: null,
    stock: "66.000000",
    min: "20.000000",
    days: 30,
  },
];
const WAREHOUSE_ID = uid("deposito:loja");

function productRow(p: (typeof PRODUCTS)[number]) {
  const stamp = created(p.days);
  return {
    id: uid(`produto:${p.key}`),
    entity: "products",
    version: 3,
    active: true,
    name: p.name,
    code: p.code,
    unit: p.unit,
    price: p.price,
    kind: "P",
    format: "S",
    gtin: p.gtin,
    created_at: stamp,
    updated_at: stamp,
    source: null,
    stock: { state: "recorded", quantity: p.stock, warehouse: null },
    stock_min: p.min,
    stock_max: null,
    thumbnail: null,
    deleted: false,
    cost_price: p.cost,
    location: null,
    category_id: null,
    expiry_date: null,
  };
}

function catalogPage(entity: "contacts" | "products", q: URLSearchParams) {
  const all =
    entity === "contacts" ? CONTACTS.map(contactRow) : PRODUCTS.map(productRow);
  // Seletores (?limit=&q=) leem a lista por cursor; a listagem lê páginas numeradas de 100.
  if (!q.has("page") && q.has("limit")) {
    const text = (q.get("q") ?? "").toLocaleLowerCase("pt-BR");
    const found = all.filter(
      (r) =>
        !text ||
        `${r.name} ${r.code ?? ""}`.toLocaleLowerCase("pt-BR").includes(text),
    );
    return {
      entity,
      items: found,
      next_cursor: null,
      has_more: false,
      limit: Number(q.get("limit")),
      ...NATIVE,
    };
  }
  const page = Number(q.get("page") ?? "1") || 1;
  const items = page === 1 ? all : [];
  return entity === "contacts"
    ? {
        entity,
        items,
        page,
        size: 100,
        total: all.length,
        sort: q.get("sort") || "created_desc",
        situation: q.get("situation") || "latest",
        scoped: false,
        ...NATIVE,
      }
    : {
        entity,
        items,
        page,
        size: 100,
        total: all.length,
        sort: q.get("sort") || "created_desc",
        stock_visible: true,
        ...NATIVE,
      };
}

const CONTACT_TYPES = [
  ["customer", "Cliente"],
  ["developer", "Desenvolvedor"],
  ["supplier", "Fornecedor"],
  ["default", "Padrao"],
  ["technician", "Técnico"],
  ["carrier", "Transportador"],
  ["seller", "Vendedor"],
].map(([slug, label], i) => ({
  id: uid(`tipo-contato:${slug}`),
  slug,
  label,
  system: true,
  deletable: false,
  position: i + 1,
  contacts: CONTACTS.filter((c) => c.roles.includes(slug!)).length,
}));

const TAXONOMY_KINDS: Record<string, string> = {
  "categorias-produtos": "categories",
  "grupos-produtos": "product_groups",
  "grupos-tags": "tag_groups",
  tags: "tags",
};
const TAXONOMY_NAMES: Record<string, string[]> = {
  categories: ["Cadernos e blocos", "Escrita", "Papéis", "Escritório"],
  product_groups: ["Material escolar", "Material de escritório"],
  tag_groups: [],
  tags: ["Volta às aulas", "Mais vendidos"],
};
function taxonomy(slug: string) {
  const kind = TAXONOMY_KINDS[slug];
  if (!kind) return undefined;
  const stamp = created(250);
  return {
    kind,
    items: TAXONOMY_NAMES[kind]!.map((name) => ({
      id: uid(`taxonomia:${kind}:${name}`),
      kind,
      parent_id: null,
      name,
      version: 1,
      created_at: stamp,
      updated_at: stamp,
      children: 0,
      products: 0,
      contacts: 0,
      ...(kind === "tags" || kind === "tag_groups"
        ? { tag_type: "products" }
        : { tag_type: null }),
    })),
    ...NATIVE,
  };
}

/** Depósitos em ordem de id, como /v1/posicoes-estoque/depositos responde. */
const WAREHOUSES = [
  { id: WAREHOUSE_ID, name: "Loja", active: true },
  { id: uid("deposito:fundos"), name: "Depósito dos fundos", active: true },
].sort((a, b) => (a.id < b.id ? -1 : 1));

function warehouseRecords(q: URLSearchParams) {
  const stamp = created(320);
  const items = WAREHOUSES.map((w, i) => ({
    id: w.id,
    entity: "warehouses",
    version: 1,
    active: w.active,
    name: w.name,
    code: `DEP-${i + 1}`,
    description: null,
    created_at: stamp,
    updated_at: stamp,
    source: null,
  }));
  if (q.has("page")) {
    const page = Number(q.get("page")) || 1;
    return {
      entity: "warehouses",
      items: page === 1 ? items : [],
      page,
      size: 100,
      total: items.length,
      sort: q.get("sort") || "created_desc",
      ...NATIVE,
    };
  }
  return {
    entity: "warehouses",
    items,
    next_cursor: null,
    has_more: false,
    limit: Number(q.get("limit")) || 25,
    ...NATIVE,
  };
}

const SELLERS = [
  { id: uid("vendedor:marina"), name: "Marina Albuquerque", code: "V01" },
  { id: uid("vendedor:tiago"), name: "Tiago Nogueira", code: "V02" },
];

// ---------------------------------------------------------------- Estoque

/** Produto de duas casas decimais de quantidade × preço, em centavos. */
const productCents = (quantity: string, price: string) =>
  Math.round(Number(quantity) * Number(price) * 100);
const centsText = (cents: number) =>
  `${cents < 0 ? "-" : ""}${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;

function stockTotals(warehouseId: string | null) {
  // Todo o saldo está na Loja; o depósito dos fundos ainda não tem lançamentos.
  const inShop = warehouseId === null || warehouseId === WAREHOUSE_ID;
  const qty = inShop ? PRODUCTS.reduce((t, p) => t + Number(p.stock), 0) : 0;
  return {
    scope: "stock_totals",
    ...NATIVE,
    warehouse_id: warehouseId,
    quantity: `${qty}.000000`,
    sale_value: centsText(
      inShop
        ? PRODUCTS.reduce((t, p) => t + productCents(p.stock, p.price), 0)
        : 0,
    ),
    unpriced_products: 0,
    ignored_warehouses: 0,
    warehouses: WAREHOUSES.map((w) => ({
      ...w,
      is_default: w.id === WAREHOUSE_ID,
      ignore_balance: false,
    })),
    cost_visible: true,
    cost_value: centsText(
      inShop
        ? PRODUCTS.reduce((t, p) => t + productCents(p.stock, p.cost), 0)
        : 0,
    ),
    uncosted_products: 0,
    cost_basis: "preco_compra",
  };
}

// ---------------------------------------------------------------- Documentos

type DocKind = "sales_proposals" | "sales_orders" | "purchase_orders";
const contactByKey = (key: string) => {
  const c = CONTACTS.find((x) => x.key === key)!;
  return { id: uid(`contato:${c.key}`), name: c.name };
};
// [número, dias atrás, situação, total, contato, vence/próximo contato em dias]
const DOCUMENTS: Record<DocKind, [string, number, string, string, string][]> = {
  sales_proposals: [
    ["1042", 1, "open", "1874.00", "c1"],
    ["1041", 3, "waiting", "642.50", "c2"],
    ["1040", 6, "approved", "2310.80", "c1"],
    ["1039", 12, "rejected", "158.40", "c3"],
  ],
  sales_orders: [
    ["2318", 0, "open", "289.70", "c4"],
    ["2317", 1, "in_progress", "1187.90", "c2"],
    ["2316", 2, "fulfilled", "64.30", "c3"],
    ["2315", 4, "fulfilled", "2310.80", "c1"],
    ["2314", 7, "cancelled", "47.80", "c4"],
  ],
  purchase_orders: [
    ["315", 2, "open", "3260.00", "s1"],
    ["314", 9, "fulfilled", "1475.00", "s2"],
    ["313", 21, "fulfilled", "2890.50", "s1"],
  ],
};

function documentRows(kind: DocKind) {
  const day = today();
  return DOCUMENTS[kind].map(([number, daysAgo, status, total, contact]) => {
    const date = addDays(day, -daysAgo),
      stamp = at(date, 11),
      c = contactByKey(contact);
    const done = status === "fulfilled" || status === "in_progress";
    return {
      id: uid(`documento:${kind}:${number}`),
      kind,
      number,
      version: 2,
      status,
      date,
      total,
      contact_id: c.id,
      contact_name: c.name,
      created_at: stamp,
      updated_at: stamp,
      expected_date: kind === "sales_proposals" ? addDays(date, 15) : null,
      next_contact:
        kind === "sales_proposals" && status === "open"
          ? addDays(day, 2)
          : null,
      template: false,
      warehouse_id: kind === "sales_proposals" ? null : WAREHOUSE_ID,
      warehouse_name: kind === "sales_proposals" ? null : "Loja",
      source_proposal_id:
        kind === "sales_orders" && number === "2315"
          ? uid("documento:sales_proposals:1040")
          : null,
      source_proposal_number:
        kind === "sales_orders" && number === "2315" ? "1040" : null,
      finance_active: kind !== "sales_proposals" && done,
      stock_active: kind === "sales_orders" && done,
      receipt_active: kind === "purchase_orders" && done,
      reservation_active: kind === "sales_proposals" ? null : false,
      fiscal_draft: null,
      internal_notes: null,
      situation: null,
      invoice_linked: false,
      version_label: null,
    };
  });
}

function documentList(kind: DocKind, q: URLSearchParams) {
  const page = Number(q.get("page") ?? "1") || 1,
    all = documentRows(kind);
  const cents = all.reduce((t, r) => t + Math.round(Number(r.total) * 100), 0);
  return {
    kind,
    items: page === 1 ? all : [],
    limit: Number(q.get("limit")) || 100,
    page,
    order: q.get("order") || "date_desc",
    has_more: false,
    next_cursor: null,
    total_count: all.length,
    total_amount: `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`,
    ...NATIVE,
    operational_effects: false,
  };
}

const LIST_COLUMNS = [
  "date",
  "contact",
  "total",
  "customer_po_number",
  "address",
  "ship_date",
  "contact_email",
  "contact_phone",
  "contact_document",
  "carrier_name",
];
const listView = (kind: DocKind) => ({
  kind,
  custom_view: false,
  columns: ["date", "contact", "total"],
  default_statuses: [],
  statuses_saved: false,
  available_columns: LIST_COLUMNS,
  column_limit: 8,
  version: 0,
  ...NATIVE,
  operational_effects: false,
});
const situations = (kind: DocKind) => ({
  kind,
  adopted: false,
  situations: [],
  transitions: [],
  occurrence_date_editable: false,
  ...NATIVE,
});

// ---------------------------------------------------------------- Financeiro

const byId = <T extends { id: string }>(items: T[]) =>
  [...items].sort((a, b) => (a.id < b.id ? -1 : 1));
const ACCOUNTS = byId([
  {
    id: uid("conta:caixa"),
    name: "Caixa da loja",
    kind: "cash",
    active: true,
    opening_recorded: true,
    version: 4,
    balance_cents: "84250",
  },
  {
    id: uid("conta:banco"),
    name: "Conta corrente",
    kind: "bank",
    active: true,
    opening_recorded: true,
    version: 9,
    balance_cents: "1623475",
  },
  {
    id: uid("conta:maquininha"),
    name: "Recebíveis de cartão",
    kind: "other",
    active: true,
    opening_recorded: true,
    version: 3,
    balance_cents: "135350",
  },
]);
const accountName = (key: string) =>
  ACCOUNTS.find((a) => a.id === uid(`conta:${key}`))!.name;
const CATEGORIES = byId(
  [
    ["Vendas de mercadorias", "receivable"],
    ["Serviços de impressão e cópias", "receivable"],
    ["Compra de mercadorias", "payable"],
    ["Aluguel", "payable"],
    ["Energia elétrica", "payable"],
    ["Tarifas bancárias", "both"],
  ].map(([name, kind]) => ({
    id: uid(`categoria:${name}`),
    name: name!,
    kind: kind!,
    active: true,
    version: 1,
  })),
);
const category = (name: string) => ({
  category_id: uid(`categoria:${name}`),
  category_name: name,
});

type TitleSpec = {
  key: string;
  contact: string;
  category: string;
  description: string;
  issued: number;
  due: number;
  amount: number;
  paid?: boolean;
  account: string;
  doc?: [DocKind, string];
  installment?: [number, number];
};
// Dias relativos a hoje (negativo: passado). Valores em centavos.
const TITLES: Record<"receivable" | "payable", TitleSpec[]> = {
  receivable: [
    {
      key: "r1",
      contact: "c2",
      category: "Vendas de mercadorias",
      description: "Pedido de venda 2317 - parcela 1/2",
      issued: -19,
      due: -12,
      amount: 59395,
      account: "banco",
      doc: ["sales_orders", "2317"],
      installment: [1, 2],
    },
    {
      key: "r2",
      contact: "c3",
      category: "Serviços de impressão e cópias",
      description: "Encadernação e cópias - TCC",
      issued: -10,
      due: -3,
      amount: 8600,
      account: "caixa",
    },
    {
      key: "r3",
      contact: "c1",
      category: "Vendas de mercadorias",
      description: "Pedido de venda 2315 - lista de material",
      issued: -4,
      due: 0,
      amount: 231080,
      account: "banco",
      doc: ["sales_orders", "2315"],
    },
    {
      key: "r4",
      contact: "c2",
      category: "Vendas de mercadorias",
      description: "Pedido de venda 2317 - parcela 2/2",
      issued: -19,
      due: 11,
      amount: 59395,
      account: "banco",
      doc: ["sales_orders", "2317"],
      installment: [2, 2],
    },
    {
      key: "r5",
      contact: "c4",
      category: "Vendas de mercadorias",
      description: "Pedido de venda 2318",
      issued: 0,
      due: 21,
      amount: 28970,
      account: "maquininha",
      doc: ["sales_orders", "2318"],
    },
    {
      key: "r6",
      contact: "c3",
      category: "Vendas de mercadorias",
      description: "Pedido de venda 2316",
      issued: -2,
      due: -2,
      amount: 6430,
      account: "caixa",
      doc: ["sales_orders", "2316"],
      paid: true,
    },
  ],
  payable: [
    {
      key: "p1",
      contact: "s1",
      category: "Compra de mercadorias",
      description: "Pedido de compra 314 - papéis e cadernos",
      issued: -9,
      due: -1,
      amount: 147500,
      account: "banco",
      doc: ["purchase_orders", "314"],
    },
    {
      key: "p2",
      contact: "s2",
      category: "Compra de mercadorias",
      description: "Reposição de canetas e marca-textos",
      issued: -6,
      due: 4,
      amount: 86340,
      account: "banco",
    },
    {
      key: "p3",
      contact: "s3",
      category: "Aluguel",
      description: "Aluguel da loja",
      issued: -15,
      due: 9,
      amount: 380000,
      account: "banco",
    },
    {
      key: "p4",
      contact: "s2",
      category: "Compra de mercadorias",
      description: "Etiquetas e bobinas para a impressora",
      issued: -3,
      due: 14,
      amount: 41275,
      account: "banco",
    },
    {
      key: "p5",
      contact: "s1",
      category: "Compra de mercadorias",
      description: "Pedido de compra 313",
      issued: -21,
      due: -5,
      amount: 289050,
      account: "banco",
      doc: ["purchase_orders", "313"],
      paid: true,
    },
  ],
};

function titleRows(kind: "receivable" | "payable") {
  const day = today();
  return TITLES[kind].map((t) => {
    const issued = addDays(day, t.issued),
      due = addDays(day, t.due),
      c = contactByKey(t.contact);
    const balance = t.paid ? 0 : t.amount;
    return {
      id: uid(`titulo:${t.key}`),
      group_id: uid(`titulo-grupo:${t.doc ? t.doc.join(":") : t.key}`),
      installment: t.installment?.[0] ?? 1,
      installments: t.installment?.[1] ?? 1,
      kind,
      contact_id: c.id,
      contact_name: c.name,
      ...category(t.category),
      description: t.description,
      source_reference: null,
      issued_on: issued,
      due_on: due,
      competence_on: issued,
      amount_cents: String(t.amount),
      settled_cents: String(t.amount - balance),
      balance_cents: String(balance),
      cancelled: false,
      version: t.paid ? 2 : 1,
      status: t.paid ? "paid" : "open",
      overdue: !t.paid && due < day,
      document_linked: Boolean(t.doc),
      origin: t.doc
        ? {
            document_id: uid(`documento:${t.doc[0]}:${t.doc[1]}`),
            kind: t.doc[0],
            number: t.doc[1],
          }
        : null,
      account_id: uid(`conta:${t.account}`),
      account_name: accountName(t.account),
      bank_number: null,
      interest_month_bp: null,
      penalty_bp: null,
      original_due_on: null,
      deleted_at: null,
      recurrence_id: null,
      payment_method_id: null,
      payment_method_name: null,
      payment_fee_cents: null,
      grouped_billing_id: null,
      payment_type: null,
      seller_id: null,
      seller_name: null,
      seller_source: null,
      long_history: false,
      seller_cleared: false,
      returned: false,
      imported: false,
      remittance: null,
      payments: {
        settled_on: t.paid ? due : null,
        fee_cents: "0",
        interest_cents: "0",
        penalty_cents: "0",
        discount_cents: "0",
        settled_by_return: false,
      },
    };
  });
}

/** GET /v1/financeiro/titles em modo página (SQL 109): Opção, período, situação e os demais filtros da URL. */
function titlePage(q: URLSearchParams) {
  const kind = q.get("kind") === "payable" ? "payable" : "receivable";
  const option = q.get("option") || "open",
    order = q.get("order") || "due_asc",
    page = Number(q.get("page")) || 1;
  const from = q.get("from") ?? "",
    to = q.get("to") ?? "",
    field =
      option === "issued"
        ? q.get("date") || "due"
        : option === "settled"
          ? "settled"
          : "due";
  const statuses = (q.get("status") ?? "").split(",").filter(Boolean),
    categories = (q.get("category") ?? "").split(",").filter(Boolean);
  const text = (q.get("q") ?? "").toLocaleLowerCase("pt-BR");
  const rows = titleRows(kind)
    .filter((t) => {
      const open = !t.cancelled && t.balance_cents !== "0";
      const dayOf =
        field === "issued"
          ? t.issued_on
          : field === "due"
            ? t.due_on
            : field === "competence"
              ? t.competence_on
              : null;
      if (dayOf !== null && ((from && dayOf < from) || (to && dayOf > to)))
        return false;
      if (option === "open" && !open) return false;
      if (option === "overdue" && (!open || !t.overdue)) return false;
      if (option === "settled" && t.payments.settled_on === null) return false;
      if (statuses.length && !statuses.includes(t.status)) return false;
      if (
        categories.length &&
        !categories.some((c) =>
          c === "none" ? t.category_id === null : t.category_id === c,
        )
      )
        return false;
      const account = q.get("account");
      if (
        account &&
        (account === "none" ? t.account_id !== null : t.account_id !== account)
      )
        return false;
      if (q.get("amount_cents") && t.amount_cents !== q.get("amount_cents"))
        return false;
      if (q.get("remittance") === "yes") return false;
      if (q.get("payment_method") || q.get("payment_type") || q.get("seller"))
        return false;
      if (
        text &&
        !`${t.contact_name} ${t.description}`
          .toLocaleLowerCase("pt-BR")
          .includes(text)
      )
        return false;
      return true;
    })
    .sort((a, b) => {
      const ka = `${a.due_on}:${a.id}`,
        kb = `${b.due_on}:${b.id}`;
      return order === "due_desc" ? (ka < kb ? 1 : -1) : ka < kb ? -1 : 1;
    });
  const sum = (key: "amount_cents" | "balance_cents") =>
    String(rows.reduce((t, r) => t + Number(r[key]), 0));
  return {
    entity: "titles",
    ...NATIVE,
    kind,
    page,
    option,
    limit: 100,
    order,
    total: rows.length,
    totals: {
      count: rows.length,
      amount_cents: sum("amount_cents"),
      balance_cents: sum("balance_cents"),
      fee_cents: "0",
    },
    items: rows.slice((page - 1) * 100, page * 100),
  };
}

/** Lista por cursor (010) de contas financeiras e categorias, em ordem de id. */
function financeOptions(entity: "accounts" | "categories", q: URLSearchParams) {
  const after = q.get("after") ?? "",
    kind = q.get("kind");
  const all = (entity === "accounts" ? ACCOUNTS : CATEGORIES) as {
    id: string;
    kind: string;
  }[];
  const items = all.filter(
    (x) =>
      x.id > after &&
      (!kind ||
        (entity === "categories"
          ? x.kind === kind || x.kind === "both"
          : x.kind === kind)),
  );
  return {
    entity,
    items,
    limit: Number(q.get("limit")) || 25,
    has_more: false,
    next_cursor: null,
    ...NATIVE,
  };
}

// ---------------------------------------------------------------- Roteador

export function fixtureRoute(url: URL, actor: string): unknown | undefined {
  const path = url.pathname,
    q = url.searchParams;
  switch (path) {
    case "/v1/sistema/perfil":
      return profile(actor);
    case "/v1/sistema/armazenamento":
      return storage();
    case "/v1/sistema/notificacoes":
      return notifications(q.get("aba") ?? "nao_lidas");
    case "/v1/cadastros":
      return {
        read: ["contacts", "products", "warehouses"],
        write: [],
        ...NATIVE,
      };
    case "/v1/cadastros/contatos":
      return catalogPage("contacts", q);
    case "/v1/cadastros/products":
      return catalogPage("products", q);
    case "/v1/cadastros/tipos-contato":
      return {
        scope: "contact_types",
        can_create: false,
        can_delete: false,
        items: CONTACT_TYPES,
        ...NATIVE,
      };
    case "/v1/cadastros/listas-precos":
      return { items: [], ...NATIVE };
    case "/v1/cadastros/vendedores/opcoes":
      return { scope: "seller_options", users: [], items: SELLERS, ...NATIVE };
    case "/v1/cadastros/contatos/tags":
      return {
        entity: "contacts",
        items: (q.get("ids") ?? "")
          .split(",")
          .filter(Boolean)
          .map((id) => ({ contact_id: id, version: 0, tag_ids: [], tags: [] })),
        ...NATIVE,
      };
    case "/v1/cadastros/warehouses":
      return warehouseRecords(q);
    case "/v1/documentos":
      return {
        read: ["sales_proposals", "sales_orders", "purchase_orders"],
        write: [],
        ...NATIVE,
        operational_effects: false,
      };
    case "/v1/documentos/sacola-vendas":
      return {
        items: [],
        count: 0,
        limit: 250,
        ...NATIVE,
        operational_effects: false,
      };
    case "/v1/financeiro":
      return { read: true, write: false, ...NATIVE };
    case "/v1/financeiro/titles":
      return q.has("page") ? titlePage(q) : undefined;
    case "/v1/financeiro/accounts":
      return financeOptions("accounts", q);
    case "/v1/financeiro/categories":
      return financeOptions("categories", q);
    case "/v1/politica-estoque":
      return {
        scope: "stock_policy",
        policy: { allow_negative: false, version: 0, updated_at: null },
        can_manage: true,
        ...NATIVE,
      };
    case "/v1/estoque/totais":
      return stockTotals(q.get("warehouse_id"));
    case "/v1/posicoes-estoque/depositos":
      return {
        scope: "stock_warehouse_options",
        ...NATIVE,
        limit: 100,
        items: WAREHOUSES,
        has_more: false,
        next_cursor: null,
      };
  }
  let m = /^\/v1\/cadastros\/taxonomias\/([a-z-]+)$/.exec(path);
  if (m) return taxonomy(m[1]!);
  m =
    /^\/v1\/documentos\/(sales_proposals|sales_orders|purchase_orders)(?:\/(situacoes|preferencias-listagem))?$/.exec(
      path,
    );
  if (m) {
    const kind = m[1] as DocKind;
    if (m[2] === "situacoes") return situations(kind);
    if (m[2] === "preferencias-listagem")
      return kind === "purchase_orders" ? undefined : listView(kind);
    return documentList(kind, q);
  }
  m = /^\/v1\/preferencias\/([a-z0-9-]+)$/.exec(path);
  if (m) return preferencesPage(m[1]!, actor);
  m = /^\/v1\/preferencias-listas\/([a-z][a-z0-9_.]*)$/.exec(path);
  if (m && m[1] !== "comandos") return listPreferences(m[1]!);
  return undefined;
}
