// Partes do orçamento (OS3): busca no catálogo do ERP e condições de
// pagamento. Componentes próprios: cada um consulta só o que a parte ligada
// e o papel da pessoa permitem; sem permissão, o orçamento segue com itens
// avulsos e formas genéricas.
import React, { useState } from "react";
import { useApp } from "../../../app/AppContext";
import { Button, Field, Notice } from "../../../ui";
import type { QuoteTerms } from "../work-contracts";
import { money } from "../shared";
import { useWorkApi, useWorkResource } from "../work-hooks";
import { useIntegrationApi, integrationError } from "../../integrations/api";
import { integrationAccess, useIntegrationHost } from "../../integrations/visibility";

export interface CatalogPick { id: string; name: string; code: string | null; unit: string | null; kind: "material" | "service"; price_cents: number | null }
/** Item da lista de produtos do ERP (cadastros/products), com preço e código. */
export function catalogPick(row: { id: string; name: string; code?: string | null; unit?: string | null; kind?: string | null; price?: string | number | null }): CatalogPick {
  const price = row.price === null || row.price === undefined || row.price === "" ? null : Math.round(Number(row.price) * 100);
  return { id: row.id, name: row.name, code: row.code ?? null, unit: row.unit ?? null, kind: row.kind === "S" ? "service" : "material",
    price_cents: price !== null && Number.isFinite(price) && price >= 0 ? price : null };
}

