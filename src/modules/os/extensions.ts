// Descritores internos, sem registro por efeito colateral nos filhos.
import type {
  ModuleContext,
  onCommand,
  onConversationTurn,
  onMcpTool,
  onRead,
  BinaryReadHandler,
  BinaryUploadHandler,
} from "../api";
import type { ModuleWriteRoute } from "../hooks";

export interface DueBudget {
  readonly remaining: number;
  /** Consumir ANTES de executar SQL; lote conta cada instrução. */
  consume(instructions: number): void;
}
export interface DueRequest {
  now: number;
  budget: DueBudget;
  limit: number;
}
export interface DueResult {
  processed: number;
  has_more: boolean;
}
export interface OsExtension {
  id: "tasks" | "people" | "documents" | "entries" | "objects" | "field-rules";
  reads: Array<{ path: string; handler: Parameters<typeof onRead>[2] }>;
  writes: ModuleWriteRoute[];
  commands: Array<{ op: string; handler: Parameters<typeof onCommand>[2] }>;
  binaryReads?: Array<{ path: string; handler: BinaryReadHandler }>;
  binaryUploads?: Array<{ path: string; handler: BinaryUploadHandler }>;
  tools?: Array<Parameters<typeof onMcpTool>[1]>;
  /** Executado só quando o turno legado não tratou a mensagem. */
  onConversationTurn?: Parameters<typeof onConversationTurn>[1];
  runDue?: (ctx: ModuleContext, request: DueRequest) => Promise<DueResult>;
}
export const OS_EXTENSION_SQL_BUDGET = 200;
export const OS_EXTENSION_ITEM_LIMIT = 10;

// REGISTRO RESERVADO F0/I — acrescentar imports e entradas SOMENTE aqui.
// T/P/D/L exportam OsExtension de seus diretórios; não chamam onSchedule("os").
import { tasksExtension } from "./tasks/extension";
import { peopleExtension } from "./people/extension";
import { documentsExtension } from "./documents/extension";
import { entriesExtension } from "./entries/extension";
export const osExtensions: readonly OsExtension[] = [
  tasksExtension,
  peopleExtension,
  documentsExtension,
  entriesExtension,
];
