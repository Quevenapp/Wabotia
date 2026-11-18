import React, { useState } from "react";
import { useApp } from "../../../app/AppContext";
import { Pager } from "../../../admin/shared";
import { Button, Empty } from "../../../ui";
import type { Page } from "../work-contracts";
import { ResourceState, useWorkResource } from "../work-hooks";
export function ChildCollection<T extends { id: string }>({
  workId,
  collection,
  load,
  render,
  create,
  revision = 0,
}: {
  workId: string;
  collection: string;
  load: (cursor: string) => Promise<Page<T>>;
  render: (row: T, reload: () => void) => React.ReactNode;
  create?: (reload: () => void) => React.ReactNode;
  revision?: number;
}) {
  const { root } = useApp();
  const [cursor, setCursor] = useState("");
  const resource = useWorkResource(
    `${root}/${workId}/${collection}/${cursor}/${revision}`,
    () => load(cursor),
  );
  return (
    <>
      <ResourceState resource={resource} />
      {resource.data && (
        <>
          {create?.(resource.reload)}
          <ul className="os-work-records">
            {resource.data.data.map((row) => (
              <li className="os-work-record" key={row.id}>
                {render(row, resource.reload)}
              </li>
            ))}
          </ul>
          {!resource.data.data.length && <Empty title="Nenhum registro" />}
          <Pager
            cursor={cursor}
            nextCursor={resource.data.next_cursor}
            setCursor={setCursor}
          />
          <Button secondary onClick={resource.reload}>
            Atualizar
          </Button>
        </>
      )}
    </>
  );
}
export function assertVisibility(value: {
  client_visible: boolean;
  sensitive: boolean;
}) {
  if (value.client_visible && value.sensitive)
    throw new Error(
      "Um registro restrito não pode ser visível ao cliente. Revise a classificação.",
    );
}
export function VisibilityFields({
  value,
  onChange,
  lockedSensitive = false,
}: {
  value: { client_visible: boolean; sensitive: boolean };
  onChange: (value: { client_visible: boolean; sensitive: boolean }) => void;
  lockedSensitive?: boolean;
}) {
  return (
    <>
      <label className="os-work-check">
        <input
          type="checkbox"
          checked={value.client_visible}
          onChange={(event) =>
            onChange({ ...value, client_visible: event.target.checked })
          }
        />
        Visível ao cliente
      </label>
      <label className="os-work-check">
        <input
          type="checkbox"
          checked={value.sensitive}
          disabled={lockedSensitive}
          onChange={(event) =>
            onChange({ ...value, sensitive: event.target.checked })
          }
        />
        Restrito (exige permissão para dados sensíveis)
      </label>
      {value.sensitive && value.client_visible && (
        <p role="alert">
          Desmarque a visibilidade ao cliente para manter o registro restrito.
        </p>
      )}
    </>
  );
}
