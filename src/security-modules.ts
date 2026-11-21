// Permissões por módulo: o que cada pessoa (e cada bot por ela) pode fazer em
// cada módulo ligado na área. Pedido do dono de 21/11: no lugar dos papéis
// soltos "ERP: consulta / financeiro / ...", cada módulo tem uma lista de
// ações com nome e descrição, e um nível rápido (Sem acesso, Só ver, Operar,
// Administrar); "Personalizar" escolhe as ações uma a uma.
//
// Onde fica: na mesma lista de acesso da pessoa (users.access, src/access.ts),
// sem coluna nova nem migração do D1:
//   "erp-financeiro@ver"      nível rápido (ver | operar | administrar | nenhum)
//   "erp-financeiro+baixar"   ação marcada em "Personalizar"
// O papel do motor do ERP (erp:<papel>) deixa de ser escolhido na tela: o
// servidor o deriva dos níveis ao salvar (erpEngineRoleFor), e o portão do
// Worker confere cada ação antes do motor (requireErpRouteAction).
//
// Pessoa com o papel antigo e sem nenhum item novo do ERP continua como
// estava (o motor confere o papel, como antes); a tela mostra os níveis
// equivalentes (legacyErpLevels) e, ao salvar, grava o modelo novo. A
// conversão é conferida em tests/permissoes-modulos.test.ts.
//
// Este arquivo é puro: não lê banco nem importa o registro de módulos.
import { erpBlockOf } from "./erp/blocks.ts";
import { ERP_MODULE_IDS, ERP_PART_NAMES, type ErpModuleId } from "./erp/parts.ts";

export type PermissionLevel = "nenhum" | "ver" | "operar" | "administrar";
export const PERMISSION_LEVELS: readonly PermissionLevel[] = ["nenhum", "ver", "operar", "administrar"];
export const LEVEL_LABELS: Readonly<Record<PermissionLevel | "personalizado", string>> = {
  nenhum: "Sem acesso",
  ver: "Só ver",
  operar: "Operar",
  administrar: "Administrar",
  personalizado: "Personalizado",
};
const RANK: Record<PermissionLevel, number> = { nenhum: 0, ver: 1, operar: 2, administrar: 3 };

export interface ModuleAction {
  id: string;
  label: string;
  description: string;
  /** Menor nível rápido que já inclui a ação. */
  level: Exclude<PermissionLevel, "nenhum">;
}

const a = (id: string, level: ModuleAction["level"], label: string, description: string): ModuleAction =>
  ({ id, level, label, description });

