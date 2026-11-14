// "Conectar serviço": Hermes, provedor de IA direto e os tipos de linha
// WhatsApp. Usado em Hermes e canais e pelo assistente de configuração.
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
  "transport",
];
const secretKeys = [
  "token",
  "api_key",
  "webhook_secret",
  "dashboard_token",
  "access_client_id",
  "access_client_secret",
];

const aiProviders: [string, string][] = [
  ["anthropic", "Anthropic (Claude)"],
  ["openai", "OpenAI"],
  ["deepseek", "DeepSeek"],
  ["compatible", "Outra API compatível com OpenAI"],
];
const anthropicModels: [string, string][] = [
  ["claude-opus-5-5", "Claude Opus 5.5 (mais capaz)"],
  ["claude-sonnet-5-5", "Claude Sonnet 5.5 (equilíbrio)"],
  ["claude-haiku-5-5", "Claude Haiku 5.5 (mais barato)"],
];

const effortHelp =
  "Quanto o modelo pensa antes de responder. Mais esforço deixa a resposta mais cuidadosa, mais lenta e mais cara.";
const anthropicEfforts: [string, string][] = [
  ["low", "Baixo (recomendado para conversa)"],
  ["medium", "Médio"],
  ["high", "Alto"],
];
const openaiEfforts: [string, string][] = [
  ["", "Padrão do modelo"],
  ["low", "Baixo"],
  ["medium", "Médio"],
  ["high", "Alto"],
];

