// "Conectar serviço": Hermes, Telegram e os tipos de linha WhatsApp. Usado em
// Hermes e canais e pelo assistente de configuração.
import React, { useState } from "react";
import { useApp } from "../app/AppContext";
import type { Row } from "../lib/api";
import { Field, toast } from "../ui";
import { FormDialog } from "./shared";

const configKeys = [
  "url",
  "api_url",
  "account_id",
  "zernio_profile_id",
  "zernio_workspace_id",
  "group",
  "number",
  "platform",
];
const secretKeys = [
  "token",
  "api_key",
  "webhook_secret",
  "dashboard_token",
  "access_client_id",
  "access_client_secret",
];

export function ConnectionDialog({
  initial,
  onClose,
  onSaved,
}: {
  /** Conexão em edição (linha + config) ou apenas `{ kind }` para uma nova. */
  initial: Row;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const app = useApp();
  const [form, setForm] = useState<Row>(initial);
  const change = (key: string) => (value: any) =>
    setForm((current) => ({ ...current, [key]: value }));

  async function save() {
    const config: Row = {},
      secrets: Row = {};
    config.groups_enabled = !!form.groups_enabled;
    for (const key of configKeys) if (form[key]) config[key] = form[key];
    for (const key of secretKeys) if (form[key]) secrets[key] = form[key];
    if (form.profile_key)
      secrets.profile_keys = {
        [form.remote_profile || "default"]: form.profile_key,
      };
    if (form.profile_keys_json) {
      try {
        secrets.profile_keys = JSON.parse(form.profile_keys_json);
      } catch {
        throw new Error(
          "As chaves por atendimento precisam ser um objeto JSON válido.",
        );
      }
    }
    await app.api(app.root + "/connections", "POST", {
      id: form.id,
      name: form.name,
      kind: form.kind || "hermes",
      mode: form.kind === "hermes-whatsapp" ? "hermes" : "direct",
      config,
      secrets,
    });
    toast("Salvo com sucesso.");
    await onSaved();
    onClose();
  }

  return (
    <FormDialog title="Conectar serviço" onClose={onClose} onSubmit={save}>
      <Field label="Nome" value={form.name} onChange={change("name")} required />
      <Field
        label="Serviço"
        value={form.kind}
        onChange={change("kind")}
        options={[
          ["hermes", "Hermes"],
          ["zernio", "WhatsApp · Zernio"],
          ["qr", "WhatsApp · QR direto"],
          ["hermes-whatsapp", "WhatsApp · pelo Hermes"],
          ["telegram", "Telegram"],
        ]}
      />
      {["qr", "zernio", "hermes-whatsapp"].includes(form.kind) && (
        <Field
          label="Telefone com DDI (somente dígitos)"
          value={form.number}
          onChange={change("number")}
          placeholder="5511999999999"
          required
        />
      )}
      {form.kind === "hermes-whatsapp" && (
        <Field
          label="Canal configurado no Hermes"
          value={form.platform}
          onChange={change("platform")}
          options={[
            ["whatsapp", "QR Hermes"],
            ["whatsapp_cloud", "Meta Hermes"],
          ]}
          required
        />
      )}
      {form.kind === "hermes" && (
        <>
          <Field
            label="URL do backend administrativo Hermes"
            value={form.url}
            onChange={change("url")}
            placeholder="https://hermes.seudominio.com"
          />
          <Field
            label="URL da API de bots Hermes"
            value={form.api_url}
            onChange={change("api_url")}
            placeholder="https://api-hermes.seudominio.com"
          />
          <Field
            label="Token administrativo Hermes"
            type="password"
            value={form.dashboard_token}
            onChange={change("dashboard_token")}
            autoComplete="off"
          />
          <Field
            label="Nome do atendimento no Hermes"
            value={form.remote_profile}
            onChange={change("remote_profile")}
            placeholder="default"
          />
          <Field
            label="API_SERVER_KEY desse atendimento"
            type="password"
            value={form.profile_key}
            onChange={change("profile_key")}
            autoComplete="off"
          />
          <details>
            <summary>Chaves de vários atendimentos Hermes</summary>
            <p>
              Informe um objeto JSON com nome do atendimento e chave. Deixe
              vazio para manter as chaves já cadastradas.
            </p>
            <Field
              label="Chaves por atendimento (JSON)"
              type="textarea"
              value={form.profile_keys_json}
              onChange={change("profile_keys_json")}
            />
          </details>
          <details>
            <summary>Conexão protegida por Cloudflare Access</summary>
            <Field
              label="Client ID"
              value={form.access_client_id}
              onChange={change("access_client_id")}
            />
            <Field
              label="Client Secret"
              type="password"
              value={form.access_client_secret}
              onChange={change("access_client_secret")}
              autoComplete="off"
            />
          </details>
        </>
      )}
      {form.kind === "telegram" && (
        <Field
          label="Token do serviço"
          type="password"
          value={form.token}
          onChange={change("token")}
          autoComplete="off"
        />
      )}
      {form.kind === "zernio" && (
        <>
          <p>
            Este cadastro usa um telefone já conectado na Zernio. Para
            encontrar e importar seus telefones, use Integração Zernio no menu
            WhatsApp e canais.
          </p>
          {[
            ["account_id", "ID do telefone na Zernio"],
            ["zernio_profile_id", "ID da integração na Zernio"],
            ["api_key", "API key da Zernio"],
            ["webhook_secret", "Segredo de assinatura do webhook Zernio"],
          ]
            .filter(
              ([key]) =>
                !form.zernio_workspace_id ||
                !["api_key", "webhook_secret"].includes(key),
            )
            .map(([key, label]) => (
              <Field
                key={key}
                label={label}
                type={
                  key === "api_key" || key === "webhook_secret"
                    ? "password"
                    : "text"
                }
                value={form[key]}
                onChange={change(key)}
                autoComplete="off"
                required={
                  !form.id || key === "account_id" || key === "zernio_profile_id"
                }
              />
            ))}
          {form.zernio_workspace_id && (
            <p>
              As credenciais deste telefone são gerenciadas em Integração
              Zernio. Pause a linha antes de editar sua configuração.
            </p>
          )}
          <label className="check-line">
            <input
              type="checkbox"
              checked={!!form.groups_enabled}
              onChange={(event) =>
                change("groups_enabled")(event.target.checked)
              }
            />
            Este número tem grupos empresariais habilitados na Zernio, sem
            coexistência com o aplicativo
          </label>
          <p>
            Após salvar, cadastre a URL exibida nos webhooks da Zernio e teste
            a conexão.
          </p>
        </>
      )}
      {form.kind === "telegram" && (
        <Field
          label="ID do grupo privado com tópicos"
          value={form.group}
          onChange={change("group")}
          placeholder="-100…"
        />
      )}
      {["qr", "hermes-whatsapp"].includes(form.kind) && (
        <p>
          Após salvar, gere uma chave do conector e siga o guia para iniciá-lo
          junto do Hermes.
        </p>
      )}
    </FormDialog>
  );
}
