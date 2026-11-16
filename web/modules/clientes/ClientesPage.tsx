// Clientes (módulo "clientes", docs/CLIENTES.md): lista com busca, ficha
// mascarada, revelar com motivo (auditado), linha do tempo do relacionamento,
// pedido de exclusão ao titular, histórico de exclusões e auditoria.
import React, { useEffect, useState } from "react";
import { Eye, Pencil, Plus, ShieldAlert, Trash2, Users } from "lucide-react";
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
  Segmented,
  SkeletonRows,
  Table,
  toast,
} from "../../ui";
import { FormDialog, Pager, useList, useResource } from "../../admin/shared";
import {
  addressLine,
  dateLabel,
  erasureLabels,
  erasureTones,
  fieldLabels,
  ieLabels,
  kindLabels,
  moduleLabels,
  sourceLabels,
  stampLabel,
  statusLabels,
  viaLabels,
} from "./shared";
import "./clientes.css";

const ADDRESS: [string, string, number][] = [
  ["cep", "CEP", 9],
  ["street", "Logradouro", 120],
  ["number", "Número", 20],
  ["complement", "Complemento", 60],
  ["district", "Bairro", 60],
  ["city", "Município", 60],
  ["uf", "UF", 2],
  ["city_ibge", "Código IBGE do município", 7],
];

/** Criar ou corrigir. Na correção, os campos mascarados ficam em branco: só o preenchido muda. */
export function CustomerForm({
  initial,
  onClose,
  onSaved,
}: {
  initial: Row | null;
  onClose: () => void;
  onSaved: (row: Row) => void;
}) {
  const app = useApp();
  const write = useIntents(app.api);
  const [draft, setDraft] = useState<Row>(() => ({
    kind: initial?.kind || "pf",
    name: initial?.name || "",
    trade_name: initial?.trade_name || "",
    document: "",
    individual_business: !!initial?.individual_business,
    ie: "",
    ie_indicator: initial?.ie_indicator || "9",
    im: "",
    email: "",
    phone: "",
    notes: initial?.notes || "",
    ...Object.fromEntries(ADDRESS.map(([k]) => [k, ""])),
  }));
  const set = (key: string) => (value: any) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const masked = (key: string) =>
    initial ? `Atual: ${initial[key] || "—"}. Em branco, mantém.` : undefined;
  return (
    <FormDialog
      title={initial ? "Corrigir ficha" : "Nova ficha"}
      subtitle={
        initial
          ? "Os dados pessoais aparecem mascarados: preencha só o que muda."
          : "Prefira o link de autocadastro: o próprio cliente preenche e dá o aceite."
      }
      onClose={onClose}
      onSubmit={async () => {
        const body: Row = {
          kind: draft.kind,
          name: draft.name,
          trade_name: draft.kind === "pj" ? draft.trade_name : "",
          individual_business: draft.kind === "pj" && !!draft.individual_business,
          ie_indicator: draft.ie_indicator,
          notes: draft.notes,
        };
        for (const key of ["document", "ie", "im", "email", ...ADDRESS.map(([k]) => k)])
          if (!initial || draft[key]) body[key] = draft[key];
        let saved: Row;
        if (initial)
          saved = await write(`${app.root}/clientes/customers/${initial.id}`, "PATCH", {
            ...body,
            expected_version: initial.version,
          });
        else {
          if (draft.phone) body.phones = [draft.phone];
          saved = await write(`${app.root}/clientes/customers`, "POST", body);
        }
        toast(initial ? "Ficha corrigida." : "Ficha criada.");
        onSaved(saved);
      }}
    >
      <div className="form-field-grid">
        <Field
          label="Tipo"
          value={draft.kind}
          onChange={set("kind")}
          options={[
            ["pf", kindLabels.pf],
            ["pj", kindLabels.pj],
          ]}
          emptyOption={null}
        />
        <Field
          label={draft.kind === "pj" ? "Razão social" : "Nome completo"}
          value={draft.name}
          onChange={set("name")}
          maxLength={150}
          required
        />
      </div>
      <div className="form-field-grid">
        <Field
          label={draft.kind === "pj" ? "CNPJ" : "CPF"}
          value={draft.document}
          onChange={set("document")}
          maxLength={20}
          help={masked("document_display") || "Os dígitos são conferidos. Aceita o CNPJ com letras."}
        />
        {draft.kind === "pj" && (
          <Field
            label="Nome fantasia"
            value={draft.trade_name}
            onChange={set("trade_name")}
            maxLength={150}
          />
        )}
      </div>
      {draft.kind === "pj" && (
        <label className="clientes-check">
          <input
            type="checkbox"
            checked={!!draft.individual_business}
            onChange={(e) => set("individual_business")(e.target.checked)}
          />{" "}
          CNPJ de MEI ou empresário individual (fica mascarado como dado pessoal)
        </label>
      )}
      <div className="form-field-grid">
        <Field
          label="Indicador da inscrição estadual"
          value={draft.ie_indicator}
          onChange={set("ie_indicator")}
          options={Object.entries(ieLabels)}
          emptyOption={null}
        />
        <Field label="Inscrição estadual" value={draft.ie} onChange={set("ie")} maxLength={20} help={masked("ie")} />
        <Field label="Inscrição municipal" value={draft.im} onChange={set("im")} maxLength={20} help={masked("im")} />
      </div>
      <div className="form-field-grid">
        <Field label="E-mail" type="email" value={draft.email} onChange={set("email")} maxLength={200} help={masked("email")} />
        {!initial && (
          <Field label="Telefone" value={draft.phone} onChange={set("phone")} maxLength={40} help="Com DDD. Outros, depois, na ficha." />
        )}
      </div>
      <div className="form-field-grid">
        {ADDRESS.map(([key, label, max]) => (
          <Field
            key={key}
            label={label}
            value={draft[key]}
            onChange={set(key)}
            maxLength={max}
            help={initial ? `Atual: ${initial.address?.[key] || "—"}` : undefined}
          />
        ))}
      </div>
      <Field
        label="Observações internas"
        type="textarea"
        rows={2}
        value={draft.notes}
        onChange={set("notes")}
        maxLength={2000}
      />
    </FormDialog>
  );
}

