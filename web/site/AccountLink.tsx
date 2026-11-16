// Links de uso único na entrada do painel (docs/API.md, "Login e segundo
// fator"): criar a senha do convite, redefinir a senha pelo link do
// administrador e recuperar o administrador único com o código de instalação.
import React, { useEffect, useState } from "react";
import { api, type Row } from "../lib/api";
import { Button, Field, Notice } from "../ui";

/** Criar ou redefinir a senha pelo link (#invite= ou #reset=). */
export function AccountLinkForm({
  purpose,
  token,
  onDone,
}: {
  purpose: "reset" | "invite";
  token: string;
  onDone: (email: string, password: string) => void;
}) {
  const [info, setInfo] = useState<Row | null>(null),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api("auth/link-info", "POST", { token })
      .then(setInfo)
      .catch((e) => setError(e.message));
  }, [token]);
  if (!info)
    return error ? <Notice tone="error">{error}</Notice> : <p>Conferindo…</p>;
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError("");
        try {
          const done = await api(
            purpose === "invite" ? "auth/invite/accept" : "auth/reset",
            "POST",
            { token, password },
          );
          onDone(done.email, password);
        } catch (e: any) {
          setError(e.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <p>
        <strong>{info.name}</strong> · {info.email}
      </p>
      <Field
        label={purpose === "invite" ? "Crie sua senha" : "Nova senha"}
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        help="Pelo menos 12 caracteres."
        required
      />
      {error && <Notice tone="error">{error}</Notice>}
      <Button type="submit" busy={busy} full size="lg">
        {purpose === "invite"
          ? "Criar senha e entrar"
          : "Trocar senha e entrar"}
      </Button>
    </form>
  );
}

/**
 * Esqueceu a senha: o administrador gera um link em Pessoas e acessos. O
 * administrador único usa o código de instalação (SETUP_TOKEN), que também
 * tira o segundo fator.
 */
export function RecoverAdminForm({
  onDone,
}: {
  onDone: (email: string, password: string) => void;
}) {
  const [form, setForm] = useState<Row>({}),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError("");
        try {
          const done = await api("auth/recover-admin", "POST", form);
          onDone(done.email, form.password);
        } catch (e: any) {
          setError(e.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <p>
        Atendente: peça ao administrador um link para redefinir a senha, em
        Pessoas e acessos. Administrador único: use o código de instalação
        (SETUP_TOKEN), que está no arquivo de chaves da instalação. Isso troca a
        senha e tira o segundo fator.
      </p>
      <Field
        label="Código de instalação (SETUP_TOKEN)"
        type="password"
        value={form.setup_token}
        onChange={(setup_token) => setForm({ ...form, setup_token })}
        autoComplete="off"
        required
      />
      <Field
        label="Nova senha"
        type="password"
        value={form.password}
        onChange={(password) => setForm({ ...form, password })}
        autoComplete="new-password"
        help="Pelo menos 12 caracteres."
        required
      />
      {error && <Notice tone="error">{error}</Notice>}
      <Button type="submit" busy={busy} full>
        Recuperar acesso do administrador
      </Button>
    </form>
  );
}
