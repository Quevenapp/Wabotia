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

function ModuleCard({
  module,
  busy,
  onToggle,
}: {
  module: Row;
  busy: boolean;
  onToggle: (next: boolean) => void;
}) {
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
          disabled={!app.isAdmin}
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
      {(places.length > 0 || menuTypes.length > 0) && (
        <dl className="module-facts">
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
    await run(
      () =>
        app.api(app.root + "/modules/" + module.id, "PUT", {
          enabled,
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
          <p>
            As configurações e os registros ficam guardados. Para voltar, ligue
            o módulo de novo nesta tela.
          </p>
        </Confirm>
      )}
    </>
  );
}