/** Revelar: motivo obrigatório, campos escolhidos; o resultado some ao fechar. */
function RevealDialog({
  customer,
  onClose,
}: {
  customer: Row;
  onClose: () => void;
}) {
  const app = useApp();
  const [reason, setReason] = useState("");
  const [fields, setFields] = useState<string[]>(Object.keys(fieldLabels));
  const [shown, setShown] = useState<Row | null>(null);
  if (shown)
    return (
      <Dialog
        title="Dados sem máscara"
        subtitle="Este acesso ficou registrado com o seu nome e o motivo."
        onClose={onClose}
      >
        <dl className="clientes-facts">
          {fields.includes("document") && (
            <>
              <dt>CPF/CNPJ</dt>
              <dd>{shown.document_display || "—"}</dd>
            </>
          )}
          {fields.includes("email") && (
            <>
              <dt>E-mail</dt>
              <dd>{shown.email || "—"}</dd>
            </>
          )}
          {fields.includes("phones") && (
            <>
              <dt>Telefones</dt>
              <dd>{(shown.phones || []).map((p: Row) => p.phone).join(", ") || "—"}</dd>
            </>
          )}
          {fields.includes("address") && (
            <>
              <dt>Endereço</dt>
              <dd>{addressLine(shown.address)}</dd>
            </>
          )}
          {fields.includes("ie") && (
            <>
              <dt>Inscrição estadual</dt>
              <dd>{shown.ie || "—"}</dd>
            </>
          )}
          {fields.includes("im") && (
            <>
              <dt>Inscrição municipal</dt>
              <dd>{shown.im || "—"}</dd>
            </>
          )}
        </dl>
      </Dialog>
    );
  return (
    <FormDialog
      title="Ver dados sem máscara"
      subtitle="Fica registrado quem viu, quando, o quê e por quê."
      submitLabel="Ver dados"
      onClose={onClose}
      onSubmit={async () => {
        const query = new URLSearchParams({ reason, fields: fields.join(",") });
        setShown(
          await app.api(`${app.root}/clientes/customers/${customer.id}/reveal?${query}`),
        );
      }}
    >
      <Field
        label="Motivo"
        value={reason}
        onChange={setReason}
        maxLength={300}
        required
        placeholder="Ex.: conferir o CPF para emitir a NF-e"
      />
      <fieldset className="clientes-fields">
        <legend>Campos</legend>
        {Object.entries(fieldLabels).map(([key, label]) => (
          <label key={key} className="clientes-check">
            <input
              type="checkbox"
              checked={fields.includes(key)}
              onChange={(e) =>
                setFields(
                  e.target.checked
                    ? [...fields, key]
                    : fields.filter((f) => f !== key),
                )
              }
            />{" "}
            {label}
          </label>
        ))}
      </fieldset>
    </FormDialog>
  );
}

