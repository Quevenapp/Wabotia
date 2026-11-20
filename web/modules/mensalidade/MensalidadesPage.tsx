import { CatalogRecordLinks } from '../integrations/CatalogLinkPicker';
import { IntegrationStatus } from '../integrations/IntegrationStatus';
// Mensalidades (módulo "mensalidade", docs/MENSALIDADE.md): resumo do mês,
// parcelas por mês com filtro de estado, assinaturas e inadimplentes. Ações:
// reenviar cobrança, dar baixa, isentar, pausar, retomar e encerrar. Todas as
// escritas levam Idempotency-Key.
import React, { useEffect, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Pause,
  Pencil,
  Play,
  Plus,
  Send,
  Square,
  Upload,
  Wallet,
} from "lucide-react";
import { useApp } from "../../app/AppContext";
import { useAction } from "../../app/hooks";
import { useIntents, type Row } from "../../lib/api";
import {
  Button,
  Chip,
  Dialog,
  Empty,
  Field,
  IconButton,
  Notice,
  Pill,
  SearchBox,
  Segmented,
  SkeletonRows,
  Table,
  toast,
} from "../../ui";
import { FormDialog, Pager, useList, useResource } from "../../admin/shared";
import {
  cents,
  centsInput,
  currentMonth,
  dateLabel,
  installmentLabels,
  installmentOrder,
  installmentTones,
  money,
  monthLabel,
  parseImport,
  periodLabels,
  phoneLabel,
  shiftMonth,
  stampLabel,
  subscriptionLabels,
  subscriptionTones,
} from "./shared";
import { PayersTab } from "./PayersTab";
import "./mensalidade.css";

function useWrite() {
  const app = useApp();
  const write = useIntents(app.api);
  return (path: string, method: string, body: Row = {}) =>
    write(`${app.root}/mensalidade${path}`, method, body);
}

const InstallmentPill = ({ status }: { status: string }) => (
  <Pill tone={installmentTones[status] || "muted"}>
    {installmentLabels[status] || status}
  </Pill>
);
const SubscriptionPill = ({ status }: { status: string }) => (
  <Pill tone={subscriptionTones[status] || "muted"}>
    {subscriptionLabels[status] || status}
  </Pill>
);

// ---------------------------------------------------------------------------
// Ações de parcela

function PayDialog({
  installment,
  mode,
  onClose,
  onDone,
}: {
  installment: Row;
  mode: "pay" | "waive";
  onClose: () => void;
  onDone: () => void;
}) {
  const write = useWrite();
  const [note, setNote] = useState("");
  const [day, setDay] = useState(
    new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10),
  );
  const [notify, setNotify] = useState(true);
  const who = installment.customer?.name || "cliente";
  return (
    <FormDialog
      title={mode === "pay" ? "Dar baixa manual" : "Isentar parcela"}
      subtitle={`${who} · ${installment.period_label} · ${money(installment.amount_cents)}`}
      submitLabel={mode === "pay" ? "Dar baixa" : "Isentar"}
      onClose={onClose}
      onSubmit={async () => {
        if (mode === "pay")
          await write(`/installments/${installment.id}/pay`, "POST", {
            note,
            paid_at: day,
            notify,
          });
        else
          await write(`/installments/${installment.id}/waive`, "POST", {
            note,
          });
        toast(mode === "pay" ? "Baixa registrada." : "Parcela isenta.");
        onDone();
      }}
    >
      {mode === "pay" ? (
        <>
          <Notice>
            Use para pagamentos fora da cobrança (dinheiro, transferência). Fica
            registrado quem deu baixa e quando. O Pix ou link aberto desta
            parcela é cancelado; um pagamento que entrar mesmo assim aparece
            como duplicado, para estorno no Mercado Pago.
          </Notice>
          <Field
            label="Data do pagamento"
            type="date"
            value={day}
            onChange={setDay}
            required
          />
          <Field
            label="Observação"
            value={note}
            onChange={setNote}
            maxLength={300}
            placeholder="Ex.: pagou em dinheiro na secretaria"
          />
          <label className="mensalidade-check">
            <input
              type="checkbox"
              checked={notify}
              onChange={(event) => setNotify(event.target.checked)}
            />{" "}
            Enviar o comprovante ao cliente pelo WhatsApp
          </label>
        </>
      ) : (
        <Field
          label="Motivo"
          value={note}
          onChange={setNote}
          maxLength={300}
          placeholder="Ex.: bolsa, cortesia, acordo"
        />
      )}
    </FormDialog>
  );
}

