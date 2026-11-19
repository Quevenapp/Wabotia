import type {
  ManagementContext,
  ManagementItem,
  PanelErpRole,
  ResolvedManagementItem,
} from "../../src/modules/panel-contract";
import { NATIVE_MANAGEMENT_ITEMS } from "../../src/modules/panel-navigation";
import { ERP_MANAGEMENT_ITEMS } from "../../src/modules/erp/panel-menu";
import { resourcesForRole } from "../../src/erp/role-resources";
import { canOpenPage, type PageId } from "../workspace-navigation";
import { href } from "../lib/routes";
import { portedTargetState } from "./ported-policy";
import type { ErpPermissions, PortedTargetState } from "./host-contract";
import { requirementsEnabled } from "../erp/modules";
import { erpRequirement } from "../../src/erp/parts";
import type { Api } from "../lib/api";

export const MANAGEMENT_ITEMS: readonly ManagementItem[] = [
  ...Object.values(NATIVE_MANAGEMENT_ITEMS).flat(),
  ...ERP_MANAGEMENT_ITEMS,
];
const ERP_ROLES: readonly string[] = ["admin", "consulta", "financeiro", "vendas", "estoque", "fiscal"];

export function managementContext(input: {
  statusLoaded: boolean;
  modules?: Readonly<Record<string, boolean>>;
  role: string;
  access: readonly string[] | null;
  vocabulary?: ManagementContext["vocabulary"];
}): ManagementContext {
  // Mesma regra de identity.ts: o primeiro erp:<papel> precisa ser válido.
  const candidate = input.access?.find((item) => item.startsWith("erp:"))?.slice(4);
  return {
    ...input,
    modules: input.modules ?? {},
    erpRole: input.role === "admin" ? "admin"
      : candidate && ERP_ROLES.includes(candidate) ? candidate as PanelErpRole : null,
  };
}

function permits(item: ManagementItem, c: ManagementContext): boolean {
  if (item.permission.kind === "page") {
    // Ignorar só a ativação, mantendo exclusividades administrativas.
    const modules = { ...c.modules, [item.module]: true };
    return canOpenPage(item.permission.page, c.role, modules, c.access && [...c.access]);
  }
  const { roles, resource } = item.permission;
  return !!c.erpRole && (!roles || roles.includes(c.erpRole)) &&
    (!resource || resourcesForRole(c.erpRole).includes(resource));
}

export function canEnterManagement(c: ManagementContext): boolean {
  return c.role === "admin" || MANAGEMENT_ITEMS.some((item) => permits(item, c));
}

/** Chave completa: consulta e fragmento fazem parte do destino. */
export function normalizedManagementHref(to: string): string {
  const url = new URL(to, "https://management.invalid");
  if (url.origin !== "https://management.invalid" ||
    (url.pathname !== "/app/erp" && !url.pathname.startsWith("/app/erp/")))
    throw new Error("Destino fora da casa de gestão");
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  url.searchParams.sort();
  return url.pathname + url.search + url.hash;
}

export const managementItemHref = (item: ManagementItem): string =>
  item.target.kind === "native"
    ? href({ area: "erp", page: item.target.page as PageId })
    : "/app/erp" + (item.target.to.startsWith("/") ? "" : "/") + item.target.to;