/** Ações dos módulos do ERP, na ordem da tela. */
export const ERP_MODULE_ACTIONS: Readonly<Record<ErpModuleId, readonly ModuleAction[]>> = {
  erp: [
    a("ver", "ver", "Ver cadastros", "Clientes, fornecedores, vendedores, funcionários e lojas."),
    a("criar_editar", "operar", "Criar e editar cadastros", "Inclui contatos, tags e campos próprios do cliente."),
    a("exportar", "operar", "Exportar para planilha", "Baixar a lista de cadastros em planilha."),
    a("apagar", "administrar", "Apagar e desativar cadastros", "Mandar para a lixeira ou desativar um cadastro."),
    a("configurar", "administrar", "Configurar a empresa e o ERP", "Dados da empresa, preferências, importação por planilha, backup e Bling."),
  ],
  "erp-produtos": [
    a("ver", "ver", "Ver produtos e serviços", "Catálogo, categorias e listas de preços."),
    a("criar_editar", "operar", "Criar e editar produtos", "Cadastro, variações, imagens e composição."),
    a("precos", "operar", "Mudar preços", "Preço de venda, reajuste e listas de preços."),
    a("exportar", "operar", "Exportar para planilha", "Baixar o catálogo em planilha."),
    a("apagar", "administrar", "Apagar e desativar produtos", "Mandar para a lixeira ou desativar."),
  ],
  "erp-vendas": [
    a("ver", "ver", "Ver propostas e pedidos", "Propostas, pedidos de venda e ordens de serviço."),
    a("relatorios", "ver", "Ver painéis de vendas", "Meu negócio: vendas por vendedor, canal, metas e curva ABC."),
    a("criar_editar", "operar", "Criar e editar pedido ou proposta", "Inclui mudar a situação e duplicar."),
    a("cancelar", "administrar", "Cancelar e apagar pedido ou proposta", "Cancela, estorna ou manda para a lixeira."),
    a("aprovar_desconto", "administrar", "Aprovar desconto acima do limite", "Passa do limite de desconto do vendedor."),
    a("ver_margem", "administrar", "Ver custo e margem", "Custo, margem e lucro por pedido e por produto."),
  ],
  "erp-compras": [
    a("ver", "ver", "Ver pedidos de compra", "Pedidos de compra e notas recebidas do fornecedor."),
    a("criar_editar", "operar", "Criar e editar pedido de compra", "Inclui mudar a situação."),
    a("receber", "operar", "Receber mercadoria e nota", "Conferir e dar entrada pela nota do fornecedor."),
    a("cancelar", "administrar", "Cancelar e apagar pedido de compra", "Cancela, estorna a entrada ou manda para a lixeira."),
  ],
  "erp-estoque": [
    a("ver", "ver", "Ver estoque", "Saldos, movimentos, lotes, reservas e relatórios de estoque."),
    a("movimentar", "operar", "Lançar entradas, saídas e transferências", "Movimentos do dia a dia e reservas."),
    a("ajustar", "administrar", "Inventário, ajuste e depósitos", "Conferência, ajuste de saldo, política de estoque e depósitos."),
  ],
  "erp-financeiro": [
    a("ver_contas", "ver", "Ver contas a pagar e a receber", "Títulos, baixas, ficha do cliente e comissões."),
    a("ver_lucro", "ver", "Ver saldos e lucro (DRE)", "Saldo das contas, extrato, fluxo de caixa, DRE e gráficos."),
    a("relatorios", "ver", "Ver relatórios financeiros", "Vencimentos, recebimentos, pagamentos e equipe."),
    a("lancar", "operar", "Lançar e editar contas", "Cadastrar conta a pagar ou a receber, recorrências, caixa e lançamentos."),
    a("baixar", "operar", "Baixar e estornar", "Registrar pagamento ou recebimento e desfazer a baixa."),
    a("conciliar", "operar", "Conciliar extrato e cartões", "Importar extrato e casar as linhas com as contas."),
    a("cobrar", "operar", "Gerar cobrança", "Mandar a cobrança de uma conta ao cliente."),
    a("apagar", "administrar", "Cancelar e apagar contas", "Cancelar título, apagar lançamento, transferência ou extrato."),
    a("configurar", "administrar", "Contas bancárias e categorias", "Criar contas financeiras e categorias, saldo inicial e custos da DRE."),
  ],
  "erp-fiscal": [
    a("ver_notas", "ver", "Ver notas fiscais", "Notas emitidas e recebidas, DANFE, XML e relatórios fiscais."),
    a("emitir", "operar", "Emitir nota", "Preparar e emitir NF-e e NFC-e, devolução e arquivos para o contador."),
    a("carta", "operar", "Carta de correção", "Enviar carta de correção de uma nota autorizada."),
    a("cancelar", "administrar", "Cancelar nota", "Cancelar nota ou cupom no prazo."),
    a("inutilizar", "administrar", "Inutilizar numeração", "Inutilizar uma faixa de números de nota."),
    a("configurar", "administrar", "Configurar o emissor", "Certificado, numeração, naturezas de operação e reforma tributária."),
  ],
  "erp-cobranca": [
    a("ver", "ver", "Ver boletos, remessas e retornos", "Situação dos boletos no banco."),
    a("gerar", "operar", "Gerar boleto e remessa", "Registrar boleto, mudar vencimento e montar a remessa."),
    a("retorno", "operar", "Processar retorno", "Ler o retorno do banco e baixar as contas pagas."),
    a("configurar", "administrar", "Configurar a cobrança", "Conta de cobrança e convênio do banco."),
  ],
  "erp-pdv": [
    a("ver", "ver", "Ver vendas do caixa", "Vendas do balcão, sessões de caixa e pagamentos da maquininha."),
    a("vender", "operar", "Vender no balcão", "Abrir caixa, registrar a venda e receber, inclusive na maquininha."),
    a("devolver", "administrar", "Devolver e cancelar venda", "Devolução e cancelamento de venda do caixa."),
    a("configurar", "administrar", "Configurar o caixa", "Preferências do caixa e da maquininha."),
  ],
  "erp-producao": [
    a("ver", "ver", "Ver ordens de produção", "Ordens e sugestões do que fabricar."),
    a("produzir", "operar", "Criar e concluir ordem de produção", "Baixa os insumos e dá entrada no produto acabado."),
    a("estornar", "administrar", "Estornar ordem de produção", "Desfaz a produção no estoque."),
  ],
  "erp-expedicao": [
    a("ver", "ver", "Ver separação e entregas", "Separação, volumes, romaneio, frete e rastreio."),
    a("separar", "operar", "Separar, embalar e expedir", "Gerar separação, volumes, etiquetas e marcar expedido."),
    a("devolucao", "operar", "Registrar devolução física", "Mercadoria que voltou da entrega."),
    a("frete", "administrar", "Contratar e cancelar frete", "Contratar o envio com a transportadora ou cancelar."),
  ],
  "erp-contratos": [
    a("ver", "ver", "Ver contratos", "Contratos, faturas, avisos de renovação e índices."),
    a("editar", "operar", "Criar e editar contrato", "Itens, vigência, periodicidade e aditivos."),
    a("faturar", "operar", "Gerar faturas", "Gera a conta a receber do período."),
    a("encerrar", "administrar", "Reajustar, suspender e encerrar", "Reajuste por índice, suspensão, renovação e encerramento."),
  ],
};