function InstallmentActions({
  row,
  onAction,
}: {
  row: Row;
  onAction: (kind: "pay" | "waive" | "charge", row: Row) => void;
}) {
  const app = useApp();
  const payable = ["open", "overdue"].includes(row.status);
  if (!payable && !(row.status === "cancelled" && app.isAdmin)) return null;
  return (
    <div className="mensalidade-actions">
      {payable && (
        <Button
          secondary
          size="sm"
          icon={<Send size={15} />}
          onClick={() => onAction("charge", row)}
        >
          Reenviar
        </Button>
      )}
      {payable && app.isAdmin && (
        <Button secondary size="sm" onClick={() => onAction("pay", row)}>
          Dar baixa
        </Button>
      )}
      {app.isAdmin && (
        <Button secondary size="sm" onClick={() => onAction("waive", row)}>
          Isentar
        </Button>
      )}
    </div>
  );
}

function useInstallmentActions(after: () => void) {
  const write = useWrite();
  const { run } = useAction();
  const [dialog, setDialog] = useState<{
    mode: "pay" | "waive";
    row: Row;
  } | null>(null);
  const act = (kind: "pay" | "waive" | "charge", row: Row) => {
    if (kind !== "charge") return setDialog({ mode: kind, row });
    void run(
      async () => {
        await write(`/installments/${row.id}/charge`, "POST", {});
        after();
      },
      { success: "Cobrança enviada ao cliente." },
    );
  };
  const node = dialog ? (
    <PayDialog
      installment={dialog.row}
      mode={dialog.mode}
      onClose={() => setDialog(null)}
      onDone={() => {
        setDialog(null);
        after();
      }}
    />
  ) : null;
  return { act, node };
}

// ---------------------------------------------------------------------------
// Assinaturas