export function Timeline({ customerId }: { customerId: string }) {
  const app = useApp();
  const timeline = useResource(`${app.root}/clientes/customers/${customerId}/timeline`);
  const rows: Row[] = timeline.data?.data || [];
  if (!timeline.data && !timeline.error) return <SkeletonRows rows={3} avatar={false} />;
  if (timeline.error)
    return (
      <Notice tone="error" onRetry={() => void timeline.reload()}>
        {timeline.error}
      </Notice>
    );
  return (
    <>
      <ol className="clientes-timeline">
        {rows.map((item) => (
          <li key={`${item.module}:${item.kind}:${item.ref_id}`}>
            <time>{stampLabel(item.at)}</time>
            <span className="clientes-timeline-module">
              {moduleLabels[item.module] || item.module}
            </span>
            <span>{item.title}</span>
            {item.status && <Pill tone="muted">{item.status}</Pill>}
          </li>
        ))}
      </ol>
      {!rows.length && (
        <Empty compact title="Sem relacionamento ainda" description="Conversas, protocolos, pedidos, vendas e agendamentos aparecem aqui." />
      )}
      {(timeline.data?.skipped || []).length > 0 && (
        <p className="muted">
          <small>
            Não foi possível ler:{" "}
            {timeline.data.skipped.map((s: Row) => moduleLabels[s.module] || s.module).join(", ")}.
          </small>
        </p>
      )}
    </>
  );
}

function AccessLog({ customerId }: { customerId?: string }) {
  const app = useApp();
  const list = useList(
    customerId
      ? `${app.root}/clientes/customers/${customerId}/access-log`
      : `${app.root}/clientes/access-log`,
  );
  if (!list.loaded && !list.error) return <SkeletonRows rows={3} avatar={false} />;
  return (
    <>
      <Table
        rows={list.rows}
        columns={[
          ["created", "Quando", (row) => stampLabel(row.created)],
          ["actor", "Quem", (row) => app.names[row.actor] || row.actor],
          ["action", "O quê", (row) => (row.action === "fiscal" ? "Emissão de nota" : "Revelar")],
          ["fields", "Campos", (row) => (row.fields || []).map((f: string) => fieldLabels[f] || f).join(", ")],
          ["reason", "Motivo"],
          ...(customerId ? [] : ([["customer_id", "Ficha", (row: Row) => row.customer_id.slice(0, 8)]] as any)),
        ]}
        empty={<Empty compact title="Ninguém viu dados sem máscara" description="Cada revelação e cada emissão de nota ficam registradas aqui." />}
      />
      <Pager cursor={list.cursor} nextCursor={list.nextCursor} setCursor={list.setCursor} />
    </>
  );
}

