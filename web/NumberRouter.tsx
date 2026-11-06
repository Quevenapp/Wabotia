import React, { useEffect, useRef, useState } from "react";
type Row = Record<string, any>;
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
      waba_id: "123456789000000",
      timezone: "America/Sao_Paulo",
      discovered: "[]",
    },
  ],
  numbers: [
    {
      id: "numero-atendimento-1",
      account_id: "conta-exemplo",
      name: "Atendimento 1",
      number: "5511999990001",
      status: "active",
      usage: {
        period: "2026-11",
        limit: 1000,
        used: 842,
        remaining: 158,
        reserved: 2,
        delivered: 840,
        free_confirmed: 840,
        billable_confirmed: 12,
        baseline: 0,
        pricing_unknown: 0,
      },
    },
    {
      id: "numero-atendimento-2",
      account_id: "conta-exemplo",
      name: "Atendimento 2",
      number: "5511999990002",
      status: "active",
      usage: {
        period: "2026-11",
        limit: 1000,
        used: 635,
        remaining: 365,
        reserved: 3,
        delivered: 632,
        free_confirmed: 632,
        billable_confirmed: 8,
        baseline: 0,
        pricing_unknown: 0,
      },
    },
  ],
  pools: [
    {
      id: "grupo-atendimento",
      account_id: "conta-exemplo",
      name: "Atendimento principal",
      strategy: "least_used",
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
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(""),
    [accountId, setAccountId] = useState(demo ? "conta-exemplo" : ""),
    [accountForm, setAccountForm] = useState<Row>({
      name: "",
      waba_id: "",
      timezone: "America/Sao_Paulo",
    }),
    [numberForm, setNumberForm] = useState<Row>({
      phone_id: "",
      baseline_used: 0,
      service_limit: 1000,
      baseline_confirmed: false,
    }),
    [poolForm, setPoolForm] = useState<Row>({
      name: "",
      strategy: "least_used",
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
    }),
    [limits, setLimits] = useState<Row>({});
  const intents = useRef(new Map<string, string>());
  async function load() {
    if (demo) return;
    const r = await api(root + "/router");
    setData(r);
    setAccountId((v) => v || r.accounts?.[0]?.id || "");
  }
  useEffect(() => {
    if (!busy) load().catch((e) => setError(e.message));
    const timer = setInterval(() => {
      if (!document.hidden && !busy) load().catch(() => {});
    }, 15000);
    return () => clearInterval(timer);
  }, [root, demo, busy]);
  const account = data.accounts.find((a: Row) => a.id === accountId),
    available = parse(account?.discovered),
    numbers = data.numbers.filter((n: Row) => n.account_id === accountId);
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
      setError(e.message);
    } finally {
      setBusy("");
    }
  }
  function editAccount(a?: Row) {
    setAccountForm(
      a
        ? { id: a.id, name: a.name, waba_id: a.waba_id, timezone: a.timezone }
        : { name: "", waba_id: "", timezone: "America/Sao_Paulo" },
    );
  }
  function chooseAccount(id: string) {
    setAccountId(id);
    setPoolForm({
      name: "",
      strategy: "least_used",
      members: [],
      enabled: false,
      allow_paid: false,
      public_enabled: false,
    });
    setNumberForm({
      phone_id: "",
      baseline_used: 0,
      service_limit: 1000,
      baseline_confirmed: false,
    });
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
          <h2>Roteador de números</h2>
          <button
            disabled={!!busy}
            onClick={() => load().catch((e) => setError(e.message))}
          >
            Atualizar contadores
          </button>
        </div>
        <p>
          Até 20 números da mesma conta Meta, com um webhook compartilhado.
          Escolha o remetente pela API ou deixe um grupo distribuir os novos
          atendimentos.
        </p>
        <div className="notice">
          A Meta informa 1.000 mensagens de <strong>atendimento</strong>{" "}
          gratuitas por número/mês desde 01/10/2026. Modelos pagos ficam
          separados. A janela de 24 horas e a conversa pertencem ao número com
          que o cliente falou; o roteador mantém esse remetente.
        </div>
        <p className="muted">
          Os contadores são uma proteção local, não uma fatura da Meta. Confira
          o uso anterior, o fuso e envios feitos fora do Wabotia.{" "}
          <a
            href="https://whatsappbusiness.com/resources/faq/"
            target="_blank"
            rel="noreferrer"
          >
            Regras oficiais ↗
          </a>
        </p>
        {demo && (
          <p className="notice">
            Tela de referência · todos os números e contadores abaixo são
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
        <label>
          Conta Meta
          <select
            value={accountId}
            onChange={(e) => chooseAccount(e.target.value)}
          >
            <option value="">Selecione uma conta</option>
            {data.accounts.map((a: Row) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      </section>
      <section className="card">
        <details open={!data.accounts.length}>
          <summary>1. Cadastrar ou editar a conta Meta</summary>
          <p>
            Use o token com acesso à WABA e aos seus números. App Secret é o
            segredo do aplicativo Meta. Verify Token é uma chave escolhida por
            você para confirmar o webhook. As credenciais ficam protegidas no
            backend.
          </p>
          <div className="router-actions">
            <button onClick={() => editAccount()}>Nova conta</button>
            {account && (
              <button onClick={() => editAccount(account)}>
                Editar {account.name}
              </button>
            )}
          </div>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const r = await write(
                "router/accounts",
                {
                  id: accountForm.id,
                  name: accountForm.name,
                  waba_id: accountForm.waba_id,
                  timezone: accountForm.timezone,
                  secrets: {
                    token: accountForm.token,
                    app_secret: accountForm.app_secret,
                    verify_token: accountForm.verify_token,
                  },
                },
                "Salvar conta",
              );
              if (r) {
                setAccountId(r.id);
                editAccount();
              }
            }}
          >
            <div className="router-fields">
              <label>
                Nome da conta
                <input
                  required
                  maxLength={100}
                  value={accountForm.name}
                  onChange={(e) =>
                    setAccountForm({ ...accountForm, name: e.target.value })
                  }
                />
              </label>
              <label>
                WABA ID
                <input
                  required
                  readOnly={!!accountForm.id}
                  value={accountForm.waba_id}
                  onChange={(e) =>
                    setAccountForm({ ...accountForm, waba_id: e.target.value })
                  }
                />
              </label>
              <label>
                Fuso da conta Meta
                <input
                  required
                  value={accountForm.timezone}
                  onChange={(e) =>
                    setAccountForm({ ...accountForm, timezone: e.target.value })
                  }
                />
              </label>
              {[
                ["token", "Token Meta"],
                ["app_secret", "App Secret"],
                ["verify_token", "Verify Token do webhook"],
              ].map(([field, label]) => (
                <label key={field}>
                  {label}
                  <input
                    type="password"
                    autoComplete="new-password"
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
                </label>
              ))}
            </div>
            <button disabled={!!busy} type="submit">
              Salvar conta Meta
            </button>
          </form>
        </details>
        {account && (
          <>
            <h3>Webhook único desta conta</h3>
            <p>
              Cadastre esta URL no aplicativo Meta, com o Verify Token acima.
              Assine <code>messages</code>. A WABA precisa estar inscrita no
              mesmo aplicativo. Se usa ligações ou grupos, mantenha também os
              eventos desses recursos.
            </p>
            <CopyValue
              value={location.origin + "/webhooks/meta-accounts/" + account.id}
            />
          </>
        )}
      </section>
      {account && (
        <section className="card">
          <details>
            <summary>
              2. Buscar e adicionar números ({numbers.length}/20)
            </summary>
            <p>
              Os números precisam estar cadastrados e habilitados na Meta.
              Buscar números apenas consulta sua conta; não cria nem ativa
              telefones.
            </p>
            <button
              disabled={!!busy}
              onClick={() =>
                write(
                  `router/accounts/${accountId}/discover`,
                  {},
                  "Buscar números",
                )
              }
            >
              Buscar números na Meta
            </button>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const r = await write(
                  "router/numbers",
                  {
                    ...numberForm,
                    account_id: accountId,
                    baseline_used: Number(numberForm.baseline_used),
                    service_limit: Number(numberForm.service_limit),
                  },
                  "Adicionar número",
                );
                if (r)
                  setNumberForm({
                    phone_id: "",
                    baseline_used: 0,
                    service_limit: 1000,
                    baseline_confirmed: false,
                  });
              }}
            >
              <div className="router-fields">
                <label>
                  Número encontrado
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
                <label>
                  Mensagens de atendimento já usadas neste mês
                  <input
                    required
                    type="number"
                    min="0"
                    max="100000000"
                    value={numberForm.baseline_used}
                    onChange={(e) =>
                      setNumberForm({
                        ...numberForm,
                        baseline_used: e.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  Teto local de atendimento (máximo 1.000)
                  <input
                    required
                    type="number"
                    min="0"
                    max="1000"
                    value={numberForm.service_limit}
                    onChange={(e) =>
                      setNumberForm({
                        ...numberForm,
                        service_limit: e.target.value,
                      })
                    }
                  />
                </label>
              </div>
              <label className="check-line">
                <input
                  type="checkbox"
                  required
                  checked={numberForm.baseline_confirmed}
                  onChange={(e) =>
                    setNumberForm({
                      ...numberForm,
                      baseline_confirmed: e.target.checked,
                    })
                  }
                />
                Conferi na Meta o uso deste mês e o fuso {account.timezone}. O
                valor inicial não inclui mensagens futuras.
              </label>
              <p>
                O número será adicionado pausado. Se ele já está no Wabotia,
                pause e reconcilie as entregas antes. Depois confira o webhook e
                clique em Ativar na lista.
              </p>
              <button type="submit" disabled={!!busy || numbers.length >= 20}>
                Adicionar ao roteador
              </button>
            </form>
          </details>
        </section>
      )}
      <section className="card">
        <h3>Uso por número</h3>
        <p>
          Uso protegido = histórico inicial + entregas de atendimento +
          reservas. Reservas sem confirmação não são liberadas automaticamente.
          A mudança de mês segue o fuso da conta Meta.
        </p>
        {!data.numbers.length && (
          <p>
            Nenhum número cadastrado. Comece pela conta Meta e pela busca de
            números.
          </p>
        )}
        <div className="router-number-grid">
          {(accountId ? numbers : data.numbers).map((n: Row) => (
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
              <strong className="router-count">
                {n.usage.used} / {n.usage.limit}
              </strong>
              <span> usados ou reservados · {n.usage.period}</span>
              <progress
                aria-label={"Uso de " + n.name}
                value={Math.min(n.usage.used, n.usage.limit)}
                max={n.usage.limit || 1}
              />
              <dl>
                <div>
                  <dt>Disponíveis</dt>
                  <dd>{n.usage.remaining}</dd>
                </div>
                <div>
                  <dt>Reservadas</dt>
                  <dd>{n.usage.reserved}</dd>
                </div>
                <div>
                  <dt>Grátis confirmadas pela Meta</dt>
                  <dd>{n.usage.free_confirmed}</dd>
                </div>
                <div>
                  <dt>Pagas confirmadas pela Meta</dt>
                  <dd>{n.usage.billable_confirmed}</dd>
                </div>
                <div>
                  <dt>Cobrança não informada</dt>
                  <dd>{n.usage.pricing_unknown}</dd>
                </div>
                <div>
                  <dt>Uso anterior informado</dt>
                  <dd>{n.usage.baseline}</dd>
                </div>
              </dl>
              <div className="router-actions">
                <button
                  disabled={!!busy}
                  onClick={() =>
                    write(
                      `connections/${n.id}/state`,
                      { status: n.status === "active" ? "paused" : "active" },
                      n.status === "active" ? "Pausar número" : "Ativar número",
                      "PUT",
                    )
                  }
                >
                  {n.status === "active" ? "Pausar" : "Ativar"}
                </button>
                <label>
                  Teto
                  <input
                    aria-label={"Teto de " + n.name}
                    type="number"
                    min="0"
                    max="1000"
                    value={limits[n.id] ?? n.usage.limit}
                    onChange={(e) =>
                      setLimits({ ...limits, [n.id]: e.target.value })
                    }
                  />
                </label>
                <button
                  disabled={!!busy}
                  onClick={() =>
                    write(
                      `router/numbers/${n.id}/limit`,
                      { service_limit: Number(limits[n.id] ?? n.usage.limit) },
                      "Atualizar teto",
                      "PUT",
                    )
                  }
                >
                  Salvar teto
                </button>
              </div>
              <small>ID para a API</small>
              <CopyValue value={n.id} />
            </article>
          ))}
        </div>
      </section>
      {account && (
        <section className="card">
          <h3>3. Grupos de números</h3>
          <p>
            Um grupo pertence a uma conta Meta. A escolha ocorre no início do
            atendimento e fica vinculada a ele. Grupos podem compartilhar
            números; o consumo do número continua único.
          </p>
          {data.pools
            .filter((p: Row) => p.account_id === accountId)
            .map((p: Row) => (
              <div className="router-pool" key={p.id}>
                <strong>{p.name}</strong>
                <span>
                  {p.members.length} números · {p.enabled ? "Ativo" : "Pausado"}{" "}
                  ·{" "}
                  {p.allow_paid
                    ? "Modelos pagos permitidos com autorização"
                    : "Somente atendimento"}
                </span>
                <button
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
                <CopyValue value={p.id} />
                {p.public_token && (
                  <>
                    <small>
                      Link para o cliente iniciar contato num número disponível
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
          <details>
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
                    strategy: "least_used",
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
                  Como escolher
                  <select
                    value={poolForm.strategy}
                    onChange={(e) =>
                      setPoolForm({ ...poolForm, strategy: e.target.value })
                    }
                  >
                    <option value="least_used">
                      Menor consumo, alternando empates
                    </option>
                    <option value="round_robin">Em sequência</option>
                    <option value="random">
                      Aleatório entre os disponíveis
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
              <button disabled={!!busy} type="submit">
                Salvar grupo
              </button>
              {poolForm.id && (
                <button
                  type="button"
                  onClick={() =>
                    setPoolForm({
                      name: "",
                      strategy: "least_used",
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
      <section className="card">
        <details>
          <summary>4. Autorizar programas externos</summary>
          <p>
            Crie a aplicação e sua chave em <strong>API e integrações</strong>,
            com acesso a este perfil. Aqui, escolha quais números ou grupos ela
            poderá usar.
          </p>
          <label>
            Aplicação
            <select value={appId} onChange={(e) => selectApp(e.target.value)}>
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
              <h4>Número escolhido diretamente</h4>
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
                Permitir modelos pagos nestas origens. Cada pedido ainda exige
                allow_paid: true e consentimento.
              </label>
              <p>
                Salvar também autoriza a aplicação a consultar o roteador e
                operar conversas deste perfil. Autorizar um grupo permite seus
                membros atuais e futuros; a escolha direta de um número exige a
                autorização individual.
              </p>
              <button disabled={!!busy} type="submit">
                Salvar permissões do roteador
              </button>
            </form>
          )}
        </details>
      </section>
      <section className="card">
        <details>
          <summary>5. Enviar pela API</summary>
          <p>
            Use a chave Bearer no servidor do programa integrador e uma{" "}
            <code>Idempotency-Key</code> por pedido. Escolha{" "}
            <code>number_id</code> ou <code>pool_id</code>. O retorno 202
            confirma a fila; acompanhe a entrega na conversa e nos webhooks.
          </p>
          <CopyValue
            value={location.origin + "/api/" + root + "/router/messages"}
          />
          <h4>Atendimento: exige mensagem recente do cliente neste número</h4>
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
            Não altere o identificador externo durante o atendimento para forçar
            troca de remetente. Um resultado sem confirmação exige
            reconciliação; repetir com outro número pode duplicar a mensagem.
          </p>
          <a href="/api-docs">Abrir documentação da API</a>
        </details>
      </section>
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
