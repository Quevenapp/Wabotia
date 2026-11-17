// erp_preferences.report_source(base): as linhas de cada base dos relatórios
// customizados, com a chave de ordem do Fagoo (texto, ordenado em collation C)
// e os valores já como texto (report_clean, centavos em reais, situações).
// O espelho do Origin saiu: só documentos nativos (authority 'brufap').
import { one, type SqlDriver } from "../../engine/driver.ts";
import { jsonbText } from "../../engine/json.ts";
import { pgLower } from "../../engine/text.ts";
import { todaySaoPaulo } from "../../engine/time.ts";
import { decText, formatScaled, fromColumn } from "../../engine/dec.ts";
import { actorLabel } from "../access/public.ts";
import { commissionRows, statementLines } from "../finance/public.ts";
import { situationBaseLabel } from "./center.ts";
import { utcStamp } from "./framework.ts";
import { compareText } from "./order.ts";
import { reportClean } from "./report-text.ts";

export interface SourceRow {
  sort: string | null;
  data: Record<string, string | null>;
}

const clean = reportClean;
/** jsonb #>> path */
function jp(o: unknown, ...keys: string[]): string | null {
  let v = o;
  for (const k of keys) {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
    v = (v as Record<string, unknown>)[k];
  }
  if (v === undefined || v === null) return null;
  return typeof v === "string" ? v : jsonbText(v);
}
const json = (v: unknown) => JSON.parse(String(v)) as unknown;
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
/** lpad(s, n, '0'): completa ou corta em n. */
const lpad = (s: string, n: number) => ([...s].length >= n ? [...s].slice(0, n).join("") : s.padStart(n, "0"));
/** trim_scale(x)::text */
export const trimScale = (t: string) => (t.includes(".") ? t.replace(/0+$/, "").replace(/\.$/, "") : t);
/** report_cents(c): centavos em reais com duas casas. */
const cents = (c: bigint | number | null) => (c === null ? null : formatScaled(BigInt(c), 2));
const dateKey = (d: string) => d.replace(/-/g, "");
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const PROPOSAL_STATUS: Record<string, string> = {
  draft: "Rascunho", open: "Em aberto", pending: "Pendente", waiting: "Aguardando", approved: "Aprovado", rejected: "Não aprovado", completed: "Concluído", cancelled: "Cancelado",
};
/** erp_preferences.report_document_status(kind, status) */
export function documentStatus(kind: string, status: string | null): string | null {
  if (status === null) return null;
  if (kind === "sales_proposals") return PROPOSAL_STATUS[status] ?? status;
  if (["sales_orders", "purchase_orders", "service_orders"].includes(kind)) return situationBaseLabel(kind, status);
  return status;
}
const INVOICE_STATUS: Record<string, string> = {
  "1": "Pendente", "2": "Em contingência", "3": "Cancelada", "4": "Aguardando recibo", "5": "Rejeitada", "6": "Autorizada", "7": "Emitida DANFE", "8": "Registrada",
  "9": "Aguardando protocolo", "10": "Denegada", "11": "Consulta situação", "12": "Bloqueada", "14": "Enviando Carta de correção", "15": "Enviando Cancelamento", "16": "Enviando Autorização",
};
const FREIGHT: Record<string, string> = {
  "0": "0 - Contratação do Frete por conta do Remetente (CIF)",
  "1": "1 - Contratação do Frete por conta do Destinatário (FOB)",
  "2": "2 - Contratação do Frete por conta de Terceiros",
  "3": "3 - Transporte Próprio por conta do Remetente",
  "4": "4 - Transporte Próprio por conta do Destinatário",
  "9": "9 - Sem Ocorrência de Transporte",
};
const freight = (code: string | null) => (code === null ? null : (FREIGHT[code] ?? null));
/** round(x::numeric, 2)::numeric(17,2)::text quando o texto casa com o padrão. */
const money2 = (t: string | null, re: RegExp) => (t !== null && re.test(t) ? decText(t, 2, true) : null);
const trimmed = (t: string | null, re: RegExp) => (t !== null && re.test(t) ? trimScale(decText(t, 0, false)) : null);
const docKey = (number: unknown) => lpad(String(number), 12);
/** to_char(date '2100-12-31' - issue, 'FM000000') || lpad(coalesce(999999999-number, 999999999), 9, '0') || id */
function invoiceKey(i: Record<string, unknown>) {
  const days = Math.round((Date.parse("2100-12-31T00:00:00Z") - Date.parse(`${i.issue_date}T00:00:00Z`)) / 86_400_000);
  const n = i.number === null ? 999999999 : 999999999 - Number(i.number);
  return String(days).padStart(6, "0") + lpad(String(n), 9) + i.id;
}
const stripNulls = (o: Record<string, string | null>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null)) as Record<string, string | null>;
const titleSituation = (t: Record<string, unknown>, today: string, returned: boolean, partial: (kind: string) => string) => {
  const amount = fromColumn(t.amount_cents),
    settled = fromColumn(t.settled_cents);
  if (Number(t.cancelled) === 1 && returned) return "Devolvido";
  if (Number(t.cancelled) === 1) return "Cancelada";
  if (settled === amount) return t.kind === "receivable" ? "Recebida" : "Paga";
  if (settled > 0n) return partial(String(t.kind));
  return String(t.due_on) < today ? "Atrasada" : "Em aberto";
};
const returnedTitles = (db: SqlDriver) => new Set(db.exec('SELECT title_id FROM "erp_finance__title_return"').rows.map((r) => String(r.title_id)));

