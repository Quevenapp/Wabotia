// Conectar provedor de IA ou linha WhatsApp, também pelo assistente.
import React, { useState } from "react";
import { useApp } from "../app/AppContext";
import type { Row } from "../lib/api";
import { Field, toast } from "../ui";
import { FormDialog } from "./shared";
import { CHANNEL_REGISTRY, isChannelId } from "../../src/channels";

/** Ausência de canal conserva apenas os transportes WhatsApp reconhecidos. */
export function connectionChannelPresentation(row: Row) {
  const channel = row.kind === "ai" ? null : row.channel ??
    (["zernio", "qr", "meta", "hermes-whatsapp"].includes(row.kind) ? "whatsapp" : null);
  const rules = isChannelId(channel) ? CHANNEL_REGISTRY[channel] : null;
  return {
    channel: rules?.id ?? null,
    label: rules?.label || "Canal desconhecido",
    social: channel != null && channel !== "whatsapp",
    available: channel === "whatsapp" ||
      (row.kind === "zernio" && ["instagram", "facebook"].includes(channel)),
    serviceLine: rules?.serviceLine === true && row.serviceLine !== false,
    rules,
  };
}

export function connectionFormConfiguration(form: Row) {
  const { social } = connectionChannelPresentation(form);
  const config: Row = {}, secrets: Row = {};
  if (!social) config.groups_enabled = !!form.groups_enabled;
  for (const key of configKeys)
    if (form[key] && (!social || !["number", "group"].includes(key))) config[key] = form[key];
  if (!social) for (const key of secretKeys) if (form[key]) secrets[key] = form[key];
  return { config, secrets };
}

export function SocialConnectionFields({ form }: { form: Row }) {
  const channel = connectionChannelPresentation(form);
  return <>
    <p><strong>{channel.label}{form.account_label ? ` · ${form.account_label}` : ""}</strong></p>
    {channel.available && form.id ? <>
      <p>Conta importada da Zernio. Canal, conta e integração são fixos; as credenciais são compartilhadas e gerenciadas em Integração Zernio.</p>
      <p>Requer acesso à caixa de entrada (Inbox) no plano da Zernio, conta conectada, permissões de mensagens e webhook configurado. Se aparecer inbox_required, habilite o Inbox no provedor e teste novamente.</p>
      <p>O cliente inicia a conversa. Bot e automações respondem até 24 horas após a mensagem do cliente. Até 7 dias, somente texto escrito por uma pessoa; mídia e automações não usam essa extensão.</p>
      <p>Depois de testar a conexão, configure bot, menu e horário em Linhas de atendimento. Requisitos do provedor: a conferir com a conta real.</p>
    </> : <p role="alert">{channel.available
      ? "Importe esta conta em Integração Zernio → Buscar contas na Zernio antes de editar a conexão."
      : "Este canal ainda não está disponível nesta etapa."}</p>}
  </>;
}

