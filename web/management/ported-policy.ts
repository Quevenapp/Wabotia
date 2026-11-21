// Política de entrada: somente catálogo e recursos puros, sem montagem ou API.
import { ERP_MANAGEMENT_ITEMS, type ErpPart } from "../../src/modules/erp/panel-menu.ts";
import { ROLE_RESOURCES } from "../../src/erp/role-resources.ts";
import type { ManagementContext, PanelErpRole } from "../../src/modules/panel-contract.ts";
import type { ErpPermissions, PortedTargetState } from "./host-contract";
import { erpPartEnabled } from "../erp/modules.ts";
import { MOTOR_PENDING } from "../erp/motor.ts";

export interface PortedTarget {
  part: ErpPart;
  roles?: readonly PanelErpRole[];
  resource?: string;
  anyResource?: readonly string[];
  readPermission?: string;
}
const admin = ["admin"] as const;
const finance = ["admin", "consulta", "financeiro"] as const;
const products = ["admin", "consulta", "vendas", "estoque", "fiscal"] as const;
const purchases = ["admin", "consulta", "financeiro", "estoque", "fiscal"] as const;
const sales = ["admin", "consulta", "financeiro", "vendas"] as const;
const fiscal = ["admin", "consulta", "fiscal"] as const;
const fiscalWriters = ["admin", "fiscal"] as const;
const rule = (part: ErpPart, roles?: readonly PanelErpRole[], resource?: string): PortedTarget => ({ part, roles, resource });

