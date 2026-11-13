// Entrada do painel (web/DESIGN.md §9): marca do app, cartão central e botão
// principal em largura total. Cria o primeiro administrador quando a
// instalação ainda não foi iniciada.
import React, { useEffect, useState } from "react";
import { ArrowRight, Eye, EyeOff } from "lucide-react";
import { api, type Row } from "../lib/api";
import { Button, Field, Logo, Notice } from "../ui";

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
  useEffect(() => {
    api("auth/status")
      .then((status) => {
        setSetup(!status.initialized);
        setConfigured(status.configured);
      })
      .catch((e) => setError(e.message));
  }, []);
  return (
    <div className="auth-page">
      <Logo light size={40} />
      <main className="auth-card">
        <h1>{setup ? "Crie sua conta de administrador" : "Entrar no Wabotia"}</h1>
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
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            try {
              if (setup) await api("auth/setup", "POST", form);
              await api("auth/login", "POST", form);
              await ready();
            } catch (e: any) {
              setError(e.message);
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
          {error && <Notice tone="error">{error}</Notice>}
          <Button type="submit" busy={busy} full size="lg">
            {setup ? "Criar conta e entrar" : "Entrar"}
            {!busy && <ArrowRight size={17} />}
          </Button>
        </form>
      </main>
      <nav className="auth-links" aria-label="Ajuda">
        <a href="/install">Precisa de ajuda para instalar?</a>
        <a href="/app?demo=1">Ver telas de demonstração</a>
        <a href="/">Página inicial</a>
      </nav>
    </div>
  );
}
