// Módulos de área do bot (Saúde, Ensino, Jurídico, Condomínio): regras puras
// da tela. O inventário vem de GET {root}/bots/{id}/area-grants e a mudança
// vai em PUT {root}/bots/{id}/area-grants (src/bot-actions/area.ts).

export type AreaOperation = {
  id: string;
  title: string;
  description: string;
  kind: "read" | "write";
  enabled: boolean;
  direct: boolean;
};

export type AreaLogEntry = {
  id: string;
  kind: string;
  operation: string;
  action: "on" | "off" | "used";
  actor_name: string;
  detail: string;
  created: number;
  title: string;
};

export type AreaModule = {
  module: string;
  title: string;
  module_enabled: boolean;
  warning: string;
  direct_warning: string;
  sensitive_warning: string;
  sensitive_label: string;
  sensitive_fields: boolean;
  operations: AreaOperation[];
  log: AreaLogEntry[];
};

export type AreaGrantRequest = {
  module: string;
  kind: "operation" | "direct" | "sensitive_fields";
  operation?: string;
  enabled: boolean;
  confirmed?: true;
  direct_confirmed?: true;
};

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** Módulos da resposta, sem itens malformados; a ordem é a do servidor. */
export function areaModules(raw: any): AreaModule[] {
  const list = Array.isArray(raw?.modules) ? raw.modules : [];
  return list
    .filter((m: any) => m && typeof m.module === "string")
    .map((m: any) => ({
      module: m.module,
      title: text(m.title) || m.module,
      module_enabled: m.module_enabled === true,
      warning: text(m.warning),
      direct_warning: text(m.direct_warning),
      sensitive_warning: text(m.sensitive_warning),
      sensitive_label: text(m.sensitive_label),
      sensitive_fields: m.sensitive_fields === true,
      operations: (Array.isArray(m.operations) ? m.operations : [])
        .filter((op: any) => op && typeof op.id === "string")
        .map((op: any) => ({
          id: op.id,
          title: text(op.title) || op.id,
          description: text(op.description),
          kind: op.kind === "write" ? "write" : "read",
          enabled: op.enabled === true,
          direct: op.direct === true,
        })),
      log: (Array.isArray(m.log) ? m.log : []).filter((entry: any) => entry && typeof entry.id === "string"),
    }));
}

/** Só os módulos ligados na área aparecem; os outros, num aviso. */
export const visibleModules = (modules: AreaModule[]) => modules.filter((m) => m.module_enabled);

export const enabledCount = (module: AreaModule) => module.operations.filter((op) => op.enabled).length;

/** Pedido ao ligar ou desligar: ligar leva a confirmação do aviso certo. */
export function grantRequest(
  module: AreaModule,
  kind: AreaGrantRequest["kind"],
  enabled: boolean,
  operation?: string,
): AreaGrantRequest {
  return {
    module: module.module,
    kind,
    ...(operation ? { operation } : {}),
    enabled,
    ...(enabled && kind === "direct" ? { direct_confirmed: true as const } : {}),
    ...(enabled && kind !== "direct" ? { confirmed: true as const } : {}),
  };
}

/** Aviso que a pessoa confirma antes de ligar. */
export function warningFor(module: AreaModule, kind: AreaGrantRequest["kind"]) {
  return kind === "direct" ? module.direct_warning : kind === "sensitive_fields" ? module.sensitive_warning : module.warning;
}

/** Linha do registro, em português. */
export function logText(entry: AreaLogEntry) {
  const who = entry.actor_name || "Alguém";
  if (entry.action === "used")
    return `${who} usou pelo bot: ${entry.title}${entry.detail ? ` (${entry.detail})` : ""}`;
  const verb = entry.action === "on" ? "ligou" : "desligou";
  if (entry.kind === "direct") return `${who} ${verb} a execução sem confirmação: ${entry.title}`;
  if (entry.kind === "sensitive_fields") return `${who} ${verb} incluir campos sensíveis`;
  return `${who} ${verb}: ${entry.title}`;
}

/** Mensagem quando o inventário não carrega. */
export function areaProblem(error: any): { text: string; retry: boolean } {
  const status = Number(error?.status);
  if (status === 403)
    return { text: "Só o administrador da área vê e libera os módulos de área para o bot.", retry: false };
  if (status === 404)
    return { text: "Este bot não está mais nesta área. Atualize a página.", retry: false };
  return { text: "Não deu para carregar os módulos de área do bot agora.", retry: true };
}