export const managementItemOrder = (a: ManagementItem, b: ManagementItem): number =>
  Number(a.target.kind === "ported") - Number(b.target.kind === "ported") ||
  a.groupOrder - b.groupOrder || a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function resolveManagement(
  items: readonly ManagementItem[],
  c: ManagementContext,
  simulated = false,
  permissions?: ErpPermissions | null,
): readonly ResolvedManagementItem[] {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) throw new Error(`ID de gestão repetido: ${item.id}`);
    ids.add(item.id);
  }
  if (!c.statusLoaded) return [];
  const destinations = new Set<string>();
  return [...items]
    .sort(managementItemOrder)
    .filter((item) => permits(item, c) && (item.target.kind === "native"
      ? c.modules[item.module] === true &&
        canOpenPage(item.target.page, c.role, c.modules, c.access && [...c.access])
      : requirementsEnabled(erpRequirement(...(item.requires ?? [])), c.modules) && c.modules[item.module] === true &&
        portedTargetState(item.target.to, c, simulated, permissions) === "allowed"))
    .flatMap((item) => {
      const destination = managementItemHref(item);
      const key = normalizedManagementHref(destination);
      if (destinations.has(key)) return [];
      destinations.add(key);
      const label = item.labelKey === "workCollection" ? c.vocabulary?.collection_label
        : item.labelKey === "customers" ? c.vocabulary?.customer_plural : undefined;
      return [{ ...item, href: destination, resolvedLabel: label || item.label }];
    });
}

export function managementLanding(items: readonly ResolvedManagementItem[]): string | null {
  const ported = items.filter(item => item.target.kind === "ported");
  if (ported.length && items.every(item => item.module === "erp"))
    return items.find(item => item.id === "erp.customers")?.href ?? null;
  if (!ported.length) return (items.find(item => item.primary) || items[0])?.href ?? null;
  if (ported.length === items.length) return items.find(item => item.id === "erp.overview")?.href ?? null;
  if (new Set(items.map((item) => item.module)).size !== 1) return null;
  return (items.find((item) => item.primary) || items[0])?.href ?? null;
}

export function managementEntryState(c: ManagementContext, items: readonly ResolvedManagementItem[]) {
  if (!c.statusLoaded) return "loading";
  if (!MANAGEMENT_ITEMS.some((item) => c.modules[item.module] === true)) return "empty";
  if (!items.length) return "denied";
  return managementLanding(items) ? "redirecting" : "home";
}

export function nativeTargetState(page: string, c: ManagementContext): PortedTargetState {
  const item = MANAGEMENT_ITEMS.find((item) => item.target.kind === "native" && item.target.page === page);
  if (!item) return "not-found";
  if (!c.statusLoaded) return "loading";
  // Uma revogação não pode manter dados de um módulo também desligado.
  if (!permits(item, c)) return "denied";
  if (c.modules[item.module] !== true) return "disabled";
  return "allowed";
}

/** Geração monotônica: A → B → A nunca torna válida uma resposta antiga. */
export function createManagementGeneration() {
  let key = "", generation = 0;
  return {
    update(next: string) {
      if (next !== key) { key = next; generation++; }
      return generation;
    },
    invalidate() { return ++generation; },
    capture() { return generation; },
    current(value: number) { return value === generation; },
  };
}

/** A API de uma tela não publica respostas de uma autorização anterior. */
export function createManagementRequestScope(request: Api) {
  const generation = createManagementGeneration();
  const pending = new Set<AbortController>();
  let enabled = false, disposed = false;
  const cancel = () => { for (const controller of pending) controller.abort(); pending.clear(); };
  const stale = () => new DOMException("O contexto da gestão mudou.", "AbortError");
  const api: Api = async (path, method, body, signal, idempotencyKey) => {
    if (!enabled || disposed) throw stale();
    const current = generation.capture(), controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    pending.add(controller);
    try {
      if (controller.signal.aborted) throw stale();
      const result = await request(path, method, body, controller.signal, idempotencyKey);
      if (disposed || !enabled || !generation.current(current) || controller.signal.aborted) throw stale();
      return result;
    } finally {
      pending.delete(controller);
      signal?.removeEventListener("abort", abort);
    }
  };
  return {
    api,
    update(key: string, allowed: boolean) {
      const previous = generation.capture();
      generation.update(JSON.stringify([key, allowed]));
      enabled = allowed;
      if (!generation.current(previous)) cancel();
    },
    dispose() { disposed = true; generation.invalidate(); cancel(); },
  };
}