/** Ações de um módulo da área (Ordem de Serviço, Agenda, Mensalidade...). */
export const AREA_MODULE_ACTIONS: readonly ModuleAction[] = [
  a("ver", "ver", "Ver", "Abrir as telas e consultar os registros do módulo."),
  a("operar", "operar", "Criar e editar", "Registrar, alterar e mudar a situação."),
  a("apagar", "administrar", "Apagar", "Apagar registros do módulo."),
];

export const isErpModule = (id: string): id is ErpModuleId => (ERP_MODULE_IDS as readonly string[]).includes(id);

/** Ações declaradas de um módulo (ERP: as próprias; área: as gerais). */
export const actionsOf = (moduleId: string): readonly ModuleAction[] =>
  isErpModule(moduleId) ? ERP_MODULE_ACTIONS[moduleId] : AREA_MODULE_ACTIONS;

export const moduleTitle = (moduleId: string, fallback?: string) =>
  isErpModule(moduleId) ? ERP_PART_NAMES[moduleId] : fallback ?? moduleId;

// ---------------------------------------------------------------------------
// Itens da lista de acesso

export const levelItem = (moduleId: string, level: PermissionLevel) => `${moduleId}@${level}`;
export const actionItem = (moduleId: string, action: string) => `${moduleId}+${action}`;

/** "<módulo>@<nível>" ou "<módulo>+<ação>" → partes; outro item → null. */
export function parsePermissionItem(item: string):
  | { kind: "level"; module: string; level: PermissionLevel }
  | { kind: "action"; module: string; action: string }
  | null {
  const at = /^([a-z0-9-]+)@([a-z]+)$/.exec(item);
  if (at) return PERMISSION_LEVELS.includes(at[2] as PermissionLevel) ? { kind: "level", module: at[1], level: at[2] as PermissionLevel } : null;
  const plus = /^([a-z0-9-]+)\+([a-z_]+)$/.exec(item);
  return plus ? { kind: "action", module: plus[1], action: plus[2] } : null;
}

