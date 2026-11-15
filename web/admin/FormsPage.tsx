// Formulários (módulo "forms", docs/MODULOS.md): o administrador monta
// formulários com texto, escolha, data e aceite. O cliente recebe um link pelo
// menu do WhatsApp, pela equipe ou por um bot, responde numa página leve e
// volta ao WhatsApp; as respostas vão para a conversa, o contato e o protocolo.
import React, { useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ClipboardList,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useApp } from "../app/AppContext";
import { useAction } from "../app/hooks";
import type { Row } from "../lib/api";
import { Button, Confirm, Empty, Field, Pill, Switch, toast } from "../ui";
import { FormDialog } from "./shared";

const fieldTypes = [
  { id: "text", name: "Texto" },
  { id: "choice", name: "Escolha" },
  { id: "date", name: "Data" },
  { id: "accept", name: "Aceite (caixa de marcar)" },
];
const ticketModes = [
  { id: "attach", name: "Anexar ao protocolo ativo da conversa, se houver" },
  { id: "open", name: "Anexar ao protocolo ativo ou abrir um novo" },
  { id: "none", name: "Não usar protocolo" },
];
const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const blankField = (): Row => ({
  id: newId(),
  type: "text",
  label: "",
  required: true,
});
const blankForm = (): Row => ({
  id: newId(),
  name: "",
  title: "",
  intro: "",
  fields: [blankField()],
  ticket: "attach",
  expires_hours: 24,
  enabled: true,
});

/** Limpa o rascunho para o formato aceito em PUT /settings. */
function cleanForm(form: Row): Row {
  const out: Row = {
    ...form,
    expires_hours: Number(form.expires_hours) || 24,
    fields: (form.fields || []).map((field: Row) => {
      const next: Row = {
        id: field.id,
        type: field.type,
        label: field.label,
        required: field.required !== false,
      };
      if (field.help) next.help = field.help;
      if (field.type === "text" && field.multiline) next.multiline = true;
      if (field.type === "choice")
        next.options = String(
          field.optionsText ?? (field.options || []).join("\n"),
        )
          .split("\n")
          .map((option) => option.trim())
          .filter(Boolean);
      return next;
    }),
  };
  if (out.ticket !== "open") delete out.ticket_category;
  for (const key of [
    "intro",
    "message",
    "button",
    "submit_label",
    "done_text",
    "return_text",
    "title",
    "flow_id",
    "flow_cta",
    "flow_screen",
  ])
    if (!String(out[key] || "").trim()) delete out[key];
  return out;
}

function FieldEditor({
  field,
  index,
  count,
  onChange,
  onMove,
  onRemove,
}: {
  field: Row;
  index: number;
  count: number;
  onChange: (next: Row) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}) {
  const set = (key: string) => (value: any) =>
    onChange({ ...field, [key]: value });
  return (
    <fieldset className="form-field-editor">
      <legend>Campo {index + 1}</legend>
      <div className="form-field-grid">
        <Field
          label={field.type === "accept" ? "Texto do aceite" : "Pergunta"}
          value={field.label}
          onChange={set("label")}
          maxLength={200}
          required
        />
        <Field
          label="Tipo"
          value={field.type}
          onChange={set("type")}
          options={fieldTypes}
          emptyOption=""
        />
      </div>
      {field.type === "choice" && (
        <Field
          label="Opções (uma por linha, de 2 a 20)"
          type="textarea"
          rows={4}
          value={field.optionsText ?? (field.options || []).join("\n")}
          onChange={set("optionsText")}
          required
        />
      )}
      <Field
        label="Ajuda (opcional)"
        value={field.help || ""}
        onChange={set("help")}
        maxLength={300}
      />
      <div className="form-field-actions">
        <label className="check">
          <input
            type="checkbox"
            checked={field.required !== false}
            onChange={(event) => set("required")(event.target.checked)}
          />
          {field.type === "accept"
            ? "Precisa marcar para enviar"
            : "Obrigatório"}
        </label>
        {field.type === "text" && (
          <label className="check">
            <input
              type="checkbox"
              checked={!!field.multiline}
              onChange={(event) => set("multiline")(event.target.checked)}
            />
            Resposta longa
          </label>
        )}
        <span className="spacer" />
        <span className="form-field-buttons">
          <button
            type="button"
            className="icon-button sm"
            aria-label="Subir campo"
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            <ArrowUp size={16} />
          </button>
          <button
            type="button"
            className="icon-button sm"
            aria-label="Descer campo"
            disabled={index === count - 1}
            onClick={() => onMove(1)}
          >
            <ArrowDown size={16} />
          </button>
          <button
            type="button"
            className="icon-button sm"
            aria-label="Remover campo"
            disabled={count === 1}
            onClick={onRemove}
          >
            <Trash2 size={16} />
          </button>
        </span>
      </div>
    </fieldset>
  );
}

