// Conversa aberta (mobile/DESIGN.md §5, web/DESIGN.md §4): cabeçalho, faixa
// da janela de 24 h, mensagens e rodapé conforme o estado.
import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  Bot,
  CheckCheck,
  Clock,
  EllipsisVertical,
  FileText,
  Forward,
  Hourglass,
  List,
  Mail,
  PanelRight,
  Phone,
  ShieldCheck,
  Star,
  Tags,
  Undo2,
  Upload,
  UserPlus,
  UserRound,
} from "lucide-react";
import { useApp, useAppEvents } from "../app/AppContext";
import { useCompact } from "../app/hooks";
import { useIntents, type Row } from "../lib/api";
import { conversationName, span } from "../lib/format";
import { navigate } from "../lib/routes";
import { readText, writeText } from "../lib/storage";
import { windowInfo } from "../lib/window";
import { channelLabel, channelPresentation } from "../channels";
import {
  Avatar,
  Button,
  Confirm,
  Empty,
  IconButton,
  MenuButton,
  SkeletonRows,
  WindowRing,
  conversationBadge,
  toast,
  toastError,
  type MenuAction,
} from "../ui";
import { ChatScroll, type ChatScrollHandle } from "../ui/chat";
import { CallPanel } from "../WhatsAppCalls";
import { ContactEditor } from "../ContactsPanel";
import { useConversationActions } from "./actions";
import { Composer, type ComposerHandle } from "./Composer";
import { WindowDialog } from "./dialogs";
import { InfoPanel } from "./InfoPanel";
import { ImageViewer, isImage } from "./Media";
import { MessageList, type Optimistic, type SessionEvent } from "./MessageList";
import { botContext, botName, channelConversation, channelSendPolicy, headerSubtitle, isMine } from "./model";
import type { TransferTab } from "./TransferDialog";
import { EmailTranscriptDialog, transcriptAction } from "./EmailTranscriptDialog";

export type ChatHandle = { reload: () => Promise<void> };

/** Conversas internas do painel podem não ter canal: sem capacidade de ligar. */

export const ChatView = React.forwardRef<
  ChatHandle,
  {
    id: string;
    events: SessionEvent[];
    onLoaded: (conversation: Row) => void;
    onTransfer: (conversation: Row, tab?: TransferTab) => void;
    onTags: (conversation: Row) => void;
    onTicket: (conversation: Row) => void;
    onResolve: (conversation: Row) => void;
    ticketsVersion: number;
  }