/** O item é do modelo novo e conhecido (módulo existente e ação declarada)? */
export function validPermissionItem(item: string, knownModules: ReadonlySet<string>): boolean {
  const parsed = parsePermissionItem(item);
  if (!parsed || !knownModules.has(parsed.module)) return false;
  return parsed.kind === "level" || actionsOf(parsed.module).some((x) => x.id === parsed.action);
}

/** A lista usa o modelo novo neste módulo? */
export const hasModuleItems = (list: readonly string[], moduleId: string) =>
  list.some((item) => item.startsWith(moduleId + "@") || item.startsWith(moduleId + "+"));

/** A lista usa o modelo novo em algum módulo do ERP? */
export const hasErpItems = (list: readonly string[]) => ERP_MODULE_IDS.some((id) => hasModuleItems(list, id));

/** Nível rápido guardado (null: personalizado ou sem item). */
export function storedLevel(list: readonly string[], moduleId: string): PermissionLevel | null {
  for (const item of list) {
    const parsed = parsePermissionItem(item);
    if (parsed?.kind === "level" && parsed.module === moduleId) return parsed.level;
  }
  return null;
}

/** Ações de um nível rápido. */
export const actionsForLevel = (moduleId: string, level: PermissionLevel) =>
  actionsOf(moduleId).filter((x) => RANK[x.level] <= RANK[level]).map((x) => x.id);

/**
 * Ações que a lista dá no módulo, ou null quando a lista não usa o modelo
 * novo ali (vale a regra antiga, sem conferência por ação).
 */
export function grantedActions(list: readonly string[], moduleId: string): string[] | null {
  if (!hasModuleItems(list, moduleId)) return null;
  const level = storedLevel(list, moduleId);
  if (level) return actionsForLevel(moduleId, level);
  const known = new Set(actionsOf(moduleId).map((x) => x.id));
  return list.flatMap((item) => {
    const parsed = parsePermissionItem(item);
    return parsed?.kind === "action" && parsed.module === moduleId && known.has(parsed.action) ? [parsed.action] : [];
  });
}

/**
 * Ações do ERP da pessoa: no modelo novo, o que está marcado (módulo do ERP
 * sem item = sem acesso); sem item novo, null (papel antigo, motor decide).
 */
export function erpGrantedActions(list: readonly string[], moduleId: ErpModuleId): string[] | null {
  if (!hasErpItems(list)) return null;
  return grantedActions(list, moduleId) ?? [];
}

// ---------------------------------------------------------------------------
// Papéis antigos ↔ níveis

export type ErpEngineRole = "admin" | "consulta" | "vendas" | "financeiro" | "estoque" | "fiscal";
const ROLES: readonly ErpEngineRole[] = ["admin", "consulta", "vendas", "financeiro", "estoque", "fiscal"];

/** Papel antigo guardado na lista (erp:<papel>), ou null. */
export function legacyErpRole(list: readonly string[]): ErpEngineRole | null {
  const role = list.find((item) => item.startsWith("erp:"))?.slice(4);
  return ROLES.includes(role as ErpEngineRole) ? (role as ErpEngineRole) : null;
}

/** Só o administrador do motor configura (empresa, emissor, contas, caixa). */
const ENGINE_ADMIN_ACTIONS: ReadonlySet<string> = new Set(["configurar"]);

/**
 * Itens do modelo novo equivalentes a um papel antigo (a migração): nos
 * módulos que o papel lia, "Só ver"; nos que ele escrevia, tudo menos
 * "Configurar" (que era só do administrador). Nada se perde: o papel
 * derivado desses itens é o mesmo papel antigo.
 */
