import React, { useState } from "react";
import { useApp } from "../../app/AppContext";
import type { Api, Row } from "../../lib/api";
import {
  choices,
  Form,
  Records,
  useData,
  usePagedData,
  WorkForm,
  type Field,
} from "./shared";
import "./condominio.css";

const unitChoices = (rows: Row[] = []) =>
  choices(rows, (r) => `${r.block || ""} ${r.number}`);
function Assemblies({
  api,
  root,
  revision,
  refresh,
  admin,
}: {
  api: Api;
  root: string;
  revision: number;
  refresh: () => void;
  admin: boolean;
}) {
  const [assembly, setAssembly] = useState<Row | null>(null),
    [agenda, setAgenda] = useState<Row | null>(null);
  const people = usePagedData(api, `${root}/electoral-people`, revision),
    units = usePagedData(api, `${root}/electoral-units`, revision);
  const directory = { people: people.data.data, units: units.data.data },
    error = people.error || units.error;
  const { data: detail } = useData(
    api,
    assembly ? `${root}/assemblies/${assembly.id}` : null,
    revision,
  );
  const { data: proxies } = useData(
    api,
    assembly ? `${root}/assemblies/${assembly.id}/proxies` : null,
    revision,
  );
  const { data: tally } = useData(
    api,
    agenda?.status === "closed" ? `${root}/agenda/${agenda.id}/results` : null,
    revision,
  );
  const post = (path: string, d: Row, key: string) =>
    api(`${root}/${path}`, "POST", d, undefined, key);
  const person: Field = {
    key: "person_id",
    label: "Pessoa",
    options: choices(directory.people),
    more: people.more,
  };
  const unit: Field = {
    key: "unit_id",
    label: "Unidade",
    options: unitChoices(directory.units),
    more: units.more,
  };
  return (
    <>
      <h2>Assembleias</h2>
      <p role="alert">{error}</p>
      <details>
        <summary>Preparar assembleia</summary>
        <Form
          fields={[
            { key: "title", label: "Título" },
            {
              key: "call_text",
              label: "Convocação revisada para os moradores",
              type: "textarea",
            },
            {
              key: "starts_at",
              label: "Data e hora de início",
              type: "datetime-local",
            },
          ]}
          submit={(d, k) => post("assemblies", d, k)}
          onDone={refresh}
        />
      </details>
      <Records
        api={api}
        path={`${root}/assemblies`}
        revision={revision}
        columns={[
          ["title", "Assembleia"],
          ["status", "Situação"],
        ]}
        choose={(row) => {
          setAssembly(row);
          setAgenda(null);
        }}
      />
      {assembly && (
        <section>
          <h3>{detail.title || assembly.title}</h3>
          <pre>{detail.call_text}</pre>
          {assembly.status === "draft" && (
            <>
              <h4>Pauta</h4>
              <Form
                fields={[
                  { key: "title", label: "Tema da votação" },
                  {
                    key: "options",
                    label:
                      "Opções, uma por linha (inclua abstenção se aplicável)",
                    type: "lines",
                  },
                  {
                    key: "closes_at",
                    label: "Encerramento da votação",
                    type: "datetime-local",
                  },
                  {
                    key: "weighted",
                    label: "Pesar por fração ideal",
                    type: "checkbox",
                  },
                  {
                    key: "block_debt",
                    label:
                      "Exigir regularidade financeira revisada por unidade",
                    type: "checkbox",
                  },
                ]}
                submit={(d, k) =>
                  post(`assemblies/${assembly.id}/agenda`, d, k)
                }
                onDone={refresh}
              />
              <Form
                fields={[
                  {
                    key: "reviewed",
                    label:
                      "Conferi convocação, público e pauta; o texto pode ser mostrado aos moradores",
                    type: "checkbox",
                    required: true,
                  },
                ]}
                label="Publicar convocação"
                submit={(d, k) =>
                  post(`assemblies/${assembly.id}/publish`, d, k)
                }
                onDone={() => {
                  setAssembly({ ...assembly, status: "published" });
                  refresh();
                }}
              />
              <p>
                Depois da publicação, a administração inicia o envio na aba
                Comunicados.
              </p>
            </>
          )}
          <nav>
            {detail.agenda?.map((p: Row) => (
              <button key={p.id} onClick={() => setAgenda(p)}>
                {p.title} · {p.status}
              </button>
            ))}
          </nav>
          {agenda && (
            <section>
              <h4>{agenda.title}</h4>
              <p>{agenda.options?.join(" / ")}</p>
              <Records
                api={api}
                path={`${root}/agenda/${agenda.id}/electors`}
                revision={revision}
                columns={[
                  ["unit_label", "Unidade"],
                  ["person_name", "Pessoa habilitada"],
                  ["weight", "Peso"],
                ]}
              />
              {agenda.status === "draft" && (
                <>
                  <Form
                    fields={[
                      unit,
                      person,
                      {
                        key: "proxy_id",
                        label:
                          "Procuração conferida (opcional para proprietário)",
                        required: false,
                        options: choices(
                          proxies.data?.filter(
                            (p: Row) => p.status === "approved",
                          ),
                          (p) =>
                            `${directory.people?.find((v: Row) => v.id === p.person_id)?.name || "Representante"} · ${directory.units?.find((u: Row) => u.id === p.unit_id)?.number || "Unidade"}`,
                        ),
                      },
                      ...(agenda.block_debt && admin
                        ? [
                            {
                              key: "debt_status",
                              label:
                                "Situação da unidade na data de referência",
                              options: [
                                { value: "regular", label: "Regular" },
                                { value: "overdue", label: "Inadimplente" },
                              ],
                            },
                            {
                              key: "debt_evidence",
                              label: "Evidência e data da conferência",
                              type: "textarea",
                            },
                          ]
                        : []),
                    ]}
                    label="Habilitar pessoa pela unidade"
                    submit={(d, k) => post(`agenda/${agenda.id}/qualify`, d, k)}
                    onDone={refresh}
                  />
                  <p>
                    Habilite uma pessoa por unidade. Abrir congela as regras e
                    os pesos. Presença é registrada separadamente.
                  </p>
                  <Form
                    fields={[]}
                    label="Abrir votação"
                    submit={(d, k) => post(`agenda/${agenda.id}/open`, d, k)}
                    onDone={() => {
                      setAgenda({ ...agenda, status: "open" });
                      refresh();
                    }}
                  />
                </>
              )}
              {agenda.status === "open" && (
                <Form
                  fields={[]}
                  label="Encerrar votação"
                  submit={(d, k) => post(`agenda/${agenda.id}/close`, d, k)}
                  onDone={() => {
                    setAgenda({ ...agenda, status: "closed" });
                    refresh();
                  }}
                />
              )}
              {agenda.status !== "annulled" && (
                <details>
                  <summary>Anular votação</summary>
                  <Form
                    fields={[{ key: "reason", label: "Justificativa" }]}
                    label="Anular"
                    submit={(d, k) => post(`agenda/${agenda.id}/annul`, d, k)}
                    onDone={() => {
                      setAgenda({ ...agenda, status: "annulled" });
                      refresh();
                    }}
                  />
                </details>
              )}
              {tally.totals?.map((t: Row) => (
                <p key={t.choice}>
                  {t.choice}: {t.votes} voto(s), peso {t.weight}
                </p>
              ))}
            </section>
          )}
          <details>
            <summary>Procurações</summary>
            <p>
              Registre a referência da evidência privada e confira os poderes
              antes de aprovar.
            </p>
            <Form
              fields={[
                unit,
                {
                  key: "grantor_id",
                  label: "Proprietário outorgante",
                  options: choices(directory.people),
                },
                person,
                {
                  key: "agenda_id",
                  label: "Somente esta pauta (opcional)",
                  required: false,
                  options: choices(detail.agenda, (p) => p.title),
                },
                {
                  key: "evidence",
                  label: "Referência e conferência da procuração",
                  type: "textarea",
                },
                {
                  key: "expires_at",
                  label: "Validade",
                  type: "datetime-local",
                },
              ]}
              submit={(d, k) =>
                post("proxies", { ...d, assembly_id: assembly.id }, k)
              }
              onDone={refresh}
            />
            {proxies.data?.map((p: Row) => (
              <section key={p.id}>
                <p>
                  {
                    directory.people?.find((x: Row) => x.id === p.person_id)
                      ?.name
                  }{" "}
                  · {p.status}
                </p>
                <pre>{p.evidence}</pre>
                <Form
                  fields={[
                    {
                      key: "reviewed",
                      label: "Conferi a representação",
                      type: "checkbox",
                      required: true,
                    },
                  ]}
                  label={
                    p.status === "pending"
                      ? "Aprovar procuração"
                      : "Revogar procuração"
                  }
                  submit={(d, k) =>
                    post(
                      `proxies/${p.id}/${p.status === "pending" ? "review" : "revoke"}`,
                      d,
                      k,
                    )
                  }
                  onDone={refresh}
                />
              </section>
            ))}
          </details>
          <details>
            <summary>Lista de presença</summary>
            <Form
              fields={[
                unit,
                person,
                {
                  key: "proxy_id",
                  label: "Procuração, se representante",
                  required: false,
                  options: choices(
                    proxies.data,
                    (p) =>
                      directory.people?.find((v: Row) => v.id === p.person_id)
                        ?.name || "Representante",
                  ),
                },
                { key: "leave", label: "Registrar saída", type: "checkbox" },
              ]}
              submit={(d, k) =>
                post("attendance", { ...d, assembly_id: assembly.id }, k)
              }
              onDone={refresh}
            />
            <Records
              api={api}
              path={`${root}/assemblies/${assembly.id}/attendance`}
              revision={revision}
              columns={[
                ["person_name", "Pessoa"],
                ["unit_label", "Unidade"],
                ["arrived_at", "Entrada"],
                ["left_at", "Saída"],
              ]}
            />
          </details>
          <Form
            fields={[]}
            label="Apurar e gerar ata em texto"
            submit={(d, k) => post(`assemblies/${assembly.id}/minutes`, d, k)}
            onDone={refresh}
          />
          {detail.minutes && (
            <>
              <pre>{detail.minutes}</pre>
              <button
                onClick={() => {
                  const url = URL.createObjectURL(
                    new Blob([detail.minutes], {
                      type: "text/plain;charset=utf-8",
                    }),
                  );
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = "ata.txt";
                  a.click();
                  URL.revokeObjectURL(url);
                }}
              >
                Baixar ata
              </button>
            </>
          )}
        </section>
      )}
    </>
  );
}

