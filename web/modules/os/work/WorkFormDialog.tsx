import React, { useId, useRef, useState } from "react";
import { useApp } from "../../../app/AppContext";
import { useAction } from "../../../app/hooks";
import { FormDialog } from "../../../admin/shared";
import { Dialog, Field, Button, Notice, toastError } from "../../../ui";
import type { CreateOrderRequest, Order, OrderRequirements, ServiceObjectType, WorkTypeView } from "../work-contracts";
import { ExtraFields, commonExtra, parseExtra } from "../components/ExtraFields";
import { AssigneeField } from "../components/AssigneeField";
import { ObjectPicker, parseObjectOpening } from "../objects/ObjectPicker";
import { ObjectSnapshot } from "../objects/ObjectSnapshot";
import { dateTimeInput, dateTimeValue, ResourceState, useDraftGuard, useWorkApi, useWorkResource } from "../work-hooks";

/** A vitrine OS2 grava apenas no transporte em memória de demo.ts. */
function DemoWorkFormDialog({ title, subtitle, onClose, onSubmit, children, submitLabel = "Salvar", size, disabled }: React.ComponentProps<typeof FormDialog>) {
  const id = useId(), sending = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <Dialog title={title} subtitle={subtitle} size={size} onClose={onClose} footer={<>
    <Button secondary disabled={busy} onClick={onClose}>Cancelar</Button>
    <Button type="submit" form={id} busy={busy} disabled={disabled}>{submitLabel}</Button>
  </>}><Notice>Demonstração: alterações simuladas em memória, descartadas ao recarregar a página.</Notice>
    <form id={id} onSubmit={async event => {
      event.preventDefault();
      if (sending.current || disabled) return;
      sending.current = true; setBusy(true); setError("");
      try { await onSubmit(); } catch (error) { setError((error as Error).message); }
      finally { sending.current = false; setBusy(false); }
    }}>{children}{error && <Notice tone="error">{error}</Notice>}</form>
  </Dialog>;
}
export function useWorkOperationDialog() {
  return useApp().demo ? DemoWorkFormDialog : FormDialog;
}
export function useWorkOperationAction() {
  const app = useApp(), action = useAction(), sending = useRef(false);
  const [busy, setBusy] = useState(false);
  return app.demo ? { busy, run: async (operation: () => Promise<unknown>) => {
    if (sending.current) return;
    sending.current = true; setBusy(true);
    try { await operation(); } catch (error) { toastError(error); }
    finally { sending.current = false; setBusy(false); }
  } } : action;
}

export interface OpeningContact { id: string; name?: string; phone?: string; namespace?: string; identity_state?: string; identityState?: string; merged_into?: string | null }
export const requiresCanonicalContact = (type: WorkTypeView, initial?: Order) => !initial && !!type.object_type_id;
export function changeOpeningContact(draft: CreateOrderRequest, contact: OpeningContact): CreateOrderRequest {
  const next = { ...draft, contact_id: contact.id, customer_name: contact.name || "", phone: contact.phone || "" };
  if (draft.contact_id !== contact.id) delete next.object;
  return next;
}

