// Transporte de verdade até a API do banco (no Worker). Os testes nunca usam
// este arquivo: passam um banco simulado como `BankHttp`.
//
// Certificado (mTLS): o fetch do Worker não apresenta um certificado de
// cliente escolhido na hora. O certificado digitado fica guardado no cofre do
// núcleo e o dono da instalação o liga ao Worker uma vez, como um vínculo de
// certificado mTLS chamado BOLETO_MTLS_<BANCO> (docs/BOLETO-API.md). Sem o
// vínculo, o pedido que exige certificado nem sai, e a mensagem diz o que
// fazer. Nada do pedido (cabeçalhos, corpo, token) vai para log.
import type { Env } from "../../types";
import { BankError, type BankHttp } from "./adapter.ts";
import { BOLETO_BANK_INFO, type BoletoBank } from "./contract.ts";

const TIMEOUT_MS = 20_000;
export const mtlsBinding = (bank: BoletoBank) => `BOLETO_MTLS_${bank.toUpperCase()}`;

export function bankTransport(env: Env, bank: BoletoBank): BankHttp {
  return async request => {
    let fetcher: { fetch: typeof fetch } | null = null;
    if (request.mtls) {
      const binding = (env as unknown as Record<string, unknown>)[mtlsBinding(bank)] as { fetch?: typeof fetch } | undefined;
      if (!binding || typeof binding.fetch !== "function")
        throw new BankError("configuracao", `O ${BOLETO_BANK_INFO[bank].name} exige o certificado da API, e ele ainda não está ligado a esta instalação (${mtlsBinding(bank)}). O dono da instalação faz isso uma vez, como explicado em docs/BOLETO-API.md.`);
      fetcher = binding as { fetch: typeof fetch };
    }
    if (!request.url.startsWith("https://")) throw new BankError("configuracao", "Endereço do banco inválido.");
    const response = await (fetcher ? fetcher.fetch.bind(fetcher) : fetch)(request.url, {
      method: request.method, headers: request.headers, body: request.body, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "manual",
    });
    const text = await response.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { status: response.status, body };
  };
}
