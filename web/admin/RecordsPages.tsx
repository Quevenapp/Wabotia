// Relatórios e registros: relatórios com exportação, execuções de bots,
// entregas, eventos para sistemas, avaliações e consentimentos.
import React, { useState } from "react";
import { Download } from "lucide-react";
import { useApp } from "../app/AppContext";
import { useAction } from "../app/hooks";
import type { Row } from "../lib/api";
import { Button, Field, Notice, SkeletonBlock, Table, toast } from "../ui";
import { WhatsAppGroups } from "../WhatsAppGroups";
import { navigate } from "../lib/routes";
import { usageText } from "../lib/usage";
import { FormDialog, Pager, useList } from "./shared";
import { channelLabel, conversationChannels, isMultichannel } from "../channels";
import { ChannelReviewsPage, channelReviewsAvailable } from "../channel-extensions";

const reportSections: [string, string][] = [
  ["tickets", "Protocolos"],
  ["conversations", "Conversas"],
  ["deliveries", "Entregas"],
  ["surveys", "Avaliações"],
  ["consents", "Consentimentos"],
  ["runs", "Execuções dos bots"],
];

export function ReportsPage() {
  const app = useApp();
  const [selected, setSelected] = useState<"service" | "google">("service");
  const available = channelReviewsAvailable(app.status);
  return <>
    {available && <nav aria-label="Origem do relatório">
      <Button secondary={selected !== "service"} onClick={() => setSelected("service")}>Atendimento</Button>
      <Button secondary={selected !== "google"} onClick={() => setSelected("google")}>Google</Button>
    </nav>}
    {available && selected === "google"
      ? <ChannelReviewsPage api={app.api} root={app.root} status={app.status} now={app.now} mode="report" />
      : <ConversationReportsPage />}
  </>;
}

function ConversationReportsPage() {
  const app = useApp();
  const [section, setSection] = useState("tickets");
  const [selectedChannel, setChannel] = useState("");
  const channels = conversationChannels(app.status);
  const channel = channels.length > 1 && channels.includes(selectedChannel as any) ? selectedChannel : "";
  const reportPath = app.root + "/reports?section=" + section + (channel ? "&channel=" + encodeURIComponent(channel) : "");
  const list = useList(reportPath);
  const { busy, run } = useAction();
  return (
    <>
      <section className="card">
        <div className="toolbar">
          <Field
            label="Seção do relatório"
            value={section}
            onChange={setSection}
            emptyOption={null}
            options={reportSections}
          />
          {channels.length > 1 && <Field label="Canal" value={channel} onChange={setChannel}
            emptyOption={null} options={[["", "Todos os canais"], ...channels.map((id): [string, string] => [id, channelLabel(id)])]} />}
          <Button
            secondary
            busy={busy}
            icon={<Download size={16} />}
            onClick={() =>
              run(
                async () => {
                  const response = await fetch(
                    "/api/" + reportPath + "&format=jsonl",
                    { credentials: "same-origin" },
                  );
                  if (!response.ok)
                    throw new Error("Não foi possível exportar.");
                  const blob = await response.blob();
                  const link = document.createElement("a");
                  link.href = URL.createObjectURL(blob);
                  link.download = "wabotia-" + section + ".jsonl";
                  link.click();
                  URL.revokeObjectURL(link.href);
                },
                { success: "Exportação concluída." },
              )
            }
          >
            Exportar JSONL
          </Button>
        </div>
        {list.error && (
          <Notice tone="error" onRetry={() => void list.reload()}>
            {list.error}
          </Notice>
        )}
        {!list.loaded && !list.error ? (
          <SkeletonBlock height={160} />
        ) : (
          <Table
            rows={list.rows}
            columns={[
              ...(section === "tickets"
                ? [
                    ["number", "Protocolo"],
                    ["title", "Solicitação"],
                    ["status", "Estado"],
                    ["created", "Data"],
                  ]
                : [
                    ["id", "Identificador"],
                    ["status", "Estado"],
                    ["created", "Data"],
                  ]) as [string, string][],
              ...(isMultichannel(app.status) ? [["channel", "Canal", (row: Row) => channelLabel(row.channel)] as [string, string, (row: Row) => React.ReactNode]] : []),
            ]}
          />
        )}
        <p className="muted">
          {list.raw?.count || 0} registros nesta consulta.
        </p>
      </section>
      <Pager {...list} />
    </>
  );
}

