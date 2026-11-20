// OS4: contratos de manutenção (lista, criar, editar, suspender, encerrar e
// imprimir) e "Manutenções a abrir". Aba da lista de ordens (?aba=contratos e
// ?aba=manutencoes). Exige Ordem de Serviço e Mensalidade ligadas; com uma
// delas desligada, a tela diz qual módulo ligar.
import React, { useState } from "react";
import { useApp } from "../../../app/AppContext";
import { FormDialog, Pager } from "../../../admin/shared";
import { Button, Empty, Field, Notice, toast } from "../../../ui";
import { navigate } from "../../../lib/routes";
import { ResourceState, useDraftGuard, useWorkApi, useWorkResource } from "../work-hooks";
import { money, cents } from "../shared";
import { openPrint } from "../work/print";
import { buildContractPrintHtml } from "./print";
import { brDate, hoursText, type Contract, type ContractBody, type ContractOptions, type ContractStatus } from "./types";

const SITUATIONS: { id: string; name: string }[] = [
  { id: "active,suspended", name: "Vigentes e suspensos" },
  { id: "active", name: "Vigentes" },
  { id: "suspended", name: "Suspensos" },
  { id: "ended", name: "Encerrados" },
  { id: "", name: "Todos" },
];

/** Avisa qual módulo ligar; null quando está tudo ligado. */
export function ContractModules({ options }: { options?: ContractOptions }) {
  if (!options?.missing) return null;
  return <Notice>{options.missing}</Notice>;
}

function nextDueText(contract: Contract) {
  const sub = contract.subscription;
  if (!sub) return contract.plan ? "Sem assinatura" : "—";
  if (sub.status !== "active") return `Assinatura ${sub.status_label.toLowerCase()}`;
  const next = sub.next_due.slice(0, 2).map(d => `${brDate(d.due_date)} · ${money(d.amount_cents)}`).join("; ");
  return `${sub.overdue ? `Em atraso (${money(sub.overdue_cents)}) · ` : ""}${next || "Sem vencimento previsto"}`;
}

export async function printContract(api: ReturnType<typeof useWorkApi>, contract: Contract) {
  const company = await api.establishment().catch(() => null);
  if (!openPrint(buildContractPrintHtml(contract, company))) toast("Permita janelas pop-up neste endereço para imprimir o contrato.", { tone: "error" });
}

