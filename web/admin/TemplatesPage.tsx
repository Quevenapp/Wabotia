// Modelos de atendimento (docs/CENTRAL-ATENDIMENTO.md §7): pré-visualização,
// escolha de modo e de bot, aplicação com confirmação e resumo do resultado.
import React, { useEffect, useState } from "react";
import {
  ArrowRight,
  Bot,
  CalendarClock,
  Check,
  FileText,
  FolderTree,
  LayoutTemplate,
  ListChecks,
  MessageSquareText,
  Tags,
  Users,
} from "lucide-react";
import { useApp } from "../app/AppContext";
import { useIntents, type Row } from "../lib/api";
import { linkProps, type Route } from "../lib/routes";
import {
  Button,
  Confirm,
  Empty,
  Field,
  Notice,
  Pill,
  Segmented,
  SkeletonBlock,
  toast,
} from "../ui";
import { menuTree, type MenuItem, type MenuTreeNode } from "../menu-tree";
import type { PageId } from "../workspace-navigation";
import { useResource } from "./shared";

type Mode = "merge" | "replace";

const typeNames: Row = {
  submenu: "Submenu",
  bot: "Bot atendente",
  ticket: "Abrir protocolo",
  protocols: "Consulta de protocolos",
  human: "Equipe humana",
  content: "Mensagem informativa",
  link: "Conteúdo com link",
  app: "Aplicativo",
  survey: "Avaliação",
};
const typeTones: Row = {
  submenu: "muted",
  bot: "bot",
  ticket: "ticket",
  protocols: "ticket",
  human: "brand",
};
const settingNames: Row = {
  protocol_response_unit: "Unidade do prazo",
  protocol_response_days: "Prazo em dias úteis",
  business_hours: "Dias e horário de atendimento",
  instructions: "Orientações ao Bot Atendente",
  protocol_confirmation: "Mensagem de confirmação do protocolo",
  menu_greeting: "Saudação do menu principal",
};
const weekdays = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const groupNames: [string, string][] = [
  ["departments", "Setores"],
  ["categories", "Categorias"],
  ["menus", "Opções de menu"],
  ["settings", "Textos e prazos"],
];
const outcomes: [string, string, "ok" | "muted" | "warn" | "danger"][] = [
  ["created", "Criado", "ok"],
  ["replaced", "Substituído", "warn"],
  ["kept", "Mantido", "muted"],
  ["removed", "Removido", "danger"],
  ["skipped", "Não criado", "danger"],
];
/** Atalho do painel para cada pendência devolvida pelo servidor. */
const pendingLinks: Record<string, [PageId, string]> = {
  department_members: ["menus", "Abrir setores em Menus e ações"],
  bot_missing: ["connections", "Conectar o Hermes"],
  bot_disabled: ["bots", "Abrir Atendente e especialistas"],
  attendant_bot: ["bots", "Escolher o Bot Atendente"],
  connect_whatsapp: ["router", "Abrir Integração Zernio"],
  activate: ["settings", "Abrir Regras de atendimento"],
  menu_conflict: ["menus", "Abrir Menus e ações"],
  review_texts: ["menus", "Revisar textos em Menus e ações"],
  knowledge: ["knowledge", "Abrir Conhecimento"],
  notification_template: ["router", "Abrir Integração Zernio"],
};

function MenuPreview({ nodes, departments }: { nodes: MenuTreeNode[]; departments: Row[] }) {
  return (
    <ul className="template-tree">
      {nodes.map(({ item, children }) => (
        <li key={item.id}>
          <div className="template-tree-row">
            <strong>{item.label}</strong>
            <Pill tone={typeTones[item.type] || "muted"}>
              {typeNames[item.type] || item.type}
            </Pill>
            {item.type === "human" && item.department_id && (
              <small className="muted">
                {departments.find((entry) => entry.id === item.department_id)
                  ?.name || item.department_id}
              </small>
            )}
          </div>
          {children.length > 0 && (
            <MenuPreview nodes={children} departments={departments} />
          )}
        </li>
      ))}
    </ul>
  );
}