/** Só o ramo com objeto busca o cadastro compartilhado; a URL nunca comprova titularidade. */
function OpeningContactPicker({ value, initialId, onChange }: {
  value?: string; initialId?: string; onChange: (contact: OpeningContact) => void;
}) {
  const app = useApp();
  const [search, setSearch] = useState(""), [query, setQuery] = useState("");
  const [known, setKnown] = useState<Record<string, OpeningContact>>({});
  const contacts = useWorkResource(`${app.root}/os-contact-search/${query}`, () =>
    app.api(app.root + "/contacts?" + new URLSearchParams({ q: query, identity: "all", namespace: "team", limit: "30" })) as Promise<{ data: OpeningContact[] }>,
  );
  const initial = useWorkResource(initialId ? `${app.root}/os-opening-contact/${initialId}` : null, () =>
    app.api(app.root + "/contacts/" + encodeURIComponent(initialId!)).then(result => result.contact as OpeningContact),
  );
  const allowed = (contact: OpeningContact) => !contact.merged_into && (!contact.namespace || contact.namespace === "team") && (!contact.identity_state || contact.identity_state === "active") && (!contact.identityState || contact.identityState === "active");
  const options = (contacts.data?.data || []).filter(allowed);
  if (initial.data && allowed(initial.data) && !options.some(contact => contact.id === initial.data!.id)) options.unshift(initial.data);
  const selected = value ? known[app.root + "/" + value] : undefined;
  if (selected && allowed(selected) && !options.some(contact => contact.id === selected.id)) options.unshift(selected);
  const choose = (contact: OpeningContact) => {
    setKnown(previous => ({ ...previous, [app.root + "/" + contact.id]: contact }));
    onChange(contact);
  };
  return <fieldset>
    <legend>Contato do cliente</legend>
    <Field label="Buscar contato cadastrado" value={search} onChange={setSearch} />
    <Button secondary onClick={() => setQuery(search.trim())}>Buscar contatos</Button>
    <ResourceState resource={contacts} />
    {initialId && !!initial.error && <ResourceState resource={initial} />}
    <Field label="Contato canônico" required value={value || ""} options={options.map(contact => ({ id: contact.id, name: `${contact.name || "Sem nome"}${contact.phone ? " · " + contact.phone : ""}` }))}
      onChange={id => { const contact = options.find(contact => contact.id === id); if (contact) choose(contact); }}
      help="Selecione a ficha do titular. Placa, telefone ou nome digitado não comprovam propriedade." />
    {!options.length && contacts.data && <Notice>Nenhum contato disponível. Cadastre o cliente na ficha de contatos antes de abrir esta ordem.</Notice>}
    {initial.data && !value && allowed(initial.data) && <Button secondary onClick={() => choose(initial.data!)}>Confirmar contato: {initial.data.name || "Sem nome"}</Button>}
  </fieldset>;
}