function SubscriptionForm({
  initial,
  plans,
  onClose,
  onSaved,
}: {
  initial: Row | null;
  plans: Row[];
  onClose: () => void;
  onSaved: (sub: Row) => void;
}) {
  const app = useApp();
  const write = useWrite();
  const [draft, setDraft] = useState<Row>(() => ({
    customer_name: initial?.customer?.name || "",
    phone: initial?.customer?.phone || "",
    plan_id: initial?.plan_id || plans.find((p) => p.active)?.id || "",
    amount: initial ? centsInput(initial.amount_cents) : "",
    discount: initial ? centsInput(initial.discount_cents) : "",
    due_day: initial ? String(initial.due_day) : "",
    start_date: initial?.start_date || "",
    end_date: initial?.end_date || "",
    notes: initial?.notes || "",
    document: "",
    payer_name: "",
    billing_consent: false,
    billing_consent_evidence: "",
  }));
  const set = (key: string) => (value: string) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const plan = plans.find((p) => p.id === draft.plan_id);
  return (
    <FormDialog
      title={initial ? "Editar assinatura" : "Nova assinatura"}
      subtitle={
        initial
          ? "Valores novos valem para as próximas parcelas; as já geradas não mudam."
          : "As parcelas nascem sozinhas até 31 dias antes de cada vencimento."
      }
      onClose={onClose}
      onSubmit={async () => {
        const body: Row = {
          customer_name: draft.customer_name,
          phone: draft.phone,
          notes: draft.notes,
        };
        // Datas só vão quando mudam (só administrador muda).
        if ((draft.end_date || null) !== (initial?.end_date || null))
          body.end_date = draft.end_date || null;
        // Plano, valor e desconto só vão quando mudam (só administrador muda).
        if (!initial || draft.plan_id !== initial.plan_id)
          body.plan_id = draft.plan_id;
        const value = draft.amount
          ? cents(draft.amount)
          : initial
            ? (plan?.amount_cents ?? null)
            : null;
        if (draft.amount && value === null)
          throw new Error("Valor inválido. Use, por exemplo, 180,00.");
        if (initial ? value !== initial.amount_cents : value !== null)
          body.amount_cents = value;
        const discount = draft.discount ? cents(draft.discount) : 0;
        if (discount === null)
          throw new Error("Desconto inválido. Use, por exemplo, 20,00.");
        if (initial ? discount !== initial.discount_cents : discount > 0)
          body.discount_cents = discount;
        if (draft.due_day) body.due_day = Number(draft.due_day);
        if (!initial && draft.start_date) body.start_date = draft.start_date;
        if (!initial && draft.document) body.document = draft.document;
        if (!initial && draft.payer_name) body.payer_name = draft.payer_name;
        if (!initial && draft.billing_consent) {
          body.billing_consent = true;
          body.billing_consent_evidence = draft.billing_consent_evidence;
        }
        const saved = initial
          ? await write(`/subscriptions/${initial.id}`, "PATCH", body)
          : await write("/subscriptions", "POST", body);
        toast(initial ? "Assinatura atualizada." : "Assinatura criada.");
        onSaved(saved);
      }}
    >
      <div className="form-field-grid">
        <Field
          label="Cliente"
          value={draft.customer_name}
          onChange={set("customer_name")}
          maxLength={120}
          required
        />
        <Field
          label="Telefone (WhatsApp)"
          value={draft.phone}
          onChange={set("phone")}
          maxLength={40}
          required
          help="Com DDD. É por ele que o cliente recebe a cobrança e consulta no menu."
        />
      </div>
      {!initial && (
        <div className="form-field-grid">
          <Field
            label="CPF ou CNPJ do pagador (opcional)"
            value={draft.document}
            onChange={set("document")}
            maxLength={20}
            help="Com documento, assinaturas do mesmo pagador ficam juntas e o telefone passa a ser autorizado."
          />
          <Field
            label="Nome do pagador (se for outro)"
            value={draft.payer_name}
            onChange={set("payer_name")}
            maxLength={120}
            placeholder="Ex.: empresa ou responsável"
          />
        </div>
      )}
      <Field
        label="Plano"
        value={draft.plan_id}
        onChange={set("plan_id")}
        options={plans
          .filter((p) => p.active || p.id === initial?.plan_id)
          .map((p) => ({
            id: p.id,
            name: `${p.name} · ${money(p.amount_cents)} · ${periodLabels[p.period]}`,
          }))}
        disabled={!!initial && !app.isAdmin}
        required
      />
      <div className="form-field-grid">
        <Field
          label="Valor (R$)"
          value={draft.amount}
          onChange={set("amount")}
          placeholder={plan ? centsInput(plan.amount_cents) : "0,00"}
          help={
            app.isAdmin
              ? "Em branco, o valor do plano."
              : "Valor e desconto: somente administradores."
          }
          disabled={!app.isAdmin}
        />
        <Field
          label="Desconto (R$)"
          value={draft.discount}
          onChange={set("discount")}
          placeholder="0,00"
          disabled={!app.isAdmin}
        />
        <Field
          label="Dia de vencimento"
          type="number"
          min={1}
          max={31}
          value={draft.due_day}
          onChange={set("due_day")}
          placeholder={plan ? String(plan.due_day) : "10"}
          help="31 vence no último dia dos meses curtos."
        />
      </div>
      <div className="form-field-grid">
        {!initial && (
          <Field
            label="Início"
            type="date"
            value={draft.start_date}
            onChange={set("start_date")}
            help={
              app.isAdmin
                ? "Em branco, hoje."
                : "Hoje. Outra data: somente administradores."
            }
            disabled={!app.isAdmin}
          />
        )}
        <Field
          label="Fim (opcional)"
          type="date"
          value={draft.end_date}
          onChange={set("end_date")}
          disabled={!app.isAdmin}
        />
      </div>
      <Field
        label="Observações internas"
        type="textarea"
        rows={2}
        value={draft.notes}
        onChange={set("notes")}
        maxLength={1000}
        placeholder="Ex.: aluno Pedro, turma de sábado"
      />
      {!initial && app.isAdmin && (
        <ConsentCheck
          checked={!!draft.billing_consent}
          onChange={(value) =>
            setDraft((current) => ({ ...current, billing_consent: value }))
          }
          evidence={draft.billing_consent_evidence}
          onEvidence={set("billing_consent_evidence")}
        />
      )}
    </FormDialog>
  );
}

