// Sessão do ERP sobre a sessão do Wabotia (PLANO-FAGOO-PAINEL.md, B e C).
//
// O controlador do Fagoo espera um cliente de Auth do Supabase: getSession,
// onAuthStateChange, signInWithPassword e signOut. No Wabotia quem entra é o
// núcleo (web/site/Login.tsx); o ERP só recebe a pessoa já autenticada pelo
// cookie. O "token" entregue ao controlador é um marcador: fetch-port.ts tira
// o Authorization e o servidor confere o cookie em cada pedido.
import type { AuthPort } from "./app/lib/real-access";
import type { Factor, MfaPort } from "./app/lib/account-security";

type AuthResult = Awaited<ReturnType<AuthPort["getSession"]>>;
type Session = NonNullable<AuthResult["data"]["session"]>;
type Listener = (event: string, session: Session | null) => void;

export type SessionPort = AuthPort & {
  /** A sessão do Wabotia terminou (401): o ERP mostra "entre novamente". */
  expire(): void;
};

/**
 * @param actor pessoa do Wabotia (GET /api/v1/me); a API do ERP responde
 *   /v1/me com o mesmo id em user_id, senão o controlador encerra a sessão.
 * @param leave "Sair" do menu do ERP: volta para o painel (não encerra a
 *   sessão do Wabotia, que tem o próprio Sair).
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
// O MFA do núcleo ainda não existe (sessão A, feat/login-mfa). O contrato abaixo
// é o que a tela Minha conta › Segurança do Fagoo usa; o núcleo deve atender
// estas rotas. Até lá elas respondem 404 e a tela mostra "indisponível".
//   GET    /api/v1/account/mfa/factors          → { all: Factor[] }
//   POST   /api/v1/account/mfa/factors          { friendlyName } → { id, totp: { qr_code, secret, uri } }
//   POST   /api/v1/account/mfa/factors/:id/verify { code }
//   DELETE /api/v1/account/mfa/factors/:id
//   POST   /api/v1/account/password             { password, nonce? }
//   POST   /api/v1/account/reauthenticate

type Result<T> = {
  data: T;
  error: { message?: string; code?: string; status?: number } | null;
};

async function call<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<Result<T | null>> {
  try {
    const response = await fetch("/api/v1/account/" + path, {
      method,
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(method === "GET" ? {} : { "Idempotency-Key": crypto.randomUUID() }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data: any = await response.json().catch(() => null);
    if (!response.ok)
      return {
        data: null,
        error: {
          status: response.status,
          code: data?.error?.code,
          message: data?.error?.message,
        },
      };
    return { data: data as T, error: null };
  } catch {
    return { data: null, error: { status: 0, code: "network" } };
  }
}

/** MFA e senha sobre /api/v1/account (núcleo do Wabotia). */
export function createCoreMfaPort(): MfaPort {
  return {
    mfa: {
      listFactors: () => call<{ all: Factor[] }>("mfa/factors"),
      enroll: ({ friendlyName }) =>
        call<{
          id: string;
          totp: { qr_code: string; secret: string; uri: string };
        }>("mfa/factors", "POST", { friendlyName }),
      challengeAndVerify: ({ factorId, code }) =>
        call(`mfa/factors/${encodeURIComponent(factorId)}/verify`, "POST", {
          code,
        }),
      unenroll: ({ factorId }) =>
        call(`mfa/factors/${encodeURIComponent(factorId)}`, "DELETE"),
    },
    updateUser: (attributes) => call("password", "POST", attributes),
    reauthenticate: () => call("reauthenticate", "POST", {}),
  };
}

/**
 * Simulado em memória (desenvolvimento e demonstração): aceita qualquer código
 * de 6 dígitos. Nada sai do navegador; recarregar a página zera o estado.
 */
export function createSimulatedMfaPort(): MfaPort {
  let factors: Factor[] = [];
  const ok = <T>(data: T): Result<T> => ({ data, error: null });
  const qr =
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#fff"/><path d="M1 1h2v2H1zM5 1h2v2H5zM1 5h2v2H1zM4 4h1v1H4zM6 6h1v1H6z"/></svg>',
    );
  return {
    mfa: {
      listFactors: async () => ok({ all: factors }),
      enroll: async ({ friendlyName }) => {
        const id = crypto.randomUUID();
        factors = [
          ...factors,
          {
            id,
            factor_type: "totp",
            status: "unverified",
            friendly_name: friendlyName,
          },
        ];
        return ok({
          id,
          totp: {
            qr_code: qr,
            secret: "SIMULADO234567AB",
            uri: "otpauth://totp/Wabotia:simulado",
          },
        });
      },
      challengeAndVerify: async ({ factorId, code }) => {
        if (!/^\d{6}$/.test(code))
          return {
            data: null,
            error: { code: "mfa_verification_failed", status: 422 },
          };
        factors = factors.map((f) =>
          f.id === factorId ? { ...f, status: "verified" } : f,
        );
        return ok({});
      },
      unenroll: async ({ factorId }) => {
        factors = factors.filter((f) => f.id !== factorId);
        return ok({});
      },
    },
    updateUser: async () => ok({}),
    reauthenticate: async () => ok({}),
  };
}
