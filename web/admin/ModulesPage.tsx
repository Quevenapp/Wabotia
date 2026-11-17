// Módulos (docs/MODULOS.md): o administrador liga e desliga as funções
// embutidas por área de atendimento. Desligado, o módulo some do painel e do
// menu do WhatsApp; o que foi configurado fica guardado para quando religar.
import React, { useState } from "react";
import {
  Blocks,
  ClipboardList,
  CreditCard,
  Puzzle,
  Ticket,
} from "lucide-react";
import { useApp } from "../app/AppContext";
import { useAction } from "../app/hooks";
import type { Row } from "../lib/api";
import { Confirm, Empty, Notice, Pill, SkeletonRows, Switch } from "../ui";
import { useResource } from "./shared";

const icons: Record<string, typeof Puzzle> = {
  queue: Ticket,
  forms: ClipboardList,
  payments: CreditCard,
};

/** Nomes dos módulos de `ids`, na ordem da lista. */
const names = (all: Row[], ids: string[]) =>
  all.filter((m) => ids.includes(m.id)).map((m) => m.name);

/** Ligados que dependem de `id`, direta ou indiretamente (como o servidor). */
function dependentsOf(all: Row[], id: string) {
  const found = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const m of all)
      if (
        m.enabled &&
        !found.has(m.id) &&
        (m.requires || []).some((r: string) => r === id || found.has(r))
      ) {
        found.add(m.id);
        changed = true;
      }
  }
  return [...found];
}

function ModuleCard({
  module,
  all,
  busy,
  onToggle,
}: {
  module: Row;
  all: Row[];
  busy: boolean;
  onToggle: (next: boolean) => void;
}) {
  const requires: string[] = module.requires || [];
  const missing = requires.filter(
    (id) => !all.find((m) => m.id === id)?.enabled,
  );
  const app = useApp();
  const Icon = icons[module.id] || Puzzle;
  const places = (module.navigation || []).map((item: Row) => item.label);
  const menuTypes = (module.menu_item_types || []).map(
    (item: Row) => item.label,
  );
  return (
    <section className={"card module-card" + (module.enabled ? "" : " off")}>
      <div className="section-heading">
        <span className="integration-icon">
          <Icon />
        </span>
        <Switch
          label={(module.enabled ? "Desligar " : "Ligar ") + module.name}
          checked={!!module.enabled}
          busy={busy}
          disabled={!app.isAdmin || (!module.enabled && missing.length > 0)}
          onChange={onToggle}
        />
      </div>
      <h2>{module.name}</h2>
      <p>{module.description}</p>
      <div className="module-meta">
        <Pill tone={module.enabled ? "ok" : "muted"}>
          {module.enabled ? "Ligado" : "Desligado"}
        </Pill>
        <small>Versão {module.version}</small>
        {module.builtin && <small>Integrado ao Wabotia</small>}
      </div>
      {!module.enabled && missing.length > 0 && (
        <p className="muted">
          Ligue antes {names(all, missing).join(" e ")}: este módulo depende
          {missing.length > 1 ? " deles" : " dele"}.
        </p>
      )}
      {(places.length > 0 ||
        menuTypes.length > 0 ||
        requires.length > 0 ||
        !!module.erp_role) && (
        <dl className="module-facts">
          {module.erp_role && (
            <>
              <dt>No ERP</dt>
              <dd>
                Lança como "Sistema · {module.name}", com o papel{" "}
                {module.erp_role}
              </dd>
            </>
          )}
          {requires.length > 0 && (
            <>
              <dt>Depende de</dt>
              <dd>{names(all, requires).join(" · ")}</dd>
            </>
          )}
          {places.length > 0 && (
            <>
              <dt>No painel</dt>
              <dd>{places.join(" · ")}</dd>
            </>
          )}
          {menuTypes.length > 0 && (
            <>
              <dt>No menu do WhatsApp</dt>
              <dd>{menuTypes.join(" · ")}</dd>
            </>
          )}
        </dl>
      )}
    </section>
  );
}

export function ModulesPage() {
  const app = useApp();
  const list = useResource(app.root + "/modules");
  const { busyKey, run } = useAction();
  const [confirm, setConfirm] = useState<Row | null>(null);
  const modules: Row[] = list.data?.data || [];
  const change = async (module: Row, enabled: boolean) => {
    // Desligar um módulo do qual outros dependem desliga os dependentes
    // junto (cascade), depois da confirmação que os lista.
    const cascade = !enabled && dependentsOf(modules, module.id).length > 0;
    await run(
      () =>
        app.api(app.root + "/modules/" + module.id, "PUT", {
          enabled,
          ...(cascade ? { cascade: true } : {}),
        }),
      {
        key: module.id,
        success: enabled
          ? `${module.name} ligado.`
          : `${module.name} desligado.`,
      },
    );
    await Promise.all([list.reload(), app.refresh().catch(() => {})]);
  };
  return (
    <>
      <section className="card">
        <h2>Ligue só o que a sua empresa usa</h2>
        <p className="workspace-help">
          Cada módulo acrescenta telas ao painel e opções ao menu do WhatsApp
          desta área de atendimento. Ao desligar, ele sai da navegação e do
          menu, e o que já foi configurado fica guardado para quando você
          religar.
        </p>
      </section>
      {list.error && (
        <Notice tone="error" onRetry={() => void list.reload()}>
          {list.error}
        </Notice>
      )}
      {!list.loaded && !list.error ? (
        <div className="card">
          <SkeletonRows rows={3} avatar={false} />
        </div>
      ) : modules.length ? (
        <div className="cards-grid">
          {modules.map((module) => (
            <ModuleCard
              key={module.id}
              module={module}
              all={modules}
              busy={busyKey === module.id}
              onToggle={(next) =>
                next ? void change(module, true) : setConfirm(module)
              }
            />
          ))}
        </div>
      ) : (
        list.loaded && (
          <div className="card">
            <Empty
              icon={<Blocks size={28} />}
              title="Nenhum módulo nesta versão"
              description="Os módulos aparecem aqui quando o servidor for atualizado."
            />
          </div>
        )
      )}
      {confirm && (
        <Confirm
          title={`Desligar ${confirm.name}?`}
          confirmLabel="Desligar"
          danger
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            const target = confirm;
            setConfirm(null);
            void change(target, false);
          }}
        >
          <p>
            {confirm.name} sai da navegação do painel e do menu do WhatsApp
            desta área. Aplicativos e aparelhos que usam o módulo passam a
            receber o aviso de módulo desligado.
          </p>
          {dependentsOf(modules, confirm.id).length > 0 && (
            <p>
              <strong>
                Também serão desligados:{" "}
                {names(modules, dependentsOf(modules, confirm.id)).join(", ")}
              </strong>
              , que{" "}
              {dependentsOf(modules, confirm.id).length > 1
                ? "dependem"
                : "depende"}{" "}
              de {confirm.name}.
            </p>
          )}
          <p>
            As configurações e os registros ficam guardados. Para voltar, ligue
            o módulo de novo nesta tela.
          </p>
        </Confirm>
      )}
    </>
  );
}