/**
 * Aceite de cobranças pelo WhatsApp, registrado por um administrador com a
 * evidência (onde o cliente aceitou).
 */
function ConsentCheck({
  checked,
  onChange,
  evidence,
  onEvidence,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  evidence: string;
  onEvidence: (value: string) => void;
}) {
  return (
    <>
      <label className="mensalidade-check">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />{" "}
        O cliente aceitou receber as cobranças e avisos pelo WhatsApp (contrato,
        ficha ou pedido dele). Sem esse aceite, os avisos fora da janela de 24
        horas esperam o cliente escrever.
      </label>
      {checked && (
        <Field
          label="Onde o cliente aceitou"
          value={evidence}
          onChange={onEvidence}
          maxLength={500}
          required
          placeholder="Ex.: contrato de matrícula assinado em 10/11/2026, cláusula 7"
        />
      )}
    </>
  );
}

function ImportDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const write = useWrite();
  const [text, setText] = useState("");
  const [result, setResult] = useState<Row | null>(null);
  const [consent, setConsent] = useState(false);
  const [evidence, setEvidence] = useState("");
  const parsed = parseImport(text);
  if (result)
    return (
      <Dialog
        title="Importação concluída"
        onClose={onDone}
        footer={<Button onClick={onDone}>Fechar</Button>}
      >
        <p>
          {result.created.length} assinatura(s) criada(s)
          {result.skipped.length
            ? `, ${result.skipped.length} já existia(m)`
            : ""}
          .
        </p>
        {result.errors.length > 0 && (
          <Notice tone="error">
            {result.errors
              .map((e: Row) => `Linha ${e.line}: ${e.message}`)
              .join("\n")}
          </Notice>
        )}
      </Dialog>
    );
  return (
    <FormDialog
      title="Importar clientes"
      subtitle="Cole uma linha por cliente: nome; telefone; plano; desconto (opcional); dia de vencimento (opcional). Serve copiar as colunas de uma planilha."
      submitLabel={`Importar ${parsed.rows.length || ""}`.trim()}
      size="lg"
      disabled={!parsed.rows.length}
      onClose={onClose}
      onSubmit={async () => {
        setResult(
          await write("/subscriptions/import", "POST", {
            rows: parsed.rows,
            ...(consent
              ? { billing_consent: true, billing_consent_evidence: evidence }
              : {}),
          }),
        );
      }}
    >
      <Field
        label="Clientes"
        type="textarea"
        rows={10}
        value={text}
        onChange={setText}
        placeholder={
          "Ana Souza; (11) 98765-0001; Inglês Kids; 30,00; 10\nBruno Lima; 11987650002; Inglês Teens"
        }
      />
      {parsed.problems.length > 0 && (
        <Notice tone="error">{parsed.problems.join("\n")}</Notice>
      )}
      <p className="muted">
        {parsed.rows.length} linha(s) pronta(s). O plano é procurado pelo nome
        (Planos e regras). Telefone que já tem assinatura no mesmo plano é
        pulado, então dá para importar a mesma planilha de novo.
      </p>
      <ConsentCheck
        checked={consent}
        onChange={setConsent}
        evidence={evidence}
        onEvidence={setEvidence}
      />
    </FormDialog>
  );
}

