import React, { useState } from "react";
import { useApp } from "../../app/AppContext";
import { useAction } from "../../app/hooks";
import { useIntents } from "../../lib/api";
import { linkProps } from "../../lib/routes";
import { Button, Field } from "../../ui";
import type { ConversationExtensionProps } from "../conversation";
import { ConversationServiceOrders } from "./ConversationServiceOrders";
import { WorkFormDialog } from "./work/WorkFormDialog";
import { ResourceState, useWorkApi, useWorkResource } from "./work-hooks";
import { hasCustomTypes, workCollectionLabel } from "./work-vocabulary";
import { StagePill } from "./components/StagePill";
export function ConversationWorkOrders(props: ConversationExtensionProps) {
  const app = useApp();
  return (
    <ConversationWorkContent
      key={app.profile + ":" + props.conversation.id}
      {...props}
    />
  );
}
function ConversationWorkContent(props: ConversationExtensionProps) {
  const app = useApp(),
    api = useWorkApi(),
    action = useAction(),
    write = useIntents(app.api);
  const catalog = useWorkResource(
    app.root + "/conversation-types/" + (app.status.settings_revision || ""),
    () => api.types(),
  );
  const orders = useWorkResource(
    catalog.data && hasCustomTypes(catalog.data.data)
      ? app.root + "/conversation-work/" + props.conversation.id
      : null,
    () =>
      api.orders({
        open: "1",
        conversation_id: props.conversation.id,
        limit: "50",
      }),
  );
  const [typeId, setTypeId] = useState(""),
    [opening, setOpening] = useState(false);
  if (
    !(app.settings.os_work_types || []).length &&
    (!catalog.data || !hasCustomTypes(catalog.data.data))
  )
    return <ConversationServiceOrders {...props} />;
  if (!catalog.data) return <ResourceState resource={catalog} />;
  const available = catalog.data.data.filter((type) => !type.archived);
  const type = available.find((type) => type.id === typeId) || available[0];
  return (
    <section className="info-section os-work">
      <h4>
        {workCollectionLabel(catalog.data.data, app.settings.os_vocabulary)}
      </h4>
      <ResourceState resource={orders} />
      {orders.data?.data.map((order) => (
        <a
          key={order.id}
          className="info-web-step"
          {...linkProps({
            area: "admin",
            page: "work",
            typeId: order.type_id,
            id: order.id,
          })}
        >
          <strong>
            {order.type_label} {order.display_number} · {order.item}
          </strong>
          <StagePill status={order.status} label={order.stage_label} />
        </a>
      ))}
      {type && (
        <>
          <Field
            label="Tipo de trabalho"
            value={type.id}
            emptyOption={null}
            options={available.map((type) => ({
              id: type.id,
              name: type.labels.singular,
            }))}
            onChange={setTypeId}
          />
          <div className="card-actions">
            <Button secondary onClick={() => setOpening(true)}>
              Criar: {type.labels.singular}
            </Button>
            {type.features.customer_open && (
              <Button
                secondary
                disabled={action.busy}
                onClick={() =>
                  void action.run(
                    () =>
                      write(
                        `${app.root}/conversations/${encodeURIComponent(props.conversation.id)}/actions`,
                        "POST",
                        {
                          action: "service_order",
                          type_id: type.id,
                          send_form: true,
                        },
                      ),
                    { success: "Link de abertura enviado." },
                  )
                }
              >
                Enviar link de abertura
              </Button>
            )}
          </div>
          {opening && (
            <WorkFormDialog
              type={type}
              conversationId={props.conversation.id}
              onClose={() => setOpening(false)}
              onSaved={() => {
                setOpening(false);
                orders.reload();
              }}
            />
          )}
        </>
      )}
    </section>
  );
}
