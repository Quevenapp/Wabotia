import React, { useState } from "react";
import { FormDialog } from "../../../admin/shared";
import { useAction } from "../../../app/hooks";
import { Button, Field, Notice } from "../../../ui";
import {
  ChildCollection,
  VisibilityFields,
  assertVisibility,
} from "../components/ChildCollection";
import type { CreatePersonRequest, LinkedPerson } from "../work-contracts";
import { useDraftGuard, useWorkApi } from "../work-hooks";
import { ConflictRecovery, useConflictRecovery } from "../components/ConflictRecovery";
import { findWorkChild } from "../work-api";
export function PersonDialog({
  workId,
  initial,
  onClose,
  onSaved,
}: {
  workId: string;
  initial?: LinkedPerson;
  onClose: () => void;
  onSaved: () => void;
}) {
  const api = useWorkApi();
  const recovery = useConflictRecovery(initial, async () => ({
    record: await findWorkChild((cursor) => api.people(workId, { cursor, limit: 100 }), initial!.id),
  }));
  const current = recovery.latest?.record;
  const [draft, setDraft] = useState<CreatePersonRequest>({
    role: initial?.role || "",
    name: initial?.name || "",
    phone: initial?.phone || "",
    email: initial?.email || "",
    note: initial?.note || "",
    contact_id: initial?.contact_id || null,
    client_visible: initial?.client_visible || false,
    sensitive: initial?.sensitive || false,
  });
  const [dirty, setDirty] = useState(false);
  const close = useDraftGuard(dirty, onClose);
  const change = (patch: Partial<CreatePersonRequest>) => {
    setDirty(true);
    setDraft((old) => ({ ...old, ...patch }));
  };
  return (
    <FormDialog
      title={initial ? "Editar vínculo" : "Vincular pessoa"}
      onClose={close}
      disabled={recovery.conflict}
      onSubmit={async () => {
        const body = { ...draft, sensitive: !!recovery.base?.sensitive || draft.sensitive };
        assertVisibility(body);
        await recovery.run(async () => {
          if (recovery.base)
            await api.updatePerson(workId, recovery.base.id, {
              ...body,
              version: recovery.base.version,
            });
          else await api.createPerson(workId, body);
        });
        setDirty(false);
        onSaved();
      }}
    >
      <ConflictRecovery recovery={recovery}>
        {current && <dl>
          <dt>Nome / papel atuais</dt><dd>{current.name} · {current.role}</dd>
          <dt>Contato</dt><dd>{current.contact_id} · {current.phone} · {current.email}</dd>
          <dt>Observação</dt><dd>{current.note}</dd>
          <dt>Visibilidade</dt><dd>{current.sensitive ? "Restrito" : current.client_visible ? "Cliente" : "Equipe"}</dd>
        </dl>}
      </ConflictRecovery>
      <Notice>
        O vínculo não concede acesso ao acompanhamento. O titular continua sendo
        o contato principal do trabalho.
      </Notice>
      <Field
        label="Nome"
        value={draft.name}
        onChange={(name) => change({ name })}
        maxLength={120}
        required
      />
      <Field
        label="Papel no trabalho"
        value={draft.role}
        onChange={(role) => change({ role })}
        maxLength={64}
        required
      />
      <Field
        label="ID do contato existente (opcional)"
        value={draft.contact_id || ""}
        onChange={(contact_id) => change({ contact_id: contact_id || null })}
      />
      <Field
        label="Telefone"
        value={draft.phone}
        onChange={(phone) => change({ phone })}
        maxLength={40}
      />
      <Field
        label="E-mail"
        type="email"
        value={draft.email}
        onChange={(email) => change({ email })}
        maxLength={254}
      />
      <Field
        label="Observação"
        type="textarea"
        value={draft.note}
        onChange={(note) => change({ note })}
        maxLength={2000}
      />
      <VisibilityFields
        value={{ ...draft, sensitive: !!recovery.base?.sensitive || draft.sensitive }}
        onChange={change}
        lockedSensitive={!!recovery.base?.sensitive}
      />
    </FormDialog>
  );
}
export function WorkPeopleTab({
  workId,
  onChanged,
}: {
  workId: string;
  onChanged: () => void;
}) {
  const api = useWorkApi(),
    action = useAction();
  const [editing, setEditing] = useState<LinkedPerson | "new" | null>(null),
    [revision, setRevision] = useState(0);
  const changed = () => {
    setEditing(null);
    setRevision((n) => n + 1);
    onChanged();
  };
  return (
    <>
      <ChildCollection<LinkedPerson>
        workId={workId}
        collection="people"
        revision={revision}
        load={(cursor) => api.people(workId, { cursor, limit: 50 })}
        create={() => (
          <Button onClick={() => setEditing("new")}>Vincular pessoa</Button>
        )}
        render={(person) => (
          <>
            <strong>
              {person.name} · {person.role}
            </strong>
            {person.phone && <span>{person.phone}</span>}
            {person.email && <span>{person.email}</span>}
            {person.note && <p>{person.note}</p>}
            <div className="card-actions">
              <Button secondary onClick={() => setEditing(person)}>
                Editar vínculo
              </Button>
              <Button
                secondary
                disabled={action.busy}
                onClick={() => {
                  if (window.confirm(`Desvincular ${person.name}?`))
                    void action.run(async () => {
                      await api.archive(
                        workId,
                        "people",
                        person.id,
                        person.version,
                      );
                      changed();
                    });
                }}
              >
                Desvincular
              </Button>
            </div>
          </>
        )}
      />
      {editing && (
        <PersonDialog
          workId={workId}
          initial={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={changed}
        />
      )}
    </>
  );
}
