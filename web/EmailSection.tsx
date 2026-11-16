// E-mail da instalação em Gestão → Sistema (src/email.ts, docs/EMAIL.md):
// Cloudflare Email Sending pela API, com o token guardado cifrado. Sem ele,
// "Esqueci a senha" fica só com o link do administrador.
import React, { useCallback, useEffect, useState } from "react";
import { Mail } from "lucide-react";
import { Button, Field, Notice } from "./ui";

type Api = (
  path: string,
  method?: string,
  body?: any,
  signal?: AbortSignal,
) => Promise<any>;
type EmailConfig = {
  configured: boolean;
  account_id: string;
  token_configured: boolean;
  from_address: string;
  from_name: string;
  log?: {
    id: string;
    purpose: string;
    to_masked: string;
    status: string;
    error_code: string | null;
    created: number;
  }[];
};

const purposeLabel: Record<string, string> = {
  test: "Teste",
  "account.forgot": "Esqueci a senha",
  "account.reset": "Link de nova senha",
  "account.invite": "Convite",
  "account.password_changed": "Alerta: senha trocada",
  "account.mfa_reset": "Alerta: segundo fator removido",
};
const statusLabel: Record<string, string> = {
  sent: "Enviado",
  queued: "Na fila",
  bounced: "Devolvido",
  failed: "Falhou",
  sending: "Enviando",
};

export function EmailSection({
  api,
  demo,
  accountId,
}: {
  api: Api;
  demo: boolean;
  /** Account ID da autorização Cloudflare, se já houver. */
  accountId?: string;
}) {
  const [config, setConfig] = useState<EmailConfig | null>(
    demo
      ? {
          configured: false,
          account_id: "",
          token_configured: false,
          from_address: "",
          from_name: "",
        }
      : null,
  );
  const [form, setForm] = useState({
    account_id: "",
    token: "",
    from_address: "",
    from_name: "",
  });
  const [busy, setBusy] = useState(""),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const fill = (result: EmailConfig) => {
    setConfig(result);
    setForm({
      account_id: result.account_id || accountId || "",
      token: "",
      from_address: result.from_address,
      from_name: result.from_name,
    });
  };
  const load = useCallback(async () => {
    if (demo) return;
    try {
      fill(await api("v1/system/email"));
    } catch (e: any) {
      setError(e.message || "Não foi possível consultar o e-mail.");
    }
  }, [api, demo]);
  useEffect(() => {
    void load();
  }, [load]);
  const run = async (label: string, task: () => Promise<string>) => {
    if (demo) {
      setError("Indisponível nas telas de demonstração.");
      return;
    }
    setBusy(label);
    setError("");
    setMessage("");
    try {
      setMessage(await task());
      await load();
    } catch (e: any) {
      setError(e.message || "Não foi possível concluir.");
    } finally {
      setBusy("");
    }
  };
  const set = (key: keyof typeof form) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }));
  return (
    <section className="card system-card">
      <div className="section-heading">
        <h2>
          <Mail size={22} /> E-mail
        </h2>
        <span className={"badge " + (config?.configured ? "active" : "paused")}>
          {config?.configured ? "Ligado" : "Desligado"}
        </span>
      </div>
      <p>
        Com o e-mail ligado, a equipe pode usar “Esqueci a senha” na entrada,
        convites e links de nova senha chegam por e-mail, e cada pessoa recebe
        um aviso quando a senha ou o segundo fator dela mudam. Sem e-mail, o
        administrador continua gerando os links em Pessoas e acessos.
      </p>
      <p>
        O envio usa o Cloudflare Email Sending, que exige o plano Workers Paid e
        um domínio com DNS na Cloudflare. O passo a passo está em{" "}
        <code>docs/EMAIL.md</code>.
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      {message && <Notice tone="ok">{message}</Notice>}
      {!config && !error ? (
        <p role="status">Carregando e-mail…</p>
      ) : (
        <form
          className="system-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run("save", async () => {
              await api(
                "v1/system/email/configure",
                "POST",
                {
                  account_id: form.account_id.trim(),
                  from_address: form.from_address.trim(),
                  from_name: form.from_name.trim(),
                  ...(form.token ? { token: form.token.trim() } : {}),
                },
                AbortSignal.timeout(20000),
              );
              return "E-mail salvo. Use “Enviar teste” para conferir.";
            });
          }}
        >
          <div className="system-grid">
            <Field
              label="Account ID da Cloudflare"
              value={form.account_id}
              onChange={set("account_id")}
              autoComplete="off"
              required
            />
            <Field
              label={
                config?.token_configured
                  ? "Token de API (configurado; vazio mantém)"
                  : "Token de API (permissão de envio de e-mail)"
              }
              type="password"
              value={form.token}
              onChange={set("token")}
              autoComplete="new-password"
              required={!config?.token_configured}
            />
            <Field
              label="Endereço do remetente"
              type="email"
              value={form.from_address}
              onChange={set("from_address")}
              autoComplete="off"
              required
            />
            <Field
              label="Nome do remetente"
              value={form.from_name}
              onChange={set("from_name")}
              autoComplete="off"
            />
          </div>
          <small>
            O remetente precisa ser do domínio cadastrado no Email Sending (por
            exemplo, nao-responda@suaempresa.com.br); o nome é opcional. O token
            é guardado criptografado e não volta a ser exibido. Os e-mails nunca
            levam links ou códigos no assunto.
          </small>
          <div className="card-actions">
            <Button type="submit" busy={busy === "save"} disabled={!!busy}>
              Salvar e-mail
            </Button>
            <Button
              type="button"
              variant="secondary"
              busy={busy === "test"}
              disabled={!!busy || !config?.configured}
              onClick={() =>
                void run("test", async () => {
                  const result = await api(
                    "v1/system/email/test",
                    "POST",
                    {},
                    AbortSignal.timeout(30000),
                  );
                  return result.status === "bounced"
                    ? `O provedor devolveu o teste para ${result.to}. Confira o endereço da sua conta.`
                    : `Teste enviado para ${result.to}. Confira a caixa de entrada e o spam.`;
                })
              }
            >
              Enviar teste
            </Button>
            {config?.configured && (
              <Button
                type="button"
                variant="danger"
                busy={busy === "remove"}
                disabled={!!busy}
                onClick={() =>
                  void run("remove", async () => {
                    await api("v1/system/email/configure", "POST", {
                      remove: true,
                    });
                    return "E-mail desligado. Os links continuam em Pessoas e acessos.";
                  })
                }
              >
                Desligar e-mail
              </Button>
            )}
          </div>
        </form>
      )}
      {!!config?.log?.length && (
        <details>
          <summary>Últimos envios</summary>
          <table className="table">
            <thead>
              <tr>
                <th>Quando</th>
                <th>Tipo</th>
                <th>Para</th>
                <th>Situação</th>
              </tr>
            </thead>
            <tbody>
              {config.log.map((row) => (
                <tr key={row.id}>
                  <td>{new Date(row.created).toLocaleString("pt-BR")}</td>
                  <td>{purposeLabel[row.purpose] || row.purpose}</td>
                  <td>{row.to_masked}</td>
                  <td>
                    {statusLabel[row.status] || row.status}
                    {row.error_code ? ` (${row.error_code})` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </section>
  );
}
