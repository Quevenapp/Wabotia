import React, { useEffect, useRef, useState } from "react";
import { NumberPolicyEditor } from "./NumberPolicyEditor";
import { numberPolicyPresets } from "../src/number-policy";
import {
  menuDescendants,
  menuParentChoices,
  menuPath,
  menuTree,
  menuSnapshot,
  type MenuItem,
  type MenuTreeNode,
} from "./menu-tree";
import "./menu-tree.css";

type Row = Record<string, any>;
type Props = { api: any; root: string; demo: boolean };
const parse = (value: any, fallback: any = null) => {
  try {
    return typeof value === "string" ? JSON.parse(value) : (value ?? fallback);
  } catch {
    return fallback;
  }
};
export const demoLines: Row[] = [
  {
    id: "line-main",
    name: "Filial Centro",
    number: "5511999990001",
    status: "active",
    kind: "zernio",
    number_policy: numberPolicyPresets.official,
    service: { mode: "bot", bot_id: "demo-bot", menu_mode: "automatic" },
  },
  {
    id: "line-support",
    name: "Atendimento da loja",
    number: "5511999990002",
    status: "active",
    kind: "zernio",
    number_policy: numberPolicyPresets.official,
    service: { mode: "human", bot_id: null, menu_mode: "manual" },
  },
];
const demoBots: Row[] = [
  { id: "demo-bot", name: "Atendente", enabled: 1, line_ids: null },
];
const demoMenus: MenuItem[] = [
  {
    id: "menu-sales",
    label: "Informações da loja",
    type: "submenu",
    enabled: true,
    line_ids: [],
    trigger: "automatic",
  },
  {
    id: "menu-person",
    label: "Conversar com uma pessoa",
    type: "human",
    parent_id: "menu-sales",
    enabled: true,
    line_ids: [],
    trigger: "automatic",
  },
  {
    id: "menu-bot",
    label: "Consultar pedido",
    type: "bot",
    bot_id: "demo-bot",
    enabled: true,
    line_ids: ["line-main"],
    trigger: "manual",
  },
];

function useWrite({ api, root, demo }: Props) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const intents = useRef(new Map<string, string>());
  async function write(path: string, method: string, body: Row) {
    if (demo) {
      setNotice("Demonstração: nenhuma alteração foi salva.");
      return null;
    }
    setBusy(true);
    setError("");
    setNotice("");
    const intent = path + JSON.stringify(body);
    if (!intents.current.has(intent))
      intents.current.set(intent, crypto.randomUUID());
    try {
      const result = await api(
        root + path,
        method,
        body,
        undefined,
        intents.current.get(intent),
      );
      intents.current.delete(intent);
      setNotice("Alteração salva.");
      return result;
    } catch (e: any) {
      if (
        e.status >= 400 &&
        e.status < 500 &&
        !["operation_unknown", "idempotency_conflict"].includes(e.code)
      )
        intents.current.delete(intent);
      setError(e.message);
      return null;
    } finally {
      setBusy(false);
    }
  }
  return {
    busy,
    error,
    notice,
    write,
    setError: (message: string) => {
      setError(message);
      setNotice("");
    },
  };
}
function Feedback({ error, notice }: { error: string; notice: string }) {
  return (
    <>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="notice" role="status">
          {notice}
        </div>
      )}
    </>
  );
}
function LineChoices({
  lines,
  value,
  onChange,
  disabled = false,
}: {
  lines: Row[];
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <div className="service-checks">
      {lines.map((line) => (
        <label className="check-line" key={line.id}>
          <input
            type="checkbox"
            disabled={disabled}
            checked={value.includes(line.id)}
            onChange={(e) =>
              onChange(
                e.target.checked
                  ? [...value, line.id]
                  : value.filter((id) => id !== line.id),
              )
            }
          />
          <span>
            {line.name}
            {line.number && <small>+{line.number}</small>}
          </span>
        </label>
      ))}
      {!lines.length && (
        <p>Nenhuma linha cadastrada nesta área de atendimento.</p>
      )}
    </div>
  );
}