export function CatalogSearch({ onPick }: { onPick: (item: CatalogPick) => void }) {
  const host = useIntegrationHost(), api = useIntegrationApi();
  const access = host && integrationAccess(host.context);
  const [query, setQuery] = useState(""), [items, setItems] = useState<CatalogPick[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [searched, setSearched] = useState(false);
  if (!api || !access?.products)
    return <Notice>Seu perfil não consulta o catálogo do ERP. Use itens avulsos ou peça ao administrador o acesso a Produtos e serviços.</Notice>;
  const search = () => {
    if (!query.trim()) return;
    setBusy(true); setError("");
    void api.catalog(query.trim())
      .then((rows) => { setItems((rows as unknown as Parameters<typeof catalogPick>[0][]).map(catalogPick)); setSearched(true); })
      .catch((e) => setError(integrationError(e)))
      .finally(() => setBusy(false));
  };
  return <section className="os-quote-catalog" aria-label="Catálogo do ERP">
    <div className="form-field-grid">
      <Field label="Buscar peça ou serviço do catálogo (nome ou código)" value={query} onChange={setQuery} />
      <Button secondary disabled={busy || !query.trim()} onClick={search}>Buscar no catálogo</Button>
    </div>
    {error && <Notice tone="error">{error}</Notice>}
    {searched && !items.length && <p className="muted">Nada encontrado com esse nome ou código. Confira o cadastro em ERP → Produtos e serviços.</p>}
    <ul className="os-quote-results">{items.map((item) => <li key={item.id}>
      <Button secondary size="sm" onClick={() => onPick(item)}>Adicionar</Button>{" "}
      {item.name}{item.code ? ` · ${item.code}` : ""} · {item.kind === "service" ? "Serviço" : "Peça"}
      {item.price_cents !== null ? ` · ${money(item.price_cents)}` : " · sem preço na lista"}{item.unit ? ` / ${item.unit}` : ""}
    </li>)}</ul>
  </section>;
}

// ---------------------------------------------------------------------------
// Condições de pagamento

export const GENERIC_METHODS = [
  { id: "pix", name: "Pix" }, { id: "cash", name: "Dinheiro" }, { id: "card", name: "Cartão" },
  { id: "boleto", name: "Boleto" }, { id: "transfer", name: "Transferência" }, { id: "other", name: "Outra forma" },
];
export interface TermsDraft {
  payerId: string; payerName: string;
  /** "" | forma genérica | "erp:<id>" */
  method: string; methodLabel: string;
  count: string; first: string; interval: string;
}
const today = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
export function termsDraft(terms: QuoteTerms | null | undefined): TermsDraft {
  return {
    payerId: terms?.payer_contact_id || "", payerName: terms?.payer_name || "",
    method: terms?.payment_method_id ? `erp:${terms.payment_method_id}` : terms?.method || "",
    methodLabel: terms?.method_label || "",
    count: terms?.installments ? String(terms.installments.count) : "1",
    first: terms?.installments?.first_due_on || today(),
    interval: terms?.installments ? String(terms.installments.interval_days) : "30",
  };
}
/** Corpo enviado ao servidor; sem Financeiro, nada de parcelas. */
export function termsBody(draft: TermsDraft, finance: boolean): Partial<QuoteTerms> | null {
  const erp = draft.method.startsWith("erp:") ? draft.method.slice(4) : null;
  const generic = !erp && draft.method ? draft.method as QuoteTerms["method"] : null;
  const count = Number(draft.count), interval = Number(draft.interval);
  if (finance && (!Number.isInteger(count) || count < 1 || count > 24)) throw new Error("Parcelas: informe de 1 a 24.");
  if (finance && (!Number.isInteger(interval) || interval < 1 || interval > 365)) throw new Error("Intervalo entre parcelas: de 1 a 365 dias.");
  if (finance && !/^\d{4}-\d\d-\d\d$/.test(draft.first)) throw new Error("Informe a data da primeira parcela.");
  const empty = !draft.payerId && !draft.method && (!finance || count === 1 && draft.first === today());
  if (empty) return null;
  return {
    payer_contact_id: draft.payerId || null, payer_name: draft.payerId ? draft.payerName : "",
    method: erp ? "other" : generic, payment_method_id: erp, method_label: draft.methodLabel,
    installments: finance ? { count, first_due_on: draft.first, interval_days: interval } : null,
  };
}
/** Mesma divisão do servidor: parcelas iguais, a diferença na primeira. */
export function previewInstallments(draft: TermsDraft, total: number) {
  const count = Math.min(Number(draft.count) || 1, Math.max(total, 1)), interval = Number(draft.interval) || 30;
  if (total <= 0 || !/^\d{4}-\d\d-\d\d$/.test(draft.first)) return [];
  const base = Math.floor(total / count), first = total - base * (count - 1);
  return Array.from({ length: count }, (_, i) => {
    const at = new Date(draft.first + "T12:00:00Z"); at.setUTCDate(at.getUTCDate() + i * interval);
    return { number: i + 1, due_on: at.toISOString().slice(0, 10), amount_cents: i === 0 ? first : base };
  });
}
const civil = (date: string) => date.split("-").reverse().join("/");

export function QuoteTermsFields({ value, onChange, total, finance, customerName }: {
  value: TermsDraft; onChange: (value: TermsDraft) => void; total: number; finance: boolean; customerName: string;
}) {
  const app = useApp(), api = useWorkApi();
  const [search, setSearch] = useState(""), [query, setQuery] = useState("");
  const contacts = useWorkResource(query ? `${app.root}/os3-payer/${query}` : null, () => api.contacts(query));
  const methods = useWorkResource(finance ? `${app.root}/os3-methods` : null, () => api.paymentMethods());
  const erpMethods = (methods.data?.items || []).filter((m) => m.active !== false).map((m) => ({ id: `erp:${m.id}`, name: m.name || m.description || "Forma do Financeiro" }));
  const options = [...erpMethods, ...GENERIC_METHODS.filter((g) => !erpMethods.some((m) => m.name.toLowerCase() === g.name.toLowerCase()))];
  const payers = (contacts.data?.data || []).filter((c) => !c.merged_into && (!c.namespace || c.namespace === "team") && (!c.identity_state || c.identity_state === "active") && c.name);
  const set = (patch: Partial<TermsDraft>) => onChange({ ...value, ...patch });
  const plan = finance ? previewInstallments(value, total) : [];
  return <fieldset className="os-quote-terms">
    <legend>Condições de pagamento</legend>
    <p>Pagador: <strong>{value.payerId ? value.payerName || "Contato escolhido" : `${customerName || "cliente"} (cliente da ordem)`}</strong>
      {value.payerId && <> <Button secondary size="sm" onClick={() => set({ payerId: "", payerName: "" })}>Usar o cliente da ordem</Button></>}</p>
    <div className="form-field-grid">
      <Field label="Outro pagador do cadastro" value={search} onChange={setSearch} placeholder="Nome ou telefone" />
      <Button secondary disabled={!search.trim()} onClick={() => setQuery(search.trim())}>Buscar pagador</Button>
    </div>
    {query && contacts.data && !payers.length && <p className="muted">Nenhum contato com nome encontrado. Cadastre o pagador em Contatos.</p>}
    {payers.length > 0 && <Field label="Escolha o pagador" value={value.payerId} emptyOption="Selecione..."
      options={payers.map((c) => ({ id: c.id, name: `${c.name}${c.phone ? " · " + c.phone : ""}` }))}
      onChange={(id) => { const c = payers.find((p) => p.id === id); if (c) set({ payerId: c.id, payerName: c.name || "" }); }} />}
    <Field label="Forma de pagamento" value={value.method} emptyOption="Combinar depois" options={options}
      onChange={(id) => set({ method: id, methodLabel: options.find((o) => o.id === id)?.name || "" })}
      help={finance && methods.error ? "As formas do Financeiro não puderam ser lidas com seu perfil; use uma forma genérica." : undefined} />
    {finance ? <>
      <div className="form-field-grid">
        <Field label="Parcelas" type="number" min={1} max={24} value={value.count} onChange={(count) => set({ count })} />
        <Field label="Primeira parcela" type="date" value={value.first} onChange={(first) => set({ first })} />
        <Field label="Intervalo (dias)" type="number" min={1} max={365} value={value.interval} onChange={(interval) => set({ interval })} />
      </div>
      {plan.length > 0 && <p className="muted">Será cobrado: {plan.length > 1
        ? plan.map((p) => `${p.number}ª ${money(p.amount_cents)} em ${civil(p.due_on)}`).join(" · ")
        : `${money(plan[0].amount_cents)} em ${civil(plan[0].due_on)}`}{value.methodLabel ? ` · ${value.methodLabel}` : ""}</p>}
    </> : <p className="muted">Sem o Financeiro do ERP ligado, a ordem guarda só o total combinado ({money(total)}), sem parcelas.</p>}
  </fieldset>;
}
