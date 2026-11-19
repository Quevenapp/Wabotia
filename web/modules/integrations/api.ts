import { useMemo } from "react";
import type { Api } from "../../lib/api";
import type { ManagementContext } from "../../../src/modules/panel-contract";
import type { CatalogItem, CatalogLink, CommercialPolicy, Destination, DocumentOrigin, IntegrationModule, ManualReceipt, ModuleStatus, PolicyInitialization, SourceView, StockObservation, WorkCommercialView } from "./contracts";
import { integrationAccess, integrationHost, useIntegrationHost, visibleSource } from "./visibility";

export const integrationError = (error: unknown): string => {
  const code = (error as { code?: string })?.code;
  const messages: Record<string, string> = {
    version_conflict: "O registro mudou ou o comando anterior já foi aplicado. Atualize a confirmação antes de corrigir.",
    idempotency_conflict: "Esta chave já identifica outro conteúdo. Confira a confirmação antes de continuar.",
    pending_command: "Há uma confirmação pendente. Repita a mesma ação antes de mudar os dados.",
    part_disabled: "A parte necessária está desligada. A operação local foi preservada.",
    forbidden: "Seu perfil não permite esta operação.", mfa_required: "Confirme sua identidade para continuar.",
    default_missing: "Falta um padrão comercial. Confira os padrões da área.", default_inactive: "Um padrão comercial está ausente ou inativo.",
    warehouse_required: "Defina um depósito ativo.", revenue_category_required: "Defina uma categoria de receita ativa.", category_required: "Defina uma categoria de receita ativa.",
    settlement_account_required: "Defina uma conta de baixa ativa.", customer_required: "Complete o cadastro do responsável financeiro.",
    historical_origin_unlinked: "A obrigação antiga não tem vínculo ERP. Precisa de análise humana.",
    integration_not_implemented: "Integração em implantação nesta instalação.", not_found: "Registro não encontrado ou indisponível para seu perfil.",
    lease_lost: "Outra tentativa está em andamento. Atualize a confirmação antes de repetir.",
  };
  return messages[code ?? ""] ?? "Não foi possível confirmar. Atualize a consulta ou repita a mesma ação; os dados locais foram preservados.";
};
export type IntentStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export interface PendingCommand { path: string; method: string; body: object; key: string; uncertain: boolean }
const memory = new Map<string, string>();
const fallback: IntentStorage = { getItem: k => memory.get(k) ?? null, setItem: (k, v) => { memory.set(k, v); }, removeItem: k => { memory.delete(k); } };
function browserStorage(): IntentStorage { try { return globalThis.localStorage ?? fallback; } catch { return fallback; } }
const flights = new Set<string>();
/** Só uma ação humana envia. Construir o cliente/retomar a tela nunca repete comandos. */
export function persistentCommands(api: Api, namespace: string, storage = browserStorage()) {
  const slot = (scope: string) => `wabotia:f3:${namespace}:${scope}`;
  const pending = (scope: string): PendingCommand | null => {
    try { const raw = storage.getItem(slot(scope)); return raw ? JSON.parse(raw) : null; } catch { return null; }
  };
  async function send(scope: string, command: PendingCommand) {
    const id = slot(scope);
    if (flights.has(id)) throw Object.assign(new Error(), { code: "lease_lost" });
    // Persistir antes da chamada. Falha de armazenamento não inicia uma escrita incerta.
    // Se a aba cair durante fetch, a próxima sessão já sabe que o resultado é incerto.
    storage.setItem(id, JSON.stringify({ ...command, uncertain: true })); flights.add(id);
    try {
      const value = await api(command.path, command.method, command.body, undefined, command.key);
      storage.removeItem(id); return value;
    } catch (error) {
      const status = (error as { status?: number })?.status ?? 0;
      const code = (error as { code?: string })?.code;
      if (!command.uncertain && status >= 400 && status < 500 && status !== 429 && !["operation_unknown", "idempotency_conflict"].includes(code ?? "")) storage.removeItem(id);
      else storage.setItem(id, JSON.stringify({ ...command, uncertain: true }));
      throw error;
    } finally { flights.delete(id); }
  }
  return { pending, async execute(scope: string, path: string, method: string, body: object) {
    const previous = pending(scope);
    if (previous && (previous.path !== path || previous.method !== method || JSON.stringify(previous.body) !== JSON.stringify(body)))
      throw Object.assign(new Error(), { code: "pending_command" });
    return send(scope, previous ?? { path, method, body, key: crypto.randomUUID(), uncertain: false });
  }, async resume(scope: string) {
    const command = pending(scope);
    if (!command) throw Object.assign(new Error(), { code: "not_found" });
    return send(scope, command);
  } };
}
const enc = encodeURIComponent;
export function createIntegrationApi(api: Api, root: string, context: () => ManagementContext, actor: string, storage?: IntentStorage) {
  const base = root + "/integrations";
  const access = () => integrationAccess(context());
  const require = (allowed: boolean) => { if (!allowed) throw Object.assign(new Error(), { code: "part_disabled", status: 409 }); };
  const checkModule = (module: IntegrationModule, write = false) => require(write ? access().write(module) : access().module(module));
  const sourcePath = (module: IntegrationModule, id: string) => `${base}/${module}/sources/${enc(id)}`;
  const commands = persistentCommands(api, `${enc(root)}:${enc(actor)}`, storage);
  const get = async <T>(path: string, signal?: AbortSignal): Promise<T> => {
    const before = context();
    const value = await api(path, "GET", undefined, signal);
    if (before !== context() || signal?.aborted) throw new DOMException("Contexto alterado", "AbortError");
    return value;
  };
  return {
    pending: commands.pending,
    async status(module: IntegrationModule, signal?: AbortSignal): Promise<ModuleStatus> { checkModule(module); return get(`${base}/${module}/status`, signal); },
    async source(module: IntegrationModule, id: string, signal?: AbortSignal): Promise<SourceView> {
      checkModule(module); const view = await get<SourceView>(sourcePath(module, id), signal); checkModule(module); return visibleSource(view, context());
    },
    async sourceAction(module: IntegrationModule, id: string, action: "retry" | "replace" | "post", body: { event_id: string; reason_code?: string; version?: number; destinations?: Destination[] }) {
      checkModule(module, action !== "post");
      require(access().documents || access().stock || access().finance);
      if (action === "post") require(!!body.destinations?.length && body.destinations.every(d => d === "finance" ? access().finance : access().postStock));
      return commands.execute(`${module}:${id}`, sourcePath(module, id) + "/" + action, "POST", body);
    },
    async resumeSource(module: IntegrationModule, id: string) {
      const pending = commands.pending(`${module}:${id}`); if (!pending) return;
      const action = pending.path.split("/").at(-1);
      checkModule(module, action !== "post");
      require(access().documents || access().stock || access().finance);
      if (action === "post") { const body = pending.body as { destinations: Destination[] }; require(body.destinations.every(d => d === "finance" ? access().finance : access().postStock)); }
      return commands.resume(`${module}:${id}`);
    },
    async policy(signal?: AbortSignal): Promise<CommercialPolicy> { require(access().policy); return get(base + "/commercial-policy", signal); },
    async policyReferences(kind: "warehouse" | "category" | "method" | "account", query: string, after?: string) {
      require(kind === "warehouse" ? access().stock : access().finance);
      const params = new URLSearchParams({ q: query, limit: "25", ...(after ? { after } : {}) });
      const path = kind === "warehouse" ? "/v1/estoque/depositos?" + new URLSearchParams({ q: query })
        : kind === "method" ? "/v1/financeiro/formas-pagamento?kind=receivable"
        : `/v1/financeiro/${kind === "category" ? "categories" : "accounts"}?${params}`;
      const value = await get<{ items: { id: string; name?: string; description?: string; active?: boolean; kind?: string }[]; next_cursor?: string | null }>(root + "/erp" + path);
      return { items: value.items.filter(row => row.active !== false && (kind !== "category" || row.kind === "receivable" || row.kind === "both")).map(row => ({ id: row.id, name: row.name ?? row.description ?? row.id })), next_cursor: value.next_cursor ?? null };
    },
    async patchPolicy(body: Partial<CommercialPolicy> & { version: number }) { require(access().configure); return commands.execute("policy", base + "/commercial-policy", "PATCH", body) as Promise<CommercialPolicy>; },
    async initialize(body: PolicyInitialization) { require(access().configure); require(!body.warehouse || access().stock); require(!(body.category || body.payment_method || body.account) || access().finance); return commands.execute("policy", base + "/commercial-policy/initialize", "POST", body) as Promise<CommercialPolicy>; },
    async resumePolicy() { require(access().configure); const p = commands.pending("policy"); if (p?.path.endsWith("initialize")) { const body = p.body as PolicyInitialization; require(!body.warehouse || access().stock); require(!(body.category || body.payment_method || body.account) || access().finance); } return commands.resume("policy") as Promise<CommercialPolicy>; },
    async catalog(query: string, signal?: AbortSignal): Promise<CatalogItem[]> { require(access().products); const permissions = await get<{ read: string[] }>(root + "/erp/v1/cadastros", signal); require(permissions.read.includes("products")); const result = await get<{ items: CatalogItem[] }>(root + "/erp/v1/cadastros/products?" + new URLSearchParams({ q: query, active: "true", limit: "25" }), signal); return result.items; },
    async link(module: IntegrationModule, kind: string, id: string, component: string, value: CatalogLink): Promise<CatalogLink> { checkModule(module, true); require(access().products); return commands.execute(`catalog:${module}:${kind}:${id}:${component}`, `${base}/${module}/catalog/${enc(kind)}/${enc(id)}/${enc(component)}`, value.erp_item_id ? "PUT" : "DELETE", { version: value.version, ...(value.erp_item_id ? { erp_item_id: value.erp_item_id } : {}) }); },
    async stock(product: string, signal?: AbortSignal): Promise<StockObservation[]> {
      require(access().stock);
      const permissions = await get<{ user_id: string; role: string; access: { open: boolean }; permissions: string[] | null }>(root + "/erp/v1/sistema/permissoes", signal);
      require(permissions.user_id === actor && permissions.role === context().erpRole && permissions.access.open && (permissions.permissions === null || permissions.permissions.includes("suprimentos.controle_estoque")));
      const result = await get<{ items: Omit<StockObservation, "observed_ms">[] }>(root + "/erp/v1/estoque/saldos?product_id=" + enc(product), signal); const observed_ms = Date.now(); return result.items.map(row => ({ ...row, observed_ms }));
    },
    async origins(ids: string[], signal?: AbortSignal): Promise<DocumentOrigin[]> { require(access().documents); const out: DocumentOrigin[] = []; for (let i = 0; i < ids.length; i += 50) { const result = await get<{ data: DocumentOrigin[] }>(base + "/document-origins?" + new URLSearchParams({ ids: ids.slice(i, i + 50).join(",") }), signal); out.push(...result.data); } return out; },
    async commercial(id: string, signal?: AbortSignal): Promise<WorkCommercialView> { checkModule("os"); require(access().documents || access().finance || access().stock); return get(`${root}/service-orders/${enc(id)}/commercial`, signal); },
    async saveCommercial(id: string, body: object) { checkModule("os", true); require(access().documents || access().stock || access().finance); return commands.execute(`commercial:${id}`, `${root}/service-orders/${enc(id)}/commercial`, "PATCH", body); },
    async appointment(id: string, action: "charge" | "complete", version: number) { require(access().localWrite("agenda")); return commands.execute(`appointment:${id}`, `${root}/agenda/appointments/${enc(id)}/${action}`, "POST", { version }); },
    async receipt(module: "agenda" | "reserva" | "entrega", id: string, body: ManualReceipt) { require(access().localWrite(module) && access().localFinance); const collection = { agenda: "appointments", reserva: "bookings", entrega: "deliveries" }[module]; return commands.execute(`receipt:${module}:${id}`, `${root}/${module}/${collection}/${enc(id)}/receipts`, "POST", body); },
    async reverseReceipt(id: string, reason_code: string) { require(access().finance); return commands.execute(`reverse:${id}`, `${base}/receipts/${enc(id)}/reverse`, "POST", { reason_code }); },
    async deliveryCommercial(id: string, body: object) { checkModule("entrega", true); return commands.execute(`delivery:${id}`, `${root}/entrega/deliveries/${enc(id)}/commercial`, "PATCH", body); },
    async delivery(id: string, signal?: AbortSignal): Promise<{ source: string; source_ref: string | null; commercial?: { revision: number; price_cents: number | null; authorized: boolean } }> { checkModule("entrega"); return get(`${root}/entrega/deliveries/${enc(id)}`, signal); },
  };
}
export function useIntegrationApi() {
  const host = useIntegrationHost();
  return useMemo(() => host ? createIntegrationApi(async (...args) => {
    if (integrationHost() !== host) throw new DOMException("Contexto alterado", "AbortError");
    const result = await host.api(...args);
    if (integrationHost() !== host) throw new DOMException("Contexto alterado", "AbortError");
    return result;
  }, host.root, () => integrationHost() === host ? host.context : { ...host.context, statusLoaded: false }, host.actor) : null, [host]);
}
export type IntegrationApi = ReturnType<typeof createIntegrationApi>;