function SubscriptionDetail({
  id,
  plans,
  onClose,
  onChanged,
}: {
  id: string;
  plans: Row[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const app = useApp();
  const write = useWrite();
  const { busy, run } = useAction();
  const resource = useResource(`${app.root}/mensalidade/subscriptions/${id}`);
  const [editing, setEditing] = useState(false);
  const sub: Row | null = resource.data;
  const reload = () => {
    void resource.reload();
    onChanged();
  };
  const actions = useInstallmentActions(reload);
  if (!sub)
    return (
      <Dialog title="Assinatura" onClose={onClose} size="lg">
        {resource.error ? (
          <Notice tone="error" onRetry={() => void resource.reload()}>
            {resource.error}
          </Notice>
        ) : (
          <SkeletonRows rows={4} avatar={false} />
        )}
      </Dialog>
    );
  const move = (path: string, message: string) =>
    void run(
      async () => {
        await write(`/subscriptions/${sub.id}/${path}`, "POST", {});
        reload();
      },
      { success: message },
    );
  return (
    <>
      <Dialog
        title={sub.customer.name || "Assinatura"}
        subtitle={
          <>
            <SubscriptionPill status={sub.status} /> {sub.plan_name || "—"} ·{" "}
            {sub.period_label}
          </>
        }
        size="lg"
        onClose={onClose}
        footer={
          sub.status !== "ended" ? (
            <>
              <Button
                secondary
                icon={<Pencil size={16} />}
                onClick={() => setEditing(true)}
              >
                Editar
              </Button>
              {app.isAdmin && sub.status === "active" && (
                <Button
                  secondary
                  icon={<Pause size={16} />}
                  disabled={busy}
                  onClick={() =>
                    move(
                      "pause",
                      "Assinatura pausada. As parcelas a vencer foram canceladas.",
                    )
                  }
                >
                  Pausar
                </Button>
              )}
              {app.isAdmin && sub.status === "paused" && (
                <Button
                  secondary
                  icon={<Play size={16} />}
                  disabled={busy}
                  onClick={() => move("resume", "Assinatura retomada.")}
                >
                  Retomar
                </Button>
              )}
              {app.isAdmin && (
                <Button
                  variant="danger"
                  icon={<Square size={16} />}
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        "Encerrar a assinatura? As parcelas a vencer são canceladas; as vencidas continuam devidas.",
                      )
                    )
                      move("end", "Assinatura encerrada.");
                  }}
                >
                  Encerrar
                </Button>
              )}
            </>
          ) : undefined
        }
      >
        <dl className="mensalidade-facts">
          {sub.payer && (
            <>
              <dt>Pagador</dt>
              <dd>
                {sub.payer.name || "—"}
                {sub.payer.document_display
                  ? ` · ${sub.payer.document_display}`
                  : " · sem CPF/CNPJ"}
              </dd>
            </>
          )}
          <dt>Telefone</dt>
          <dd>
            {phoneLabel(sub.customer.phone)}
            {sub.customer.conversation_id
              ? " · conversa no WhatsApp"
              : " · ainda sem conversa (o cliente precisa escrever)"}
          </dd>
          <dt>Valor</dt>
          <dd>
            {money(sub.charge_cents)}
            {sub.discount_cents
              ? ` (${money(sub.amount_cents)} − desconto ${money(sub.discount_cents)})`
              : ""}
          </dd>
          <dt>Vencimento</dt>
          <dd>Dia {sub.due_day}</dd>
          <dt>Vigência</dt>
          <dd>
            {dateLabel(sub.start_date)}
            {sub.end_date ? ` a ${dateLabel(sub.end_date)}` : " · sem fim"}
          </dd>
          {sub.notes && (
            <>
              <dt>Observações</dt>
              <dd style={{ whiteSpace: "pre-wrap" }}>{sub.notes}</dd>
            </>
          )}
        </dl>
        <h3>Parcelas</h3>
        <Table
          rows={sub.installments || []}
          columns={[
            ["period_label", "Competência"],
            ["due_date", "Vencimento", (row) => dateLabel(row.due_date)],
            ["amount_cents", "Valor", (row) => money(row.amount_cents)],
            [
              "status",
              "Estado",
              (row) => (
                <>
                  <InstallmentPill status={row.status} />
                  {row.status === "paid" && (
                    <small className="muted">
                      {" "}
                      {stampLabel(row.paid_at)} ·{" "}
                      {row.paid_via === "manual"
                        ? `baixa por ${app.names[row.paid_by] || row.paid_by}`
                        : row.paid_via === "link"
                          ? "link"
                          : "Pix"}
                    </small>
                  )}
                </>
              ),
            ],
          ]}
          action={(row) => (
            <InstallmentActions
              row={{ ...row, customer: sub.customer }}
              onAction={actions.act}
            />
          )}
          empty={
            <Empty
              compact
              icon={<Wallet size={28} />}
              title="Nenhuma parcela ainda"
              description="As parcelas são geradas sozinhas até 31 dias antes de cada vencimento."
            />
          }
        />
      </Dialog>
      {editing && (
        <SubscriptionForm
          initial={sub}
          plans={plans}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            reload();
          }}
        />
      )}
      {actions.node}
    </>
  );
}