function CustomerDetail({
  id,
  onClose,
  onChanged,
}: {
  id: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const app = useApp();
  const write = useIntents(app.api);
  const { busy, run } = useAction();
  const resource = useResource(`${app.root}/clientes/customers/${id}`);
  const [tab, setTab] = useState<"ficha" | "relacionamento" | "acessos">("ficha");
  const [editing, setEditing] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [phone, setPhone] = useState("");
  const customer: Row | null = resource.data;
  const reload = () => {
    void resource.reload();
    onChanged();
  };
  if (!customer)
    return (
      <Dialog title="Cliente" onClose={onClose} size="lg">
        {resource.error ? (
          <Notice tone="error" onRetry={() => void resource.reload()}>
            {resource.error}
          </Notice>
        ) : (
          <SkeletonRows rows={4} avatar={false} />
        )}
      </Dialog>
    );
  const active = customer.status === "active";
  const erasure: Row | null = customer.erasure;
  return (
    <>
      <Dialog
        title={customer.name || "Cliente com dados excluídos"}
        subtitle={
          <>
            <Pill tone={active ? "ok" : "muted"}>{statusLabels[customer.status]}</Pill>{" "}
            {kindLabels[customer.kind]} · {customer.document_display || "sem CPF/CNPJ"}
          </>
        }
        size="lg"
        onClose={onClose}
        footer={
          active && (
            <>
              {customer.revealable && (
                <Button secondary icon={<Eye size={16} />} onClick={() => setRevealing(true)}>
                  Ver sem máscara
                </Button>
              )}
              <Button secondary icon={<Pencil size={16} />} onClick={() => setEditing(true)}>
                Corrigir
              </Button>
              {!erasure && (
                <Button
                  secondary
                  icon={<Trash2 size={16} />}
                  disabled={busy}
                  onClick={() =>
                    void run(
                      async () => {
                        await write(`${app.root}/clientes/customers/${customer.id}/erasure`, "POST", {});
                        reload();
                      },
                      { success: "Pedido enviado ao cliente pelo WhatsApp. Só ele confirma." },
                    )
                  }
                >
                  Pedir exclusão ao cliente
                </Button>
              )}
            </>
          )
        }
      >
        {erasure && (
          <Notice tone="warn">
            Exclusão {erasureLabels[erasure.status]?.toLowerCase()} · pedida por{" "}
            {viaLabels[erasure.requested_via] || erasure.requested_via} em {stampLabel(erasure.created)}.
            {erasure.status === "awaiting_confirmation" && (
              <>
                {" "}
                Vale até {stampLabel(erasure.expires_at)}.{" "}
                <Button
                  secondary
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      async () => {
                        await write(`${app.root}/clientes/erasures/${erasure.id}/cancel`, "POST", {});
                        reload();
                      },
                      { success: "Pedido cancelado." },
                    )
                  }
                >
                  Cancelar pedido
                </Button>
              </>
            )}
          </Notice>
        )}
        <Segmented
          label="Seções da ficha"
          value={tab}
          onChange={setTab}
          options={[
            { value: "ficha", label: "Ficha" },
            { value: "relacionamento", label: "Relacionamento" },
            ...(app.isAdmin ? [{ value: "acessos" as const, label: "Quem viu" }] : []),
          ]}
        />
        {tab === "ficha" && (
          <>
            {customer.masked && active && (
              <p className="muted">
                <ShieldAlert size={14} /> Dados pessoais mascarados.
                {customer.revealable
                  ? " Para ver, use Ver sem máscara e informe o motivo."
                  : " Só administradores veem sem máscara nesta área."}
              </p>
            )}
            <dl className="clientes-facts">
              {customer.trade_name && (
                <>
                  <dt>Nome fantasia</dt>
                  <dd>{customer.trade_name}</dd>
                </>
              )}
              <dt>Inscrição estadual</dt>
              <dd>
                {customer.ie || "—"} · {ieLabels[customer.ie_indicator]}
              </dd>
              {customer.im && (
                <>
                  <dt>Inscrição municipal</dt>
                  <dd>{customer.im}</dd>
                </>
              )}
              <dt>E-mail</dt>
              <dd>{customer.email || "—"}</dd>
              <dt>Endereço</dt>
              <dd>{addressLine(customer.address)}</dd>
              <dt>Origem</dt>
              <dd>{sourceLabels[customer.source] || customer.source}</dd>
              <dt>Pronta para nota</dt>
              <dd>
                {customer.fiscal_ready?.nfe ? "NF-e, NFC-e e NFS-e" : customer.fiscal_ready?.nfse ? "NFC-e e NFS-e (falta endereço completo para NF-e)" : "NFC-e sem CPF/CNPJ"}
              </dd>
              {customer.notes && (
                <>
                  <dt>Observações</dt>
                  <dd>{customer.notes}</dd>
                </>
              )}
            </dl>
            <h3>Telefones</h3>
            <Table
              rows={(customer.phones || []).map((p: Row, i: number) => ({ ...p, id: String(i) }))}
              columns={[
                ["phone", "Telefone"],
                ["label", "Quem", (row) => row.label || "—"],
                ["verified", "Confirmado", (row) => (row.verified ? <Pill tone="ok">Pelo WhatsApp</Pill> : <Pill tone="muted">Pela equipe</Pill>)],
              ]}
              empty={<Empty compact title="Nenhum telefone" description="Sem telefone, a ficha não se liga às conversas." />}
            />
            {active && (
              <form
                className="form-field-grid"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(
                    async () => {
                      await write(`${app.root}/clientes/customers/${customer.id}/phones`, "POST", { phone });
                      setPhone("");
                      reload();
                    },
                    { success: "Telefone acrescentado." },
                  );
                }}
              >
                <Field label="Novo telefone" value={phone} onChange={setPhone} maxLength={40} required />
                <div>
                  <Button type="submit" secondary icon={<Plus size={16} />} busy={busy}>
                    Acrescentar
                  </Button>
                </div>
              </form>
            )}
            <h3>Aceites</h3>
            <Table
              rows={customer.consents || []}
              columns={[
                ["created", "Quando", (row) => stampLabel(row.created)],
                ["terms_version", "Versão do texto"],
                ["source", "Onde", (row) => (row.source === "web_step" ? "Link do cadastro" : row.source)],
                ["status", "Situação", (row) => (row.status === "granted" ? "Aceito" : "Revogado")],
              ]}
              empty={<Empty compact title="Sem aceite registrado" description="Ficha criada pela equipe: envie o link para o cliente conferir e aceitar." />}
            />
            <h3>Notas fiscais</h3>
            <Table
              rows={(customer.fiscal_documents || []).map((d: Row) => ({ ...d, id: `${d.module_id}:${d.ref_id}` }))}
              columns={[
                ["model", "Modelo", (row) => String(row.model).toUpperCase()],
                ["number", "Número", (row) => `${row.number || "—"}${row.series ? ` (série ${row.series})` : ""}`],
                ["issued_at", "Emissão", (row) => dateLabel(row.issued_at)],
                ["retain_until", "Guarda até", (row) => dateLabel(row.retain_until)],
              ]}
              empty={<Empty compact title="Nenhuma nota vinculada" />}
            />
          </>
        )}
        {tab === "relacionamento" && <Timeline customerId={customer.id} />}
        {tab === "acessos" && <AccessLog customerId={customer.id} />}
      </Dialog>
      {editing && (
        <CustomerForm
          initial={customer}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            reload();
          }}
        />
      )}
      {revealing && <RevealDialog customer={customer} onClose={() => setRevealing(false)} />}
    </>
  );
}

