// Segundo fator no painel (docs/API.md, "Login e segundo fator"): o portão
// depois do login (confirmar com o código ou cadastrar o aplicativo
// autenticador, quando a política exige) e "Minha conta".
import React, { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { api, type Row } from "../lib/api";
import { Button, Dialog, Field, Logo, Notice, toast } from "../ui";

/** O que falta para usar o painel com esta sessão, ou null. */
export function mfaNeeded(me: Row | null) {
  if (!me || me.kind !== "user" || (me.aal ?? 1) >= 2) return null;
  if (me.mfa?.factor) return "challenge";
  if (me.mfa?.policy === "all") return "enroll";
  return null;
}

/** Códigos de recuperação: mostrados uma vez, com cópia. */
function RecoveryCodes({ codes }: { codes: string[] }) {
  return (
    <>
      <Notice tone="warn">
        Guarde estes códigos num lugar seguro. Cada um entra uma vez, se você
        perder o celular. Eles não aparecem de novo.
      </Notice>
      <pre className="secret-box" style={{ whiteSpace: "pre-wrap" }}>
        {codes.join("\n")}
      </pre>
      <Button
        secondary
        onClick={() =>
          void navigator.clipboard
            ?.writeText(codes.join("\n"))
            .then(() => toast("Códigos copiados."))
        }
      >
        Copiar códigos
      </Button>
    </>
  );
}

/**
 * Cadastro do aplicativo autenticador: senha → segredo (copiar para o app ou
 * abrir o link otpauth no celular) → primeiro código → códigos de recuperação.
 */
export function EnrollMfa({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState(""),
    [started, setStarted] = useState<Row | null>(null),
    [code, setCode] = useState(""),
    [codes, setCodes] = useState<string[] | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  if (codes)
    return (
      <>
        <RecoveryCodes codes={codes} />
        <Button full onClick={onDone}>
          Pronto, guardei os códigos
        </Button>
      </>
    );
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          if (!started) {
            setStarted(
              await api("v1/account/mfa/enroll", "POST", { password }),
            );
            return;
          }
          const done = await api("v1/account/mfa/verify", "POST", {
            factor_id: started.factor_id,
            code,
          });
          setCodes(done.recovery_codes);
        });
      }}
    >
      {!started ? (
        <Field
          label="Sua senha"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          help="Para cadastrar o aplicativo autenticador (Google Authenticator, Microsoft Authenticator, 1Password…)."
          required
        />
      ) : (
        <>
          <p>
            No aplicativo autenticador, adicione uma conta pela chave abaixo
            (tipo: baseada em tempo). No celular, o link abre o aplicativo
            direto.
          </p>
          <div className="secret-box">
            <code>{started.secret}</code>
          </div>
          <p>
            <a className="text-link" href={started.otpauth_url}>
              Abrir no aplicativo autenticador deste aparelho
            </a>
          </p>
          <Field
            label="Código de 6 dígitos"
            value={code}
            onChange={(v) => setCode(v.replace(/\D/g, "").slice(0, 6))}
            autoComplete="one-time-code"
            required
          />
        </>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      <Button type="submit" busy={busy} full>
        {started ? "Confirmar código" : "Continuar"}
      </Button>
    </form>
  );
}

