// Gestão → Planos e regras (módulo "mensalidade"): planos, regras de cobrança
// e avisos (chave "mensalidade" de PUT /settings) e os itens do menu do
// WhatsApp do módulo.
import React, { useState } from "react";
import { Check, Pencil, Plus, Trash2 } from "lucide-react";
import { useApp } from "../../app/AppContext";
import { useAction, useUnsavedGuard } from "../../app/hooks";
import { useIntents, type Row } from "../../lib/api";
import {
  Button,
  Card,
  Empty,
  Field,
  Notice,
  Pill,
  Table,
  toast,
} from "../../ui";
import { FormDialog, useResource } from "../../admin/shared";
import { cents, centsInput, money, periodLabels } from "./shared";
import "./mensalidade.css";

/** Padrões do servidor (src/modules/mensalidade/model.ts). */
const defaults: Row = {
  method: "pix",
  days_before: 3,
  due_today: true,
  overdue_every_days: 3,
  overdue_max: 3,
  manual_instructions: "",
  grace_days: 0,
};

const menuTypes = [
  { type: "mensalidade_list", label: "Minhas mensalidades" },
  { type: "mensalidade_copy", label: "Segunda via" },
];

function PlanForm({
  initial,
  onClose,
  onSaved,
}: {
  initial: Row | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const app = useApp();
  const write = useIntents(app.api);
  const [draft, setDraft] = useState<Row>(() => ({
    name: initial?.name || "",
    amount: initial ? centsInput(initial.amount_cents) : "",
    period: initial?.period || "monthly",
    due_day: String(initial?.due_day || 10),
    active: initial ? initial.active : true,
    sellable: initial ? initial.sellable : false,
    description: initial?.description || "",
  }));
  const set = (key: string) => (value: string) =>
    setDraft((current) => ({ ...current, [key]: value }));
  return (
    <FormDialog
      title={initial ? `Editar plano ${initial.name}` : "Novo plano"}
      subtitle={
        initial
          ? "Mudanças valem para assinaturas novas; as existentes guardam o valor e a periodicidade de quando foram criadas."
          : undefined
      }
      onClose={onClose}
      onSubmit={async () => {
        const amount = cents(draft.amount);
        if (!amount)
          throw new Error("Valor inválido. Use, por exemplo, 180,00.");
        const body = {
          name: draft.name,
          amount_cents: amount,
          period: draft.period,
          due_day: Number(draft.due_day),
          active: !!draft.active,
          sellable: !!draft.sellable,
          description: draft.description,
        };
        if (initial)
          await write(
            `${app.root}/mensalidade/plans/${initial.id}`,
            "PATCH",
            body,
          );
        else await write(`${app.root}/mensalidade/plans`, "POST", body);
        toast(initial ? "Plano atualizado." : "Plano criado.");
        onSaved();
      }}
    >
      <Field
        label="Nome"
        value={draft.name}
        onChange={set("name")}
        maxLength={80}
        required
        placeholder="Ex.: Inglês Kids, Futsal sub-11, Condomínio bloco A"
      />
      <div className="form-field-grid">
        <Field
          label="Valor (R$)"
          value={draft.amount}
          onChange={set("amount")}
          placeholder="0,00"
          required
        />
        <Field
          label="Periodicidade"
          value={draft.period}
          onChange={set("period")}
          options={Object.entries(periodLabels).map(([id, name]) => ({
            id,
            name,
          }))}
          emptyOption={null}
        />
        <Field
          label="Dia de vencimento padrão"
          type="number"
          min={1}
          max={31}
          value={draft.due_day}
          onChange={set("due_day")}
          required
          help="31 vence no último dia dos meses curtos."
        />
      </div>
      {initial && (
        <label className="mensalidade-check">
          <input
            type="checkbox"
            checked={!!draft.active}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                active: event.target.checked,
              }))
            }
          />{" "}
          Plano ativo (desativado não aceita novas assinaturas)
        </label>
      )}
      <label className="mensalidade-check">
        <input
          type="checkbox"
          checked={!!draft.sellable}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              sellable: event.target.checked,
            }))
          }
        />{" "}
        Vender pelo WhatsApp (o cliente contrata e paga a primeira parcela na
        conversa, pelo módulo Suporte)
      </label>
      {draft.sellable && (
        <Field
          label="Descrição para o cliente"
          value={draft.description}
          onChange={set("description")}
          maxLength={200}
          placeholder="Ex.: atendimento humano ilimitado em horário comercial"
        />
      )}
    </FormDialog>
  );
}

