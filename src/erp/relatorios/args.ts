// Argumentos dos RPCs dos relatórios do ERP a partir da consulta, do caminho e
// do corpo das rotas (./routes.ts). Puro: os testes do Node importam este arquivo.
import type { ErpReportOperation } from "./contract.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Pedido com dado inválido (a rota responde 400 invalid_request com a mensagem). */
export class ReportArgsError extends Error {}
const bad = (message: string): never => { throw new ReportArgsError(message); };

/** Reais ("1500.00" ou "1500,00") em centavos (texto). */
export function reaisToCents(value: unknown): string {
  const text = typeof value === "number" ? value.toFixed(2) : typeof value === "string" ? value.trim() : "";
  const m = /^([0-9]{1,13})(?:[.,]([0-9]{1,2}))?$/.exec(text);
  if (!m) bad("valor: informe o valor em reais, como 1500.00.");
  const cents = BigInt(m![1]) * 100n + BigInt((m![2] ?? "0").padEnd(2, "0"));
  if (cents <= 0n) bad("valor: informe um valor maior que zero.");
  return cents.toString();
}

const date = (value: string | null, name: string, required = true): string | null => {
  if (value === null || value === "") return required ? bad(`${name}: informe a data (AAAA-MM-DD).`) : null;
  if (!DATE.test(value)) bad(`${name}: use a data no formato AAAA-MM-DD.`);
  return value;
};
export const uuid = (value: unknown, name: string, required = false): string | null => {
  if (value === undefined || value === null || value === "") return required ? bad(`${name}: informe o identificador.`) : null;
  if (typeof value !== "string" || !UUID.test(value)) bad(`${name}: identificador inválido.`);
  return (value as string).toLowerCase();
};
const choice = <T extends string>(value: string | null, map: Record<string, T>, name: string, fallback?: T): T => {
  if (value === null || value === "") return fallback ?? bad(`${name}: escolha ${Object.keys(map).join(", ")}.`);
  if (!Object.hasOwn(map, value)) bad(`${name}: use ${Object.keys(map).join(", ")}.`);
  return map[value];
};
const GROUP = { dia: "day", semana: "week", mes: "month" } as const;

