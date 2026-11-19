/** Fachada da mesma composição usada pelo main histórico e por configurações locais. */
import Worker from "../index";
export { C2_EXTENSIONS, installC2Worker } from "./install";

// Mesma classe, sem subclassificação nem nova migração de Durable Object.
export { Coordinator } from "../index";
export const { fetch, scheduled, email } = Worker;
export default Worker;