export function legacyErpItems(role: ErpEngineRole): string[] {
  return ERP_MODULE_IDS.flatMap((id) => {
    if (role === "admin") return [levelItem(id, "administrar")];
    if (ENGINE_WRITES[role].includes(id)) {
      const all = ERP_MODULE_ACTIONS[id].map((x) => x.id);
      const kept = all.filter((x) => !ENGINE_ADMIN_ACTIONS.has(x));
      if (kept.length === all.length) return [levelItem(id, "administrar")];
      const operar = actionsForLevel(id, "operar");
      if (kept.length === operar.length && kept.every((x) => operar.includes(x))) return [levelItem(id, "operar")];
      return kept.map((x) => actionItem(id, x));
    }
    return [levelItem(id, ENGINE_READS[role].includes(id) ? "ver" : "nenhum")];
  });
}

/** Nível rápido que resume uma lista de ações (null: personalizado). */
export function levelOfActions(moduleId: string, actions: readonly string[]): PermissionLevel | null {
  const set = new Set(actions);
  return PERMISSION_LEVELS.find((level) => {
    const want = actionsForLevel(moduleId, level);
    return want.length === set.size && want.every((x) => set.has(x));
  }) ?? null;
}

/**
 * Converte a lista guardada para o modelo novo no ERP: tira o papel antigo e
 * põe os níveis equivalentes. Lista já no modelo novo (ou sem papel) fica.
 */
export function migrateErpAccess(list: readonly string[]): string[] {
  if (hasErpItems(list)) return [...list];
  const role = legacyErpRole(list);
  if (!role) return [...list];
  return [...list.filter((item) => !item.startsWith("erp:")), ...legacyErpItems(role)];
}

/**
 * O que cada papel do motor lê e escreve, por módulo (src/erp/role-resources.ts
 * e as regras de escrita dos domínios), para escolher o papel mais estreito
 * que cobre o que foi marcado. O motor confere o papel; o Worker, cada ação
 * (erpRouteAllowed).
 */
const ENGINE_READS: Readonly<Record<Exclude<ErpEngineRole, "admin">, readonly ErpModuleId[]>> = {
  consulta: ERP_MODULE_IDS,
  vendas: ["erp", "erp-produtos", "erp-vendas", "erp-pdv"],
  financeiro: ["erp", "erp-financeiro", "erp-cobranca", "erp-contratos"],
  estoque: ["erp", "erp-produtos", "erp-compras", "erp-estoque", "erp-producao", "erp-expedicao"],
  fiscal: ["erp", "erp-produtos", "erp-vendas", "erp-compras", "erp-fiscal"],
};
const ENGINE_WRITES: Readonly<Record<Exclude<ErpEngineRole, "admin">, readonly ErpModuleId[]>> = {
  consulta: [],
  vendas: ["erp", "erp-vendas", "erp-pdv"],
  financeiro: ["erp", "erp-financeiro", "erp-cobranca", "erp-contratos"],
  estoque: ["erp-produtos", "erp-compras", "erp-estoque", "erp-producao", "erp-expedicao"],
  fiscal: ["erp-fiscal"],
};

/**
 * Papel do motor para uma lista no modelo novo: o mais estreito que lê e
 * escreve tudo o que foi marcado; quando nenhum papel único cobre (vendas e
 * financeiro juntos, por exemplo) ou há algo de "Administrar", o motor recebe
 * administrador e o Worker restringe ação por ação. "Configurar" também pede
 * administrador no motor. Sem nada do ERP, null.
 */
