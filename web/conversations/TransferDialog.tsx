// "Encaminhar atendimento" (mobile/DESIGN.md §6, web/DESIGN.md §5): um só
// lugar para tirar a conversa de mim. Abas Pessoas, Bots, Setores, Menu e
// Protocolo; cada item pede uma confirmação curta dentro do diálogo.
import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Bot,
  Building2,
  ChevronRight,
  FileText,
  List,
  ListTree,
  Plus,
  Search,
  Users,
} from "lucide-react";
import { useApp } from "../app/AppContext";
import { useIntents, type Row } from "../lib/api";
import { conversationName, digits, parse, plural } from "../lib/format";
import { navigate } from "../lib/routes";
import { ticketStateName, ticketStateTone } from "../lib/tickets";
import { menuPath, type MenuItem } from "../menu-tree";
import {
  Avatar,
  Button,
  Dialog,
  Empty,
  Notice,
  Pill,
  SearchBox,
  Segmented,
  Spinner,
  toast,
} from "../ui";

export type TransferTab = "people" | "bots" | "departments" | "menu" | "ticket";

type Choice = {
  key: string;
  /** Pergunta de confirmação: "Transferir para Ana?" */
  question: string;
  confirm: string;
  warning?: string;
  help?: string;
  body: Row;
  success: string;
};

