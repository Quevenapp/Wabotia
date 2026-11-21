// "Confirme que é você" dentro do ERP: o código do aplicativo autenticador (ou
// um código de recuperação) confirma a sessão do Vinki (POST
// /api/v1/account/mfa/challenge, porta `challenge`). Usado quando a política
// de segundo fator do ERP pede (ERP_MFA_REQUIRED) e para mudar essa política.
// Quando a casca tiver o próprio pedido de código (origin/feat/login-mfa,
// MfaPrompt), esta tela pode passar a abri-lo.
import React, { useState, type FormEvent } from "react";
import { erpPorts } from "./ports";
import { ChallengeError, type ChallengeFailure } from "./session-port";

const MESSAGES: Record<ChallengeFailure, string> = {
  invalid_code:
    "Código errado ou já usado. Confira o aplicativo e tente de novo.",
  mfa_locked:
    "Muitas tentativas erradas. Aguarde 15 minutos antes de tentar de novo.",
  no_factor:
    "Você ainda não cadastrou o aplicativo autenticador. Cadastre em Minha conta, no menu com o seu nome no painel.",
  demo: "Na demonstração não há segundo fator para confirmar.",
  unavailable: "Não foi possível confirmar agora. Tente de novo em instantes.",
};

export function IdentityChallenge({
  intro,
  onConfirmed,
}: {
  intro: string;
  onConfirmed: () => void;
}) {
  const ports = erpPorts();
  const [recovery, setRecovery] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failure, setFailure] = useState<ChallengeFailure | null>(null);
  // Com a casca disponível, o pedido de código é o do painel (o mesmo de
  // qualquer 403 mfa_required, /api/v1/account/mfa/challenge); ao fechar, o
  // ERP confere de novo.
  const confirm = ports?.confirmIdentity;
  if (confirm)
    return (
      <div className="identity-challenge">
        <p>{intro}</p>
        <div className="real-editor-actions">
          <button
            type="button"
            className="primary-button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void confirm()
                .then(onConfirmed)
                .finally(() => setBusy(false));
            }}
          >
            Confirmar que é você
          </button>
        </div>
      </div>
    );
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !ports) return;
    const text = value.replace(/\s/g, "");
    if (!recovery && !/^\d{6}$/.test(text)) {
      setMessage("Digite os 6 números do aplicativo autenticador.");
      return;
    }
    if (recovery && !text) {
      setMessage("Digite um código de recuperação.");
      return;
    }
    setBusy(true);
    setMessage("");
    setFailure(null);
    try {
      await ports.challenge(
        recovery ? { recovery_code: text } : { code: text },
      );
      setValue("");
      onConfirmed();
    } catch (error) {
      // Pelo formato, não pela classe: a porta pode vir de outro pacote (testes, casca).
      const known = (error as Partial<ChallengeError> | null)?.reason;
      const reason: ChallengeFailure =
        known && Object.hasOwn(MESSAGES, known) ? known : "unavailable";
      setFailure(reason);
      setMessage(MESSAGES[reason]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="identity-challenge" onSubmit={submit} aria-busy={busy}>
      <p>{intro}</p>
      <div className="form-field">
        <label htmlFor="identity-code">
          {recovery ? "Código de recuperação" : "Código do aplicativo"}
        </label>
        <input
          id="identity-code"
          inputMode={recovery ? "text" : "numeric"}
          autoComplete="one-time-code"
          maxLength={recovery ? 40 : 7}
          value={value}
          disabled={busy}
          onChange={(event) => setValue(event.target.value)}
        />
      </div>
      {message && (
        <p className="real-alert" role="alert">
          {message}
        </p>
      )}
      <div className="real-editor-actions">
        <button type="submit" className="primary-button" disabled={busy}>
          {busy ? "Confirmando…" : "Confirmar"}
        </button>
        <button
          type="button"
          className="text-button"
          disabled={busy}
          onClick={() => {
            setRecovery(!recovery);
            setValue("");
            setMessage("");
          }}
        >
          {recovery
            ? "Usar o código do aplicativo"
            : "Usar um código de recuperação"}
        </button>
        {failure === "no_factor" && ports?.openAccount && (
          <button
            type="button"
            className="secondary-button"
            onClick={ports.openAccount}
          >
            Abrir Minha conta
          </button>
        )}
      </div>
    </form>
  );
}
