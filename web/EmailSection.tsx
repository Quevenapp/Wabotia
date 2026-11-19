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
  transcript_custom_enabled?: boolean;
  transcript_allowed_domains?: string[];
  log?: {
    id: string;
    purpose: string;
    to_masked: string;
    status: string;
    error_code: string | null;
    created: number;
    conversation_id?: string | null;
    user_id?: string | null;
  }[];
};

const purposeLabel: Record<string, string> = {
  test: "Teste",
  "account.forgot": "Esqueci a senha",
  "account.reset": "Link de nova senha",
  "account.invite": "Convite",
  "account.password_changed": "Alerta: senha trocada",
  "account.mfa_reset": "Alerta: segundo fator removido",
  "conversation.email": "Transcrição de conversa",
};
const statusLabel: Record<string, string> = {
  sent: "Enviado",
  queued: "Na fila",
  bounced: "Devolvido",
  failed: "Falhou",
  sending: "Enviando",
  unknown: "Resultado indeterminado",
};

export function TranscriptEmailSettings({ enabled, domains, onEnabled, onDomains }: {
  enabled: boolean;
  domains: string;
  onEnabled: (value: boolean) => void;
  onDomains: (value: string) => void;
}) {
  return (
    <fieldset>
      <legend>Transcrição de conversas</legend>
      <label className="check-field">
        <input type="checkbox" checked={enabled} onChange={(event) => onEnabled(event.target.checked)} />
        Permitir endereço digitado para envio de conversa
      </label>
      <Field label="Domínios permitidos para transcrições" value={domains} onChange={onDomains}
        placeholder="empresa.com.br, exemplo.com" autoComplete="off"
        help="Separe por vírgulas. Vazio não acrescenta restrição. Cada domínio deve corresponder exatamente ao endereço de destino." />
      <p className="muted">
        O envio exige a permissão “Enviar conversa por e-mail”. Endereços digitados vêm desligados
        e exigem confirmação. O envio ao contato exige confirmação e solicitação do cliente.
        O limite é de 10 envios por pessoa ou aplicação e 50 por área a cada 24 horas,
        separado dos avisos dos módulos.
      </p>
    </fieldset>
  );
}

export function EmailLog({ rows }: { rows: NonNullable<EmailConfig["log"]> }) {
  if (!rows.length) return null;
  const transcripts = rows.some((row) => row.purpose === "conversation.email");
  return (
    <details>
      <summary>Últimos envios</summary>
      {transcripts && <p>Resultado indeterminado: o envio pode ter ocorrido. A mesma solicitação não será reenviada automaticamente.</p>}
      <table className="table">
        <thead><tr>
          <th>Quando</th><th>Tipo</th><th>Para</th><th>Situação</th>
          {transcripts && <><th>Conversa</th><th>Solicitante</th></>}
        </tr></thead>
        <tbody>{rows.map((row) => (
          <tr key={row.id}>
            <td>{new Date(row.created).toLocaleString("pt-BR")}</td>
            <td>{purposeLabel[row.purpose] || row.purpose}</td>
            <td>{row.to_masked}</td>
            <td>
              {row.purpose === "conversation.email" && row.status === "sending"
                ? statusLabel.unknown : statusLabel[row.status] || row.status}
              {row.error_code ? ` (${row.error_code})` : ""}
            </td>
            {transcripts && <><td>{row.conversation_id || "—"}</td><td>{row.user_id || "—"}</td></>}
          </tr>
        ))}</tbody>
      </table>
    </details>
  );
}

export function EmailSection({
  api,
  demo,
}: {
  api: Api;
  demo: boolean;
  /** Account ID da autorização Cloudflare, se já houver. */
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
    transcript_custom_enabled: false,
    transcript_allowed_domains: "",
  });
  const [busy, setBusy] = useState(""),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const fill = (result: EmailConfig) => {
    setConfig(result);
    setForm({
      account_id: result.account_id || "",
      token: "",
      from_address: result.from_address,
      from_name: result.from_name,
      transcript_custom_enabled: result.transcript_custom_enabled === true,
      transcript_allowed_domains: (result.transcript_allowed_domains || []).join(", "),
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
                  transcript_custom_enabled: form.transcript_custom_enabled,
                  transcript_allowed_domains: form.transcript_allowed_domains.split(/[,;\s]+/).filter(Boolean),
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
          <TranscriptEmailSettings
            enabled={form.transcript_custom_enabled}
            domains={form.transcript_allowed_domains}
            onEnabled={(enabled) => setForm((current) => ({ ...current, transcript_custom_enabled: enabled }))}
            onDomains={set("transcript_allowed_domains")}
          />
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
      <EmailLog rows={config?.log || []} />
    </section>
  );
}
