// Gestão › Empresas: várias empresas (CNPJs) na mesma conta. Cada empresa é
// uma área de atendimento com o ERP dela; esta página fica por cima:
// - Todas as empresas: vendas, contas a receber e a pagar e saldo das contas
//   de cada empresa lado a lado (só o administrador do ERP);
// - Copiar cadastros: de outra empresa para esta, com prévia e sem duplicar;
// - Adicionar empresa: área nova com o ERP ligado, os dados da empresa e as
//   pessoas de acesso (só o administrador da conta).
// Rotas em /api/v1/profiles/:area/erp-empresas (src/erp/multiempresa/routes.ts).
import React, { useEffect, useMemo, useState } from "react";
import { Building2 } from "lucide-react";
import { useApp } from "../app/AppContext";
import { useAction } from "../app/hooks";
import { companyLabel, formatCnpj } from "../app/company-switch";
import type { Row } from "../lib/api";
import { Button, Card, Empty, Field, Notice, Pill, Segmented, SkeletonRows } from "../ui";
import "../app/company.css";

type Tab = "todas" | "copiar" | "nova";

const PERIODS: [string, string][] = [["hoje", "Hoje"], ["7d", "Últimos 7 dias"], ["30d", "Últimos 30 dias"], ["3m", "Últimos 3 meses"], ["6m", "Últimos 6 meses"], ["12m", "Últimos 12 meses"]];
const KINDS: [string, string][] = [
  ["produtos", "Produtos (com categorias e listas de preços)"],
  ["contatos", "Contatos (clientes e fornecedores)"],
  ["formas_pagamento", "Formas de pagamento"],
  ["categorias_financeiras", "Categorias financeiras"],
  ["naturezas", "Naturezas de operação"],
];
const REGIMES: [string, string][] = [["simples", "Simples Nacional"], ["simples_excesso", "Simples Nacional com excesso de sublimite"], ["normal", "Regime normal (lucro presumido ou real)"], ["mei", "MEI"]];
const UFS = ["AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA", "MG", "MS", "MT", "PA", "PB", "PE", "PI", "PR", "RJ", "RN", "RO", "RR", "RS", "SC", "SE", "SP", "TO"];

