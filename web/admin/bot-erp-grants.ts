// O que cada bot pode fazer no ERP: regras puras da tela do bot (montar o
// PATCH ao ligar e desligar, decidir quando avisar, filtrar as leituras que o
// bot faz sozinho). O inventário vem de GET {root}/bots/erp-operations: é a
// fonte única dos nomes, grupos e módulos exigidos; aqui nada é repetido.

export type ErpOperationModule = { id: string; title: string; enabled: boolean };

export type ErpOperation = {
  id: string;
  title: string;
  description: string;
  kind: "read" | "write";
  sensitive: boolean;
  autonomous: boolean;
  modules: ErpOperationModule[];
};

export type ErpOperationGroup = {
  id: string;
  title: string;
  operations: ErpOperation[];
};

/** Concessões atuais do bot. */
export type BotErpGrants = { operations: string[]; autonomous: string[] };

/** Corpo do PATCH {root}/bots/{id}. */
export type BotErpPatch = {
  erp_operations: string[];
  erp_autonomous_operations: string[];
  erp_data_acknowledged: true;
};

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string" && !!item))]
    : [];

/** Grupos da resposta, sem itens malformados; a ordem é a do servidor. */
export function erpGroups(raw: any): ErpOperationGroup[] {
  const groups = Array.isArray(raw?.groups) ? raw.groups : [];
  return groups
    .filter((group: any) => group && typeof group.id === "string")
    .map((group: any) => ({
      id: group.id,
      title: String(group.title || group.id),
      operations: (Array.isArray(group.operations) ? group.operations : [])
        .filter((op: any) => op && typeof op.id === "string" && op.id)
        .map(
          (op: any): ErpOperation => ({
            id: op.id,
            title: String(op.title || op.id),
            description: String(op.description || ""),
            kind: op.kind === "write" ? "write" : "read",
            sensitive: op.sensitive === true,
            autonomous: op.autonomous === true,
            modules: (Array.isArray(op.modules) ? op.modules : [])
              .filter((m: any) => m && typeof m.id === "string")
              .map((m: any) => ({
                id: m.id,
                title: String(m.title || m.id),
                enabled: m.enabled !== false,
              })),
          }),
        ),
    }));
}

/** Concessões do bot como vieram em app.bots (ausentes = vazio). */
export function botErpGrants(bot: any): BotErpGrants {
  return {
    operations: strings(bot?.erp_operations),
    autonomous: strings(bot?.erp_autonomous_operations),
  };
}

const patchOf = (operations: string[], autonomous: string[]): BotErpPatch => ({
  erp_operations: operations,
  // Só vale "sozinho" para o que também está liberado.
  erp_autonomous_operations: autonomous.filter((id) => operations.includes(id)),
  erp_data_acknowledged: true,
});

/** Ligar ou desligar uma operação. Desligada, sai também de "sozinho". */
export function operationPatch(current: BotErpGrants, id: string, on: boolean): BotErpPatch {
  const operations = on
    ? [...new Set([...current.operations, id])]
    : current.operations.filter((item) => item !== id);
  const autonomous = on ? current.autonomous : current.autonomous.filter((item) => item !== id);
  return patchOf(operations, autonomous);
}

/** Ligar ou desligar a leitura sem confirmação da pessoa. */
export function autonomousPatch(current: BotErpGrants, id: string, on: boolean): BotErpPatch {
  const autonomous = on
    ? [...new Set([...current.autonomous, id])]
    : current.autonomous.filter((item) => item !== id);
  return patchOf(current.operations, autonomous);
}

/** A primeira operação liberada pede o aviso de que dados vão ao provedor. */
export const needsDataWarning = (current: BotErpGrants, on: boolean) =>
  on && current.operations.length === 0;

/** Leituras sensíveis que podem virar "sozinho" e já estão liberadas. */
export function autonomousCandidates(
  groups: ErpOperationGroup[],
  current: BotErpGrants,
): ErpOperation[] {
  return groups.flatMap((group) =>
    group.operations.filter((op) => op.autonomous && current.operations.includes(op.id)),
  );
}

/** Quantas operações do grupo estão ligadas para o bot. */
export function groupCount(group: ErpOperationGroup, current: BotErpGrants) {
  const on = group.operations.filter((op) => current.operations.includes(op.id)).length;
  return { on, total: group.operations.length };
}

export const groupCountText = (count: { on: number; total: number }) =>
  `${count.on} de ${count.total} ${count.on === 1 ? "ligada" : "ligadas"}`;

/** Etiqueta curta do tipo da operação. */
export function operationKind(op: ErpOperation) {
  return {
    label: op.kind === "write" ? "Ação" : "Consulta",
    confirms: op.kind === "write" || op.sensitive,
  };
}

const joinNames = (names: string[]) =>
  names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} e ${names[names.length - 1]}`;

/** "Ligue o módulo X para o bot usar", ou vazio se tudo está ligado. */
export function missingModulesText(op: ErpOperation): string {
  const off = op.modules.filter((m) => !m.enabled).map((m) => m.title);
  if (!off.length) return "";
  return `${off.length === 1 ? "Ligue o módulo" : "Ligue os módulos"} ${joinNames(off)} para o bot usar.`;
}

export const ERP_OFF_TEXT = "Ligue o ERP em Módulos para liberar operações a este bot.";
export const ADMIN_ONLY_TEXT = "Só o administrador vê e muda o que o bot pode fazer no ERP.";

/**
 * Frase para quando o inventário não vem. Recusa conhecida vira uma frase
 * clara; o resto, um aviso com "Tentar de novo" (retry: true).
 */
export function inventoryProblem(error: any, erpOn: boolean): { text: string; retry: boolean } {
  if (!erpOn) return { text: ERP_OFF_TEXT, retry: false };
  const status = Number(error?.status);
  if (status === 403) return { text: ADMIN_ONLY_TEXT, retry: false };
  if (status === 404 || (status === 409 && error?.code === "module_disabled"))
    return { text: ERP_OFF_TEXT, retry: false };
  return { text: "Não deu para carregar as operações do ERP agora.", retry: true };
}
