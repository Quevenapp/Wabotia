// Chaves do ERP em Gestão → Módulos (PLANO-FAGOO.md, itens 16 e 17): `erp`,
// e os opcionais `erp-fiscal`, `erp-cobranca` e `erp-pdv`. Desligados de
// fábrica: enquanto o servidor não declarar um desses ids (GET /status, campo
// modules), ele conta como desligado. Os outros módulos do painel seguem a
// regra antiga (desconhecido = ligado, web/workspace-navigation.ts).
//
// Desenvolvimento: `localStorage.setItem("wabotia:erp-dev", "1")` liga todos os
// ids que o servidor não informa (só em `npm run web`; o build ignora). A
// demonstração declara os seus (web/lib/demo.ts).

export const ERP_MODULES = [
  "erp",
  "erp-fiscal",
  "erp-cobranca",
  "erp-pdv",
] as const;
export type ErpModule = (typeof ERP_MODULES)[number];

function devOverride() {
  if (!import.meta.env.DEV) return false;
  try {
    return localStorage.getItem("wabotia:erp-dev") === "1";
  } catch {
    return false;
  }
}

/** Ligado só quando o servidor diz que está ligado (ou a chave de desenvolvimento). */
export function erpModuleOn(
  modules: Record<string, boolean> | undefined,
  id: ErpModule,
) {
  const declared = modules?.[id];
  return declared === undefined ? devOverride() : declared === true;
}
