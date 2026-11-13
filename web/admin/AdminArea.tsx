// Gestão (web/DESIGN.md §2 e §8): coluna de navegação de administração e as
// páginas à direita, com as mesmas regras de quem pode ver o quê.
import React, { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Menu as MenuIcon, X } from "lucide-react";
import { useApp } from "../app/AppContext";
import { useCompact, useUnsavedGuard } from "../app/hooks";
import { linkProps, navigate, pageRoute } from "../lib/routes";
import { Button, Empty, PageHeader } from "../ui";
import {
  canOpenPage,
  pageDescriptions,
  sections,
  visibleGroups,
  type PageId,
} from "../workspace-navigation";
import { SetupWizard } from "../SetupWizard";
import { SystemPanel } from "../SystemPanel";
import { NumberRouter } from "../NumberRouter";
import { LinesPanel, MenusPanel } from "../ServicePanels";
import { OverviewPage } from "./OverviewPage";
import { ConnectionsPage } from "./ConnectionsPage";
import { ConnectionDialog } from "./ConnectionDialog";
import { BotsPage } from "./BotsPage";
import { KnowledgePage } from "./KnowledgePage";
import { SettingsPage } from "./SettingsPage";
import { UsersPage } from "./UsersPage";
import { ApplicationsPage } from "./ApplicationsPage";
import { TemplatesPage } from "./TemplatesPage";
import {
  GroupsPage,
  LogsPage,
  ReportsPage,
  SimpleListPage,
} from "./RecordsPages";
import "../styles/admin.css";

const SETUP_FLAG = "wabotia:setup-active";
const readFlag = () => {
  try {
    return sessionStorage.getItem(SETUP_FLAG) === "1";
  } catch {
    return false;
  }
};
const writeFlag = (on: boolean) => {
  try {
    if (on) sessionStorage.setItem(SETUP_FLAG, "1");
    else sessionStorage.removeItem(SETUP_FLAG);
  } catch {
    /* lembrete opcional */
  }
};

/** Páginas que funcionam sem uma área de atendimento aberta. */
const withoutProfile: ReadonlySet<string> = new Set([
  "users",
  "applications",
  "system",
  "setup",
]);
const section = (page: string) => sections.find(([id]) => id === page);

function SetupPage() {
  const app = useApp();
  const [dirty, setDirty] = useState(false),
    [revision, setRevision] = useState(0),
    [connecting, setConnecting] = useState<string | null>(null);
  useUnsavedGuard(dirty);
  // Depois de abrir o assistente, as outras páginas lembram de voltar a ele.
  useEffect(() => writeFlag(true), []);
  return (
    <>
      <SetupWizard
        key={app.profile}
        api={app.api}
        root={app.root}
        demo={app.demo}
        hasArea={!!app.profile}
        onNavigate={(page: string) => navigate(pageRoute(page))}
        onConnect={(kind: string) => setConnecting(kind)}
        onRetryArea={() => void app.reloadSession()}
        onRefresh={() => app.refresh()}
        refreshKey={revision}
        onDirtyChange={setDirty}
      />
      {connecting && (
        <ConnectionDialog
          initial={{ kind: connecting }}
          onClose={() => setConnecting(null)}
          onSaved={async () => {
            setRevision((value) => value + 1);
            await app.refresh().catch(() => {});
          }}
        />
      )}
    </>
  );
}

function Page({ page }: { page: PageId }) {
  const app = useApp();
  const { api, root, demo } = app;
  switch (page) {
    case "setup":
      return <SetupPage />;
    case "system":
      return <SystemPanel api={api} demo={demo} />;
    case "router":
      return <NumberRouter api={api} root={root} demo={demo} />;
    case "lines":
      return <LinesPanel api={api} root={root} demo={demo} />;
    case "menus":
      return <MenusPanel api={api} root={root} demo={demo} />;
    case "templates":
      return <TemplatesPage />;
    case "groups":
      return <GroupsPage />;
    case "connections":
      return <ConnectionsPage />;
    case "bots":
      return <BotsPage />;
    case "knowledge":
      return <KnowledgePage />;
    case "settings":
      return <SettingsPage />;
    case "users":
      return <UsersPage />;
    case "applications":
      return <ApplicationsPage />;
    case "reports":
      return <ReportsPage />;
    case "bot-runs":
    case "deliveries":
    case "webhook-deliveries":
      return <LogsPage page={page} />;
    case "surveys":
    case "consents":
      return <SimpleListPage page={page} />;
    default:
      return <OverviewPage />;
  }
}

