/** Conta real do Bling: prova de conta e escopos.
 *
 * Prova de conta: depois da troca do código OAuth, o token de acesso identifica
 * a empresa. Um GET em /empresas/me/dados-basicos (API v3, leitura) devolve o
 * id e o nome da empresa; o id vira o vínculo gravado no controle (auth-store)
 * e toda autorização seguinte precisa devolver a mesma empresa
 * (BLING_ACCOUNT_MISMATCH). Uma chamada, sem repetição, com prazo, sem
 * redirecionamento; o token nunca vai a log, erro ou banco.
 *
 * Escopos: no Bling, as permissões são marcadas no cadastro do aplicativo
 * (Central de Extensões → Minhas instalações → o aplicativo → Escopos); a tela
 * de autorização não aceita escolher escopos pelo endereço. O token devolve os
 * escopos concedidos como identificadores opacos, que ficam gravados para
 * consulta. A lista abaixo diz, conforme os interruptores ligados, quais
 * permissões marcar no aplicativo: leitura para a coleta, escrita só para o
 * que vai de volta ao Bling. Falta de permissão volta como 403 e vira
 * pendência "falta permissão", nunca dado parcial. */
import { BlingError, type BlingContext, type BlingPublicAccount } from "./contracts.ts";
import type { BlingAccountProof } from "./oauth.ts";
import type { BlingPrivateCredential } from "./ports.ts";

export const BLING_API_BASE = "https://api.bling.com.br/Api/v3";
/** Domínio reservado do simulador (testes). */
const TEST_BASE = "https://bling.invalid/Api/v3";
export const BLING_ACCOUNT_PATH = "/empresas/me/dados-basicos";
export const BLING_ACCOUNT_EVIDENCE = Object.freeze({
  url: "https://developer.bling.com.br/referencia#/Empresas/get_empresas_me_dados_basicos",
  checked_at: "2026-11-21T12:00:00.000Z",
  read_only: true as const,
});
/** Escopo como o token devolve: identificador opaco, sem espaço nem controle. */
export const isBlingGrantedScope = (scope: string) => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(scope);

export interface BlingAccountProofOptions {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  baseUrl?: string;
  /** Prazo da chamada (ms). */
  timeoutMs?: number;
}
const text = (value: unknown, max: number): string | null => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return clean ? clean.slice(0, max) : null;
};

/** Lê id e nome da empresa no corpo de /empresas/me/dados-basicos. */
export function blingAccountOf(body: unknown, now: number): BlingPublicAccount {
  const data = body && typeof body === "object" ? (body as Record<string, unknown>).data : null;
  const record = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : null;
  const cnpj = text(record?.cnpj, 40)?.replace(/\D/g, "") || null;
  const id = text(record?.id, 128) ?? (cnpj && cnpj.length === 14 ? `cnpj-${cnpj}` : null);
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id)) throw new BlingError("BLING_RESPONSE_INVALID");
  return { id, name: text(record?.nome, 300) ?? text(record?.razaoSocial, 300), confirmed_at: new Date(now).toISOString() };
}

/** Prova de conta da produção: uma leitura dos dados básicos da empresa. */
export function createBlingAccountProof(options: BlingAccountProofOptions): BlingAccountProof {
  const base = options.baseUrl ?? BLING_API_BASE;
  if (base !== BLING_API_BASE && base !== TEST_BASE) throw new BlingError("BLING_RESPONSE_INVALID");
  return {
    evidence: { ...BLING_ACCOUNT_EVIDENCE },
    async identify(ctx: BlingContext, credential: BlingPrivateCredential) {
      const token = credential?.access_token;
      if (typeof token !== "string" || !token || /\s/.test(token) || token.length > 16384) throw new BlingError("BLING_AUTH_REQUIRED");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1, options.timeoutMs ?? 3000));
      try {
        const response = await options.fetch(base + BLING_ACCOUNT_PATH, { method: "GET", redirect: "manual", signal: controller.signal,
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "enable-jwt": "1" } });
        if (response.status === 401) throw new BlingError("BLING_AUTH_REQUIRED");
        if (response.status === 403) throw new BlingError("BLING_SCOPE_REQUIRED");
        if (response.status === 429) throw new BlingError("BLING_RATE_WAIT", { retry_at: ctx.clock.now() + 60_000 });
        if (response.status !== 200) throw new BlingError("BLING_RETRY_WAIT", { retry_at: ctx.clock.now() + 60_000 });
        const raw = await response.text();
        if (raw.length > 65536) throw new BlingError("BLING_RESPONSE_INVALID");
        let body: unknown;
        try { body = JSON.parse(raw); } catch { throw new BlingError("BLING_RESPONSE_INVALID"); }
        return blingAccountOf(body, ctx.clock.now());
      } catch (error) {
        if (error instanceof BlingError) throw error;
        throw new BlingError("BLING_RETRY_WAIT", { retry_at: ctx.clock.now() + 60_000 });
      } finally { clearTimeout(timer); }
    },
  };
}

/** Permissões a marcar no aplicativo do Bling, conforme o que está ligado. */
export interface BlingScopeSwitches {
  /** Entidades escolhidas para receber (coleta). */
  read: readonly string[];
  /** Entidades com "Escrever no Bling" ligado (mão dupla). */
  write: readonly string[];
  /** Nota de volta ao Bling ligada. */
  invoice_back: boolean;
  /** Situação e rastreio de volta ao Bling ligados. */
  status_back: boolean;
}
const READ_NAMES: Record<string, string> = {
  contacts: "Contatos", products: "Produtos", sales_orders: "Pedidos de venda", sales_proposals: "Propostas comerciais", purchase_orders: "Pedidos de compra",
  receivables: "Contas a receber", payables: "Contas a pagar", nfe: "Notas fiscais (NF-e)", nfce: "Notas fiscais de consumidor (NFC-e)",
  payment_methods: "Formas de pagamento", sellers: "Vendedores", warehouses: "Depósitos", product_categories: "Categorias de produtos",
  financial_categories: "Categorias de receitas e despesas", ledger_accounts: "Contas contábeis", cash_entries: "Caixas e bancos", stock_balances: "Estoques",
  service_orders: "Ordens de serviço",
};
/** Lista em palavras: o que marcar como leitura e o que marcar como escrita. */
export function blingScopeChecklist(input: BlingScopeSwitches): { read: string[]; write: string[]; note: string } {
  const named = (keys: readonly string[]) => [...new Set(keys.map(key => READ_NAMES[key]).filter((v): v is string => !!v))];
  const read = named([...input.read, ...(input.invoice_back || input.status_back ? ["sales_orders"] : [])]);
  const write = named([...input.write, ...(input.invoice_back || input.status_back ? ["sales_orders"] : [])]);
  if (!read.includes("Empresa (dados básicos)")) read.unshift("Empresa (dados básicos)");
  return { read, write, note: "No Bling as permissões são marcadas no cadastro do aplicativo. Depois de mudar, autorize de novo aqui para valerem." };
}
