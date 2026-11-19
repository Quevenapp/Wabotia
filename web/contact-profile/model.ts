import type { ContactProfileView, Json, SectionView } from "../../src/customer/profile-contracts";
import type { CustomerJobView } from "../../src/customer/contracts";
import type { ContactMergePreview, ContactMergeRequest, ContactMergeResult, ContactMergeUndoRequest } from "../../src/channel-contracts";
import type { Api } from "../lib/api";
import { loadFullCustomerHost, type FullCustomerHost, type FullCustomerHostInput } from "./host-port";

export type ProfileVocabulary = ContactProfileView["vocabulary"];
export function contactVocabulary(value?: Partial<ProfileVocabulary>, supplier = false): ProfileVocabulary {
  if (supplier) return { singular: "Fornecedor", plural: "Fornecedores" };
  return { singular: value?.singular?.trim() || "Cliente", plural: value?.plural?.trim() || "Clientes" };
}
export const contactNamespace = (contact?: Record<string, any> | null, conversation?: Record<string, any>) =>
  contact?.namespace ?? (conversation?.external_namespace?.startsWith("app:") ? conversation.external_namespace : "team");
export function contactWriter(api: Api) {
  const receipts = new Map<string, string>();
  return (path: string, method: string, body: any, signal?: AbortSignal) => {
    const signature = JSON.stringify([path, method, body]);
    if (!receipts.has(signature)) receipts.set(signature, crypto.randomUUID());
    return api(path, method, body, signal, receipts.get(signature));
  };
}

// Extensão aditiva enquanto o contrato comum da fila é integrado pela frente de cadastro.
export type ProfileJob = Omit<CustomerJobView, "state"> & {
  state: CustomerJobView["state"] | "failed";
  updated?: number;
  reason?: string | null;
  expectedVersion?: number | null;
};
const jobMessages: Record<string, string> = {
  pending: "Atualização aguardando processamento.", running: "Atualização em processamento…",
  paused: "Atualização pausada.", conflict: "A atualização precisa de revisão por conflito de dados.",
  retained: "Solicitação retida para revisão.", cancelled: "Solicitação cancelada. Você pode iniciar uma nova edição.",
  failed: "A atualização falhou. Revise os dados antes de iniciar uma nova edição.", done: "Atualização concluída.",
};
export function jobMessage(job: Partial<ProfileJob>) {
  const reasons: Record<string, string> = { module_disabled: "O módulo está desligado.", awaiting_proof: "Falta comprovação do vínculo com o canal.",
    contact_required: "Complete os campos obrigatórios.", field_conflict: "Os dados foram alterados por outra operação.",
    contact_conflict: "A versão do cadastro mudou.", customer_ambiguous: "Há mais de um cadastro possível.",
    dependency_unavailable: "O serviço está indisponível.", forbidden: "Sem permissão para concluir a operação." };
  const fields: Record<string, string> = { name: "Nome", phones: "Telefones", phone: "Telefones", mobile: "Telefones", email: "E-mail",
    document: "Documento", personType: "Tipo de pessoa", person_type: "Tipo de pessoa", address: "Endereço", "address.postalCode": "CEP", postal_code: "CEP" };
  const why = job.reason ? reasons[job.reason] ?? job.reason : job.errorCode ? reasons[job.errorCode] ?? `Motivo: ${job.errorCode}.` : "";
  return [jobMessages[job.state ?? ""] ?? "Resultado ainda não confirmado.", why,
    job.missingFields?.length ? "Campos pendentes: " + [...new Set(job.missingFields.map(field => fields[field] ?? field))].join(", ") + "." : ""].filter(Boolean).join(" ");
}
export function writeFeedback(response: any, fallback = "Cadastro salvo.") {
  const result = response?.result ?? response?.customer ?? response;
  const state = result?.state as ProfileJob["state"] | undefined;
  const pending = result?.pending === true;
  const jobId = typeof result?.jobId === "string" ? result.jobId : null;
  const completed = state ? state === "done" && !pending : !response?.result && !response?.customer && !pending && !jobId;
  return { jobId, completed, message: completed ? fallback : jobMessage({ ...result, state: pending && (!state || state === "done") ? "pending" : state }) };
}
export function synchronizationJob(detail: any): string | null {
  const sync = detail?.synchronization;
  return sync && sync.state !== "done" && typeof sync.jobId === "string" ? sync.jobId : null;
}
export const jobBlocksEditing = (job: Partial<ProfileJob> | null) => !!job && !["done", "cancelled", "retained"].includes(job.state ?? "pending");