/** Os argumentos do RPC a partir da consulta, do caminho e do corpo. */
export async function reportRpcArgs(operation: ErpReportOperation, params: Record<string, string>, query: URLSearchParams, body: Record<string, unknown> | undefined, command: (body: Record<string, unknown>) => Promise<string>) {
  for (const key of query.keys()) if (!operation.query.includes(key) || query.getAll(key).length !== 1) bad(`Parâmetro não aceito: ${key}. Use ${operation.query.join(", ") || "nenhum"}.`);
  const q = (key: string) => query.get(key);
  const period = () => ({ from: date(q("de"), "de"), to: date(q("ate"), "ate") });
  switch (operation.name) {
    case "erp.financeiro.dre":
    case "erp.financeiro.dre.categoria": {
      const args: Record<string, unknown> = { ...period(), basis: choice(q("regime"), { caixa: "cash", competencia: "competence" } as const, "regime", "cash") };
      if (operation.name === "erp.financeiro.dre") {
        const compare = q("comparar");
        if (compare !== null && !["1", "0"].includes(compare)) bad("comparar: use 1 ou 0.");
        args.compare = compare !== "0";
      } else {
        args.category_id = params.id === "sem" ? "none" : uuid(params.id, "categoria", true);
        const page = q("pagina");
        if (page !== null) { if (!/^[1-9][0-9]{0,4}$/.test(page)) bad("pagina: use um número a partir de 1."); args.page = Number(page); }
        args.limit = 50;
      }
      return { p_args: args };
    }
    case "erp.financeiro.dre.custos.ver":
      return { p_args: { costs: true } };
    case "erp.financeiro.dre.custos": {
      if (typeof body!.custos !== "boolean") bad("custos: use true ou false.");
      return { p_command_id: await command(body!), p_category_id: uuid(body!.categoria, "categoria", true), p_cost: body!.custos };
    }
    case "erp.negocio.vendas":
      return { p_args: { report: choice(q("relatorio"), { periodo: "period", vendedor: "seller", produto: "product" } as const, "relatorio"), ...period(), group: choice(q("agrupar"), GROUP, "agrupar", "day") } };
    case "erp.financeiro.graficos": {
      const report = choice(q("relatorio"), { fluxo: "cash_flow", vencimentos: "due" } as const, "relatorio");
      return { p_args: report === "due" ? { report } : { report, ...period(), group: choice(q("agrupar"), GROUP, "agrupar", "month") } };
    }
    case "erp.negocio.estoque": {
      const report = choice(q("relatorio"), { depositos: "warehouses", giro: "turnover" } as const, "relatorio");
      return { p_args: report === "warehouses" ? { report } : { report, ...period(), ...(q("deposito") ? { warehouse_id: uuid(q("deposito"), "deposito") } : {}) } };
    }
    case "erp.negocio.lotes_vencendo": {
      const days = q("dias");
      if (days !== null && !/^[0-9]{1,4}$/.test(days)) bad("dias: use um número de 0 a 3650.");
      return { p_args: { ...(days !== null ? { days: Number(days) } : {}), ...(q("deposito") ? { warehouse_id: uuid(q("deposito"), "deposito") } : {}) } };
    }
    case "erp.financeiro.equipe.pessoas":
      return {};
    case "erp.financeiro.equipe.pagamentos": {
      const kind = q("pessoa_tipo") ? choice(q("pessoa_tipo"), { funcionario: "employee", vendedor: "seller" } as const, "pessoa_tipo") : null;
      const pay = q("tipo") ? choice(q("tipo"), { salario: "salario", comissao: "comissao", adiantamento: "adiantamento", vale: "vale" } as const, "tipo") : null;
      return { p_args: { ...period(), ...(kind ? { person_kind: kind } : {}), ...(q("pessoa") ? { person_id: uuid(q("pessoa"), "pessoa") } : {}), ...(pay ? { pay_kind: pay } : {}) } };
    }
    case "erp.financeiro.equipe.comissoes":
      return { p_args: { ...period(), ...(q("vendedor") ? { seller_id: uuid(q("vendedor"), "vendedor") } : {}) } };
    case "erp.financeiro.equipe.lancar": {
      const b = body!;
      const text = (key: string) => (b[key] === undefined || b[key] === null ? null : typeof b[key] === "string" ? (b[key] as string) : bad(`${key}: use texto.`));
      const due = date(text("vencimento"), "vencimento")!;
      const data: Record<string, unknown> = {
        person_kind: choice(text("pessoa_tipo"), { funcionario: "employee", vendedor: "seller" } as const, "pessoa_tipo"),
        person_id: uuid(b.pessoa, "pessoa", true),
        pay_kind: choice(text("tipo"), { salario: "salario", comissao: "comissao", adiantamento: "adiantamento", vale: "vale" } as const, "tipo"),
        amount_cents: reaisToCents(b.valor),
        issued_on: date(text("emissao"), "emissao", false) ?? (due < todayBr() ? due : todayBr()),
        due_on: due,
        period_from: date(text("periodo_de"), "periodo_de"), period_to: date(text("periodo_ate"), "periodo_ate"),
      };
      const competence = date(text("competencia"), "competencia", false);
      if (competence) data.competence_on = competence;
      const description = text("descricao");
      if (description !== null && description.trim()) { if (description.length > 240) bad("descricao: até 240 caracteres."); data.description = description.trim(); }
      if (b.categoria) data.category_id = uuid(b.categoria, "categoria");
      if (b.conta_financeira) data.account_id = uuid(b.conta_financeira, "conta_financeira");
      return { p_command_id: await command(b), p_data: data };
    }
  }
  return bad("Operação desconhecida.");
}
/** Hoje em São Paulo (AAAA-MM-DD). */
const todayBr = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

