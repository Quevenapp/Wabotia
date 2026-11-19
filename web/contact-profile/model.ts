import type { ContactProfileView, Json, SectionView } from "../../src/customer/profile-contracts";
import type { CustomerJobView } from "../../src/customer/contracts";
import type { Api } from "../lib/api";
import { loadFullCustomerHost, type FullCustomerHost, type FullCustomerHostInput } from "./host-port";

export type IdentityFilter = "identified" | "phone_only" | "all";
export function contactsQuery(input: { search?: string; cursor?: string; identity?: IdentityFilter; review?: boolean }) {
  const query = new URLSearchParams({ q: input.search ?? "", cursor: input.cursor ?? "", identity: input.identity ?? "identified" });
  if (input.review) { query.set("identity", "phone_only"); query.set("review", "inactive180"); }
  return query.toString();
}

export function profileScopeKey(root: string, person: Record<string, any>, modules?: Record<string, boolean>) {
  return JSON.stringify([root, person.id, person.sessionId ?? person.session_id, person.role, person.access,
    Object.entries(modules ?? {}).sort(([a], [b]) => a.localeCompare(b))]);
}
export function profileMode(view: ContactProfileView): "simple" | "full" {
  return view.depth === "full" && !!view.erpContactId ? "full" : "simple";
}
export function profileMessage(error: unknown): string {
  const e = error as { code?: string; status?: number; message?: string };
  const messages: Record<string, string> = {
    dependency_unavailable: "Esta parte da ficha está temporariamente indisponível.",
    module_disabled: "O módulo foi desligado. Atualize a ficha para continuar.",
    contact_conflict: "O cadastro mudou. Recarregue os dados antes de salvar novamente.",
    customer_ambiguous: "Há mais de um contato possível. Resolva o vínculo antes de continuar.",
    sync_pending: "A atualização aguarda sincronização. Seus dados continuam salvos.",
    customer_erasing: "O contato tem uma solicitação de exclusão em andamento.",
    forbidden: "Você não tem permissão para esta parte da ficha.",
    not_found: "Esta ficha não está disponível nesta área.",
  };
  return messages[e?.code ?? ""] ?? (e?.status === 403 ? messages.forbidden : e?.message || "Não foi possível carregar. Tente novamente.");
}

/** Um canal por leitura ou formulário; uma seção nunca cancela outra. */
export class ProfileRequests {
  private requests = new Map<string, AbortController>();
  private disposed = false;
  begin(key: string) {
    this.requests.get(key)?.abort();
    const controller = new AbortController();
    if (this.disposed) controller.abort();
    this.requests.set(key, controller);
    return { signal: controller.signal, current: () => !controller.signal.aborted && this.requests.get(key) === controller };
  }
  cancel(key: string) { this.requests.get(key)?.abort(); this.requests.delete(key); }
  dispose() { this.disposed = true; for (const request of this.requests.values()) request.abort(); this.requests.clear(); }
}

/** Intenção estável por formulário: repetir após timeout conserva comando e versão. */
export function sectionWriter(api: Api, path: string) {
  let pending: { signature: string; commandId: string } | null = null;
  return async (section: SectionView, data: Json, signal: AbortSignal): Promise<SectionView> => {
    const changes = sectionChanges(section, data);
    const signature = JSON.stringify([section.version, changes]);
    if (pending?.signature !== signature) pending = { signature, commandId: crypto.randomUUID() };
    const command = pending;
    const result: SectionView = await api(path, "PUT", { commandId: command.commandId, expectedVersion: section.version, data: changes }, signal, command.commandId);
    if (result.schema !== section.schema || !Number.isSafeInteger(result.version) || result.version < section.version)
      throw new Error("Não foi possível confirmar a versão salva.");
    if (pending === command) pending = null;
    return result;
  };
}

/** A seção devolve um snapshot; PUT recebe até dez operações, sem rótulos derivados. */
export function sectionChanges(section: SectionView, draft: Json): Json {
  if (section.schema !== "condominio.units.v1" || !draft || typeof draft !== "object" || Array.isArray(draft) || !Array.isArray(draft.memberships)) return draft;
  const before = section.data as Record<string, Json>;
  const pick = (row: any, keys: string[]) => Object.fromEntries(keys.map(key => [key, row[key]]));
  const changed = (key: string) => (draft[key] as any[] ?? []).filter(row =>
    JSON.stringify(row) !== JSON.stringify((before[key] as any[] ?? []).find(old => key === "subscriptions"
      ? old.unitId === row.unitId && old.subscriptionId === row.subscriptionId : old.id === row.id)));
  const memberships = changed("memberships").map(row => pick(row, ["id", "personId", "unitId", "role", "startsAt", "endsAt", "notices"]));
  const functions = changed("functions").map(row => ({ ...pick(row, ["id", "personId", "unitId", "role", "startsAt", "endsAt"]), expectedVersion: row.version ?? 0 }));
  const subscriptions = changed("subscriptions").map(row => ({ ...pick(row, ["unitId", "subscriptionId"]), linked: row.linked !== false }));
  if (memberships.length + functions.length + subscriptions.length > 10) throw new Error("Salve até dez alterações por vez.");
  return { memberships, functions, subscriptions } as Json;
}

/** Cancelamento cobre também importação e mount que não respeitam AbortSignal. */
export async function mountProfileHost(element: HTMLElement, view: ContactProfileView,
  input: FullCustomerHostInput, signal: AbortSignal, loader: () => Promise<FullCustomerHost> = loadFullCustomerHost) {
  const abort = () => { throw new DOMException("Ficha fechada", "AbortError"); };
  if (profileMode(view) !== "full" || view.contactId !== input.contactId || view.profileId !== input.profileId || view.erpContactId !== input.erpContactId)
    throw Object.assign(new Error("Ficha completa não autorizada."), { code: "forbidden" });
  if (signal.aborted) return abort();
  const host = await loader();
  if (signal.aborted) return abort();
  const mounted = await host.mount(element, { ...input,
    onSaved: () => { if (!signal.aborted) input.onSaved(); },
    onClose: () => { if (!signal.aborted) input.onClose(); },
  });
  let disposed = false;
  const dispose = () => { if (!disposed) { disposed = true; mounted.dispose(); } signal.removeEventListener("abort", dispose); };
  if (signal.aborted) { dispose(); return abort(); }
  signal.addEventListener("abort", dispose, { once: true });
  return { dispose };
}

export type ErpBinding = { contactId: string | null; jobId: string | null; state?: string };
export async function bindErpContact(api: Api, root: string, erpId: string, signal: AbortSignal, commandId: string): Promise<ErpBinding> {
  const result = await api(root + "/contacts/from-erp", "POST", { erpId }, signal, commandId);
  // IDs de domínios distintos: só a resposta autorizada do D1 fornece contactId.
  const contactId = result.contactId ?? result.contact?.id ?? null;
  const jobId = result.jobId ?? null;
  if (typeof contactId !== "string" && typeof jobId !== "string") throw new Error("O vínculo com a ficha ainda não está disponível.");
  return { contactId, jobId, state: result.state };
}
export const readContactJob = (api: Api, root: string, id: string, signal: AbortSignal): Promise<CustomerJobView> =>
  api(root + "/contact-jobs/" + encodeURIComponent(id), "GET", undefined, signal);
