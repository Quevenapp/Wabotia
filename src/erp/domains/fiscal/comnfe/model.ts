/** Modelo fiscal da operação em curso: 55 (NF-e do pedido) ou 65 (NFC-e do
 * balcão). A máquina é uma só; o modelo escolhe as tabelas irmãs, o tipo do
 * documento no cofre e o modelo da chave de acesso. O escopo é estritamente
 * síncrono (como runWithCom1Authority): nunca envolver I/O ou Promise.
 */
import { one, type SqlDriver } from "../../../engine/driver.ts";

export type Com1Model = "nfe" | "nfce";
export interface Com1Tables {
  settings: string; emission: string; revision: string; command: string;
  cancel: string; effect: string; audit: string;
}
const tables = (prefix: string): Com1Tables => Object.freeze({
  settings: "erp_fiscal_vault__commercial_settings", emission: `${prefix}emission`, revision: `${prefix}revision`,
  command: `${prefix}command`, cancel: `${prefix}cancel`, effect: `${prefix}effect`, audit: `${prefix}audit`,
});
export const COM1_MODEL_TABLES: Readonly<Record<Com1Model, Com1Tables>> = Object.freeze({
  nfe: tables("erp_fiscal_vault__order_"), nfce: tables("erp_fiscal_vault__counter_"),
});
/** Natureza do cupom (só o modelo 65). */
export const NFCE_SETTINGS_TABLE = "erp_fiscal_vault__counter_settings";
/** Código do modelo na chave de acesso (posições 21-22). */
export const COM1_MODEL_CODE: Readonly<Record<Com1Model, string>> = Object.freeze({ nfe: "55", nfce: "65" });

let current: Com1Model = "nfe";
export const com1Model = (): Com1Model => current;
export const com1Tables = (): Com1Tables => COM1_MODEL_TABLES[current];

export function withCom1Model<T>(model: Com1Model, run: () => T): T {
  const previous = current;
  current = model;
  try { return run(); } finally { current = previous; }
}

/** Em qual família está a emissão; null quando não existe em nenhuma. */
export function modelOfEmission(db: SqlDriver, emissionId: unknown): Com1Model | null {
  if (typeof emissionId !== "string") return null;
  for (const model of ["nfce", "nfe"] as const)
    if (one(db, `SELECT 1 FROM ${COM1_MODEL_TABLES[model].emission} WHERE id=?`, emissionId)) return model;
  return null;
}
/** Comando durável de qualquer família (capacidade de evidência). */
export function modelOfCommand(db: SqlDriver, commandId: unknown): Com1Model | null {
  if (typeof commandId !== "string") return null;
  for (const model of ["nfce", "nfe"] as const)
    if (one(db, `SELECT 1 FROM ${COM1_MODEL_TABLES[model].command} WHERE id=?`, commandId)) return model;
  return null;
}
/** Executa no modelo da emissão (a NF-e quando ainda não existe: o erro sai igual). */
export const withEmissionModel = <T>(db: SqlDriver, emissionId: unknown, run: () => T): T =>
  withCom1Model(modelOfEmission(db, emissionId) ?? "nfe", run);
