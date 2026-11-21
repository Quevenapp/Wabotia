// Transporte de verdade até o provedor da maquininha (no Worker). Os testes
// nunca usam este arquivo: passam um provedor simulado como `TerminalHttp`.
// Nada do pedido (cabeçalhos, corpo, token) vai para log.
import { TerminalError, type TerminalHttp } from "./adapter.ts";

const TIMEOUT_MS = 15_000;

export function terminalTransport(): TerminalHttp {
  return async request => {
    if (!request.url.startsWith("https://")) throw new TerminalError("configuracao", "Endereço do provedor inválido.");
    const response = await fetch(request.url, {
      method: request.method, headers: request.headers, body: request.body, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "manual",
    });
    const text = await response.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { status: response.status, body };
  };
}
