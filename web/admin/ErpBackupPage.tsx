// Gestão → Sistema → Backup do ERP (só administrador, área com o ERP ligado).
// Fazer backup agora, acompanhar, listar os guardados (erp-backups/<área>/ no
// armazenamento de arquivos), restaurar um deles e apagar um antigo. As rotas
// ficam em /profiles/:profile/erp-backup (src/erp/api/backup-routes.ts);
// fazer, restaurar e apagar pedem o segundo fator quando a área exige.
import React, { useState } from "react";
import { DatabaseBackup, RotateCcw, Trash2 } from "lucide-react";
import { useApp } from "../app/AppContext";
import { useAction, usePolling } from "../app/hooks";
import type { Row } from "../lib/api";
import { Button, Confirm, Dialog, Field, Notice, Pill, SkeletonRows, Table } from "../ui";
import { useResource } from "./shared";

const sizeText = (bytes: unknown) => {
  const n = Number(bytes);
  if (bytes === null || bytes === undefined || !Number.isFinite(n)) return "—";
  const units = ["bytes", "KB", "MB", "GB"];
  let value = n, unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${value.toLocaleString("pt-BR", { maximumFractionDigits: unit ? 1 : 0 })} ${units[unit]}`;
};
const countText = (value: unknown) => value === null || value === undefined ? "—" : Number(value).toLocaleString("pt-BR");
const dateText = (value: unknown) => {
  const date = new Date(String(value ?? ""));
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
};
const minutes = (ms: unknown) => {
  const m = Math.round(Number(ms) / 60000);
  return m < 1 ? "menos de 1 minuto" : m === 1 ? "1 minuto" : `${m} minutos`;
};

const PHASES: Record<string, string> = {
  export: "Lendo o ERP e gravando as partes",
  publish: "Fechando o backup",
  stage: "Conferindo as partes do backup (o ERP ainda não mudou)",
  swap: "Trocando os dados do ERP",
  rollback: "Voltando o ERP ao estado de antes",
  cleanup: "Limpando o que sobrou",
  done: "Concluído",
  failed: "Não concluído",
};

const active = (job: Row | null | undefined) => !!job && !["done", "failed"].includes(job.phase);

function Progress({ job }: { job: Row }) {
  const restore = job.kind === "restore";
  const running = active(job);
  return (
    <div className="card" aria-live="polite">
      <div className="section-heading">
        <h2>{restore ? "Restauração do ERP" : "Backup do ERP"}</h2>
        {running ? <Pill tone="warn">Em andamento</Pill> : job.phase === "done" ? <Pill tone="ok">Concluído</Pill> : <Pill tone="danger">Não concluído</Pill>}
      </div>
      <p className="workspace-help">{PHASES[job.phase] ?? job.phase}</p>
      {running && (
        <>
          <progress max={100} value={Number(job.percent ?? 0)} style={{ width: "100%" }} aria-label="Progresso" />
          <p className="workspace-help">
            {Number(job.percent ?? 0).toLocaleString("pt-BR")}% · {countText(job.progress?.rows_done)} de {countText(job.progress?.rows_total)} linhas
          </p>
        </>
      )}
      {running && job.blocked && (
        <Notice tone="warn">
          O ERP desta área está parado enquanto os dados são trocados: ninguém consegue abrir nem lançar nada no ERP até terminar. Não feche o
          sistema da área; se algo der errado, o ERP volta sozinho ao estado de antes da restauração.
        </Notice>
      )}
      {running && !job.blocked && job.barrier?.active && (
        <Notice tone="info">
          As alterações do ERP desta área estão suspensas há {minutes(job.barrier.held_ms)} (as consultas continuam). Voltam sozinhas no fim.
        </Notice>
      )}
      {job.phase === "done" && !restore && (
        <Notice tone="ok">
          Backup guardado: {countText(job.result?.rows)} linhas, {sizeText(job.result?.bytes)} no armazenamento. As alterações ficaram suspensas por {minutes(job.barrier?.held_ms)}.
        </Notice>
      )}
      {job.phase === "done" && restore && (
        <Notice tone="ok">
          ERP restaurado: {countText(job.result?.rows)} linhas. A coleta do Bling ficou desligada e a conexão com o Bling precisa ser refeita.
        </Notice>
      )}
      {job.result?.warning && <Notice tone="warn">{job.result.warning}</Notice>}
      {job.phase === "failed" && (
        <Notice tone="error">
          {job.error?.message || "O trabalho parou sem dizer o motivo."} {restore ? "O ERP da área continua como estava antes da restauração." : "Nenhum backup novo foi guardado; tente de novo."}
        </Notice>
      )}
    </div>
  );
}

export function ErpBackupPage() {
  const app = useApp();
  const list = useResource(app.root + "/erp-backup");
  const { busy, run } = useAction();
  const [job, setJob] = useState<Row | null | undefined>(undefined);
  const [askBackup, setAskBackup] = useState(false);
  const [restoring, setRestoring] = useState<Row | null>(null);
  const [typed, setTyped] = useState("");
  const [removing, setRemoving] = useState<Row | null>(null);
  const current = job === undefined ? list.data?.job ?? null : job;
  // Com trabalho em andamento, o progresso é relido a cada 3 s.
  usePolling(() => {
    if (!active(current)) return;
    app.api(app.root + "/erp-backup/progresso").then((data: Row) => {
      setJob(data.job ?? null);
      if (!active(data.job)) void list.reload();
    }).catch(() => {});
  }, 3000, [current?.id, current?.phase, app.root]);

  const start = () => run(async () => {
    const data = await app.api(app.root + "/erp-backup", "POST", {});
    setJob(data.job ?? null);
    setAskBackup(false);
    await list.reload();
  }, { success: "Backup iniciado." });
  const restore = () => run(async () => {
    const data = await app.api(app.root + "/erp-backup/restaurar", "POST", { prefix: restoring!.prefix, confirmacao: typed });
    setJob(data.job ?? null);
    setRestoring(null);
    setTyped("");
  }, { success: "Restauração iniciada." });
  const remove = () => run(async () => {
    await app.api(app.root + "/erp-backup/apagar", "POST", { prefix: removing!.prefix, confirmado: true });
    setRemoving(null);
    await list.reload();
  }, { success: "Backup apagado." });

  if (!list.data)
    return list.error ? (
      <Notice tone="error" onRetry={() => void list.reload()}>{list.error}</Notice>
    ) : (
      <div className="card"><SkeletonRows rows={3} avatar={false} /></div>
    );
  const backups: Row[] = list.data.backups ?? [];
  const working = active(current);
  const matches = typed.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("pt-BR")
    === app.profileName.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("pt-BR");
  return (
    <>
      <div className="card">
        <div className="section-heading">
          <span className="integration-icon"><DatabaseBackup /></span>
        </div>
        <h2>Fazer backup agora</h2>
        <p className="workspace-help">
          Guarda uma cópia do ERP desta área ({app.profileName}) no armazenamento de arquivos: cadastros, vendas, estoque, financeiro e
          configurações. Os XML das notas e os anexos já ficam guardados à parte e não entram nesta cópia.
        </p>
        <Notice tone="warn">
          Enquanto o backup lê o ERP, as alterações do ERP desta área ficam suspensas; as consultas continuam. Leva cerca de 5 minutos por
          GiB de dados. Prefira um horário de pouco movimento.
        </Notice>
        <Button icon={<DatabaseBackup size={17} />} onClick={() => setAskBackup(true)} disabled={working}>
          Fazer backup agora
        </Button>
      </div>
      {current && <Progress job={current} />}
      <div className="card">
        <h2>Backups guardados</h2>
        <Table
          rows={backups.map(item => ({ ...item, id: item.prefix }))}
          columns={[
            ["created_at", "Data", row => dateText(row.created_at)],
            ["text_bytes", "Tamanho dos dados", row => sizeText(row.text_bytes)],
            ["bytes", "Guardado", row => sizeText(row.bytes)],
            ["rows", "Linhas", row => countText(row.rows)],
          ]}
          action={row => (
            <>
              <Button secondary size="sm" icon={<RotateCcw size={15} />} disabled={working} onClick={() => { setTyped(""); setRestoring(row); }}>
                Restaurar
              </Button>{" "}
              <Button variant="danger" size="sm" icon={<Trash2 size={15} />} disabled={working && current?.prefix === row.prefix} onClick={() => setRemoving(row)}>
                Apagar
              </Button>
            </>
          )}
          empty={<p className="workspace-help">Nenhum backup do ERP guardado nesta área ainda.</p>}
        />
      </div>
      {askBackup && (
        <Confirm title="Fazer backup do ERP agora?" confirmLabel="Fazer backup" busy={!!busy} onConfirm={() => void start()} onClose={() => setAskBackup(false)}>
          <p>Durante o backup ninguém consegue lançar nem alterar nada no ERP desta área (cerca de 5 minutos por GiB de dados). As consultas continuam.</p>
        </Confirm>
      )}
      {restoring && (
        <Dialog
          title="Restaurar este backup?"
          subtitle={`Backup de ${dateText(restoring.created_at)}`}
          onClose={() => setRestoring(null)}
          footer={
            <>
              <Button secondary onClick={() => setRestoring(null)} disabled={!!busy}>Cancelar</Button>
              <Button variant="danger" disabled={!matches} busy={!!busy} onClick={() => void restore()}>Restaurar o ERP</Button>
            </>
          }
        >
          <Notice tone="error">
            O ERP desta área volta a ficar exatamente como estava em {dateText(restoring.created_at)}. Tudo o que foi lançado depois disso
            (vendas, notas, baixas, cadastros, estoque) se perde e não volta.
          </Notice>
          <ul className="workspace-help">
            <li>Durante a restauração o ERP desta área fica parado: ninguém consegue abrir nem lançar nada até terminar.</li>
            <li>Os XML das notas e os anexos não fazem parte do backup: continuam como estão hoje.</li>
            <li>A coleta do Bling fica desligada e a conexão com o Bling precisa ser refeita depois.</li>
            <li>Se algo der errado no meio, o ERP volta sozinho ao estado de antes da restauração.</li>
          </ul>
          <Field
            label={`Para confirmar, digite o nome da área: ${app.profileName}`}
            value={typed}
            onChange={setTyped}
            maxLength={200}
          />
        </Dialog>
      )}
      {removing && (
        <Confirm title="Apagar este backup?" confirmLabel="Apagar backup" danger busy={!!busy} onConfirm={() => void remove()} onClose={() => setRemoving(null)}>
          <p>O backup de {dateText(removing.created_at)} ({sizeText(removing.bytes)}) será apagado do armazenamento e não poderá mais ser restaurado. O ERP não muda.</p>
        </Confirm>
      )}
    </>
  );
}
