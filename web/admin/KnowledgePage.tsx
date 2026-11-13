// Conhecimento: fontes que fundamentam as respostas dos bots.
import React, { useRef, useState } from "react";
import { BookOpen, Plus } from "lucide-react";
import { useApp } from "../app/AppContext";
import { useAction } from "../app/hooks";
import type { Row } from "../lib/api";
import { Button, Empty, Field, Notice, SkeletonBlock, Table, toast } from "../ui";
import { FormDialog, Pager, useList } from "./shared";

const kindNames: Row = {
  text: "Texto",
  url: "Página da internet",
  file: "Documento",
  youtube: "Vídeo com transcrição",
};

function KnowledgeDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const app = useApp();
  const [form, setForm] = useState<Row>({ kind: "text" });
  const file = useRef<HTMLInputElement>(null);
  const change = (key: string) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));
  return (
    <FormDialog
      title="Adicionar conhecimento"
      onClose={onClose}
      onSubmit={async () => {
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
      {form.kind === "text" ? (
        <Field
          label="Conteúdo"
          type="textarea"
          value={form.text}
          onChange={change("text")}
        />
      ) : form.kind === "file" ? (
        <label className="field">
          <span>Documento</span>
          <input ref={file} type="file" accept=".pdf,.docx,.txt,.md,.srt,.vtt" />
          <small>PDF, DOCX, TXT, MD, VTT ou SRT · até 20 MB</small>
        </label>
      ) : (
        <Field label="URL pública" value={form.url} onChange={change("url")} />
      )}
    </FormDialog>
  );
}

export function KnowledgePage() {
  const app = useApp();
  const list = useList(app.root + "/knowledge");
  const { busy, run } = useAction();
  const [adding, setAdding] = useState(false);
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
              ["error", "Observação"],
            ]}
            action={(row) => (
              <button
                type="button"
                className="text-link"
                disabled={busy}
                onClick={() =>
                  run(
                    () => app.api(app.root + "/knowledge/" + row.id, "DELETE"),
                    { success: "Salvo com sucesso." },
                  ).then(list.reload)
                }
              >
                Remover
              </button>
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
        <KnowledgeDialog onClose={() => setAdding(false)} onSaved={list.reload} />
      )}
    </>
  );
}
