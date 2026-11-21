import type { ErpPart } from "../../src/modules/erp/panel-menu.ts";
import { ERP_MODULE_IDS, erpPartOffMessage, erpRequirement, type ErpModuleId, type ErpRequirement } from "../../src/erp/parts.ts";
import { erpDestinationRequirement, erpEntityRequirement, erpImportRequirement, ERP_IMPORT_KINDS, erpOperationRequirement, erpXmlRequirement, erpPreferenceRequirement, ERP_PREFERENCE_DESTINATIONS } from "../../src/erp/parts-requirements.ts";
export const ERP_MODULES = ERP_MODULE_IDS;
export type ErpModule = ErpModuleId;
export type ErpBlock = ErpModule;
export function erpModuleOn(modules: Readonly<Record<string, boolean>> | undefined, id: ErpModule) {
  return modules?.[id] === true;
}
export const ERP_PART_OWNERS: Readonly<Partial<Record<ErpPart, ErpModule>>> = {
  cadastro: "erp", sistema: "erp", catalogo: "erp-produtos", vendas: "erp-vendas", servicos: "erp-vendas",
  compras: "erp-compras", estoque: "erp-estoque", financeiro: "erp-financeiro", fiscal: "erp-fiscal", cobranca: "erp-cobranca", pdv: "erp-pdv",
  producao: "erp-producao",
};
export const requirementsEnabled = (requirement: ErpRequirement | null, modules: Readonly<Record<string, boolean>>) =>
  !!requirement && requirement.all.every(id => modules[id] === true);

// Aliases de apresentação ausentes do resolvedor comum. Os requisitos continuam vindo dele.
const containers = new Set([
  "/preferencias/empresa", "/preferencias/sistema", "/preferencias/cadastros", "/preferencias/suprimentos", "/preferencias/vendas",
  "/preferencias/notas-fiscais", "/preferencias/certificado", "/preferencias/financas", "/preferencias/servicos", "/preferencias/contabilidade", "/preferencias/importacoes",
  "/preferencias/sistema/gestao-acoes", "/preferencias/sistema/consulta-exclusoes", "/preferencias/sistema/gerenciador-arquivos",
  "/preferencias/sistema/gerenciador-transicoes", "/preferencias/sistema/relatorios-customizados", "/preferencias/sistema/etiquetas-customizadas",
  "/preferencias/sistema/registro-atividades", "/preferencias/sistema/usuarios", "/preferencias/backup/exportacao",
]);
export function requirementOf(target: string) {
  let url: URL;
  try { url = new URL(target, "https://erp.invalid"); } catch { return null; }
  if (url.pathname.startsWith("/app/erp/")) url.pathname = url.pathname.slice(8);
  if (["cadastro", "tipo", "area", "painel", "acao", "relatorio"].some(key => url.searchParams.getAll(key).length > 1)) return null;
  if (url.pathname === "/cadastros-reais" && !url.searchParams.has("cadastro")) url.searchParams.set("cadastro", "contacts");
  if (url.pathname === "/documentos-empresa" && !url.searchParams.has("tipo")) url.searchParams.set("tipo", "sales_proposals");
  if (["/preferencias/suprimentos/tags", "/preferencias/suprimentos/grupos-tags"].includes(url.pathname)) url.pathname = "/tags";
  if (["/tags", "/grupos-tags"].includes(url.pathname) && url.searchParams.get("tipo")) {
    const entity = { produtos: "products", contatos: "contacts", notas: "nfe" }[url.searchParams.get("tipo")!];
    const requirement = erpEntityRequirement(entity);
    return requirement ? {owner: requirement.all[0], requirement} : null;
  }
  const imported = /^\/preferencias\/importacoes\/([^/]+)$/.exec(url.pathname);
  if (imported) {
    const kind = ERP_IMPORT_KINDS[imported[1]], requirement = erpImportRequirement(kind);
    return requirement ? { owner: erpEntityRequirement(kind)!.all[0], requirement } : null;
  }
  if (containers.has(url.pathname)) return erpDestinationRequirement("/preferencias");
  const resolved = erpDestinationRequirement(url);
  if (!resolved) return null;
  const action = url.searchParams.get("acao");
  const extras = action === "xml" ? erpXmlRequirement(url.searchParams.get("tipo") ?? "") : action === "recebimentos" ? erpOperationRequirement("purchase_receipt") : action === "reservas" ? erpOperationRequirement("reservation") : action === "venda-fisica" ? erpOperationRequirement("pos") : null;
  if (url.pathname === "/relatorios-estoque" && url.searchParams.get("relatorio") === "pedidos-compra")
    return { ...resolved, requirement: erpOperationRequirement("purchase_receipt") };
  return extras ? { ...resolved, requirement: erpRequirement(...resolved.requirement.all, ...extras.all) } : resolved;
}
export const blockOf = (target: string): ErpBlock | null => requirementOf(target)?.owner ?? null;
/** Tela aberta pelo endereço com a parte desligada: qual módulo falta e de quem ele depende. */
export function partOffMessage(target: string, modules: Readonly<Record<string, boolean>>): string | null {
  const resolved = requirementOf(target);
  return resolved ? erpPartOffMessage(resolved.owner, resolved.requirement, modules) : null;
}
export function erpPartEnabled(part: ErpPart, modules: Readonly<Record<string, boolean>>, to: string): boolean {
  const resolved = requirementOf(to);
  // Resultados é apenas o nome legado de um grupo; nunca uma chave.
  const owner = ERP_PART_OWNERS[part];
  return !!resolved && (part === "resultados" || !!owner && requirementsEnabled(erpRequirement(owner), modules)) && requirementsEnabled(resolved.requirement, modules);
}
export { erpPreferenceRequirement, ERP_PREFERENCE_DESTINATIONS };
