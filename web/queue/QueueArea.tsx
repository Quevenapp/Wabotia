// Fila de senhas da equipe (/app/fila): guichê, chamada e lista de espera.
// Contrato: docs/FILA-SENHAS.md.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Ban,
  Bell,
  CheckCircle2,
  Megaphone,
  Pause,
  Play,
  Plus,
  Power,
  Repeat2,
  Ticket,
  UserX,
  X,
} from "lucide-react";
import { useApp } from "../app/AppContext";
import { useAction, usePolling } from "../app/hooks";
import { linkProps } from "../lib/routes";
import type { Row } from "../lib/api";
import {
  Button,
  Confirm,
  Dialog,
  Empty,
  Field,
  Notice,
  Pill,
  SkeletonBlock,
  toast,
} from "../ui";
import { FormDialog } from "../admin/shared";
import { useQueueSocket } from "./live";
import "../styles/queue.css";

const COUNTER_KEY = "wabotia:queue-counter";
const readCounter = () => {
  try {
    return localStorage.getItem(COUNTER_KEY) || "";
  } catch {
    return "";
  }
};
const statusLabel: Row = {
  waiting: "Aguardando",
  called: "Chamada",
  serving: "Em atendimento",
  done: "Concluída",
  no_show: "Ausente",
  cancelled: "Cancelada",
};
const sourceLabel: Row = {
  whatsapp: "WhatsApp",
  kiosk: "Totem",
  staff: "Balcão",
};
const minutesSince = (at: number) =>
  Math.max(0, Math.round((Date.now() - at) / 60000));

export function TicketCode({
  ticket,
  size = "md",
}: {
  ticket: Row;
  size?: "md" | "lg";
}) {
  return (
    <span
      className={"queue-code " + size + (ticket.preferential ? " pref" : "")}
    >
      {ticket.code}
    </span>
  );
}

function TransferDialog({
  ticket,
  overview,
  onClose,
  onDone,
}: {
  ticket: Row;
  overview: Row;
  onClose: () => void;
  onDone: () => void;
}) {
  const app = useApp();
  const [target, setTarget] = useState("");
  const options = [
    ...overview.queues
      .filter((q: Row) => q.enabled)
      .map((q: Row) => ["q:" + q.id, `Fila ${q.name}`]),
    ...overview.counters.map((c: Row) => ["c:" + c.id, c.name]),
  ];
  return (
    <FormDialog
      title={`Transferir senha ${ticket.code}`}
      subtitle="A senha volta a aguardar no destino, mantendo a ordem de emissão."
      onClose={onClose}
      submitLabel="Transferir"
      disabled={!target}
      onSubmit={async () => {
        const [kind, id] = [target.slice(0, 1), target.slice(2)];
        await app.api(
          `${app.root}/queue/tickets/${ticket.id}/transfer`,
          "POST",
          {
            [kind === "q" ? "queue_id" : "counter_id"]: id,
          },
        );
        toast(`Senha ${ticket.code} transferida.`);
        onDone();
        onClose();
      }}
    >
      <Field
        label="Destino"
        value={target}
        onChange={setTarget}
        options={options}
        required
        help="Para um guichê, a senha será a próxima chamada nele."
      />
    </FormDialog>
  );
}

