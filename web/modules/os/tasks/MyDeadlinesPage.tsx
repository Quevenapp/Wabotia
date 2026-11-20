import React, { useState } from "react";
import { useApp } from "../../../app/AppContext";
import { useAction } from "../../../app/hooks";
import { Button, Field } from "../../../ui";
import { linkProps, navigate, useRoute } from "../../../lib/routes";
import { ChildCollection } from "../components/ChildCollection";
import { instantLabel, useWorkApi, useWorkResource } from "../work-hooks";
import type { Deadline, TaskState } from "../work-contracts";
import { taskStateLabel } from "./WorkTasksTab";
import { TaskDialog } from "./TaskDialog";
import "../work.css";

/** OS4: execuções agendadas das ordens da pessoa (responsável ou profissional da Agenda). */
function MyScheduleSection() {
  const api = useWorkApi(), app = useApp();
  const schedule = useWorkResource(app.root + "/os4-my-schedule", () => api.mySchedule());
  const items = schedule.data?.data || [];
  if (schedule.error || !items.length) return null;
  return (
    <section className="os-work-section">
      <h3>Execuções agendadas</h3>
      <ul className="os-work-records">
        {items.map((item) => (
          <li key={item.id} className="os-work-record">
            <strong>{item.when_text}{item.overdue ? " · já passou" : ""}</strong>{" "}
            <a {...linkProps({ area: "admin", page: "work", typeId: item.type_id, id: item.id })}>
              {item.display_number} · {item.item}
            </a>
            {item.customer_name && <span> · {item.customer_name}</span>}
            <span className="muted"> · {item.mode === "agenda" ? "pela Agenda" : "data combinada"} · {item.status_label}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function MyDeadlinesPage() {
  const api = useWorkApi(),
    app = useApp(),
    route = useRoute(),
    action = useAction();
  const filters = route.filters || {};
  const [editing, setEditing] = useState<Deadline | null>(null),
    [revision, setRevision] = useState(0);
  const types = useWorkResource(app.root + "/deadline-types", () =>
    api.types(),
  );
  const change = (key: string, value: string) =>
    navigate({ ...route, filters: { ...filters, [key]: value } });
  const changed = () => {
    setEditing(null);
    setRevision((n) => n + 1);
  };
  return (
    <div className="os-work">
      <MyScheduleSection />
      <p>Suas tarefas em {app.profileName}. Datas e horários de Brasília.</p>
      <div className="os-work-toolbar">
        <Field
          label="Período"
          value={filters.period || "overdue"}
          emptyOption={null}
          options={[
            { id: "overdue", name: "Atrasadas" },
            { id: "today", name: "Hoje" },
            { id: "next7", name: "Próximos sete dias" },
            { id: "range", name: "Intervalo" },
            { id: "undated", name: "Sem vencimento" },
          ]}
          onChange={(value) => change("period", value)}
        />
        {filters.period === "range" && (
          <>
            <Field
              label="De"
              type="date"
              value={filters.due_from || ""}
              onChange={(value) => change("due_from", value)}
            />
            <Field
              label="Até"
              type="date"
              value={filters.due_to || ""}
              onChange={(value) => change("due_to", value)}
            />
          </>
        )}
        <Field
          label="Tipo"
          value={filters.type_id || ""}
          emptyOption="Todos os tipos"
          options={(types.data?.data || []).map((type) => ({
            id: type.id,
            name: type.labels.plural,
          }))}
          onChange={(value) => change("type_id", value)}
        />
        <Field
          label="Situação"
          value={filters.state || "open"}
          emptyOption={null}
          options={Object.entries(taskStateLabel).map(([id, name]) => ({
            id,
            name,
          }))}
          onChange={(value) => change("state", value)}
        />
      </div>
      <ChildCollection<Deadline>
        key={JSON.stringify(filters)}
        workId="me"
        collection="deadlines"
        revision={revision}
        load={(cursor) =>
          api.deadlines({
            assignee: "me",
            state: (filters.state || "open") as TaskState,
            period: filters.period || "overdue",
            type_id: filters.type_id,
            due_from: filters.period === "range" ? filters.due_from : undefined,
            due_to: filters.period === "range" ? filters.due_to : undefined,
            cursor,
          })
        }
        render={(task) => (
          <>
            <strong>
              {instantLabel(task.due_at)} · {task.title}
            </strong>
            <a
              {...linkProps({
                area: "admin",
                page: "work",
                typeId: task.type_id,
                id: task.order_id,
                tab: "tarefas",
              })}
            >
              {task.type_label} {task.display_number} · {task.stage_label}
            </a>
            {task.customer && <span>{task.customer.name}</span>}
            <div className="card-actions">
              <Button secondary onClick={() => setEditing(task)}>
                Editar prazo
              </Button>
              <Button
                secondary
                disabled={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    await api.updateTask(task.order_id, task.id, {
                      version: task.version,
                      state: task.state === "done" ? "open" : "done",
                    }, task.sensitive);
                    changed();
                  })
                }
              >
                {task.state === "done" ? "Reabrir" : "Concluir"}
              </Button>
            </div>
          </>
        )}
      />
      {editing && (
        <TaskDialog
          workId={editing.order_id}
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={changed}
        />
      )}
    </div>
  );
}