export function erpEngineRoleFor(list: readonly string[]): ErpEngineRole | null {
  const reads: ErpModuleId[] = [], writes: ErpModuleId[] = [];
  let admin = false;
  for (const id of ERP_MODULE_IDS) {
    const granted = grantedActions(list, id) ?? [];
    if (!granted.length) continue;
    reads.push(id);
    const actions = ERP_MODULE_ACTIONS[id].filter((x) => granted.includes(x.id));
    if (actions.some((x) => ENGINE_ADMIN_ACTIONS.has(x.id))) admin = true;
    if (actions.some((x) => x.level !== "ver")) writes.push(id);
  }
  if (!reads.length) return null;
  if (admin) return "admin";
  for (const role of ["consulta", "vendas", "financeiro", "estoque", "fiscal"] as const)
    if (reads.every((id) => ENGINE_READS[role].includes(id)) && writes.every((id) => ENGINE_WRITES[role].includes(id))) return role;
  return "admin";
}

/**
 * Normaliza a lista ao salvar: no modelo novo do ERP, o papel do motor é
 * sempre o derivado (o enviado pela tela é descartado).
 */
export function normalizeErpAccess(list: readonly string[]): string[] {
  if (!hasErpItems(list)) return [...list];
  const role = erpEngineRoleFor(list);
  return [...list.filter((item) => !item.startsWith("erp:")), ...(role ? [`erp:${role}`] : [])];
}

// ---------------------------------------------------------------------------
// Rota → ação

export interface RouteAction {
  module: string;
  /** null: livre para quem já tem algum acesso ao ERP (início, preferências de tela). */
  action: string | null;
}

const READ = new Set(["GET", "HEAD"]);

/** Ação de uma rota da erp-api (`/v1/...`). */
export function erpApiAction(method: string, path: string): RouteAction {
  const read = READ.has(method.toUpperCase()), del = method.toUpperCase() === "DELETE";
  const block = erpBlockOf(path);
  const module: ErpModuleId = !block || block === "externo" ? "erp" : block;
  const removing = del || /(?:^|\/|_)(excluir|deleted|delete|apagar|lixeira|trash|active|set_active|inativar)(?:\/|$|_)/.test(path);
  const cancelling = /cancel|estorn|revers/.test(path);
  switch (module) {
    case "erp":
      if (read) {
        if (/^\/v1\/(me|inicio|plataforma|preferencias|preferencias-listas|sistema|empresa)(\/|$)/.test(path)) return { module, action: null };
        if (/exporta/.test(path)) return { module, action: "exportar" };
        if (/^\/v1\/(usuarios|seguranca|registro-atividades|gerenciador-arquivos|importacoes|receber-bling)(\/|$)/.test(path)) return { module, action: "configurar" };
        return { module, action: "ver" };
      }
      if (/^\/v1\/(empresa|usuarios|seguranca|preferencias|preferencias-listas|sistema|importacoes|receber-bling|gerenciador-arquivos|plataforma)(\/|$)/.test(path))
        return { module, action: "configurar" };
      return { module, action: removing ? "apagar" : "criar_editar" };
    case "erp-produtos":
      if (read) return { module, action: /exporta/.test(path) ? "exportar" : "ver" };
      if (removing) return { module, action: "apagar" };
      return { module, action: /listas-precos|\/precos|reajuste/.test(path) ? "precos" : "criar_editar" };
    case "erp-vendas":
      if (read) {
        if (/margem|margin/.test(path)) return { module, action: "ver_margem" };
        return { module, action: /^\/v1\/meu-negocio/.test(path) ? "relatorios" : "ver" };
      }
      return { module, action: removing || cancelling ? "cancelar" : "criar_editar" };
    case "erp-compras":
      if (read) return { module, action: "ver" };
      if (removing || cancelling) return { module, action: "cancelar" };
      return { module, action: /recebimentos-compras/.test(path) ? "receber" : "criar_editar" };
    case "erp-estoque":
      if (read) return { module, action: "ver" };
      return { module, action: /inventario|conferencia|ajuste|politica-estoque|cadastros\/warehouses|preferencias/.test(path) ? "ajustar" : "movimentar" };
    case "erp-financeiro": {
      if (read) {
        if (/dre|fluxo|balancete|extrato|contas-financeiras|saldo|graficos/.test(path)) return { module, action: "ver_lucro" };
        if (/relatorio|vencimentos/.test(path)) return { module, action: "relatorios" };
        return { module, action: "ver_contas" };
      }
      const name = /\/actions\/([a-z_]+)$/.exec(path)?.[1] ?? "";
      if (/^(settle|settle_batch|reverse|title_bank_writeoff)$/.test(name)) return { module, action: "baixar" };
      if (/_delete$|^title_cancel$/.test(name) || del) return { module, action: "apagar" };
      if (/^(line_|statement_import)/.test(name)) return { module, action: "conciliar" };
      if (/^(account_|category_|opening$|balance_adjust$)/.test(name) || /preferencias/.test(path)) return { module, action: "configurar" };
      return { module, action: "lancar" };
    }
    case "erp-fiscal":
      if (read) return { module, action: "ver_notas" };
      if (/inutiliz/.test(path)) return { module, action: "inutilizar" };
      if (/carta/.test(path)) return { module, action: "carta" };
      if (/cancel/.test(path)) return { module, action: "cancelar" };
      if (/numeracao-fiscal|certificado|preferencias|\/a1(\/|$)/.test(path)) return { module, action: "configurar" };
      return { module, action: "emitir" };
    case "erp-cobranca":
      if (read) return { module, action: "ver" };
      if (/retorno/.test(path)) return { module, action: "retorno" };
      return { module, action: /account_set_default|preferencias/.test(path) ? "configurar" : "gerar" };
    case "erp-pdv":
      if (read) return { module, action: "ver" };
      if (/preferencias/.test(path)) return { module, action: "configurar" };
      return { module, action: /devol|cancel/.test(path) ? "devolver" : "vender" };
    default:
      return { module, action: read ? "ver" : actionsOf(module).find((x) => x.level === "operar")?.id ?? "ver" };
  }
}