type Reconcile =
  | { kind: "delivery"; id: string; paid_template: boolean }
  | null;

/** Execuções de bots, entregas de mensagens e eventos para sistemas. */
export function LogsPage({
  page,
}: {
  page: "bot-runs" | "deliveries" | "webhook-deliveries";
}) {
  const app = useApp();
  const { api, root } = app;
  // A lista de execuções traz só as do próprio usuário, a menos que o
  // administrador peça todas.
  const list = useList(
    root + "/" + page + (page === "bot-runs" ? "?all=1" : ""),
  );
  const { busy, run } = useAction();
  const [reconcile, setReconcile] = useState<Reconcile>(null);
  const [form, setForm] = useState<Row>({});
  const act = (path: string) =>
    run(() => api(root + path, "POST", {}), {
      success: "Salvo com sucesso.",
    }).then(list.reload);
  return (
    <>
      <section className="card">
        <p>
          Consulte o resultado antes de repetir uma operação sem confirmação.
          Webhooks mantêm o mesmo ID de evento nos reenvios.
        </p>
        {list.error && (
          <Notice tone="error" onRetry={() => void list.reload()}>
            {list.error}
          </Notice>
        )}
        {!list.loaded && !list.error ? (
          <SkeletonBlock height={160} />
        ) : (
          <Table
            rows={list.rows}
            columns={[
              ["id", "Identificador"],
              ["status", "Estado"],
              [
                page === "webhook-deliveries" ? "attempts" : "error",
                page === "webhook-deliveries" ? "Tentativas" : "Detalhes",
              ],
              // Tokens da execução (provedor de IA direto): para ver o custo
              // e se o cache de prompt está pegando. Sem valor em dinheiro:
              // o preço muda.
              ...(page === "bot-runs"
                ? ([["usage", "Tokens", (row: Row) => usageText(row.usage)]] as [
                    string,
                    string,
                    (row: Row) => React.ReactNode,
                  ][])
                : []),
              ["created", "Data"],
            ]}
            action={(row) => (
              <div className="card-actions">
                {page === "deliveries" &&
                  row.status === "pending" &&
                  row.dedupe?.startsWith("router:") &&
                  app.isAdmin && (
                    <Button
                      secondary
                      size="sm"
                      disabled={busy}
                      onClick={() => act(`/router/messages/${row.id}/cancel`)}
                    >
                      Cancelar envio na fila
                    </Button>
                  )}
                {page === "webhook-deliveries" && (
                  <Button
                    secondary
                    size="sm"
                    disabled={busy}
                    onClick={() => act(`/webhook-deliveries/${row.id}/retry`)}
                  >
                    Reenviar
                  </Button>
                )}
                {page === "bot-runs" &&
                  ["queued", "running", "starting"].includes(row.status) && (
                    <Button
                      secondary
                      size="sm"
                      disabled={busy}
                      onClick={() => act(`/bot-runs/${row.id}/cancel`)}
                    >
                      Cancelar
                    </Button>
                  )}
                {row.status === "unknown" &&
                  app.isAdmin &&
                  page === "deliveries" && (
                    <Button
                      secondary
                      size="sm"
                      onClick={() => {
                        setForm({ status: "cancelled", allow_paid: false });
                        setReconcile(
                          {
                                kind: "delivery",
                                id: row.id,
                                paid_template: row.kind === "template",
                              },
                        );
                      }}
                    >
                      Conferir resultado
                    </Button>
                  )}
                {row.result && (
                  <details>
                    <summary>Resultado</summary>
                    <pre className="code-block">{row.result}</pre>
                  </details>
                )}
              </div>
            )}
          />
        )}
      </section>
      <Pager {...list} />
      {reconcile?.kind === "delivery" && (
        <FormDialog
          title="Conferir entrega no canal"
          onClose={() => setReconcile(null)}
          onSubmit={async () => {
            await api(root + `/deliveries/${reconcile.id}/reconcile`, "POST", {
              status: form.status,
              allow_paid: form.allow_paid === true,
            });
            toast("Salvo com sucesso.");
            await list.reload();
            setReconcile(null);
          }}
        >
          <p>
            Confira a mensagem no canal. Uma nova tentativa pode duplicar uma
            mensagem que já chegou ao destinatário.
          </p>
          <Field
            label="Resultado conferido"
            value={form.status}
            onChange={(status) => setForm({ ...form, status })}
            emptyOption={null}
            options={[
              ["cancelled", "Cancelar entrega"],
              ["sent", "Confirmar que foi enviada"],
              ["pending", "Autorizar nova tentativa"],
            ]}
          />
          {reconcile.paid_template && form.status === "pending" && (
            <label className="check-line">
              <input
                type="checkbox"
                required
                checked={!!form.allow_paid}
                onChange={(event) =>
                  setForm({ ...form, allow_paid: event.target.checked })
                }
              />
              Autorizo a possível cobrança deste novo envio de modelo pela Meta.
            </label>
          )}
        </FormDialog>
      )}
    </>
  );
}

