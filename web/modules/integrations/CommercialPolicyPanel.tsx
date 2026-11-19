import React, { useEffect, useState } from "react";
import { Button, Field } from "../../ui";
import { integrationError, useIntegrationApi } from "./api";
import { integrationAccess, useIntegrationHost } from "./visibility";
import type { CommercialPolicy, PolicyInitialization } from "./contracts";

export function missingDefaults(policy: CommercialPolicy, stock: boolean, finance: boolean) {
  return [stock && !policy.warehouse_id && "Depósito para baixa física", finance && !policy.revenue_category_id && "Categoria de receita", finance && !policy.payment_method_id && "Forma de pagamento", finance && !Object.keys(policy.settlement_accounts).length && "Conta de baixa para o meio de recebimento"].filter((v): v is string => !!v);
}
export function CommercialPolicyPanel() {
  const host = useIntegrationHost(), api = useIntegrationApi();
  const access = host && integrationAccess(host.context);
  const [open, setOpen] = useState(false), [policy, setPolicy] = useState<{ api: typeof api; value: CommercialPolicy } | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), [reload, setReload] = useState(0);
  useEffect(() => {
    if (!open || !api || !access?.policy) return;
    const request = new AbortController(); setError("");
    void api.policy(request.signal).then(value => { if (!request.signal.aborted) setPolicy({ api, value }); }).catch(e => { if (!request.signal.aborted) setError(integrationError(e)); });
    return () => request.abort();
  }, [api, open, access?.policy, reload]);
  if (!api || !access?.policy) return null;
  const value = policy?.api === api ? policy.value : null;
  return <section className="card"><Button secondary onClick={() => setOpen(!open)}>{open ? "Recolher padrões comerciais" : "Padrões comerciais da área"}</Button>
    {open && <>{error && <p role="alert">{error}</p>}{value ? <PolicyForm key={`${host?.actor}:${host?.root}:${value.version}`} policy={value} busy={busy} onSave={async (body, initialize) => {
      setBusy(true); setError("");
      try { const result = initialize ? await api.initialize(body as PolicyInitialization) : await api.patchPolicy(body); setPolicy({ api, value: result }); }
      catch (e) { setError(integrationError(e)); }
      finally { setBusy(false); }
    }} /> : <p>Consultando padrões…</p>}
      {api.pending("policy") && <><p>Confirmação pendente. Repetir mantém os dados e a chave originais.</p><Button disabled={busy} onClick={() => { setBusy(true); void api.resumePolicy().then(value => setPolicy({ api, value })).catch(e => setError(integrationError(e))).finally(() => setBusy(false)); }}>Repetir configuração</Button></>}
      <Button secondary disabled={busy} onClick={() => setReload(n => n + 1)}>Recarregar padrões</Button>
    </>}
  </section>;
}
function PolicyForm({ policy, busy, onSave }: { policy: CommercialPolicy; busy: boolean; onSave(body: Partial<CommercialPolicy> & { version: number } | PolicyInitialization, initialize: boolean): Promise<void> }) {
  const host = useIntegrationHost()!, api = useIntegrationApi()!, access = integrationAccess(host.context);
  const [stock, setStock] = useState(policy.auto_post.stock), [finance, setFinance] = useState(policy.auto_post.finance);
  const [warehouse, setWarehouse] = useState(policy.warehouse_id ?? ""), [category, setCategory] = useState(policy.revenue_category_id ?? ""), [method, setMethod] = useState(policy.payment_method_id ?? "");
  const [accounts, setAccounts] = useState(policy.settlement_accounts), [accountMethod, setAccountMethod] = useState<keyof CommercialPolicy["settlement_accounts"]>("cash");
  const [accountKind, setAccountKind] = useState<"cash" | "bank" | "other">("cash"), [paymentType, setPaymentType] = useState("01");
  const [name, setName] = useState(""), [kind, setKind] = useState(access.finance ? "category" : "warehouse"), [review, setReview] = useState(false);
  const [initialization, setInitialization] = useState<PolicyInitialization | null>(null), [error, setError] = useState("");
  const disabled = busy || !access.configure || !!api.pending("policy");
  const prepare = async () => {
    setError(""); if (!name.trim()) return;
    let body: PolicyInitialization = { version: policy.version };
    if (kind === "warehouse") {
      if (!access.stock) return;
      try { const settings = await host.api(host.root + "/erp/v1/estoque/depositos"); body.warehouse = { name: name.trim(), expected_setting_version: settings.default.version }; }
      catch (e) { setError(integrationError(e)); return; }
    } else if (!access.finance) return;
    else if (kind === "category") body.category = { name: name.trim() };
    else if (kind === "method") body.payment_method = { name: name.trim(), type: paymentType };
    else body.account = { name: name.trim(), kind: accountKind, method: accountMethod };
    setInitialization(body); setReview(true);
  };
  return <div><h3>Padrões e lançamento automático</h3>
    <ul>{missingDefaults(policy, access.stock, access.finance).map(label => <li key={label}>Ausente: {label}</li>)}</ul>
    <p>Referências devem existir e estar ativas. Nenhum cadastro é escolhido automaticamente. A conta é necessária para confirmar uma baixa.</p>
    <fieldset disabled={disabled}>
      {access.stock && <><label><input type="checkbox" checked={stock} onChange={e => setStock(e.target.checked)} /> Lançar estoque automaticamente</label><PolicyReference kind="warehouse" label="Depósito existente" value={warehouse} onChange={setWarehouse} disabled={disabled} /></>}
      {access.finance && <><label><input type="checkbox" checked={finance} onChange={e => setFinance(e.target.checked)} /> Lançar financeiro automaticamente</label><PolicyReference kind="category" label="Categoria de receita existente" value={category} onChange={setCategory} disabled={disabled} /><PolicyReference kind="method" label="Forma de pagamento existente" value={method} onChange={setMethod} disabled={disabled} />
        <Field label="Meio de recebimento para a conta de baixa" value={accountMethod} onChange={v => setAccountMethod(v as typeof accountMethod)} emptyOption={null} options={RECEIPT_METHODS} />
        <PolicyReference key={accountMethod} kind="account" label="Conta de baixa existente" value={accounts[accountMethod] ?? ''} disabled={disabled} onChange={value => setAccounts(previous => { const next = { ...previous }; if (value) next[accountMethod] = value; else delete next[accountMethod]; return next; })} /></>}
      {access.configure && <Button onClick={() => void onSave({ version: policy.version, auto_post: { ...(access.stock ? { stock } : {}), ...(access.finance ? { finance } : {}) } as CommercialPolicy["auto_post"],
        ...(access.stock && warehouse !== (policy.warehouse_id ?? "") ? { warehouse_id: warehouse || null } : {}),
        ...(access.finance && category !== (policy.revenue_category_id ?? "") ? { revenue_category_id: category || null } : {}),
        ...(access.finance && method !== (policy.payment_method_id ?? "") ? { payment_method_id: method || null } : {}),
        ...(access.finance && JSON.stringify(accounts) !== JSON.stringify(policy.settlement_accounts) ? { settlement_accounts: accounts } : {}),
      }, false)}>Salvar padrões</Button>}
    </fieldset>
    {access.configure && <fieldset disabled={disabled}><legend>Inicialização humana</legend>
      <Field label="Cadastro a criar" value={kind} onChange={v => { setKind(v); setReview(false); }} emptyOption={null} options={[...(access.finance ? [{ id: "category", name: "Categoria de receita" }, { id: "method", name: "Forma de pagamento" }, { id: "account", name: "Conta de baixa" }] : []), ...(access.stock ? [{ id: "warehouse", name: "Depósito" }] : [])]} />
      {kind === 'account' && <><Field label="Tipo da conta real" value={accountKind} onChange={v => { setAccountKind(v as typeof accountKind); setReview(false); }} emptyOption={null} options={[{ id: 'cash', name: 'Caixa físico' }, { id: 'bank', name: 'Conta bancária existente' }, { id: 'other', name: 'Outra conta real' }]} /><Field label="Meio de recebimento" value={accountMethod} onChange={v => { setAccountMethod(v as typeof accountMethod); setReview(false); }} emptyOption={null} options={RECEIPT_METHODS} /></>}
      {kind === 'method' && <Field label="Tipo de pagamento" value={paymentType} onChange={v => { setPaymentType(v); setReview(false); }} emptyOption={null} options={[{ id: '01', name: 'Dinheiro' }, { id: '17', name: 'Pix' }, { id: '03', name: 'Cartão de crédito' }, { id: '04', name: 'Cartão de débito' }, { id: '99', name: 'Outro' }]} />}
      <Field label="Nome real do cadastro" value={name} onChange={v => { setName(v); setReview(false); }} />
      <Button secondary disabled={!name.trim()} onClick={() => void prepare()}>Conferir criação</Button>
      {error && <p role="alert">{error}</p>}
      {review && initialization && <><p>Criar “{name}” como {kind === "account" ? `conta ${accountKind === "bank" ? "bancária" : accountKind === "cash" ? "de caixa" : "de outro tipo"}, para ${RECEIPT_METHODS.find(m => m.id === accountMethod)?.name}, sem saldo inicial` : kind === "method" ? "forma de pagamento selecionada, sem baixa automática" : kind === "warehouse" ? "depósito com controle de saldo" : "categoria de receita"}. A ação usa sua identidade e permissões.</p><Button onClick={() => void onSave(initialization, true)}>Confirmar criação deste cadastro</Button></>}
    </fieldset>}
  </div>;
}