export function TransferDialog({
  conversation,
  initialTab = "people",
  onClose,
  onDone,
  onNewTicket,
}: {
  conversation: Row;
  initialTab?: TransferTab;
  onClose: () => void;
  /** Depois de uma ação concluída (a conversa mudou). */
  onDone: () => void;
  /** Abre o formulário completo de novo protocolo. */
  onNewTicket: () => void;
}) {
  const app = useApp();
  const write = useIntents(app.api);
  const [tab, setTab] = useState<TransferTab>(initialTab);
  const [query, setQuery] = useState("");
  const [choice, setChoice] = useState<Choice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [team, setTeam] = useState<Row[] | null>(app.team.length ? app.team : null);
  const [menus, setMenus] = useState<Row[] | null>(null);
  const [menuError, setMenuError] = useState("");
  const [tickets, setTickets] = useState<Row[] | null>(null);
  const [number, setNumber] = useState("");
  const group = conversation.chat_type === "group";
  const name = conversationName(conversation);

  // Presença atualizada ao abrir (a casca relê a cada 20 s).
  useEffect(() => {
    let alive = true;
    app
      .api(app.root + "/team")
      .then((result) => alive && setTeam(result.data || []))
      .catch((e) => alive && !team && setError(e.message));
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (tab !== "menu" || menus) return;
    let alive = true;
    setMenuError("");
    app
      .api(
        app.root +
          "/menus?connection_id=" +
          encodeURIComponent(conversation.connection_id || ""),
      )
      .then((result) => alive && setMenus(result.data || []))
      .catch((e) => alive && setMenuError(e.message));
    return () => {
      alive = false;
    };
  }, [tab]);
  useEffect(() => {
    if (tab !== "ticket" || tickets) return;
    let alive = true;
    const phone = digits(conversation.phone || "");
    (phone
      ? app.api(app.root + "/tickets?limit=100&q=" + encodeURIComponent(phone))
      : Promise.resolve({ data: [] })
    )
      .then(
        (result) =>
          alive &&
          setTickets(
            (result.data || []).filter(
              (ticket: Row) => ticket.conversation_id === conversation.id,
            ),
          ),
      )
      .catch(() => alive && setTickets([]));
    return () => {
      alive = false;
    };
  }, [tab]);
  useEffect(() => {
    setQuery("");
    setChoice(null);
    setError("");
  }, [tab]);

  const matches = (text: string) =>
    !query.trim() || text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const people = useMemo(
    () =>
      (team || [])
        .filter((item) => item.kind === "user" && item.id !== app.me.id)
        .sort(
          (a, b) =>
            Number(!!b.online) - Number(!!a.online) || a.name.localeCompare(b.name),
        ),
    [team, app.me.id],
  );
  const bots = useMemo(
    () =>
      (team || []).filter((item) => {
        if (item.kind !== "bot") return false;
        const record = app.bots.find(
          (bot) => bot.id === (item.bot_id || String(item.id).slice(4)),
        );
        if (record && !record.enabled) return false;
        // Linhas autorizadas: null = todas; lista = só as citadas.
        const lines =
          typeof item.line_ids === "string" ? parse(item.line_ids, null) : item.line_ids;
        return (
          lines == null ||
          (Array.isArray(lines) &&
            !!conversation.connection_id &&
            lines.includes(conversation.connection_id))
        );
      }),
    [team, app.bots, conversation.connection_id],
  );
  const departments: Row[] = (app.settings.departments || []).filter(
    (department: Row) => department.enabled !== false,
  );
  const submenus = (menus || []).filter(
    (menu) => menu.type === "submenu" && menu.enabled !== false,
  );

  async function confirm() {
    if (!choice || app.demoBlocked()) return;
    setBusy(true);
    setError("");
    try {
      await write(
        `${app.root}/conversations/${conversation.id}/actions`,
        "POST",
        choice.body,
      );
      toast(choice.success);
      onDone();
      onClose();
    } catch (e: any) {
      // O erro do servidor fica aqui, sem fechar o diálogo.
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const listSize =
    tab === "people"
      ? people.length
      : tab === "bots"
        ? bots.length + 1
        : tab === "departments"
          ? departments.length
          : tab === "menu"
            ? submenus.length + 1
            : 0;

  const row = (
    key: string,
    avatar: React.ReactNode,
    title: string,
    subtitle: React.ReactNode,
    onPick: () => void,
  ) => (
    <button type="button" className="transfer-item" key={key} onClick={onPick}>
      {avatar}
      <span className="transfer-item-text">
        <strong className="truncate">{title}</strong>
        <small className="truncate">{subtitle}</small>
      </span>
      <ChevronRight size={18} aria-hidden />
    </button>
  );
  const presence = (online: boolean, on = "Online", off = "Offline") => (
    <>
      <i className={"presence-dot " + (online ? "online" : "offline")} aria-hidden />
      {online ? on : off}
    </>
  );

  let body: React.ReactNode;
  if (choice)
    body = (
      <div className="transfer-confirm">
        <h3>{choice.question}</h3>
        {choice.help && <p className="muted">{choice.help}</p>}
        {choice.warning && <Notice tone="warn">{choice.warning}</Notice>}
        {error && (
          <Notice tone="error" onRetry={confirm} busy={busy}>
            {error}
          </Notice>
        )}
        <div className="transfer-confirm-actions">
          <Button
            variant="secondary"
            disabled={busy}
            icon={<ArrowLeft size={16} />}
            onClick={() => {
              setChoice(null);
              setError("");
            }}
          >
            Voltar
          </Button>
          <Button busy={busy} onClick={confirm} data-autofocus>
            {choice.confirm}
          </Button>
        </div>
      </div>
    );
  else if (tab === "people")
    body = !team ? (
      <Spinner label="Carregando a equipe…" />
    ) : people.length ? (
      people
        .filter((person) => matches(person.name))
        .map((person) =>
          row(
            person.id,
            <Avatar name={person.name} seed={person.id} size={40} online={!!person.online} />,
            person.name,
            presence(!!person.online),
            () =>
              setChoice({
                key: person.id,
                question: `Transferir para ${person.name}?`,
                confirm: "Transferir",
                warning: person.online
                  ? undefined
                  : `${person.name} está offline e pode demorar a responder.`,
                help: "A conversa mantém o número de WhatsApp. As permissões da linha e do destinatário continuam valendo.",
                body: { action: "transfer", target: person.id },
                success: `Conversa transferida para ${person.name}.`,
              }),
          ),
        )
    ) : (
      <Empty
        compact
        icon={<Users size={24} />}
        title="Nenhuma outra pessoa na equipe"
        description="Cadastre atendentes em Gestão → Pessoas e acessos."
      />
    );
  else if (tab === "bots")
    body = !team ? (
      <Spinner label="Carregando os bots…" />
    ) : (
      <>
        {matches("Bot do atendimento automático") &&
          row(
            "auto",
            <Avatar name="Bot" kind="bot" size={40} />,
            "Bot do atendimento automático",
            "Devolve a conversa ao bot padrão desta linha",
            () =>
              setChoice({
                key: "auto",
                question: "Devolver ao atendimento automático?",
                confirm: "Devolver ao bot",
                help: "O bot do atendimento volta a responder nesta conversa.",
                body: { action: "resume" },
                success: "Conversa devolvida ao bot.",
              }),
          )}
        {bots
          .filter((bot) => matches(bot.name))
          .map((bot) =>
            row(
              bot.id,
              <Avatar name={bot.name} kind="bot" size={40} online={!!bot.online} />,
              bot.name,
              presence(!!bot.online, "Disponível", "Indisponível"),
              () =>
                setChoice({
                  key: bot.id,
                  question: `Transferir para o bot ${bot.name}?`,
                  confirm: "Transferir",
                  warning: bot.online
                    ? undefined
                    : `${bot.name} está indisponível e pode não responder agora.`,
                  help: "O bot recebe a pergunta recente e o histórico público da conversa.",
                  body: { action: "transfer", target: bot.id },
                  success: `Conversa transferida para o bot ${bot.name}.`,
                }),
            ),
          )}
        {!bots.length && (
          <p className="transfer-note">
            Nenhum outro bot habilitado para esta linha. Autorize bots em Gestão
            → Atendente e especialistas.
          </p>
        )}
      </>
    );
  else if (tab === "departments")
    body = departments.length ? (
      departments
        .filter((department) => matches(department.name))
        .map((department) => {
          const members: string[] = department.members || [];
          const online = (team || []).filter(
            (person) => person.online && members.includes(person.id),
          ).length;
          return row(
            department.id,
            <span className="transfer-icon">
              <Building2 size={20} />
            </span>,
            department.name,
            `${plural(members.length, "pessoa", "pessoas")} · ${online} online`,
            () =>
              setChoice({
                key: department.id,
                question: `Encaminhar para o setor ${department.name}?`,
                confirm: "Encaminhar",
                warning: online
                  ? undefined
                  : "Ninguém deste setor está online agora. A conversa aguarda na fila do setor.",
                help: "A conversa vai para a fila do setor e sai do seu atendimento.",
                body: { action: "transfer", department_id: department.id },
                success: `Conversa encaminhada para ${department.name}.`,
              }),
          );
        })
    ) : (
      <Empty
        compact
        icon={<Building2 size={24} />}
        title="Nenhum setor configurado no painel"
        description="Sem setores, os encaminhamentos usam a fila geral. Crie setores em Gestão → Menus e ações."
      />
    );
  else if (tab === "menu")
    body = menuError ? (
      <Notice tone="error" onRetry={() => setMenus(null)}>
        {menuError}
      </Notice>
    ) : !menus ? (
      <Spinner label="Carregando os menus…" />
    ) : (
      <>
        <p className="transfer-note">
          Envia o menu ao cliente; a conversa segue com você até ele escolher. A
          janela de 24 horas e as permissões desta linha continuam valendo.
        </p>
        {matches("Menu principal") &&
          row(
            "main",
            <span className="transfer-icon">
              <List size={20} />
            </span>,
            "Menu principal",
            "Todas as opções desta linha",
            () =>
              setChoice({
                key: "main",
                question: "Enviar o menu principal?",
                confirm: "Enviar menu",
                help: "O cliente poderá tocar ou digitar uma opção.",
                body: { action: "menu", menu_id: null },
                success: "Menu enviado ao cliente.",
              }),
          )}
        {submenus
          .filter((menu) => matches(menuPath(menus as MenuItem[], menu.id)))
          .map((menu) => {
            const path = menuPath(menus as MenuItem[], menu.id);
            return row(
              menu.id,
              <span className="transfer-icon">
                <ListTree size={20} />
              </span>,
              menu.label,
              path === menu.label ? "Submenu" : path,
              () =>
                setChoice({
                  key: menu.id,
                  question: `Enviar o submenu “${menu.label}”?`,
                  confirm: "Enviar menu",
                  help: "O cliente poderá tocar ou digitar uma opção.",
                  body: { action: "menu", menu_id: menu.id },
                  success: "Menu enviado ao cliente.",
                }),
            );
          })}
      </>
    );
  else
    body = (
      <div className="transfer-ticket">
        <button
          type="button"
          className="transfer-item"
          onClick={() => {
            onClose();
            onNewTicket();
          }}
        >
          <span className="transfer-icon ticket">
            <Plus size={20} />
          </span>
          <span className="transfer-item-text">
            <strong>Abrir protocolo</strong>
            <small>Título e categoria; o cliente acompanha pelo número</small>
          </span>
          <ChevronRight size={18} aria-hidden />
        </button>
        {!group && (
          <div className="transfer-lookup">
            <strong>
              <Search size={15} /> Enviar consulta de protocolos ao cliente
            </strong>
            <label>
              <span>Número do protocolo (opcional)</span>
              <input
                value={number}
                onChange={(event) => setNumber(event.target.value)}
                placeholder="Em branco: protocolos do telefone"
              />
            </label>
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                setChoice({
                  key: "lookup",
                  question: number.trim()
                    ? `Enviar ao cliente a situação do protocolo ${number.trim()}?`
                    : "Enviar ao cliente a lista de protocolos deste telefone?",
                  confirm: "Enviar consulta",
                  help: "O cliente recebe a situação pelo WhatsApp. Notas internas não são enviadas.",
                  body: { action: "protocols", number: number.trim() || undefined },
                  success: "Consulta de protocolos enviada.",
                })
              }
            >
              Enviar consulta
            </Button>
          </div>
        )}
        <h3 className="transfer-heading">Protocolos desta conversa</h3>
        {!tickets ? (
          <Spinner label="Carregando protocolos…" />
        ) : tickets.length ? (
          tickets.map((ticket) => (
            <button
              type="button"
              className="transfer-item"
              key={ticket.id}
              onClick={() => {
                onClose();
                navigate({ area: "tickets", id: ticket.id });
              }}
            >
              <span className="transfer-icon ticket">
                <FileText size={20} />
              </span>
              <span className="transfer-item-text">
                <strong className="mono truncate">{ticket.number}</strong>
                <small className="truncate">{ticket.title}</small>
              </span>
              <Pill tone={ticketStateTone(ticket.status)}>
                {ticketStateName(ticket.status)}
              </Pill>
            </button>
          ))
        ) : (
          <p className="transfer-note">Esta conversa ainda não tem protocolos.</p>
        )}
      </div>
    );

  return (
    <Dialog
      title="Encaminhar atendimento"
      subtitle={name}
      onClose={onClose}
      className="transfer-dialog"
      bare
    >
      <div className="transfer-tabs">
        <Segmented<TransferTab>
          label="Destino"
          value={tab}
          onChange={setTab}
          full
          options={[
            { value: "people", label: "Pessoas", icon: <Users size={15} /> },
            { value: "bots", label: "Bots", icon: <Bot size={15} /> },
            { value: "departments", label: "Setores", icon: <Building2 size={15} /> },
            { value: "menu", label: "Menu", icon: <List size={15} /> },
            { value: "ticket", label: "Protocolo", icon: <FileText size={15} /> },
          ]}
        />
        {!choice && listSize > 8 && (
          <SearchBox value={query} onChange={setQuery} placeholder="Buscar" />
        )}
      </div>
      <div className="transfer-body" role="tabpanel">
        {!choice && error && <Notice tone="error">{error}</Notice>}
        {body}
      </div>
    </Dialog>
  );
}
