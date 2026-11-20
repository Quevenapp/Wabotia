import type { Destination, SourceIntegrationState } from "./contracts";
import { IntegrationError } from "./privacy";

/** Projeção comum à API de integração e ao comercial de Trabalho. */
export function effectiveSourceState(rows: any[], correctionInProgress = false) {
  const pending = new Map<string, Set<Destination>>(), applied = new Set<Destination | "document">();
  const closed = new Map<string, string>(), skipped = new Map<string, string>();
  const fiscalPending = new Set<string>();
  for (const d of rows) {
    const fact = d.payload_json ? JSON.parse(d.payload_json) : d;
    const eligible = typeof d.eligible === "string" ? JSON.parse(d.eligible) : fact.eligible ?? {};
    const component = d.component ?? fact.source?.component ?? "main", operation = d.operation ?? fact.operation;
    // Execução comercial, recebimento e manutenção têm resoluções distintas.
    // Um vínculo de documento num lifecycle não prova o lançamento ausente.
    const scope = `${component}:${operation}`;
    const manual = pending.get(scope) ?? new Set<Destination>();
    pending.set(scope, manual);
    if (!d.receipt_json) {
      if (d.state === "done" && !["no_commercial_content", "payment_evidence_recovered", "cancellation_resolved"].includes(d.error_code)) skipped.set(scope, d.error_code ?? "part_disabled");
      if (d.state === "waiting_manual") {
        for (const target of ["stock", "finance"] as const) if (eligible[target]) manual.add(target);
      }
      continue;
    }
    const result = JSON.parse(d.receipt_json);
    if (result.outcome === "applied" && (result.links.length || Object.values(result.effects).some(effect => ["posted", "settled", "reversed"].includes(String(effect))))) skipped.delete(scope);
    const cancellationPending = ["module_cancellation_pending", "consumption_requires_classification", "refund_confirmed_review_stock"].includes(result.reason_code);
    if (cancellationPending) closed.set(`${scope}:cancel`, result.reason_code);
    else if (operation === "cancel" && result.outcome === "applied") closed.delete(`${scope}:cancel`);
    if (result.outcome === "closed") {
      for (const target of ["stock", "finance"] as const) if (eligible[target]) {
        closed.set(`${scope}:${target}`, result.reason_code ?? "epoch_closed"); manual.add(target);
      }
      if (!eligible.stock && !eligible.finance) closed.set(`${scope}:document`, result.reason_code ?? "epoch_closed");
    } else if (result.outcome === "applied" && result.links.some((l: any) => l.kind === "document")) closed.delete(`${scope}:document`);
    for (const link of result.links) {
      if (link.kind === "document") applied.add("document");
      if (link.kind === "title" || link.kind === "settlement") applied.add("finance");
      if (link.kind === "stock_posting") applied.add("stock");
    }
    for (const target of ["stock", "finance"] as const) {
      if (["posted", "settled", "reversed"].includes(result.effects[target])) {
        fiscalPending.delete(`${component}:${target}`);
        manual.delete(target); closed.delete(`${scope}:${target}`); applied.add(target);
        if (result.effects[target] === "posted") for (const op of ["execute", "recognize"]) {
          closed.delete(`${component}:${op}:${target}`); pending.get(`${component}:${op}`)?.delete(target);
        }
      } else if (result.reason_code === "awaiting_fiscal_authorization" && result.effects[target] === "skipped") {
        fiscalPending.add(`${component}:${target}`); manual.add(target);
      } else if (cancellationPending && result.links.some((link: any) =>
        target === "finance" ? ["title", "settlement"].includes(link.kind) : link.kind === "stock_posting")) manual.add(target);
      else if (eligible[target] && ["execute", "recognize", "receive"].includes(operation) && result.outcome === "applied" && result.effects[target] === "not_requested") manual.add(target);
    }
    if (operation === "cancel" && result.outcome === "applied") for (const target of ["stock", "finance"] as const) {
      if (fiscalPending.delete(`${component}:${target}`)) for (const op of ["execute", "recognize", "lifecycle"])
        pending.get(`${component}:${op}`)?.delete(target);
    }
    if (result.outcome === "skipped" || result.reason_code === "part_disabled") skipped.set(scope, result.reason_code ?? "part_disabled");
  }
  const manual = new Set([...pending.values()].flatMap(values => [...values]));
  const unfinished = rows.find(d => !["done", "waiting_manual"].includes(d.state));
  let state: SourceIntegrationState = unfinished ? unfinished.state === "sending" ? "pending" : unfinished.unresolved ? "uncertain" : unfinished.state
    : closed.size ? "blocked" : manual.size || skipped.size ? "skipped" : applied.size ? "done" : "none";
  if (!["none", "skipped", "pending", "blocked", "failed", "uncertain", "done"].includes(state)) state = "pending";
  if (correctionInProgress) state = "blocked";
  const reason = correctionInProgress ? "correction_in_progress" : unfinished?.error_code ?? [...closed.values()][0];
  return { state, manual, applied: [...applied],
    pending: correctionInProgress || !!unfinished || closed.size > 0 || manual.size > 0,
    skipped_reason: state === "skipped" ? fiscalPending.size ? "awaiting_fiscal_authorization" : manual.size ? "automation_off" : [...skipped.values()][0] : null,
    blocked_reason: state === "blocked" ? new IntegrationError(reason ?? "version_conflict").message : null,
    reason_code: reason ?? null };
}