function deadlineText(settings: Row) {
  const hours = settings.business_hours || {};
  const days = (hours.days || []).map((day: number) => weekdays[day]).join(", ");
  return settings.protocol_response_unit === "business_days"
    ? `${settings.protocol_response_days} dias úteis · ${days} · ${hours.start}–${hours.end} (horário de Brasília)`
    : `${settings.protocol_response_hours ?? 24} horas`;
}

function Result({
  result,
  template,
  onClose,
}: {
  result: Row;
  template: Row;
  onClose: () => void;
}) {
  const app = useApp();
  const wanted = template.settings || {};
  const nameOf = (group: string, id: string) =>
    group === "settings"
      ? settingNames[id] || id
      : (
          (group === "departments"
            ? [...(wanted.departments || []), ...(app.settings.departments || [])]
            : group === "categories"
              ? [
                  ...(wanted.ticket_categories || []),
                  ...(app.settings.ticket_categories || []),
                ]
              : [...(wanted.menus || []), ...(app.settings.menus || [])]
          ).find((entry: Row) => entry.id === id) || {}
        ).name ||
        (wanted.menus || []).find((entry: Row) => entry.id === id)?.label ||
        (app.settings.menus || []).find((entry: Row) => entry.id === id)?.label ||
        id;
  const next: [Route, string][] = [
    [{ area: "admin", page: "menus" }, "Adicionar pessoas aos setores"],
    [{ area: "admin", page: "menus" }, "Revisar textos do menu"],
    [{ area: "admin", page: "knowledge" }, "Cadastrar conhecimento"],
    [{ area: "admin", page: "router" }, "Conectar o WhatsApp"],
    [{ area: "admin", page: "users" }, "Pessoas e acessos"],
  ];
  return (
    <section className="card template-result" aria-live="polite">
      <div className="card-heading">
        <div>
          <h2>
            <Check size={18} aria-hidden /> Modelo aplicado
          </h2>
          <p>
            Modo{" "}
            {result.mode === "replace"
              ? "Substituir configuração"
              : "Acrescentar ao que existe"}
            {" · "}
            {result.bot_id
              ? "Bot das opções de ajuda: " +
                (app.bots.find((bot) => bot.id === result.bot_id)?.name ||
                  result.bot_id)
              : "sem bot: as opções de ajuda viraram mensagens informativas"}
          </p>
        </div>
        <Button secondary size="sm" onClick={onClose}>
          Fechar resumo
        </Button>
      </div>
      <div className="result-grid">
        {groupNames.map(([group, label]) => (
          <div className="result-group" key={group}>
            <h3>{label}</h3>
            {outcomes.every(([key]) => !(result[key]?.[group] || []).length) ? (
              <p className="muted">Nada alterado.</p>
            ) : (
              outcomes.map(([key, outcome, tone]) => {
                const ids: string[] = result[key]?.[group] || [];
                if (!ids.length) return null;
                return (
                  <details key={key}>
                    <summary>
                      <Pill tone={tone}>
                        {outcome} · {ids.length}
                      </Pill>
                    </summary>
                    <ul>
                      {ids.map((id) => (
                        <li key={id}>{nameOf(group, id)}</li>
                      ))}
                    </ul>
                  </details>
                );
              })
            )}
          </div>
        ))}
      </div>
      {(result.pending || []).length > 0 && (
        <>
          <h3>O que ainda depende de você</h3>
          <ul className="pending-list">
            {result.pending.map((item: Row, index: number) => {
              const link = pendingLinks[item.code];
              return (
                <li key={item.code + index}>
                  <span>{item.message}</span>
                  {link && (
                    <a
                      className="text-link"
                      {...linkProps({ area: "admin", page: link[0] })}
                    >
                      {link[1]} <ArrowRight size={14} />
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
      <h3>Próximos passos</h3>
      <div className="card-actions">
        {next.map(([route, label]) => (
          <a className="button secondary sm" key={label} {...linkProps(route)}>
            {label}
          </a>
        ))}
      </div>
    </section>
  );
}

export function TemplatesPage() {
  const app = useApp();
  const write = useIntents(app.api);
  const catalogue = useResource("v1/service-templates");
  const templates: Row[] = catalogue.data?.data || [];
  const [selected, setSelected] = useState("");
  const [mode, setMode] = useState<Mode>("merge"),
    [botId, setBotId] = useState(""),
    [confirming, setConfirming] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [result, setResult] = useState<Row | null>(null);
  useEffect(() => {
    if (!selected && templates[0]) setSelected(templates[0].id);
  }, [templates.length]);
  const template = templates.find((entry) => entry.id === selected);
  const wanted: Row = template?.settings || {};

  async function apply() {
    if (!template || app.demoBlocked()) return;
    setBusy(true);
    setError("");
    try {
      const summary = await write(
        `${app.root}/service-templates/${template.id}/apply`,
        "POST",
        { mode, ...(botId ? { bot_id: botId } : {}) },
      );
      setResult(summary);
      setConfirming(false);
      toast("Modelo aplicado.");
      await app.refresh().catch(() => {});
    } catch (e: any) {
      setError(e.message);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  if (catalogue.error)
    return (
      <Notice tone="error" onRetry={() => void catalogue.reload()}>
        {catalogue.error}
      </Notice>
    );
  if (!catalogue.loaded) return <SkeletonBlock height={280} />;
  if (!templates.length)
    return (
      <section className="card">
        <Empty
          icon={<LayoutTemplate size={28} />}
          title="Nenhum modelo disponível"
          description="Os modelos de atendimento desta versão aparecerão aqui."
        />
      </section>
    );
  return (
    <>
      <div className="template-cards" role="list">
        {templates.map((entry) => (
          <button
            type="button"
            role="listitem"
            key={entry.id}
            className={"template-card" + (entry.id === selected ? " selected" : "")}
            aria-pressed={entry.id === selected}
            onClick={() => {
              setSelected(entry.id);
              setResult(null);
            }}
          >
            <span className="template-card-icon">
              <LayoutTemplate size={22} />
            </span>
            <span>
              <strong>{entry.name}</strong>
              <span>{entry.description}</span>
              <small>{entry.summary}</small>
            </span>
          </button>
        ))}
      </div>
      {result && template && (
        <Result result={result} template={template} onClose={() => setResult(null)} />
      )}
      {template && (
        <div className="template-layout">
          <div className="template-preview">
            <section className="card">
              <h2>
                <FolderTree size={18} aria-hidden /> Menu principal
              </h2>
              <MenuPreview
                nodes={menuTree((wanted.menus || []) as MenuItem[])}
                departments={wanted.departments || []}
              />
              <p className="muted template-note">
                As opções de bot usam o bot escolhido ao lado; sem bot nenhum,
                viram mensagens informativas que orientam a descrever a dúvida
                ou abrir protocolo.
              </p>
            </section>
            {wanted.menu_greeting && (
              <section className="card">
                <h2>
                  <MessageSquareText size={18} aria-hidden /> Saudação do menu
                  principal
                </h2>
                <div className="preview-bubble">{wanted.menu_greeting}</div>
              </section>
            )}
            <div className="template-columns">
              <section className="card">
                <h2>
                  <Users size={18} aria-hidden /> Setores
                </h2>
                <ul className="plain-list">
                  {(wanted.departments || []).map((entry: Row) => (
                    <li key={entry.id}>{entry.name}</li>
                  ))}
                </ul>
                <p className="muted template-note">
                  Criados sem pessoas. Adicione os membros depois.
                </p>
              </section>
              <section className="card">
                <h2>
                  <Tags size={18} aria-hidden /> Categorias de protocolo
                </h2>
                <div className="pill-wrap">
                  {(wanted.ticket_categories || []).map((entry: Row) => (
                    <Pill tone="ticket" key={entry.id}>
                      {entry.name}
                    </Pill>
                  ))}
                </div>
              </section>
            </div>
            <section className="card">
              <h2>
                <CalendarClock size={18} aria-hidden /> Prazo da primeira
                resposta
              </h2>
              <p>{deadlineText(wanted)}</p>
              <p className="muted template-note">
                Os feriados já cadastrados na área são mantidos.
              </p>
            </section>
            {wanted.instructions && (
              <details className="card">
                <summary>
                  <Bot size={17} aria-hidden /> Orientações ao atendente virtual
                </summary>
                <p className="template-text">{wanted.instructions}</p>
              </details>
            )}
            {wanted.protocol_confirmation && (
              <details className="card">
                <summary>
                  <FileText size={17} aria-hidden /> Mensagem de confirmação do
                  protocolo
                </summary>
                <p className="template-text">{wanted.protocol_confirmation}</p>
              </details>
            )}
            {(template.manual_steps || []).length > 0 && (
              <section className="card">
                <h2>
                  <ListChecks size={18} aria-hidden /> O que o modelo não
                  configura
                </h2>
                <ul className="plain-list bullets">
                  {template.manual_steps.map((step: string) => (
                    <li key={step}>{step}</li>
                  ))}
                </ul>
              </section>
            )}
          </div>
          <aside className="template-apply card">
            <h2>Aplicar “{template.name}”</h2>
            <Segmented
              label="Modo de aplicação"
              value={mode}
              onChange={setMode}
              full
              options={[
                { value: "merge", label: "Acrescentar" },
                { value: "replace", label: "Substituir" },
              ]}
            />
            <p className="template-mode">
              {mode === "merge" ? (
                <>
                  <strong>Acrescentar ao que existe.</strong> Cria só os
                  setores, categorias e opções de menu que ainda não existem.
                  Nada é alterado nem removido; textos e prazos só são gravados
                  se ainda estiverem no padrão.
                </>
              ) : (
                <>
                  <strong>Substituir configuração.</strong> Troca menus,
                  setores, categorias, prazo, horário e textos pelos do modelo.
                  O que você criou à mão nessas listas é removido. Conversas e
                  protocolos existentes não são tocados.
                </>
              )}
            </p>
            <Field
              label="Bot das opções de ajuda"
              value={botId}
              onChange={setBotId}
              options={app.bots.map((bot) => [
                bot.id,
                bot.name + (bot.enabled ? "" : " · desabilitado"),
              ])}
              emptyOption="Automático (Bot Atendente da área)"
              help="Sem escolha: o Bot Atendente da área; se não houver, o primeiro bot habilitado."
            />
            {error && (
              <Notice tone="error" onRetry={() => void apply()} busy={busy}>
                {error}
              </Notice>
            )}
            <Button
              full
              variant={mode === "replace" ? "danger" : "primary"}
              busy={busy}
              onClick={() => {
                if (!app.demoBlocked()) setConfirming(true);
              }}
            >
              {mode === "replace"
                ? "Substituir pela configuração do modelo"
                : "Aplicar modelo"}
            </Button>
          </aside>
        </div>
      )}
      {confirming && template && (
        <Confirm
          title={
            mode === "replace"
              ? "Substituir a configuração atual?"
              : "Aplicar o modelo?"
          }
          confirmLabel={mode === "replace" ? "Substituir tudo" : "Aplicar"}
          danger={mode === "replace"}
          busy={busy}
          onClose={() => setConfirming(false)}
          onConfirm={() => void apply()}
        >
          {mode === "replace" ? (
            <p>
              Os menus, setores, categorias, prazo, horário, orientações,
              saudação e mensagem de confirmação desta área serão trocados
              pelos de “{template.name}”. Itens criados à mão nessas listas
              serão removidos e isso não pode ser desfeito pelo painel.
              Conversas e protocolos não são alterados: os que usam um setor
              ou uma categoria removidos continuam marcados com ele, e você
              precisa realocá-los.
            </p>
          ) : (
            <p>
              “{template.name}” vai acrescentar o que ainda não existe nesta
              área. Nada do que já está configurado será alterado ou removido.
            </p>
          )}
        </Confirm>
      )}
    </>
  );
}
