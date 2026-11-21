// Conexões: cadastro, diagnóstico e estado de cada conexão.
import React, { useState } from "react";
import { Bot, Plug, Plus } from "lucide-react";
import { useApp } from "../app/AppContext";
import { useAction } from "../app/hooks";
import type { Row } from "../lib/api";
import { date, parse } from "../lib/format";
import { linkProps, navigate } from "../lib/routes";
import {
  Badge,
  Button,
  Confirm,
  CopyButton,
  Empty,
  Notice,
  SkeletonBlock,
} from "../ui";
import { ConnectionDiagnostics } from "../ConnectionDiagnostics";
import { ConnectionDialog, connectionChannelPresentation } from "./ConnectionDialog";
import { SecretDialog, useList } from "./shared";
import { channelConnectionChoices, channelUiKey } from "../channel-extensions";

const aiProviderText: Row = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  deepseek: "DeepSeek",
  compatible: "API compatível com OpenAI",
};

const kindText = (kind: string) => ({ ai: "Bot por provedor de IA, sem servidor", telegram: "Telegram · canal removido", meta: "WhatsApp Meta · integração anterior", zernio: "WhatsApp pela Zernio", qr: "WhatsApp por QR" })[kind] || "Conexão retirada";

// Tipos de conexão que deixaram de existir: só podem ser excluídos.
const removedKinds = ["meta", "telegram", "hermes", "hermes-whatsapp"];
// Conexões de telefone: excluir remove a linha, não a conta no provedor.
const phoneKinds = ["meta", "zernio", "qr", "hermes-whatsapp"];
export const isPhoneConnection = (row: Row) =>
  phoneKinds.includes(row.kind) && connectionChannelPresentation(row).channel === "whatsapp";
const editableConnection = (row: Row) => !removedKinds.includes(row.kind) &&
  (row.kind === "ai" || connectionChannelPresentation(row).available);
export const connectionKindLabel = (row: Row) => {
  const channel = connectionChannelPresentation(row);
  return channel.social ? `${channel.label}${row.kind === "zernio" ? " pela Zernio" : ""}${row.account_label ? ` · ${row.account_label}` : ""}` : kindText(row.kind);
};

const zernioWebhook = (row: Row) =>
  location.origin +
  (parse(row.config).zernio_workspace_id
    ? "/webhooks/zernio-accounts/" + parse(row.config).zernio_workspace_id
    : "/webhooks/zernio/" + row.id);

/**
 * Conexões do Hermes pausadas pela atualização (migração
 * 0092_retira_hermes.sql): o Hermes saiu do Vinki. Lista o que foi pausado
 * e o que a equipe precisa fazer; cada cartão abaixo mantém o botão Excluir.
 */
export function RetiredHermes({
  rows,
  resources = [],
}: {
  rows: Row[];
  resources?: Row[];
}) {
  const retired = rows.filter((row) =>
    ["hermes", "hermes-whatsapp"].includes(row.kind),
  );
  if (!retired.length && !resources.length) return null;
  return (
    <Notice tone="warn">
      <strong>Hermes retirado.</strong> O Vinki passou a trabalhar só com bots
      internos (provedor de IA direto).
      {retired.length > 0 && (
        <p>
          A atualização pausou {retired.map((row) => row.name).join(", ")}. Os
          bots foram desligados e as chaves das aplicações ligadas a eles foram
          revogadas. Escolha um bot interno em Automação. O histórico das
          conversas continua.
        </p>
      )}
      {resources.length > 0 && (
        <>
          <p>
            Os recursos que o Vinki criou na sua conta Cloudflare não somem
            com a retirada. Revogue-os no painel da Cloudflare: aplicação
            Access, service token, túnel e registros DNS.
          </p>
          <ul>
            {resources.map((job, index) => (
              <li key={index}>
                <strong>
                  {job.admin_hostname} · {job.api_hostname}
                </strong>
                <ul>
                  {[
                    ["admin_app", "Aplicação Access (descoberta)"],
                    ["api_app", "Aplicação Access (API)"],
                    ["service_token", "Service token"],
                    ["policy", "Política Access"],
                    ["tunnel", "Túnel"],
                    ["admin_dns", "DNS administrativo"],
                    ["api_dns", "DNS da API"],
                  ].map(
                    ([key, label]) =>
                      job.resources?.[key] && (
                        <li key={key}>
                          {label}: {job.resources[key + "_name"]} ·{" "}
                          {job.resources[key]}
                        </li>
                      ),
                  )}
                </ul>
              </li>
            ))}
          </ul>
        </>
      )}
    </Notice>
  );
}

