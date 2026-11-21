// Entrada do painel (web/DESIGN.md §9): marca do app, cartão central e botão
// principal em largura total. Cria o primeiro administrador quando a
// instalação ainda não foi iniciada.
import React, { useEffect, useState } from "react";
import { ArrowRight, Eye, EyeOff } from "lucide-react";
import { api, type Row } from "../lib/api";
import {
  accountTokenFromHash,
  setupTokenFromHash,
} from "../../src/install-links";
import { AccountLinkForm, ForgotForm, RecoverAdminForm } from "./AccountLink";
import { Button, Field, Logo, Notice } from "../ui";
import { SourceFooterLink } from "../ui/SourceLink";

function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  help,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  help?: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <label className="field">
      <span>{label}</span>
      <span className="password-field">
        <input
          type={visible ? "text" : "password"}
          value={value || ""}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          required
        />
        <button
          type="button"
          className="icon-button"
          aria-label={visible ? "Ocultar" : "Mostrar"}
          aria-pressed={visible}
          onClick={() => setVisible(!visible)}
        >
          {visible ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
      </span>
      {help && <small>{help}</small>}
    </label>
  );
}

export function Login({ ready }: { ready: () => void | Promise<void> }) {
  const [setup, setSetup] = useState(false),
    [configured, setConfigured] = useState(true),
    [form, setForm] = useState<Row>({}),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const change = (key: string) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));
  // Link de primeiro acesso do instalador: o código vem no fragmento da URL,
  // é guardado no formulário e sai da barra de endereço em seguida.
  const [linked, setLinked] = useState(false);
  // Segundo fator no login, link de convite ou de redefinição e recuperação
  // do administrador (web/site/AccountLink.tsx).
  const [needCode, setNeedCode] = useState(false),
    [recovery, setRecovery] = useState(false),
    [link, setLink] = useState(() => accountTokenFromHash(location.hash)),
    [recover, setRecover] = useState(false),
    // Esqueci a senha por e-mail, quando a instalação envia e-mail.
    [emailOn, setEmailOn] = useState(false),
    [adminRecover, setAdminRecover] = useState(false);
  const signIn = async (email: string, password: string) => {
    setLink(null);
    setRecover(false);
    setForm({ email, password });
    try {
      await api("auth/login", "POST", { email, password });
      await ready();
    } catch (e: any) {
      if (e.code === "mfa_required") setNeedCode(true);
      else setError(e.message);
    }
  };
  useEffect(() => {
    if (link)
      history.replaceState(null, "", location.pathname + location.search);
    const token = setupTokenFromHash(location.hash);
    if (!token) return;
    setForm((current) => ({ ...current, token }));
    setLinked(true);
    history.replaceState(null, "", location.pathname + location.search);
  }, []);
  // Link aberto com o painel já na tela de entrada (só o fragmento muda, sem
  // recarregar a página): lê o convite ou a redefinição do mesmo jeito.
  useEffect(() => {
    const changed = () => {
      const next = accountTokenFromHash(location.hash);
      if (!next) return;
      setLink(next);
      setRecover(false);
      setError("");
      history.replaceState(null, "", location.pathname + location.search);
    };
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  useEffect(() => {
    api("auth/status")
      .then((status) => {
        setSetup(!status.initialized);
        setConfigured(status.configured);
        setEmailOn(!!status.email);
      })
      .catch((e) => setError(e.message));
  }, []);
  return (
    <div className="auth-page">
      <Logo light size={40} />
      <main className="auth-card">
        <h1>
          {link?.purpose === "invite"
            ? "Crie sua senha"
            : link?.purpose === "reset"
              ? "Redefinir senha"
              : recover
                ? "Esqueci a senha"
                : setup
                  ? "Crie sua conta de administrador"
                  : "Entrar no Vinki"}
        </h1>
        <p>
          {setup
            ? "Esta etapa é feita somente uma vez, na sua instalação."
            : "Acompanhe suas conversas e sua equipe."}
        </p>
        {!configured && (
          <Notice tone="error">
            Configure MASTER_KEY e SETUP_TOKEN nos secrets do Worker antes de
            começar.
          </Notice>
        )}
        {link ? (
          <AccountLinkForm
            purpose={link.purpose}
            token={link.token}
            onDone={(email, password) => void signIn(email, password)}
          />
        ) : recover && emailOn && !adminRecover ? (
          <ForgotForm onAdmin={() => setAdminRecover(true)} />
        ) : recover ? (
          <RecoverAdminForm
            onDone={(email, password) => void signIn(email, password)}
          />
        ) : (
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              setError("");
              try {
                if (setup) await api("auth/setup", "POST", form);
                const { code, ...credentials } = form;
                await api(
                  "auth/login",
                  "POST",
                  needCode
                    ? {
                        ...credentials,
                        [recovery ? "recovery_code" : "totp"]: code,
                      }
                    : credentials,
                );
                await ready();
              } catch (e: any) {
                // Conta com segundo fator: pede o código e manda de novo.
                if (e.code === "mfa_required" && !needCode) setNeedCode(true);
                else setError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {setup && (
              <>
                <Field
                  label="Seu nome"
                  value={form.name}
                  onChange={change("name")}
                  autoComplete="name"
                  required
                />
                <PasswordField
                  label="Código de instalação (SETUP_TOKEN)"
                  value={form.token}
                  onChange={change("token")}
                  autoComplete="off"
                  help={
                    linked
                      ? "Preenchido pelo link do instalador."
                      : "O instalador mostra um link que preenche este campo. O código também está em chaves.local.json."
                  }
                />
              </>
            )}
            <Field
              label="E-mail"
              type="email"
              value={form.email}
              onChange={change("email")}
              autoComplete="username"
              required
            />
            <PasswordField
              label="Senha"
              value={form.password}
              onChange={change("password")}
              autoComplete={setup ? "new-password" : "current-password"}
              help={setup ? "Use pelo menos 12 caracteres." : undefined}
            />
            {needCode && (
              <>
                <Field
                  label={
                    recovery
                      ? "Código de recuperação"
                      : "Código de 6 dígitos do aplicativo autenticador"
                  }
                  value={form.code}
                  onChange={change("code")}
                  autoComplete="one-time-code"
                  required
                />
                <button
                  type="button"
                  className="text-link"
                  onClick={() => setRecovery(!recovery)}
                >
                  {recovery
                    ? "Usar o aplicativo autenticador"
                    : "Perdi o celular: usar um código de recuperação"}
                </button>
              </>
            )}
            {error && <Notice tone="error">{error}</Notice>}
            <Button type="submit" busy={busy} full size="lg">
              {setup ? "Criar conta e entrar" : "Entrar"}
              {!busy && <ArrowRight size={17} />}
            </Button>
          </form>
        )}
      </main>
      <nav className="auth-links" aria-label="Ajuda">
        {!setup && !link && (
          <button
            type="button"
            className="text-link"
            onClick={() => {
              setRecover(!recover);
              setAdminRecover(false);
              setError("");
            }}
          >
            {recover ? "Voltar para a entrada" : "Esqueci a senha"}
          </button>
        )}
        <a href="/install">Precisa de ajuda para instalar?</a>
        <a href="/app?demo=1">Ver telas de demonstração</a>
        <a href="/">Página inicial</a>
        <SourceFooterLink />
      </nav>
    </div>
  );
}