/** Não normalizar um endereço inválido para um endereço permitido. */
export function portedUrl(to: string): URL | null {
  if (!to.startsWith("/") || to.startsWith("//") || /[\\\s]/.test(to.split(/[?#]/)[0]) ||
    /%(?:2e|2f|5c)/i.test(to.split(/[?#]/)[0]) || to.split(/[?#]/)[0].split("/").some(p => p === "." || p === "..")) return null;
  try { return new URL(to, "https://erp.invalid"); } catch { return null; }
}

export function hiddenPortedTarget(to: string): boolean {
  const path = portedUrl(to)?.pathname;
  return !!path && ["/atualizacao", "/ajuda/convivencia", "/preferencias/sistema/atualizacoes", "/preferencias/sistema/wabotia"]
    .some(hidden => path === hidden || path.startsWith(hidden + "/"));
}

// Inventário complementar a App.tsx/origin-menu.ts. Só metadados de roteamento;
// não importar os schemas completos de preferências no pacote inicial.
const extra: Readonly<Record<string, PortedTarget>> = {
  "/acesso": rule("sistema"), // alias legado, redirecionado pelo roteador portado
  "/estoque-empresa": { ...rule("estoque", products), readPermission: "suprimentos.controle_estoque" },
  "/empresa-configuracoes": rule("sistema"),
  "/manutencao-efeitos": rule("sistema"),
  // Relatórios do ERP: cada relatório da tela confere a parte dele.
  "/relatorios-graficos": rule("sistema"),
  "/estoque-abertura": rule("estoque", admin),
  "/cobranca-empresa": rule("cobranca", finance),
  "/cobranca-operacional": rule("cobranca", finance),
  "/retornos-operacionais": rule("cobranca", finance),
  "/relatorio-vencimentos": rule("financeiro", finance),
  "/notas-recebidas": rule("fiscal", fiscal),
  "/numeracao-fiscal": rule("fiscal", fiscalWriters),
  "/certificado-a1": rule("fiscal", fiscalWriters),
  "/conexao-sefaz": rule("fiscal", fiscalWriters),
  "/emissor-fiscal": rule("fiscal", fiscalWriters),
  "/naturezas-operacao": rule("fiscal", fiscal),
  "/inutilizacoes-nfe": rule("fiscal", fiscalWriters),
  "/cartas-correcao": rule("fiscal", fiscalWriters),
  "/grupos-produtos": rule("catalogo", products, "products"),
  "/tags": { part: "cadastro", anyResource: ["products", "contacts"] },
  "/grupos-tags": { part: "cadastro", anyResource: ["products", "contacts"] },
  "/exportacao-produtos": rule("catalogo", products, "products"),
  "/campos-customizados": rule("catalogo", products, "products"),
  "/tipos-contatos-empresa": rule("cadastro", admin, "contacts"),
  "/importar-contatos": rule("cadastro", admin, "contacts"),
  "/numeracao-contatos": rule("cadastro", admin, "contacts"),
};
type Preference = [target: PortedTarget, sections?: readonly string[]];
const preferences: Readonly<Record<string, Preference>> = {
  "empresa/geral": [rule("sistema")],
  "empresa/armazenamento": [rule("sistema")],
  "sistema/interface": [rule("sistema")],
  "sistema/central-notificacoes": [rule("sistema")],
  "sistema/gestao-acoes": [rule("sistema")],
  "sistema/consulta-exclusoes": [rule("sistema", admin)],
  "sistema/gerenciador-arquivos": [rule("sistema", admin)],
  "sistema/gerenciador-transicoes": [rule("sistema", admin)],
  "sistema/relatorios-customizados": [rule("sistema")],
  "sistema/etiquetas-customizadas": [rule("sistema", admin)],
  "sistema/registro-atividades": [rule("sistema", admin)],
  "sistema/usuarios": [rule("sistema", admin)],
  "cadastros/clientes-fornecedores": [rule("cadastro")],
  "cadastros/lotes": [rule("catalogo", products)],
  "cadastros/produtos": [rule("catalogo", products)],
  "suprimentos/estoque": [rule("estoque", products)],
  "suprimentos/pedidos-compra": [rule("compras", purchases)],
  "suprimentos/tags": [extra["/tags"]],
  "suprimentos/grupos-tags": [extra["/grupos-tags"]],
  "vendas/frente-caixa": [rule("pdv", ["admin", "consulta", "vendas"]), ["gerais", "item", "atalhos"]],
  "vendas/propostas-comerciais": [rule("vendas", sales), ["configuracoes", "impressao", "email"]],
  "vendas/vendas": [rule("vendas"), ["configuracoes", "checkout", "contas-receber", "email", "impressao", "comprovante", "relatorio-producao"]],
  "notas-fiscais/nfe": [rule("fiscal", fiscal), ["emissao", "gerais", "preenchimento", "numeracao", "impressao", "email"]],
  "notas-fiscais/nfce": [rule("fiscal", fiscal), ["emissao", "csc", "numeracao", "preenchimento"]],
  "certificado/configuracoes": [rule("fiscal", fiscalWriters)],
  "financas/contas-pagar": [rule("financeiro", finance)],
  "financas/contas-receber": [rule("financeiro", finance)],
  "servicos/ordens-servico": [rule("servicos", sales)],
  "contabilidade/meu-contador": [rule("sistema", ["admin", "financeiro", "fiscal"]), ["arquivos", "dados", "data"]],
  "meu-negocio/ajustes": [rule("resultados")],
  "backup/exportacao": [rule("sistema", admin)],
};
const imports: Readonly<Record<string, ErpPart>> = {
  produtos: "catalogo", composicoes: "catalogo", "campos-customizados": "catalogo", lotes: "catalogo",
  contatos: "cadastro", "pedidos-compra": "compras", "movimentacoes-estoque": "estoque",
  "fornecedores-produtos": "catalogo", "notas-fiscais": "fiscal", "contas-receber": "financeiro", vendas: "vendas",
};
const financeAreas = ["receivable", "payable", "accounts", "categories", "borderos", "contas-financeiras", "ficha", "conciliacao", "recorrentes", "importacao", "comissoes", "controle-caixa", "faturamento-agrupado", "relatorios", "remessas", "retornos", "comissoes-relatorio", "dre", "equipe"];
const businessPanels = ["mensal", "diario", "pedidos-venda", "vendas-vendedor", "venda-canal", "previsao-estoque", "margem-pedido", "novos-recorrentes", "atividade-carteira", "curva-abc", "metas"];

export function portedTarget(to: string): PortedTarget | null {
  const url = portedUrl(to);
  if (!url) return null;
  const path = url.pathname, params = url.searchParams;
  // Consultas selecionam entidades/permissões. Parâmetros de detalhe e filtros
  // continuam intactos; seletores repetidos não podem escolher dois acessos.
  if (["cadastro", "tipo", "area", "painel", "modelo", "acao"].some(key => params.getAll(key).length > 1)) return null;
  const select = (key: string, values: readonly string[], fallback: string) => !params.has(key) || values.includes(params.get(key)!) ? params.get(key) ?? fallback : null;
  if (["/tags", "/grupos-tags", "/preferencias/suprimentos/tags", "/preferencias/suprimentos/grupos-tags"].includes(path)) {
    const type = select("tipo", ["", "produtos", "contatos", "notas"], "");
    return type === null ? null : type === "produtos" ? rule("catalogo", undefined, "products") : type === "contatos" ? rule("cadastro", undefined, "contacts") :
      type === "notas" ? { part: "fiscal", anyResource: ["nfe", "nfce"] } : extra["/tags"];
  }
  if (path === "/cadastros-reais") {
    const entity = select("cadastro", ["contacts", "products", "warehouses"], "contacts");
    return entity === "contacts" ? rule("cadastro", undefined, "contacts") : entity === "products" ? rule("catalogo", undefined, "products") : entity === "warehouses" ? rule("estoque", ["admin", "consulta", "estoque"]) : null;
  }
  if (path === "/documentos-empresa") {
    const kind = select("tipo", ["sales_orders", "sales_proposals", "purchase_orders", "service_orders"], "sales_proposals");
    if (!kind) return null;
    const action = params.get("acao");
    const base = kind === "purchase_orders" ? rule("compras", purchases) : kind === "service_orders" ? rule("servicos", sales) : rule("vendas", kind === "sales_orders" ? undefined : sales);
    if (action === "numeracao") return { ...base, roles: admin };
    if (action === "cabecalho") return base;
    if (action === "aprovacao-descontos") return kind === "sales_orders" ? base : null;
    if (action === "checkout") return kind === "sales_orders" ? { ...base, roles: ["admin", "vendas"] } : null;
    return base;
  }
  if (path === "/financeiro-empresa") {
    const area = select("area", financeAreas, "receivable");
    return area ? rule(["remessas", "retornos"].includes(area) ? "cobranca" : "financeiro", finance) : null;
  }
  if (path === "/meu-negocio") {
    const panel = select("painel", businessPanels, "mensal");
    return panel ? rule("vendas", panel === "margem-pedido" ? purchases : panel === "previsao-estoque" ? products : undefined) : null;
  }
  if (path === "/painel-produtos-empresa") {
    const panel = select("painel", ["estoque", "sugestao", "sem-movimentacao"], "estoque");
    return panel ? rule(panel === "sugestao" ? "compras" : "estoque", panel === "sugestao" ? ["admin", "consulta", "estoque", "fiscal"] : products) : null;
  }
  if (["/historico-fiscal", "/emissor-fiscal"].includes(path) && select("modelo", ["", "55", "65"], "55") === null) return null;
  if (path === "/ajuda" || ["novidades", "primeiros-passos", "notas-fiscais", "naturezas-operacao", "exportacao"].some(topic => path === `/ajuda/${topic}`)) return rule("sistema");
  if (path === "/preferencias") return rule("sistema");
  if (path.startsWith("/preferencias/")) {
    const pieces = path.slice("/preferencias/".length).split("/");
    if (pieces.length === 1) {
      const category = pieces[0];
      if (category === "importacoes") return rule("sistema", admin);
      const entries = Object.entries(preferences).filter(([key]) => key.startsWith(category + "/"));
      if (!entries.length || category === "meu-negocio") return null;
      const roles = entries.some(([, [entry]]) => !entry.roles) ? undefined : [...new Set(entries.flatMap(([, [entry]]) => entry.roles!))];
      return rule(category === "notas-fiscais" || category === "certificado" ? "fiscal" : "sistema", roles);
    }
    if (pieces[0] === "importacoes" && pieces.length === 2 && Object.hasOwn(imports, pieces[1])) return rule(imports[pieces[1]], admin);
    const page = preferences[pieces.slice(0, 2).join("/")];
    return page && (pieces.length === 2 || pieces.length === 3 && page[1]?.includes(pieces[2])) ? page[0] : null;
  }
  if (Object.hasOwn(extra, path)) return extra[path];
  const item = ERP_MANAGEMENT_ITEMS.find(item => item.target.to.split("?")[0] === path);
  return item ? { part: item.part, ...item.permission } : null;
}

/** Acesso efetivo reutilizado pelas ferramentas, depois da confirmação do /v1/me. */
function roleAllowed(to: string, role: string | null | undefined, resources: readonly string[]): boolean {
  const target = portedTarget(to);
  return !!target && !!role && Object.hasOwn(ROLE_RESOURCES, role) &&
    (!target.roles || target.roles.includes(role as PanelErpRole)) && (!target.resource || resources.includes(target.resource)) &&
    (!target.anyResource || target.anyResource.some(resource => resources.includes(resource)));
}

export function portedPermissionState(to: string, permissions?: ErpPermissions | null): PortedTargetState {
  const target = portedTarget(to);
  if (!target) return "not-found";
  if (!target.readPermission) return "allowed";
  if (!permissions || permissions.phase === "checking") return "loading";
  if (permissions.phase === "error") return "unavailable";
  return permissions.permissions === null || permissions.permissions.includes(target.readPermission) ? "allowed" : "denied";
}

export function portedPermissionAllowed(to: string, role: string | null | undefined, resources: readonly string[], permissions?: ErpPermissions | null): boolean {
  return roleAllowed(to, role, resources) && (!permissions || permissions.role === role) && portedPermissionState(to, permissions) === "allowed";
}

/** O quarto argumento acrescenta a verificação efetiva sem mudar a entrada básica existente. */
export function portedTargetState(to: string, c: ManagementContext, simulated = false, permissions?: ErpPermissions | null): PortedTargetState {
  if (!c.statusLoaded) return "loading";
  if (hiddenPortedTarget(to)) return "unavailable";
  const target = portedTarget(to), url = portedUrl(to);
  if (!target || !url) return "not-found";
  if (!erpPartEnabled(target.part, c.modules, to)) return "disabled";
  if (!roleAllowed(to, c.erpRole, ROLE_RESOURCES[c.erpRole ?? ""] ?? [])) return "denied";
  if (!simulated && MOTOR_PENDING.some(item =>
    (url.pathname === item.path || item.under && url.pathname.startsWith(item.path + "/")) &&
    (!item.query || item.query[1].includes(url.searchParams.get(item.query[0]) ?? "")))) return "unavailable";
  if (permissions !== undefined) {
    if (permissions && !roleAllowed(to, permissions.role, permissions.resources ?? ROLE_RESOURCES[permissions.role] ?? [])) return "denied";
    return portedPermissionState(to, permissions);
  }
  return "allowed";
}
