import React, { useEffect, useRef, useState } from "react";
import { NumberPolicyEditor } from "./NumberPolicyEditor";
import { MonthlyDeliveredUsage } from "./MonthlyDeliveredUsage";
import { ZernioTemplatesCatalog } from "./ZernioTemplatesCatalog";
import { numberPolicyPresets } from "../src/number-policy";
import "./router-workspace.css";

const routerSteps = [
  {
    id: "account",
    title: "Integração Zernio",
    description: "Use os telefones já conectados na Zernio.",
  },
  {
    id: "numbers",
    title: "Telefones",
    description: "Importe as linhas e acompanhe as entregas.",
  },
  {
    id: "distribution",
    title: "Distribuição",
    description: "Escolha as linhas que trabalham juntas.",
  },
  {
    id: "access",
    title: "Acesso dos sistemas",
    description: "Autorize Vinki, Fagoo e outros sistemas.",
  },
] as const;
type RouterStep = (typeof routerSteps)[number]["id"];
type Row = Record<string, any>;
type ZernioResolution = {
  options: { id: string; name: string }[];
  current_id: string | null;
  suggested_id?: string | null;
};
const parse = (v: any) => {
  try {
    return typeof v === "string" ? JSON.parse(v) : v || [];
  } catch {
    return [];
  }
};
const empty = {
  accounts: [],
  numbers: [],
  pools: [],
  applications: [],
  grants: [],
};
const sample = {
  accounts: [
    {
      id: "conta-exemplo",
      name: "Minha empresa",
      zernio_profile_id: "66a1f0c2a4b9d3e8f1a2b3c4",
      timezone: "America/Sao_Paulo",
      discovered: "[]",
      provider: "zernio",
    },
  ],
  numbers: [
    {
      id: "numero-atendimento-1",
      account_id: "conta-exemplo",
      name: "Atendimento oficial",
      policy: numberPolicyPresets.official,
      number: "5511999990001",
      status: "active",
      usage: {
        period: "2026-11",
        timezone: "America/Sao_Paulo",
        delivered: 852,
        service_delivered: 840,
        utility_delivered: 8,
        marketing_delivered: 4,
        authentication_delivered: 0,
        unclassified_delivered: 0,
        monitored_at: Date.now() - 86400000 * 20,
      },
    },
    {
      id: "numero-atendimento-2",
      account_id: "conta-exemplo",
      name: "Vinki · Janela de 24 horas",
      policy: numberPolicyPresets.service_only,
      number: "5511999990002",
      status: "active",
      usage: {
        period: "2026-11",
        timezone: "America/Sao_Paulo",
        delivered: 632,
        service_delivered: 632,
        utility_delivered: 0,
        marketing_delivered: 0,
        authentication_delivered: 0,
        unclassified_delivered: 0,
        monitored_at: Date.now() - 86400000 * 20,
      },
    },
  ],
  pools: [
    {
      id: "grupo-atendimento",
      account_id: "conta-exemplo",
      name: "Atendimento principal",
      strategy: "round_robin",
      enabled: 1,
      allow_paid: 1,
      members: ["numero-atendimento-1", "numero-atendimento-2"],
      public_token: "exemplo-dados-ficticios",
    },
  ],
  applications: [
    {
      id: "sistema-exemplo",
      name: "Sistema de pedidos",
      scopes: '["routing:read","routing:send","routing:paid"]',
    },
  ],
  grants: [],
};
export function NumberRouter({
  api,
  root,
  demo,
}: {
  api: any;
  root: string;
  demo: boolean;
}) {
  const [data, setData] = useState<Row>(demo ? sample : empty),
    [step, setStep] = useState<RouterStep>("account"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(""),
    [accountEditing, setAccountEditing] = useState(false),
    [accountId, setAccountId] = useState(demo ? "conta-exemplo" : ""),
    [resolution, setResolution] = useState<ZernioResolution | null>(null),
    [resolvedId, setResolvedId] = useState(""),
    [accountForm, setAccountForm] = useState<Row>({
      name: "",
      zernio_profile_id: "",
      timezone: "America/Sao_Paulo",
    }),
    [numberForm, setNumberForm] = useState<Row>({
      phone_id: "",
    }),
    [poolForm, setPoolForm] = useState<Row>({
      name: "",
      strategy: "round_robin",
      members: [],
      enabled: false,
      allow_paid: false,
      public_enabled: false,
    }),
    [appId, setAppId] = useState(""),
    [grants, setGrants] = useState<Row>({
      numbers: [],
      pools: [],
      allow_paid: false,
    });
  const intents = useRef(new Map<string, string>());
  const resolutionVersion = useRef(0);
  async function load() {
    if (demo) return;
    const r = await api(root + "/router");
    setData(r);
    setAccountId((v) =>
      r.accounts?.some((a: Row) => a.id === v) ? v : r.accounts?.[0]?.id || "",
    );
  }
  useEffect(() => {
    if (!busy) load().catch((e) => setError(e.message));
    const timer = setInterval(() => {
      if (!document.hidden && !busy) load().catch(() => {});
    }, 15000);
    return () => clearInterval(timer);
  }, [root, demo, busy]);
  useEffect(() => {
    resetAccountForms();
  }, [accountId, root]);
  const account = data.accounts.find((a: Row) => a.id === accountId),
    legacyAccount = !!account && account.provider === "meta",
    available = parse(account?.discovered),
    numbers = data.numbers.filter((n: Row) => n.account_id === accountId),
    resolvedOption = resolution?.options.find(
      (option) => option.id === resolvedId,
    );
  async function write(
    path: string,
    body: Row,
    label: string,
    method = "POST",
  ) {
    if (demo) {
      setNotice(
        "Demonstração com dados fictícios. Nenhuma alteração ou mensagem é enviada.",
      );
      return;
    }
    setBusy(label);
    setError("");
    setNotice("");
    const intent = path + JSON.stringify(body);
    if (!intents.current.has(intent))
      intents.current.set(intent, crypto.randomUUID());
    try {
      const result = await api(
        root + "/" + path,
        method,
        body,
        undefined,
        intents.current.get(intent),
      );
      intents.current.delete(intent);
      await load();
      setNotice(label + " concluído.");
      return result;
    } catch (e: any) {
      if (
        e.status >= 400 &&
        e.status < 500 &&
        ![
          "operation_unknown",
          "idempotency_conflict",
          "zernio_unknown",
        ].includes(e.code)
      )
        intents.current.delete(intent);
      setError(e.message);
    } finally {
      setBusy("");
    }
  }
  function editAccount(a?: Row) {
    clearResolution();
    setAccountEditing(true);
    setAccountForm(
      a
        ? {
            id: a.id,
            name: a.name,
            zernio_profile_id: a.zernio_profile_id || "",
            timezone: a.timezone,
          }
        : { name: "", zernio_profile_id: "", timezone: "America/Sao_Paulo" },
    );
  }
  function chooseAccount(id: string) {
    setAccountId(id);
    resetAccountForms();
  }
  function resetAccountForms() {
    clearResolution();
    setError("");
    setNotice("");
    setAccountEditing(false);
    setAccountForm({
      name: "",
      zernio_profile_id: "",
      timezone: "America/Sao_Paulo",
    });
    setPoolForm({
      name: "",
      strategy: "round_robin",
      members: [],
      enabled: false,
      allow_paid: false,
      public_enabled: false,
    });
    setNumberForm({
      phone_id: "",
    });
  }
  function clearResolution() {
    resolutionVersion.current++;
    setResolution(null);
    setResolvedId("");
  }
  async function findZernioId() {
    if (!account || legacyAccount) return;
    clearResolution();
    const version = resolutionVersion.current;
    const path = "router/accounts/" + account.id + "/resolve";
    // A new manual lookup only reads Zernio; don't replay a prior lookup failure.
    intents.current.delete(path + JSON.stringify({}));
    const result: ZernioResolution | undefined = await write(
      path,
      {},
      "Buscar integrações na Zernio",
    );
    if (!result || resolutionVersion.current !== version) return;
    setResolution(result);
    const preferred = [result.suggested_id, result.current_id].find((id) =>
      result.options.some((option) => option.id === id),
    );
    setResolvedId(preferred || "");
    setNotice(
      result.options.length
        ? "Integrações encontradas. Confira o nome e escolha qual usar; nenhum ID foi alterado."
        : "Nenhuma integração encontrada com a API key salva. Confira o acesso dessa chave na Zernio.",
    );
  }
  async function useZernioId() {
    if (!account || !resolvedOption || numbers.length > 0) return;
    const version = resolutionVersion.current;
    const result = await write(
      "router/accounts/" + account.id + "/resolve",
      { zernio_profile_id: resolvedOption.id },
      "Atualizar ID da integração",
    );
    if (!result || resolutionVersion.current !== version) return;
    resetAccountForms();
    setNotice(
      (result.changed
        ? "ID da integração atualizado. "
        : "Este ID já estava cadastrado. ") +
        "A API key e o segredo do webhook foram preservados. Abra Telefones para buscar as linhas na Zernio.",
    );
  }
  function selectApp(id: string) {
    setAppId(id);
    const rows = data.grants.filter((r: Row) => r.app_id === id);
    setGrants({
      numbers: rows
        .filter((r: Row) => r.source_type === "number")
        .map((r: Row) => r.source_id),
      pools: rows
        .filter((r: Row) => r.source_type === "pool")
        .map((r: Row) => r.source_id),
      allow_paid: rows.some((r: Row) => r.allow_paid),
    });
  }
  function toggle(field: string, id: string) {
    setGrants((g: Row) => ({
      ...g,
      [field]: g[field].includes(id)
        ? g[field].filter((x: string) => x !== id)
        : [...g[field], id],
    }));
  }
  const exampleSource = data.pools[0]
    ? { pool_id: data.pools[0].id }
    : { number_id: data.numbers[0]?.id || "ID_DO_NUMERO" };
  return (
    <div className="number-router">
      <section className="card">
        <div className="section-heading">
          <h2>WhatsApp da sua empresa</h2>
          <button
            disabled={!!busy}
            onClick={() => load().catch((e) => setError(e.message))}
          >
            Atualizar dados
          </button>
        </div>
        <p>
          Cadastre sua integração Zernio, encontre os telefones já conectados no
          provedor e defina como distribuir novos atendimentos. Cada etapa
          abaixo cuida de uma parte da configuração.
        </p>
        {step === "account" && (
          <p>
            <a
              href="/install#zernio-whatsapp"
              target="_blank"
              rel="noopener noreferrer"
            >
              Importe seus telefones da Zernio: passo a passo ↗
            </a>
          </p>
        )}
        <nav
          className="router-step-nav"
          aria-label="Configuração dos telefones WhatsApp"
        >
          {routerSteps.map((item, index) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={step === item.id}
              aria-controls="router-step-content"
              disabled={!!busy}
              onClick={() => setStep(item.id)}
            >
              <span className="router-step-number">{index + 1}</span>
              <span>
                <strong>{item.title}</strong>
                <small>{item.description}</small>
              </span>
            </button>
          ))}
        </nav>
        {demo && (
          <p className="notice">
            Tela de referência · todos os telefones e contadores abaixo são
            fictícios.
          </p>
        )}
        {busy && <p role="status">{busy}… Aguarde a confirmação.</p>}
        {error && (
          <p role="alert" className="notice error">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="notice">
            {notice}
          </p>
        )}
        {step !== "access" && data.accounts.length > 0 && (
          <label>
            Integração que você está configurando
            <select
              value={accountId}
              disabled={!!busy}
              onChange={(e) => chooseAccount(e.target.value)}
            >
              <option value="">Selecione uma integração</option>
              {data.accounts.map((a: Row) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </section>
      <div id="router-step-content" className="router-step-content">
        {step === "account" && (
          <section className="card">
            <h3>
              {accountEditing
                ? accountForm.id
                  ? "Editar integração Zernio"
                  : "Cadastrar integração Zernio"
                : account
                  ? account.name
                  : "Cadastrar integração Zernio"}
            </h3>
            <p>
              Use sua API key para encontrar a integração e importar os
              telefones já cadastrados e conectados na Zernio. O webhook permite
              receber mensagens no Wabotia. As credenciais ficam protegidas no
              servidor.
            </p>
            {!accountEditing && data.accounts.length > 0 && (
              <p className="router-credential-links">
                <strong>Onde obter as credenciais:</strong>{" "}
                <a
                  href="https://zernio.com/dashboard/api-keys"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  API keys ↗
                </a>
                {" · "}
                <a
                  href="https://zernio.com"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Abrir painel Zernio ↗
                </a>
                {" · "}
                <a
                  href="https://docs.zernio.com/webhooks"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Como configurar o segredo do webhook ↗
                </a>
              </p>
            )}
            <div className="router-actions">
              <button disabled={!!busy} onClick={() => editAccount()}>
                Nova integração
              </button>
              {account && !legacyAccount && (
                <button disabled={!!busy} onClick={() => editAccount(account)}>
                  Editar {account.name}
                </button>
              )}
              {account && !legacyAccount && !accountEditing && (
                <button type="button" disabled={!!busy} onClick={findZernioId}>
                  Encontrar ID na Zernio
                </button>
              )}
              {account && !accountEditing && (
                <button
                  type="button"
                  disabled={!!busy || numbers.length > 0}
                  onClick={async () => {
                    if (
                      !demo &&
                      !window.confirm(
                        "Excluir a integração " +
                          account.name +
                          " do Wabotia? O histórico será preservado. Isso remove somente o cadastro local e suas credenciais; não desconecta nem exclui a conta na Zernio ou na Meta.",
                      )
                    )
                      return;
                    const result = await write(
                      "router/accounts/" + account.id,
                      {},
                      "Excluir integração",
                      "DELETE",
                    );
                    if (result) {
                      resetAccountForms();
                      setNotice(
                        "Integração removida do Wabotia. Histórico preservado; a conta no provedor não foi alterada.",
                      );
                    }
                  }}
                >
                  Excluir integração
                </button>
              )}
            </div>
            {account && !accountEditing && (
              <p className="router-field-help">
                {numbers.length > 0
                  ? "Para excluir esta integração, primeiro exclua os telefones vinculados na etapa Telefones."
                  : "Sem telefones vinculados. Você pode excluir o cadastro local da integração e suas credenciais, preservando o histórico e a conexão no provedor."}
              </p>
            )}
            {account && !legacyAccount && !accountEditing && (
              <div>
                {!account.zernio_profile_id && (
                  <p className="notice">
                    O ID da integração ainda não foi definido. Use{" "}
                    <strong>Encontrar ID na Zernio</strong> e escolha pelo nome
                    antes de buscar os telefones já conectados na Zernio.
                  </p>
                )}
                <p className="router-field-help">
                  Encontrar ID na Zernio usa a API key já salva para listar as
                  integrações pelo nome. Você escolhe antes de alterar o ID;
                  suas credenciais são preservadas. Account ID identifica o
                  telefone; WABA ID pertence à Meta.
                </p>
                {resolution && resolution.options.length > 0 && (
                  <div className="notice">
                    <h4>Escolha a integração encontrada na Zernio</h4>
                    <label>
                      Nome na Zernio
                      <select
                        value={resolvedId}
                        disabled={!!busy}
                        onChange={(e) => setResolvedId(e.target.value)}
                      >
                        <option value="">Escolha pelo nome</option>
                        {resolution.options.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.name}
                            {option.id === resolution.suggested_id
                              ? " (sugerida)"
                              : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                    <p className="router-field-help">
                      ID cadastrado:{" "}
                      <code>
                        {resolution.current_id || "Ainda não definido"}
                      </code>
                      .
                      {resolvedOption && (
                        <>
                          {" "}
                          Profile ID escolhido: <code>{resolvedOption.id}</code>
                          .
                        </>
                      )}
                    </p>
                    {resolvedOption && (
                      <p>
                        Usar <strong>{resolvedOption.name}</strong> em{" "}
                        <strong>{account.name}</strong> mantém a API key e o
                        segredo do webhook já salvos. Essa escolha não conecta
                        nem desconecta o WhatsApp no provedor.
                      </p>
                    )}
                    {numbers.length > 0 && (
                      <p>
                        Esta integração tem telefones vinculados. Exclua-os na
                        etapa Telefones antes de alterar o ID.
                      </p>
                    )}
                    <div className="router-actions">
                      <button
                        type="button"
                        disabled={
                          !!busy || !resolvedOption || numbers.length > 0
                        }
                        onClick={useZernioId}
                      >
                        Usar esta integração
                      </button>
                      <button
                        type="button"
                        disabled={!!busy}
                        onClick={clearResolution}
                      >
                        Cancelar escolha
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
            {(accountEditing || !data.accounts.length) && (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  const r = await write(
                    "router/accounts",
                    {
                      id: accountForm.id,
                      name: accountForm.name,
                      zernio_profile_id: accountForm.zernio_profile_id,
                      timezone: accountForm.timezone,
                      secrets: {
                        api_key: accountForm.api_key,
                        webhook_secret: accountForm.webhook_secret,
                      },
                    },
                    "Salvar integração",
                  );
                  if (r) {
                    setAccountId(r.id);
                    setAccountForm({
                      id: r.id,
                      name: accountForm.name,
                      zernio_profile_id: accountForm.zernio_profile_id,
                      timezone: accountForm.timezone,
                    });
                    setAccountEditing(false);
                  }
                }}
              >
                <div className="router-fields">
                  <label>
                    Nome da integração
                    <input
                      required
                      maxLength={100}
                      placeholder="Ex.: Atendimento da empresa"
                      value={accountForm.name}
                      onChange={(e) =>
                        setAccountForm({ ...accountForm, name: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    ID da integração na Zernio
                    <input
                      readOnly={!!accountForm.id}
                      aria-label="ID da integração na Zernio"
                      aria-describedby="zernio-integration-id-help"
                      value={accountForm.zernio_profile_id || ""}
                      onChange={(e) =>
                        setAccountForm({
                          ...accountForm,
                          zernio_profile_id: e.target.value,
                        })
                      }
                    />
                    <small
                      id="zernio-integration-id-help"
                      className="router-field-help"
                    >
                      {accountForm.id ? (
                        <>
                          Para conferir ou corrigir o ID, salve ou cancele esta
                          edição e use <strong>Encontrar ID na Zernio</strong>.
                        </>
                      ) : (
                        <>
                          Opcional: após salvar, use{" "}
                          <strong>Encontrar ID na Zernio</strong> para escolher
                          pelo nome com a API key salva.
                        </>
                      )}{" "}
                      Este campo é o <strong>Profile ID</strong> da Zernio.
                      Account ID identifica o telefone; WABA ID pertence à Meta.{" "}
                      <a
                        href="https://zernio.com"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Abrir Zernio ↗
                      </a>{" "}
                      <a
                        href="/install#zernio-whatsapp"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Ver guia de importação ↗
                      </a>
                    </small>
                  </label>
                  <label>
                    Fuso da integração Zernio
                    <input
                      required
                      aria-label="Fuso da integração Zernio"
                      aria-describedby="zernio-timezone-help"
                      value={accountForm.timezone}
                      onChange={(e) =>
                        setAccountForm({
                          ...accountForm,
                          timezone: e.target.value,
                        })
                      }
                    />
                    <small
                      id="zernio-timezone-help"
                      className="router-field-help"
                    >
                      Ex.: America/Sao_Paulo para o horário de Brasília.
                    </small>
                  </label>
                  {[
                    ["api_key", "API key da Zernio"],
                    [
                      "webhook_secret",
                      "Segredo de assinatura do webhook Zernio",
                    ],
                  ].map(([field, label]) => (
                    <label key={field}>
                      {label}
                      <input
                        type="password"
                        autoComplete="new-password"
                        aria-label={label}
                        aria-describedby={`zernio-${field}-help`}
                        required={!accountForm.id}
                        value={accountForm[field] || ""}
                        placeholder={
                          accountForm.id ? "Vazio mantém o valor atual" : ""
                        }
                        onChange={(e) =>
                          setAccountForm({
                            ...accountForm,
                            [field]: e.target.value,
                          })
                        }
                      />
                      <small
                        id={`zernio-${field}-help`}
                        className="router-field-help"
                      >
                        {field === "api_key" ? (
                          <>
                            Abra{" "}
                            <a
                              href="https://zernio.com/dashboard/api-keys"
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              API keys ↗
                            </a>{" "}
                            e clique em <strong>Create API key</strong>. Copie a
                            chave imediatamente: ela é exibida uma única vez.{" "}
                            <a
                              href="https://docs.zernio.com/quickstart#create-an-api-key"
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              Guia da API key ↗
                            </a>
                          </>
                        ) : (
                          <>
                            Crie uma senha aleatória longa e use o mesmo valor
                            aqui e na Zernio. A Zernio não gera este segredo.{" "}
                            <a
                              href="https://docs.zernio.com/webhooks"
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              Guia de webhooks ↗
                            </a>
                          </>
                        )}
                      </small>
                    </label>
                  ))}
                </div>
                <button disabled={!!busy} type="submit">
                  Salvar integração Zernio
                </button>
                {data.accounts.length > 0 && (
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() => {
                      setAccountEditing(false);
                      setAccountForm({
                        name: "",
                        zernio_profile_id: "",
                        timezone: "America/Sao_Paulo",
                      });
                    }}
                  >
                    Cancelar edição
                  </button>
                )}
              </form>
            )}
            {legacyAccount && (
              <p className="notice">
                Esta integração se conectava diretamente à Meta e foi pausada na
                atualização. Resolva operações em andamento ou sem confirmação,
                exclua as linhas antigas e cadastre uma integração Zernio para
                importar os telefones já conectados no provedor. O histórico
                permanece disponível.
              </p>
            )}
            {account && !legacyAccount && (
              <>
                <h3>Webhook único desta integração</h3>
                <p>
                  Copie a URL abaixo e cadastre-a em{" "}
                  <a
                    href="https://zernio.com/dashboard/webhooks"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Webhooks da Zernio ↗
                  </a>
                  , com o mesmo segredo de assinatura salvo no Wabotia.
                  Selecione os eventos de recebimento, envio, entrega, leitura e
                  falha de mensagens. Na etapa Telefones, use Buscar telefones
                  na Zernio para listar as linhas já conectadas no provedor.
                </p>
                <CopyValue
                  value={
                    location.origin + "/webhooks/zernio-accounts/" + account.id
                  }
                />
                <div className="router-actions">
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() => setStep("numbers")}
                  >
                    Continuar para os telefones →
                  </button>
                </div>
              </>
            )}
          </section>
        )}
        {!account && ["numbers", "distribution"].includes(step) && (
          <section className="card router-step-empty">
            <h3>Comece pela integração Zernio</h3>
            <p>
              Cadastre ou selecione uma integração para buscar seus telefones e
              organizar a distribuição.
            </p>
            <button type="button" onClick={() => setStep("account")}>
              Configurar integração Zernio
            </button>
          </section>
        )}
        {step === "numbers" && account && !legacyAccount && (
          <section className="card">
            <h3>Trazer telefones da Zernio</h3>
            <p>
              A busca lista os telefones já cadastrados e conectados na Zernio,
              na integração escolhida. Se um telefone não aparecer, confira seu
              cadastro e o acesso da API key no painel da Zernio. O ID do
              telefone corresponde ao campo técnico Account ID.
            </p>
            {!account.zernio_profile_id && (
              <p className="notice">
                Primeiro use <strong>Encontrar ID na Zernio</strong> na etapa
                Integração Zernio e confirme qual integração deseja usar.
              </p>
            )}
            <button
              disabled={!!busy || !account.zernio_profile_id}
              onClick={() =>
                write(
                  `router/accounts/${accountId}/discover`,
                  {},
                  "Buscar telefones",
                )
              }
            >
              Buscar telefones na Zernio
            </button>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const r = await write(
                  "router/numbers",
                  {
                    ...numberForm,
                    account_id: accountId,
                    accountId: numberForm.phone_id,
                  },
                  "Adicionar telefone",
                );
                if (r)
                  setNumberForm({
                    phone_id: "",
                  });
              }}
            >
              <div className="router-fields">
                <label>
                  Telefone encontrado
                  <select
                    required
                    value={numberForm.phone_id}
                    onChange={(e) =>
                      setNumberForm({ ...numberForm, phone_id: e.target.value })
                    }
                  >
                    <option value="">Escolha após buscar</option>
                    {available
                      .filter(
                        (n: Row) =>
                          !data.numbers.some(
                            (r: Row) => r.phone_id === n.phone_id,
                          ),
                      )
                      .map((n: Row) => (
                        <option value={n.phone_id} key={n.phone_id}>
                          +{n.number} · {n.name || n.phone_id} · qualidade{" "}
                          {n.quality}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Nome para reconhecer no painel
                  <input
                    value={numberForm.name || ""}
                    maxLength={100}
                    onChange={(e) =>
                      setNumberForm({ ...numberForm, name: e.target.value })
                    }
                  />
                </label>
              </div>
              <p>
                O telefone será adicionado pausado. Se ele já está no Wabotia,
                pause e reconcilie as entregas antes. Depois confira o webhook e
                clique em Ativar na lista.
              </p>
              <button type="submit" disabled={!!busy}>
                Adicionar telefone ao Wabotia
              </button>
            </form>
          </section>
        )}
        {step === "numbers" && account && (
          <section className="card">
            <h3>Seus telefones e mensagens entregues</h3>
            {legacyAccount && (
              <p className="notice">
                Linhas da integração Meta anterior, pausadas na atualização.
                Resolva operações em andamento ou sem confirmação e exclua as
                linhas antigas antes de importar os telefones já conectados na
                Zernio. O histórico é preservado.
              </p>
            )}
            <p>
              Acompanhe as mensagens entregues no mês, por categoria, desde o
              início do monitoramento no Wabotia. A mudança de mês segue o fuso
              da integração. Os números não estimam preços nem substituem a
              fatura do provedor.
            </p>
            {!numbers.length && (
              <p>
                Nenhum telefone cadastrado nesta integração. Use Buscar
                telefones na Zernio acima e escolha os que deseja trazer para o
                Wabotia.
              </p>
            )}
            <div className="router-number-grid">
              {numbers.map((n: Row) => (
                <article className="router-number" key={n.id}>
                  <div className="section-heading">
                    <strong>{n.name}</strong>
                    <span
                      className={
                        "badge " + (n.status === "active" ? "active" : "paused")
                      }
                    >
                      {n.status === "active" ? "Ativo" : "Pausado"}
                    </span>
                  </div>
                  <p>+{n.number}</p>
                  <MonthlyDeliveredUsage usage={n.usage} />
                  <div className="router-actions">
                    <button
                      disabled={!!busy || legacyAccount}
                      onClick={() =>
                        write(
                          `connections/${n.id}/state`,
                          {
                            status: n.status === "active" ? "paused" : "active",
                          },
                          n.status === "active"
                            ? "Pausar telefone"
                            : "Ativar telefone",
                          "PUT",
                        )
                      }
                    >
                      {n.status === "active" ? "Pausar" : "Ativar"}
                    </button>
                    <button
                      disabled={!!busy}
                      onClick={() => {
                        if (
                          demo ||
                          window.confirm(
                            "Excluir " +
                              n.name +
                              " (+" +
                              n.number +
                              ") do Wabotia? O histórico será preservado. Isso não desconecta nem exclui a conta no provedor. Mensagens e operações de grupo ainda na fila serão canceladas. Resolva envios em andamento, operações sem confirmação e ligações abertas antes de excluir.",
                          )
                        )
                          write(
                            "connections/" + n.id,
                            {},
                            "Excluir telefone",
                            "DELETE",
                          );
                      }}
                    >
                      Excluir telefone
                    </button>
                  </div>
                  {!legacyAccount && (
                    <ZernioTemplatesCatalog
                      api={api}
                      root={root}
                      numberId={n.id}
                      demo={demo}
                    />
                  )}
                  <details className="router-technical-details">
                    <summary>Identificador para integração</summary>
                    <CopyValue value={n.id} />
                  </details>
                  <NumberPolicyEditor
                    policy={n.policy}
                    name={n.name}
                    busy={!!busy}
                    onSave={(policy) =>
                      write(
                        `router/numbers/${n.id}/policy`,
                        { policy },
                        "Salvar função e permissões",
                        "PUT",
                      )
                    }
                  />
                </article>
              ))}
            </div>
          </section>
        )}
        {step === "distribution" && account && (
          <section className="card">
            <h3>Distribuir novos atendimentos</h3>
            <div className="notice">
              <strong>Vinki e janela de 24 horas:</strong> a janela é aberta
              pela mensagem do cliente e pertence ao telefone que a recebeu.
              Templates e outras mensagens de saída não abrem nem renovam a
              janela. O rodízio escolhe o telefone para um novo atendimento; a
              conversa mantém o mesmo remetente.
            </div>
            <p>
              Um grupo pertence a uma integração Zernio. A escolha ocorre no
              início do atendimento e fica vinculada a ele. Grupos podem
              compartilhar telefones; as entregas de cada telefone são contadas
              uma vez. Apenas telefones que permitem participar do roteamento
              são escolhidos. Permitir templates no grupo não libera templates
              em um telefone que os bloqueia.
            </p>
            {!numbers.length && (
              <p className="notice">
                Adicione telefones na etapa Telefones antes de criar um grupo.
              </p>
            )}
            {!data.pools.some((p: Row) => p.account_id === accountId) && (
              <p>
                Nenhum grupo nesta integração. Crie um grupo abaixo para
                alternar os telefones a cada novo atendimento.
              </p>
            )}
            {data.pools
              .filter((p: Row) => p.account_id === accountId)
              .map((p: Row) => (
                <div className="router-pool" key={p.id}>
                  <strong>{p.name}</strong>
                  <span>
                    {p.members.length} telefones ·{" "}
                    {p.enabled ? "Ativo" : "Pausado"} ·{" "}
                    {p.allow_paid
                      ? "Modelos pagos permitidos com autorização"
                      : "Somente atendimento"}
                  </span>
                  <button
                    disabled={!!busy}
                    onClick={() =>
                      setPoolForm({
                        ...p,
                        public_enabled: !!p.public_token,
                        enabled: !!p.enabled,
                        allow_paid: !!p.allow_paid,
                      })
                    }
                  >
                    Editar grupo
                  </button>
                  <details className="router-technical-details">
                    <summary>Identificador para integração</summary>
                    <CopyValue value={p.id} />
                  </details>
                  {p.public_token && (
                    <>
                      <small>
                        Link para o cliente iniciar contato num telefone
                        disponível
                      </small>
                      <CopyValue
                        value={
                          location.origin +
                          "/api/public/whatsapp/" +
                          p.public_token
                        }
                      />
                    </>
                  )}
                </div>
              ))}
            <details
              open={
                !!poolForm.id ||
                !data.pools.some((p: Row) => p.account_id === accountId)
              }
            >
              <summary>
                {poolForm.id
                  ? "Editar grupo selecionado"
                  : "Criar grupo de roteamento"}
              </summary>
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  const r = await write(
                    "router/pools",
                    { ...poolForm, account_id: accountId },
                    "Salvar grupo",
                  );
                  if (r)
                    setPoolForm({
                      name: "",
                      strategy: "round_robin",
                      members: [],
                      enabled: false,
                      allow_paid: false,
                      public_enabled: false,
                    });
                }}
              >
                <div className="router-fields">
                  <label>
                    Nome do grupo
                    <input
                      required
                      maxLength={100}
                      value={poolForm.name}
                      onChange={(e) =>
                        setPoolForm({ ...poolForm, name: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Distribuição dos novos atendimentos
                    <select value="round_robin" disabled>
                      <option value="round_robin">
                        Rodízio entre telefones disponíveis
                      </option>
                    </select>
                  </label>
                </div>
                <div className="router-checks">
                  {numbers.map((n: Row) => (
                    <label className="check-line" key={n.id}>
                      <input
                        type="checkbox"
                        checked={poolForm.members.includes(n.id)}
                        onChange={(e) =>
                          setPoolForm({
                            ...poolForm,
                            members: e.target.checked
                              ? [...poolForm.members, n.id]
                              : poolForm.members.filter(
                                  (id: string) => id !== n.id,
                                ),
                          })
                        }
                      />
                      {n.name} · +{n.number}
                    </label>
                  ))}
                </div>
                {[
                  ["enabled", "Ativar este grupo"],
                  [
                    "public_enabled",
                    "Criar link público de entrada pelo WhatsApp",
                  ],
                  [
                    "allow_paid",
                    "Permitir modelos pagos, somente com autorização explícita em cada envio",
                  ],
                ].map(([field, label]) => (
                  <label className="check-line" key={field}>
                    <input
                      type="checkbox"
                      checked={!!poolForm[field]}
                      onChange={(e) =>
                        setPoolForm({ ...poolForm, [field]: e.target.checked })
                      }
                    />
                    {label}
                  </label>
                ))}
                <button disabled={!!busy || !numbers.length} type="submit">
                  Salvar grupo
                </button>
                {poolForm.id && (
                  <button
                    type="button"
                    onClick={() =>
                      setPoolForm({
                        name: "",
                        strategy: "round_robin",
                        members: [],
                        enabled: false,
                        allow_paid: false,
                        public_enabled: false,
                      })
                    }
                  >
                    Cancelar edição
                  </button>
                )}
              </form>
            </details>
          </section>
        )}
        {step === "access" && (
          <>
            <section className="card">
              <h3>Quais telefones cada sistema pode usar</h3>
              <p>
                Cadastre Vinki, Fagoo ou outro sistema em{" "}
                <strong>Integrações</strong>, com acesso a esta área de
                atendimento. Depois escolha aqui os telefones ou grupos que ele
                poderá usar. O pareamento por código temporário fica em
                Integrações; a autorização de linhas continua limitada pelas
                permissões abaixo.
              </p>
              <p className="muted">
                As permissões abaixo abrangem todas as integrações Zernio desta
                área de atendimento.
              </p>
              {!data.applications.length && (
                <p className="notice">
                  Nenhum sistema cadastrado. Abra Integrações para cadastrar uma
                  aplicação primeiro.
                </p>
              )}
              <label>
                Sistema
                <select
                  disabled={!!busy}
                  value={appId}
                  onChange={(e) => selectApp(e.target.value)}
                >
                  <option value="">Selecione</option>
                  {data.applications.map((a: Row) => (
                    <option value={a.id} key={a.id}>
                      {a.name}
                      {a.disabled ? " · desativada" : ""}
                    </option>
                  ))}
                </select>
              </label>
              {appId && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    write(
                      "router/grants",
                      { app_id: appId, ...grants, enable_scopes: true },
                      "Salvar permissões",
                      "PUT",
                    );
                  }}
                >
                  <h4>Telefone escolhido diretamente</h4>
                  {data.numbers.map((n: Row) => (
                    <label key={n.id} className="check-line">
                      <input
                        type="checkbox"
                        checked={grants.numbers.includes(n.id)}
                        onChange={() => toggle("numbers", n.id)}
                      />
                      {n.name} · +{n.number}
                    </label>
                  ))}
                  <h4>Grupos autorizados</h4>
                  {data.pools.map((p: Row) => (
                    <label key={p.id} className="check-line">
                      <input
                        type="checkbox"
                        checked={grants.pools.includes(p.id)}
                        onChange={() => toggle("pools", p.id)}
                      />
                      {p.name}
                    </label>
                  ))}
                  <label className="check-line">
                    <input
                      type="checkbox"
                      checked={grants.allow_paid}
                      onChange={(e) =>
                        setGrants({ ...grants, allow_paid: e.target.checked })
                      }
                    />
                    Permitir modelos pagos nestas origens. Cada pedido ainda
                    exige allow_paid: true e consentimento.
                  </label>
                  <p>
                    Salvar também autoriza a aplicação a consultar o roteador e
                    operar conversas desta área de atendimento. Autorizar um
                    grupo permite seus membros atuais e futuros; a escolha
                    direta de um telefone exige a autorização individual.
                  </p>
                  <button disabled={!!busy} type="submit">
                    Salvar acesso do sistema
                  </button>
                </form>
              )}
            </section>
            <section className="card">
              <details>
                <summary>
                  Para quem desenvolve a integração: enviar pela API
                </summary>
                <p>
                  Use a chave Bearer no servidor do programa integrador e uma{" "}
                  <code>Idempotency-Key</code> por pedido. Escolha{" "}
                  <code>number_id</code> ou <code>pool_id</code>. O retorno 202
                  confirma a fila; acompanhe a entrega na conversa e nos
                  webhooks.
                </p>
                <CopyValue
                  value={location.origin + "/api/" + root + "/router/messages"}
                />
                <h4>
                  Atendimento: exige mensagem recente do cliente neste telefone
                </h4>
                <pre>
                  {JSON.stringify(
                    {
                      ...exampleSource,
                      to: "5511999991111",
                      external_id: "pedido-123",
                      text: "Olá! Como podemos ajudar?",
                    },
                    null,
                    2,
                  )}
                </pre>
                <h4>Modelo pago: autorização e consentimento por envio</h4>
                <pre>
                  {JSON.stringify(
                    {
                      ...exampleSource,
                      to: "5511999991111",
                      external_id: "pedido-456",
                      allow_paid: true,
                      consent: {
                        granted: true,
                        category: "utility",
                        reference: "Comprovante do aceite no pedido 456",
                      },
                      template: {
                        name: "seu_modelo_aprovado",
                        language: "pt_BR",
                        components: [
                          {
                            type: "body",
                            parameters: [{ type: "text", text: "456" }],
                          },
                        ],
                      },
                    },
                    null,
                    2,
                  )}
                </pre>
                <p>
                  Não altere o identificador externo durante o atendimento para
                  forçar troca de remetente. Um resultado sem confirmação exige
                  reconciliação; repetir com outro telefone pode duplicar a
                  mensagem.
                </p>
                <a href="/api-docs">Abrir documentação da API</a>
              </details>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
function CopyValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="router-copy">
      <code>{value}</code>
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? "Copiado" : "Copiar"}
      </button>
    </div>
  );
}