function IssueDialog({
  overview,
  onClose,
  onDone,
}: {
  overview: Row;
  onClose: () => void;
  onDone: () => void;
}) {
  const app = useApp();
  const queues = overview.queues.filter((q: Row) => q.enabled);
  const [form, setForm] = useState<Row>({
    queue_id: queues[0]?.id || "",
    type: "normal",
  });
  const [issued, setIssued] = useState<Row | null>(null);
  if (issued)
    return (
      <Dialog
        title="Senha emitida"
        onClose={onClose}
        size="sm"
        footer={<Button onClick={onClose}>Fechar</Button>}
      >
        <div className="queue-issued">
          <TicketCode ticket={issued} size="lg" />
          <p>
            {issued.queue_name} ·{" "}
            {issued.preferential ? "Preferencial" : "Normal"}
          </p>
          <p>
            {issued.ahead} à frente · espera estimada de {issued.wait_minutes}{" "}
            min
          </p>
        </div>
      </Dialog>
    );
  return (
    <FormDialog
      title="Emitir senha no balcão"
      onClose={onClose}
      submitLabel="Emitir"
      onSubmit={async () => {
        const ticket = await app.api(`${app.root}/queue/tickets`, "POST", {
          queue_id: form.queue_id,
          preferential: form.type === "preferential",
          source: "staff",
          phone: form.phone || undefined,
        });
        setIssued(ticket);
        onDone();
      }}
    >
      <Field
        label="Fila"
        value={form.queue_id}
        onChange={(queue_id) => setForm({ ...form, queue_id })}
        options={queues.map((q: Row) => [q.id, q.name])}
        emptyOption={null}
      />
      <Field
        label="Tipo"
        value={form.type}
        onChange={(type) => setForm({ ...form, type })}
        options={[
          ["normal", "Normal"],
          ["preferential", "Preferencial"],
        ]}
        emptyOption={null}
      />
      <Field
        label="WhatsApp do cliente (opcional)"
        value={form.phone}
        onChange={(phone) => setForm({ ...form, phone })}
        placeholder="5511999998888"
        help="Com o número, o cliente pode ser avisado pelo WhatsApp quando abrir conversa."
      />
    </FormDialog>
  );
}

