// Console do bot e execuções recentes (segmento Bots de Equipe).
// Pergunta direta a um bot: POST /bot-runs e consulta até o resultado.
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Bot,
  Copy,
  Download,
  RefreshCw,
  Send,
  Square,
} from "lucide-react";
import { useApp, useAppEvents } from "../app/AppContext";
import { useCompact } from "../app/hooks";
import { isFinalError, type Row } from "../lib/api";
import { whenLabel } from "../lib/format";
import { navigate } from "../lib/routes";
import {
  Avatar,
  Button,
  Empty,
  IconButton,
  Notice,
  Pill,
  Spinner,
  toast,
} from "../ui";
import { Bubble, ChatScroll, EventChip, MessageInput } from "../ui/chat";
import {
  botOutput,
  runActive,
  runStatusName,
  runStatusTone,
  takeBotContext,
} from "./shared";

type Exchange = { key: string; input: string; run: Row | null; error?: string };

function RunResult({ run, root }: { run: Row; root: string }) {
  const output = botOutput(run);
  return (
    <>
      {output.text ? (
        <p>{output.text}</p>
      ) : (
        <p className="muted">
          {run.status === "completed"
            ? "O bot concluiu sem texto de resposta."
            : run.error || runStatusName[run.status] || run.status}
        </p>
      )}
      {output.attachments.map((id) => (
        <a
          key={id}
          className="bot-attachment"
          href={`/api/${root}/media/${encodeURIComponent(id)}/content`}
        >
          <Download size={14} /> Baixar anexo
        </a>
      ))}
    </>
  );
}

