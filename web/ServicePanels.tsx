import React, { useEffect, useRef, useState } from "react";
import { NumberPolicyEditor } from "./NumberPolicyEditor";
import { numberPolicyPresets } from "../src/number-policy";

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
    kind: "meta",
    number_policy: numberPolicyPresets.official,
    service: { mode: "bot", bot_id: "demo-bot", menu_mode: "automatic" },
  },
  {
    id: "line-support",
    name: "Atendimento da loja",
    number: "5511999990002",
    status: "active",
    kind: "meta",
    number_policy: numberPolicyPresets.official,
    service: { mode: "human", bot_id: null, menu_mode: "manual" },
  },
];
const demoBots: Row[] = [
  { id: "demo-bot", name: "Atendente", enabled: 1, line_ids: null },
];
const demoMenus: Row[] = [
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
  return { busy, error, notice, write, setError };
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
      {!lines.length && <p>Nenhuma linha cadastrada neste perfil.</p>}
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
            <option value="inherit">Bot padrão do perfil</option>
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
          Cadastre novas linhas em Conexões ou Roteador de números. Os
          atendimentos mantêm o número de origem, inclusive após a franquia
          gratuita.
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
            <option value="all">Todas as linhas do perfil</option>
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
  const [menus, setMenus] = useState<Row[]>(props.demo ? demoMenus : []),
    [lines, setLines] = useState<Row[]>(props.demo ? demoLines : []),
    [bots, setBots] = useState<Row[]>(props.demo ? demoBots : []),
    [apps, setApps] = useState<Row[]>([]),
    [draft, setDraft] = useState<Row | null>(null);
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
  }
  useEffect(() => {
    load().catch((e) => state.setError(e.message));
  }, [props.root]);
  const edit = (menu?: Row) =>
    setDraft(
      menu
        ? {
            ...menu,
            line_ids: menu.line_ids || [],
            trigger: menu.trigger || "automatic",
          }
        : {
            id: crypto.randomUUID(),
            label: "",
            type: "human",
            parent_id: null,
            trigger: "automatic",
            line_ids: [],
            enabled: true,
          },
    );
  async function save() {
    if (!draft) return;
    // Read the latest list so saving this item preserves other operators' new items.
    const latest = props.demo
      ? menus
      : (await props.api(props.root + "/menus")).data;
    const next = latest.some((m: Row) => m.id === draft.id)
      ? latest.map((m: Row) => (m.id === draft.id ? draft : m))
      : [...latest, draft];
    if (await state.write("/settings", "PUT", { menus: next })) {
      setDraft(null);
      await load();
    }
  }
  const descendant = (id: string, parent: string): boolean => {
    const seen = new Set<string>();
    let node = menus.find((m) => m.id === id);
    while (node?.parent_id && !seen.has(node.id)) {
      seen.add(node.id);
      if (node.parent_id === parent) return true;
      node = menus.find((m) => m.id === node!.parent_id);
    }
    return false;
  };
  return (
    <div className="service-panel">
      <div className="card">
        <div className="section-heading">
          <h2>Menus e submenus</h2>
          <button className="primary" onClick={() => edit()}>
            Adicionar opção
          </button>
        </div>
        <p>
          Configure as opções que o cliente pode digitar, suas linhas e o
          momento de apresentação. As restrições da linha e do menu pai também
          se aplicam aos submenus.
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
            <h3>
              {menus.some((m) => m.id === draft.id)
                ? "Editar opção"
                : "Nova opção"}
            </h3>
            <label>
              Texto da opção
              <input
                required
                maxLength={100}
                value={draft.label}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
              />
            </label>
            <div className="service-fields">
              <label>
                Menu pai
                <select
                  value={draft.parent_id || ""}
                  onChange={(e) =>
                    setDraft({ ...draft, parent_id: e.target.value || null })
                  }
                >
                  <option value="">Menu principal</option>
                  {menus
                    .filter(
                      (m) =>
                        m.type === "submenu" &&
                        m.id !== draft.id &&
                        !descendant(m.id, draft.id),
                    )
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Destino
                <select
                  value={draft.type}
                  onChange={(e) => setDraft({ ...draft, type: e.target.value })}
                >
                  <option value="human">Equipe humana</option>
                  <option value="bot">Bot</option>
                  <option value="submenu">Submenu</option>
                  <option value="app">Aplicativo</option>
                </select>
              </label>
            </div>
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
                    Cadastre o aplicativo nas configurações do perfil pela API.
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
              <button className="primary" disabled={state.busy}>
                Salvar opção
              </button>
              <button
                type="button"
                onClick={() => setDraft(null)}
                disabled={state.busy}
              >
                Cancelar
              </button>
            </div>
          </form>
        </section>
      )}
      <section className="card">
        {menus.map((m) => (
          <div className="service-menu-row" key={m.id}>
            <div>
              <strong>
                {m.parent_id && "↳ "}
                {m.label}
              </strong>
              <small>
                {m.parent_id
                  ? `Em ${menus.find((p) => p.id === m.parent_id)?.label || "submenu"}`
                  : "Menu principal"}{" "}
                ·{" "}
                {m.trigger === "manual" ? "Chamado pela equipe" : "Automático"}{" "}
                · {m.enabled ? "Habilitado" : "Desabilitado"}
              </small>
              <small>
                {m.line_ids?.length
                  ? m.line_ids
                      .map(
                        (id: string) =>
                          lines.find((l) => l.id === id)?.name || id,
                      )
                      .join(", ")
                  : "Todas as linhas permitidas"}
              </small>
            </div>
            <button onClick={() => edit(m)}>Editar</button>
          </div>
        ))}
        {!menus.length && (
          <p>
            Adicione a primeira opção. Escolha “Submenu” para organizar opções
            dentro de outra.
          </p>
        )}
      </section>
    </div>
  );
}

export function ConversationMenu({
  conversation,
  refresh,
  ...props
}: Props & { conversation: Row; refresh: () => Promise<any> }) {
  const [menus, setMenus] = useState<Row[]>([]),
    [open, setOpen] = useState(false),
    [selected, setSelected] = useState("");
  const state = useWrite(props);
  async function show() {
    setOpen(true);
    try {
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
                .filter((m) => m.type === "submenu" && m.enabled)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
            </select>
          </label>
          <small>
            O cliente poderá digitar uma opção. A janela de 24 horas e as
            permissões desta linha continuam valendo.
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
      <Feedback {...state} />
    </div>
  );
}
