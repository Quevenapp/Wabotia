// Dados fictícios da vitrine do ERP (papelaria). Valores em centavos como texto,
// datas no fuso de São Paulo, como a API do Fagoo responde.
import { homeShortcutPaths } from "../app/lib/home-request";
import { fixtureRoute } from "./fixtures";

const today = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(
    new Date(),
  );
const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T12:00:00Z`) + days * 86400000)
    .toISOString()
    .slice(0, 10);
const firstOfMonth = (day: string, back: number) => {
  const [y, m] = day.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1 - back, 1));
  return date.toISOString().slice(0, 10);
};

type PeriodKey = "hoje" | "7d" | "30d" | "3m" | "6m" | "12m" | "customizado";

function period(params: URLSearchParams) {
  const key = (params.get("periodo") || "hoje") as PeriodKey;
  const end = today();
  const from =
    key === "customizado"
      ? params.get("de")!
      : key === "hoje"
        ? end
        : key === "7d"
          ? addDays(end, -6)
          : key === "30d"
            ? addDays(end, -29)
            : firstOfMonth(end, key === "3m" ? 2 : key === "6m" ? 5 : 11);
  const to = key === "customizado" ? params.get("ate")! : end;
  const dayCount =
    Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  const grain = dayCount > 62 ? "month" : "day";
  const buckets: string[] = [];
  if (grain === "day")
    for (let d = from; d <= to; d = addDays(d, 1)) buckets.push(d);
  else
    for (let d = from.slice(0, 7); d <= to.slice(0, 7);) {
      buckets.push(d);
      const [y, m] = d.split("-").map(Number);
      d = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
    }
  const points = buckets.map((bucket, i) => ({
    bucket,
    sales_cents: String(18000 + ((i * 7919) % 41000)),
    receivable_cents: String(9000 + ((i * 3571) % 22000)),
    payable_cents: String(4000 + ((i * 2749) % 15000)),
  }));
  const sum = (field: "sales_cents" | "receivable_cents" | "payable_cents") =>
    String(points.reduce((total, p) => total + Number(p[field]), 0));
  return {
    key,
    from,
    to,
    day_count: dayCount,
    grain,
    points,
    sales: {
      count: points.length * 3,
      statuses: [
        {
          status: "Atendido",
          count: points.length * 2,
          total_cents: sum("sales_cents"),
        },
        { status: "Em aberto", count: points.length, total_cents: "48500" },
      ],
    },
    receivable: {
      count: points.length,
      total_cents: sum("receivable_cents"),
      open_cents: "125400",
      fee_cents: "0",
    },
    payable: {
      count: Math.ceil(points.length / 2),
      total_cents: sum("payable_cents"),
      open_cents: "86300",
    },
    invoices: { count: points.length, total_cents: sum("sales_cents") },
  };
}

export function demoData(actor: string) {
  const asOf = new Date().toISOString();
  const paths = homeShortcutPaths();
  const me = {
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
      "nfe",
      "nfce",
    ],
    data_mode: "staging_readonly",
    capabilities: {
      originIntegration: false,
      originHistory: false,
      originConnection: false,
    },
  };
  return {
    me,
    shortcuts: {
      scope: "home_shortcuts",
      data_mode: "erp_native",
      role: "admin",
      version: 0,
      customized: false,
      shortcuts: paths.slice(0, 6),
      labels: {},
      available: paths,
    },
    home: (params: URLSearchParams) => ({
      data_mode: "erp_native",
      as_of: asOf,
      business_date: today(),
      timezone: "America/Sao_Paulo",
      role: "admin",
      origin: "brufap",
      catalog: [
        { entity: "contacts", active: 148, archived: 6 },
        { entity: "products", active: 412, archived: 23 },
        { entity: "warehouses", active: 2, archived: 0 },
      ],
      documents: [
        {
          kind: "sales_proposals",
          count: 12,
          statuses: [
            { status: "Em aberto", count: 7 },
            { status: "Aprovado", count: 5 },
          ],
        },
        {
          kind: "sales_orders",
          count: 34,
          statuses: [
            { status: "Em aberto", count: 9 },
            { status: "Atendido", count: 25 },
          ],
        },
        {
          kind: "purchase_orders",
          count: 6,
          statuses: [
            { status: "Em aberto", count: 2 },
            { status: "Atendido", count: 4 },
          ],
        },
      ],
      stock: {
        positions: 418,
        positive_positions: 371,
        zero_positions: 47,
        products: 412,
        warehouses: 2,
      },
      finance: {
        titles: [
          {
            kind: "receivable",
            buckets: [
              { bucket: "overdue", count: 3, balance_cents: "41250" },
              { bucket: "today", count: 2, balance_cents: "18900" },
              { bucket: "next_7_days", count: 6, balance_cents: "65250" },
              { bucket: "later", count: 11, balance_cents: "212300" },
            ],
          },
          {
            kind: "payable",
            buckets: [
              { bucket: "overdue", count: 1, balance_cents: "12800" },
              { bucket: "today", count: 1, balance_cents: "9900" },
              { bucket: "next_7_days", count: 3, balance_cents: "38600" },
              { bucket: "later", count: 5, balance_cents: "104000" },
            ],
          },
        ],
        accounts: {
          active: 3,
          archived: 0,
          opening_pending: 0,
          recorded_balance_cents: "1843075",
        },
      },
      period: period(params),
    }),
    /** Demais rotas (fixtures.ts); undefined quando ainda não simuladas. */
    route: (url: URL): unknown => fixtureRoute(url, actor),
  };
}
export type DemoData = ReturnType<typeof demoData>;
