// Segundo fator para confirmar operação sensível pelo bot. O contrato é o da
// sessão A em `feat/login-mfa` (src/mfa.ts): só pessoa (`kind: "user"`) com
// `aal === 2` passa; aplicação, chave e ator interno sem sessão nunca passam.
// A confirmação usa o `aal` da sessão de quem tocou em Confirmar.
// Na junção, troque este arquivo pelo import do núcleo: `requireFinancialAal`
// (exige aal2 só com a política da instalação `financial` ou `all`) ou
// `requireAal2` (sempre). Recomendado: `requireFinancialAal`.
import { ApiError, type Actor } from "../types";

export function requireAal2(actor: Actor) {
  if (actor.kind === "user" && !actor.via && (actor as any).aal === 2) return;
  throw new ApiError(
    403,
    "mfa_required",
    "Confirme com o código do aplicativo autenticador para continuar.",
  );
}
