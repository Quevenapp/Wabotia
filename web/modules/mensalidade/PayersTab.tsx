// Mensalidades → Pagadores: quem paga (CPF ou CNPJ), os telefones
// autorizados a falar por ele e a situação (em dia, em atraso, sem assinatura).
import React, { useEffect, useState } from "react";
import { Pencil, Plus, Trash2, Users } from "lucide-react";
import { useApp } from "../../app/AppContext";
import { useAction } from "../../app/hooks";
import { useIntents, type Row } from "../../lib/api";
import {
  Button,
  Dialog,
  Empty,
  Field,
  Notice,
  Pill,
  SearchBox,
  SkeletonRows,
  Table,
  toast,
} from "../../ui";
import { FormDialog, Pager, useList, useResource } from "../../admin/shared";
import { dateLabel, money, phoneLabel } from "./shared";

export const situationLabels: Record<string, string> = {
  em_dia: "Em dia",
  em_atraso: "Em atraso",
  sem_assinatura: "Sem assinatura",
};
const situationTones: Record<string, "ok" | "danger" | "muted"> = {
  em_dia: "ok",
  em_atraso: "danger",
  sem_assinatura: "muted",
};

function PayerForm({
  initial,
  onClose,
  onSaved,
}: {
  initial: Row | null;
  onClose: () => void;
  onSaved: (payer: Row) => void;
}) {
  const app = useApp();
  const write = useIntents(app.api);
  const [draft, setDraft] = useState<Row>(() => ({
    name: initial?.name || "",
    document: initial?.document_display || "",
    email: initial?.email || "",
    phone: "",
    notes: initial?.notes || "",
  }));
  const set = (key: string) => (value: string) =>
    setDraft((current) => ({ ...current, [key]: value }));
  return (
    <FormDialog
      title={initial ? "Editar pagador" : "Novo pagador"}
      onClose={onClose}
      onSubmit={async () => {
        const body: Row = {
          name: draft.name,
          document: draft.document || null,
          email: draft.email,
          notes: draft.notes,
        };
        if (!initial && draft.phone) body.phones = [draft.phone];
        const saved = initial
          ? await write(
              `${app.root}/mensalidade/payers/${initial.id}`,
              "PATCH",
              body,
            )
          : await write(`${app.root}/mensalidade/payers`, "POST", body);
        toast(initial ? "Pagador atualizado." : "Pagador cadastrado.");
        onSaved(saved);
      }}
    >
      <div className="form-field-grid">
        <Field
          label="Nome ou razão social"
          value={draft.name}
          onChange={set("name")}
          maxLength={120}
          required
        />
        <Field
          label="CPF ou CNPJ"
          value={draft.document}
          onChange={set("document")}
          maxLength={20}
          help="Os dígitos são conferidos. Aceita o CNPJ com letras."
        />
      </div>
      <div className="form-field-grid">
        <Field
          label="E-mail"
          type="email"
          value={draft.email}
          onChange={set("email")}
          maxLength={200}
        />
        {!initial && (
          <Field
            label="Primeiro telefone autorizado"
            value={draft.phone}
            onChange={set("phone")}
            maxLength={40}
            help="Com DDD. Outros telefones depois, no detalhe."
          />
        )}
      </div>
      <Field
        label="Observações internas"
        type="textarea"
        rows={2}
        value={draft.notes}
        onChange={set("notes")}
        maxLength={1000}
      />
    </FormDialog>
  );
}

