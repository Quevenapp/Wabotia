import type { Destination, SourceIntegrationState } from "./contracts";
import { IntegrationError } from "./privacy";

/** Projeção comum à API de integração e ao comercial de Trabalho. */
export function effectiveSourceState(rows: any[], correctionInProgress = false) {
  const pending = new Map<string, Set<Destination>>(), applied = new Set<Destination | "document">();
  const closed = new Map<string, string>(), skipped = new Map<string, string>();
  for (const d of rows) {
    const fact = d.payload_json ? JSON.parse(d.payload_json) : d;
    const eligible = typeof d.eligible === "string" ? JSON.parse(d.eligible) : fact.eligible ?? {};
    const component = d.component ?? fact.source?.component ?? "main", operation = d.operation ?? fact.operation;
    const manual = pending.get(component) ?? new Set<Destination>();
    pending.set(component, manual);
    if (!d.receipt_json) {
      if (d.state === "done" && d.error_code !== "no_commercial_content") skipped.set(component, d.error_code ?? "part_disabled");
      if (d.state === "waiting_manual") {
        for (const target of ["stock", "finance"] as const) if (eligible[target]) manual.add(target);
      }
      continue;
    }
    const result = JSON.parse(d.receipt_json);
    if (result.outcome === "applied" && (result.links.length || Object.values(result.effects).some(effect => ["posted", "settled", "reversed"].includes(String(effect))))) skipped.delete(component);
    if (result.outcome === "closed") closed.set(component, result.reason_code ?? "epoch_closed"); else closed.delete(component);
    for (const link of result.links) {
      if (link.kind === "document") applied.add("document");
      if (link.kind === "title" || link.kind === "settlement") applied.add("finance");
      if (link.kind === "stock_posting") applied.add("stock");
    }
    for (const target of ["stock", "finance"] as const) {
      if (["posted", "settled", "reversed"].includes(result.effects[target])) {
        manual.delete(target); applied.add(target);
      } else if (eligible[target] && ["execute", "recognize", "receive"].includes(operation) && result.outcome === "applied" && result.effects[target] === "not_requested") manual.add(target);
    }
    if (result.outcome === "skipped" || result.reason_code === "part_disabled") skipped.set(component, result.reason_code ?? "part_disabled");
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
    skipped_reason: state === "skipped" ? manual.size ? "automation_off" : [...skipped.values()][0] : null,
    blocked_reason: state === "blocked" ? new IntegrationError(reason ?? "version_conflict").message : null,
    reason_code: reason ?? null };
}
