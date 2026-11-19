// Blocos do ERP (PLANO-FAGOO.md, item 16): o núcleo `erp` e quatro opcionais
// com chave própria no sistema de módulos do Wabotia. Cada endereço do ERP
// pertence a um bloco; menu, rotas e divisão em arquivos seguem esta regra.
// Mapa comentado: sessao-M-erp-painel.md (notas da orquestração).

import { pendingInMotor } from "./motor.ts";
import { blockOf, erpPartEnabled } from "./modules.ts";
import { portedTarget, portedUrl, hiddenPortedTarget } from "../management/ported-policy.ts";
export { blockOf } from "./modules.ts";

export type ErpBlock = "erp" | "erp-fiscal" | "erp-cobranca" | "erp-pdv";

export const ERP_BLOCK_LABELS: Record<ErpBlock, string> = {
  erp: "ERP",
  "erp-fiscal": "Fiscal",
  "erp-cobranca": "Cobrança bancária",
  "erp-pdv": "Caixa / PDV",
};

/**
 * Telas do Fagoo que o Wabotia já faz pelo núcleo e que ficam escondidas:
 * a atualização da instalação (o painel atualiza) e o pareamento com o
 * próprio Wabotia.
 */
export const hiddenInWabotia = hiddenPortedTarget;

/** Blocos ligados na área; sem registro (testes do Fagoo), todos ligados. */
let enabled: Partial<Record<ErpBlock, boolean>> | null = null;
export function setErpBlocks(next: Partial<Record<ErpBlock, boolean>> | null) {
  enabled = next;
}
const legacyModules = () => Object.fromEntries(
  ["erp", "erp-fiscal", "erp-cobranca", "erp-pdv"].map(key => [key, !enabled || enabled[key as ErpBlock] !== false]),
);
const blockTargets: Record<ErpBlock, string> = {
  erp: "/acesso", "erp-fiscal": "/historico-fiscal", "erp-cobranca": "/cobranca-empresa", "erp-pdv": "/frente-caixa-empresa",
};
const accessChecks = new Map<symbol, (target: string) => boolean>();
export function installErpTargetAccess(check: (target: string) => boolean) {
  const owner = Symbol("erp-target-access");
  accessChecks.set(owner, check);
  return () => { accessChecks.delete(owner); };
}
export const blockEnabled = (block: ErpBlock) => erpPartEnabled("sistema", legacyModules(), blockTargets[block]);
export const targetEnabled = (target: string) => {
  const known = portedTarget(target);
  const url = portedUrl(target);
  return !!known && !hiddenInWabotia(target) &&
    !!url && erpPartEnabled(known.part, legacyModules(), target) && !pendingInMotor(url.pathname + url.search) &&
    ([...accessChecks.values()].at(-1)?.(target) ?? (!enabled || !known.readPermission));
};