export type IdentityConflict = { kind: "identity"; namespace: string; phone: string; version: number; candidates: { id: string; name: string; phone: string }[] };
export type ConflictPage = { items: (IdentityConflict | { kind: "job"; id: string; contactId: string })[]; nextCursor: string | null; incomplete: boolean };
export const readContactConflicts = (api: Api, root: string, cursor: string | null, signal: AbortSignal): Promise<ConflictPage> =>
  api(root + "/contact-conflicts?limit=25" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""), "GET", undefined, signal);
export function resolveContactIdentity(api: Api, root: string, conflict: IdentityConflict, contactId: string, reason: string, signal: AbortSignal, commandId: string) {
  if (!conflict.candidates.some(candidate => candidate.id === contactId) || !reason.trim()) throw new Error("Escolha um candidato e informe o motivo da revisão.");
  return api(root + "/contact-identities/resolve", "POST", { namespace: conflict.namespace, phone: conflict.phone,
    expectedVersion: conflict.version, contactId, reason: reason.trim() }, signal, commandId);
}
export function cancelContactJob(api: Api, root: string, job: ProfileJob, expectedVersion: number, reason: string, signal: AbortSignal, commandId: string): Promise<ProfileJob> {
  if (!Number.isSafeInteger(job.updated) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || !reason.trim())
    throw new Error("Recarregue a solicitação e informe um motivo para cancelar.");
  return api(root + "/contact-jobs/" + encodeURIComponent(job.id) + "/cancel", "POST",
    { expectedUpdated: job.updated, expectedVersion, reason: reason.trim() }, signal, commandId);
}

export type IdentityFilter = "identified" | "phone_only" | "no_personal_data" | "all";
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
  return !view.namespace?.startsWith("app:") && view.depth === "full" && !!view.erpContactId ? "full" : "simple";
}
export function profileMessage(error: unknown): string {
  const e = error as { code?: string; status?: number; message?: string; reason?: string };
  if (e?.reason === "host_not_installed") return "O hospedeiro da ficha completa ainda não está instalado.";
  const messages: Record<string, string> = {
    dependency_unavailable: "Esta parte da ficha está temporariamente indisponível.",
    module_disabled: "O módulo foi desligado. Atualize a ficha para continuar.",
    contact_conflict: "O cadastro mudou. Recarregue os dados antes de salvar novamente.",
    customer_ambiguous: "Há mais de um contato possível. Resolva o vínculo antes de continuar.",
    sync_pending: "A atualização aguarda confirmação. Confira a solicitação antes de editar novamente.",
    customer_erasing: "O contato tem uma solicitação de exclusão em andamento.",
    forbidden: "Você não tem permissão para esta parte da ficha.",
    not_found: "Esta ficha não está disponível nesta área.",
    merge_erp_conflict: "As fichas têm vínculos ERP diferentes. A junção não está disponível.",
    merge_changed: "Os dados ou as conversas mudaram. Atualize a prévia; uma junção alterada não pode ser desfeita.",
    merge_restricted: "Uma das fichas está restrita e não pode ser juntada ou restaurada.",
    merge_jobs_pending: "Aguarde as solicitações cadastrais antes de juntar as fichas.",
    merge_relation_conflict: "Há relações incompatíveis entre as fichas. Revise os vínculos antes de juntar.",
    idempotency_conflict: "Esta solicitação já foi usada com outros dados. Reabra a operação para conferir o resultado.",
  };
  return messages[e?.code ?? ""] ?? (e?.status === 403 ? messages.forbidden : e?.message || "Não foi possível carregar. Tente novamente.");
}

/** A resposta só pode confirmar o par escolhido; o ERP pode inverter o sobrevivente. */
export function validMergePreview(value: ContactMergePreview, sourceId: string, targetId: string): boolean {
  return !!value && value.source?.id === sourceId && value.target?.id === targetId && sourceId !== targetId
    && [sourceId, targetId].includes(value.survivorId)
    && [value.source.version, value.target.version].every(version => Number.isSafeInteger(version) && version > 0)
    && typeof value.previewToken === "string" && value.previewToken.length > 0
    && Number.isFinite(value.expiresAt) && Array.isArray(value.differences) && Array.isArray(value.blockers);
}

