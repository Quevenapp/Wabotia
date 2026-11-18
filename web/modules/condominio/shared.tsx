import React, { useEffect, useRef, useState } from "react";
import type { Api, Row } from "../../lib/api";

export type Field = {
  key: string;
  label: string;
  type?: string;
  required?: boolean;
  options?: { value: string; label: string }[];
  value?: unknown;
  more?: () => void;
};
export function Form({
  fields,
  submit,
  label = "Salvar",
  onDone,
}: {
  fields: Field[];
  submit: (data: Row, key: string) => Promise<any>;
  label?: string;
  onDone?: (result: any) => void;
}) {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const intent = useRef({ payload: "", key: "" });
  return (
    <form
      className="cond-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        const form = event.currentTarget,
          fd = new FormData(form),
          data: Row = {};
        for (const f of fields) {
          const raw = fd.get(f.key);
          if (f.type === "checkbox") data[f.key] = raw === "on";
          else if (f.type === "multi") data[f.key] = fd.getAll(f.key);
          else if (f.type === "lines")
            data[f.key] = String(raw || "")
              .split("\n")
              .map((v) => v.trim())
              .filter(Boolean);
          else if (raw !== "" && raw !== null)
            data[f.key] =
              f.type === "number"
                ? Number(raw)
                : f.type === "datetime-local"
                  ? new Date(String(raw)).getTime()
                  : raw;
        }
        const payload = JSON.stringify(data);
        if (intent.current.payload !== payload)
          intent.current = { payload, key: crypto.randomUUID() };
        setBusy(true);
        setMessage("");
        try {
          const result = await submit(data, intent.current.key);
          setMessage("Salvo.");
          intent.current = { payload: "", key: "" };
          onDone?.(result);
        } catch (e) {
          setMessage((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {fields.map((f) => (
        <label key={f.key}>
          {f.label}
          {f.type === "checkbox" ? (
            <input
              name={f.key}
              type="checkbox"
              defaultChecked={Boolean(f.value)}
              required={f.required}
            />
          ) : f.options ? (
            <select
              name={f.key}
              multiple={f.type === "multi"}
              required={f.required !== false}
              defaultValue={f.type === "multi" ? [] : String(f.value || "")}
            >
              {f.type !== "multi" && <option value="">Selecione</option>}
              {f.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : ["textarea", "lines"].includes(f.type || "") ? (
            <textarea
              name={f.key}
              required={f.required !== false}
              defaultValue={String(f.value || "")}
              rows={3}
            />
          ) : (
            <input
              name={f.key}
              type={f.type || "text"}
              required={f.required !== false}
              defaultValue={String(f.value ?? "")}
            />
          )}
          {f.more && (
            <button type="button" onClick={f.more}>
              Carregar mais opções
            </button>
          )}
        </label>
      ))}
      <button type="submit" disabled={busy}>
        {busy ? "Salvando…" : label}
      </button>
      <p role="status">{message}</p>
    </form>
  );
}
export function useData(api: Api, path: string | null, revision = 0) {
  const [data, setData] = useState<Row>({}),
    [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setData({});
    setError("");
    if (path)
      api(path, "GET", undefined, controller.signal)
        .then(setData)
        .catch((e) => {
          if (e.name !== "AbortError") setError(e.message);
        });
    return () => controller.abort();
  }, [api, path, revision]);
  return { data, error };
}
export function usePagedData(api: Api, path: string | null, revision = 0) {
  const [cursor, setCursor] = useState(""),
    [data, setData] = useState<Row>({ data: [] }),
    [error, setError] = useState("");
  useEffect(() => {
    setCursor("");
  }, [path, revision]);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    if (!path) {
      setData({ data: [] });
      return;
    }
    if (!cursor) setData({ data: [] });
    api(
      `${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`,
      "GET",
      undefined,
      controller.signal,
    )
      .then((result) =>
        setData((previous) => ({
          ...result,
          data: cursor ? [...previous.data, ...result.data] : result.data,
        })),
      )
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => controller.abort();
  }, [api, path, revision, cursor]);
  return {
    data,
    error,
    more: data.next_cursor ? () => setCursor(data.next_cursor) : undefined,
  };
}
const show = (value: any, key: string) =>
  typeof value === "number" &&
  /^(starts_at|ends_at|arrived_at|left_at)$/.test(key)
    ? new Date(value).toLocaleString("pt-BR")
    : String(value ?? "—");
export function Records({
  api,
  path,
  revision = 0,
  columns,
  choose,
}: {
  api: Api;
  path: string;
  revision?: number;
  columns: [string, string][];
  choose?: (row: Row) => void;
}) {
  const [cursor, setCursor] = useState("");
  useEffect(() => setCursor(""), [path, revision]);
  const { data, error } = useData(
    api,
    `${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`,
    revision,
  );
  return (
    <>
      <p role="alert">{error}</p>
      <div className="cond-table">
        <table>
          <thead>
            <tr>
              {columns.map(([key, label]) => (
                <th key={key}>{label}</th>
              ))}
              {choose && <th>Ação</th>}
            </tr>
          </thead>
          <tbody>
            {(data.data || []).map((row: Row, i: number) => (
              <tr key={row.id || i}>
                {columns.map(([key]) => (
                  <td key={key}>{show(row[key], key)}</td>
                ))}
                {choose && (
                  <td>
                    <button onClick={() => choose(row)}>Abrir</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.data?.length === 0 && <p>Nenhum registro.</p>}
      <div className="toolbar">
        <button disabled={!cursor} onClick={() => setCursor("")}>
          Início
        </button>
        <button
          disabled={!data.next_cursor}
          onClick={() => setCursor(data.next_cursor)}
        >
          Próxima página
        </button>
      </div>
    </>
  );
}
export const choices = (
  rows: Row[] = [],
  label: (row: Row) => string = (r) => r.name,
) => rows.map((r) => ({ value: r.id, label: label(r) }));
export function WorkForm({
  api,
  root,
  customer,
  unitId,
  contacts,
  moreContacts,
  onDone,
}: {
  api: Api;
  root: string;
  customer?: boolean;
  unitId?: string;
  contacts?: Row[];
  moreContacts?: () => void;
  onDone: () => void;
}) {
  const { data, error } = useData(api, `${root}/work-types`);
  const [kind, setKind] = useState("");
  const type = data.data?.find((r: Row) => r.kind === kind);
  const fields: Field[] = [
    ...(!customer
      ? [
          {
            key: "contact",
            label: "Morador e unidade",
            options: choices(
              contacts,
              (r) => `${r.name} · ${r.block} ${r.unit}`,
            ),
            more: moreContacts,
          },
        ]
      : []),
    { key: "item", label: "Assunto (sem dados reservados)" },
    { key: "problem", label: "Descrição pública", type: "textarea" },
    ...(type?.fields || []).map((f: Row): Field => ({
      key: `extra_${f.id}`,
      label: f.label,
      required: f.required,
      type:
        f.kind === "boolean"
          ? undefined
          : ["integer", "decimal"].includes(f.kind)
            ? "number"
            : f.kind === "date"
              ? "date"
              : "text",
      options:
        f.kind === "boolean"
          ? [
              { value: "true", label: "Sim" },
              { value: "false", label: "Não" },
            ]
          : f.options?.map((o: Row) => ({ value: o.id, label: o.label })),
    })),
  ];
  return (
    <section>
      <h3>Abrir trabalho</h3>
      <p role="alert">{error}</p>
      <label>
        Tipo{" "}
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">Selecione</option>
          {data.data?.map((t: Row) => (
            <option key={t.kind} value={t.kind}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      {type && (
        <Form
          key={kind}
          fields={fields}
          onDone={onDone}
          label="Abrir trabalho"
          submit={(d, key) => {
            const extra: Row = {};
            for (const f of type.fields)
              if (d[`extra_${f.id}`] !== undefined)
                extra[f.id] =
                  f.kind === "boolean"
                    ? d[`extra_${f.id}`] === "true"
                    : d[`extra_${f.id}`];
            const c = contacts?.find((c) => c.id === d.contact);
            return api(
              `${root}/works`,
              "POST",
              {
                kind,
                item: d.item,
                problem: d.problem,
                extra,
                unit_id: customer ? unitId : c?.unit_id,
                person_id: c?.person_id,
              },
              undefined,
              key,
            );
          }}
        />
      )}
    </section>
  );
}