function PayerDetail({
  id,
  onClose,
  onChanged,
  onOpenSubscription,
}: {
  id: string;
  onClose: () => void;
  onChanged: () => void;
  onOpenSubscription: (id: string) => void;
}) {
  const app = useApp();
  const write = useIntents(app.api);
  const { busy, run } = useAction();
  const resource = useResource(`${app.root}/mensalidade/payers/${id}`);
  const [editing, setEditing] = useState(false);
  const [phone, setPhone] = useState("");
  const [label, setLabel] = useState("");
  const payer: Row | null = resource.data;
  const reload = () => {
    void resource.reload();
    onChanged();
  };
  if (!payer)
    return (
      <Dialog title="Pagador" onClose={onClose} size="lg">
        {resource.error ? (
          <Notice tone="error" onRetry={() => void resource.reload()}>
            {resource.error}
          </Notice>
        ) : (
          <SkeletonRows rows={4} avatar={false} />
        )}
      </Dialog>
    );
  const situation = payer.situation || {};
  return (
    <>
      <Dialog
        title={payer.name || "Pagador"}
        subtitle={
          <>
            <Pill tone={situationTones[situation.status] || "muted"}>
              {situationLabels[situation.status] || "—"}
            </Pill>{" "}
            {payer.document_display || "sem CPF/CNPJ"}
          </>
        }
        size="lg"
        onClose={onClose}
        footer={
          <Button
            secondary
            icon={<Pencil size={16} />}
            onClick={() => setEditing(true)}
          >
            Editar
          </Button>
        }
      >
        {situation.open_installment && (
          <Notice tone={situation.status === "em_atraso" ? "warn" : "info"}>
            Parcela {situation.open_installment.period_label} de{" "}
            {money(situation.open_installment.amount_cents)}, vencimento{" "}
            {dateLabel(situation.open_installment.due_date)}
            {situation.status === "em_dia" ? " (dentro da carência)." : "."}
          </Notice>
        )}
        <h3>Telefones autorizados</h3>
        <Table
          rows={(payer.phones || []).map((p: Row) => ({ ...p, id: p.phone }))}
          columns={[
            ["phone", "Telefone", (row) => phoneLabel(row.phone)],
            ["label", "Quem", (row) => row.label || "—"],
            [
              "created_by",
              "Vinculado por",
              (row) =>
                String(row.created_by || "").startsWith("customer")
                  ? "Contratação pelo WhatsApp"
                  : app.names[row.created_by] || row.created_by || "—",
            ],
          ]}
          action={(row) => (
            <Button
              secondary
              size="sm"
              icon={<Trash2 size={15} />}
              disabled={busy}
              onClick={() =>
                void run(
                  async () => {
                    await write(
                      `${app.root}/mensalidade/payers/${payer.id}/phones/remove`,
                      "POST",
                      {
                        phone: row.phone,
                      },
                    );
                    reload();
                  },
                  { success: "Telefone removido." },
                )
              }
            >
              Remover
            </Button>
          )}
          empty={
            <Empty
              compact
              title="Nenhum telefone"
              description="Autorize ao menos um telefone para o cliente ser reconhecido no WhatsApp."
            />
          }
        />
        {!app.isAdmin && (
          <p className="muted">
            Autorizar um telefone libera o atendimento em nome do pagador:
            somente administradores fazem isso.
          </p>
        )}
        <form
          className="form-field-grid"
          hidden={!app.isAdmin}
          onSubmit={(event) => {
            event.preventDefault();
            void run(
              async () => {
                await write(
                  `${app.root}/mensalidade/payers/${payer.id}/phones`,
                  "POST",
                  { phone, label },
                );
                setPhone("");
                setLabel("");
                reload();
              },
              { success: "Telefone autorizado." },
            );
          }}
        >
          <Field
            label="Novo telefone"
            value={phone}
            onChange={setPhone}
            maxLength={40}
            required
          />
          <Field
            label="Quem é (opcional)"
            value={label}
            onChange={setLabel}
            maxLength={60}
            placeholder="Ex.: financeiro, Pedro"
          />
          <div>
            <Button
              type="submit"
              secondary
              icon={<Plus size={16} />}
              busy={busy}
            >
              Autorizar
            </Button>
          </div>
        </form>
        <h3>Assinaturas</h3>
        <Table
          rows={payer.subscriptions || []}
          columns={[
            ["customer", "Cliente", (row) => row.customer?.name || "—"],
            ["plan_name", "Plano", (row) => row.plan_name || "—"],
            ["charge_cents", "Valor", (row) => money(row.charge_cents)],
            ["status_label", "Estado"],
          ]}
          action={(row) => (
            <Button
              secondary
              size="sm"
              onClick={() => onOpenSubscription(row.id)}
            >
              Abrir
            </Button>
          )}
          empty={
            <Empty
              compact
              title="Sem assinatura"
              description="Crie uma assinatura informando este CPF ou CNPJ."
            />
          }
        />
      </Dialog>
      {editing && (
        <PayerForm
          initial={payer}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            reload();
          }}
        />
      )}
    </>
  );
}

export function PayersTab({
  onOpenSubscription,
}: {
  onOpenSubscription: (id: string) => void;
}) {
  const app = useApp();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const list = useList(
    `${app.root}/mensalidade/payers${query ? `?q=${encodeURIComponent(query)}` : ""}`,
  );
  return (
    <>
      <div className="toolbar">
        <SearchBox
          value={search}
          onChange={setSearch}
          placeholder="Buscar por nome, CPF/CNPJ ou telefone"
        />
        <Button icon={<Plus size={17} />} onClick={() => setCreating(true)}>
          Novo pagador
        </Button>
      </div>
      <section className="card">
        {!list.loaded && !list.error ? (
          <SkeletonRows rows={5} avatar={false} />
        ) : (
          <Table
            rows={list.rows}
            columns={[
              ["name", "Pagador"],
              [
                "document_display",
                "CPF/CNPJ",
                (row) => row.document_display || "—",
              ],
              [
                "phones",
                "Telefones",
                (row) =>
                  row.phones.length
                    ? row.phones
                        .slice(0, 2)
                        .map((p: Row) => phoneLabel(p.phone))
                        .join(", ") +
                      (row.phones.length > 2
                        ? ` +${row.phones.length - 2}`
                        : "")
                    : "—",
              ],
              ["subscriptions", "Assinaturas"],
            ]}
            action={(row) => (
              <Button secondary size="sm" onClick={() => setOpenId(row.id)}>
                Abrir
              </Button>
            )}
            empty={
              <Empty
                compact
                icon={<Users size={28} />}
                title="Nenhum pagador"
                description="Os pagadores nascem com as assinaturas; cadastre direto para autorizar vários telefones de uma empresa."
              />
            }
          />
        )}
        <Pager
          cursor={list.cursor}
          nextCursor={list.nextCursor}
          setCursor={list.setCursor}
        />
      </section>
      {creating && (
        <PayerForm
          initial={null}
          onClose={() => setCreating(false)}
          onSaved={(payer) => {
            setCreating(false);
            void list.reload();
            setOpenId(payer.id);
          }}
        />
      )}
      {openId && (
        <PayerDetail
          id={openId}
          onClose={() => setOpenId(null)}
          onChanged={() => void list.reload()}
          onOpenSubscription={(id) => {
            setOpenId(null);
            onOpenSubscription(id);
          }}
        />
      )}
    </>
  );
}