export function BotConsole({ botId }: { botId?: string }) {
  const app = useApp();
  const compact = useCompact();
  const bot = app.bots.find((item) => item.id === botId) || null;
  const member = app.team.find((item) => item.id === "bot:" + botId);
  const [text, setText] = useState(""),
    [exchanges, setExchanges] = useState<Exchange[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [runs, setRuns] = useState<Row[] | null>(null),
    [runsError, setRunsError] = useState(""),
    [refreshing, setRefreshing] = useState(false);
  const pending = useRef<{ body: Row; key: string } | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // "Consultar bot" na conversa deixa o contexto pronto para enviar.
  useEffect(() => {
    if (!botId) return;
    const context = takeBotContext();
    if (context?.text) setText(String(context.text).slice(0, 60000));
  }, [botId]);

  const loadRuns = useCallback(async () => {
    try {
      let all: Row[] = [],
        cursor: string | null = "";
      for (let page = 0; page < 3 && cursor !== null; page++) {
        const result: Row = await app.api(
          `${app.root}/bot-runs?limit=100&cursor=${encodeURIComponent(cursor)}`,
        );
        all = all.concat(result.data || []);
        cursor = result.next_cursor || null;
      }
      if (!alive.current) return;
      setRuns(all.sort((a, b) => b.created - a.created).slice(0, 40));
      setRunsError("");
    } catch (e: any) {
      if (alive.current) setRunsError(e.message);
    }
  }, [app.api, app.root]);
  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);
  useAppEvents((events) => {
    if (events.some((event) => event.kind.startsWith("bot.run.") || event.kind === "resync"))
      void loadRuns();
  });

  const update = (key: string, patch: Partial<Exchange>) =>
    setExchanges((list) =>
      list.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    );
  async function follow(key: string, id: string) {
    while (alive.current) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (!alive.current) return;
      try {
        const run = await app.api("v1/bot-runs/" + encodeURIComponent(id));
        update(key, { run });
        if (!runActive(run.status)) {
          void loadRuns();
          return;
        }
      } catch (e: any) {
        if (isFinalError(e)) {
          update(key, { error: e.message });
          return;
        }
      }
    }
  }
  async function ask() {
    if (!bot || busy || (!text.trim() && !pending.current)) return;
    if (app.demoBlocked()) return;
    setBusy(true);
    setError("");
    pending.current ||= {
      body: { profile_id: app.profile, bot_id: bot.id, input: text.trim() },
      key: crypto.randomUUID(),
    };
    const request = pending.current;
    try {
      const run = await app.api(
        "v1/bot-runs",
        "POST",
        request.body,
        undefined,
        request.key,
      );
      pending.current = null;
      setText("");
      setExchanges((list) => [
        ...list,
        { key: request.key, input: request.body.input, run },
      ]);
      void follow(request.key, run.id);
    } catch (e: any) {
      if (isFinalError(e)) pending.current = null;
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function cancel(exchange: Exchange) {
    if (!exchange.run || app.demoBlocked()) return;
    try {
      await app.api(
        `${app.root}/bot-runs/${encodeURIComponent(exchange.run.id)}/cancel`,
        "POST",
        {},
      );
      toast("Cancelamento pedido ao bot.");
    } catch (e: any) {
      setError(e.message);
    }
  }
  const copy = (value: string) =>
    navigator.clipboard
      .writeText(value)
      .then(() => toast("Resposta copiada."))
      .catch(() => toast("Não foi possível copiar.", { tone: "error" }));

  const botName = (id: string) =>
    app.bots.find((item) => item.id === id)?.name || "Bot";
  const shownRuns = (runs || []).filter((run) => !bot || run.bot_id === bot.id);

  const runsList = (
    <section className="bot-runs" aria-label="Execuções recentes">
      {runsError && (
        <Notice tone="error" onRetry={() => void loadRuns()}>
          {runsError}
        </Notice>
      )}
      {runs === null && !runsError ? (
        <Spinner label="Carregando execuções…" />
      ) : shownRuns.length ? (
        <ul>
          {shownRuns.map((run) => {
            const output = botOutput(run);
            return (
              <li key={run.id}>
                <details>
                  <summary>
                    <Pill tone={runStatusTone(run.status)}>
                      {runStatusName[run.status] || run.status}
                    </Pill>
                    <span className="bot-run-input truncate">
                      {!bot && <strong>{botName(run.bot_id)} · </strong>}
                      {run.input || "Pedido sem texto"}
                    </span>
                    <time>{whenLabel(run.created, app.now)}</time>
                  </summary>
                  <div className="bot-run-detail">
                    <p className="bot-run-question">{run.input}</p>
                    <RunResult run={run} root={app.root} />
                    {run.error && output.text ? (
                      <p className="muted">{run.error}</p>
                    ) : null}
                    {output.text && (
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<Copy size={14} />}
                        onClick={() => void copy(output.text)}
                      >
                        Copiar resposta
                      </Button>
                    )}
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      ) : runs !== null ? (
        <Empty
          compact
          icon={<Bot size={24} />}
          title="Nenhuma execução ainda"
          description="Os pedidos feitos aos bots aparecem aqui com o resultado."
        />
      ) : null}
    </section>
  );

  return (    <>
      <header className="pane-header team-chat-header">
        {compact && (
          <IconButton
            label="Voltar"
            onClick={() => navigate({ area: "team", sub: "bots" })}
          >
            <ArrowLeft size={20} />
          </IconButton>
        )}
        {bot ? (
          <>
            <Avatar name={bot.name} seed={bot.id} size={40} kind="bot" online={!!member?.online} />
            <div className="team-chat-title">
              <h2 className="truncate">Console · {bot.name}</h2>
              <small className="truncate">
                {member?.online ? "Disponível" : "Indisponível"} · pergunta direta,
                fora das conversas com clientes
              </small>
            </div>
          </>
        ) : (
          <div className="team-chat-title">
            <h2>Execuções recentes</h2>
            <small>Pedidos feitos aos bots desta área de atendimento</small>
          </div>
        )}
        <IconButton
          label="Atualizar execuções"
          busy={refreshing}
          onClick={async () => {
            setRefreshing(true);
            await loadRuns();
            setRefreshing(false);
          }}
        >
          <RefreshCw size={18} />
        </IconButton>
      </header>
      {bot ? (
        <ChatScroll
          resetKey={"console:" + bot.id}
          count={exchanges.length * 2}
          label="Console do bot"
          className="bot-console"
        >
          <details className="bot-runs-fold">
            <summary>
              Execuções recentes de {bot.name}
              {shownRuns.length ? ` (${shownRuns.length})` : ""}
            </summary>
            {runsList}
          </details>
          {!exchanges.length && (
            <EventChip icon={<Bot size={12} />}>
              Escreva uma pergunta para {bot.name}. A resposta aparece aqui e
              pode ser copiada para a conversa com o cliente.
            </EventChip>
          )}
          {exchanges.map((exchange) => {
            const run = exchange.run;
            const active = !!run && runActive(run.status);
            const output = run ? botOutput(run) : null;
            return (
              <React.Fragment key={exchange.key}>
                <Bubble side="out" tail at={run?.created}>
                  <p>{exchange.input}</p>
                </Bubble>
                {run && active && (
                  <EventChip icon={<Spinner size={13} />}>
                    {runStatusName[run.status] || run.status}
                    <button
                      type="button"
                      className="chip-action"
                      onClick={() => void cancel(exchange)}
                    >
                      <Square size={11} /> Cancelar
                    </button>
                  </EventChip>
                )}
                {run && !active && run.status === "completed" && (
                  <Bubble
                    side="in"
                    tail
                    at={run.updated}
                    label={
                      <>
                        <Bot size={12} /> {botName(run.bot_id)}
                      </>
                    }
                    labelTone="bot"
                    tools={
                      output?.text ? (
                        <button
                          type="button"
                          aria-label="Copiar resposta"
                          title="Copiar resposta"
                          onClick={() => void copy(output.text)}
                        >
                          <Copy size={15} />
                        </button>
                      ) : undefined
                    }
                  >
                    <RunResult run={run} root={app.root} />
                  </Bubble>
                )}
                {run && !active && run.status !== "completed" && (
                  <EventChip tone={run.status === "failed" ? "danger" : "warn"}>
                    {runStatusName[run.status] || run.status}
                    {run.error ? " · " + run.error : ""}
                  </EventChip>
                )}
                {exchange.error && (
                  <EventChip tone="danger">{exchange.error}</EventChip>
                )}
              </React.Fragment>
            );
          })}
        </ChatScroll>
      ) : (
        <div className="pane-scroll bot-runs-page">{runsList}</div>
      )}
      {bot && (
        <footer className="chat-footer">
          {error && (
            <div className="team-chat-notice">
              <Notice tone="error" onClose={() => setError("")}>
                {error}
              </Notice>
            </div>
          )}
          {pending.current && !busy && (
            <p className="team-chat-pending" role="status">
              O pedido ainda não foi confirmado. Tentar novamente reutiliza o
              mesmo pedido para evitar duplicação.
            </p>
          )}
          <div className="composer">
            <div className="composer-field">
              <MessageInput
                value={pending.current ? pending.current.body.input : text}
                onChange={setText}
                onSend={() => void ask()}
                placeholder={"Pergunte a " + bot.name}
                label="Pergunta ao bot"
                maxLength={60000}
                disabled={busy || !!pending.current || !bot.enabled}
              />
            </div>
            <button
              type="button"
              className="composer-send"
              aria-label={pending.current ? "Tentar novamente" : "Enviar pergunta"}
              title={pending.current ? "Tentar novamente" : "Enviar pergunta"}
              disabled={
                busy || !bot.enabled || (!text.trim() && !pending.current)
              }
              onClick={() => void ask()}
            >
              {busy ? <RefreshCw size={19} className="spin" /> : <Send size={19} />}
            </button>
          </div>
          {!bot.enabled && (
            <p className="team-chat-pending">
              Este bot está desabilitado em Gestão → Atendente e especialistas.
            </p>
          )}
        </footer>
      )}
    </>
  );
}