function FormEditor({
  initial,
  forms,
  onClose,
}: {
  initial: Row;
  forms: Row[];
  onClose: () => void;
}) {
  const app = useApp();
  const [form, setForm] = useState<Row>(initial);
  const set = (key: string) => (value: any) =>
    setForm((current) => ({ ...current, [key]: value }));
  const fields: Row[] = form.fields || [];
  const setFields = (next: Row[]) =>
    setForm((current) => ({ ...current, fields: next }));
  const categories: Row[] = (app.settings.ticket_categories || []).filter(
    (category: Row) => category.enabled !== false,
  );
  const exists = forms.some((item) => item.id === form.id);
  return (
    <FormDialog
      title={exists ? "Editar formulário" : "Novo formulário"}
      size="lg"
      onClose={onClose}
      onSubmit={async () => {
        const clean = cleanForm(form);
        await app.api(app.root + "/settings", "PUT", {
          forms: exists
            ? forms.map((item) => (item.id === clean.id ? clean : item))
            : [...forms, clean],
        });
        toast("Formulário salvo.");
        await app.refresh();
        onClose();
      }}
    >
      <Field
        label="Nome (visto pela equipe)"
        value={form.name}
        onChange={set("name")}
        maxLength={80}
        required
      />
      <Field
        label="Título da página (visto pelo cliente)"
        value={form.title || ""}
        onChange={set("title")}
        maxLength={120}
        placeholder="Em branco, usa o nome"
      />
      <Field
        label="Introdução (opcional)"
        type="textarea"
        rows={3}
        value={form.intro || ""}
        onChange={set("intro")}
        maxLength={1500}
      />
      <h3 className="form-editor-heading">Campos</h3>
      {fields.map((field, index) => (
        <FieldEditor
          key={field.id}
          field={field}
          index={index}
          count={fields.length}
          onChange={(next) =>
            setFields(fields.map((item, i) => (i === index ? next : item)))
          }
          onMove={(direction) => {
            const next = [...fields];
            const [moved] = next.splice(index, 1);
            next.splice(index + direction, 0, moved);
            setFields(next);
          }}
          onRemove={() => setFields(fields.filter((_, i) => i !== index))}
        />
      ))}
      {fields.length < 30 && (
        <Button
          secondary
          icon={<Plus size={16} />}
          onClick={() => setFields([...fields, blankField()])}
        >
          Adicionar campo
        </Button>
      )}
      <h3 className="form-editor-heading">Mensagens</h3>
      <Field
        label="Mensagem com o link (opcional)"
        type="textarea"
        rows={2}
        value={form.message || ""}
        onChange={set("message")}
        maxLength={900}
        placeholder={`Para continuar, abra o link e preencha: ${form.title || form.name || "título"}.`}
      />
      <Field
        label="Botão do WhatsApp (linhas oficiais)"
        value={form.button || ""}
        onChange={set("button")}
        maxLength={20}
        placeholder="Abrir formulário"
      />
      <Field
        label="Texto do botão de envio"
        value={form.submit_label || ""}
        onChange={set("submit_label")}
        maxLength={30}
        placeholder="Enviar"
      />
      <Field
        label="Texto da página depois de enviar"
        type="textarea"
        rows={2}
        value={form.done_text || ""}
        onChange={set("done_text")}
        maxLength={600}
        placeholder="Recebemos suas respostas. A confirmação chega na conversa do WhatsApp."
      />
      <Field
        label="Mensagem de retorno no WhatsApp"
        type="textarea"
        rows={2}
        value={form.return_text || ""}
        onChange={set("return_text")}
        maxLength={900}
        placeholder={`Recebemos suas respostas de "${form.title || form.name || "título"}". Obrigado!`}
        help="Se a janela de 24 horas estiver fechada, o retorno sai pelo modelo de notificação configurado em Regras de atendimento."
      />
      <h3 className="form-editor-heading">Flow do WhatsApp (opcional)</h3>
      <Field
        label="ID do Flow publicado"
        value={form.flow_id || ""}
        onChange={set("flow_id")}
        maxLength={100}
        help="Nas linhas oficiais, o formulário abre dentro do WhatsApp. Os campos do Flow precisam ter os mesmos identificadores dos campos acima. Em branco, o cliente recebe o botão com o link."
      />
      {form.flow_id && (
        <div className="form-field-grid">
          <Field
            label="Botão do Flow"
            value={form.flow_cta || ""}
            onChange={set("flow_cta")}
            maxLength={30}
            placeholder={form.button || "Abrir formulário"}
          />
          <Field
            label="Tela inicial (opcional)"
            value={form.flow_screen || ""}
            onChange={set("flow_screen")}
            maxLength={100}
          />
        </div>
      )}
      <h3 className="form-editor-heading">Respostas e validade</h3>
      <Field
        label="Protocolo"
        value={form.ticket}
        onChange={set("ticket")}
        options={ticketModes}
        emptyOption=""
      />
      {form.ticket === "open" && (
        <Field
          label="Categoria do protocolo novo (opcional)"
          value={form.ticket_category || ""}
          onChange={set("ticket_category")}
          options={categories}
          emptyOption="Sem categoria"
        />
      )}
      <Field
        label="Validade do link (horas)"
        type="number"
        min={1}
        max={168}
        value={form.expires_hours}
        onChange={(value) => set("expires_hours")(Number(value))}
        help="Depois disso o link expira e o cliente precisa pedir outro."
      />
      <div className="form-enabled">
        <Switch
          label="Formulário ativo"
          checked={form.enabled !== false}
          onChange={set("enabled")}
        />
        <span>Ativo: pode ser enviado pelo menu, pela equipe e por bots.</span>
      </div>
    </FormDialog>
  );
}