const DOC_KIND: Record<string, string> = { vendas: "sales_orders", propostas: "sales_proposals", pedidos_compra: "purchase_orders", ordens_servico: "service_orders" };

export function reportSource(db: SqlDriver, base: string): SourceRow[] {
  const out: SourceRow[] = [];
  const today = todaySaoPaulo();
  if (base === "produtos")
    for (const r of db.exec(`SELECT r.id, r.name, r.code, r.active, p.unit, p.price, p.kind, p.gtin, p.ncm FROM "erp_catalog__record" r JOIN "erp_catalog__product" p ON p.record_id=r.id`).rows)
      out.push({
        sort: pgLower(String(r.name)) + " " + r.id,
        data: {
          codigo: clean(str(r.code), 100), descricao: clean(str(r.name), 200), unidade: clean(str(r.unit), 20), preco: str(r.price),
          tipo: r.kind === "S" ? "Serviço" : r.kind === "N" ? "Não especificado" : r.kind === "P" ? "Produto" : null,
          situacao: Number(r.active) === 1 ? "Ativo" : "Inativo", gtin: clean(str(r.gtin), 20), ncm: clean(str(r.ncm), 10),
        },
      });
  else if (base === "contatos")
    for (const r of db.exec(
      `SELECT r.id, r.name, r.active, c.trade_name, c.document, c.ie, c.city, c.state, c.phone, c.mobile, c.email, c.roles FROM "erp_catalog__record" r JOIN "erp_catalog__contact" c ON c.record_id=r.id`,
    ).rows) {
      const roles = ((r.roles === null ? [] : json(r.roles)) as string[]).slice().sort(compareText);
      const tipos = roles.map((x) => (x === "customer" ? "Cliente" : x === "supplier" ? "Fornecedor" : "Transportador")).join(", ");
      out.push({
        sort: pgLower(String(r.name)) + " " + r.id,
        data: {
          nome: clean(str(r.name), 200), fantasia: clean(str(r.trade_name), 200), documento: clean(str(r.document), 20), ie: clean(str(r.ie), 20),
          cidade: clean(str(r.city), 100), uf: clean(str(r.state), 2), telefone: clean(str(r.phone), 40), celular: clean(str(r.mobile), 40), email: clean(str(r.email), 200),
          tipos: tipos === "" ? null : tipos, situacao: Number(r.active) === 1 ? "Ativo" : "Inativo",
        },
      });
    }
  else if (base === "contas_receber" || base === "contas_pagar") {
    const returned = returnedTitles(db);
    for (const t of db.exec(
      `SELECT t.id, t.kind, t.due_on, t.issued_on, t.description, t.installment, t.installments, CAST(t.amount_cents AS TEXT) amount_cents, CAST(t.settled_cents AS TEXT) settled_cents,
        t.cancelled, r.name, c.name category FROM "erp_finance__title" t JOIN "erp_catalog__record" r ON r.id=t.contact_id LEFT JOIN "erp_finance__category" c ON c.id=t.category_id WHERE t.kind=?`,
      base === "contas_receber" ? "receivable" : "payable",
    ).rows) {
      const cancelled = Number(t.cancelled) === 1;
      out.push({
        sort: dateKey(String(t.due_on)) + " " + pgLower(String(t.name)) + " " + t.id,
        data: {
          vencimento: str(t.due_on), emissao: str(t.issued_on), contato: clean(str(t.name), 200), descricao: clean(str(t.description), 200),
          categoria: clean(str(t.category), 120), parcela: `${t.installment}/${t.installments}`, valor: cents(fromColumn(t.amount_cents)),
          saldo: cents(cancelled ? 0n : fromColumn(t.amount_cents) - fromColumn(t.settled_cents)),
          situacao: titleSituation(t, today, returned.has(String(t.id)), () => "Parcial"),
        },
      });
    }
  } else if (DOC_KIND[base]) {
    const kind = DOC_KIND[base];
    for (const d of db.exec(
      `SELECT d.id, d.kind, d.status, d.number, d.body, d.contact_snapshot, CAST(d.total AS TEXT) total, (SELECT count(*) FROM "erp_documents__item" i WHERE i.document_id=d.id) items
       FROM "erp_documents__document" d WHERE d.authority='brufap' AND d.kind=?`,
      kind,
    ).rows) {
      const body = json(d.body);
      const date = jp(body, "date");
      out.push({
        sort: docKey(d.number),
        data: {
          numero: String(d.number), data: date !== null && DATE.test(date) ? date : null, contato: clean(jp(json(d.contact_snapshot), "name"), 200),
          situacao: documentStatus(kind, str(d.status)), vendedor: clean(jp(body, "commercial", "seller_reference", "label"), 80), itens: String(d.items),
          total: formatScaled(fromColumn(d.total), 2),
        },
      });
    }
  } else if (base === "notas_saida" || base === "notas_entrada" || base === "nfce") {
    const where = base === "nfce" ? "model='65'" : `model='55' AND direction='${base === "notas_saida" ? "1" : "0"}'`;
    for (const i of db.exec(
      `SELECT id, number, series, issue_date, recipient, nature_description, status, totals, access_key FROM "erp_fiscal_invoices__invoice" WHERE deleted_at IS NULL AND ${where}`,
    ).rows) {
      const rec = json(i.recipient);
      const total = jp(json(i.totals), "total");
      out.push({
        sort: invoiceKey(i),
        data: {
          ...stripNulls({
            numero: str(i.number), serie: str(i.series), emissao: str(i.issue_date), contato: clean(jp(rec, "name"), 200), documento: clean(jp(rec, "document"), 20),
            natureza: clean(str(i.nature_description), 60), situacao: INVOICE_STATUS[String(i.status)] ?? null,
            total: money2(total, /^-?[0-9]{1,15}(\.[0-9]+)?$/), chave: str(i.access_key),
          }),
          ...(base !== "nfce" ? stripNulls({ uf: clean(jp(rec, "state"), 2) }) : {}),
        },
      });
    }
  } else if (base === "recebimentos" || base === "pagamentos") {
    const reversed = new Set(db.exec('SELECT reverses_id FROM "erp_finance__settlement" WHERE reverses_id IS NOT NULL').rows.map((r) => String(r.reverses_id)));
    for (const s of db.exec(
      `SELECT s.id, s.posted_on, CAST(s.created_at AS TEXT) created_at, CAST(s.principal_cents AS TEXT) p, CAST(s.interest_cents AS TEXT) i, CAST(s.penalty_cents AS TEXT) pe,
        CAST(s.discount_cents AS TEXT) d, CAST(s.fee_cents AS TEXT) fee, CAST(s.net_cash_cents AS TEXT) net, t.due_on, t.kind, t.description, t.installment, t.installments,
        r.name, c.name category, a.name account
       FROM "erp_finance__settlement" s JOIN "erp_finance__title" t ON t.id=s.title_id LEFT JOIN "erp_catalog__record" r ON r.id=t.contact_id
       LEFT JOIN "erp_finance__category" c ON c.id=t.category_id LEFT JOIN "erp_finance__account" a ON a.id=s.account_id
       WHERE s.kind='payment' AND t.kind=?`,
      base === "recebimentos" ? "receivable" : "payable",
    ).rows) {
      const n = (k: string) => fromColumn(s[k]);
      out.push({
        sort: dateKey(String(s.posted_on)) + " " + utcStamp(BigInt(String(s.created_at))) + " " + s.id,
        data: {
          data: str(s.posted_on), vencimento: str(s.due_on), contato: clean(str(s.name), 200), descricao: clean(str(s.description), 200),
          categoria: clean(str(s.category), 120), parcela: `${s.installment}/${s.installments}`, conta: clean(str(s.account), 200),
          valor: cents(n("p") + n("i") + n("pe") - n("d")), juros: cents(n("i")), multa: cents(n("pe")), desconto: cents(n("d")), tarifa: cents(n("fee")), liquido: cents(n("net")),
          situacao: reversed.has(String(s.id)) ? "Estornado" : s.kind === "receivable" ? "Recebido" : "Pago",
        },
      });
    }
  } else if (base === "venda_parcela") {
    const methods = new Map(db.exec('SELECT id, description FROM "erp_catalog__payment_method"').rows.map((m) => [String(m.id), str(m.description)]));
    for (const d of db.exec(`SELECT number, kind, status, body, contact_snapshot FROM "erp_documents__document" WHERE authority='brufap' AND kind='sales_orders'`).rows) {
      const body = json(d.body) as Record<string, unknown>;
      const list = Array.isArray(body.installments) ? (body.installments as unknown[]) : [];
      const date = jp(body, "date");
      list.forEach((p, idx) => {
        const n = idx + 1;
        const due = jp(p, "due_date");
        const method = jp(p, "payment_method_id");
        out.push({
          sort: docKey(d.number) + lpad(String(n), 4),
          data: {
            numero: String(d.number), data: date !== null && DATE.test(date) ? date : null, contato: clean(jp(json(d.contact_snapshot), "name"), 200),
            situacao: documentStatus("sales_orders", str(d.status)), parcela: `${n}/${list.length}`, vencimento: due !== null && DATE.test(due) ? due : null,
            valor: money2(jp(p, "amount"), /^[0-9]{1,15}(\.[0-9]{1,6})?$/),
            forma: clean((method !== null && methods.has(method) ? methods.get(method)! : null) ?? jp(p, "method"), 120), observacao: clean(jp(p, "note"), 200),
          },
        });
      });
    }
  } else if (base === "comissoes") {
    for (const x of commissionRows(db, null)) {
      const s = one(db, 'SELECT r.name FROM "erp_catalog__seller" s LEFT JOIN "erp_catalog__record" r ON r.id=s.contact_id WHERE s.id=?', x.seller_id);
      if (!s) continue;
      const name = str(s.name);
      out.push({
        sort: x.due_on === null ? null : pgLower(name ?? "") + " " + dateKey(x.due_on) + " " + x.id,
        data: {
          vendedor: clean(name, 200), origem: x.origin === "document" ? "Venda" : "Manual", pedido: x.document_number === null ? null : String(x.document_number),
          descricao: clean(x.description, 200), parcela: cents(x.parcel_cents), base: cents(x.base_cents), aliquota: trimScale(formatScaled(x.rate, 6)),
          comissao: cents(x.commission_cents), vencimento: x.due_on, liberada: x.released_on,
          situacao: x.void === true ? "Anulada" : x.released_on !== null ? "Liberada" : "Pendente",
        },
      });
    }
  } else if (base === "caixa") {
    const name = (table: string, id: unknown) => (id === null || id === undefined ? null : (str(one(db, `SELECT name FROM "${table}" WHERE id=?`, id)?.name) ?? null));
    for (const l of statementLines(db, null, null, null, false))
      out.push({
        sort: dateKey(String(l.posted_on)) + " " + utcStamp(BigInt(String(l.created_at))) + " " + l.line_id,
        data: {
          data: str(l.posted_on), conta: clean(name("erp_finance__account", l.account_id), 200), descricao: clean(str(l.note), 200),
          contato: clean(name("erp_catalog__record", l.contact_id), 200), categoria: clean(name("erp_finance__category", l.category_id), 120),
          tipo:
            l.line_kind === "entry" ? "Lançamento" : l.line_kind === "transfer" ? "Transferência" : l.line_kind === "settlement" ? (l.title_kind === "receivable" ? "Recebimento" : "Pagamento") : "Saldo inicial",
          entrada: fromColumn(l.amount_cents) > 0n ? cents(fromColumn(l.amount_cents)) : null,
          saida: fromColumn(l.amount_cents) < 0n ? cents(-fromColumn(l.amount_cents)) : null,
        },
      });
  } else if (base === "curva_abc") {
    const sold = new Map<string, { qty: bigint; amount: bigint; orders: Set<string> }>();
    for (const r of db.exec(
      `SELECT d.id doc, i.product_id, CAST(i.quantity AS TEXT) q, CAST(i.total AS TEXT) t FROM "erp_documents__document" d JOIN "erp_documents__item" i ON i.document_id=d.id
       WHERE d.authority='brufap' AND d.kind='sales_orders' AND d.status NOT IN ('draft','cancelled') AND i.product_id IS NOT NULL`,
    ).rows) {
      const s = sold.get(String(r.product_id)) ?? { qty: 0n, amount: 0n, orders: new Set<string>() };
      s.qty += fromColumn(r.q);
      s.amount += fromColumn(r.t);
      s.orders.add(String(r.doc));
      sold.set(String(r.product_id), s);
    }
    const ranked = [...sold.entries()]
      .map(([id, s]) => ({ id, ...s, rec: one(db, 'SELECT code, name FROM "erp_catalog__record" WHERE id=?', id) }))
      .filter((x) => x.rec)
      .sort((x, y) => (x.amount > y.amount ? -1 : x.amount < y.amount ? 1 : compareText(x.id, y.id)));
    const total = ranked.reduce((s, x) => s + x.amount, 0n);
    /** round(a*100/b, 2)::text */
    const pct = (a: bigint) => {
      const num = a * 10000n,
        q = num / total,
        r = num % total;
      return formatScaled(r * 2n >= total ? q + 1n : q, 2);
    };
    let cum = 0n;
    ranked.forEach((x, idx) => {
      cum += x.amount;
      const before = (cum - x.amount) * 100n;
      out.push({
        sort: lpad(String(idx + 1), 10),
        data: {
          classe: total <= 0n ? "C" : before < 80n * total ? "A" : before < 95n * total ? "B" : "C",
          codigo: clean(str(x.rec!.code), 100), descricao: clean(str(x.rec!.name), 200), quantidade: trimScale(formatScaled(x.qty, 6)),
          valor: formatScaled(x.amount, 2), percentual: total > 0n ? pct(x.amount) : null, acumulado: total > 0n ? pct(cum) : null, pedidos: String(x.orders.size),
        },
      });
    });
  } else if (base === "pessoas_contato")
    for (const p of db.exec(
      `SELECT p.position, r.id, r.name, c.document, pr.name person, pc.email, pc.phone, pc.mobile FROM "erp_catalog__contact_person" p
       JOIN "erp_catalog__record" r ON r.id=p.contact_id JOIN "erp_catalog__contact" c ON c.record_id=p.contact_id
       JOIN "erp_catalog__record" pr ON pr.id=p.person_id JOIN "erp_catalog__contact" pc ON pc.record_id=p.person_id`,
    ).rows)
      out.push({
        sort: pgLower(String(p.name)) + " " + p.id + " " + lpad(String(p.position), 2),
        data: {
          contato: clean(str(p.name), 200), documento: clean(str(p.document), 20), nome: clean(str(p.person), 200), email: clean(str(p.email), 200),
          telefone: clean(str(p.phone), 40), celular: clean(str(p.mobile), 40),
        },
      });
  else if (base === "ficha_receber" || base === "ficha_pagar") {
    const returned = returnedTitles(db);
    for (const t of db.exec(
      `SELECT t.id, t.kind, t.due_on, t.issued_on, t.description, t.installment, t.installments, CAST(t.amount_cents AS TEXT) amount_cents, CAST(t.settled_cents AS TEXT) settled_cents,
        t.cancelled, r.id rid, r.name, c.document FROM "erp_finance__title" t JOIN "erp_catalog__record" r ON r.id=t.contact_id LEFT JOIN "erp_catalog__contact" c ON c.record_id=t.contact_id
       WHERE t.deleted_at IS NULL AND t.kind=?`,
      base === "ficha_receber" ? "receivable" : "payable",
    ).rows) {
      const cancelled = Number(t.cancelled) === 1;
      out.push({
        sort: pgLower(String(t.name)) + " " + t.rid + " " + dateKey(String(t.due_on)) + " " + t.id,
        data: {
          contato: clean(str(t.name), 200), documento: clean(str(t.document), 20), emissao: str(t.issued_on), vencimento: str(t.due_on),
          descricao: clean(str(t.description), 200), parcela: `${t.installment}/${t.installments}`, valor: cents(fromColumn(t.amount_cents)),
          pago: cents(fromColumn(t.settled_cents)), saldo: cents(cancelled ? 0n : fromColumn(t.amount_cents) - fromColumn(t.settled_cents)),
          situacao: titleSituation(t, today, returned.has(String(t.id)), (k) => (k === "receivable" ? "Parcialmente Recebida" : "Parcialmente Paga")),
        },
      });
    }
  } else if (base === "ocorrencias_propostas" || base === "ocorrencias_os" || base === "ocorrencias_vendas") {
    const kind = base === "ocorrencias_propostas" ? "sales_proposals" : base === "ocorrencias_os" ? "service_orders" : "sales_orders";
    for (const o of db.exec(
      `SELECT o.sequence, o.occurred_on, o.occurred_time, o.situation_before, o.situation_after, o.status_before, o.status_after, o.text, o.actor_id, o.next_contact,
        d.number, d.contact_snapshot FROM "erp_documents__occurrence" o JOIN "erp_documents__document" d ON d.id=o.document_id
       WHERE d.authority='brufap' AND d.kind=? AND NOT EXISTS(SELECT 1 FROM "erp_documents__occurrence_removal" x WHERE x.occurrence_id=o.id)`,
      kind,
    ).rows) {
      const before = jp(o.situation_before === null ? null : json(o.situation_before), "name") ?? documentStatus(kind, str(o.status_before));
      const after = jp(o.situation_after === null ? null : json(o.situation_after), "name") ?? documentStatus(kind, str(o.status_after) ?? str(o.status_before));
      out.push({
        sort: docKey(o.number) + lpad(String(o.sequence), 8),
        data: {
          numero: String(o.number), contato: clean(jp(json(o.contact_snapshot), "name"), 200), data: str(o.occurred_on), hora: str(o.occurred_time),
          situacao_anterior: clean(before, 80), situacao: clean(after, 80), ocorrencia: clean(str(o.text), 200),
          usuario: clean(o.actor_id === null ? null : actorLabel(db, String(o.actor_id)), 120),
          ...(base === "ocorrencias_propostas" ? { proximo_contato: str(o.next_contact) } : {}),
        },
      });
    }
  } else if (base === "transporte_venda")
    for (const d of db.exec(`SELECT number, status, body, contact_snapshot FROM "erp_documents__document" WHERE authority='brufap' AND kind='sales_orders'`).rows) {
      const body = json(d.body);
      const date = jp(body, "date");
      const carrierId = jp(body, "carrier_id");
      const carrier = carrierId === null ? undefined : one(db, 'SELECT name FROM "erp_catalog__record" WHERE id=?', carrierId);
      const t = (k: string) => jp(body, "commercial", "transport", k);
      const days = t("delivery_days");
      out.push({
        sort: docKey(d.number),
        data: {
          numero: String(d.number), data: date !== null && DATE.test(date) ? date : null, contato: clean(jp(json(d.contact_snapshot), "name"), 200),
          situacao: documentStatus("sales_orders", str(d.status)),
          transportador: clean(str(carrier?.name) ?? jp(body, "commercial", "transport", "carrier_reference", "label"), 200),
          frete: freight(t("freight_mode")), valor_frete: money2(jp(body, "freight"), /^[0-9]{1,15}(\.[0-9]{1,6})?$/),
          volumes: trimmed(t("volume_count"), /^[0-9]{1,12}(\.[0-9]{1,6})?$/), peso_bruto: trimmed(t("gross_weight"), /^[0-9]{1,12}(\.[0-9]{1,6})?$/),
          prazo: days !== null && /^(0|[1-9][0-9]{0,5})$/.test(days) ? days : null, rastreamento: clean(t("tracking_code"), 200),
        },
      });
    }
  else if (base === "transporte_nota")
    for (const i of db.exec(
      `SELECT id, number, series, issue_date, recipient, transport, CAST(freight AS TEXT) freight FROM "erp_fiscal_invoices__invoice" WHERE deleted_at IS NULL AND model='55' AND direction='1'`,
    ).rows) {
      const tr = json(i.transport);
      const qty = jp(tr, "volumes", "quantity");
      out.push({
        sort: invoiceKey(i),
        data: {
          numero: str(i.number), serie: str(i.series), emissao: str(i.issue_date), contato: clean(jp(json(i.recipient), "name"), 200),
          transportador: clean(jp(tr, "carrier", "name"), 200), documento_transportador: clean(jp(tr, "carrier", "document"), 20), frete: freight(jp(tr, "freight_by")),
          valor_frete: formatScaled(fromColumn(i.freight), 2), volumes: qty !== null && /^[0-9]{1,15}$/.test(qty) ? BigInt(qty).toString() : null,
          especie: clean(jp(tr, "volumes", "species"), 60), peso_bruto: trimmed(jp(tr, "volumes", "gross_weight"), /^[0-9]{1,12}(\.[0-9]{1,3})?$/),
          peso_liquido: trimmed(jp(tr, "volumes", "net_weight"), /^[0-9]{1,12}(\.[0-9]{1,3})?$/), placa: clean(jp(tr, "vehicle", "plate"), 10),
          rastreamento: clean(jp(tr, "tracking_code"), 60),
        },
      });
    }
  return out;
}