// ---------------------------------------------------------------------------
// Abas

function InstallmentsTab({
  month,
  onOpen,
  onChanged,
}: {
  month: string;
  onOpen: (subscriptionId: string) => void;
  onChanged: () => void;
}) {
  const app = useApp();
  const [filter, setFilter] = useState("all");
  const params = new URLSearchParams({ month });
  if (filter !== "all") params.set("status", filter);
  const list = useList(`${app.root}/mensalidade/installments?${params}`);
  const counts: Row = list.raw?.counts || {};
  const total = Object.values(counts).reduce(
    (sum: number, n: any) => sum + (Number(n) || 0),
    0,
  );
  const actions = useInstallmentActions(() => {
    void list.reload();
    onChanged();
  });
  return (
    <>
      <div className="chip-row" role="group" aria-label="Filtrar por estado">
        <Chip
          active={filter === "all"}
          count={total}
          onClick={() => setFilter("all")}
        >
          Todas
        </Chip>
        {installmentOrder.map((status) => (
          <Chip
            key={status}
            active={filter === status}
            count={counts[status] || 0}
            onClick={() => setFilter(status)}
          >
            {installmentLabels[status]}
          </Chip>
        ))}
      </div>
      {list.error && (
        <Notice tone="error" onRetry={() => void list.reload()}>
          {list.error}
        </Notice>
      )}
      <section className="card">
        {!list.loaded && !list.error ? (
          <SkeletonRows rows={5} avatar={false} />
        ) : (
          <Table
            rows={list.rows}
            columns={[
              [
                "customer",
                "Cliente",
                (row) => (
                  <button
                    type="button"
                    className="mensalidade-link"
                    onClick={() => onOpen(row.subscription_id)}
                  >
                    {row.customer?.name || phoneLabel(row.customer?.phone)}
                  </button>
                ),
              ],
              ["plan_name", "Plano", (row) => row.plan_name || "—"],
              ["due_date", "Vencimento", (row) => dateLabel(row.due_date)],
              ["amount_cents", "Valor", (row) => money(row.amount_cents)],
              [
                "status",
                "Estado",
                (row) => (
                  <>
                    <InstallmentPill status={row.status} />
                    {row.notices?.overdue ? (
                      <small className="muted">
                        {" "}
                        {row.notices.overdue} aviso(s) de atraso
                      </small>
                    ) : null}
                    {row.notices?.error &&
                      ["open", "overdue"].includes(row.status) && (
                        <div className="mensalidade-error">
                          {row.notices.error}
                        </div>
                      )}
                  </>
                ),
              ],
            ]}
            action={(row) => (
              <InstallmentActions row={row} onAction={actions.act} />
            )}
            empty={
              <Empty
                compact
                icon={<Wallet size={28} />}
                title={`Nenhuma parcela em ${monthLabel(month)}`}
                description="As parcelas nascem sozinhas a partir das assinaturas ativas."
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
      {actions.node}
    </>
  );
}

function SubscriptionsTab({
  plans,
  onOpen,
  reloadKey,
}: {
  plans: Row[];
  onOpen: (id: string) => void;
  reloadKey: number;
}) {
  const app = useApp();
  const [filter, setFilter] = useState("active");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const params = new URLSearchParams();
  if (filter !== "all") params.set("status", filter);
  if (query) params.set("q", query);
  const list = useList(`${app.root}/mensalidade/subscriptions?${params}`);
  useEffect(() => {
    if (reloadKey) void list.reload();
  }, [reloadKey]);
  const counts: Row = list.raw?.counts || {};
  return (
    <>
      <div className="toolbar">
        <SearchBox
          value={search}
          onChange={setSearch}
          placeholder="Buscar por cliente, telefone ou observação"
        />
        {app.isAdmin && (
          <Button
            secondary
            icon={<Upload size={16} />}
            onClick={() => setImporting(true)}
          >
            Importar
          </Button>
        )}
        <Button
          icon={<Plus size={17} />}
          disabled={!plans.some((p) => p.active)}
          onClick={() => setCreating(true)}
        >
          Nova assinatura
        </Button>
      </div>
      {!plans.length && (
        <Notice>
          Cadastre um plano em Planos e regras antes da primeira assinatura.
        </Notice>
      )}
      <div className="chip-row" role="group" aria-label="Filtrar por estado">
        {(["active", "paused", "ended"] as const).map((status) => (
          <Chip
            key={status}
            active={filter === status}
            count={counts[status] || 0}
            onClick={() => setFilter(status)}
          >
            {subscriptionLabels[status]}
          </Chip>
        ))}
        <Chip active={filter === "all"} onClick={() => setFilter("all")}>
          Todas
        </Chip>
      </div>
      <section className="card">
        {!list.loaded && !list.error ? (
          <SkeletonRows rows={5} avatar={false} />
        ) : (
          <Table
            rows={list.rows}
            columns={[
              [
                "customer",
                "Cliente",
                (row) => (
                  <>
                    {row.customer.name}
                    <br />
                    <small className="muted">
                      {phoneLabel(row.customer.phone)}
                    </small>
                  </>
                ),
              ],
              ["plan_name", "Plano", (row) => row.plan_name || "—"],
              [
                "charge_cents",
                "Valor",
                (row) =>
                  `${money(row.charge_cents)} · ${periodLabels[row.period] || ""}`,
              ],
              ["due_day", "Dia"],
              [
                "status",
                "Estado",
                (row) => <SubscriptionPill status={row.status} />,
              ],
              [
                "overdue",
                "Em atraso",
                (row) =>
                  row.overdue_count ? (
                    <Pill tone="danger">
                      {row.overdue_count} · {money(row.overdue_cents)}
                    </Pill>
                  ) : (
                    "—"
                  ),
              ],
            ]}
            action={(row) => (
              <Button secondary size="sm" onClick={() => onOpen(row.id)}>
                Abrir
              </Button>
            )}
            empty={
              <Empty
                compact
                icon={<Wallet size={28} />}
                title="Nenhuma assinatura"
                description="Crie uma assinatura ou importe a lista de clientes."
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
        <SubscriptionForm
          initial={null}
          plans={plans}
          onClose={() => setCreating(false)}
          onSaved={(sub) => {
            setCreating(false);
            void list.reload();
            onOpen(sub.id);
          }}
        />
      )}
      {importing && (
        <ImportDialog
          onClose={() => setImporting(false)}
          onDone={() => {
            setImporting(false);
            void list.reload();
          }}
        />
      )}
    </>
  );
}

function DelinquentsTab({ onOpen }: { onOpen: (id: string) => void }) {
  const app = useApp();
  const list = useList(`${app.root}/mensalidade/delinquents`);
  return (
    <section className="card">
      {!list.loaded && !list.error ? (
        <SkeletonRows rows={4} avatar={false} />
      ) : (
        <Table
          rows={list.rows.map((row) => ({ ...row, id: row.subscription_id }))}
          columns={[
            [
              "customer",
              "Cliente",
              (row) => (
                <>
                  {row.customer.name}
                  <br />
                  <small className="muted">
                    {phoneLabel(row.customer.phone)}
                  </small>
                </>
              ),
            ],
            ["plan_name", "Plano", (row) => row.plan_name || "—"],
            ["overdue_count", "Vencidas"],
            ["overdue_cents", "Total", (row) => money(row.overdue_cents)],
            [
              "oldest_due_date",
              "Desde",
              (row) => dateLabel(row.oldest_due_date),
            ],
            ["notices_sent", "Avisos", (row) => row.notices_sent || 0],
          ]}
          action={(row) => (
            <Button
              secondary
              size="sm"
              onClick={() => onOpen(row.subscription_id)}
            >
              Ver parcelas
            </Button>
          )}
          empty={
            <Empty
              compact
              icon={<Wallet size={28} />}
              title="Ninguém em atraso"
              description="Quem tiver parcela vencida aparece aqui."
            />
          }
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

export function MensalidadesPage() {
  const app = useApp();
  const [tab, setTab] = useState<
    "installments" | "subscriptions" | "payers" | "delinquents"
  >("installments");
  const [month, setMonth] = useState(currentMonth());
  const [openId, setOpenId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const summary = useResource(`${app.root}/mensalidade/summary?month=${month}`);
  const plans = useResource(`${app.root}/mensalidade/plans`);
  const planRows: Row[] = plans.data?.data || [];
  const s: Row | null = summary.data;
  const changed = () => {
    void summary.reload();
    setReloadKey((n) => n + 1);
  };
  const stat = (label: string, value: number, tone: string, note?: string) => (
    <div className={`stat-card tone-${tone}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{money(value)}</span>
      {note && <small>{note}</small>}
    </div>
  );
  return (
    <>
      <IntegrationStatus module="mensalidade" compact />
      <CatalogRecordLinks module="mensalidade" kind="plan" records={planRows} />
      <div className="toolbar">
        <div className="mensalidade-month" aria-label="Mês">
          <IconButton
            label="Mês anterior"
            onClick={() => setMonth(shiftMonth(month, -1))}
          >
            <ChevronLeft size={18} />
          </IconButton>
          <strong>{monthLabel(month)}</strong>
          <IconButton
            label="Próximo mês"
            onClick={() => setMonth(shiftMonth(month, 1))}
          >
            <ChevronRight size={18} />
          </IconButton>
          {month !== currentMonth() && (
            <Button
              secondary
              size="sm"
              onClick={() => setMonth(currentMonth())}
            >
              Mês atual
            </Button>
          )}
        </div>
      </div>
      {s && !s.payments_ready && (
        <Notice tone="warn">
          A Cobrança não está configurada nesta área: os avisos saem sem Pix,
          com as instruções de Planos e regras, e a baixa é manual.
          {app.isAdmin ? " Configure em Gestão → Cobrança." : ""}
        </Notice>
      )}
      {summary.error && (
        <Notice tone="error" onRetry={() => void summary.reload()}>
          {summary.error}
        </Notice>
      )}
      <div className="stat-grid mensalidade-stats">
        {s ? (
          <>
            {stat(
              "Previsto",
              s.expected_cents,
              "brand",
              `${s.counts.open + s.counts.paid + s.counts.overdue} parcela(s)`,
            )}
            {stat(
              "Recebido",
              s.received_cents,
              "ok",
              `${s.counts.paid} paga(s)`,
            )}
            {stat(
              "Em atraso",
              s.overdue_cents,
              "danger",
              `${s.counts.overdue} vencida(s)`,
            )}
            {stat(
              "Em aberto",
              s.open_cents,
              "warn",
              `${s.counts.open} a vencer`,
            )}
            {stat(
              "Inadimplência total",
              s.overdue_total.cents,
              "danger",
              `${s.overdue_total.subscriptions} cliente(s), todos os meses`,
            )}
          </>
        ) : (
          <SkeletonRows rows={1} avatar={false} />
        )}
      </div>
      <Segmented
        label="Visão"
        value={tab}
        onChange={setTab}
        options={[
          { value: "installments", label: "Parcelas do mês" },
          { value: "subscriptions", label: "Assinaturas" },
          { value: "payers", label: "Pagadores" },
          {
            value: "delinquents",
            label: "Inadimplentes",
            count: s?.overdue_total.subscriptions || undefined,
          },
        ]}
      />
      {tab === "installments" && (
        <InstallmentsTab month={month} onOpen={setOpenId} onChanged={changed} />
      )}
      {tab === "subscriptions" && (
        <SubscriptionsTab
          plans={planRows}
          onOpen={setOpenId}
          reloadKey={reloadKey}
        />
      )}
      {tab === "delinquents" && <DelinquentsTab onOpen={setOpenId} />}
      {tab === "payers" && <PayersTab onOpenSubscription={setOpenId} />}
      {openId && (
        <SubscriptionDetail
          id={openId}
          plans={planRows}
          onClose={() => setOpenId(null)}
          onChanged={changed}
        />
      )}
    </>
  );
}
