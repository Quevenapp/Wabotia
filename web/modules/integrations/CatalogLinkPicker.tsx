import React, { useState } from "react";
import { Button, Field } from "../../ui";
import { useIntegrationApi, integrationError } from "./api";
import { integrationAccess, useIntegrationHost } from "./visibility";
import type { CatalogItem, CatalogLink, IntegrationModule, StockObservation } from "./contracts";
import { confirmationTime } from "./IntegrationStatus";

export function stockAvailable(row: StockObservation): string | null {
  if (row.available_quantity != null) return row.available_quantity;
  if (row.quantity == null || row.reserved_quantity == null) return null;
  const units = (s: string) => { if (!/^-?\d+(\.\d{1,6})?$/.test(s)) throw new Error(); const [whole, decimal = ""] = s.replace("-", "").split("."); return BigInt(whole + decimal.padEnd(6, "0")) * (s.startsWith("-") ? -1n : 1n); };
  try { const amount = units(row.quantity) - units(row.reserved_quantity), text = String(amount < 0n ? -amount : amount).padStart(7, "0"); return (amount < 0n ? "-" : "") + text.slice(0, -6) + "." + text.slice(-6); } catch { return null; }
}
export function CatalogLinkPicker({ value, onChange, module, recordKind, recordId, component = "main", disabled = false }: {
  value?: CatalogLink; onChange?(value: CatalogLink, item: CatalogItem | null): void; module?: IntegrationModule; recordKind?: string; recordId?: string; component?: string; disabled?: boolean;
}) {
  const host = useIntegrationHost(), api = useIntegrationApi(), access = host && integrationAccess(host.context);
  const [query, setQuery] = useState(""), [items, setItems] = useState<CatalogItem[]>([]), [error, setError] = useState(""), [busy, setBusy] = useState(false), [balances, setBalances] = useState<StockObservation[] | null>(null), [balanceApi, setBalanceApi] = useState(api);
  const [saved, setSaved] = useState<CatalogLink | undefined>();
  const selected = saved ?? value;
  const choose = async (item: CatalogItem | null) => {
    if (!api || !access?.products || disabled) return;
    setBusy(true); setError("");
    try { const link = { erp_item_id: item?.id ?? null, version: selected?.version ?? 0 }; const result = module && recordKind && recordId ? await api.link(module, recordKind, recordId, component, link) : link; setSaved(result); onChange?.(result, item); setBalances(null); }
    catch (e) { setError(integrationError(e)); } finally { setBusy(false); }
  };
  return <section aria-label="Vínculo opcional de catálogo">
    {!selected?.erp_item_id && <p>Item livre: não baixa estoque e não cria produto no catálogo.</p>}
    {selected?.erp_item_id && <p>Produto ou serviço vinculado: {selected.erp_item_id}. O vínculo não altera o preço contratado.</p>}
    {api && access?.products && !disabled && <>
      <Field label="Buscar produto ou serviço (opcional)" value={query} onChange={setQuery} />
      <Button secondary disabled={busy || !query.trim()} onClick={() => { setBusy(true); setError(""); void api.catalog(query).then(setItems).catch(e => setError(integrationError(e))).finally(() => setBusy(false)); }}>Buscar catálogo</Button>
      <ul>{items.map(item => <li key={item.id}><Button secondary disabled={busy} onClick={() => void choose(item)}>{item.name}{item.unit ? ` · ${item.unit}` : ""}</Button></li>)}</ul>
      {selected?.erp_item_id && <Button secondary disabled={busy} onClick={() => void choose(null)}>Usar item livre</Button>}
    </>}
    {api && access?.stock && selected?.erp_item_id && <Button secondary disabled={busy} onClick={() => { setBusy(true); setError(""); void api.stock(selected.erp_item_id!).then(rows => { setBalances(rows); setBalanceApi(api); }).catch(e => setError(integrationError(e))).finally(() => setBusy(false)); }}>Consultar estoque observado</Button>}
    {access?.stock && balanceApi === api && balances && <><table><thead><tr><th>Depósito</th><th>Físico</th><th>Reservado</th><th>Disponível</th><th>Observado em São Paulo</th></tr></thead><tbody>{balances.map(row => <tr key={row.warehouse_id}><td>{row.warehouse_name}</td><td>{row.quantity ?? "Desconhecido"}</td><td>{row.reserved_quantity ?? "Desconhecido"}</td><td>{stockAvailable(row) ?? "Desconhecido"}</td><td>{confirmationTime(row.observed_ms)}</td></tr>)}</tbody></table>{!balances.length && <p>Saldo desconhecido: nenhum depósito informado.</p>}<p>Consulta informativa. Não altera a disponibilidade manual nem impede a operação local.</p></>}
    {error && <p role="alert">{error}</p>}
  </section>;
}

/** O cadastro operacional entrega o vínculo e sua versão; a escolha não recalcula preços. */
export function CatalogRecordLinks({ module, kind, records: rawRecords }: { module: IntegrationModule; kind: string; records: Record<string, unknown>[] }) {
  const host = useIntegrationHost();
  const [id, setId] = useState("");
  if (!host || !integrationAccess(host.context).products || !integrationAccess(host.context).write(module)) return null;
  const records = rawRecords.filter(row => typeof row.id === "string" && typeof row.name === "string") as { id: string; name: string; catalog_link?: CatalogLink }[];
  const record = records.find(row => row.id === id);
  return <section className="card"><h3>Catálogo ERP opcional</h3><Field label="Cadastro local" value={id} onChange={setId} options={records.map(row => ({ id: row.id, name: row.name }))} />
    {record && <CatalogLinkPicker key={module + id} module={module} recordKind={kind} recordId={id} value={record.catalog_link} />}
  </section>;
}