function LineCard({
  line,
  bots,
  ...props
}: Props & { line: Row; bots: Row[]; refresh: () => Promise<void> }) {
  const saved = line.service || {
    mode: "inherit",
    bot_id: null,
    menu_mode: "automatic",
  };
  const [draft, setDraft] = useState<Row>({ ...saved });
  const state = useWrite(props);
  const botChoices = bots.filter((b) => {
    const ids = parse(b.line_ids);
    return ids === null || ids.includes(line.id);
  });
  return (
    <article className="card service-line-card">
      <div className="section-heading">
        <h2>{line.name}</h2>
        <span
          className={
            "badge " + (line.status === "active" ? "active" : "paused")
          }
        >
          {line.status === "active" ? "Ativa" : "Pausada"}
        </span>
      </div>
      <p>
        {line.number ? `+${line.number}` : "Número não informado"} ·{" "}
        {line.number_policy?.pool
          ? "Participa do roteador"
          : "Atendimento direto"}
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (await state.write(`/lines/${line.id}`, "PUT", { service: draft }))
            await props.refresh();
        }}
      >
        <label>
          Quem atende esta linha
          <select
            value={draft.mode}
            disabled={state.busy}
            onChange={(e) =>
              setDraft({
                ...draft,
                mode: e.target.value,
                bot_id: e.target.value === "bot" ? draft.bot_id : null,
              })
            }
          >
            <option value="inherit">Bot padrão da área de atendimento</option>
            <option value="human">Equipe humana</option>
            <option value="bot">Bot específico</option>
          </select>
        </label>
        {draft.mode === "bot" && (
          <label>
            Bot responsável
            <select
              required
              value={draft.bot_id || ""}
              disabled={state.busy}
              onChange={(e) => setDraft({ ...draft, bot_id: e.target.value })}
            >
              <option value="">Selecione o bot</option>
              {botChoices.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                  {!b.enabled ? " (desabilitado)" : ""}
                </option>
              ))}
            </select>
            <small>
              As linhas autorizadas de cada bot são configuradas em Equipe Bot.
            </small>
          </label>
        )}
        <label>
          Quando apresentar o menu
          <select
            value={draft.menu_mode}
            disabled={state.busy}
            onChange={(e) => setDraft({ ...draft, menu_mode: e.target.value })}
          >
            <option value="automatic">
              Automaticamente e quando solicitado
            </option>
            <option value="manual">Quando uma pessoa ou bot chamar</option>
            <option value="off">Não usar menus nesta linha</option>
          </select>
        </label>
        <button className="primary" disabled={state.busy}>
          Salvar atendimento da linha
        </button>
      </form>
      <NumberPolicyEditor
        policy={line.number_policy}
        name={line.name}
        busy={state.busy}
        onSave={async (policy) => {
          const result = await state.write(`/lines/${line.id}`, "PUT", {
            number_policy: policy,
          });
          if (result) await props.refresh();
          return result;
        }}
      />
      <Feedback {...state} />
    </article>
  );
}
export function LinesPanel(props: Props) {
  const [lines, setLines] = useState<Row[]>(props.demo ? demoLines : []),
    [bots, setBots] = useState<Row[]>(props.demo ? demoBots : []),
    [error, setError] = useState(""),
    [loaded, setLoaded] = useState(props.demo);
  async function load() {
    if (props.demo) return;
    const [l, b] = await Promise.all([
      props.api(props.root + "/lines"),
      props.api(props.root + "/bots"),
    ]);
    setLines(l.data);
    setBots(b.data);
    setLoaded(true);
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [props.root]);
  return (
    <div className="service-panel">
      <div className="card">
        <h2>Linhas de atendimento</h2>
        <p>
          Escolha quem atende cada número e quando seus menus aparecem. Para uma
          linha exclusiva de bot ou equipe humana, desative sua participação nos
          grupos de roteamento.
        </p>
        <p>
          Cadastre novas linhas em Telefones. Os atendimentos mantêm o número de
          origem durante toda a conversa.
        </p>
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
      </div>
      <div className="cards-grid">
        {lines.map((line) => (
          <LineCard
            {...props}
            key={line.id}
            line={line}
            bots={bots}
            refresh={load}
          />
        ))}
      </div>
      {loaded && !lines.length && (
        <div className="card">
          <p>Conecte uma linha de WhatsApp para configurar seu atendimento.</p>
        </div>
      )}
    </div>
  );
}