/** Confirma a sessão com o código do aplicativo ou um de recuperação. */
export function ChallengeMfa({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState(""),
    [recovery, setRecovery] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError("");
        try {
          await api(
            "v1/account/mfa/challenge",
            "POST",
            recovery ? { recovery_code: code } : { code },
          );
          onDone();
        } catch (e: any) {
          setError(e.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field
        label={recovery ? "Código de recuperação" : "Código de 6 dígitos"}
        value={code}
        onChange={(v) =>
          setCode(recovery ? v : v.replace(/\D/g, "").slice(0, 6))
        }
        autoComplete="one-time-code"
        required
      />
      {error && <Notice tone="error">{error}</Notice>}
      <Button type="submit" busy={busy} full>
        Confirmar
      </Button>
      <button
        type="button"
        className="text-link"
        onClick={() => {
          setRecovery(!recovery);
          setCode("");
        }}
      >
        {recovery
          ? "Usar o aplicativo autenticador"
          : "Perdi o celular: usar um código de recuperação"}
      </button>
    </form>
  );
}

/** Tela inteira depois do login, quando o segundo fator falta. */
export function MfaGate({
  need,
  onDone,
  onLogout,
}: {
  need: "challenge" | "enroll";
  onDone: () => void;
  onLogout: () => void;
}) {
  return (
    <div className="auth-page">
      <Logo light size={40} />
      <main className="auth-card">
        <h1>
          {need === "challenge"
            ? "Confirme que é você"
            : "Cadastre o segundo fator"}
        </h1>
        <p>
          {need === "challenge"
            ? "Abra o aplicativo autenticador e digite o código desta conta."
            : "Esta instalação exige o código de um aplicativo autenticador para entrar."}
        </p>
        {need === "challenge" ? (
          <ChallengeMfa onDone={onDone} />
        ) : (
          <EnrollMfa onDone={onDone} />
        )}
      </main>
      <nav className="auth-links" aria-label="Sair">
        <button type="button" className="text-link" onClick={onLogout}>
          Sair
        </button>
      </nav>
    </div>
  );
}

/** Minha conta: segundo fator, códigos de recuperação e horário. */
export function AccountDialog({ onClose }: { onClose: () => void }) {
  const [account, setAccount] = useState<Row | null>(null),
    [mode, setMode] = useState<"" | "enroll" | "challenge">(""),
    [codes, setCodes] = useState<string[] | null>(null),
    [error, setError] = useState("");
  const load = () =>
    api("v1/account")
      .then(setAccount)
      .catch((e) => setError(e.message));
  useEffect(() => void load(), []);
  const active = (account?.mfa?.factors || []).find(
    (f: Row) => f.status === "active",
  );
  const aal2 = (account?.session?.aal ?? 1) >= 2;
  const act = async (task: () => Promise<void>) => {
    setError("");
    try {
      await task();
      await load();
    } catch (e: any) {
      if (e.code === "mfa_required") setMode("challenge");
      setError(e.message);
    }
  };
  return (
    <Dialog
      title="Minha conta"
      onClose={onClose}
      footer={<Button onClick={onClose}>Fechar</Button>}
    >
      {!account ? (
        error ? (
          <Notice tone="error">{error}</Notice>
        ) : (
          <p>Carregando…</p>
        )
      ) : mode === "enroll" ? (
        <EnrollMfa
          onDone={() => {
            setMode("");
            void load();
          }}
        />
      ) : mode === "challenge" ? (
        <ChallengeMfa
          onDone={() => {
            setMode("");
            setError("");
            void load();
          }}
        />
      ) : (
        <>
          <p>
            <strong>{account.name}</strong> · {account.email}
          </p>
          <h3>
            <ShieldCheck size={16} /> Segundo fator
          </h3>
          {active ? (
            <p>
              Aplicativo autenticador cadastrado. Restam{" "}
              {account.mfa.recovery_codes_left} códigos de recuperação.
            </p>
          ) : (
            <p>
              Nenhum. Com o segundo fator, entrar exige também o código do
              aplicativo autenticador.
              {account.mfa.policy !== "off" &&
                " Esta instalação exige o segundo fator para operações financeiras ou para todos."}
            </p>
          )}
          {codes && <RecoveryCodes codes={codes} />}
          {error && <Notice tone="error">{error}</Notice>}
          <div className="toolbar">
            {!active && (
              <Button onClick={() => setMode("enroll")}>
                Cadastrar aplicativo autenticador
              </Button>
            )}
            {active && !aal2 && (
              <Button onClick={() => setMode("challenge")}>
                Confirmar com o código
              </Button>
            )}
            {active && (
              <Button
                secondary
                onClick={() =>
                  void act(async () =>
                    setCodes(
                      (await api("v1/account/mfa/recovery-codes", "POST", {}))
                        .recovery_codes,
                    ),
                  )
                }
              >
                Gerar novos códigos de recuperação
              </Button>
            )}
            {active && account.mfa.policy !== "all" && (
              <Button
                variant="danger"
                onClick={() =>
                  void act(() =>
                    api(`v1/account/mfa/factors/${active.id}`, "DELETE"),
                  )
                }
              >
                Remover segundo fator
              </Button>
            )}
          </div>
          {account.schedule?.enabled && (
            <p>
              Horário de acesso:{" "}
              {account.schedule.windows
                .map(
                  (w: Row) =>
                    `${w.days.map((d: number) => "DSTQQSS"[d]).join("")} ${w.start}–${w.end}`,
                )
                .join("; ")}{" "}
              (horário de Brasília).
            </p>
          )}
        </>
      )}
    </Dialog>
  );
}
