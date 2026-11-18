import React, { useMemo, useState } from "react";
import type { Api, Row } from "../../lib/api";
import { Form, Records, useData, WorkForm } from "./shared";
import "./condominio.css";

function Portal({ session }: { session: Row }) {
  const api = useMemo<Api>(
    () =>
      async (path, method = "GET", body, signal, key) => {
        const response = await fetch(`/api/${path}`, {
          method,
          signal,
          credentials: "omit",
          referrerPolicy: "no-referrer",
          headers: {
            Authorization: `Bearer ${session.token}`,
            "Content-Type": "application/json",
            ...(method !== "GET"
              ? { "Idempotency-Key": key || crypto.randomUUID() }
              : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const result = (await response.json()) as Row;
        if (!response.ok)
          throw new Error(
            result.error?.message ||
              "Acesso indisponível. Abra um novo link pelo WhatsApp.",
          );
        return result;
      },
    [session],
  );
  const root = `v1/profiles/${encodeURIComponent(session.profile)}/condominio/me/${encodeURIComponent(session.subject)}`;
  const [revision, setRevision] = useState(0),
    [unit, setUnit] = useState(""),
    [error, setError] = useState(""),
    [assembly, setAssembly] = useState<Row | null>(null),
    [agenda, setAgenda] = useState<Row | null>(null),
    [voteUnit, setVoteUnit] = useState(""),
    [choice, setChoice] = useState(""),
    [receipt, setReceipt] = useState<Row | null>(null),
    [notice, setNotice] = useState<Row | null>(null),
    [work, setWork] = useState<Row | null>(null);
  const refresh = () => setRevision((n) => n + 1);
  const units = useData(api, `${root}/units`, revision);
  const selectedUnit =
    unit ||
    units.data.selected ||
    (units.data.data?.length === 1 ? units.data.data[0].id : "");
  const { data: detail } = useData(
    api,
    assembly ? `${root}/assemblies/${assembly.id}` : null,
    revision,
  );
  const { data: eligible } = useData(
    api,
    assembly ? `${root}/assemblies/${assembly.id}/units` : null,
    revision,
  );
  const { data: tally } = useData(
    api,
    agenda?.status === "closed" ? `${root}/agenda/${agenda.id}/results` : null,
    revision,
  );
  const { data: ballot, error: ballotError } = useData(
    api,
    agenda?.status === "open" && voteUnit
      ? `${root}/agenda/${agenda.id}/ballot?unit_id=${encodeURIComponent(voteUnit)}`
      : null,
    revision,
  );
  const { data: workDetail, error: workError } = useData(
    api,
    work ? `${root}/works/${work.id}` : null,
    revision,
  );
  return (
    <>
      <h1>Minha unidade</h1>
      <p>
        Este acesso é pessoal e temporário. Abra um novo link pelo WhatsApp
        quando expirar.
      </p>
      <p role="alert">{units.error || error}</p>
      <label>
        Unidade{" "}
        <select
          value={selectedUnit}
          onChange={async (e) => {
            const value = e.target.value;
            setError("");
            try {
              await api(`${root}/select`, "POST", { unit_id: value });
              setUnit(value);
              setWork(null);
              refresh();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          <option value="">Escolha sua unidade</option>
          {units.data.data?.map((u: Row) => (
            <option key={u.id} value={u.id}>
              {u.block} · {u.number}
            </option>
          ))}
        </select>
      </label>
      {selectedUnit && (
        <>
          <section>
            <h2>Seus registros</h2>
            <Records
              api={api}
              path={`${root}/works?unit_id=${encodeURIComponent(selectedUnit)}`}
              revision={revision}
              columns={[
                ["kind", "Tipo"],
                ["block", "Bloco"],
                ["unit", "Unidade"],
              ]}
              choose={setWork}
            />
            {work && (
              <>
                <p role="alert">{workError}</p>
                <p>
                  {workDetail.display_number} · {workDetail.stage_label}
                </p>
                <p>{workDetail.item}</p>
                <p>{workDetail.problem}</p>
              </>
            )}
            <WorkForm
              api={api}
              root={root}
              customer
              unitId={selectedUnit}
              onDone={refresh}
            />
            <h3>Seus veículos e animais</h3>
            <Records
              api={api}
              path={`${root}/assets?unit_id=${encodeURIComponent(selectedUnit)}`}
              columns={[
                ["label", "Nome/modelo"],
                ["detail", "Placa/espécie"],
              ]}
            />
          </section>
        </>
      )}
      <section>
        <h2>Comunicados</h2>
        <Records
          api={api}
          path={`${root}/notices`}
          revision={revision}
          columns={[["title", "Título"]]}
          choose={setNotice}
        />
        {notice && (
          <>
            <h3>{notice.title}</h3>
            <pre>{notice.body}</pre>
          </>
        )}
      </section>
      <section>
        <h2>Assembleias</h2>
        <Records
          api={api}
          path={`${root}/assemblies`}
          revision={revision}
          columns={[
            ["title", "Título"],
            ["status", "Situação"],
          ]}
          choose={(a) => {
            setAssembly(a);
            setAgenda(null);
            setReceipt(null);
            setVoteUnit("");
          }}
        />
        {assembly && (
          <>
            <h3>{detail.title}</h3>
            <pre>{detail.call_text}</pre>
            <label>
              Unidade que você representa nesta assembleia{" "}
              <select
                value={voteUnit}
                onChange={(e) => {
                  setVoteUnit(e.target.value);
                  setChoice("");
                  setReceipt(null);
                }}
              >
                <option value="">Selecione</option>
                {eligible.data?.map((u: Row) => (
                  <option key={`${u.id}:${u.proxy_id || ""}`} value={u.id}>
                    {u.block} · {u.number}
                  </option>
                ))}
              </select>
            </label>
            {voteUnit && (
              <Form
                fields={[
                  {
                    key: "leave",
                    label: "Registrar saída em vez de entrada",
                    type: "checkbox",
                  },
                ]}
                label="Registrar presença/saída"
                submit={(d, k) =>
                  api(
                    `${root}/attendance`,
                    "POST",
                    {
                      ...d,
                      assembly_id: assembly.id,
                      unit_id: voteUnit,
                      proxy_id:
                        eligible.data?.find((u: Row) => u.id === voteUnit)
                          ?.proxy_id || undefined,
                    },
                    undefined,
                    k,
                  )
                }
                onDone={refresh}
              />
            )}
            <nav>
              {detail.agenda?.map((p: Row) => (
                <button
                  key={p.id}
                  onClick={() => {
                    setAgenda(p);
                    setChoice("");
                    setReceipt(null);
                  }}
                >
                  {p.title} · {p.status}
                </button>
              ))}
            </nav>
            {agenda && (
              <section>
                <h4>{agenda.title}</h4>
                <p role="alert">{ballotError}</p>
                {tally.totals?.map((t: Row) => (
                  <p key={t.choice}>
                    {t.choice}: {t.votes} voto(s), peso {t.weight}
                  </p>
                ))}
                {ballot.id && ballot.status === "open" && !receipt && (
                  <>
                    <p>
                      Peso deste voto: {ballot.weight}. Um voto confirmado por
                      unidade.
                    </p>
                    <label>
                      Escolha{" "}
                      <select
                        value={choice}
                        onChange={(e) => setChoice(e.target.value)}
                      >
                        <option value="">Selecione</option>
                        {ballot.options?.map((o: string) => (
                          <option key={o}>{o}</option>
                        ))}
                      </select>
                    </label>
                    {choice && (
                      <Form
                        key={`${voteUnit}:${agenda.id}:${choice}`}
                        fields={[
                          {
                            key: "confirmed",
                            label: `Confirmo o voto “${choice}” pela unidade ${eligible.data?.find((u: Row) => u.id === voteUnit)?.block} ${eligible.data?.find((u: Row) => u.id === voteUnit)?.number}. O voto não pode ser alterado.`,
                            type: "checkbox",
                            required: true,
                          },
                        ]}
                        label="Confirmar voto"
                        submit={(d, k) =>
                          api(
                            `${root}/votes`,
                            "POST",
                            {
                              ...d,
                              agenda_id: agenda.id,
                              unit_id: voteUnit,
                              choice,
                            },
                            undefined,
                            k,
                          )
                        }
                        onDone={(r) => {
                          setReceipt(r);
                          refresh();
                        }}
                      />
                    )}
                  </>
                )}
                {receipt && (
                  <p role="status">Voto registrado. Recibo: {receipt.id}</p>
                )}
              </section>
            )}
            <pre>{detail.minutes}</pre>
          </>
        )}
      </section>
    </>
  );
}

export function MoradorPage() {
  const [code] = useState(() => {
    const value = location.hash.slice(1);
    history.replaceState(null, "", location.pathname);
    return value;
  });
  const [session, setSession] = useState<Row | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <main className="condominio condominio-access">
      {session ? (
        <Portal session={session} />
      ) : (
        <>
          <h1>Acesso do morador</h1>
          <p>
            Use o link pessoal enviado ao seu WhatsApp. Não compartilhe este
            acesso.
          </p>
          <button
            disabled={busy || !code}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const response = await fetch("/api/credentials/claim", {
                  method: "POST",
                  credentials: "omit",
                  referrerPolicy: "no-referrer",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    code,
                    name: "Morador",
                    device: "Portal do condomínio",
                  }),
                });
                const data = (await response.json()) as Row;
                if (!response.ok || data.module !== "condominio")
                  throw new Error(
                    data.error?.message || "Acesso indisponível.",
                  );
                setSession(data);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Abrindo…" : "Entrar"}
          </button>
          {!code && (
            <p>Peça um novo link em Minha unidade, no menu do WhatsApp.</p>
          )}
          <p role="alert">{error}</p>
        </>
      )}
    </main>
  );
}