function Navigation({
  page,
  onNavigate,
}: {
  page: PageId;
  onNavigate: () => void;
}) {
  const app = useApp();
  const groups = visibleGroups(app.me.role);
  const link = (id: PageId, label: string, Icon: any, child = false) => (
    <a
      key={id}
      {...linkProps({ area: "admin", page: id })}
      className={
        "admin-link" + (child ? " child" : "") + (page === id ? " active" : "")
      }
      aria-current={page === id ? "page" : undefined}
      onClickCapture={onNavigate}
    >
      <Icon size={child ? 17 : 19} aria-hidden />
      <span>{label}</span>
    </a>
  );
  return (
    <>
      <div className="admin-nav-head">
        <h1>Gestão</h1>
        <div className="admin-area-name">
          <strong>Área de atendimento</strong>
          <small>
            {app.profileName === "Área de atendimento"
              ? "Compartilhada pela equipe"
              : app.profileName || "Atendimento da empresa"}
          </small>
        </div>
        {app.profiles.length > 1 && (
          <details className="admin-areas">
            <summary>Áreas anteriores</summary>
            <p>
              Os dados anteriores permanecem separados para preservar os
              acessos.
            </p>
            <select
              aria-label="Área de atendimento anterior"
              value={app.profile}
              onChange={(event) => app.chooseProfile(event.target.value)}
            >
              {app.profiles.map((area) => (
                <option key={area.id} value={area.id}>
                  {area.name}
                </option>
              ))}
            </select>
          </details>
        )}
      </div>
      <nav className="admin-nav-list" aria-label="Páginas de gestão">
        {groups.map((group) =>
          group.pages.length === 1 ? (
            // Grupo de uma página só: vira um atalho direto.
            link(
              group.pages[0],
              section(group.pages[0])?.[1] || group.label,
              group.icon,
            )
          ) : (
            <div className="admin-group" key={group.id}>
              <h2>
                <group.icon size={15} aria-hidden />
                {group.label}
              </h2>
              {group.pages.map((id) => {
                const [, label, Icon] = section(id)!;
                return link(id, label, Icon, true);
              })}
            </div>
          ),
        )}
      </nav>
    </>
  );
}

export function AdminArea({ page: requested }: { page: PageId | string }) {
  const app = useApp();
  const compact = useCompact();
  const allowed =
    !!section(requested) && canOpenPage(requested, app.me.role);
  const page = (allowed ? requested : "overview") as PageId;
  const [drawer, setDrawer] = useState(false),
    [setupActive, setSetupActive] = useState(readFlag);
  useEffect(() => {
    if (!allowed)
      navigate({ area: "admin", page: "overview" }, { replace: true });
  }, [allowed]);
  useEffect(() => {
    setDrawer(false);
    setSetupActive(readFlag());
  }, [page]);
  useEffect(() => {
    if (!drawer) return;
    // Ao abrir a gaveta no celular, o foco entra na navegação.
    document.querySelector<HTMLElement>(".admin-nav-close")?.focus();
    const close = (event: KeyboardEvent) =>
      event.key === "Escape" && setDrawer(false);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [drawer]);
  const [, title, Icon] = section(page)!;
  const needsProfile = !app.profile && !withoutProfile.has(page);
  return (
    <div className={"area admin-area" + (drawer ? " drawer-open" : "")}>
      {drawer && (
        <button
          type="button"
          className="admin-nav-backdrop"
          aria-label="Fechar navegação de gestão"
          onClick={() => setDrawer(false)}
        />
      )}
      <aside
        className="admin-nav"
        id="admin-navigation"
        aria-label="Navegação de gestão"
      >
        {compact && (
          <button
            type="button"
            className="icon-button admin-nav-close"
            aria-label="Fechar navegação"
            onClick={() => setDrawer(false)}
          >
            <X size={20} />
          </button>
        )}
        <Navigation page={page} onNavigate={() => setDrawer(false)} />
      </aside>
      <div className="admin-main">
        <header className="admin-topbar">
          <button
            type="button"
            className="icon-button"
            aria-label="Voltar"
            onClick={() => navigate({ area: "more" })}
          >
            <ArrowLeft size={20} />
          </button>
          <h1 className="truncate">{title}</h1>
          <button
            type="button"
            className="button secondary sm"
            aria-expanded={drawer}
            aria-controls="admin-navigation"
            onClick={() => setDrawer(true)}
          >
            <MenuIcon size={16} /> Menu
          </button>
        </header>
        <div className="admin-scroll" key={page}>
          <div className="admin-content">
            <PageHeader
              title={title}
              icon={<Icon size={22} />}
              description={
                pageDescriptions[page] || "Organize seu atendimento com clareza."
              }
            />
            {setupActive && page !== "setup" && app.isAdmin && (
              <div className="setup-return">
                <span>
                  Você abriu uma etapa da configuração. Ao terminar, continue
                  pelo assistente.
                </span>
                <a
                  className="text-link"
                  {...linkProps({ area: "admin", page: "setup" })}
                >
                  Voltar à configuração guiada <ArrowRight size={14} />
                </a>
                <button
                  type="button"
                  className="icon-button sm"
                  aria-label="Fechar lembrete de configuração"
                  onClick={() => {
                    writeFlag(false);
                    setSetupActive(false);
                  }}
                >
                  <X size={15} />
                </button>
              </div>
            )}
            {needsProfile ? (
              <div className="card">
                <Empty
                  title="Área de atendimento"
                  description={
                    app.isAdmin
                      ? "Não foi possível abrir o atendimento da empresa. Tente novamente."
                      : "Peça ao administrador para liberar seu acesso ao atendimento da empresa."
                  }
                  action={
                    app.isAdmin ? (
                      <Button onClick={() => void app.reloadSession()}>
                        Tentar novamente
                      </Button>
                    ) : undefined
                  }
                />
              </div>
            ) : (
              <Page key={app.profile + ":" + page} page={page} />
            )}
            <footer className="app-footer">
              <span>Wabotia · Atendimento conectado</span>
              <a href="https://github.com/Quevenapp/Wabotia">
                Código aberto ↗
              </a>
            </footer>
          </div>
        </div>
      </div>
    </div>
  );
}