const RECEIPT_METHODS = [{ id: 'cash', name: 'Dinheiro' }, { id: 'pix', name: 'Pix' }, { id: 'card', name: 'Cartão' }, { id: 'other', name: 'Outro' }, { id: 'unknown', name: 'Não informado' }];
function PolicyReference({ kind, label, value, onChange, disabled }: { kind: 'warehouse' | 'category' | 'method' | 'account'; label: string; value: string; onChange(value: string): void; disabled: boolean }) {
  const api = useIntegrationApi();
  const [query, setQuery] = useState(''), [items, setItems] = useState<{ id: string; name: string }[]>([]), [next, setNext] = useState<string | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const search = (after?: string) => {
    if (!api || disabled) return;
    setBusy(true); setError('');
    void api.policyReferences(kind, query, after).then(result => { setItems(previous => after ? [...previous, ...result.items.filter(row => !previous.some(p => p.id === row.id))] : result.items); setNext(result.next_cursor); }).catch(e => setError(integrationError(e))).finally(() => setBusy(false));
  };
  return <div><Field label={label} value={value} onChange={onChange} disabled={disabled || busy} options={value && !items.some(row => row.id === value) ? [{ id: value, name: 'Referência atual · ' + value }, ...items] : items} />
    {!disabled && <><Field label={'Buscar ' + label.toLowerCase()} value={query} onChange={setQuery} /><Button secondary disabled={busy} onClick={() => search()}>Buscar cadastros existentes</Button>{next && <Button secondary disabled={busy} onClick={() => search(next)}>Mais cadastros</Button>}</>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
