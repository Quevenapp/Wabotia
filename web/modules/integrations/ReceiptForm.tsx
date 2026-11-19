import React, { useEffect, useState } from "react";
import { Button, Field } from "../../ui";
import { integrationError, useIntegrationApi } from "./api";
import { integrationAccess, useIntegrationHost } from "./visibility";
import type { ManualReceipt } from "./contracts";

export function receiptCents(text: string): number | null {
  if (!/^\d+([.,]\d{1,2})?$/.test(text.trim())) return null;
  const [whole, fraction = ""] = text.trim().replace(",", ".").split(".");
  const value = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}
export function ReceiptForm({ module, sourceId, onSaved, receiptId }: { module: "agenda" | "reserva" | "entrega"; sourceId: string; onSaved?(): void; receiptId?: string }) {
  const host = useIntegrationHost(), api = useIntegrationApi();
  const [amount, setAmount] = useState(""), [method, setMethod] = useState<ManualReceipt["method"]>("cash"), [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const access = host && integrationAccess(host.context);
  if (!api || !access?.localFinance || !access.localWrite(module)) return null;
  const scope = `receipt:${module}:${sourceId}`, pending = api.pending(scope);
  const execute = async (reverse = false) => {
    if (!confirmed && !pending || busy) return;
    const cents = receiptCents(amount);
    if (!reverse && !pending && cents == null) { setError("Informe um valor positivo com até duas casas decimais."); return; }
    setBusy(true); setError("");
    try {
      if (reverse && receiptId) await api.reverseReceipt(receiptId, "manual_receipt_annulled");
      else await api.receipt(module, sourceId, pending ? pending.body as ManualReceipt : { request_id: crypto.randomUUID(), amount_cents: cents!, method, occurred_ms: Date.now() });
      setConfirmed(false); setAmount(""); onSaved?.();
    } catch (e) { setError(integrationError(e)); } finally { setBusy(false); }
  };
  return <section><h3>Recebimento confirmado</h3><p>Registre somente dinheiro efetivamente recebido. Cancelar o atendimento não confirma devolução. O registro é local; a confirmação ERP é acompanhada separadamente.</p>
    <fieldset disabled={busy || !!pending}><Field label="Valor recebido (R$)" value={amount} onChange={setAmount} /><Field label="Meio de recebimento" value={method} onChange={v => setMethod(v as ManualReceipt["method"])} emptyOption={null} options={[{ id: "cash", name: "Dinheiro" }, { id: "pix", name: "Pix" }, { id: "card", name: "Cartão" }, { id: "other", name: "Outro" }, { id: "unknown", name: "Não informado" }]} /><label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> Conferi o recebimento ou a anulação real</label></fieldset>
    {error && <p role="alert">{error}</p>}
    <Button disabled={busy || !pending && !confirmed} onClick={() => void execute()}>{pending ? "Repetir o mesmo recebimento" : "Registrar recebimento"}</Button>
    {receiptId && <Button secondary disabled={busy || !confirmed} onClick={() => void execute(true)}>Confirmar anulação do recebimento</Button>}
  </section>;
}

export function AppointmentCommercialActions({ id, version, priceCents, onSaved }: { id: string; version: number | null; priceCents: number | null; onSaved(): void }) {
  const host = useIntegrationHost(), api = useIntegrationApi();
  const [review, setReview] = useState<"charge" | "complete" | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const access = host && integrationAccess(host.context);
  if (!api || !access?.localFinance || !access.localWrite("agenda")) return null;
  const pending = api.pending(`appointment:${id}`);
  return <section><p>{priceCents == null ? "Preço ainda não definido; nenhuma cobrança será inventada." : `Preço contratado: ${(priceCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`}</p>
    {version == null ? <p>O produtor ainda não informou a revisão comercial para cobrar ou concluir.</p> : <>
      <Button secondary disabled={busy || !!pending || priceCents == null || priceCents <= 0} onClick={() => setReview("charge")}>Conferir cobrança</Button>
      <Button secondary disabled={busy || !!pending} onClick={() => setReview("complete")}>Conferir conclusão</Button>
      {(review || pending) && <><p>Confirmar {review === "charge" ? "a cobrança explícita pelo preço contratado" : "a conclusão local"}. A confirmação ERP será acompanhada separadamente.</p><Button disabled={busy} onClick={() => {
        const command = pending?.body as { version: number } | undefined;
        const action = pending ? pending.path.endsWith("/charge") ? "charge" : "complete" : review!;
        setBusy(true); setError("");
        void api.appointment(id, action, command?.version ?? version).then(() => { setReview(null); onSaved(); }).catch(e => setError(integrationError(e))).finally(() => setBusy(false));
      }}>{pending ? "Repetir a mesma ação" : "Confirmar"}</Button></>}
    </>}
    {error && <p role="alert">{error}</p>}<ReceiptForm module="agenda" sourceId={id} onSaved={onSaved} />
  </section>;
}

export function ReceiptReverseForm() {
  const host = useIntegrationHost(), api = useIntegrationApi();
  const [id, setId] = useState(""), [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [done, setDone] = useState(false);
  if (!host || !api || !integrationAccess(host.context).finance) return null;
  return <section className="card"><h3>Anular recebimento</h3><p>Use a referência do recebimento original. Confirme somente uma devolução ou anulação efetivamente realizada.</p>
    <Field label="Referência do recebimento original" value={id} onChange={value => { setId(value); setConfirmed(false); setDone(false); }} disabled={busy} />
    <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} /> Conferi a anulação real</label>
    <Button disabled={busy || !confirmed || !id.trim()} onClick={() => { setBusy(true); setError(""); void api.reverseReceipt(id.trim(), "manual_receipt_annulled").then(() => { setDone(true); setConfirmed(false); }).catch(e => setError(integrationError(e))).finally(() => setBusy(false)); }}>{api.pending(`reverse:${id.trim()}`) ? "Repetir a mesma anulação" : "Confirmar anulação"}</Button>
    {error && <p role="alert">{error}</p>}{done && <p>Anulação registrada. Confira a confirmação ERP na origem.</p>}
  </section>;
}

export function DeliveryCommercialForm({ id }: { id: string }) {
  const host = useIntegrationHost(), api = useIntegrationApi(), access = host && integrationAccess(host.context);
  const allowed = access?.module("entrega") && (access.documents || access.finance || access.stock);
  const [data, setData] = useState<{ source: string; source_ref: string | null; commercial?: { revision: number; price_cents: number | null; authorized: boolean } } | null>(null);
  const [price, setPrice] = useState(""), [authorized, setAuthorized] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [reload, setReload] = useState(0);
  useEffect(() => {
    if (!api || !allowed) return;
    const request = new AbortController();
    void api.delivery(id, request.signal).then(value => { if (!request.signal.aborted) { setData(value); setPrice(value.commercial?.price_cents == null ? "" : (value.commercial.price_cents / 100).toFixed(2)); setAuthorized(value.commercial?.authorized ?? false); } }).catch(e => { if (!request.signal.aborted) setError(integrationError(e)); });
    return () => request.abort();
  }, [api, id, allowed, reload]);
  if (!api || !allowed) return null;
  if (data?.source === "pedido") return <p>Entrega vinculada ao pedido: o frete acompanha o documento do pedido e não será lançado novamente.</p>;
  const pending = api.pending(`delivery:${id}`);
  return <section><h3>Entrega avulsa</h3>{error && <p role="alert">{error}</p>}
    {data?.commercial ? <><fieldset disabled={busy || !!pending || !access?.write("entrega")}><Field label="Preço contratado (R$)" value={price} onChange={setPrice} /><label><input type="checkbox" checked={authorized} onChange={e => setAuthorized(e.target.checked)} /> Cobrança expressamente autorizada</label></fieldset>
      {access?.write("entrega") && <Button disabled={busy || !pending && (!authorized || receiptCents(price) == null)} onClick={() => {
        setBusy(true); setError("");
        void api.deliveryCommercial(id, pending?.body ?? { revision: data.commercial!.revision, price_cents: receiptCents(price), authorized }).then(() => setReload(n => n + 1)).catch(e => setError(integrationError(e))).finally(() => setBusy(false));
      }}>{pending ? "Repetir a mesma autorização" : "Confirmar preço e autorização"}</Button>}
      <ReceiptForm key={id} module="entrega" sourceId={id} onSaved={() => setReload(n => n + 1)} />
    </> : <p>Sem dados comerciais publicados pelo módulo. A entrega continua local, sem cobrança inventada.</p>}
  </section>;
}
