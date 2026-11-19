import type { Env } from "../types";
import { moduleEnabled } from "../modules/registry";

/** Única decisão de ativação do cadastro completo; reaproveita o cache da área. */
export function isFullCustomerEnabled(env: Env, profileId: string): Promise<boolean> {
  return moduleEnabled(env, profileId, "erp");
}