export function BotLinesEditor({ bot, ...props }: Props & { bot: Row }) {
  const [lines, setLines] = useState<Row[]>(props.demo ? demoLines : []);
  const [value, setValue] = useState<string[] | null>(() =>
    parse(bot.line_ids),
  );
  const state = useWrite(props);
  useEffect(() => {
    if (!props.demo)
      props
        .api(props.root + "/lines")
        .then((r: Row) => setLines(r.data))
        .catch((e: Error) => state.setError(e.message));
  }, [props.root]);
  return (
    <details className="bot-line-editor">
      <summary>Linhas que este bot atende</summary>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          await state.write(`/bots/${bot.id}`, "PATCH", { line_ids: value });
        }}
      >
        <label>
          Disponibilidade para atendimento
          <select
            value={
              value === null ? "all" : value.length ? "selected" : "internal"
            }
            disabled={state.busy}
            onChange={(e) =>
              setValue(
                e.target.value === "all"
                  ? null
                  : e.target.value === "internal"
                    ? []
                    : lines.slice(0, 1).map((l) => l.id),
              )
            }
          >
            <option value="all">Todas as linhas da área de atendimento</option>
            <option value="selected" disabled={!lines.length}>
              Somente linhas selecionadas
            </option>
            <option value="internal">Somente conversas internas</option>
          </select>
        </label>
        {value !== null && (
          <>
            <LineChoices
              lines={lines}
              value={value}
              onChange={setValue}
              disabled={state.busy}
            />
            <small>
              Sem linhas marcadas, o bot fica disponível apenas internamente.
            </small>
          </>
        )}
        <button disabled={state.busy}>Salvar linhas do bot</button>
      </form>
      <Feedback {...state} />
    </details>
  );
}

