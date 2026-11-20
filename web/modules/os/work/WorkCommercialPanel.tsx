import React, { useEffect, useState } from "react";
import { Button } from "../../../ui";
import { IntegrationStatus } from "../../integrations/IntegrationStatus";
import { integrationError, useIntegrationApi } from "../../integrations/api";
import { integrationAccess, useIntegrationHost } from "../../integrations/visibility";
import type { WorkCommercialView } from "../../integrations/contracts";
import { money } from "../shared";

export function WorkCommercialPanel({ workId }: { workId: string }) {
  const host = useIntegrationHost(), api = useIntegrationApi();
  const access = host && integrationAccess(host.context);
  const allowed = access?.module("os") && (access.documents || access.stock || access.finance);
  const [open, setOpen] = useState(false), [data, setData] = useState<{ api: typeof api; id: string; value: WorkCommercialView } | null>(null), [error, setError] = useState("");
  const [approve, setApprove] = useState(false), [busy, setBusy] = useState(false), [reload, setReload] = useState(0);
  useEffect(() => {
    if (!api || !allowed || !open) return;
    const request = new AbortController(); setError("");
    void api.commercial(workId, request.signal).then(value => { if (!request.signal.aborted) setData({ api, id: workId, value }); }).catch(e => { if (!request.signal.aborted) setError(integrationError(e)); });
    return () => request.abort();
  }, [api, allowed, open, workId, reload]);
  const value = data?.api === api && data.id === workId ? data.value : null;
  return <section><h3>Parte comercial</h3><IntegrationStatus module="os" sourceId={workId} />
    {allowed && <Button secondary onClick={() => setOpen(!open)}>{open ? "Recolher dados comerciais" : "Conferir dados comerciais"}</Button>}
    {allowed && open && <>{error && <p role="alert">{error}</p>}{value && <>
      <p>{value.frozen ? "Itens, cliente, depósito e parcelas congelados após o lançamento." : "Altere os itens no orçamento antes do lançamento."}</p>
      <ul>{value.items.map(item => <li key={item.id}>{item.description} · {item.quantity} {item.unit} · {money(item.unit_cents)}{!item.product_id && " · Item livre: não baixa estoque"}</li>)}</ul>
      <p>Total contratado: {money(value.total_cents)}</p>
      {access?.finance && <ul>{value.installments.map(item => <li key={item.key}>{item.due_on}: {money(item.amount_cents)}</li>)}</ul>}
      <p>{value.authorization ? "Autorização comercial registrada." : "Sem autorização comercial para a primeira execução."}</p>
      {!value.frozen && access?.write("os") && api && <>
        <label><input type="checkbox" checked={approve} disabled={busy || !!api.pending(`commercial:${workId}`)} onChange={e => setApprove(e.target.checked)} /> Autorizo expressamente o preço fixo de {money(value.total_cents)} para este trabalho</label>
        <Button disabled={busy || !approve && !api.pending(`commercial:${workId}`)} onClick={() => {
          setBusy(true); setError("");
          const body = api.pending(`commercial:${workId}`)?.body ?? { version: value.version, authorize_fixed_price: true };
          void api.saveCommercial(workId, body).then(() => { setApprove(false); setReload(n => n + 1); }).catch(e => setError(integrationError(e))).finally(() => setBusy(false));
        }}>{api.pending(`commercial:${workId}`) ? "Repetir a mesma autorização" : "Confirmar autorização de preço fixo"}</Button>
      </>}
    </>}</>}
  </section>;
}