/** Avaliações e consentimentos: listas de consulta. */
export function SimpleListPage({ page }: { page: "surveys" | "consents" }) {
  const app = useApp();
  const [selected, setSelected] = useState<"service" | "google">("service");
  const available = page === "surveys" && channelReviewsAvailable(app.status);
  return <>
    {available && <nav aria-label="Origem das avaliações">
      <Button secondary={selected !== "service"} onClick={() => setSelected("service")}>Atendimento</Button>
      <Button secondary={selected !== "google"} onClick={() => setSelected("google")}>Google</Button>
    </nav>}
    {available && selected === "google"
      ? <ChannelReviewsPage api={app.api} root={app.root} status={app.status} now={app.now} mode="reviews" />
      : <ServiceRecordsListPage page={page} />}
  </>;
}

function ServiceRecordsListPage({ page }: { page: "surveys" | "consents" }) {
  const app = useApp();
  const list = useList(app.root + "/" + page);
  return (
    <>
      {list.error && (
        <Notice tone="error" onRetry={() => void list.reload()}>
          {list.error}
        </Notice>
      )}
      <section className="card">
        {!list.loaded && !list.error ? (
          <SkeletonBlock height={160} />
        ) : (
          <Table
            rows={list.rows}
            columns={
              page === "surveys"
                ? [
                    ["score", "Nota"],
                    ["comment", "Comentário"],
                    ["status", "Estado"],
                    ["created", "Data"],
                  ]
                : [
                    ["conversation_id", "Conversa"],
                    ["status", "Consentimento"],
                    ["created", "Data"],
                  ]
            }
          />
        )}
      </section>
      <Pager {...list} />
    </>
  );
}

/** Grupos WhatsApp: sincronizar, criar e administrar grupos das linhas. */
export function GroupsPage() {
  const app = useApp();
  const list = useList(app.root + "/groups");
  return (
    <>
      {list.error && (
        <Notice tone="error" onRetry={() => void list.reload()}>
          {list.error}
        </Notice>
      )}
      <WhatsAppGroups
        api={app.api}
        root={app.root}
        rows={list.rows}
        demo={app.demo}
        openConversation={(row) =>
          navigate({ area: "conversations", id: row.id })
        }
      />
      <Pager {...list} />
    </>
  );
}