export function QueueArea() {
  const app = useApp();
  const { busy, busyKey, run } = useAction();
  const [overview, setOverview] = useState<Row | null>(null),
    [tickets, setTickets] = useState<Row[]>([]),
    [error, setError] = useState(""),
    [counterId, setCounterId] = useState(readCounter),
    [transfer, setTransfer] = useState<Row | null>(null),
    [blocking, setBlocking] = useState<Row | null>(null),
    [issuing, setIssuing] = useState(false),
    [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    if (!app.profile) return;
    try {
      const [o, t] = await Promise.all([
        app.api(`${app.root}/queue`),
        app.api(`${app.root}/queue/tickets`),
      ]);
      setOverview(o);
      setTickets(t.data || []);
      setError("");
    } catch (e: any) {
      setError(e.message);
    }
  }, [app.api, app.root, app.profile]);

  const live = useQueueSocket(
    app.profile && !app.demo ? `/api/${app.root}/queue/ws` : null,
    (frame) => {
      if (frame.type === "snapshot") {
        setOverview(frame.data);
        void app
          .api(`${app.root}/queue/tickets`)
          .then((t: Row) => setTickets(t.data || []))
          .catch(() => {});
      }
    },
  );
  // Without the socket, poll; with it, a slow safety reload.
  usePolling(() => void load(), live ? 60000 : 5000, [load, live]);

  useEffect(() => {
    try {
      if (counterId) localStorage.setItem(COUNTER_KEY, counterId);
    } catch {
      /* preferência opcional */
    }
  }, [counterId]);

  const counter =
    overview?.counters.find((c: Row) => c.id === counterId) || null;
  const current: Row | null = counter?.current || null;
  const waiting = useMemo(
    () =>
      tickets.filter(
        (t) => t.status === "waiting" && (!filter || t.queue_id === filter),
      ),
    [tickets, filter],
  );
  const doneToday = tickets.filter((t) => t.status === "done").length;

  const act = (key: string, path: string, body: Row = {}, success?: string) =>
    run(() => app.api(`${app.root}/${path}`, "POST", body), {
      key,
      success,
    }).then((result) => {
      void load();
      return result;
    });

  if (!overview)
    return (
      <div className="area queue-area">
        {error ? (
          <Notice tone="error" onRetry={() => void load()}>
            {error}
          </Notice>
        ) : (
          <SkeletonBlock height={240} />
        )}
      </div>
    );

  if (!overview.queues.length)
    return (
      <div className="area queue-area">
        <Empty
          icon={<Ticket size={28} />}
          title="Nenhuma fila criada"
          description={
            app.isAdmin
              ? "Crie as filas e os guichês para começar a chamar senhas."
              : "Peça ao administrador para criar as filas e os guichês."
          }
          action={
            app.isAdmin ? (
              <a
                className="button"
                {...linkProps({ area: "admin", page: "queue-settings" })}
              >
                Configurar filas
              </a>
            ) : undefined
          }
        />
      </div>
    );

  return (
    <div className="area queue-area">
      <header className="queue-head">
        <div>
          <h1>Fila de senhas</h1>
          <p>
            {live ? (
              <Pill tone="ok">Ao vivo</Pill>
            ) : (
              <Pill tone="warn">Atualizando a cada 5 s</Pill>
            )}{" "}
            {doneToday} atendidas hoje
          </p>
        </div>
        <div className="queue-head-actions">
          <Button
            secondary
            icon={<Plus size={17} />}
            onClick={() => setIssuing(true)}
          >
            Emitir senha
          </Button>
        </div>
      </header>

      <section className="queue-stats" aria-label="Filas">
        {overview.queues
          .filter((q: Row) => q.enabled)
          .map((q: Row) => (
            <div className="queue-stat" key={q.id}>
              <strong>{q.name}</strong>
              <span>
                <b>{q.waiting.normal}</b> normal · ~{q.wait_minutes.normal} min
              </span>
              <span>
                <b>{q.waiting.preferential}</b> preferencial · ~
                {q.wait_minutes.preferential} min
              </span>
              <small>{q.open_counters} guichê(s) aberto(s)</small>
            </div>
          ))}
      </section>

      <div className="queue-grid">
        <section className="card queue-desk" aria-label="Meu guichê">
          <div className="queue-desk-head">
            <Field
              label="Meu guichê"
              value={counterId}
              onChange={setCounterId}
              options={overview.counters.map((c: Row) => [
                c.id,
                `${c.name} · ${c.status === "open" ? "aberto" : c.status === "paused" ? "pausado" : "fechado"}${c.user_name ? " · " + c.user_name : ""}`,
              ])}
              emptyOption="Escolha o guichê"
            />
            {counter && (
              <div className="queue-desk-state">
                {counter.status !== "open" && (
                  <Button
                    size="sm"
                    icon={<Play size={16} />}
                    busy={busyKey === "open"}
                    onClick={() =>
                      act(
                        "open",
                        `queue/counters/${counter.id}/state`,
                        { status: "open" },
                        "Guichê aberto.",
                      )
                    }
                  >
                    Abrir
                  </Button>
                )}
                {counter.status === "open" && (
                  <Button
                    size="sm"
                    secondary
                    icon={<Pause size={16} />}
                    busy={busyKey === "pause"}
                    onClick={() =>
                      act(
                        "pause",
                        `queue/counters/${counter.id}/state`,
                        { status: "paused" },
                        "Guichê pausado.",
                      )
                    }
                  >
                    Pausar
                  </Button>
                )}
                {counter.status !== "closed" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Power size={16} />}
                    busy={busyKey === "close"}
                    onClick={() =>
                      act(
                        "close",
                        `queue/counters/${counter.id}/state`,
                        { status: "closed" },
                        "Guichê fechado.",
                      )
                    }
                  >
                    Fechar
                  </Button>
                )}
              </div>
            )}
          </div>

          {!counter ? (
            <Empty
              compact
              title="Escolha seu guichê"
              description="As chamadas saem com o nome dele no painel e no WhatsApp."
            />
          ) : (
            <>
              <div className="queue-current" aria-live="polite">
                {current ? (
                  <>
                    <TicketCode ticket={current} size="lg" />
                    <div>
                      <strong>{current.queue_name}</strong>
                      <span>
                        {current.preferential ? "Preferencial" : "Normal"} ·{" "}
                        {statusLabel[current.status]} · chamada{" "}
                        {current.call_count}×
                      </span>
                    </div>
                  </>
                ) : (
                  <p>Nenhuma senha em atendimento neste guichê.</p>
                )}
              </div>
              <div className="queue-actions">
                <Button
                  size="lg"
                  icon={<Megaphone size={20} />}
                  disabled={counter.status !== "open"}
                  busy={busyKey === "next"}
                  onClick={() =>
                    run(
                      () =>
                        app.api(
                          `${app.root}/queue/counters/${counter.id}/call-next`,
                          "POST",
                          {},
                        ),
                      { key: "next", retry: false },
                    ).then((t: any) => {
                      if (t) toast(`Senha ${t.code} chamada.`);
                      void load();
                    })
                  }
                >
                  Chamar próxima
                </Button>
                {current && (
                  <>
                    <Button
                      secondary
                      icon={<Repeat2 size={17} />}
                      busy={busyKey === "recall"}
                      onClick={() =>
                        act(
                          "recall",
                          `queue/tickets/${current.id}/recall`,
                          {},
                          "Senha chamada novamente.",
                        )
                      }
                    >
                      Rechamar
                    </Button>
                    {current.status === "called" && (
                      <Button
                        secondary
                        icon={<Play size={17} />}
                        busy={busyKey === "start"}
                        onClick={() =>
                          act("start", `queue/tickets/${current.id}/start`)
                        }
                      >
                        Iniciar
                      </Button>
                    )}
                    <Button
                      secondary
                      icon={<CheckCircle2 size={17} />}
                      busy={busyKey === "finish"}
                      onClick={() =>
                        act(
                          "finish",
                          `queue/tickets/${current.id}/finish`,
                          {},
                          "Atendimento concluído.",
                        )
                      }
                    >
                      Concluir
                    </Button>
                    {current.status === "called" && (
                      <Button
                        variant="ghost"
                        icon={<UserX size={17} />}
                        busy={busyKey === "absent"}
                        onClick={() =>
                          act(
                            "absent",
                            `queue/tickets/${current.id}/no-show`,
                            {},
                            "Marcada como ausente.",
                          )
                        }
                      >
                        Ausente
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      icon={<Bell size={17} />}
                      onClick={() => setTransfer(current)}
                    >
                      Transferir
                    </Button>
                  </>
                )}
              </div>
              {counter.status !== "open" && (
                <Notice tone="info">Abra o guichê para chamar senhas.</Notice>
              )}
            </>
          )}
        </section>

        <section className="card queue-list" aria-label="Aguardando">
          <div className="card-heading">
            <div>
              <h2>Aguardando ({waiting.length})</h2>
            </div>
            <div className="card-actions">
              <select
                aria-label="Filtrar por fila"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              >
                <option value="">Todas as filas</option>
                {overview.queues.map((q: Row) => (
                  <option key={q.id} value={q.id}>
                    {q.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {!waiting.length ? (
            <Empty
              compact
              title="Ninguém aguardando"
              description="Novas senhas aparecem aqui na hora."
            />
          ) : (
            <ul className="queue-rows">
              {waiting.map((t) => (
                <li key={t.id}>
                  <TicketCode ticket={t} />
                  <div className="queue-row-info">
                    <span>
                      {t.queue_name} · {sourceLabel[t.source] || t.source}
                      {t.target_counter_id ? " · transferida para guichê" : ""}
                    </span>
                    <small>
                      esperando há {minutesSince(t.created_at)} min
                      {t.phone && !t.window_open
                        ? " · fora da janela do WhatsApp"
                        : ""}
                    </small>
                  </div>
                  <div className="queue-row-actions">
                    <button
                      type="button"
                      className="text-link"
                      onClick={() => setTransfer(t)}
                    >
                      Transferir
                    </button>
                    <button
                      type="button"
                      className="text-link"
                      disabled={busy}
                      onClick={() =>
                        act(
                          "cancel:" + t.id,
                          `queue/tickets/${t.id}/cancel`,
                          {},
                          `Senha ${t.code} cancelada.`,
                        )
                      }
                    >
                      <X size={14} /> Cancelar
                    </button>
                    {t.phone && (
                      <button
                        type="button"
                        className="text-link danger"
                        onClick={() => setBlocking(t)}
                      >
                        <Ban size={14} /> Bloquear
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {transfer && (
        <TransferDialog
          ticket={transfer}
          overview={overview}
          onClose={() => setTransfer(null)}
          onDone={() => void load()}
        />
      )}
      {issuing && (
        <IssueDialog
          overview={overview}
          onClose={() => setIssuing(false)}
          onDone={() => void load()}
        />
      )}
      {blocking && (
        <Confirm
          title={`Bloquear ${blocking.phone}?`}
          confirmLabel="Bloquear"
          danger
          busy={busy}
          onClose={() => setBlocking(null)}
          onConfirm={() =>
            void run(
              () =>
                app.api(`${app.root}/queue/blocklist`, "POST", {
                  ticket_id: blocking.id,
                  note: `Bloqueado pela fila (senha ${blocking.code})`,
                }),
              {
                success: "Contato bloqueado para retirar senha pelo WhatsApp.",
              },
            ).then(() => setBlocking(null))
          }
        >
          <p>
            O contato não poderá retirar senha pelo WhatsApp pelo prazo
            configurado. A senha {blocking.code} continua na fila.
          </p>
        </Confirm>
      )}
    </div>
  );
}
