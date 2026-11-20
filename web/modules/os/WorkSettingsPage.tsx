import React from "react";
import { useApp } from "../../app/AppContext";
import { useAction } from "../../app/hooks";
import { useIntents } from "../../lib/api";
import { linkProps, useRoute } from "../../lib/routes";
import { hasWorkMenu } from "../../menu-tree";
import { Button, Card, Pill } from "../../ui";
import type { CustomWorkType } from "./work-contracts";
import { ServiceOrdersSettingsPage } from "./ServiceOrdersSettingsPage";
import { WorkTypesPage } from "./types/WorkTypesPage";
import { ResourceState, useWorkResource } from "./work-hooks";
import type { Row } from "../../lib/api";
import "./work.css";

export const workSettingsTabs = [
  { id: "modelos", label: "Modelos" },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "prazos", label: "Prazos e garantia" },
] as const;

export function workSettingsTab(page?: string, tab?: string) {
  return workSettingsTabs.some((item) => item.id === tab) ? tab!
    : page === "service-orders-settings" ? "whatsapp" : "modelos";
}

export function WorkMenus() {
  const app = useApp(), action = useAction(), write = useIntents(app.api);
  const menus = useWorkResource<{ data: Row[] }>(app.root + "/work-menus", () => app.api(app.root + "/menus"), app.status.settings_revision || "");
  const types = [
    { id: "service_order", labels: { singular: "Ordem de serviço", plural: "Ordens de serviço" }, archived: false, features: { customer_open: true } },
    ...(app.settings.os_work_types || []) as CustomWorkType[],
  ];
  return <Card title="Menu do WhatsApp" description="Abrir e acompanhar cada modelo. Ajuste a posição e as linhas em Menus e ações.">
    <ResourceState resource={menus} />
    {types.map((type) => <section className="os-work-record" key={type.id}>
      <h3>{type.labels.plural}{type.archived ? " · Arquivado" : ""}</h3>
      {(["os_open", "os_track"] as const).map((menuType) => {
        const included = hasWorkMenu((menus.data?.data || []).filter((menu) => menu.enabled !== false), menuType, type.id);
        const label = menuType === "os_open" ? "Abrir" : "Acompanhar";
        return <div className="card-actions" key={menuType}>
          <strong>{label}</strong>
          <Pill tone={included ? "ok" : "muted"}>{included ? "No menu" : "Fora do menu"}</Pill>
          {!included && <Button secondary disabled={!menus.data || action.busy || (menuType === "os_open" && (type.archived || !type.features.customer_open))}
            onClick={() => void action.run(async () => {
              const latest = await app.api(app.root + "/menus");
              const current: Row[] = latest.data || [];
              const existing = current.find((menu) => menu.type === menuType && (menu.type_id || "service_order") === type.id);
              if (existing?.enabled !== false && existing) { menus.reload(); return; }
              await write(app.root + "/settings", "PUT", {
                menus_revision: latest.revision,
                menus: existing ? current.map((menu) => menu.id === existing.id ? { ...menu, enabled: true } : menu) : [...current, {
                  id: `work_${crypto.randomUUID().replaceAll("-", "")}`,
                  type: menuType, type_id: type.id,
                  label: `${label} ${type.labels.singular}`, enabled: true,
                }],
              });
              await app.refresh();
              menus.reload();
            }, { success: "Opção disponível no menu." })}>Adicionar ao menu</Button>}
          {menuType === "os_open" && !type.archived && !type.features.customer_open && <small>Ative a abertura pelo cliente em Recursos do modelo.</small>}
        </div>;
      })}
    </section>)}
  </Card>;
}

export function WorkSettingsPage() {
  const app = useApp(), route = useRoute();
  const tab = workSettingsTab(route.page, route.filters?.tab);
  const types = (app.settings.os_work_types || []) as CustomWorkType[];
  return <div className="os-work">
    <nav className="os-work-toolbar" aria-label="Configurar ordens de serviço">
      {workSettingsTabs.map((item) => <a key={item.id} className="button secondary"
        aria-current={tab === item.id ? "page" : undefined}
        {...linkProps({ area: "admin", page: "work-types", filters: { tab: item.id } })}>{item.label}</a>)}
    </nav>
    {tab === "modelos" && <WorkTypesPage />}
    {tab === "whatsapp" && <><WorkMenus /><ServiceOrdersSettingsPage key={app.root + "/whatsapp"} section="whatsapp" /></>}
    {tab === "prazos" && <>
      <ServiceOrdersSettingsPage key={app.root + "/prazos"} section="prazos" />
      <Card title="Prazos dos modelos personalizados" description="Cada modelo define seus próprios prazos, tarefas e garantia na aba Recursos.">
        {types.map((type) => <p key={type.id}><a {...linkProps({ area: "admin", page: "work-types", typeId: type.id, filters: { tab: "modelos", editor: "recursos" } })}>{type.labels.plural} → Recursos</a></p>)}
        {!types.length && <p>Crie um modelo na aba Modelos para configurar prazos específicos do seu serviço.</p>}
      </Card>
    </>}
  </div>;
}