/**
 * Ação de uma rota da área (caminho depois de /api/v1/profiles/<área>/) que
 * pertence ao ERP; null quando a rota não é do ERP.
 */
export function erpRouteAction(method: string, route: string): RouteAction | null {
  const clean = route.replace(/^\/+|\/+$/g, "");
  const [root, ...rest] = clean.split("/");
  const sub = rest.join("/");
  const read = READ.has(method.toUpperCase());
  const write = !read;
  const at = (module: ErpModuleId, action: string | null): RouteAction => ({ module, action });
  switch (root) {
    case "erp":
      return erpApiAction(method, "/" + sub);
    case "erp-comercial-nfe":
      if (read) return at("erp-fiscal", "ver_notas");
      if (/inutiliz/.test(sub)) return at("erp-fiscal", "inutilizar");
      if (/carta-correcao/.test(sub)) return at("erp-fiscal", "carta");
      if (/cancelar/.test(sub)) return at("erp-fiscal", "cancelar");
      if (/(^|\/)config$/.test(sub)) return at("erp-fiscal", "configurar");
      return at("erp-fiscal", "emitir");
    case "erp-emissor":
    case "erp-fiscal-cofre":
    case "erp-reforma":
      return at("erp-fiscal", read ? "ver_notas" : "configurar");
    case "erp-contador":
    case "erp-sped":
      return at("erp-fiscal", read ? "ver_notas" : "emitir");
    case "erp-recebidas":
      return at("erp-compras", read ? "ver" : "receber");
    case "erp-relatorios":
      if (/^dre/.test(sub)) return at("erp-financeiro", write ? "configurar" : "ver_lucro");
      if (/^graficos\/financeiro/.test(sub)) return at("erp-financeiro", "ver_lucro");
      if (/^graficos\/vendas/.test(sub)) return at("erp-vendas", "relatorios");
      if (/^(graficos\/estoque|lotes-vencendo)/.test(sub)) return at("erp-estoque", "ver");
      if (/^equipe/.test(sub)) return at("erp-financeiro", write ? "lancar" : "relatorios");
      return at("erp", read ? "ver" : "configurar");
    case "erp-conciliacao":
      return at("erp-financeiro", read ? "ver_contas" : "conciliar");
    case "erp-boleto":
      return at("erp-cobranca", read ? "ver" : "gerar");
    case "erp-maquininha":
      return at("erp-pdv", read ? "ver" : /config/.test(sub) ? "configurar" : "vender");
    case "erp-producao":
      return at("erp-producao", read ? "ver" : /estorn/.test(sub) ? "estornar" : "produzir");
    case "erp-expedicao":
      if (read) return at("erp-expedicao", "ver");
      if (/^frete/.test(sub)) return at("erp-expedicao", "frete");
      return at("erp-expedicao", /devolu/.test(sub) ? "devolucao" : "separar");
    case "erp-contratos":
      if (read) return at("erp-contratos", "ver");
      if (/fatur/.test(sub)) return at("erp-contratos", "faturar");
      return at("erp-contratos", /reajust|suspend|encerr|renov|ativar/.test(sub) ? "encerrar" : "editar");
    case "erp-conversa":
      if (/^conta\/[^/]+\/cobranca\/[^/]+\/baixar/.test(sub)) return at("erp-financeiro", "baixar");
      if (/^conta\/[^/]+\/cobranca/.test(sub)) return at("erp-financeiro", read ? "ver_contas" : "cobrar");
      if (/^financeiro\/preferencias/.test(sub)) return at("erp-financeiro", read ? "ver_contas" : "configurar");
      return at("erp", read ? "ver" : "criar_editar");
    case "erp-contato-campos":
      return at("erp", read ? "ver" : "criar_editar");
    case "erp-lojas":
    case "erp-empresas":
      return at("erp", read ? "ver" : "configurar");
    case "erp-backup":
      return at("erp", "configurar");
    default:
      return null;
  }
}

