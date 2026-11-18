// Fechamento do recibo do /command no lote da escrita da operação
// (src/coordinator.ts, docs/LIMITES.md): a auditoria e a marca do recibo
// ("ref:<operação>:<id do recurso>") vão junto com a escrita, no mesmo lote
// (atômico). Assim, um reinício do objeto depois da resposta não perde a
// auditoria, e a repetição com a mesma chave sabe que a escrita aconteceu e
// reconstrói a resposta pelo recurso (src/queue.ts, queueReplay).
//
// Só as operações que sabem fazer isso (a emissão e a chamada da fila) usam;
// as outras fecham o recibo depois, como sempre.
import type { Env } from "./types";

const CONTEXT = Symbol.for("wabotia.commandClosing");

export interface CommandClosing {
  readonly operation: string;
  /**
   * A auditoria e a marca do recibo do recurso `id`, para o lote da escrita.
   * `guard`: condição SQL (com os argumentos) para só gravar se a escrita
   * pegou (a chamada que perde a corrida não audita nem marca).
   */
  statements(id: string, guard?: [string, any[]]): [string, any[]][];
  /** A operação confirma que o lote com estas instruções gravou. */
  committed(id: string): void;
  /** Recurso do lote que gravou (a marca "ref:" está no recibo). */
  readonly ref: string | null;
}

export function withCommandClosing(env: Env, closing: CommandClosing) {
  (env as any)[CONTEXT] = closing;
  return env;
}

/** O fechamento no lote, se o /command o ofereceu para esta operação. */
export function commandClosing(
  env: Env,
  operation: string,
): CommandClosing | null {
  const closing: CommandClosing | undefined = (env as any)[CONTEXT];
  return closing && closing.operation === operation ? closing : null;
}
