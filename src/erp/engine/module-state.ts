/** Ativação efetiva lida pelo Worker na requisição, fora dos argumentos do RPC. */
export interface ErpModuleState {
  fiscal: boolean;
}

export const FISCAL_MODULE_HEADER = "x-erp-fiscal-enabled";

/** A fronteira HTTP sempre fornece um estado explícito; ausência nunca autoriza. */
export function requestModuleState(headers: Headers, internal: boolean): ErpModuleState {
  return { fiscal: internal && headers.get(FISCAL_MODULE_HEADER) === "1" };
}

/** Chamadas diretas do motor conservam o contrato legado, sem fronteira HTTP. */
export const fiscalModuleEnabled = (state?: ErpModuleState) => state === undefined || state.fiscal === true;
