// Mesas: a conta para conferir e imprimir. Linhas somadas (2x Cerveja), taxa
// de serviço, pago, a pagar e a divisão por pessoa; dados do estabelecimento
// e o texto pronto em colunas fixas (32, 42 ou 48), como a comanda do Pedido.
import { requireValue, type Actor } from "../../types";
import type { Establishment, ModuleContext } from "../api";
import * as pedido from "../pedido/public";
import { PAY_LABELS, splitShares, type PayMethod } from "./model";
import { config, loadTab, paymentView, tabState, type TabView } from "./tabs";

export interface BillLine {
  name: string;
  options: string[];
  note: string;
  quantity: number;
  unit_cents: number;
  total_cents: number;
}

/**
 * Linhas da conta: pedidos não cancelados, com o mesmo item, os mesmos
 * adicionais, a mesma observação e o mesmo preço somados numa linha.
 */
export function billLines(orders: pedido.OrderView[]): BillLine[] {
  const out = new Map<string, BillLine>();
  for (const order of orders) {
    if (order.status === "cancelled") continue;
    for (const line of order.lines) {
      const options = line.options.map((o) => o.name);
      const unit = Math.round(line.total_cents / line.quantity);
      const key = JSON.stringify([
        line.item_id,
        [...options].sort(),
        line.note,
        unit,
      ]);
      const current = out.get(key);
      if (current) {
        current.quantity += line.quantity;
        current.total_cents += line.total_cents;
      } else
        out.set(key, {
          name: line.name,
          options,
          note: line.note,
          quantity: line.quantity,
          unit_cents: unit,
          total_cents: line.total_cents,
        });
    }
  }
  return [...out.values()];
}

export function billText(
  establishment: Establishment,
  tab: TabView,
  lines: BillLine[],
  payments: ReturnType<typeof paymentView>[],
  split: { people: number; shares: number[] } | null,
  columns: number,
) {
  const { center, pair, wrap, money } = pedido;
  const rule = "-".repeat(columns);
  const out: string[] = [];
  out.push(...center(establishment.name.toUpperCase(), columns));
  if (establishment.document_display)
    out.push(
      ...center(
        `${establishment.document_type === "cpf" ? "CPF" : "CNPJ"} ${establishment.document_display}`,
        columns,
      ),
    );
  if (establishment.address)
    out.push(...center(establishment.address, columns));
  out.push(rule);
  out.push(
    ...pair(
      `CONTA Nº ${tab.number}`,
      pedido.dateTimeOf(tab.closed_at ?? Date.now()).replace(" às ", " "),
      columns,
    ),
  );
  out.push(
    ...wrap(
      `${tab.table.name.toUpperCase()}${tab.guests ? ` · ${tab.guests} ${tab.guests === 1 ? "pessoa" : "pessoas"}` : ""}`,
      columns,
    ),
  );
  if (tab.customer_name) out.push(...wrap(tab.customer_name, columns));
  out.push(rule);
  for (const line of lines) {
    out.push(
      ...pair(
        `${line.quantity}x ${line.name}`,
        money(line.total_cents),
        columns,
      ),
    );
    for (const option of line.options)
      out.push(...wrap(`+ ${option}`, columns - 3).map((l) => "   " + l));
    if (line.note)
      out.push(...wrap(`Obs: ${line.note}`, columns - 3).map((l) => "   " + l));
  }
  if (!lines.length) out.push(...wrap("Nenhum item.", columns));
  out.push(rule);
  const b = tab.bill;
  out.push(...pair("Subtotal", money(b.subtotal_cents), columns));
  if (b.service_on)
    out.push(
      ...pair(
        `Serviço (${String(b.service_percent).replace(".", ",")}%)`,
        money(b.service_cents),
        columns,
      ),
    );
  out.push(...pair("TOTAL", money(b.total_cents), columns));
  const ok = payments.filter((p) => p.status === "ok");
  if (ok.length) {
    for (const p of ok)
      out.push(
        ...pair(
          `Pago (${PAY_LABELS[p.method as PayMethod] || p.method})`,
          money(p.amount_cents),
          columns,
        ),
      );
    if (b.due_cents) out.push(...pair("A PAGAR", money(b.due_cents), columns));
  }
  if (tab.status === "closed")
    out.push(...center("*** CONTA PAGA ***", columns));
  if (split) {
    out.push(rule);
    const groups = new Map<number, number>();
    for (const s of split.shares) groups.set(s, (groups.get(s) || 0) + 1);
    out.push(...wrap(`Dividido por ${split.people}:`, columns));
    for (const [cents, count] of groups)
      out.push(
        ...pair(
          `${count} ${count === 1 ? "pessoa" : "pessoas"}`,
          `${money(cents)} cada`,
          columns,
        ),
      );
  }
  out.push(rule);
  out.push(...center("Não é documento fiscal", columns));
  if (establishment.footer) out.push(...center(establishment.footer, columns));
  return out.join("\n");
}

/**
 * GET mesas/tabs/:id/bill?split=N&columns=32|42|48: a conta para o cliente
 * conferir (parcial com a conta aberta). `split` divide o que falta pagar
 * (ou o total, sem nada pago) entre N pessoas; `columns` traz o texto para
 * imprimir.
 */
export async function tabBill(
  ctx: ModuleContext,
  actor: Actor,
  id: unknown,
  query: Record<string, string>,
) {
  const cfg = await config(ctx);
  const state = await tabState(ctx, await loadTab(ctx, id));
  let split: { people: number; of: "due" | "total"; shares: number[] } | null =
    null;
  if (query.split) {
    const people = Number(query.split);
    requireValue(
      Number.isInteger(people) && people >= 2 && people <= cfg.split_max,
      `split: de 2 a ${cfg.split_max} pessoas.`,
    );
    const of = state.tab.bill.paid_cents ? "due" : "total";
    split = {
      people,
      of,
      shares: splitShares(
        of === "due" ? state.tab.bill.due_cents : state.tab.bill.total_cents,
        people,
      ),
    };
  }
  const columns = query.columns ? Number(query.columns) : null;
  requireValue(
    columns === null ||
      (pedido.TICKET_COLUMNS as readonly number[]).includes(columns),
    "columns: 32, 42 ou 48.",
  );
  const lines = billLines(state.orders);
  const payments = state.payments.map(paymentView);
  const establishment = await ctx.establishment();
  const notes = ctx.mayRead(actor, "notes");
  return {
    tab: state.tab,
    lines,
    payments: notes ? payments : payments.map(({ note: _n, ...p }) => p),
    split,
    establishment,
    ...(columns
      ? {
          columns,
          text: billText(
            establishment,
            state.tab,
            lines,
            payments,
            split,
            columns,
          ),
        }
      : {}),
  };
}
