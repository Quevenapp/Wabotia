import { ErpError } from "../engine/errors.ts";
import type { CommercialNfeSlots } from "./contracts.ts";
import type { CommercialNfeHttpContext } from "./routes.ts";

export const com1NotReady = (): never => { throw new ErpError("0A000", "com1_not_ready"); };
const defaults: CommercialNfeSlots = Object.freeze({
  prepare: com1NotReady, read: com1NotReady, list: com1NotReady,
  claim: com1NotReady, record: com1NotReady, cancelClaim: com1NotReady,
  cancelRecord: com1NotReady, recordCancellationXml: com1NotReady,
  applyEffects: com1NotReady, reverseEffects: com1NotReady,
});
let current: CommercialNfeSlots = defaults;
export const commercialNfeSlots = (): CommercialNfeSlots => current;
/** Instalar só no teste ou na integração final; sempre restaurar ao terminar. */
export function installCommercialNfeSlots(implementation: Partial<CommercialNfeSlots>): () => void {
  const previous = current;
  current = Object.freeze({ ...current, ...implementation });
  return () => { current = previous; };
}
export type CommercialNfeHttpHandler = (context: CommercialNfeHttpContext) => Promise<Response>;
let http: CommercialNfeHttpHandler = async () => com1NotReady();
export const commercialNfeHttp = (): CommercialNfeHttpHandler => http;
/** A instalação não habilita nenhum slot do motor implicitamente. */
export function installCommercialNfeHttp(handler: CommercialNfeHttpHandler): () => void {
  const previous = http;
  http = handler;
  return () => { http = previous; };
}
