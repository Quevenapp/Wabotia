import { IntegrationError } from "./privacy";

export function checkDeadline(deadline = Infinity): void {
  if (Date.now() >= deadline) throw new IntegrationError("integration_unavailable", 503);
}
/** Inclui leitura do corpo e transportes que não respeitam AbortSignal. A
 * concessão protege confirmações tardias; o mesmo comando recupera o recibo. */
export async function withinDeadline<T>(deadline: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  checkDeadline(deadline);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([run(controller.signal), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new IntegrationError("integration_unavailable", 503)); }, Math.max(0, deadline - Date.now()));
    })]);
  } finally { clearTimeout(timer); }
}