function ErasuresTab() {
  const app = useApp();
  const list = useList(`${app.root}/clientes/erasures`);
  if (!list.loaded && !list.error) return <SkeletonRows rows={4} avatar={false} />;
  return (
    <section className="card">
      <p className="muted">
        Pedidos de exclusão de dados (LGPD, art. 18). Ficam só os vínculos de atendimento (números de
        conversas e protocolos) e a guarda das notas fiscais pelo prazo legal, sem dado pessoal.
      </p>
      <Table
        rows={list.rows}
        columns={[
          ["created", "Pedido", (row) => stampLabel(row.created)],
          ["requested_via", "Como", (row) => viaLabels[row.requested_via] || row.requested_via],
          ["status", "Situação", (row) => <Pill tone={erasureTones[row.status] || "muted"}>{erasureLabels[row.status] || row.status}</Pill>],
          ["confirmed_via", "Confirmação do titular", (row) => (row.confirmed_at ? `${viaLabels[row.confirmed_via] || row.confirmed_via} · ${stampLabel(row.confirmed_at)}` : "—")],
          ["kept", "Guardado", (row) => `${row.kept?.conversation_ids?.length || 0} conversa(s), ${row.kept?.ticket_ids?.length || 0} protocolo(s)${row.kept?.fiscal_documents ? `, ${row.kept.fiscal_documents} nota(s) até ${dateLabel(row.kept.fiscal_retention_until)}` : ""}`],
          ["modules", "Módulos", (row) => Object.entries(row.modules || {}).map(([m, r]: [string, any]) => `${moduleLabels[m] || m}: ${r.status === "done" ? "ok" : "pendente"}`).join("; ") || "—"],
        ]}
        empty={<Empty compact title="Nenhum pedido de exclusão" />}
      />
    </section>
  );
}

