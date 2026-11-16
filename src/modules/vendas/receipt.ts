// Vendas: comprovante não fiscal da venda e orçamento para imprimir. Dados
// estruturados (estabelecimento, venda) para os apps imprimirem pelo
// ThermalPrinterKit e o texto pronto em colunas fixas (32 na bobina de 58 mm,
// 48 na de 80 mm) para o painel e impressoras simples. Observações internas
// não entram.
import { requireValue, type Actor } from "../../types";
import type { Establishment, ModuleContext } from "../api";
import { dateTime, day, money, quantityLabel, vendasSettings } from "./model";
import { loadSale, saleView, visibleSale, type SaleView } from "./sales";
import { loadQuote, quoteView, visibleQuote, type QuoteView } from "./quotes";

export const RECEIPT_COLUMNS = [32, 42, 48] as const;

const chars = (value: string) => Array.from(value);
const width = (value: string) => chars(value).length;

/** Quebra o texto em linhas de até `columns` caracteres (palavras inteiras). */
export function wrap(value: string, columns: number) {
  const out: string[] = [];
  for (const paragraph of value.split("\n")) {
    let line = "";
    for (const raw of paragraph.split(/\s+/).filter(Boolean)) {
      let word = raw;
      while (width(word) > columns) {
        if (line) out.push(line);
        line = "";
        out.push(chars(word).slice(0, columns).join(""));
        word = chars(word).slice(columns).join("");
      }
      if (!word) continue;
      if (!line) line = word;
      else if (width(line) + 1 + width(word) <= columns) line += " " + word;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

const center = (value: string, columns: number) =>
  wrap(value, columns).map((line) => {
    const pad = Math.max(0, Math.floor((columns - width(line)) / 2));
    return " ".repeat(pad) + line;
  });

/** Texto à esquerda e valor à direita na mesma linha (ou na seguinte). */
export function pair(left: string, right: string, columns: number) {
  const lines = wrap(left, columns);
  const last = lines.at(-1)!;
  if (width(last) + 1 + width(right) <= columns)
    lines[lines.length - 1] =
      last + " ".repeat(columns - width(last) - width(right)) + right;
  else lines.push(" ".repeat(Math.max(0, columns - width(right))) + right);
  return lines;
}

const header = (e: Establishment, columns: number) => {
  const out = [...center(e.name.toUpperCase(), columns)];
  if (e.document_display)
    out.push(
      ...center(
        `${e.document_type === "cpf" ? "CPF" : "CNPJ"} ${e.document_display}`,
        columns,
      ),
    );
  if (e.address) out.push(...center(e.address, columns));
  if (e.phone) out.push(...center(e.phone, columns));
  return out;
};

type Item = SaleView["lines"][number] | QuoteView["lines"][number];

function items(lines: Item[], columns: number) {
  const out: string[] = [];
  for (const line of lines) {
    out.push(...wrap(line.name, columns));
    out.push(
      ...pair(
        `  ${quantityLabel(line.quantity * 1000)} ${line.unit} x ${money(line.unit_cents)}`,
        money(line.gross_cents),
        columns,
      ),
    );
    if (line.discount_cents)
      out.push(...pair("  Desconto", `-${money(line.discount_cents)}`, columns));
  }
  return out;
}

export function receiptText(
  e: Establishment,
  sale: SaleView,
  columns: number,
  footer = "",
) {
  const rule = "-".repeat(columns);
  const out = header(e, columns);
  out.push(rule);
  out.push(...center("COMPROVANTE DE VENDA", columns));
  out.push(...center("NÃO É DOCUMENTO FISCAL", columns));
  out.push(rule);
  out.push(...pair(`VENDA Nº ${sale.number}`, dateTime(sale.created), columns));
  if (sale.status !== "completed")
    out.push(...wrap(`*** ${sale.status_label.toUpperCase()} ***`, columns));
  out.push(rule);
  out.push(...items(sale.lines, columns));
  out.push(rule);
  out.push(...pair("Subtotal", money(sale.subtotal_cents), columns));
  if (sale.discount_cents)
    out.push(...pair("Descontos", `-${money(sale.discount_cents)}`, columns));
  out.push(...pair("TOTAL", money(sale.total_cents), columns));
  for (const p of sale.payments)
    out.push(...pair(p.method_label, money(p.amount_cents), columns));
  if (sale.change_cents)
    out.push(...pair("Troco", money(sale.change_cents), columns));
  if (sale.refunded_cents)
    out.push(...pair("Devolvido", `-${money(sale.refunded_cents)}`, columns));
  if (sale.customer.name || sale.customer.document) {
    out.push(rule);
    if (sale.customer.name)
      out.push(...wrap(`Cliente: ${sale.customer.name}`, columns));
    if (sale.customer.document)
      out.push(
        ...wrap(
          `${sale.customer.document.length === 11 ? "CPF" : "CNPJ"}: ${sale.customer.document}`,
          columns,
        ),
      );
  }
  if (sale.note) out.push(...wrap(`Obs.: ${sale.note}`, columns));
  const tail = [footer, e.footer].filter(Boolean).join("\n");
  if (tail) {
    out.push(rule);
    out.push(...center(tail, columns));
  }
  return out.join("\n");
}

export function quoteText(
  e: Establishment,
  quote: QuoteView,
  columns: number,
  footer = "",
) {
  const rule = "-".repeat(columns);
  const out = header(e, columns);
  out.push(rule);
  out.push(...pair(`ORÇAMENTO Nº ${quote.number}`, day(quote.created), columns));
  if (quote.customer.name)
    out.push(...wrap(`Cliente: ${quote.customer.name}`, columns));
  out.push(rule);
  out.push(...items(quote.lines, columns));
  out.push(rule);
  out.push(...pair("Subtotal", money(quote.subtotal_cents), columns));
  if (quote.discount_cents)
    out.push(...pair("Descontos", `-${money(quote.discount_cents)}`, columns));
  out.push(...pair("TOTAL", money(quote.total_cents), columns));
  if (quote.valid_until)
    out.push(...wrap(`Válido até ${day(quote.valid_until)}.`, columns));
  if (quote.note) out.push(...wrap(quote.note, columns));
  const tail = [footer, e.footer].filter(Boolean).join("\n");
  if (tail) {
    out.push(rule);
    out.push(...center(tail, columns));
  }
  return out.join("\n");
}

const columnsOf = (query: Record<string, string>) => {
  const columns = query.columns ? Number(query.columns) : 32;
  requireValue(
    (RECEIPT_COLUMNS as readonly number[]).includes(columns),
    "columns: 32, 42 ou 48.",
  );
  return columns;
};

/** GET vendas/sales/:id/receipt?columns=32|42|48. */
export async function saleReceipt(
  ctx: ModuleContext,
  id: unknown,
  query: Record<string, string>,
  actor: Actor,
) {
  const columns = columnsOf(query);
  const sale = visibleSale(ctx, actor, saleView(await loadSale(ctx, id)));
  const [establishment, settings] = await Promise.all([
    ctx.establishment(),
    ctx.settings(),
  ]);
  return {
    columns,
    establishment,
    sale,
    text: receiptText(
      establishment,
      sale,
      columns,
      vendasSettings(settings).receipt_footer,
    ),
  };
}

/** GET vendas/quotes/:id/print?columns=32|42|48. */
export async function quotePrint(
  ctx: ModuleContext,
  id: unknown,
  query: Record<string, string>,
  actor: Actor,
) {
  const columns = columnsOf(query);
  const quote = visibleQuote(ctx, actor, quoteView(await loadQuote(ctx, id)));
  const [establishment, settings] = await Promise.all([
    ctx.establishment(),
    ctx.settings(),
  ]);
  return {
    columns,
    establishment,
    quote,
    text: quoteText(
      establishment,
      quote,
      columns,
      vendasSettings(settings).quote_footer,
    ),
  };
}