export function CondominioPage() {
  const app = useApp(),
    root = `${app.root}/condominio`;
  const [tab, setTab] = useState("portaria"),
    [revision, setRevision] = useState(0),
    [kind, setKind] = useState("blocks"),
    [chosen, setChosen] = useState<Row | null>(null);
  const refresh = () => setRevision((v) => v + 1);
  const capabilities = useData(app.api, `${root}/capabilities`),
    caps = capabilities.data;
  const blockPages = usePagedData(
      app.api,
      caps.admin && ["cadastro", "comunicados"].includes(tab)
        ? `${root}/blocks`
        : null,
      revision,
    ),
    blocks = blockPages.data;
  const peoplePages = usePagedData(
    app.api,
    caps.admin && tab === "cadastro" ? `${root}/electoral-people` : null,
    revision,
  );
  const unitPages = usePagedData(
    app.api,
    caps.admin && ["cadastro", "comunicados"].includes(tab)
      ? `${root}/electoral-units`
      : null,
    revision,
  );
  const directory = {
    people: peoplePages.data.data,
    units: unitPages.data.data,
  };
  const { data: conversations } = useData(
    app.api,
    caps.admin && tab === "cadastro" && kind === "phones"
      ? `${app.root}/conversations?limit=100`
      : null,
  );
  const contactPages = usePagedData(
      app.api,
      tab === "portaria" && (caps.admin || caps.portaria)
        ? `${root}/contacts`
        : null,
      revision,
    ),
    contacts = contactPages.data;
  const { data: work, error: workError } = useData(
    app.api,
    tab === "portaria" && chosen ? `${root}/works/${chosen.id}` : null,
    revision,
  );
  const schemas: Record<string, Field[]> = {
    blocks: [{ key: "name", label: "Nome do bloco" }],
    units: [
      { key: "block_id", label: "Bloco", options: choices(blocks.data) },
      { key: "number", label: "Número ou nome da unidade" },
      {
        key: "fraction_ppb",
        label: "Fração ideal em partes por bilhão (opcional)",
        type: "number",
        required: false,
      },
    ],
    people: [{ key: "name", label: "Nome do morador" }],
    phones: [
      {
        key: "person_id",
        label: "Morador",
        options: choices(directory.people),
      },
      {
        key: "conversation_id",
        label: "Conversa do WhatsApp verificado",
        options: choices(
          conversations.data,
          (c) =>
            `${c.name || c.customer_name || "Conversa"} · ${c.phone || ""}`,
        ),
      },
      {
        key: "confirmed",
        label: "Conferi que este telefone pertence ao morador",
        type: "checkbox",
        required: true,
      },
    ],
    memberships: [
      {
        key: "person_id",
        label: "Morador",
        options: choices(directory.people),
      },
      {
        key: "unit_id",
        label: "Unidade",
        options: unitChoices(directory.units),
      },
      {
        key: "role",
        label: "Papel",
        options: [
          { value: "proprietario", label: "Proprietário" },
          { value: "inquilino", label: "Inquilino" },
          { value: "dependente", label: "Dependente" },
          { value: "funcionario", label: "Funcionário da unidade" },
        ],
      },
      { key: "starts_at", label: "Início", type: "datetime-local" },
      {
        key: "ends_at",
        label: "Fim (opcional, exclusivo)",
        type: "datetime-local",
        required: false,
      },
      {
        key: "notices",
        label: "Receber avisos de comunicados",
        type: "checkbox",
      },
    ],
    assets: [
      {
        key: "unit_id",
        label: "Unidade",
        options: unitChoices(directory.units),
      },
      {
        key: "person_id",
        label: "Responsável",
        options: choices(directory.people),
      },
      {
        key: "kind",
        label: "Cadastro",
        options: [
          { value: "vehicle", label: "Veículo" },
          { value: "animal", label: "Animal" },
        ],
      },
      { key: "label", label: "Nome ou modelo" },
      { key: "detail", label: "Placa ou espécie (sem dados clínicos)" },
    ],
  };
  return (
    <div className="condominio">
      <h1>Condomínio</h1>
      {capabilities.error && (
        <p role="alert">
          {capabilities.error} O acesso ao Condomínio exige um papel do
          condomínio (administração, mesa ou portaria), concedido em Pessoas e
          acessos; ser administrador da área não basta.
        </p>
      )}
      <nav>
        {caps.admin && (
          <button
            onClick={() => {
              setTab("cadastro");
              setChosen(null);
            }}
          >
            Cadastro
          </button>
        )}
        {(caps.admin || caps.portaria) && (
          <button
            onClick={() => {
              setTab("portaria");
              setChosen(null);
            }}
          >
            Portaria e trabalhos
          </button>
        )}
        {caps.admin && (
          <button
            onClick={() => {
              setTab("comunicados");
              setChosen(null);
            }}
          >
            Comunicados
          </button>
        )}
        {(caps.admin || caps.mesa) && (
          <button
            onClick={() => {
              setTab("assembleias");
              setChosen(null);
            }}
          >
            Assembleias
          </button>
        )}
      </nav>
      <p role="alert">
        {peoplePages.error ||
          unitPages.error ||
          blockPages.error ||
          contactPages.error}
      </p>
      {tab === "comunicados" && (
        <nav>
          {blockPages.more && (
            <button onClick={blockPages.more}>Carregar mais blocos</button>
          )}
          {unitPages.more && (
            <button onClick={unitPages.more}>Carregar mais unidades</button>
          )}
        </nav>
      )}
      {tab === "cadastro" && caps.admin && (
        <section>
          <h2>Cadastro</h2>
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              setChosen(null);
            }}
          >
            {Object.entries({
              blocks: "Blocos",
              units: "Unidades",
              people: "Moradores",
              memberships: "Vínculos e períodos",
              phones: "Telefones",
              assets: "Veículos e animais",
            }).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <Form
            key={kind}
            fields={schemas[kind].map((f) => ({
              ...f,
              more:
                f.key === "person_id"
                  ? peoplePages.more
                  : f.key === "unit_id"
                    ? unitPages.more
                    : f.key === "block_id"
                      ? blockPages.more
                      : undefined,
            }))}
            submit={(d, k) =>
              app.api(`${root}/${kind}`, "POST", d, undefined, k)
            }
            onDone={refresh}
          />
          <Records
            api={app.api}
            path={`${root}/${kind}`}
            revision={revision}
            columns={
              kind === "blocks" || kind === "people"
                ? [["name", "Nome"]]
                : kind === "units"
                  ? [
                      ["block", "Bloco"],
                      ["number", "Unidade"],
                      ["fraction_ppb", "Fração"],
                    ]
                  : kind === "phones"
                    ? [
                        ["person_name", "Morador"],
                        ["phone", "Telefone"],
                        ["ends_at", "Encerramento"],
                      ]
                    : kind === "assets"
                      ? [
                          ["label", "Nome/modelo"],
                          ["detail", "Placa/espécie"],
                        ]
                      : [
                          ["person_name", "Morador"],
                          ["unit_label", "Unidade"],
                          ["role", "Papel"],
                          ["ends_at", "Fim"],
                        ]
            }
            choose={
              ["memberships", "phones"].includes(kind) ? setChosen : undefined
            }
          />
          {chosen && (
            <Form
              fields={[]}
              label="Encerrar vínculo selecionado"
              submit={(d, k) =>
                app.api(
                  `${root}/${kind}/${chosen.id}/end`,
                  "POST",
                  d,
                  undefined,
                  k,
                )
              }
              onDone={() => {
                setChosen(null);
                refresh();
              }}
            />
          )}
        </section>
      )}
      {tab === "portaria" && (caps.admin || caps.portaria) && (
        <section>
          <Records
            api={app.api}
            path={`${root}/contacts`}
            revision={revision}
            columns={[
              ["name", "Nome"],
              ["block", "Bloco"],
              ["unit", "Unidade"],
              ["phone", "Telefone"],
            ]}
          />
          <WorkForm
            api={app.api}
            root={root}
            contacts={contacts.data}
            moreContacts={contactPages.more}
            onDone={refresh}
          />
          <Records
            api={app.api}
            path={`${root}/works`}
            revision={revision}
            columns={[
              ["kind", "Tipo"],
              ["block", "Bloco"],
              ["unit", "Unidade"],
            ]}
            choose={setChosen}
          />
          {chosen && (
            <section>
              <p role="alert">{workError}</p>
              <p>
                {work.name || work.customer?.name} · {work.unit} ·{" "}
                {work.stage_label || work.stage}
              </p>
              <Form
                fields={[
                  {
                    key: "transition_id",
                    label: "Próxima etapa",
                    options:
                      work.actions?.map((a: Row) => ({
                        value: a.id,
                        label: a.label,
                      })) ||
                      work.next_stages
                        ?.filter((s: Row) => s.kind === "manual")
                        .map((s: Row) => ({
                          value: s.transition_id,
                          label: s.stage_label,
                        })) ||
                      [],
                  },
                ]}
                label="Registrar etapa"
                submit={(d, k) =>
                  app.api(
                    `${root}/works/${chosen.id}/stage`,
                    "POST",
                    { ...d, version: work.version },
                    undefined,
                    k,
                  )
                }
                onDone={refresh}
              />
            </section>
          )}
        </section>
      )}
      {tab === "comunicados" && caps.admin && (
        <section>
          <h2>Comunicados</h2>
          <Form
            fields={[
              { key: "title", label: "Título" },
              {
                key: "body",
                label: "Texto adequado ao público",
                type: "textarea",
              },
              {
                key: "audience",
                label: "Público",
                options: [
                  { value: "all", label: "Todos" },
                  { value: "block", label: "Um bloco" },
                  { value: "units", label: "Lista de unidades" },
                ],
              },
              {
                key: "targets",
                label:
                  "Selecione o bloco ou as unidades; deixe vazio para Todos",
                type: "multi",
                required: false,
                options: [
                  ...choices(blocks.data),
                  ...unitChoices(directory.units),
                ],
              },
            ]}
            submit={(d, k) =>
              app.api(`${root}/notices`, "POST", d, undefined, k)
            }
            onDone={refresh}
          />
          <Records
            api={app.api}
            path={`${root}/notices`}
            revision={revision}
            columns={[
              ["title", "Título"],
              ["status", "Situação"],
              ["queued", "Na fila"],
              ["failed", "Falhas"],
            ]}
            choose={setChosen}
          />
          {chosen && (
            <section>
              <h3>{chosen.title}</h3>
              <pre>{chosen.body}</pre>
              <Form
                fields={
                  chosen.status === "draft"
                    ? [
                        {
                          key: "reviewed_public_content",
                          label:
                            "Revisei texto e público: sem dados pessoais ou financeiros individuais",
                          type: "checkbox",
                          required: true,
                        },
                      ]
                    : []
                }
                label={
                  chosen.status === "draft"
                    ? "Aprovar"
                    : chosen.status === "approved"
                      ? "Iniciar envio"
                      : "Repetir falhas (máximo 3 tentativas)"
                }
                submit={(d, k) =>
                  app.api(
                    `${root}/notices/${chosen.id}/${chosen.status === "draft" ? "approve" : chosen.status === "approved" ? "send" : "retry"}`,
                    "POST",
                    d,
                    undefined,
                    k,
                  )
                }
                onDone={() => {
                  setChosen(null);
                  refresh();
                }}
              />
            </section>
          )}
        </section>
      )}
      {tab === "assembleias" && (caps.admin || caps.mesa) && (
        <Assemblies
          api={app.api}
          root={root}
          revision={revision}
          refresh={refresh}
          admin={caps.admin}
        />
      )}
    </div>
  );
}
