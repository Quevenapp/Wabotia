// Segundo fator para confirmar operação sensível pelo bot. O login com MFA
// (sessão aal2) é da sessão A, em `feat/login-mfa`; até ele chegar, nenhuma
// sessão tem aal2 e toda operação sensível proposta pelo bot responde
// 403 mfa_required. Quando `requireAal2` existir no núcleo, este arquivo passa
// a reexportá-lo.
import { ApiError, type Actor } from "../types";

export function requireAal2(actor: Actor) {
  if ((actor as any).aal === "aal2") return;
  throw new ApiError(
    403,
    "mfa_required",
    "Esta operação pede o código do autenticador. Confirme o código e toque em Confirmar de novo.",
  );
}
