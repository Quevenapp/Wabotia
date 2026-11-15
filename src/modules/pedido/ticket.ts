// Comanda do pedido para impressão: dados estruturados (estabelecimento,
// pedido) para os apps nativos imprimirem pelo ThermalPrinterKit e o texto
// pronto em colunas fixas (32 na bobina de 58 mm, 48 na de 80 mm) para o
// painel e impressoras simples. Observações internas não entram.
import { requireValue } from "../../types";
import type { Establishment, ModuleContext } from "../api";
import { PAYMENT_LABELS, dateTimeOf, money, type PaymentMethod } from "./model";
import { loadOrder, orderView, type OrderView } from "./orders";

export const TICKET_COLUMNS = [32, 42, 48] as const;

const chars = (value: string) => Array.from(value);
const width = (value: string) => chars(value).length;

/** Quebra o texto em linhas de até `columns` caracteres (palavras inteiras). */
export function wrap(value: string, columns: number) {
  const out: string[] = [];
  for (const paragraph of value.split("\n")) {
    let line = "";
    for (const raw of paragraph.split(/\s+/).filter(Boolean)) {
      let word = raw;
      // Palavra maior que a linha: corta em pedaços.
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

/** Linhas recuadas (adicionais e observação do item). */
const indented = (value: string, columns: number, pad = "   ") =>
  wrap(value, columns - pad.length).map((line) => pad + line);

const center = (value: string, columns: number) =>
  wrap(value, columns).map((line) => {
    const pad = Math.max(0, Math.floor((columns - width(line)) / 2));
    return " ".repeat(pad) + line;
  });

/** Texto à esquerda e valor à direita na mesma linha (ou na seguinte). */
function pair(left: string, right: string, columns: number) {
  const lines = wrap(left, columns);
  const last = lines.at(-1)!;
  if (width(last) + 1 + width(right) <= columns)
    lines[lines.length - 1] =
      last + " ".repeat(columns - width(last) - width(right)) + right;
  else lines.push(" ".repeat(Math.max(0, columns - width(right))) + right);
  return lines;
}

const phoneLabel = (digits: string) => {
  const m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(digits || "");
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : digits;
};

/** Comanda em texto, colunas fixas. */
export function ticketText(
  establishment: Establishment,
  order: OrderView,
  columns: number,
) {
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
  if (establishment.phone) out.push(...center(establishment.phone, columns));
  out.push(rule);
  out.push(
    ...pair(
      `PEDIDO Nº ${order.number}`,
      dateTimeOf(order.created).replace(" às ", " "),
      columns,
    ),
  );
  out.push(
    ...wrap(
      `${order.fulfillment === "delivery" ? "ENTREGA" : "RETIRADA"} · ${order.status_label}`,
      columns,
    ),
  );
  out.push(rule);
  for (const line of order.lines) {
    out.push(
      ...pair(
        `${line.quantity}x ${line.name}`,
        money(line.total_cents),
        columns,
      ),
    );
    for (const option of line.options)
      out.push(...indented(`+ ${option.name}`, columns));
    if (line.note) out.push(...indented(`Obs: ${line.note}`, columns));
  }
  out.push(rule);
  out.push(...pair("Subtotal", money(order.subtotal_cents), columns));
  if (order.fulfillment === "delivery")
    out.push(...pair("Entrega", money(order.delivery_fee_cents), columns));
  out.push(...pair("TOTAL", money(order.total_cents), columns));
  const method = order.payment.method as PaymentMethod | null;
  out.push(
    ...wrap(
      `Pagamento: ${method ? PAYMENT_LABELS[method] : "a definir"}${
        order.payment.change_for_cents
          ? ` (troco para ${money(order.payment.change_for_cents)})`
          : ""
      }`,
      columns,
    ),
  );
  out.push(
    ...wrap(
      order.payment.status === "paid"
        ? "*** PAGO ***"
        : `Situação: ${order.payment.status_label}`,
      columns,
    ),
  );
  out.push(rule);
  if (order.customer.name)
    out.push(...wrap(`Cliente: ${order.customer.name}`, columns));
  if (order.customer.phone)
    out.push(...wrap(`Tel: ${phoneLabel(order.customer.phone)}`, columns));
  if (order.fulfillment === "delivery" && order.address_text)
    out.push(...wrap(`Entregar em: ${order.address_text}`, columns));
  if (order.note) out.push(...wrap(`Obs.: ${order.note}`, columns));
  if (establishment.footer) {
    out.push(rule);
    out.push(...center(establishment.footer, columns));
  }
  return out.join("\n");
}

/** GET pedido/orders/:id/ticket?columns=32|42|48. */
export async function orderTicket(
  ctx: ModuleContext,
  id: unknown,
  query: Record<string, string>,
) {
  const columns = query.columns ? Number(query.columns) : 32;
  requireValue(
    (TICKET_COLUMNS as readonly number[]).includes(columns),
    "columns: 32, 42 ou 48.",
  );
  const order = orderView(await loadOrder(ctx, id));
  const establishment = await ctx.establishment();
  return {
    columns,
    establishment,
    order,
    text: ticketText(establishment, order, columns),
  };
}