/** Uma intenção mantém o recibo depois de timeout; mudar o corpo exige nova chave. */
export function contactMergeWriter(api: Api, base: string) {
  const write = contactWriter(api);
  const sourceId = decodeURIComponent(base.slice(base.lastIndexOf("/") + 1));
  return {
    async merge(input: ContactMergeRequest, signal?: AbortSignal): Promise<ContactMergeResult> {
      const result: ContactMergeResult = await write(base + "/merge", "POST", input, signal);
      if (!result?.id || result.state !== "applied" || result.sourceId === result.targetId
          || ![result.sourceId, result.targetId].includes(input.targetId) || ![result.sourceId, result.targetId].includes(sourceId))
        throw new Error("Não foi possível confirmar a junção. Confira o resultado antes de repetir.");
      return result;
    },
    async undo(input: ContactMergeUndoRequest, signal?: AbortSignal): Promise<ContactMergeResult> {
      const result: ContactMergeResult = await write(base + "/merges/" + encodeURIComponent(input.mergeId) + "/undo", "POST", input, signal);
      if (result?.id !== input.mergeId || result.state !== "undone")
        throw new Error("Não foi possível confirmar o desfazer. Confira o resultado antes de repetir.");
      return result;
    },
  };
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
  if (section.schema !== "condominio.units.v1" || !draft || typeof draft !== "object" || Array.isArray(draft) ||
      !["memberships", "functions", "subscriptions"].some(key => Array.isArray(draft[key]))) return draft;
  const before = section.data as Record<string, Json>;
  const pick = (row: any, keys: string[]) => Object.fromEntries(keys.map(key => [key, row[key]]));
  const identityKeys = ["id", "personId", "unitId", "role", "startsAt"];
  const operations = (key: "memberships" | "functions" | "subscriptions") => {
    const oldRows = Array.isArray(before[key]) ? before[key] as any[] : [];
    const rows = Array.isArray(draft[key]) ? draft[key] as any[] : [];
    const project = (row: any, old?: any) => key === "subscriptions"
      ? { ...pick(row, ["unitId", "subscriptionId"]), linked: row.linked !== false }
      : { ...pick(row, [...identityKeys, "endsAt"]), ...(key === "memberships" ? { notices: !!row.notices }
        : { expectedVersion: Number(old?.version ?? old?.expectedVersion ?? 0) }) };
    return rows.flatMap(row => {
      const old = oldRows.find(previous => key === "subscriptions" ? previous.unitId === row.unitId && previous.subscriptionId === row.subscriptionId : previous.id === row.id);
      if (old && key !== "subscriptions" && identityKeys.some(field => row[field] !== old[field]))
        throw new Error("Encerre o vínculo atual e crie outro para mudar pessoa, unidade, papel ou início.");
      const change = project(row, old);
      return old && JSON.stringify(change) === JSON.stringify(project(old, old)) ? [] : [change];
    });
  };
  const memberships = operations("memberships"), functions = operations("functions"), subscriptions = operations("subscriptions");
  if (memberships.length + functions.length + subscriptions.length > 10) throw new Error("Salve até dez alterações por vez.");
  return { memberships, functions, subscriptions } as Json;
}

/** Troca de papel encerra o vínculo anterior, sem mudar sua identidade. */
export function replaceSectionRole(data: Json, kind: "memberships" | "functions", id: string, role: string, at: number, newId: string): Json {
  const snapshot = data as Record<string, Json>, rows = snapshot[kind] as Record<string, Json>[];
  const current = rows.find(row => row.id === id);
  const roles = kind === "memberships" ? ["proprietario", "inquilino", "empregado_unidade"] : ["sindico", "zelador", "porteiro", "prestador", "visitante_recorrente"];
  if (!current || !roles.includes(role) || role === current.role || current.endsAt != null || !Number.isSafeInteger(at) || at < Number(current.startsAt) || !newId || rows.some(row => row.id === newId))
    throw new Error("Confira o vínculo, o novo papel e a data da troca.");
  const next = { id: newId, personId: current.personId, unitId: current.unitId, role, startsAt: at, endsAt: null,
    ...(kind === "memberships" ? { notices: !!current.notices } : { version: 0 }) };
  return { ...snapshot, [kind]: [...rows.map(row => row.id === id ? { ...row, endsAt: at } : row), next] };
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
export const readContactJob = (api: Api, root: string, id: string, signal: AbortSignal): Promise<ProfileJob> =>
  api(root + "/contact-jobs/" + encodeURIComponent(id), "GET", undefined, signal);

/** Só estados em execução são consultados automaticamente; o descarte cobre transportes sem abort. */
export function watchContactJob(api: Api, root: string, id: string, signal: AbortSignal,
  changed: (job: ProfileJob) => void, failed: (error: unknown) => void) {
  let active = true, timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { active = false; clearTimeout(timer); signal.removeEventListener("abort", stop); };
  const poll = async () => {
    try {
      const job = await readContactJob(api, root, id, signal);
      if (!active || signal.aborted) return;
      changed(job);
      if (active && !signal.aborted && ["pending", "running"].includes(job.state)) timer = setTimeout(() => void poll(), 1500);
    } catch (error) { if (active && !signal.aborted) failed(error); }
  };
  if (!signal.aborted) { signal.addEventListener("abort", stop, { once: true }); void poll(); }
  return stop;
}