export const actionLabel = (moduleId: string, action: string, moduleName?: string) =>
  `${moduleTitle(moduleId, moduleName)} › ${actionsOf(moduleId).find((x) => x.id === action)?.label ?? action}`;

/** Frase da recusa: qual ação falta e quem libera. */
export const missingActionMessage = (moduleId: string, action: string, moduleName?: string) =>
  `Falta a permissão “${actionLabel(moduleId, action, moduleName)}” para fazer isto. Quem libera é o administrador, em Gestão › Pessoas e acessos › Editar pessoa.`;

/**
 * A lista dá a ação desta rota do ERP? true quando a pessoa ainda está no
 * papel antigo (o motor confere) ou quando a rota não é do ERP.
 */
export function erpRouteAllowed(list: readonly string[], method: string, route: string):
  { ok: true } | { ok: false; module: string; action: string } {
  if (!hasErpItems(list)) return { ok: true };
  const found = erpRouteAction(method, route);
  if (!found) return { ok: true };
  const anyErp = ERP_MODULE_IDS.some((id) => (grantedActions(list, id) ?? []).length > 0);
  if (found.action === null) return anyErp ? { ok: true } : { ok: false, module: found.module, action: "ver" };
  const granted = grantedActions(list, found.module) ?? [];
  return granted.includes(found.action) ? { ok: true } : { ok: false, module: found.module, action: found.action };
}

/**
 * Módulo da área (não ERP) pelo método: leitura pede "ver", DELETE pede
 * "apagar", o resto "operar". Sem item novo no módulo, vale a regra antiga.
 */
export function areaModuleAllowed(list: readonly string[], moduleId: string, method: string):
  { ok: true } | { ok: false; module: string; action: string } {
  if (isErpModule(moduleId)) return { ok: true };
  const granted = grantedActions(list, moduleId);
  if (granted === null) return { ok: true };
  const verb = method.toUpperCase();
  const action = READ.has(verb) ? "ver" : verb === "DELETE" ? "apagar" : "operar";
  return granted.includes(action) ? { ok: true } : { ok: false, module: moduleId, action };
}
