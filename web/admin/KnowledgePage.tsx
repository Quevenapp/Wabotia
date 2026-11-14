// Conhecimento: fontes que fundamentam as respostas dos bots.
import React, { useEffect, useRef, useState } from "react";
import { BookOpen, Plus } from "lucide-react";
import { useApp } from "../app/AppContext";
import { useAction } from "../app/hooks";
import type { Row } from "../lib/api";
import {
  Button,
  Empty,
  Field,
  Notice,
  SkeletonBlock,
  Table,
  toast,
} from "../ui";
import { FormDialog, Pager, useList } from "./shared";

const kindNames: Row = {
  text: "Texto",
  url: "Página da internet",
  file: "Documento",
  youtube: "Vídeo com transcrição",
};

const usageHelp =
  "Opcional. Diga ao bot quando e como usar esta fonte, por exemplo: “Use só para clientes do plano empresarial” ou “Não informe valores; ofereça abrir um protocolo”.";

/** Nova fonte, ou edição de uma existente (`initial` com o texto completo). */
function KnowledgeDialog({
  initial,
  onClose,
  onSaved,
}: {
  initial?: Row;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const app = useApp();
  const editing = !!initial?.id;
  const [form, setForm] = useState<Row>(initial || { kind: "text" });
  const file = useRef<HTMLInputElement>(null);
  const change = (key: string) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));
  return (
    <FormDialog
      title={editing ? "Editar fonte" : "Adicionar conhecimento"}
      onClose={onClose}
      onSubmit={async () => {
        if (editing) {
          await app.api(app.root + "/knowledge/" + initial!.id, "PATCH", {
            title: form.title,
            usage: form.usage || "",
            ...(form.kind === "text" ? { text: form.text || "" } : {}),
            ...(["url", "youtube"].includes(form.kind)
              ? { url: form.url }
              : {}),
          });
        } else {
          let mediaId;
          const chosen = file.current?.files?.[0];
          if (chosen) {
            const data = new FormData();
            data.set("file", chosen);
            mediaId = (await app.api(app.root + "/media", "POST", data)).id;
          }
          await app.api(app.root + "/knowledge", "POST", {
            ...form,
            kind: chosen ? "file" : form.kind || "text",
            media_id: mediaId,
          });
        }
        toast("Salvo com sucesso.");
        await onSaved();
        onClose();
      }}
    >
      <Field
        label="Título da fonte"
        value={form.title}
        onChange={change("title")}
        required
      />
      {editing ? (
        <p>Tipo de fonte: {kindNames[form.kind] || form.kind}</p>
      ) : (
        <Field
          label="Tipo de fonte"
          value={form.kind}
          onChange={change("kind")}
          emptyOption={null}
          options={[
            ["text", "Texto"],
            ["url", "Página da internet"],
            ["file", "Documento"],
            ["youtube", "Vídeo com transcrição"],
          ]}
        />
      )}
      {form.kind === "text" ? (
        <Field
          label="Conteúdo"
          type="textarea"
          rows={12}
          value={form.text}
          onChange={change("text")}
        />
      ) : form.kind === "file" ? (
        editing ? (
          <p>
            Para trocar o documento, remova esta fonte e adicione o arquivo
            novo.
          </p>
        ) : (
          <label className="field">
            <span>Documento</span>
            <input
              ref={file}
              type="file"
              accept=".pdf,.docx,.txt,.md,.srt,.vtt"
            />
            <small>PDF, DOCX, TXT, MD, VTT ou SRT · até 20 MB</small>
          </label>
        )
      ) : (
        <Field
          label="URL pública"
          value={form.url}
          onChange={change("url")}
          help={
            editing
              ? "Trocar o endereço importa a página de novo em alguns minutos."
              : undefined
          }
        />
      )}
      <Field
        label="Quando e como o bot pode usar"
        type="textarea"
        rows={3}
        maxLength={2000}
        value={form.usage}
        onChange={change("usage")}
        help={usageHelp}
      />
    </FormDialog>
  );
}

export function KnowledgePage() {
  const app = useApp();
  const list = useList(app.root + "/knowledge");
  const { busy, run } = useAction();
  const [adding, setAdding] = useState(false),
    [editing, setEditing] = useState<Row | null>(null),
    [loadingId, setLoadingId] = useState("");
  useEffect(() => {
    if (!loadingId) return;
    let alive = true;
    app
      .api(app.root + "/knowledge/" + loadingId)
      .then((doc: Row) => alive && setEditing(doc))
      .catch((e: any) => toast(e.message))
      .finally(() => alive && setLoadingId(""));
    return () => {
      alive = false;
    };
  }, [loadingId]);
  return (
    <>
      <div className="toolbar">
        <p>Informações confiáveis para fundamentar as respostas.</p>
        <Button onClick={() => setAdding(true)} icon={<Plus size={17} />}>
          Adicionar fonte
        </Button>
      </div>
      {list.error && (
        <Notice tone="error" onRetry={() => void list.reload()}>
          {list.error}
        </Notice>
      )}
      <section className="card">
        {!list.loaded && !list.error ? (
          <SkeletonBlock height={160} />
        ) : (
          <Table
            rows={list.rows}
            columns={[
              ["title", "Fonte"],
              ["kind", "Tipo", (row) => kindNames[row.kind] || row.kind || "—"],
              ["status", "Estado"],
              ["usage", "Quando usar", (row) => row.usage || row.error || "—"],
            ]}
            action={(row) => (
              <div className="card-actions">
                <button
                  type="button"
                  className="text-link"
                  disabled={busy || !!loadingId || app.demo}
                  onClick={() => setLoadingId(row.id)}
                >
                  Editar
                </button>
                <button
                  type="button"
                  className="text-link"
                  disabled={busy}
                  onClick={() =>
                    run(
                      () =>
                        app.api(app.root + "/knowledge/" + row.id, "DELETE"),
                      { success: "Salvo com sucesso." },
                    ).then(list.reload)
                  }
                >
                  Remover
                </button>
              </div>
            )}
            empty={
              <Empty
                icon={<BookOpen size={28} />}
                title="Conhecimento que ajuda de verdade"
                description="Cadastre textos, páginas ou documentos para sua equipe de bots consultar."
              />
            }
          />
        )}
      </section>
      <Pager {...list} />
      {adding && (
        <KnowledgeDialog
          onClose={() => setAdding(false)}
          onSaved={list.reload}
        />
      )}
      {editing && (
        <KnowledgeDialog
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={list.reload}
        />
      )}
    </>
  );
}
