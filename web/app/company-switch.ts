// Contas puras do seletor "Empresa" (web/app/CompanySwitcher.tsx): o rótulo
// de cada empresa e a tela a abrir na outra empresa. Sem React: os testes do
// Node importam este arquivo.
import type { Route } from "../lib/routes";

/** CNPJ com a pontuação de sempre (o alfanumérico também). */
export function formatCnpj(value: unknown) {
  const raw = String(value ?? "").replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  return raw.length === 14 ? `${raw.slice(0, 2)}.${raw.slice(2, 5)}.${raw.slice(5, 8)}/${raw.slice(8, 12)}-${raw.slice(12)}` : raw;
}

/** Nome do item no seletor: nome fantasia · CNPJ (nunca o nome técnico da área quando o ERP tem os dados). */
export const companyLabel = (company: Record<string, any>): string =>
  company.cnpj ? `${company.nome_fantasia} · ${formatCnpj(company.cnpj)}` : String(company.nome_fantasia ?? company.area_nome ?? "");

// Segmento que é registro de uma empresa (id, número), não tela.
const RECORD = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+|[0-9A-Za-z_-]{21,})$/i;
const decode = (part: string) => { try { return decodeURIComponent(part); } catch { return part; } };
function screenPath(path?: string) {
  if (!path) return path;
  const parts = path.split("/");
  const cut = parts.findIndex((part, index) => index > 0 && RECORD.test(decode(part)));
  return cut < 0 ? path : parts.slice(0, cut).join("/") || "/";
}

/** A mesma tela na outra empresa, sem o registro aberto (que é da empresa anterior) nem os filtros. */
export function companySwitchRoute(route: Route): Route {
  if (route.area === "admin") return { area: "admin", page: route.page };
  if (route.area === "erp") {
    if (route.page) return { area: "erp", page: route.page, ...(route.typeId ? { typeId: route.typeId } : {}) };
    if (route.nativePath) return { area: "erp", nativePath: screenPath(route.nativePath) };
    return route.erpPath ? { area: "erp", erpPath: screenPath(route.erpPath) } : { area: "erp" };
  }
  if (route.area === "team") return route.sub ? { area: "team", sub: route.sub } : { area: "team" };
  return { area: route.area };
}