export function WorkFormDialog({ type, initial, conversationId, initialContactId, initialObjectId, onClose, onSaved }: {
  type: WorkTypeView; initial?: Order; conversationId?: string; initialContactId?: string; initialObjectId?: string;
  onClose: () => void; onSaved: (order: Order) => void;
}) {
  const api = useWorkApi();
  const OperationDialog = useWorkOperationDialog();
  const [base, setBase] = useState(initial);
  const fields = base?.fields || type.fields;
  const labels = base?.labels || type.labels;
  const needsContact = requiresCanonicalContact(type, base);
  const [draft, setDraft] = useState<CreateOrderRequest>({
    customer_name: initial?.customer.name || "", phone: initial?.customer.phone || "",
    item: initial?.item || "", problem: initial?.problem || "", notes: initial?.notes || "",
    assignee: initial?.assignee || null, extra: commonExtra(fields, initial?.extra || {}),
  });
  const [objectType, setObjectType] = useState<ServiceObjectType>();
  const [requirements, setRequirements] = useState<OrderRequirements>();
  const [objectTouched, setObjectTouched] = useState(false);
  const [objectRefresh, setObjectRefresh] = useState(0);
  const [due, setDue] = useState(dateTimeInput(initial?.due_at));
  const [dirty, setDirty] = useState(false), [conflict, setConflict] = useState(false), [reloaded, setReloaded] = useState(false);
  const submitting = useRef(false);
  const close = useDraftGuard(dirty, onClose);
  const change = <K extends keyof CreateOrderRequest>(key: K, value: CreateOrderRequest[K]) => {
    setDirty(true); setDraft(old => ({ ...old, [key]: value }));
  };
  const closed = base && ["delivered", "cancelled"].includes(base.status);
  return <OperationDialog title={`${base ? "Editar" : "Criar"}: ${labels.singular}`} onClose={close} disabled={conflict}
    onSubmit={async () => {
      if (submitting.current) return;
      submitting.current = true;
      try {
        if (needsContact && !draft.contact_id) throw new Error("Selecione o contato cadastrado do cliente.");
        const body = { ...draft, due_at: dateTimeValue(due), extra: parseExtra(fields, draft.extra || {}) };
        if (base?.customer.conversation_id || conversationId) delete body.phone;
        if (needsContact) body.object = parseObjectOpening(draft.object, objectType);
        else { delete body.object; delete body.contact_id; }
        const saved = base
          ? await api.update(base.id, closed ? { notes: draft.notes, version: base.version } : { ...body, version: base.version })
          : await api.create({ ...body, type_id: type.id, conversation_id: conversationId });
        setDirty(false); close.release(); onSaved(saved);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "version_conflict" || code === "object_archived" || code === "object_definition_conflict") setConflict(true);
        if (code === "missing_fields" && base) setRequirements(await api.requirements(base.id));
        throw error;
      } finally { submitting.current = false; }
    }}>
    {conflict && <Notice>Rascunho preservado. <Button secondary onClick={async () => {
      if (base) setBase(await api.order(base.id));
      else setObjectRefresh(value => value + 1);
      setConflict(false); setReloaded(true);
    }}>Recarregar versão atual</Button></Notice>}
    {reloaded && <Notice>Versão atual carregada. Revise seu rascunho antes de substituir os campos.{needsContact ? " Confirme novamente a seleção do objeto antes de salvar." : ""}</Notice>}
    {base?.object && <ObjectSnapshot snapshot={base.object} />}
    {requirements && <Notice tone="error">{requirements.internal_missing ? "A equipe precisa completar os dados desta etapa. " : ""}
      {(requirements.missing.length ? requirements.missing : requirements.required).length ? `Confira os campos exigidos: ${(requirements.missing.length ? requirements.missing : requirements.required).map(field => field.label).join(", ")}.` : "Confira os campos exigidos antes de salvar."}</Notice>}
    {closed ? <Notice>Trabalho encerrado: somente observações internas podem mudar.</Notice> : <>
      {needsContact ? <>
        <OpeningContactPicker value={draft.contact_id} initialId={initialContactId} onChange={contact => {
          if (draft.contact_id !== contact.id && (draft.object || objectTouched) && !window.confirm("Trocar o contato e descartar a seleção ou o cadastro do objeto? Os campos desta ordem serão preservados.")) return;
          setDirty(true); setDraft(old => changeOpeningContact(old, contact));
          if (draft.contact_id !== contact.id) { setObjectType(undefined); setObjectTouched(false); }
        }} />
        {draft.contact_id && <ObjectPicker key={draft.contact_id + type.object_type_id} contactId={draft.contact_id} typeId={type.object_type_id!}
          value={draft.object} onChange={value => { setObjectTouched(true); change("object", value); }} onType={setObjectType}
          initialObjectId={draft.contact_id === initialContactId ? initialObjectId : undefined} refreshKey={objectRefresh} />}
      </> : <>
        <Field label={labels.customer_singular} value={draft.customer_name} onChange={value => change("customer_name", value)} disabled={!!base?.object} maxLength={120} />
        {!conversationId && <Field label="Telefone (WhatsApp)" value={draft.phone} onChange={value => change("phone", value)} required={!base}
          disabled={!!base?.customer.conversation_id || !!base?.object} maxLength={40} />}
      </>}
      {needsContact && <h3>Dados desta ordem</h3>}
      <Field label={labels.item} value={draft.item} onChange={value => change("item", value)} required maxLength={200} />
      <Field label={labels.problem} value={draft.problem} onChange={value => change("problem", value)} required type="textarea" maxLength={2000} />
      <ExtraFields fields={fields} values={draft.extra || {}} onChange={value => change("extra", value)} />
      <AssigneeField value={draft.assignee || null} onChange={value => change("assignee", value || null)} />
      <Field label="Prazo geral · horário de Brasília" type="datetime-local" value={due} onChange={value => { setDirty(true); setDue(value); }} />
    </>}
    <Field label="Observações internas" value={draft.notes} onChange={value => change("notes", value)} type="textarea" maxLength={4000} />
  </OperationDialog>;
}