export function ContractsView() {
  const app = useApp(), api = useWorkApi();
  const [situation, setSituation] = useState("active,suspended"), [search, setSearch] = useState(""), [q, setQ] = useState("");
  const [cursor, setCursor] = useState(""), [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState<Contract | "new" | null>(null);
  const [changing, setChanging] = useState<{ contract: Contract; to: ContractStatus } | null>(null);
  const options = useWorkResource(app.root + "/os4-contract-options", () => api.contractOptions(), String(revision));
  const ready = !!options.data && !options.data.missing;
  const list = useWorkResource(ready ? `${app.root}/os4-contracts/${situation}/${q}/${cursor}/${revision}` : null,
    () => api.contracts({ situation: situation || undefined, q: q || undefined, cursor: cursor || undefined, limit: "50" }));
  const reload = () => setRevision(n => n + 1);
  return <div className="os-work">
    <ResourceState resource={options} />
    <ContractModules options={options.data} />
    {ready && <>
      <form className="os-work-toolbar" onSubmit={event => { event.preventDefault(); setCursor(""); setQ(search.trim()); }}>
        <Button onClick={() => setEditing("new")}>Novo contrato</Button>
        <Field label="Situação" value={situation} emptyOption={null} options={SITUATIONS} onChange={value => { setCursor(""); setSituation(value); }} />
        <Field label="Buscar por número ou cliente" value={search} onChange={setSearch} />
        <Button type="submit" secondary>Buscar</Button>
      </form>
      {!options.data!.plans.length && <Notice>Cadastre um plano em Mensalidade → Planos para criar contratos.</Notice>}
      <ResourceState resource={list} />
      {list.data && (list.data.data.length ? <div className="table-stack"><div className="table-scroll"><table>
        <thead><tr>{["Número", "Cliente", "Plano", "Situação", "Próximos vencimentos", "Uso no período", "Vigência", "Ações"].map(h => <th key={h} scope="col">{h}</th>)}</tr></thead>
        <tbody>{list.data.data.map(contract => <tr key={contract.id}>
          <td data-label="Número">{contract.number}</td>
          <td data-label="Cliente">{contract.customer.name || "Sem nome"}{contract.objects.length ? <div className="muted">{contract.objects.map(o => o.identifier).join(", ")}</div> : null}</td>
          <td data-label="Plano">{contract.plan?.name || "—"}</td>
          <td data-label="Situação">{contract.status_label}{contract.warnings.length ? <div className="muted">{contract.warnings[0]}</div> : null}</td>
          <td data-label="Próximos vencimentos">{nextDueText(contract)}</td>
          <td data-label="Uso no período">{contract.usage.text}</td>
          <td data-label="Vigência">{brDate(contract.starts_on)} – {contract.ends_on ? brDate(contract.ends_on) : "indeterminado"}</td>
          <td data-label="Ações"><div className="os-work-toolbar">
            {contract.status !== "ended" && <Button secondary size="sm" onClick={() => setEditing(contract)}>Editar</Button>}
            {contract.status === "active" && <Button secondary size="sm" onClick={() => setChanging({ contract, to: "suspended" })}>Suspender</Button>}
            {contract.status === "suspended" && <Button secondary size="sm" onClick={() => setChanging({ contract, to: "active" })}>Reativar</Button>}
            {contract.status !== "ended" && <Button secondary size="sm" variant="danger" onClick={() => setChanging({ contract, to: "ended" })}>Encerrar</Button>}
            <Button secondary size="sm" onClick={() => printContract(api, contract)}>Imprimir</Button>
          </div></td>
        </tr>)}</tbody>
      </table></div></div> : <Empty title="Nenhum contrato aqui" description="Crie um contrato de manutenção para ligar um cliente a um plano da Mensalidade." />)}
      {list.data && <Pager cursor={cursor} nextCursor={list.data.next_cursor} setCursor={setCursor} />}
    </>}
    {editing && options.data && <ContractForm options={options.data} contract={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
    {changing && <ContractSituationDialog contract={changing.contract} to={changing.to} onClose={() => setChanging(null)} onSaved={() => { setChanging(null); reload(); }} />}
  </div>;
}

export function ContractSituationDialog({ contract, to, onClose, onSaved }: { contract: Contract; to: ContractStatus; onClose: () => void; onSaved: () => void }) {
  const api = useWorkApi();
  const [reason, setReason] = useState(""), [follow, setFollow] = useState(true);
  const title = { active: "Reativar contrato", suspended: "Suspender contrato", ended: "Encerrar contrato" }[to];
  const subscription = { active: "Retomar também a assinatura na Mensalidade", suspended: "Pausar também a assinatura na Mensalidade", ended: "Encerrar também a assinatura na Mensalidade" }[to];
  return <FormDialog title={`${title} · ${contract.display_number}`} danger={to === "ended"} submitLabel={title} onClose={onClose}
    subtitle={to === "ended" ? "Encerrado não volta. As ordens já cobertas continuam como estão." : to === "suspended" ? "Enquanto suspenso, novas ordens não podem ser marcadas como cobertas." : undefined}
    onSubmit={async () => {
      if (to !== "active" && !reason.trim()) throw new Error("Informe o motivo.");
      await api.contractSituation(contract.id, { status: to, reason: reason.trim() || undefined, subscription: follow ? "follow" : "keep", version: contract.version });
      toast(`${title}: feito.`);
      onSaved();
    }}>
    <Field label={to === "active" ? "Observação (opcional)" : "Motivo"} required={to !== "active"} value={reason} maxLength={500} type="textarea" rows={3} onChange={setReason} />
    {contract.subscription && contract.subscription.status !== "ended" && <label className="os-check"><input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)} /> {subscription}</label>}
  </FormDialog>;
}

interface Draft {
  contactId: string; contactName: string; objectIds: string[]; planId: string; subscriptionMode: "new" | "none";
  typeIds: string[]; services: string; unit: "visits" | "hours"; limit: string; period: "month" | "quarter" | "year";
  excess: "quote" | "approval"; excessPrice: string; startsOn: string; endsOn: string;
  adjustment: string; adjustmentOn: string; overdue: "warn" | "block"; terms: string;
  visitKind: "" | "every_days" | "month_day"; visitDays: string; visitDay: string; visitLead: string; visitType: string; visitItem: string; visitFirst: string;
}
const todayCivil = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
function draftOf(contract: Contract | null): Draft {
  const c = contract?.coverage, v = contract?.visits;
  return {
    contactId: contract?.customer.contact_id || "", contactName: contract?.customer.name || "", objectIds: contract?.objects.map(o => o.id) || [],
    planId: contract?.plan?.id || "", subscriptionMode: "new",
    typeIds: c?.type_ids || [], services: c?.services || "", unit: c?.unit || "visits",
    limit: c ? (c.unit === "hours" ? hoursText(c.limit) : String(c.limit)) : "2", period: c?.period || "month",
    excess: c?.excess || "quote", excessPrice: c?.excess_unit_cents != null ? (c.excess_unit_cents / 100).toFixed(2).replace(".", ",") : "",
    startsOn: contract?.starts_on || todayCivil(), endsOn: contract?.ends_on || "",
    adjustment: contract?.adjustment ? String(contract.adjustment.percent).replace(".", ",") : "", adjustmentOn: contract?.adjustment?.on || "",
    overdue: contract?.overdue_policy || "warn", terms: contract?.terms || "",
    visitKind: v?.kind || "", visitDays: String(v?.days ?? 30), visitDay: String(v?.day ?? 10), visitLead: String(v?.lead_days ?? 7),
    visitType: v?.type_id || "service_order", visitItem: v?.item || "Manutenção programada", visitFirst: v?.first_on || "",
  };
}
const decimalNumber = (value: string) => Number(value.replace(",", "."));

function bodyOf(draft: Draft, creating: boolean): ContractBody {
  const limit = decimalNumber(draft.limit);
  if (!Number.isFinite(limit) || limit <= 0) throw new Error(draft.unit === "visits" ? "Informe o limite de visitas por período." : "Informe o limite de horas por período.");
  const price = draft.excessPrice.trim() ? cents(draft.excessPrice) : null;
  if (draft.excessPrice.trim() && price == null) throw new Error("Preço do excedente: use, por exemplo, 150,00.");
  const percent = draft.adjustment.trim() ? decimalNumber(draft.adjustment) : null;
  if (percent !== null && (!Number.isFinite(percent) || percent < 0 || percent > 100)) throw new Error("Reajuste: percentual de 0 a 100.");
  if (!draft.planId) throw new Error("Escolha o plano da Mensalidade.");
  if (creating && !draft.contactId) throw new Error("Escolha o cliente do contrato.");
  return {
    ...(creating ? { contact_id: draft.contactId, create_subscription: draft.subscriptionMode === "new" } : {}),
    customer_name: draft.contactName || undefined,
    object_ids: draft.objectIds, plan_id: draft.planId,
    coverage: { type_ids: draft.typeIds, services: draft.services, unit: draft.unit, limit: draft.unit === "visits" ? Math.round(limit) : limit,
      period: draft.period, excess: draft.excess, excess_unit_cents: price },
    starts_on: draft.startsOn, ends_on: draft.endsOn || null,
    adjustment: percent === null ? null : { percent, ...(draft.adjustmentOn ? { on: draft.adjustmentOn } : {}) },
    overdue_policy: draft.overdue, terms: draft.terms,
    visits: !draft.visitKind ? null : {
      kind: draft.visitKind, ...(draft.visitKind === "every_days" ? { days: Number(draft.visitDays) } : { day: Number(draft.visitDay) }),
      lead_days: Number(draft.visitLead || 0), type_id: draft.visitType, item: draft.visitItem, first_on: draft.visitFirst || null,
    },
  };
}

export function ContractForm({ options, contract, onClose, onSaved, initialContact }: {
  options: ContractOptions; contract: Contract | null; onClose: () => void; onSaved: (contract: Contract) => void;
  initialContact?: { id: string; name: string };
}) {
  const app = useApp(), api = useWorkApi();
  const [draft, setDraft] = useState<Draft>(() => ({ ...draftOf(contract), ...(initialContact && !contract ? { contactId: initialContact.id, contactName: initialContact.name } : {}) }));
  const [dirty, setDirty] = useState(false), [search, setSearch] = useState(""), [query, setQuery] = useState("");
  const close = useDraftGuard(dirty, onClose);
  const set = (patch: Partial<Draft>) => { setDirty(true); setDraft(old => ({ ...old, ...patch })); };
  const contacts = useWorkResource(query ? `${app.root}/os4-contract-contact/${query}` : null, () => api.contacts(query));
  const people = (contacts.data?.data || []).filter(c => !c.merged_into && (!c.namespace || c.namespace === "team") && (!c.identity_state || c.identity_state === "active") && c.name);
  const objects = useWorkResource(draft.contactId ? `${app.root}/os4-contract-objects/${draft.contactId}` : null,
    () => api.objects({ contact_id: draft.contactId, include_archived: "0", limit: 50 }));
  const toggle = (list: string[], id: string, on: boolean) => on ? [...new Set([...list, id])] : list.filter(x => x !== id);
  const plans = options.plans.some(p => p.id === draft.planId) || !contract?.plan ? options.plans : [...options.plans, { id: contract.plan.id, name: `${contract.plan.name} (desativado)`, amount_cents: contract.plan.amount_cents ?? 0, period_label: contract.plan.period_label, due_day: 0 }];
  return <FormDialog title={contract ? `Editar ${contract.display_number}` : "Novo contrato de manutenção"} size="lg" onClose={close}
    subtitle="A cobrança é a da assinatura da Mensalidade: o contrato diz o que ela cobre."
    onSubmit={async () => {
      const body = bodyOf(draft, !contract);
      const saved = contract ? await api.updateContract(contract.id, { ...body, version: contract.version }) : await api.createContract(body);
      setDirty(false);
      toast(contract ? "Contrato salvo." : `${saved.display_number} criado.`);
      onSaved(saved);
    }}>
    <fieldset><legend>Cliente e objetos</legend>
      {contract || initialContact ? <p>Cliente: <strong>{draft.contactName || "Sem nome"}</strong></p> : <>
        <p>Cliente: <strong>{draft.contactId ? draft.contactName : "escolha no cadastro"}</strong></p>
        <div className="form-field-grid">
          <Field label="Buscar cliente" value={search} onChange={setSearch} placeholder="Nome ou telefone" />
          <Button secondary disabled={!search.trim()} onClick={() => setQuery(search.trim())}>Buscar</Button>
        </div>
        {query && contacts.data && !people.length && <p className="muted">Nenhum contato com nome encontrado. Cadastre o cliente em Contatos.</p>}
        {people.length > 0 && <Field label="Escolha o cliente" value={draft.contactId} options={people.map(c => ({ id: c.id, name: `${c.name}${c.phone ? " · " + c.phone : ""}` }))}
          onChange={id => { const c = people.find(p => p.id === id); if (c) set({ contactId: c.id, contactName: c.name || "", objectIds: [] }); }} />}
      </>}
      {draft.contactId && <>
        <ResourceState resource={objects} />
        {objects.data && (objects.data.data.length ? <div><p className="muted">Objetos cobertos (opcional):</p>
          {objects.data.data.filter(o => !o.archived).map(o => <label key={o.id} className="os-check"><input type="checkbox" checked={draft.objectIds.includes(o.id)}
            onChange={event => set({ objectIds: toggle(draft.objectIds, o.id, event.target.checked) })} /> {o.identifier}</label>)}
        </div> : <p className="muted">Este cliente não tem objetos do serviço cadastrados. O contrato vale para o cliente.</p>)}
      </>}
    </fieldset>
    <fieldset><legend>Plano e vigência</legend>
      <Field label="Plano da Mensalidade" required value={draft.planId} options={plans.map(p => ({ id: p.id, name: `${p.name} · ${money(p.amount_cents)} ${p.period_label.toLowerCase()}` }))} onChange={planId => set({ planId })} />
      {!contract && <Field label="Cobrança" value={draft.subscriptionMode} emptyOption={null}
        options={[{ id: "new", name: "Criar a assinatura na Mensalidade (valor e dia do plano)" }, { id: "none", name: "Sem assinatura (não cobra)" }]}
        onChange={value => set({ subscriptionMode: value as Draft["subscriptionMode"] })} />}
      <div className="form-field-grid">
        <Field label="Início" type="date" required value={draft.startsOn} onChange={startsOn => set({ startsOn })} />
        <Field label="Fim (vazio: indeterminado)" type="date" value={draft.endsOn} onChange={endsOn => set({ endsOn })} />
      </div>
      <div className="form-field-grid">
        <Field label="Reajuste anual informado (%)" value={draft.adjustment} placeholder="Ex.: 5,5" onChange={adjustment => set({ adjustment })}
          help="Só registrado e avisado na data. O valor da assinatura não muda sozinho." />
        <Field label="Data do reajuste" type="date" value={draft.adjustmentOn} onChange={adjustmentOn => set({ adjustmentOn })} help="Vazio: um ano após o início." />
      </div>
      <Field label="Assinatura em atraso" value={draft.overdue} emptyOption={null}
        options={[{ id: "warn", name: "Só avisar ao marcar a ordem coberta" }, { id: "block", name: "Bloquear a cobertura até o pagamento" }]}
        onChange={value => set({ overdue: value as Draft["overdue"] })} help="Atraso pela regra da Mensalidade: parcela vencida além da carência." />
    </fieldset>
    <fieldset><legend>O que cobre</legend>
      <p className="muted">Modelos de ordem incluídos (nenhum marcado: todos):</p>
      {options.types.map(t => <label key={t.id} className="os-check"><input type="checkbox" checked={draft.typeIds.includes(t.id)}
        onChange={event => set({ typeIds: toggle(draft.typeIds, t.id, event.target.checked) })} /> {t.label}</label>)}
      <Field label="Serviços incluídos (texto para imprimir)" type="textarea" rows={2} maxLength={1000} value={draft.services} onChange={services => set({ services })} />
      <div className="form-field-grid">
        <Field label="Unidade" value={draft.unit} emptyOption={null} options={[{ id: "visits", name: "Visitas" }, { id: "hours", name: "Horas" }]} onChange={value => set({ unit: value as Draft["unit"] })} />
        <Field label={draft.unit === "visits" ? "Visitas por período" : "Horas por período"} required value={draft.limit} onChange={limit => set({ limit })} />
        <Field label="Período" value={draft.period} emptyOption={null} options={[{ id: "month", name: "Mês" }, { id: "quarter", name: "Trimestre" }, { id: "year", name: "Ano" }]} onChange={value => set({ period: value as Draft["period"] })} />
      </div>
      <div className="form-field-grid">
        <Field label="Excedente" value={draft.excess} emptyOption={null}
          options={[{ id: "quote", name: "Cobra pelo orçamento normal da ordem" }, { id: "approval", name: "Avisa e pede aprovação do cliente" }]} onChange={value => set({ excess: value as Draft["excess"] })} />
        <Field label={`Preço por ${draft.unit === "visits" ? "visita" : "hora"} excedente (R$)`} value={draft.excessPrice} placeholder="Vazio: preço no orçamento" onChange={excessPrice => set({ excessPrice })} />
      </div>
      <Field label="Condições (texto para imprimir)" type="textarea" rows={4} maxLength={4000} value={draft.terms} onChange={terms => set({ terms })} />
    </fieldset>
    <fieldset><legend>Visitas programadas</legend>
      <Field label="Recorrência" value={draft.visitKind} emptyOption={null}
        options={[{ id: "", name: "Sem visitas programadas" }, { id: "every_days", name: "A cada N dias" }, { id: "month_day", name: "Todo mês no dia" }]}
        onChange={value => set({ visitKind: value as Draft["visitKind"] })} />
      {draft.visitKind && <>
        <div className="form-field-grid">
          {draft.visitKind === "every_days"
            ? <Field label="A cada (dias)" type="number" min={1} max={365} value={draft.visitDays} onChange={visitDays => set({ visitDays })} />
            : <Field label="Dia do mês" type="number" min={1} max={31} value={draft.visitDay} onChange={visitDay => set({ visitDay })} />}
          <Field label="Mostrar para abrir com antecedência (dias)" type="number" min={0} max={60} value={draft.visitLead} onChange={visitLead => set({ visitLead })} />
          <Field label="Primeira visita (opcional)" type="date" value={draft.visitFirst} onChange={visitFirst => set({ visitFirst })} />
        </div>
        <div className="form-field-grid">
          <Field label="Modelo da ordem de manutenção" value={draft.visitType} emptyOption={null} options={options.types.map(t => ({ id: t.id, name: t.label }))} onChange={visitType => set({ visitType })} />
          <Field label="Descrição da ordem" value={draft.visitItem} maxLength={200} onChange={visitItem => set({ visitItem })} />
        </div>
        <p className="muted">O sistema propõe a próxima ordem em "Manutenções a abrir"; ninguém recebe ordem aberta sozinha.</p>
      </>}
    </fieldset>
  </FormDialog>;
}

/** "Manutenções a abrir": visitas propostas para a pessoa confirmar (abrir ou pular). */
export function MaintenanceDueView() {
  const app = useApp(), api = useWorkApi();
  const [revision, setRevision] = useState(0);
  const [skipping, setSkipping] = useState<{ id: string; due_on: string; label: string } | null>(null);
  const [objectChoice, setObjectChoice] = useState<Record<string, string>>({});
  const due = useWorkResource(`${app.root}/os4-maintenance-due/${revision}`, () => api.maintenanceDue());
  const open = async (contractId: string, dueOn: string) => {
    try {
      const result = await api.openVisit(contractId, { due_on: dueOn, action: "open", ...(objectChoice[contractId] ? { object_id: objectChoice[contractId] } : {}) });
      for (const warning of result.warnings) toast(warning, { tone: "error" });
      if (result.order) {
        toast(`Ordem ${result.order.number} aberta. Agende a execução na ordem.`);
        navigate({ area: "admin", page: "work", typeId: result.order.type_id, id: result.order.id });
      } else setRevision(n => n + 1);
    } catch (error) {
      toast((error as Error).message, { tone: "error" });
    }
  };
  return <div className="os-work">
    <ResourceState resource={due} />
    {due.data && !due.data.available && <Notice>{due.data.missing}</Notice>}
    {due.data?.available && (due.data.data.length ? <ul className="os-work-records">{due.data.data.map(item => <li key={item.contract.id} className="os-work-record">
      <strong>{item.contract.display_number} · {item.contract.customer.name || "Sem nome"}</strong>
      <p>{item.type_label}: {item.item} · prevista para {brDate(item.due_on)}{item.overdue ? " (atrasada)" : ""}</p>
      <p className="muted">{item.contract.visits?.text} · {item.contract.usage.text}</p>
      {item.contract.warnings.map(w => <p key={w} className="muted">{w}</p>)}
      {item.objects.length > 1 && <Field label="Objeto da visita" value={objectChoice[item.contract.id] || ""} options={item.objects.map(o => ({ id: o.id, name: `${o.type_label}: ${o.identifier}` }))}
        onChange={id => setObjectChoice({ ...objectChoice, [item.contract.id]: id })} />}
      <div className="os-work-toolbar">
        <Button onClick={() => open(item.contract.id, item.due_on)}>Abrir ordem de manutenção</Button>
        <Button secondary onClick={() => setSkipping({ id: item.contract.id, due_on: item.due_on, label: `${item.contract.display_number} · ${brDate(item.due_on)}` })}>Pular esta data</Button>
      </div>
    </li>)}</ul> : <Empty title="Nenhuma manutenção a abrir" description="As visitas programadas dos contratos aparecem aqui com a antecedência configurada." />)}
    {skipping && <SkipDialog item={skipping} onClose={() => setSkipping(null)} onSaved={() => { setSkipping(null); setRevision(n => n + 1); }} />}
  </div>;
}

function SkipDialog({ item, onClose, onSaved }: { item: { id: string; due_on: string; label: string }; onClose: () => void; onSaved: () => void }) {
  const api = useWorkApi();
  const [reason, setReason] = useState("");
  return <FormDialog title={`Pular visita · ${item.label}`} submitLabel="Pular" onClose={onClose} onSubmit={async () => {
    await api.openVisit(item.id, { due_on: item.due_on, action: "skip", reason: reason.trim() || undefined });
    onSaved();
  }}>
    <Field label="Motivo (opcional)" value={reason} maxLength={300} onChange={setReason} />
  </FormDialog>;
}

/** Contrato vigente na tela do objeto do serviço (e onde mais couber). */
export function ContractsInForce({ objectId, contactId, title = "Contrato de manutenção" }: { objectId?: string; contactId?: string; title?: string }) {
  const app = useApp(), api = useWorkApi();
  const options = useWorkResource(app.root + "/os4-contract-options", () => api.contractOptions());
  const ready = !!options.data && !options.data.missing;
  const list = useWorkResource(ready && (objectId || contactId) ? `${app.root}/os4-contracts-in-force/${objectId || ""}/${contactId || ""}` : null,
    () => api.contracts({ situation: "active,suspended", ...(objectId ? { object_id: objectId } : { contact_id: contactId }), limit: "20" }));
  if (!ready) return null;
  const current = (list.data?.data || []).filter(c => c.in_force || c.status === "suspended");
  return <section className="os-work-section">
    <h3>{title}</h3>
    {!list.data ? <ResourceState resource={list} /> : current.length ? <ul className="os-work-records">{current.map(c => <li key={c.id} className="os-work-record">
      <strong>{c.display_number} · {c.status_label}</strong>
      <p>{c.plan?.name || "Sem plano"} · {c.coverage.text} · {c.usage.text}</p>
      <p className="muted">Vigência: {brDate(c.starts_on)} – {c.ends_on ? brDate(c.ends_on) : "indeterminado"}{c.subscription?.overdue ? " · Assinatura em atraso" : ""}</p>
      <Button secondary size="sm" onClick={() => printContract(api, c)}>Imprimir contrato</Button>
    </li>)}</ul> : <p className="muted">Sem contrato de manutenção vigente.</p>}
  </section>;
}