export function FormsPage() {
  const app = useApp();
  const { busy, run } = useAction();
  const forms: Row[] = app.settings.forms || [];
  const [editing, setEditing] = useState<Row | null>(null);
  const [removing, setRemoving] = useState<Row | null>(null);
  const menuUses = (form: Row) =>
    (app.settings.menus || []).filter(
      (item: Row) => item.type === "form" && item.form_id === form.id,
    );
  return (
    <>
      <section className="card">
        <h2>O que não cabe no chat vai por link</h2>
        <p className="workspace-help">
          Monte um formulário com texto, escolha, data e aceite. O cliente
          recebe o link pelo menu do WhatsApp (destino Formulário em Menus e
          ações), pela equipe na conversa (Encaminhar → Menu) ou por um bot,
          responde no celular e volta ao WhatsApp com a confirmação. As
          respostas ficam na conversa, no contato e no protocolo.
        </p>
      </section>
      <div className="toolbar">
        <p>
          {forms.length
            ? `${forms.length} ${forms.length === 1 ? "formulário" : "formulários"}`
            : "Nenhum formulário ainda."}
        </p>
        <Button
          icon={<Plus size={17} />}
          onClick={() => setEditing(blankForm())}
        >
          Novo formulário
        </Button>
      </div>
      {forms.length ? (
        <div className="cards-grid">
          {forms.map((form) => {
            const uses = menuUses(form);
            return (
              <section className="card" key={form.id}>
                <div className="section-heading">
                  <span className="integration-icon">
                    <ClipboardList />
                  </span>
                  <Pill tone={form.enabled !== false ? "ok" : "muted"}>
                    {form.enabled !== false ? "Ativo" : "Desativado"}
                  </Pill>
                </div>
                <h2>{form.name}</h2>
                <p>
                  {(form.fields || []).length} campos ·{" "}
                  {form.expires_hours || 24} h de validade ·{" "}
                  {form.ticket === "none"
                    ? "sem protocolo"
                    : form.ticket === "open"
                      ? "abre protocolo se preciso"
                      : "anexa ao protocolo ativo"}
                </p>
                <small className="muted">
                  {uses.length
                    ? "No menu: " +
                      uses.map((item: Row) => item.label).join(", ")
                    : "Fora do menu: enviado pela equipe ou por bots."}
                </small>
                <div className="card-actions">
                  <Button
                    secondary
                    icon={<Pencil size={16} />}
                    disabled={busy}
                    onClick={() => setEditing(form)}
                  >
                    Editar
                  </Button>
                  <Button
                    secondary
                    icon={<Trash2 size={16} />}
                    disabled={busy}
                    onClick={() => setRemoving(form)}
                  >
                    Excluir
                  </Button>
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        app.statusLoaded && (
          <div className="card">
            <Empty
              icon={<ClipboardList size={28} />}
              title="Crie o primeiro formulário"
              description="Cadastro, ficha de anamnese, autorização, pesquisa: o cliente responde no celular sem sair da conversa por muito tempo."
              action={
                <Button
                  icon={<Plus size={17} />}
                  onClick={() => setEditing(blankForm())}
                >
                  Novo formulário
                </Button>
              }
            />
          </div>
        )
      )}
      {editing && (
        <FormEditor
          key={editing.id}
          initial={editing}
          forms={forms}
          onClose={() => setEditing(null)}
        />
      )}
      {removing && (
        <Confirm
          title={`Excluir “${removing.name}”?`}
          confirmLabel="Excluir"
          danger
          onClose={() => setRemoving(null)}
          onConfirm={() => {
            const target = removing;
            setRemoving(null);
            void run(
              async () => {
                await app.api(app.root + "/settings", "PUT", {
                  forms: forms.filter((item) => item.id !== target.id),
                });
                await app.refresh();
              },
              { success: "Formulário excluído." },
            );
          }}
        >
          <p>
            {menuUses(removing).length
              ? "Este formulário está no menu do WhatsApp. Troque ou remova o item em Menus e ações antes de excluir."
              : "Links já enviados continuam valendo até expirar, com os campos do momento do envio. As respostas recebidas ficam guardadas nas conversas."}
          </p>
        </Confirm>
      )}
    </>
  );
}
