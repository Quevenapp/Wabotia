import React, { useState } from "react";
import { FormDialog } from "../../../admin/shared";
import { useAction } from "../../../app/hooks";
import { Button, Field, Notice } from "../../../ui";
import {
  ChildCollection,
  VisibilityFields,
  assertVisibility,
} from "../components/ChildCollection";
import type { CreateEntryRequest, Entry } from "../work-contracts";
import {
  dateTimeInput,
  dateTimeValue,
  instantLabel,
  useDraftGuard,
  useWorkApi,
} from "../work-hooks";
export function quantityMilli(value: string): number | null {
  if (!value.trim()) return null;
  if (!/^\d+(?:[.,]\d{1,3})?$/.test(value.trim()))
    throw new Error("Use uma quantidade positiva com até três casas decimais.");
  const [integer, fraction = ""] = value.trim().replace(",", ".").split(".");
  const result = Number(integer) * 1000 + Number(fraction.padEnd(3, "0"));
  if (!Number.isSafeInteger(result) || result > 1000000000000)
    throw new Error("Quantidade fora do limite.");
  return result;
}
function EntryDialog({
  workId,
  initial,
  onClose,
  onSaved,
}: {
  workId: string;
  initial?: Entry;
  onClose: () => void;
  onSaved: () => void;
}) {
  const api = useWorkApi();
  const [draft, setDraft] = useState<CreateEntryRequest>({
    kind: initial?.kind || "",
    text: initial?.text || "",
    unit: initial?.unit || "",
    occurred_at: initial?.occurred_at || Date.now(),
    client_visible: initial?.client_visible || false,
    sensitive: initial?.sensitive || false,
  });
  const [date, setDate] = useState(dateTimeInput(draft.occurred_at)),
    [quantity, setQuantity] = useState(
      initial?.quantity_milli == null
        ? ""
        : String(initial.quantity_milli / 1000),
    );
  const [dirty, setDirty] = useState(false);
  const close = useDraftGuard(dirty, onClose);
  const change = (patch: Partial<CreateEntryRequest>) => {
    setDirty(true);
    setDraft((old) => ({ ...old, ...patch }));
  };
  return (
    <FormDialog
      title={initial ? "Retificar lançamento" : "Registrar lançamento"}
      onClose={close}
      onSubmit={async () => {
        assertVisibility(draft);
        const body = {
          ...draft,
          quantity_milli: quantityMilli(quantity),
          occurred_at: dateTimeValue(date)!,
        };
        if (!body.occurred_at) throw new Error("Informe a data da ocorrência.");
        if (initial)
          await api.reviseEntry(workId, initial.id, {
            ...body,
            version: initial.version,
          });
        else await api.createEntry(workId, body);
        setDirty(false);
        onSaved();
      }}
    >
      {initial && (
        <Notice>
          A retificação cria um novo registro e preserva o anterior no
          histórico.
        </Notice>
      )}
      <Field
        label="Tipo de lançamento"
        value={draft.kind}
        onChange={(kind) => change({ kind })}
        maxLength={64}
        required
      />
      <Field
        label="Texto"
        value={draft.text}
        onChange={(text) => change({ text })}
        type="textarea"
        maxLength={4000}
        required
      />
      <Field
        label="Quantidade (até três casas decimais)"
        value={quantity}
        onChange={(value) => {
          setDirty(true);
          setQuantity(value);
        }}
      />
      <Field
        label="Unidade"
        value={draft.unit}
        onChange={(unit) => change({ unit })}
        maxLength={32}
      />
      <Field
        label="Ocorrência · horário de Brasília"
        type="datetime-local"
        value={date}
        onChange={(value) => {
          setDirty(true);
          setDate(value);
        }}
        required
      />
      <VisibilityFields
        value={draft}
        onChange={change}
        lockedSensitive={!!initial?.sensitive}
      />
    </FormDialog>
  );
}
export function WorkEntriesTab({
  workId,
  onChanged,
}: {
  workId: string;
  onChanged: () => void;
}) {
  const api = useWorkApi(),
    action = useAction();
  const [editing, setEditing] = useState<Entry | "new" | null>(null),
    [revision, setRevision] = useState(0),
    [archived, setArchived] = useState(false);
  const changed = () => {
    setEditing(null);
    setRevision((n) => n + 1);
    onChanged();
  };
  return (
    <>
      <label className="os-work-check">
        <input
          type="checkbox"
          checked={archived}
          onChange={(event) => setArchived(event.target.checked)}
        />
        Incluir arquivados e retificados
      </label>
      <ChildCollection<Entry>
        key={String(archived)}
        workId={workId}
        collection={"entries/" + archived}
        revision={revision}
        load={(cursor) =>
          api.entries(workId, { cursor, limit: 50, include_archived: archived })
        }
        create={() => (
          <Button onClick={() => setEditing("new")}>
            Registrar lançamento
          </Button>
        )}
        render={(entry) => (
          <>
            <strong>
              {entry.kind} · {instantLabel(entry.occurred_at)}
            </strong>
            <p>{entry.text}</p>
            {entry.quantity_milli != null && (
              <span>
                {entry.quantity_milli / 1000} {entry.unit}
              </span>
            )}
            {entry.replaces_id && (
              <span>Retificação de {entry.replaces_id}</span>
            )}
            {entry.archived_at ? (
              <span>Arquivado</span>
            ) : (
              <div className="card-actions">
                <Button secondary onClick={() => setEditing(entry)}>
                  Retificar
                </Button>
                <Button
                  secondary
                  disabled={action.busy}
                  onClick={() => {
                    if (window.confirm("Arquivar este lançamento?"))
                      void action.run(async () => {
                        await api.archive(
                          workId,
                          "entries",
                          entry.id,
                          entry.version,
                        );
                        changed();
                      });
                  }}
                >
                  Arquivar
                </Button>
              </div>
            )}
          </>
        )}
      />
      {editing && (
        <EntryDialog
          workId={workId}
          initial={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={changed}
        />
      )}
    </>
  );
}
