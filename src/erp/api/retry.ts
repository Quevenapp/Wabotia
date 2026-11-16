// Nova tentativa na chamada Worker → objeto erp: (stub de Durable Object),
// como recomenda a Cloudflare em "Durable Objects › Best practices › Error
// handling" (developers.cloudflare.com/durable-objects/best-practices/error-handling/):
// - só erro marcado `retryable` e não `overloaded` (objeto sobrecarregado não
//   se repete: piora a sobrecarga);
// - stub novo a cada tentativa (o que lançou pode ficar "quebrado"): quem
//   chama passa `attempt`, que pede o stub de novo (erpStub);
// - só pedido idempotente: leitura, ou RPC com p_command_id (o recibo do
//   comando devolve a mesma resposta sem aplicar de novo).
// Uma nova tentativa só (o runtime já repete por conta própria). Fora disso:
// ErpUnavailable (503). Cada nova tentativa sai no log, sem dados pessoais
// (só a rota e as marcas do erro), para medir a frequência em produção.

export interface StubErrorMarks {
  retryable?: boolean;
  overloaded?: boolean;
  remote?: boolean;
}

/** O objeto não respondeu (erro de stub): 503 para o cliente decidir. */
export class ErpUnavailable extends Error {
  readonly status = 503;
  readonly code = "erp_unavailable";
  readonly marks: StubErrorMarks;
  constructor(marks: StubErrorMarks) {
    super(marks.overloaded ? "O ERP está sobrecarregado. Tente de novo em instantes." : "O ERP não respondeu. Tente de novo em instantes.");
    this.marks = marks;
  }
}

const marksOf = (error: unknown): StubErrorMarks => {
  const e = (error ?? {}) as Record<string, unknown>;
  return { retryable: e.retryable === true, overloaded: e.overloaded === true, remote: e.remote === true };
};

export interface RetryOptions {
  /** Pedido idempotente (leitura ou comando com recibo). */
  idempotent: boolean;
  /** Rota sem dados (ex.: "/erp-rpc/erp_stock_post"), só para o log. */
  route: string;
  /** Espera antes da nova tentativa (padrão: 50–150 ms, com jitter). */
  wait?: () => Promise<void>;
  log?: (line: string) => void;
}

const defaultWait = () => new Promise<void>((resolve) => setTimeout(resolve, 50 + Math.random() * 100));

export async function withStubRetry(attempt: () => Promise<Response>, options: RetryOptions): Promise<Response> {
  try {
    return await attempt();
  } catch (error) {
    const marks = marksOf(error);
    if (!marks.retryable || marks.overloaded || !options.idempotent) throw new ErpUnavailable(marks);
    (options.log ?? console.warn)(JSON.stringify({ event: "erp_stub_retry", route: options.route, ...marks }));
    await (options.wait ?? defaultWait)();
    try {
      return await attempt();
    } catch (again) {
      throw new ErpUnavailable(marksOf(again));
    }
  }
}

/** Corpo de RPC da erp-api com p_command_id: idempotente pelo recibo do comando. */
export function rpcHasCommand(body: unknown): boolean {
  if (typeof body !== "string") return false;
  try {
    const args = JSON.parse(body);
    return typeof args?.p_command_id === "string" && args.p_command_id !== "";
  } catch {
    return false;
  }
}