export function MenusPanel(props: Props) {
  const [menus, setMenus] = useState<MenuItem[]>(props.demo ? demoMenus : []),
    [lines, setLines] = useState<Row[]>(props.demo ? demoLines : []),
    [bots, setBots] = useState<Row[]>(props.demo ? demoBots : []),
    [apps, setApps] = useState<Row[]>([]),
    [departments, setDepartments] = useState<Row[]>([]),
    [draft, setDraft] = useState<Row | null>(null),
    [removal, setRemoval] = useState<{
      id: string;
      ids: string[];
      snapshots: Record<string, string>;
    } | null>(null),
    [conflicted, setConflicted] = useState(false),
    [pending, setPending] = useState(false);
  const state = useWrite(props);
  async function load() {
    if (props.demo) return;
    const [m, l, b, status] = await Promise.all([
      props.api(props.root + "/menus"),
      props.api(props.root + "/lines"),
      props.api(props.root + "/bots"),
      props.api(props.root + "/status"),
    ]);
    setMenus(m.data);
    setLines(l.data);
    setBots(b.data);
    setApps(status.settings?.apps || []);
    setDepartments(status.settings?.departments || []);
  }
  useEffect(() => {
    load().catch((e) => state.setError(e.message));
  }, [props.root]);
  const editorHeading = useRef<HTMLHeadingElement>(null);
  const original = useRef<string | null>(null);
  const busy = state.busy || pending;
  useEffect(() => {
    if (draft) editorHeading.current?.focus();
  }, [draft?.id]);
  function edit(
    menu?: MenuItem,
    parentId: string | null = null,
    type = "human",
  ) {
    state.setError("");
    setRemoval(null);
    setConflicted(false);
    original.current = menu ? menuSnapshot(menu) : null;
    setDraft(
      menu
        ? {
            ...menu,
            parent_id: menu.parent_id || null,
            line_ids: menu.line_ids || [],
            trigger: menu.trigger || "automatic",
            enabled: menu.enabled !== false,
          }
        : {
            id: crypto.randomUUID(),
            label: "",
            type,
            parent_id: parentId,
            trigger: "automatic",
            line_ids: [],
            enabled: true,
          },
    );
  }
  async function save() {
    if (!draft || pending || conflicted) return;
    setPending(true);
    try {
      const latest = props.demo
        ? { data: menus, revision: undefined }
        : await props.api(props.root + "/menus");
      const items: MenuItem[] = latest.data;
      const current = items.find((item) => item.id === draft.id);
      if (
        original.current &&
        (!current || menuSnapshot(current) !== original.current)
      ) {
        setMenus(items);
        setConflicted(true);
        throw Error(
          current
            ? "Esta opção foi alterada por outra pessoa. Seu rascunho foi mantido. Reabra a versão salva antes de continuar."
            : "Esta opção foi removida por outra pessoa. Seu rascunho foi mantido para conferência. Cancele a edição e crie uma nova opção se desejar recuperá-la.",
        );
      }
      const parent = draft.parent_id
        ? items.find((item) => item.id === draft.parent_id)
        : null;
      if (
        draft.parent_id &&
        (!parent ||
          parent.type !== "submenu" ||
          draft.parent_id === draft.id ||
          menuDescendants(items, draft.id).has(draft.parent_id))
      ) {
        setMenus(items);
        throw Error(
          "O submenu de destino mudou ou não é válido. Escolha novamente onde esta opção aparece.",
        );
      }
      if (draft.type !== "submenu" && menuDescendants(items, draft.id).size) {
        setMenus(items);
        throw Error(
          "Este submenu tem opções dentro. Mova ou remova essas opções antes de alterar o destino.",
        );
      }
      const next = current
        ? items.map((item) => (item.id === draft.id ? draft : item))
        : [...items, draft];
      if (
        await state.write("/settings", "PUT", {
          menus: next,
          menus_revision: latest.revision,
        })
      ) {
        setDraft(null);
        original.current = null;
      }
      if (!props.demo) await load();
    } finally {
      setPending(false);
    }
  }
  function reviewRemoval(item: MenuItem) {
    state.setError("");
    const ids = [item.id, ...menuDescendants(menus, item.id)];
    setRemoval({
      id: item.id,
      ids,
      snapshots: Object.fromEntries(
        menus
          .filter((menu) => ids.includes(menu.id))
          .map((menu) => [menu.id, menuSnapshot(menu)]),
      ),
    });
  }
  async function remove() {
    if (!removal || pending) return;
    setPending(true);
    try {
      const latest = props.demo
        ? { data: menus, revision: undefined }
        : await props.api(props.root + "/menus");
      const items: MenuItem[] = latest.data;
      const ids = new Set([removal.id, ...menuDescendants(items, removal.id)]);
      if (
        ids.size !== removal.ids.length ||
        removal.ids.some(
          (id) =>
            !ids.has(id) ||
            !items.some(
              (item) =>
                item.id === id && menuSnapshot(item) === removal.snapshots[id],
            ),
        )
      ) {
        setMenus(items);
        setRemoval(null);
        throw Error(
          "As opções deste submenu mudaram. Revise a árvore e confira novamente a remoção.",
        );
      }
      if (
        await state.write("/settings", "PUT", {
          menus: items.filter((item) => !ids.has(item.id)),
          menus_revision: latest.revision,
        })
      )
        setRemoval(null);
      if (!props.demo) await load();
    } finally {
      setPending(false);
    }
  }
  function renderTree(nodes: MenuTreeNode[]): React.ReactNode {
    return (
      <ul className="menu-tree">
        {nodes.map(({ item: m, children, detached }) => (
          <li className="menu-tree-node" key={m.id}>
            <div className="menu-tree-row">
              <div className="menu-tree-content">
                <strong>{m.label}</strong>
                <small className="menu-breadcrumb">
                  {menuPath(menus, m.parent_id)}
                </small>
                <small>
                  {m.type === "submenu"
                    ? "Submenu"
                    : (
                        {
                          human: "Equipe humana",
                          bot: "Bot especialista",
                          app: "Aplicativo",
                          link: "Link",
                          content: "Conteúdo",
                          protocols: "Consulta de protocolos",
                          survey: "Avaliação",
                        } as Row
                      )[m.type]}{" "}
                  ·{" "}
                  {m.trigger === "manual"
                    ? "Chamado pela equipe"
                    : "Automático"}{" "}
                  · {m.enabled !== false ? "Habilitado" : "Desabilitado"}
                </small>
                {m.type === "human" && (
                  <small>
                    {m.department_id
                      ? "Setor: " +
                        (departments.find((d) => d.id === m.department_id)
                          ?.name || "indisponível")
                      : "Fila geral"}
                  </small>
                )}
                <small>
                  {m.line_ids?.length
                    ? m.line_ids
                        .map(
                          (id: string) =>
                            lines.find((line) => line.id === id)?.name || id,
                        )
                        .join(", ")
                    : "Todas as linhas permitidas pelo menu pai"}
                </small>
                {detached && (
                  <p className="notice error">
                    Esta opção precisa de um menu pai válido. Use Editar para
                    escolher onde ela aparece.
                  </p>
                )}
                {m.type === "submenu" && !children.length && (
                  <p className="menu-tree-empty">
                    Submenu vazio. Adicione a primeira opção dentro dele para o
                    cliente poder usá-lo.
                  </p>
                )}
              </div>
              <div className="menu-tree-actions">
                {m.type === "submenu" && (
                  <>
                    <button
                      type="button"
                      disabled={busy || !!draft || !!removal}
                      onClick={() => edit(undefined, m.id)}
                      aria-label={"Adicionar opção dentro de " + m.label}
                    >
                      Adicionar opção dentro
                    </button>
                    <button
                      type="button"
                      disabled={busy || !!draft || !!removal}
                      onClick={() => edit(undefined, m.id, "submenu")}
                      aria-label={"Criar submenu dentro de " + m.label}
                    >
                      Criar submenu dentro
                    </button>
                  </>
                )}
                <button
                  type="button"
                  disabled={busy || !!draft || !!removal}
                  onClick={() => edit(m)}
                  aria-label={"Editar ou mover " + m.label}
                >
                  Editar / mover
                </button>
                <button
                  type="button"
                  disabled={busy || !!draft || !!removal}
                  onClick={() => reviewRemoval(m)}
                  aria-label={"Remover " + m.label}
                >
                  Remover
                </button>
              </div>
            </div>
            {removal?.id === m.id && (
              <div
                className="menu-delete-review"
                role="region"
                aria-label="Confirmar remoção do menu"
              >
                <strong>
                  Remover {m.label}
                  {removal.ids.length > 1 ? " e suas opções" : ""}?
                </strong>
                <p>
                  {removal.ids.length} opção(ões) será(ão) removida(s) do menu.
                  As conversas e seus históricos serão preservados.
                </p>
                {removal.ids.length > 1 && (
                  <ul>
                    {removal.ids
                      .filter((id) => id !== m.id)
                      .map((id) => (
                        <li key={id}>{menuPath(menus, id)}</li>
                      ))}
                  </ul>
                )}
                <div className="card-actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      remove().catch((err) => state.setError(err.message))
                    }
                  >
                    Confirmar remoção
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setRemoval(null)}
                  >
                    Cancelar remoção
                  </button>
                </div>
              </div>
            )}
            {children.length > 0 && renderTree(children)}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="service-panel">
      <div className="card">
        <div className="section-heading">
          <h2>Menus e submenus</h2>
          <div className="card-actions">
            <button
              className="primary"
              disabled={busy || !!draft || !!removal}
              onClick={() => edit()}
            >
              Adicionar opção principal
            </button>
            <button
              disabled={busy || !!draft || !!removal}
              onClick={() => edit(undefined, null, "submenu")}
            >
              Criar submenu
            </button>
          </div>
        </div>
        <p>
          Crie caminhos para conteúdo, links, bots, setores, protocolos e
          avaliações. No WhatsApp pela Zernio, até três opções curtas viram
          botões e até dez viram uma lista. Nos demais casos, o cliente recebe
          opções numeradas. As permissões da linha e dos menus pais continuam
          valendo. Um submenu organiza outras opções: crie-o e use Adicionar
          opção dentro para montar os próximos níveis.
        </p>
        <Feedback {...state} />
      </div>
      {draft && (
        <section className="card">
          <form
            className="service-form"
            onSubmit={(e) => {
              e.preventDefault();
              save().catch((err) => state.setError(err.message));
            }}
          >
            <fieldset className="menu-editor-fields" disabled={busy}>
              <h3
                className="menu-editor-heading"
                ref={editorHeading}
                tabIndex={-1}
              >
                {menus.some((m) => m.id === draft.id)
                  ? "Editar ou mover opção"
                  : draft.type === "submenu"
                    ? "Novo submenu"
                    : "Nova opção"}
              </h3>
              <p className="menu-breadcrumb">
                Caminho: {menuPath(menus, draft.parent_id)} ›{" "}
                {draft.label || "Nova opção"}
              </p>
              {conflicted && (
                <div className="notice error">
                  <p>
                    {menus.some((m) => m.id === draft.id)
                      ? "Seu rascunho foi mantido para conferência. Reabrir a versão salva substitui os campos deste formulário."
                      : "A opção não existe mais. Você pode copiar os campos deste rascunho antes de cancelar a edição e cadastrar uma nova opção."}
                  </p>
                  {menus.some((m) => m.id === draft.id) && (
                    <button
                      type="button"
                      onClick={() =>
                        edit(menus.find((m) => m.id === draft.id)!)
                      }
                    >
                      Reabrir versão salva
                    </button>
                  )}
                </div>
              )}
              <label>
                Texto da opção
                <input
                  required
                  maxLength={100}
                  value={draft.label}
                  onChange={(e) =>
                    setDraft({ ...draft, label: e.target.value })
                  }
                />
              </label>
              <div className="service-fields">
                <label>
                  Onde esta opção aparece
                  <select
                    value={draft.parent_id || ""}
                    onChange={(e) =>
                      setDraft({ ...draft, parent_id: e.target.value || null })
                    }
                  >
                    <option value="">Menu principal</option>
                    {menuParentChoices(menus, draft.id).map((m) => (
                      <option key={m.id} value={m.id}>
                        {menuPath(menus, m.id)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Destino
                  <select
                    value={draft.type}
                    disabled={
                      draft.type === "submenu" &&
                      menuDescendants(menus, draft.id).size > 0
                    }
                    onChange={(e) =>
                      setDraft({ ...draft, type: e.target.value })
                    }
                  >
                    <option value="human">Equipe humana</option>
                    <option value="bot">Bot</option>
                    <option value="submenu">Submenu</option>
                    <option value="app">Aplicativo</option>
                    <option value="link">Conteúdo com link</option>
                    <option value="content">Mensagem informativa</option>
                    <option value="protocols">Consultar protocolos</option>
                    <option value="survey">Avaliar atendimento</option>
                  </select>
                </label>
              </div>
              {draft.type === "submenu" && (
                <p>
                  Salve o submenu e use Adicionar opção dentro na árvore abaixo.
                  Para mudar o destino de um submenu que já tem filhos, mova ou
                  remova os filhos primeiro.
                </p>
              )}
              {draft.type === "human" && (
                <label>
                  Setor responsável
                  <select
                    value={draft.department_id || ""}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        department_id: e.target.value || null,
                      })
                    }
                  >
                    <option value="">Fila geral da equipe</option>
                    {departments.map((department) => (
                      <option key={department.id} value={department.id}>
                        {department.name}
                        {department.enabled === false ? " · desativado" : ""}
                      </option>
                    ))}
                  </select>
                  <small>
                    Somente pessoas do setor ou administradores podem assumir.
                    Sem membros disponíveis, é aberto um protocolo. Cadastre os
                    setores abaixo.
                  </small>
                </label>
              )}
              {["link", "content"].includes(draft.type) && (
                <label>
                  {draft.type === "link"
                    ? "Texto que acompanha o link (opcional)"
                    : "Conteúdo da resposta"}
                  <textarea
                    required={draft.type === "content"}
                    maxLength={draft.type === "link" ? 3000 : 3500}
                    value={draft.content || ""}
                    onChange={(e) =>
                      setDraft({ ...draft, content: e.target.value })
                    }
                  />
                </label>
              )}
              {draft.type === "link" && (
                <label>
                  Link do conteúdo
                  <input
                    required
                    type="url"
                    placeholder="https://seusistema.com/ajuda"
                    value={draft.url || ""}
                    onChange={(e) =>
                      setDraft({ ...draft, url: e.target.value })
                    }
                  />
                </label>
              )}
              {draft.type === "protocols" && (
                <p>
                  A opção reconhece os protocolos do telefone do cliente nesta
                  área de atendimento, inclusive em outras linhas. Depois, o
                  cliente pode digitar o número completo para consultar um
                  protocolo específico.
                </p>
              )}
              {draft.type === "survey" && (
                <label>
                  Pergunta da avaliação (opcional)
                  <input
                    maxLength={300}
                    placeholder="Como você avalia este atendimento?"
                    value={draft.question || ""}
                    onChange={(e) =>
                      setDraft({ ...draft, question: e.target.value })
                    }
                  />
                  <small>
                    O cliente responde de 1 a 5, com comentário opcional. Enviar
                    MENU sai da avaliação.
                  </small>
                </label>
              )}
              {draft.type === "bot" && (
                <label>
                  Bot
                  <select
                    required
                    value={draft.bot_id || ""}
                    onChange={(e) =>
                      setDraft({ ...draft, bot_id: e.target.value })
                    }
                  >
                    <option value="">Selecione</option>
                    {bots.map((b) => (
                      <option value={b.id} key={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {draft.type === "app" && (
                <label>
                  Aplicativo
                  <select
                    required
                    value={draft.app_id || ""}
                    onChange={(e) =>
                      setDraft({ ...draft, app_id: e.target.value })
                    }
                  >
                    <option value="">Selecione</option>
                    {apps.map((a) => (
                      <option value={a.id} key={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                  {!apps.length && (
                    <small>
                      Cadastre o aplicativo nas configurações da área de
                      atendimento pela API.
                    </small>
                  )}
                </label>
              )}
              <label>
                Quando esta opção aparece
                <select
                  value={draft.trigger}
                  onChange={(e) =>
                    setDraft({ ...draft, trigger: e.target.value })
                  }
                >
                  <option value="automatic">
                    No menu automático e quando chamado pela equipe
                  </option>
                  <option value="manual">
                    Quando uma pessoa ou bot chamar o menu
                  </option>
                </select>
              </label>
              <fieldset>
                <legend>Linhas onde esta opção funciona</legend>
                <p>
                  Nenhuma seleção significa todas as linhas permitidas pelo menu
                  pai.
                </p>
                <LineChoices
                  lines={lines}
                  value={draft.line_ids}
                  onChange={(line_ids) => setDraft({ ...draft, line_ids })}
                />
              </fieldset>
              <label className="check-line">
                <input
                  type="checkbox"
                  checked={!!draft.enabled}
                  onChange={(e) =>
                    setDraft({ ...draft, enabled: e.target.checked })
                  }
                />
                Opção habilitada
              </label>
              <div className="card-actions">
                <button className="primary" disabled={busy || conflicted}>
                  {draft.type === "submenu" ? "Salvar submenu" : "Salvar opção"}
                </button>
                <button
                  type="button"
                  onClick={() => setDraft(null)}
                  disabled={busy}
                >
                  Cancelar
                </button>
              </div>
            </fieldset>
          </form>
        </section>
      )}
      <section className="card">
        <h3>Menu principal</h3>
        <p>
          As opções aparecem abaixo do submenu a que pertencem. Use Editar /
          mover para trocar o menu pai.
        </p>
        {renderTree(menuTree(menus))}
        {!menus.length && (
          <p>
            Nenhuma opção cadastrada. Use Adicionar opção principal ou Criar
            submenu.
          </p>
        )}
      </section>
      <DepartmentsEditor {...props} saved={load} />
    </div>
  );
}

function DepartmentsEditor(props: Props & { saved: () => Promise<void> }) {
  const state = useWrite(props);
  const [departments, setDepartments] = useState<Row[]>([]),
    [people, setPeople] = useState<Row[]>([]),
    [draft, setDraft] = useState<Row | null>(null);
  async function load() {
    if (props.demo) {
      setPeople([{ id: "demo-user", name: "Administrador", role: "admin" }]);
      return;
    }
    const [status, users] = await Promise.all([
      props.api(props.root + "/status"),
      props.api("v1/users"),
    ]);
    const profile = props.root.split("/").at(-1);
    setDepartments(status.settings?.departments || []);
    setPeople(
      (Array.isArray(users) ? users : users.data || []).filter(
        (user: Row) =>
          !user.disabled &&
          (user.role === "admin" || parse(user.profiles, []).includes(profile)),
      ),
    );
  }
  useEffect(() => {
    load().catch((e) => state.setError(e.message));
  }, [props.root]);
  async function save() {
    if (!draft) return;
    const latest = props.demo
      ? departments
      : (await props.api(props.root + "/status")).settings?.departments || [];
    const next = latest.some((item: Row) => item.id === draft.id)
      ? latest.map((item: Row) => (item.id === draft.id ? draft : item))
      : [...latest, draft];
    if (await state.write("/settings", "PUT", { departments: next })) {
      setDraft(null);
      await load();
      await props.saved();
    }
  }
  return (
    <section className="card">
      <div className="section-heading">
        <h2>Setores de atendimento</h2>
        <button
          onClick={() =>
            setDraft({
              id: crypto.randomUUID(),
              name: "",
              members: [],
              enabled: true,
            })
          }
        >
          Adicionar setor
        </button>
      </div>
      <p>
        Monte filas como Financeiro, Comercial e Suporte. A disponibilidade é a
        mesma informada pela equipe; somente membros do setor ou administradores
        podem assumir e responder.
      </p>
      <Feedback {...state} />
      {draft && (
        <form
          className="service-form"
          onSubmit={(e) => {
            e.preventDefault();
            save().catch((err) => state.setError(err.message));
          }}
        >
          <label>
            Nome do setor
            <input
              required
              maxLength={100}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <fieldset>
            <legend>Pessoas que atendem este setor</legend>
            {draft.members
              .filter(
                (id: string) => !people.some((person) => person.id === id),
              )
              .map((id: string) => (
                <div className="check-line" key={id}>
                  <span>
                    Pessoa sem acesso ativo a esta área de atendimento
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        members: draft.members.filter(
                          (member: string) => member !== id,
                        ),
                      })
                    }
                  >
                    Remover do setor
                  </button>
                </div>
              ))}
            {people.map((person) => (
              <label className="check-line" key={person.id}>
                <input
                  type="checkbox"
                  checked={draft.members.includes(person.id)}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      members: e.target.checked
                        ? [...draft.members, person.id]
                        : draft.members.filter(
                            (id: string) => id !== person.id,
                          ),
                    })
                  }
                />
                {person.name}
              </label>
            ))}
            {!people.length && (
              <p>
                Cadastre pessoas em Equipe → Pessoas e acessos, com acesso a
                esta área de atendimento.
              </p>
            )}
          </fieldset>
          <label className="check-line">
            <input
              type="checkbox"
              checked={draft.enabled !== false}
              onChange={(e) =>
                setDraft({ ...draft, enabled: e.target.checked })
              }
            />
            Setor habilitado
          </label>
          <div className="card-actions">
            <button className="primary" disabled={state.busy}>
              Salvar setor
            </button>
            <button type="button" onClick={() => setDraft(null)}>
              Cancelar
            </button>
          </div>
        </form>
      )}
      {departments.map((department) => (
        <div className="service-menu-row" key={department.id}>
          <div>
            <strong>{department.name}</strong>
            <small>
              {department.members.length} pessoa(s) ·{" "}
              {department.enabled === false ? "Desativado" : "Habilitado"}
            </small>
          </div>
          <button
            onClick={() =>
              setDraft({ ...department, members: [...department.members] })
            }
          >
            Editar setor
          </button>
        </div>
      ))}
      {!departments.length && (
        <p>Sem setores cadastrados, os encaminhamentos usam a fila geral.</p>
      )}
    </section>
  );
}

export function ConversationMenu({
  conversation,
  refresh,
  ...props
}: Props & { conversation: Row; refresh: () => Promise<any> }) {
  const [menus, setMenus] = useState<Row[]>([]),
    [open, setOpen] = useState(false),
    [selected, setSelected] = useState(""),
    [departments, setDepartments] = useState<Row[]>([]),
    [department, setDepartment] = useState(""),
    [protocol, setProtocol] = useState("");
  const state = useWrite(props);
  async function show() {
    setOpen(true);
    try {
      if (!props.demo)
        setDepartments(
          (await props.api(props.root + "/status")).settings?.departments || [],
        );
      setMenus(
        props.demo
          ? demoMenus
          : (
              await props.api(
                props.root +
                  "/menus?connection_id=" +
                  encodeURIComponent(conversation.connection_id || ""),
              )
            ).data,
      );
    } catch (e: any) {
      state.setError(e.message);
    }
  }
  return (
    <div className="conversation-menu">
      <button onClick={show}>Enviar menu ao cliente</button>
      {open && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (
              await state.write(
                `/conversations/${conversation.id}/actions`,
                "POST",
                { action: "menu", menu_id: selected || null },
              )
            ) {
              setOpen(false);
              await refresh();
            }
          }}
        >
          <label>
            Menu a apresentar
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="">Menu principal</option>
              {menus
                .filter((m) => m.type === "submenu" && m.enabled !== false)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {menuPath(menus as MenuItem[], m.id)}
                  </option>
                ))}
            </select>
          </label>
          <small>
            O cliente poderá tocar ou digitar uma opção. A janela de 24 horas e
            as permissões desta linha continuam valendo.
          </small>
          <div className="card-actions">
            <button className="primary" disabled={state.busy}>
              Enviar menu
            </button>
            <button
              type="button"
              disabled={state.busy}
              onClick={() => setOpen(false)}
            >
              Cancelar
            </button>
          </div>
        </form>
      )}
      {conversation.chat_type !== "group" && (
        <details>
          <summary>Protocolos, avaliação e setores</summary>
          <label>
            Número do protocolo (opcional)
            <input
              value={protocol}
              onChange={(e) => setProtocol(e.target.value)}
              placeholder="Em branco: protocolos do telefone"
            />
          </label>
          <div className="card-actions">
            <button
              disabled={state.busy}
              onClick={async () => {
                if (
                  await state.write(
                    `/conversations/${conversation.id}/actions`,
                    "POST",
                    {
                      action: "protocols",
                      number: protocol.trim() || undefined,
                    },
                  )
                )
                  await refresh();
              }}
            >
              Enviar consulta ao cliente
            </button>
            <button
              disabled={state.busy}
              onClick={async () => {
                if (
                  await state.write(
                    `/conversations/${conversation.id}/actions`,
                    "POST",
                    { action: "survey" },
                  )
                )
                  await refresh();
              }}
            >
              Pedir avaliação
            </button>
            <button
              disabled={state.busy}
              onClick={async () => {
                try {
                  setDepartments(
                    props.demo
                      ? []
                      : (await props.api(props.root + "/status")).settings
                          ?.departments || [],
                  );
                } catch (e: any) {
                  state.setError(e.message);
                }
              }}
            >
              Carregar setores
            </button>
          </div>
          {departments.length > 0 && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (
                  await state.write(
                    `/conversations/${conversation.id}/actions`,
                    "POST",
                    { action: "transfer", department_id: department },
                  )
                )
                  await refresh();
              }}
            >
              <label>
                Encaminhar para setor
                <select
                  required
                  value={department}
                  onChange={(e) => setDepartment(e.target.value)}
                >
                  <option value="">Selecione o setor</option>
                  {departments
                    .filter((d) => d.enabled !== false)
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                </select>
              </label>
              <button disabled={state.busy}>
                Encaminhar para a fila do setor
              </button>
            </form>
          )}
        </details>
      )}
      <Feedback {...state} />
    </div>
  );
}