/** Campos da conexão direta com um provedor de IA, sem Hermes. */
function AiFields({
  form,
  change,
}: {
  form: Row;
  change: (key: string) => (value: any) => void;
}) {
  const app = useApp();
  const provider = form.provider || "anthropic";
  const [models, setModels] = useState<string[] | null>(null),
    [loading, setLoading] = useState(false),
    [modelsError, setModelsError] = useState("");
  // Pergunta ao provedor quais modelos a conta tem. Usa a chave digitada ou,
  // na edição, a já cadastrada.
  async function fetchModels() {
    if (app.demoBlocked()) return;
    setLoading(true);
    setModelsError("");
    try {
      const result = await app.api(app.root + "/ai-models", "POST", {
        provider,
        base_url: provider === "compatible" ? form.base_url : undefined,
        api_key: form.api_key || undefined,
        connection_id: form.id || undefined,
      });
      setModels(result.data || []);
    } catch (error) {
      setModels(null);
      setModelsError(
        error instanceof Error
          ? error.message
          : "Não foi possível buscar os modelos.",
      );
    } finally {
      setLoading(false);
    }
  }
  const modelsButton = (
    <button
      type="button"
      className="text-link"
      disabled={loading || (!form.api_key && !form.id)}
      onClick={() => void fetchModels()}
    >
      {loading ? "Buscando modelos…" : "Buscar modelos da conta"}
    </button>
  );
  const modelsStatus = modelsError ? (
    <div className="connection-result error" role="alert">
      <p>{modelsError}</p>
    </div>
  ) : models ? (
    <small>
      {models.length
        ? `${models.length} ${models.length === 1 ? "modelo encontrado" : "modelos encontrados"}.`
        : "O provedor não listou modelos. Digite o nome do modelo."}
    </small>
  ) : null;
  return (
    <>
      <p>
        O Wabotia chama o provedor direto, sem VPS nem Hermes. O bot responde
        com base nas fontes, menus e protocolos desta área, mas não executa
        ações em outros sistemas, não gera arquivos e não pode ser especialista.
        O custo é cobrado pelo provedor, por uso.
      </p>
      <Field
        label="Provedor"
        value={provider}
        onChange={(value: string) => {
          change("provider")(value);
          change("model")("");
          change("effort")("");
          setModels(null);
          setModelsError("");
        }}
        options={aiProviders}
        disabled={!!form.id}
      />
      <Field
        label={form.id ? "Nova chave de API (opcional)" : "Chave de API"}
        type="password"
        value={form.api_key}
        onChange={change("api_key")}
        autoComplete="off"
        required={!form.id}
        help={
          form.id ? "Deixe vazio para manter a chave já cadastrada." : undefined
        }
      />
      {provider === "compatible" && (
        <Field
          label="URL da API"
          value={form.base_url}
          onChange={change("base_url")}
          placeholder="https://api.exemplo.com/v1"
          help="O endereço ao qual se acrescenta /chat/completions."
          required
        />
      )}
      {provider === "anthropic" ? (
        <>
          <Field
            label="Modelo"
            value={form.model || anthropicModels[0][0]}
            onChange={change("model")}
            emptyOption={null}
            options={
              models
                ? anthropicModels.filter(([id]) => models.includes(id))
                : anthropicModels
            }
          />
          {modelsButton}
          {modelsStatus}
        </>
      ) : (
        <label className="field">
          <span>Modelo</span>
          <input
            list="ai-provider-models"
            value={form.model ?? ""}
            onChange={(event) => change("model")(event.target.value)}
            placeholder={
              models?.length
                ? "Escolha da lista ou digite"
                : provider === "deepseek"
                  ? "deepseek-chat"
                  : "Nome do modelo"
            }
            required
            autoComplete="off"
          />
          <datalist id="ai-provider-models">
            {(models || []).map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
          {modelsButton}
          {modelsStatus || (
            <small>
              Busque os modelos da sua conta ou digite o nome exatamente como
              aparece no painel do provedor.
            </small>
          )}
        </label>
      )}
      {provider !== "deepseek" && (
        <Field
          label="Esforço de raciocínio"
          value={form.effort || (provider === "anthropic" ? "low" : "")}
          onChange={change("effort")}
          emptyOption={null}
          options={provider === "anthropic" ? anthropicEfforts : openaiEfforts}
          help={
            provider === "anthropic"
              ? effortHelp
              : `${effortHelp} Só modelos com raciocínio aceitam; o teste da conexão confere.`
          }
        />
      )}
      {provider === "compatible" && (
        <>
          <label className="check-line">
            <input
              type="checkbox"
              checked={!!form.vision}
              onChange={(event) => change("vision")(event.target.checked)}
            />
            O modelo entende imagens
          </label>
        </>
      )}
      <label className="check-line">
        <input
          type="checkbox"
          checked={form.text_only !== false}
          onChange={(event) => change("text_only")(event.target.checked)}
        />
        Apenas mensagens (não receber áudio e vídeo)
      </label>
      <p>
        {form.text_only !== false
          ? "Quem enviar áudio ou vídeo recebe um aviso pedindo para escrever, e a conversa continua com o bot."
          : "Áudio e vídeo vão para a equipe humana, porque o bot não os entende."}{" "}
        {provider === "deepseek" || (provider === "compatible" && !form.vision)
          ? "Imagens também vão para a equipe."
          : "Imagens são enviadas ao modelo."}
      </p>
      <p>
        Depois de salvar, use <strong>Testar conexão</strong>: o teste cria o
        bot com o nome desta conexão. Habilite-o em Atendente e especialistas.
      </p>
    </>
  );
}

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
  // Hermes novo começa pelo plugin, que dispensa túnel e chaves no Wabotia.
  const [form, setForm] = useState<Row>(
    initial.id ? initial : { transport: "link", ...initial },
  );
  const byPlugin = form.kind === "hermes" && form.transport === "link";
  const change = (key: string) => (value: any) =>
    setForm((current) => ({ ...current, [key]: value }));

  async function save() {
    if (form.kind === "ai") {
      // Provedor de IA direto: a chave só é enviada quando preenchida, para
      // a edição manter a já cadastrada.
      await app.api(app.root + "/connections", "POST", {
        id: form.id,
        name: form.name,
        kind: "ai",
        mode: "direct",
        config: {
          provider: form.provider || "anthropic",
          model:
            form.model ||
            ((form.provider || "anthropic") === "anthropic"
              ? anthropicModels[0][0]
              : ""),
          base_url: form.provider === "compatible" ? form.base_url : undefined,
          vision: form.provider === "compatible" ? !!form.vision : undefined,
          effort:
            form.provider === "deepseek"
              ? undefined
              : form.effort ||
                ((form.provider || "anthropic") === "anthropic"
                  ? "low"
                  : undefined),
          text_only: form.text_only !== false,
        },
        secrets: form.api_key ? { api_key: form.api_key } : {},
      });
      toast("Salvo com sucesso. Teste a conexão para criar o bot.");
      await onSaved();
      onClose();
      return;
    }
    const config: Row = {},
      secrets: Row = {};
    config.groups_enabled = !!form.groups_enabled;
    for (const key of configKeys) if (form[key]) config[key] = form[key];
    if (form.kind !== "hermes" || form.transport !== "link")
      delete config.transport;
    if (!byPlugin)
      for (const key of secretKeys) if (form[key]) secrets[key] = form[key];
    if (byPlugin) {
      delete config.url;
      delete config.api_url;
    } else if (form.profile_key)
      secrets.profile_keys = {
        [form.remote_profile || "default"]: form.profile_key,
      };
    if (!byPlugin && form.profile_keys_json) {
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
      <Field
        label="Nome"
        value={form.name}
        onChange={change("name")}
        required
      />
      <Field
        label="Serviço"
        value={form.kind}
        onChange={change("kind")}
        options={[
          ["hermes", "Hermes"],
          ["ai", "Provedor de IA (sem servidor)"],
          ["zernio", "WhatsApp · Zernio"],
          ["qr", "WhatsApp · QR direto"],
          ["hermes-whatsapp", "WhatsApp · pelo Hermes"],
        ]}
        disabled={!!form.id}
      />
      {form.kind === "ai" && <AiFields form={form} change={change} />}
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
      {form.kind === "hermes" && !form.id && (
        <Field
          label="Como ligar ao Hermes"
          value={form.transport || "url"}
          onChange={(value: string) =>
            change("transport")(value === "link" ? "link" : "")
          }
          options={[
            ["link", "Plugin no Hermes (recomendado, sem túnel)"],
            ["url", "URLs públicas com túnel Cloudflare"],
          ]}
        />
      )}
      {byPlugin && (
        <p>
          Nada mais a preencher. Depois de salvar, use{" "}
          <strong>Gerar comando de instalação</strong> no cartão da conexão e
          execute o comando na máquina onde o Hermes está. As chaves do Hermes
          ficam nessa máquina.
        </p>
      )}
      {form.kind === "hermes" && !byPlugin && (
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
      {form.kind === "zernio" && (
        <>
          <p>
            Este cadastro usa um telefone já conectado na Zernio. Para encontrar
            e importar seus telefones, use Integração Zernio no menu WhatsApp e
            canais.
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
                  !form.id ||
                  key === "account_id" ||
                  key === "zernio_profile_id"
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
            Após salvar, cadastre a URL exibida nos webhooks da Zernio e teste a
            conexão.
          </p>
        </>
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
