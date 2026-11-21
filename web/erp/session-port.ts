// Sessão do ERP sobre a sessão do Vinki (PLANO-FAGOO-PAINEL.md, B e C).
//
// O controlador do Fagoo espera um cliente de Auth do Supabase: getSession,
// onAuthStateChange, signInWithPassword e signOut. No Vinki quem entra é o
// núcleo (web/site/Login.tsx); o ERP só recebe a pessoa já autenticada pelo
// cookie. O "token" entregue ao controlador é um marcador: fetch-port.ts tira
// o Authorization e o servidor confere o cookie em cada pedido.
import type { AuthPort } from "./app/lib/real-access";

type AuthResult = Awaited<ReturnType<AuthPort["getSession"]>>;
type Session = NonNullable<AuthResult["data"]["session"]>;
type Listener = (event: string, session: Session | null) => void;

export type SessionPort = AuthPort & {
  /** A sessão do Vinki terminou (401): o ERP mostra "entre novamente". */
  expire(): void;
};

/**
 * @param actor pessoa do Vinki (GET /api/v1/me); a API do ERP responde
 *   /v1/me com o mesmo id em user_id, senão o controlador encerra a sessão.
 * @param leave "Sair" do menu do ERP: volta para o painel (não encerra a
 *   sessão do Vinki, que tem o próprio Sair).
 */
export function createSessionPort(
  actor: { id: string },
  leave: () => void,
): SessionPort {
  let session: Session | null = {
    access_token: "wabotia-cookie",
    user: { id: String(actor.id) },
  };
  const listeners = new Set<Listener>();
  const tell = (event: string) =>
    listeners.forEach((listener) => listener(event, session));
  return {
    async getSession() {
      return { data: { session }, error: null };
    },
    onAuthStateChange(callback) {
      listeners.add(callback);
      return {
        data: {
          subscription: { unsubscribe: () => listeners.delete(callback) },
        },
      };
    },
    // O login é do núcleo: o ERP nunca recebe senha.
    async signInWithPassword() {
      return { data: { session: null }, error: { code: "WABOTIA_LOGIN" } };
    },
    async signOut() {
      session = null;
      tell("SIGNED_OUT");
      leave();
      return { error: null };
    },
    expire() {
      if (!session) return;
      session = null;
      tell("SIGNED_OUT");
    },
  };
}

// --- segundo fator -----------------------------------------------------------
// O segundo fator é do núcleo (sessão A, origin/feat/login-mfa; contrato em
// sessao-A-login-mfa-contrato.md). O ERP só pede a confirmação da sessão quando
// a política do ERP exige (ERP_MFA_REQUIRED) ou para mudar essa política:
//   POST /api/v1/account/mfa/challenge  { code } | { recovery_code }
//   → 200; 401 invalid_code; 429 mfa_locked.
// Cadastrar ou remover o aplicativo e trocar a senha ficam em "Minha conta" do
// Vinki.

export type ChallengeInput = { code: string } | { recovery_code: string };
export type ChallengeFailure =
  "invalid_code" | "mfa_locked" | "no_factor" | "demo" | "unavailable";
export class ChallengeError extends Error {
  readonly reason: ChallengeFailure;
  constructor(reason: ChallengeFailure) {
    super(reason);
    this.reason = reason;
  }
}
export type ChallengePort = (input: ChallengeInput) => Promise<void>;

/** Confirmação na sessão do Vinki (aal2 por 7 dias contados do código). */
export function createChallengePort(
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): ChallengePort {
  return async (input) => {
    let response: Response;
    try {
      response = await fetchImpl("/api/v1/account/mfa/challenge", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify(input),
      });
    } catch {
      throw new ChallengeError("unavailable");
    }
    if (response.ok) return;
    const data: any = await response.json().catch(() => null);
    const code = data?.error?.code;
    throw new ChallengeError(
      code === "invalid_code" || response.status === 401
        ? "invalid_code"
        : code === "mfa_locked" || response.status === 429
          ? "mfa_locked"
          : code === "mfa_enroll_first" || code === "no_factor"
            ? "no_factor"
            : "unavailable",
    );
  };
}

/** Demonstração: não há segundo fator para confirmar. */
export const createSimulatedChallengePort = (): ChallengePort => async () => {
  throw new ChallengeError("demo");
};