export function ClientesPage() {
  const app = useApp();
  const [tab, setTab] = useState<"clientes" | "exclusoes" | "auditoria">("clientes");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("active");
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const params = new URLSearchParams({ status, ...(query ? { q: query } : {}) });
  const list = useList(`${app.root}/clientes/customers?${params}`);
  return (
    <>
      {app.isAdmin && (
        <Segmented
          label="Clientes"
          value={tab}
          onChange={setTab}
          options={[
            { value: "clientes", label: "Fichas" },
            { value: "exclusoes", label: "Exclusões" },
            { value: "auditoria", label: "Quem viu dados" },
          ]}
        />
      )}
      {tab === "exclusoes" && <ErasuresTab />}
      {tab === "auditoria" && (
        <section className="card">
          <AccessLog />
        </section>
      )}
      {tab === "clientes" && (
        <>
          <div className="toolbar">
            <SearchBox value={search} onChange={setSearch} placeholder="Buscar por nome, CPF/CNPJ ou telefone completos" />
            <Field
              label="Situação"
              value={status}
              onChange={setStatus}
              options={[
                ["active", "Ativas"],
                ["erasing", "Exclusão em andamento"],
                ["erased", "Dados excluídos"],
                ["all", "Todas"],
              ]}
              emptyOption={null}
            />
            <Button icon={<Plus size={17} />} onClick={() => setCreating(true)}>
              Nova ficha
            </Button>
          </div>
          <section className="card">
            {!list.loaded && !list.error ? (
              <SkeletonRows rows={5} avatar={false} />
            ) : (
              <Table
                rows={list.rows}
                columns={[
                  ["name", "Cliente", (row) => row.name || <span className="muted">Dados excluídos</span>],
                  ["kind", "Tipo", (row) => kindLabels[row.kind]],
                  ["document_display", "CPF/CNPJ", (row) => row.document_display || "—"],
                  ["phones", "Telefone", (row) => row.phones?.[0]?.phone || "—"],
                  ["address", "Cidade", (row) => (row.address?.city ? `${row.address.city}/${row.address.uf}` : "—")],
                  ["updated", "Atualizada", (row) => dateLabel(row.updated)],
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
                    title="Nenhuma ficha"
                    description='Ponha "Meu cadastro" no menu do WhatsApp ou envie o link pela conversa: o cliente preenche e aceita.'
                  />
                }
              />
            )}
            <Pager cursor={list.cursor} nextCursor={list.nextCursor} setCursor={list.setCursor} />
          </section>
        </>
      )}
      {creating && (
        <CustomerForm
          initial={null}
          onClose={() => setCreating(false)}
          onSaved={(row) => {
            setCreating(false);
            void list.reload();
            setOpenId(row.id);
          }}
        />
      )}
      {openId && <CustomerDetail id={openId} onClose={() => setOpenId(null)} onChanged={() => void list.reload()} />}
    </>
  );
}