>(function ChatView(
  { id, events, onLoaded, onTransfer, onTags, onTicket, onResolve, ticketsVersion },
  ref,
) {
  const app = useApp();
  const compact = useCompact();
  const write = useIntents(app.api);
  const scopeKey = JSON.stringify([app.root, id, app.contextGeneration]);
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  const [loaded, setLoaded] = useState<{ key: string; value: Row } | null>(null);
  const detail = loaded?.key === scopeKey ? loaded.value : null;
  const [failure, setFailure] = useState<{ key: string; message: string; status?: number } | null>(
    null,
  );
  const error = failure?.key === scopeKey ? failure : null;
  const [info, setInfo] = useState(
    () => readText("wabotia:conversation-info") === "open" && window.innerWidth >= 1100,
  );
  const [quote, setQuote] = useState<Row | null>(null),
    [edit, setEdit] = useState<Row | null>(null),
    [highlighted, setHighlighted] = useState<string | null>(null),
    [viewer, setViewer] = useState<string | null>(null),
    [callOpen, setCallOpen] = useState(false),
    [windowOpen, setWindowOpen] = useState(false),
    [emailOpen, setEmailOpen] = useState(false),
    [resolveOpen, setResolveOpen] = useState(false),
    [contactEditing, setContactEditing] = useState(false),
    [saveContact, setSaveContact] = useState<Row | null>(null),
    [savingContact, setSavingContact] = useState(false),
    [optimistic, setOptimistic] = useState<Record<string, Optimistic>>({}),
    [dragging, setDragging] = useState(false),
    [clockOffset, setClockOffset] = useState(0);
  const scroll = useRef<ChatScrollHandle>(null),
    composer = useRef<ComposerHandle>(null),
    alive = useRef(true),
    request = useRef(0),
    dragDepth = useRef(0);
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  const load = useCallback(async () => {
    const mine = ++request.current;
    try {
      const next = await app.api(`${app.root}/conversations/${id}`);
      if (!alive.current || mine !== request.current || currentScope.current !== scopeKey) return;
      setLoaded({ key: scopeKey, value: next });
      setFailure(null);
      const serverNow = next.server_now || next.window?.serverNow || next.capabilities?.window?.serverNow;
      if (serverNow) {
        app.syncClock(serverNow);
        setClockOffset(serverNow - Date.now());
      }
      const conversation = {
        ...channelConversation(next),
        contact_name: next.contact?.name ?? next.conversation.contact_name ?? null,
      };
      app.rememberConversations([conversation]);
      onLoadedRef.current(conversation);
    } catch (e: any) {
      if (!alive.current || mine !== request.current || currentScope.current !== scopeKey) return;
      // Com a conversa já na tela, uma falha de releitura não a esconde.
      setFailure({ key: scopeKey, message: e.message, status: e.status });
    }
  }, [app.api, app.root, id, app.syncClock, app.rememberConversations, scopeKey]);
  useImperativeHandle(ref, () => ({ reload: load }), [load]);

  useEffect(() => {
    alive.current = true;
    setLoaded(null);
    setQuote(null);
    setEdit(null);
    setEmailOpen(false);
    setResolveOpen(false);
    setOptimistic({});
    void load();
    return () => {
      alive.current = false;
      request.current++;
    };
  }, [load]);

  // Conversa aberta e visível: mensagens novas nela não contam como não lidas.
  useEffect(() => {
    const sync = () => app.setOpenConversation(document.hidden ? null : id);
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      app.setOpenConversation(null);
    };
  }, [id, app.setOpenConversation]);

  // Atualização: eventos da área e, de reserva, releitura enquanto visível
  // (mais curta quando há envios aguardando o canal).
  const loadRef = useRef(load);
  loadRef.current = load;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useAppEvents((list) => {
    if (
      list.some(
        (event) =>
          event.kind === "resync" ||
          event.resource_id === id ||
          event.payload?.conversation_id === id,
      )
    ) {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void loadRef.current(), 200);
    }
  });
  const waiting = (detail?.deliveries || []).some((delivery: Row) =>
    ["pending", "sending"].includes(delivery.status),
  );
  useEffect(() => {
    const poll = setInterval(
      () => {
        if (!document.hidden) void loadRef.current();
      },
      waiting ? 3000 : 10_000,
    );
    const visible = () => !document.hidden && void loadRef.current();
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(poll);
      clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [waiting]);

  const actions = useConversationActions(() => void loadRef.current());
  // Os diálogos mostram o nome do contato salvo, que vem à parte no detalhe.
  const c: Row | null = useMemo(
    () =>
      detail?.conversation
        ? {
            ...channelConversation(detail),
            contact_name:
              detail.contact?.name ?? detail.conversation.contact_name ?? null,
          }
        : null,
    [detail],
  );
  const cap: Row = detail?.capabilities || {};
  const policy = channelSendPolicy(c || {}, cap, app.now, app.lineKinds);
  const presentation = channelPresentation(c || {}, app.status, app.lineKinds);
  const emailAction = transcriptAction(detail?.email_transcript);
  const mine = !!c && isMine(c, app.me.id);
  const canTransfer = mine || app.isAdmin;
  const group = c?.chat_type === "group";
  const name = c
    ? detail?.contact?.name || conversationName(c)
    : "Conversa";
  const windowState = useMemo(() => {
    if (!c) return null;
    // O tipo da linha vem do próprio detalhe quando a casca ainda não o conhece.
    const kinds =
      c.connection_id && detail?.connection_kind
        ? { ...app.lineKinds, [c.connection_id]: detail.connection_kind }
        : app.lineKinds;
    return windowInfo(c, kinds, app.now);
  }, [c, detail?.connection_kind, app.lineKinds, app.now]);

  // O rodapé muda de altura quando o estado muda: mantém o fim à vista.
  useEffect(() => {
    const frame = requestAnimationFrame(() => scroll.current?.toBottom());
    return () => cancelAnimationFrame(frame);
  }, [mine, c?.state]);

  const toggleInfo = (next = !info) => {
    setInfo(next);
    writeText("wabotia:conversation-info", next ? "open" : "closed");
  };

  // Atalho: Ctrl+Shift+T abre "Encaminhar atendimento".
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() === "t" &&
        event.shiftKey &&
        (event.ctrlKey || event.metaKey) &&
        c &&
        canTransfer &&
        !document.querySelector(".modal")
      ) {
        event.preventDefault();
        onTransfer(c);
      }
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [c?.id, canTransfer, onTransfer]);

  const jump = (messageId: string) => {
    const element = document.getElementById("message-" + messageId);
    if (!element) return;
    element.scrollIntoView({ block: "center", behavior: "smooth" });
    setHighlighted(messageId);
    setTimeout(() => alive.current && setHighlighted(null), 1600);
  };

  const images = useMemo(() => {
    if (!detail) return [];
    const byId = new Map<string, Row>(
      (detail.media || []).map((file: Row) => [file.id, file]),
    );
    const list: { id: string; name: string }[] = [];
    for (const message of detail.messages || []) {
      let ids: string[] = [];
      try {
        ids = JSON.parse(message.attachments || "[]");
      } catch {
        /* anexos ilegíveis ficam fora do visualizador */
      }
      for (const fileId of ids) {
        const file = byId.get(fileId);
        if (file && isImage(file.type) && !list.some((item) => item.id === fileId))
          list.push({ id: fileId, name: file.name || "Imagem" });
      }
    }
    // Imagens que só aparecem na lista de mídia (sem mensagem carregada).
    for (const file of detail.media || [])
      if (isImage(file.type) && !list.some((item) => item.id === file.id))
        list.push({ id: file.id, name: file.name || "Imagem" });
    return list;
  }, [detail?.messages, detail?.media]);

  if (!detail || !c)
    return (
      <section className="main-pane chat" aria-label="Conversa">
        <header className="pane-header chat-header">
          {compact && (
            <IconButton
              label="Voltar para a lista"
              onClick={() => navigate({ area: "conversations" })}
            >
              <ArrowLeft size={20} />
            </IconButton>
          )}
          <h2>{error ? "Conversa" : "Abrindo conversa…"}</h2>
        </header>
        {error ? (
          <Empty
            title={
              error.status === 404
                ? "Conversa não encontrada"
                : "Não foi possível abrir a conversa"
            }
            description={
              error.status === 404
                ? "Ela pode pertencer a outra área de atendimento ou não estar mais disponível para você."
                : error.message
            }
            action={
              error.status === 404 ? (
                <Button
                  variant="secondary"
                  onClick={() => navigate({ area: "conversations" })}
                >
                  Voltar para a lista
                </Button>
              ) : (
                <Button onClick={() => void load()}>Tentar de novo</Button>
              )
            }
          />
        ) : (
          <div className="chat-loading">
            <SkeletonRows rows={5} avatar={false} />
          </div>
        )}
      </section>
    );

  const run = (
    action: string,
    success: string,
    body: Row = {},
  ) => void actions.act(c.id, action, body, { success });
  const consent = async () => {
    if (app.demoBlocked()) return;
    try {
      await write(app.root + "/consents/request", "POST", {
        conversation_id: c.id,
      });
      toast("Pedido de consentimento enviado.");
    } catch (e) {
      toastError(e, () => void consent());
    }
  };
  const askBot = () => {
    try {
      sessionStorage.setItem(
        "wabotia:bot-context",
        JSON.stringify({ text: botContext(c, detail.messages || []) }),
      );
    } catch {
      /* o console do bot abre sem o contexto */
    }
    navigate({ area: "team", sub: "bots" });
  };
  const messageAction = (action: string, body: Row) => {
    if (["reaction", "edit", "delete", "read"].includes(action) && !policy.capabilities[action]) return;
    void actions.act(c.id, action, body, { route: "message-actions" });
  };
  const requestResolve = () => policy.automation ? onResolve(c) : setResolveOpen(true);

  const menu: MenuAction[] = [
    { label: "Etiquetas", icon: <Tags size={17} />, onSelect: () => onTags(c) },
    {
      label: "Abrir protocolo",
      icon: <FileText size={17} />,
      onSelect: () => onTicket(c),
    },
    {
      label: "Enviar menu",
      icon: <List size={17} />,
      hidden: !canTransfer || !policy.automation || cap.menu === null,
      onSelect: () => onTransfer(c, "menu"),
    },
    {
      label: "Devolver ao bot",
      icon: <Undo2 size={17} />,
      hidden: !mine || !policy.automation,
      onSelect: () => run("resume", "Conversa devolvida ao bot."),
    },
    {
      label: "Pesquisa de satisfação",
      icon: <Star size={17} />,
      hidden: group || !canTransfer || !policy.automation,
      onSelect: () => run("survey", "Pesquisa de satisfação enviada."),
    },
    { label: "Consultar bot", icon: <Bot size={17} />, onSelect: askBot },
    {
      label: detail.contact ? "Editar contato" : "Salvar contato",
      icon: <UserPlus size={17} />,
      hidden: group,
      onSelect: () => setContactEditing(true),
    },
    {
      label: "Solicitar consentimento",
      icon: <ShieldCheck size={17} />,
      hidden: group || !policy.modules || !policy.automation,
      onSelect: () => void consent(),
    },
    {
      label: "Enviar conversa por e-mail",
      icon: <Mail size={17} />,
      hidden: !emailAction.visible,
      disabled: !emailAction.enabled,
      hint: emailAction.reason || undefined,
      onSelect: () => setEmailOpen(true),
    },
    {
      label: "Dados da conversa",
      icon: <PanelRight size={17} />,
      separator: true,
      onSelect: () => toggleInfo(true),
    },
    {
      label: "Concluir",
      icon: <CheckCheck size={17} />,
      hidden: !mine,
      danger: true,
      onSelect: requestResolve,
    },
  ];

  const pendingCount = (detail.deliveries || []).filter(
    (delivery: Row) => !["sent", "cancelled"].includes(delivery.status),
  ).length;
  const queueWait = span(app.now - (c.updated || app.now));
  const bot = botName(c, app);
  const claimBusy = actions.isBusy(c.id, "claim") || actions.isBusy(c.id, "transfer");

  const footer = mine ? (
    <Composer
      ref={composer}
      detail={detail}
      windowClosed={!!windowState?.closed}
      quote={quote}
      setQuote={setQuote}
      edit={edit}
      setEdit={setEdit}
      refresh={load}
      onSent={(result, sent) => {
        const ids: string[] = result.delivery_ids || (result.delivery_id ? [result.delivery_id] : []);
        if (ids.length)
          setOptimistic((current) => {
            const next = { ...current };
            ids.forEach((deliveryId, index) => {
              next[deliveryId] = {
                text: index === 0 ? sent.text : "",
                attachments: sent.attachments ? 1 : 0,
                at: Date.now(),
              };
            });
            return next;
          });
        requestAnimationFrame(() => scroll.current?.toBottom(true));
      }}
      onMenu={() => onTransfer(c, "menu")}
      onTicket={() => onTicket(c)}
    />
  ) : c.state === "waiting" ? (
    <div className="footer-card">
      <span className="footer-icon tone-warn">
        <Hourglass size={20} />
      </span>
      <div>
        <strong>{queueWait === "agora" ? "Na fila" : "Na fila há " + queueWait}</strong>
        <small>Assuma para responder, enviar arquivos ou ligar.</small>
      </div>
      <Button
        size="lg"
        busy={claimBusy}
        onClick={() => run("claim", "Conversa assumida.")}
      >
        Assumir conversa
      </Button>
    </div>
  ) : c.state === "ai" ? (
    <div className="footer-card">
      <span className="footer-icon tone-bot">
        <Bot size={20} />
      </span>
      <div>
        <strong>{bot ? `O bot ${bot} está atendendo` : "O bot está atendendo"}</strong>
        <small>Assumir pausa as respostas automáticas nesta conversa.</small>
      </div>
      <Button
        size="lg"
        busy={claimBusy}
        onClick={() => run("claim", "Conversa assumida.")}
      >
        Assumir conversa
      </Button>
    </div>
  ) : c.state === "human" ? (
    <div className="footer-card">
      <span className="footer-icon tone-muted">
        <UserRound size={20} />
      </span>
      <div>
        <strong>Em atendimento com {app.names[c.owner] || "outra pessoa"}</strong>
        <small>
          {app.isAdmin
            ? "Como administrador, você pode trazer a conversa para você."
            : "Só quem assumiu pode responder."}
        </small>
      </div>
      {app.isAdmin && (
        <Button
          size="lg"
          variant="secondary"
          busy={claimBusy}
          onClick={() =>
            run("transfer", "Conversa transferida para você.", { target: app.me.id })
          }
        >
          Transferir para mim
        </Button>
      )}
    </div>
  ) : (
    <div className="footer-card">
      <span className="footer-icon tone-muted">
        <CheckCheck size={20} />
      </span>
      <div>
        <strong>Conversa concluída</strong>
        <small>Reabra para voltar a falar com o cliente.</small>
      </div>
      <Button
        size="lg"
        busy={claimBusy}
        onClick={() => run("claim", "Conversa reaberta e assumida.")}
      >
        Reabrir e assumir
      </Button>
    </div>
  );

  const hasFiles = (event: React.DragEvent) =>
    Array.from(event.dataTransfer?.types || []).includes("Files");

  return (
    <>
      <section
        className="main-pane chat"
        aria-label={"Conversa com " + name}
        onDragEnter={(event) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          dragDepth.current++;
          setDragging(true);
        }}
        onDragOver={(event) => {
          if (hasFiles(event)) event.preventDefault();
        }}
        onDragLeave={(event) => {
          if (!hasFiles(event)) return;
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (!dragDepth.current) setDragging(false);
        }}
        onDrop={(event) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          const files = Array.from(event.dataTransfer.files || []);
          if (!files.length) return;
          if (!mine)
            toast("Assuma a conversa para enviar arquivos.", { tone: "info" });
          else composer.current?.addFiles(files);
        }}
      >
        <header className="pane-header chat-header">
          {compact && (
            <IconButton
              label="Voltar para a lista"
              onClick={() => navigate({ area: "conversations" })}
            >
              <ArrowLeft size={20} />
            </IconButton>
          )}
          <button
            type="button"
            className="chat-title"
            onClick={() => toggleInfo()}
            aria-expanded={info}
            aria-label={`${name}. ${headerSubtitle(c, app)}. Abrir dados da conversa`}
          >
            <Avatar
              name={name}
              seed={c.id}
              size={40}
              kind={group ? "group" : "person"}
              badge={conversationBadge(c, app.me.id)}
              channel={presentation.channel}
              multichannel={presentation.multichannel}
            />
            <span className="chat-title-text">
              <strong className="truncate">{name}</strong>
              <small className="truncate">{headerSubtitle(c, app)}</small>
            </span>
          </button>
          <div className="chat-actions">
            {policy.capabilities.calls && (
              <IconButton
                label="Ligar"
                active={callOpen}
                onClick={() => setCallOpen(!callOpen)}
              >
                <Phone size={20} />
              </IconButton>
            )}
            {canTransfer && (
              <IconButton
                label="Transferir (Ctrl+Shift+T)"
                onClick={() => onTransfer(c)}
              >
                <Forward size={20} />
              </IconButton>
            )}
            {!compact && (
              <IconButton
                label="Dados da conversa"
                active={info}
                onClick={() => toggleInfo()}
              >
                <PanelRight size={20} />
              </IconButton>
            )}
            <MenuButton label="Mais ações" items={menu}>
              <EllipsisVertical size={20} />
            </MenuButton>
          </div>
        </header>
        {windowState && (
          <button
            type="button"
            className={
              "window-banner tone-" +
              windowState.tone +
              (windowState.closed ? " closed" : "")
            }
            onClick={() => setWindowOpen(true)}
            aria-label={policy.channel === "whatsapp" ? "Janela de 24 horas. Ver explicação" : "Janela de atendimento. Ver explicação"}
          >
            <WindowRing info={windowState} size={20} />
            <span className="window-banner-text truncate">
              {windowState.state === "human_text_only" ? (
                <><strong>Somente texto humano</strong> · {windowState.long} restantes</>
              ) : windowState.closed ? (
                <>
                  <strong>Janela fechada</strong> · só volta quando o cliente
                  escrever
                </>
              ) : windowState.tone === "danger" ? (
                <strong>Janela fecha em {windowState.long}</strong>
              ) : (
                <>
                  Janela de 24h · <strong>{windowState.long}</strong> restantes
                </>
              )}
            </span>
            {!windowState.closed && (
              <span className="window-banner-until">{windowState.until}</span>
            )}
            <i
              className="window-banner-progress"
              style={{ width: windowState.fraction * 100 + "%" }}
              aria-hidden
            />
          </button>
        )}
        <CallPanel
          name={name}
          api={app.api}
          root={app.root}
          conversation={c}
          enabled={!!policy.capabilities.calls}
          me={app.me}
          refresh={load}
          demo={app.demo}
          open={callOpen}
          onClose={() => setCallOpen(false)}
        />
        {error && (
          <div className="chat-stale" role="status">
            <Clock size={14} /> Não foi possível atualizar agora. Mostrando o
            que já estava carregado.
          </div>
        )}
        {(detail.other_conversations || []).length > 0 && (
          <nav className="chat-other-conversations" aria-label="Outras conversas deste contato">
            <span>Outras conversas deste contato:</span>
            {detail.other_conversations.map((other: Row) => (
              <button type="button" key={other.id} onClick={() => navigate({ area: "conversations", id: other.id })}>
                {channelLabel(other.channel)}{other.account_label ? ` · ${other.account_label}` : ""} · {other.title || "Abrir conversa"}
              </button>
            ))}
          </nav>
        )}
        <div className="chat-body">
          <ChatScroll
            ref={scroll}
            resetKey={c.id}
            count={(detail.messages || []).length + events.length + pendingCount}
            label={"Mensagens de " + name}
          >
            <MessageList
              detail={detail}
              root={app.root}
              events={events}
              optimistic={optimistic}
              highlighted={highlighted}
              onJump={jump}
              tools={{
                own: mine,
                capabilities: policy.capabilities,
                busy: actions.busy !== null,
                onReply: (message) => {
                  setEdit(null);
                  setQuote(message);
                },
                onEdit: (message) => {
                  setQuote(null);
                  setEdit(message);
                },
                onAct: messageAction,
                onOpenImage: setViewer,
                onSaveContact: setSaveContact,
              }}
            />
          </ChatScroll>
          {dragging && (
            <div className="drop-zone" aria-hidden>
              <span>
                <Upload size={28} />
                <strong>Solte os arquivos para anexar</strong>
                <small>
                  {mine
                    ? "Você revisa antes de enviar."
                    : "Assuma a conversa para enviar arquivos."}
                </small>
              </span>
            </div>
          )}
        </div>
        <footer className="chat-footer">{footer}</footer>
      </section>
      {info && (
        <InfoPanel
          detail={detail}
          info={windowState}
          busy={actions.busy !== null}
          refresh={load}
          onClose={() => toggleInfo(false)}
          ticketsVersion={ticketsVersion}
          actions={{
            contact: () => setContactEditing(true),
            tags: () => onTags(c),
            ticket: () => onTicket(c),
            call: policy.capabilities.calls ? () => setCallOpen(true) : undefined,
            bot: askBot,
            survey: policy.automation ? () => run("survey", "Pesquisa de satisfação enviada.") : undefined,
            consent: policy.modules && policy.automation ? () => void consent() : undefined,
            resume: policy.automation ? () => run("resume", "Conversa devolvida ao bot.") : undefined,
            email: emailAction.enabled ? () => setEmailOpen(true) : undefined,
            resolve: requestResolve,
            window: () => setWindowOpen(true),
            openImage: setViewer,
          }}
        />
      )}
      {emailOpen && detail.email_transcript && (
        <EmailTranscriptDialog conversationId={c.id} options={detail.email_transcript} onClose={() => setEmailOpen(false)} />
      )}
      {resolveOpen && (
        <Confirm title="Concluir conversa" confirmLabel="Concluir" busy={actions.isBusy(c.id, "resolve")}
          onClose={() => setResolveOpen(false)} onConfirm={async () => {
            const done = await actions.act(c.id, "resolve", {}, { success: "Conversa concluída." });
            if (done) setResolveOpen(false);
          }}>
          <p>Concluir o atendimento de {name}? A janela não permite enviar convite automático para avaliar. O estado da conversa pode ser concluído.</p>
        </Confirm>
      )}
      {viewer && (
        <ImageViewer
          images={images}
          startId={viewer}
          root={app.root}
          onClose={() => setViewer(null)}
        />
      )}
      {windowOpen && windowState && (
        <WindowDialog
          info={windowState}
          clockOffset={clockOffset}
          onClose={() => setWindowOpen(false)}
        />
      )}
      {contactEditing && (
        <ContactEditor
          key={c.id}
          api={app.api}
          root={app.root}
          demo={app.demo}
          contact={detail.contact}
          conversation={c}
          close={() => setContactEditing(false)}
          saved={(message) => {
            setContactEditing(false);
            toast(message);
            void load();
          }}
        />
      )}
      {saveContact && (
        <Confirm
          title="Salvar contato"
          confirmLabel="Salvar na agenda"
          busy={savingContact}
          onClose={() => setSaveContact(null)}
          onConfirm={async () => {
            if (app.demoBlocked()) return setSaveContact(null);
            setSavingContact(true);
            try {
              await write(app.root + "/contacts", "POST", {
                name: saveContact.name || saveContact.phone,
                phone: saveContact.phone || "",
              });
              toast("Contato salvo na agenda.");
              setSaveContact(null);
            } catch (e) {
              toastError(e);
            } finally {
              setSavingContact(false);
            }
          }}
        >
          <p>
            Salvar {saveContact.name || "este contato"}
            {saveContact.phone ? ` (${saveContact.phone})` : ""} na agenda da
            equipe?
          </p>
        </Confirm>
      )}
    </>
  );
});