const money = (cents: unknown) => cents === null || cents === undefined ? "—"
  : (Number(BigInt(String(cents))) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

/** O primeiro erp:<papel> da pessoa (o administrador da conta vale administrador do ERP). */
function erpRole(me: Row) {
  if (me.role === "admin") return "admin";
  return ((me.access ?? []) as string[]).find((item) => item.startsWith("erp:"))?.slice(4) ?? null;
}

export function CompaniesPage() {
  const app = useApp();
  const admin = erpRole(app.me) === "admin";
  const [tab, setTab] = useState<Tab>(admin ? "todas" : app.isAdmin ? "nova" : "todas");
  const options = [
    { value: "todas" as const, label: "Todas as empresas" },
    { value: "copiar" as const, label: "Copiar cadastros" },
    ...(app.isAdmin ? [{ value: "nova" as const, label: "Adicionar empresa" }] : []),
  ];
  return (
    <div>
      <p className="workspace-help">
        <Building2 size={15} aria-hidden /> Cada empresa (CNPJ) tem o seu ERP. Troque de empresa pelo seletor Empresa, no topo do painel.
      </p>
      <Segmented label="O que fazer" value={tab} onChange={setTab} options={options} />
      <div style={{ marginTop: 14 }}>
        {tab === "todas" && (admin ? <Consolidated /> : <Notice tone="warn">Ver todas as empresas lado a lado é só para quem é administrador do ERP em todas as empresas. Peça ao administrador em Gestão › Pessoas e acessos.</Notice>)}
        {tab === "copiar" && (admin ? <CopyRecords /> : <Notice tone="warn">Copiar cadastros entre empresas é só para o administrador do ERP. Peça ao administrador em Gestão › Pessoas e acessos.</Notice>)}
        {tab === "nova" && app.isAdmin && <NewCompany />}
      </div>
    </div>
  );
}

function Consolidated() {
  const app = useApp();
  const [period, setPeriod] = useState("30d");
  const [data, setData] = useState<Row | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setBusy(true);
    setError("");
    try {
      setData(await app.api(`${app.root}/erp-empresas/consolidado?periodo=${period}`));
    } catch (e: any) {
      setError(e.message || "O resumo das empresas não chegou. Tente de novo.");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => { void load(); }, [period, app.root]);
  return (
    <Card
      title="Todas as empresas"
      description="Vendas do período, contas a receber e a pagar em aberto e o saldo das contas de cada empresa, lado a lado. Só leitura."
      actions={<Field label="Período" value={period} onChange={setPeriod} options={PERIODS} emptyOption={null} />}
    >
      {error && <Notice tone="error" onRetry={() => void load()}>{error}</Notice>}
      {!data && !error && <SkeletonRows />}
      {data && (
        <>
          {data.total_empresas > data.limite && (
            <Notice tone="info">Mostrando {data.empresas.length} de {data.total_empresas} empresas (até {data.limite} por vez).</Notice>
          )}
          <div className="companies-scroll">
            <table className="companies-table">
              <thead>
                <tr>
                  <th>Empresa</th><th>Vendas</th><th>A receber</th><th>Vencido a receber</th><th>A pagar</th><th>Vencido a pagar</th><th>Saldo das contas</th>
                </tr>
              </thead>
              <tbody>
                {data.empresas.map((row: Row) => (
                  <tr key={row.area}>
                    <td>
                      {row.nome_fantasia}
                      <small>{row.cnpj ? formatCnpj(row.cnpj) : row.area_nome}</small>
                      {row.erro && <small>{row.erro}</small>}
                      {row.area !== app.profile && (
                        <Button variant="ghost" onClick={() => app.chooseProfile(row.area, { area: "erp" })}>Abrir</Button>
                      )}
                    </td>
                    <td>{row.resumo?.vendas ? <>{money(row.resumo.vendas.total_centavos)}<small>{row.resumo.vendas.pedidos} pedido(s)</small></> : "—"}</td>
                    <td>{money(row.resumo?.receber?.aberto_centavos)}</td>
                    <td>{money(row.resumo?.receber?.vencido_centavos)}</td>
                    <td>{money(row.resumo?.pagar?.aberto_centavos)}</td>
                    <td>{money(row.resumo?.pagar?.vencido_centavos)}</td>
                    <td>{money(row.resumo?.saldo_contas_centavos)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td>{money(data.total.vendas_centavos)}</td>
                  <td>{money(data.total.receber_centavos)}</td>
                  <td>{money(data.total.receber_vencido_centavos)}</td>
                  <td>{money(data.total.pagar_centavos)}</td>
                  <td>{money(data.total.pagar_vencido_centavos)}</td>
                  <td>{money(data.total.saldo_contas_centavos)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          {data.total.incompleto && (
            <Notice tone="info">
              “—” é o que a empresa não mostra: a parte do ERP está desligada nela (Vendas ou Financeiro, em Gestão › Módulos) ou o ERP dela não respondeu. O total soma só o que aparece.
            </Notice>
          )}
          {busy && <p className="workspace-help">Atualizando…</p>}
        </>
      )}
    </Card>
  );
}

function CopyRecords() {
  const app = useApp();
  const { busyKey: busy, run } = useAction();
  const others = app.companies.filter((company) => company.area !== app.profile);
  const [origin, setOrigin] = useState("");
  const [kinds, setKinds] = useState<string[]>(["produtos", "contatos"]);
  const [preview, setPreview] = useState<Row | null>(null);
  const [result, setResult] = useState<Row | null>(null);
  const [command, setCommand] = useState(() => crypto.randomUUID());
  const here = app.companies.find((company) => company.area === app.profile);
  useEffect(() => { setPreview(null); setResult(null); setCommand(crypto.randomUUID()); }, [origin, kinds.join(","), app.profile]);
  if (!others.length)
    return <Empty title="Nenhuma outra empresa" description="Para copiar cadastros, você precisa de acesso a outra empresa com o ERP ligado. O administrador da conta adiciona empresas na aba Adicionar empresa." />;
  const toggle = (kind: string) => setKinds((list) => list.includes(kind) ? list.filter((k) => k !== kind) : [...list, kind]);
  const showPreview = () => run(async () => {
    setPreview(await app.api(`${app.root}/erp-empresas/copiar/previa?origem=${encodeURIComponent(origin)}&cadastros=${kinds.join(",")}`));
  }, { key: "preview" });
  const copy = () => run(async () => {
    setResult(await app.api(`${app.root}/erp-empresas/copiar`, "POST", { origem: origin, cadastros: kinds, comando: command }, undefined, command));
  }, { key: "copy", success: "Cópia concluída." });
  return (
    <Card
      title={`Copiar cadastros para ${here ? companyLabel(here) : "esta empresa"}`}
      description="O que já existe aqui fica como está: produto é conferido pelo código e contato pelo CPF/CNPJ; os outros cadastros, pelo nome. Nada é apagado nem alterado."
    >
      <Field label="De qual empresa" value={origin} onChange={setOrigin} options={others.map((company) => [company.area, companyLabel(company)])} emptyOption="Escolha a empresa de origem" />
      <div className="companies-kinds" role="group" aria-label="O que copiar">
        {KINDS.map(([id, label]) => (
          <label key={id}><input type="checkbox" checked={kinds.includes(id)} onChange={() => toggle(id)} /> {label}</label>
        ))}
      </div>
      <div className="card-actions">
        <Button variant="secondary" disabled={!origin || !kinds.length || !!busy} busy={busy === "preview"} onClick={() => void showPreview()}>Ver prévia</Button>
        <Button disabled={!preview || !!busy || !!result} busy={busy === "copy"} onClick={() => void copy()}>Copiar</Button>
      </div>
      {preview && !result && (
        <div className="companies-plan">
          {preview.cadastros.map((plan: Row) => (
            <Notice key={plan.cadastro} tone={plan.novos ? "info" : "ok"}>
              <strong>{plan.titulo}:</strong> {plan.novos} novo(s), {plan.existentes} já existe(m) aqui e fica(m) como está(ão)
              {plan.cadastro === "produtos" && <>, {plan.categorias_novas} categoria(s) nova(s), {plan.listas_novas} lista(s) de preços nova(s)</>}
              {plan.ignorados.length > 0 && <>, {plan.ignorados.length} não vai(ão)</>}.
              {plan.amostra.length > 0 && <ul>{plan.amostra.map((name: string) => <li key={name}>{name}</li>)}{plan.novos > plan.amostra.length && <li>e mais {plan.novos - plan.amostra.length}…</li>}</ul>}
              {plan.ignorados.length > 0 && <ul>{plan.ignorados.slice(0, 20).map((s: Row, i: number) => <li key={i}>{s.nome}: {s.motivo}</li>)}</ul>}
              {plan.avisos.map((text: string) => <div key={text}>{text}</div>)}
            </Notice>
          ))}
        </div>
      )}
      {result && (
        <div className="companies-plan">
          {result.cadastros.map((done: Row) => (
            <Notice key={done.cadastro} tone={done.recusados.length ? "warn" : "ok"}>
              <strong>{done.titulo}:</strong> {done.criados} copiado(s), {done.ja_existiam} já existia(m)
              {done.cadastro === "produtos" && <>, {done.categorias_criadas ?? 0} categoria(s) e {done.listas_criadas ?? 0} lista(s) de preços criadas</>}.
              {done.recusados.length > 0 && <ul>{done.recusados.slice(0, 30).map((s: Row, i: number) => <li key={i}>{s.nome}: {s.motivo}</li>)}</ul>}
            </Notice>
          ))}
        </div>
      )}
    </Card>
  );
}

function NewCompany() {
  const app = useApp();
  const { busy, run } = useAction();
  const [form, setForm] = useState<Row>({ regime: "simples", uf: "" });
  const [people, setPeople] = useState<Row[] | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [done, setDone] = useState<Row | null>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const set = (name: string) => (value: string) => { setForm((current) => ({ ...current, [name]: value })); setKey(crypto.randomUUID()); };
  useEffect(() => {
    let alive = true;
    app.api("v1/users").then((rows: Row[]) => {
      if (!alive) return;
      const list = (rows || []).filter((u) => u.role !== "admin" && !u.disabled);
      setPeople(list);
      // As pessoas desta empresa já vêm marcadas.
      setChosen(list.filter((u) => { try { return JSON.parse(u.profiles || "[]").includes(app.profile); } catch { return false; } }).map((u) => u.id));
    }).catch(() => alive && setPeople([]));
    return () => { alive = false; };
  }, [app.profile]);
  const current = useMemo(() => app.companies.find((company) => company.area === app.profile), [app.companies, app.profile]);
  const submit = () => run(async () => {
    const body = {
      nome_fantasia: form.nome_fantasia, razao_social: form.razao_social, cnpj: form.cnpj, ie: form.ie || null, regime: form.regime,
      endereco: { cep: form.cep || null, rua: form.rua || null, numero: form.numero || null, complemento: form.complemento || null, bairro: form.bairro || null,
        cidade: form.cidade || null, codigo_municipio: form.codigo_municipio || null, uf: form.uf || null },
      telefone: form.telefone || null, email: form.email || null, pessoas: chosen,
    };
    const result = await app.api(`${app.root}/erp-empresas/nova`, "POST", body, undefined, key);
    setDone(result);
    await app.reloadSession().catch(() => {});
    await app.reloadCompanies();
  }, { success: "Empresa adicionada." });
  if (done)
    return (
      <Card title={`${done.nome} foi adicionada`} description="A área nova já tem o ERP ligado. Confira o que foi feito:">
        <div className="companies-plan">
          {done.passos.map((step: Row) => (
            <Notice key={step.passo} tone={step.ok ? "ok" : "warn"}>{step.passo}{step.mensagem ? `: ${step.mensagem}` : ""}</Notice>
          ))}
        </div>
        <div className="card-actions">
          <Button onClick={() => app.chooseProfile(done.area, { area: "erp" })}>Abrir a empresa nova</Button>
          <Button variant="secondary" onClick={() => { setDone(null); setForm({ regime: "simples", uf: "" }); setKey(crypto.randomUUID()); }}>Adicionar outra</Button>
        </div>
      </Card>
    );
  return (
    <form className="card" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <h2>Adicionar empresa</h2>
      <p className="workspace-help">
        Cria uma área nova já com o ERP ligado (as mesmas partes do ERP de {current ? current.nome_fantasia : "esta empresa"}), os dados da empresa e as pessoas que vão ter acesso.
        Os cadastros não vêm junto: depois, use a aba Copiar cadastros na empresa nova.
      </p>
      <div className="form-field-grid">
        <Field label="Nome fantasia" value={form.nome_fantasia} onChange={set("nome_fantasia")} required maxLength={100} />
        <Field label="Razão social" value={form.razao_social} onChange={set("razao_social")} required maxLength={150} />
      </div>
      <div className="form-field-grid">
        <Field label="CNPJ" value={form.cnpj} onChange={set("cnpj")} required maxLength={18} placeholder="00.000.000/0000-00" help="Aceita o CNPJ com letras." />
        <Field label="Inscrição estadual (opcional)" value={form.ie} onChange={set("ie")} maxLength={20} help="Deixe em branco se a empresa for isenta." />
      </div>
      <Field label="Regime tributário" value={form.regime} onChange={set("regime")} options={REGIMES} emptyOption={null} />
      <h3>Endereço</h3>
      <div className="form-field-grid">
        <Field label="CEP" value={form.cep} onChange={set("cep")} maxLength={9} placeholder="00000-000" />
        <Field label="Rua" value={form.rua} onChange={set("rua")} maxLength={120} />
      </div>
      <div className="form-field-grid">
        <Field label="Número" value={form.numero} onChange={set("numero")} maxLength={20} />
        <Field label="Complemento" value={form.complemento} onChange={set("complemento")} maxLength={80} />
      </div>
      <div className="form-field-grid">
        <Field label="Bairro" value={form.bairro} onChange={set("bairro")} maxLength={80} />
        <Field label="Cidade" value={form.cidade} onChange={set("cidade")} maxLength={80} />
      </div>
      <div className="form-field-grid">
        <Field label="UF" value={form.uf} onChange={set("uf")} options={UFS.map((uf) => [uf, uf])} emptyOption="—" />
        <Field label="Código IBGE da cidade" value={form.codigo_municipio} onChange={set("codigo_municipio")} maxLength={7} placeholder="7 dígitos" help="Precisa dele para emitir nota." />
      </div>
      <div className="form-field-grid">
        <Field label="Telefone (opcional)" value={form.telefone} onChange={set("telefone")} maxLength={20} />
        <Field label="E-mail (opcional)" value={form.email} onChange={set("email")} type="email" maxLength={200} />
      </div>
      <h3>Quem vai ter acesso</h3>
      <p className="workspace-help">Os administradores da conta já veem todas as empresas. Marque as outras pessoas; o papel de cada uma no ERP é o mesmo de hoje.</p>
      {people === null ? <SkeletonRows /> : people.length === 0 ? <p className="workspace-help">Nenhuma outra pessoa na conta.</p> : (
        <div className="companies-kinds" role="group" aria-label="Pessoas">
          {people.map((person) => (
            <label key={person.id}>
              <input type="checkbox" checked={chosen.includes(person.id)}
                onChange={() => { setChosen((list) => list.includes(person.id) ? list.filter((id) => id !== person.id) : [...list, person.id]); setKey(crypto.randomUUID()); }} />
              {person.name} <Pill tone="muted">{person.email}</Pill>
            </label>
          ))}
        </div>
      )}
      <div className="card-actions">
        <Button type="submit" busy={!!busy} disabled={!!busy || !form.nome_fantasia || !form.razao_social || !form.cnpj}>Adicionar empresa</Button>
      </div>
    </form>
  );
}