const configKeys = [
  "account_id",
  "zernio_profile_id",
  "zernio_workspace_id",
  "group",
  "number",
];
const secretKeys = [
  "api_key",
  "webhook_secret",
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
  "Quanto o modelo pensa antes de responder. Mais esforço deixa a resposta mais cuidadosa, mais lenta e mais cara. Nos níveis Muito alto e Máximo cada resposta pode levar até 3 minutos, e as conversas da área esperam na fila enquanto isso.";
const anthropicEfforts: [string, string][] = [
  ["low", "Baixo (recomendado para conversa)"],
  ["medium", "Médio"],
  ["high", "Alto"],
  ["xhigh", "Muito alto"],
  ["max", "Máximo"],
];
const deepseekEfforts: [string, string][] = [
  ["none", "Sem raciocínio (mais rápido e barato)"],
  ["low", "Baixo (recomendado para conversa)"],
  ["high", "Alto"],
  ["max", "Máximo"],
];
const openaiEfforts: [string, string][] = [
  ["", "Padrão do modelo"],
  ["none", "Sem raciocínio"],
  ["minimal", "Mínimo"],
  ["low", "Baixo"],
  ["medium", "Médio"],
  ["high", "Alto"],
  ["xhigh", "Muito alto"],
  ["max", "Máximo"],
];
// Compatible APIs pass the value through: any level the model accepts.
const compatibleEfforts: [string, string][] = openaiEfforts;

/** Esforço usado quando nada foi escolhido; vazio deixa o padrão do modelo. */
/** "O modelo entende PDF": ligada de fábrica na Anthropic, escolhida na OpenAI (src/ai-provider.ts). */
const pdfOn = (provider: string, value: unknown) =>
  provider === "anthropic" ? value !== false : provider === "openai" ? value === true : false;

const defaultEffort = (provider: string) =>
  provider === "anthropic" || provider === "deepseek" ? "low" : "";

/** Campos da conexão direta com um provedor de IA, sem servidor externo. */
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
        O Wabotia chama o provedor direto, sem servidor próprio. O bot responde
        com base nas fontes, menus e protocolos desta área, mas não executa
        ações em outros sistemas, não gera arquivos.
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
                  ? "deepseek-flash"
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
      <Field
        label="Esforço de raciocínio"
        value={form.effort || defaultEffort(provider)}
        onChange={change("effort")}
        emptyOption={null}
        options={
          provider === "anthropic"
            ? anthropicEfforts
            : provider === "deepseek"
              ? deepseekEfforts
              : provider === "compatible"
                ? compatibleEfforts
                : openaiEfforts
        }
        help={
          provider === "anthropic"
            ? effortHelp
            : provider === "deepseek"
              ? `${effortHelp} Estes são todos os níveis da DeepSeek: ela não tem Médio nem Muito alto.`
              : `${effortHelp} Cada modelo aceita só alguns níveis; o teste da conexão confere o escolhido.`
        }
      />
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
      {(provider === "anthropic" || provider === "openai") && (
        <>
          <label className="check-line">
            <input
              type="checkbox"
              checked={pdfOn(provider, form.pdf)}
              onChange={(event) => change("pdf")(event.target.checked)}
            />
            O modelo entende PDF
          </label>
          <p>
            {pdfOn(provider, form.pdf)
              ? "Nota fiscal ou comprovante em PDF (um por mensagem, até 4 MB e 10 páginas) vai ao modelo junto com a mensagem; PDF maior, com senha ou corrompido vai para a equipe. Nas mensagens seguintes o bot não tem mais o arquivo, só o que ele escreveu sobre ele."
              : "PDF enviado pelo cliente vai para a equipe."}
            {provider === "openai" && " Na OpenAI, só modelos com visão leem PDF."}
          </p>
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
        {provider === "compatible"
          ? "Ações pelo bot na conversa interna (consultar e propor ações em nome de quem pediu) dependem de a API aceitar ferramentas no formato da OpenAI. Se não aceitar, o bot avisa na conversa que não consegue consultar e responde só com o que sabe."
          : "Na conversa interna, este bot pode consultar e propor ações em nome de quem pediu, com o acesso dessa pessoa. As ações só acontecem depois que a pessoa toca em Confirmar."}
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
  const [form, setForm] = useState<Row>({ ...initial, kind: initial.kind || "ai" });
  const channel = connectionChannelPresentation(form);
  const change = (key: string) => (value: any) =>
    setForm((current) => ({ ...current, [key]: value }));

  async function save() {
    if (channel.social && (!channel.available || !form.id))
      throw new Error("Importe uma conta de Instagram ou Facebook pela integração Zernio.");
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
          pdf: pdfOn(form.provider || "anthropic", form.pdf),
          effort:
            form.effort ||
            defaultEffort(form.provider || "anthropic") ||
            undefined,
          text_only: form.text_only !== false,
        },
        secrets: form.api_key ? { api_key: form.api_key } : {},
      });
      toast("Salvo com sucesso. Teste a conexão para criar o bot.");
      await onSaved();
      onClose();
      return;
    }
    const { config, secrets } = connectionFormConfiguration(form);
    await app.api(app.root + "/connections", "POST", {
      id: form.id,
      name: form.name,
      kind: form.kind || "ai",
      ...(channel.social ? { channel: channel.channel } : {}),
      mode: "direct",
      config,
      secrets,
    });
    toast("Salvo com sucesso.");
    await onSaved();
    onClose();
  }

  return (
    <FormDialog title="Conectar serviço" onClose={onClose} onSubmit={save}
      disabled={channel.social && (!channel.available || !form.id)}>
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
          ["ai", "Provedor de IA (sem servidor)"],
          ["zernio", channel.social ? `${channel.label} · Zernio` : "WhatsApp · Zernio"],
          ["qr", "WhatsApp · QR direto"],
        ]}
        disabled={!!form.id}
      />
      {form.kind === "ai" && <AiFields form={form} change={change} />}
      {channel.social && <SocialConnectionFields form={form} />}
      {!channel.social && ["qr", "zernio"].includes(form.kind) && (
        <Field
          label="Telefone com DDI (somente dígitos)"
          value={form.number}
          onChange={change("number")}
          placeholder="5511999999999"
          required
        />
      )}
      {form.kind === "zernio" && !channel.social && (
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
      {form.kind === "qr" && !channel.social && (
        <p>
          Após salvar, gere uma chave do conector e siga o guia para iniciá-lo
          no seu servidor.
        </p>
      )}
    </FormDialog>
  );
}
