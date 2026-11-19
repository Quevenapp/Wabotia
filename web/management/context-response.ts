/** Mesmo um prefetch já respondido perde seu corpo quando a autorização muda. */
export async function contextBoundResponse(response: Response, signal: AbortSignal): Promise<Response> {
  if (signal.aborted) throw new DOMException("Contexto alterado", "AbortError");
  if (!response.body) return response;
  const reader = response.body.getReader();
  let active = true, stop = () => {};
  const finish = () => { active = false; stop(); };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const abort = () => {
        if (!active) return;
        finish();
        controller.error(new DOMException("Contexto alterado", "AbortError"));
        void reader.cancel().catch(() => {});
      };
      signal.addEventListener("abort", abort, { once: true });
      stop = () => signal.removeEventListener("abort", abort);
    },
    async pull(controller) {
      try {
        if (signal.aborted) throw new DOMException("Contexto alterado", "AbortError");
        const next = await reader.read();
        if (signal.aborted) throw new DOMException("Contexto alterado", "AbortError");
        if (!active) return;
        if (next.done) { finish(); controller.close(); } else controller.enqueue(next.value);
      } catch (error) { if (active) { finish(); controller.error(error); } }
    },
    cancel() { finish(); return reader.cancel(); },
  });
  const guarded = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  // fetch-port descarta antecipações não utilizáveis e refaz /v1/me. Isso
  // também vale se o cache já recebeu os cabeçalhos antes da revogação.
  Object.defineProperty(guarded, "ok", { get: () => !signal.aborted && response.ok });
  return guarded;
}
