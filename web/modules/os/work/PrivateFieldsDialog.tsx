import React, { useState } from "react";
import { useApp } from "../../../app/AppContext";
import { FormDialog } from "../../../admin/shared";
import { Button, Notice } from "../../../ui";
import type { Order, PrivateFields, WorkField } from "../work-contracts";
import {
  ResourceState,
  useDraftGuard,
  useWorkApi,
  useWorkResource,
} from "../work-hooks";
import { ExtraFields, parseExtra } from "../components/ExtraFields";

function PrivateEditor({
  order,
  authorized,
  onClose,
  onSaved,
}: {
  order: Order;
  authorized: PrivateFields;
  onClose: () => void;
  onSaved: () => void;
}) {
  const api = useWorkApi();
  // A classificação do servidor não é alterada. Esta cópia só habilita os
  // controles depois de /private-fields autorizar explicitamente a leitura.
  const fields: WorkField[] = order.fields
    .filter((field) => field.sensitive)
    .map((field) => ({ ...field, sensitive: false }));
  const [values, setValues] = useState(authorized.extra),
    [dirty, setDirty] = useState(false);
  const close = useDraftGuard(dirty, onClose);
  return (
    <FormDialog
      title="Campos restritos"
      onClose={close}
      onSubmit={async () => {
        await api.updatePrivateFields(order.id, {
          version: authorized.version,
          extra: parseExtra(fields, values),
        });
        setDirty(false);
        onSaved();
      }}
    >
      <Notice>
        Dados restritos à pessoa autorizada. Não são incluídos em mensagens ou
        no formulário comum.
      </Notice>
      <ExtraFields
        fields={fields}
        values={values}
        onChange={(next) => {
          setDirty(true);
          setValues(next);
        }}
      />
    </FormDialog>
  );
}
export function PrivateFieldsDialog({
  order,
  onClose,
  onSaved,
}: {
  order: Order;
  onClose: () => void;
  onSaved: () => void;
}) {
  const api = useWorkApi(),
    app = useApp();
  const resource = useWorkResource(
    app.root + "/private-fields/" + order.id,
    () => api.privateFields(order.id),
  );
  if (!resource.data)
    return (
      <>
        <ResourceState resource={resource} />
        <Button secondary onClick={onClose}>
          Fechar campos restritos
        </Button>
      </>
    );
  return (
    <PrivateEditor
      order={order}
      authorized={resource.data}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}