export function ConnectionsPage() {
  const app = useApp();
  const { api, root, demo } = app;
  const list = useList(root + "/connections");
  const { busy, run } = useAction();
  const [editing, setEditing] = useState<Row | null>(null),
    [secret, setSecret] = useState(""),
    [removing, setRemoving] = useState<Row | null>(null);
  const reload = async () => {
    await Promise.all([list.reload(), app.refresh().catch(() => {})]);
  };
  return (
    <>
      <div className="callout">
        <Plug size={22} />
        <div>
          <strong>Um lugar para cada conexão</strong>
          <p>
            Use bots internos com um provedor de IA direto, sem servidor. A equipe atende pelo painel e pelos aplicativos. A
            Integração Zernio e seus telefones ficam em{" "}
            <a {...linkProps({ area: "admin", page: "router" })}>
              Integração Zernio
            </a>
            .
          </p>
        </div>
      </div>
      <RetiredHermes rows={list.rows} resources={app.settings.retired_cloudflare || []} />
      <div className="toolbar">
        <p>
          O provedor de IA fornece a inteligência. Os canais trazem
          as conversas.
        </p>
        <Button
          onClick={() => setEditing({ kind: "ai" })}
          icon={<Plus size={17} />}
        >
          Nova conexão
        </Button>
      </div>
      {channelConnectionChoices({ ...app.status, connections: list.rows }).map(choice => (
        <Button key={choice.kind} secondary onClick={() => setEditing({ kind: choice.kind, channel: choice.channel })}>
          {choice.label}
        </Button>
      ))}
      {list.error && (
        <Notice tone="error" onRetry={() => void list.reload()}>
          {list.error}
        </Notice>
      )}
      {!list.loaded && !list.error && <SkeletonBlock height={220} />}
      <div className="cards-grid">
        {list.rows.map((row) => (
          <section className="card integration-card" key={row.id}>
            <div className="section-heading">
              <span className="integration-icon">
                {row.kind === "ai" ? <Bot /> : <Plug />}
              </span>
              {parse(row.config).remove_pending ? <span className="badge">Sendo removida</span> : <Badge value={row.status} />}
            </div>
            <h2>{row.name}</h2>
            {parse(row.config).qr && (
              <img
                className="qr-image"
                src={parse(row.config).qr}
                alt="Leia o código com o WhatsApp para conectar"
              />
            )}
            {editableConnection(row) && !parse(row.config).remove_pending && (
              <button
                type="button"
                className="text-link"
                onClick={() => setEditing({ ...row, ...parse(row.config) })}
              >
                Editar conexão
              </button>
            )}
            <p>{connectionKindLabel(row)}</p>
            {connectionChannelPresentation(row).social && !channelUiKey(row) && (
              <p className="notice">
                {connectionChannelPresentation(row).available
                  ? "Conta importada. Requer Inbox no plano da Zernio e permissões de mensagens. O cliente inicia a conversa; teste a conexão antes de ativar."
                  : "Este canal ainda não está disponível nesta etapa."}
              </p>
            )}
            {row.kind === "ai" && (
              <p>
                {aiProviderText[parse(row.config).provider] ||
                  parse(row.config).provider}{" "}
                · {parse(row.config).model}
                {parse(row.config).effort
                  ? ` · esforço ${({ low: "baixo", medium: "médio", high: "alto" } as Row)[parse(row.config).effort] || parse(row.config).effort}`
                  : ""}
                {parse(row.config).text_only !== false
                  ? " · apenas mensagens"
                  : ""}
              </p>
            )}
            <small>Último contato: {date(row.last_seen)}</small>
            {editableConnection(row) && !parse(row.config).remove_pending && (
              <ConnectionDiagnostics
                listsBots={row.kind === "ai"}
                demo={demo}
                disabled={busy}
                request={(action, signal) =>
                  api(
                    root + `/connections/${row.id}/${action}`,
                    "POST",
                    {},
                    signal,
                  )
                }
                refresh={reload}
                showBots={() => navigate({ area: "admin", page: "bots" })}
              >
                <Button
                  secondary
                  disabled={busy}
                  onClick={() =>
                    run(
                      () =>
                        api(root + `/connections/${row.id}/state`, "PUT", {
                          status: row.status === "active" ? "paused" : "active",
                        }),
                      { success: "Salvo com sucesso." },
                    ).then(reload)
                  }
                >
                  {row.status === "active" ? "Pausar" : "Ativar"}
                </Button>
              </ConnectionDiagnostics>
            )}
            {row.kind === "telegram" && (
              <p className="notice">
                O atendimento pelo Telegram foi removido. Esta conexão não é
                mais usada: exclua-a. A equipe atende pelo painel e pelos
                aplicativos.
              </p>
            )}
            {row.kind === "meta" && (
              <p className="notice">
                A integração direta com a Meta foi desativada. Resolva operações
                em andamento ou sem confirmação, exclua esta linha e importe o
                telefone já conectado na Zernio. O histórico é preservado.
              </p>
            )}
            {[
              "meta",
              "zernio",
              "qr",
              "hermes-whatsapp",
              "telegram",
              "telegram_bot",
              "email",
              "hermes",
              "ai",
            ].includes(row.kind) && (
              <Button
                secondary
                disabled={busy}
                onClick={() => {
                  if (!app.demoBlocked()) setRemoving(row);
                }}
              >
                {isPhoneConnection(row)
                  ? "Excluir telefone"
                  : "Excluir conexão"}
              </Button>
            )}
            {row.kind === "qr" && !parse(row.config).remove_pending && (
              <button
                type="button"
                className="text-link"
                onClick={() =>
                  run(
                    () =>
                      api(
                        root + `/connections/${row.id}/connector-token`,
                        "POST",
                        {},
                      ),
                    { success: "Salvo com sucesso.", retry: false },
                  ).then((result) => {
                    if (result?.token) setSecret(result.token);
                  })
                }
              >
                Gerar chave do conector
              </button>
            )}
            {row.kind === "zernio" && (
              <div className="resource-id">
                <span>Webhook Zernio</span>
                <code>{zernioWebhook(row)}</code>
                <CopyButton value={zernioWebhook(row)} />
              </div>
            )}
            <small className="resource-id">
              ID: {row.id} <CopyButton value={row.id} />
            </small>
          </section>
        ))}
      </div>
      {list.loaded && !list.rows.length && (
        <section className="card">
          <Empty
            icon={<Plug size={28} />}
            title="Conecte seu primeiro serviço"
            description="Comece por um provedor de IA. Depois configure o WhatsApp."
          />
        </section>
      )}
      {editing && (
        <ConnectionDialog
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={reload}
        />
      )}
      {secret && <SecretDialog token={secret} onClose={() => setSecret("")} />}
      {removing && isPhoneConnection(removing) && (
        <Confirm
          title={"Excluir o telefone " + removing.name + " do Vinki?"}
          confirmLabel="Excluir telefone"
          danger
          busy={busy}
          onClose={() => setRemoving(null)}
          onConfirm={() =>
            run(() => api(root + "/connections/" + removing.id, "DELETE", {}), {
              success: "Telefone excluído. Histórico preservado.",
            }).then(async () => {
              setRemoving(null);
              await reload();
            })
          }
        >
          <p>
            O histórico será preservado. A conta no provedor não será
            desconectada nem excluída. Mensagens e operações de grupo ainda na
            fila serão canceladas. Resolva envios em andamento, operações sem
            confirmação e ligações abertas antes de excluir.
          </p>
        </Confirm>
      )}
      {removing && !isPhoneConnection(removing) && (
        <Confirm
          title={"Excluir a conexão " + removing.name + " do Vinki?"}
          confirmLabel="Excluir conexão"
          danger
          busy={busy}
          onClose={() => setRemoving(null)}
          onConfirm={() =>
            run(() => api(root + "/connections/" + removing.id, "DELETE", {}), {
              success: "Conexão excluída. Histórico preservado.",
            }).then(async () => {
              setRemoving(null);
              await reload();
            })
          }
        >
          {connectionChannelPresentation(removing).social ? (
            <p>O vínculo local desta conta será removido. Conversas, mensagens, canal e conta de origem permanecem no histórico. As credenciais compartilhadas da integração e a conta no provedor são preservadas. Resolva envios em andamento ou sem confirmação antes de excluir.</p>
          ) : removing.kind === "telegram" ? (
            <p>A conexão Telegram não é mais usada e será removida.</p>
          ) : (
            <>
              <p>
                Os bots desta conexão deixam de existir no Vinki e a chave
                guardada é apagada. Conversas, mensagens e execuções anteriores
                continuam no histórico.{" "}
                A conta no provedor não é alterada.
              </p>
              <p>
                Pause a conexão antes. Se um bot dela for o Bot Atendente, um
                especialista, um item de menu ou o bot de uma linha, troque-o
                antes de excluir.
              </p>
            </>
          )}
        </Confirm>
      )}
    </>
  );
}