export function MensalidadeSettingsPage() {
  const app = useApp();
  const write = useIntents(app.api);
  const { busy, run } = useAction();
  const plans = useResource(`${app.root}/mensalidade/plans`);
  const [editing, setEditing] = useState<Row | null | "new">(null);
  const saved: Row = { ...defaults, ...(app.settings.mensalidade || {}) };
  const [draft, setDraft] = useState<Row>(saved);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  useUnsavedGuard(dirty);
  const set =
    (key: string, numeric = false) =>
    (value: string) =>
      setDraft((current) => ({
        ...current,
        [key]: numeric ? (value === "" ? "" : Number(value)) : value,
      }));
  const menus: Row[] = app.settings.menus || [];
  const inMenu = (type: string) => menus.some((item) => item.type === type);
  const rows: Row[] = plans.data?.data || [];
  return (
    <>
      <Card
        title="Como funciona"
        description="Cada assinatura gera uma parcela por período. Alguns dias antes do vencimento o cliente recebe a cobrança (Pix copia e cola ou link) pelo WhatsApp; no dia e depois do vencimento, lembretes com o código. A parcela só fica paga quando o Mercado Pago confirma pelo webhook ou quando um administrador dá baixa manual; o cliente recebe o comprovante."
      />
      <Card
        title="Planos"
        actions={
          <Button icon={<Plus size={17} />} onClick={() => setEditing("new")}>
            Novo plano
          </Button>
        }
      >
        {plans.error && (
          <Notice tone="error" onRetry={() => void plans.reload()}>
            {plans.error}
          </Notice>
        )}
        <Table
          rows={rows}
          columns={[
            ["name", "Plano"],
            ["amount_cents", "Valor", (row) => money(row.amount_cents)],
            [
              "period",
              "Periodicidade",
              (row) => periodLabels[row.period] || row.period,
            ],
            ["due_day", "Vencimento", (row) => `Dia ${row.due_day}`],
            ["subscriptions", "Assinaturas", (row) => row.subscriptions ?? 0],
            [
              "active",
              "Estado",
              (row) => (
                <Pill tone={row.active ? "ok" : "muted"}>
                  {row.active ? "Ativo" : "Desativado"}
                </Pill>
              ),
            ],
          ]}
          action={(row) => (
            <div className="mensalidade-actions">
              <Button
                secondary
                size="sm"
                icon={<Pencil size={15} />}
                onClick={() => setEditing(row)}
              >
                Editar
              </Button>
              {!row.subscriptions && (
                <Button
                  secondary
                  size="sm"
                  icon={<Trash2 size={15} />}
                  disabled={busy}
                  onClick={() =>
                    void run(
                      async () => {
                        await write(
                          `${app.root}/mensalidade/plans/${row.id}`,
                          "DELETE",
                          {},
                        );
                        await plans.reload();
                      },
                      { success: "Plano excluído." },
                    )
                  }
                >
                  Excluir
                </Button>
              )}
            </div>
          )}
          empty={
            <Empty
              compact
              title="Nenhum plano"
              description="Crie os planos da escola, academia ou condomínio: nome, valor, periodicidade e dia de vencimento."
            />
          }
        />
      </Card>
      <Card
        title="Menu do WhatsApp"
        description="Itens que o módulo oferece ao cliente. Depois de adicionar, ajuste a posição em Menus e ações."
      >
        <div className="cards-grid">
          {menuTypes.map((entry) => (
            <section className="card" key={entry.type}>
              <div className="section-heading">
                <h3>{entry.label}</h3>
                <Pill tone={inMenu(entry.type) ? "ok" : "muted"}>
                  {inMenu(entry.type) ? "No menu" : "Fora do menu"}
                </Pill>
              </div>
              {!inMenu(entry.type) && (
                <Button
                  secondary
                  icon={<Plus size={16} />}
                  disabled={busy}
                  onClick={() =>
                    void run(
                      async () => {
                        const latest = await app.api(app.root + "/menus");
                        if (
                          (latest.data || []).some(
                            (item: Row) => item.type === entry.type,
                          )
                        )
                          return;
                        await app.api(app.root + "/settings", "PUT", {
                          menus: [
                            ...(latest.data || []),
                            {
                              id:
                                entry.type.replace("_", "-") +
                                "-" +
                                crypto.randomUUID().slice(0, 6),
                              label: entry.label,
                              type: entry.type,
                              enabled: true,
                            },
                          ],
                          menus_revision: latest.revision,
                        });
                        await app.refresh();
                      },
                      { success: "Item adicionado ao menu." },
                    )
                  }
                >
                  Adicionar ao menu
                </Button>
              )}
            </section>
          ))}
        </div>
      </Card>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run(
            async () => {
              await app.api(app.root + "/settings", "PUT", {
                mensalidade: {
                  method: draft.method,
                  days_before: Number(draft.days_before),
                  due_today: !!draft.due_today,
                  overdue_every_days: Number(draft.overdue_every_days),
                  overdue_max: Number(draft.overdue_max),
                  manual_instructions: draft.manual_instructions || "",
                  grace_days: Number(draft.grace_days) || 0,
                },
              });
              await app.refresh();
            },
            { success: "Regras salvas." },
          );
        }}
      >
        <Card
          title="Cobrança e avisos"
          description="Fora da janela de 24 horas os avisos saem pelo modelo de notificação de Regras de atendimento (modelo UTILITY aprovado no WhatsApp; cada envio é cobrado pela Meta)."
        >
          <div className="form-field-grid">
            <Field
              label="Forma de cobrança"
              value={draft.method}
              onChange={set("method")}
              options={[
                { id: "pix", name: "Pix copia e cola" },
                { id: "link", name: "Link de pagamento (cartão, Pix…)" },
              ]}
              emptyOption={null}
            />
            <Field
              label="Enviar a cobrança (dias antes)"
              type="number"
              min={0}
              max={15}
              value={draft.days_before}
              onChange={set("days_before", true)}
              required
              help="0 envia no dia do vencimento."
            />
            <Field
              label="Avisos de atraso (máximo por parcela)"
              type="number"
              min={0}
              max={10}
              value={draft.overdue_max}
              onChange={set("overdue_max", true)}
              required
              help="0 não avisa atraso."
            />
            <Field
              label="Intervalo entre avisos de atraso (dias)"
              type="number"
              min={1}
              max={30}
              value={draft.overdue_every_days}
              onChange={set("overdue_every_days", true)}
              required
            />
            <Field
              label="Carência (dias após o vencimento)"
              type="number"
              min={0}
              max={60}
              value={draft.grace_days}
              onChange={set("grace_days", true)}
              required
              help="Nesse prazo o pagador ainda conta como em dia para o Suporte e outros módulos."
            />
          </div>
          <label className="mensalidade-check">
            <input
              type="checkbox"
              checked={!!draft.due_today}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  due_today: event.target.checked,
                }))
              }
            />{" "}
            Lembrar no dia do vencimento, com o código de novo
          </label>
          <Field
            label="Instruções sem a Cobrança configurada"
            type="textarea"
            rows={2}
            value={draft.manual_instructions}
            onChange={set("manual_instructions")}
            maxLength={500}
            placeholder="Ex.: Pague na secretaria ou pelo Pix CNPJ 12.345.678/0001-90 e envie o comprovante."
            help="Vai no aviso quando a conta do Mercado Pago não está configurada. A baixa, nesse caso, é manual."
          />
        </Card>
        <div className="toolbar">
          <span />
          <Button
            type="submit"
            busy={busy}
            disabled={!dirty}
            icon={<Check size={17} />}
          >
            Salvar regras
          </Button>
        </div>
      </form>
      {editing && (
        <PlanForm
          initial={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void plans.reload();
          }}
        />
      )}
    </>
  );
}
