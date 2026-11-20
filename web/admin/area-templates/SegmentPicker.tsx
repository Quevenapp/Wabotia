import React, { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, Search, Undo2 } from "lucide-react";
import { useApp } from "../../app/AppContext";
import { Button, Notice, Spinner } from "../../ui";
import { linkProps, navigate } from "../../lib/routes";
import type { AreaTemplate, AreaTemplateApplyResult, AreaTemplatePreview } from "../../modules/os/work-contracts";
import { SEGMENT_GROUPS, searchSegments, segmentOfTemplate, type Segment } from "../../../src/area-templates/segments";
import { ownerSummary, spoken } from "../../../src/area-templates/owner-summary";
import { createSegmentApi, segmentError, type SegmentState, type UndoPreview, type UndoReport } from "./segment-api";
import { templateSelection } from "./selection";
import "./segment.css";

type View =
  | { kind: "choose" }
  | { kind: "loading"; label: string }
  | { kind: "preview"; segment: Segment; template: AreaTemplate; preview: AreaTemplatePreview; leaving: UndoPreview | null }
  | { kind: "applied"; segment: Segment; result: AreaTemplateApplyResult; left: UndoReport | null }
  | { kind: "undo"; preview: UndoPreview }
  | { kind: "undone"; report: UndoReport }
  | { kind: "other" };

/** Ramo que vale agora: o último modelo aplicado e não desfeito. */
export const currentApplied = (state: SegmentState | null) => state?.applied.find((entry) => entry.status === "applied") ?? null;

function Kept({ report }: { report: UndoReport }) {
  return (
    <>
      {(report.modules_off.length > 0 || report.removed.length > 0) && (
        <div className="segment-block">
          <h4>Sai</h4>
          <ul>
            {report.modules_off.length > 0 && <li>Desligar: {spoken(report.modules_off)}</li>}
            {report.removed.map((label) => <li key={label}>{label}</li>)}
          </ul>
        </div>
      )}
      {report.kept.length > 0 && (
        <div className="segment-block">
          <h4>Fica</h4>
          <ul>
            {report.kept.map((entry, index) => <li key={index}><strong>{entry.label}</strong> {entry.reason}</li>)}
          </ul>
        </div>
      )}
      {!report.modules_off.length && !report.removed.length && !report.kept.length && <p>Nada do que este modelo criou continua na área.</p>}
    </>
  );
}

export function SegmentPicker({ onDone, onSkip, heading = true }: {
  /** Depois de aplicar, "Outro" ou desfazer: segue a configuração guiada. */
  onDone?: () => void;
  /** Depois de "Pular por enquanto". */
  onSkip?: () => void;
  heading?: boolean;
}) {
  const app = useApp();
  const api = useMemo(() => createSegmentApi(app.api, app.root), [app.api, app.root]);
  const [state, setState] = useState<SegmentState | null>(null);
  const [view, setView] = useState<View>({ kind: "choose" });
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const current = currentApplied(state);
  const currentSegment = current ? segmentOfTemplate(current.template_id) : null;

  const reload = () => api.state().then(setState).catch(() => setState(null));
  useEffect(() => { void reload(); }, [api]);

  async function run(task: () => Promise<void>) {
    setBusy(true); setError("");
    try { await task(); }
    catch (failure) { setError(segmentError(failure)); }
    finally { setBusy(false); }
  }
  const open = (segment: Segment) => run(async () => {
    if (!segment.template_id) { setView({ kind: "other" }); return; }
    setView({ kind: "loading", label: `Preparando a prévia de ${segment.label}…` });
    try {
      const template = await api.template(segment.template_id);
      const switching = current && current.template_id !== template.id ? current : null;
      const [preview, leaving] = await Promise.all([
        api.preview(template.id, templateSelection(template)),
        switching ? api.undoPreview(switching.template_id) : Promise.resolve(null),
      ]);
      setView({ kind: "preview", segment, template, preview, leaving });
    } catch (failure) { setView({ kind: "choose" }); throw failure; }
  });
  const apply = (view: Extract<View, { kind: "preview" }>) => run(async () => {
    let left: UndoReport | null = null;
    let preview = view.preview;
    if (view.leaving && current) {
      // Trocar de ramo: desfaz o atual e refaz a prévia do novo sobre o resultado.
      left = await api.undo(current.template_id, view.leaving.preview_hash);
      preview = await api.preview(view.template.id, templateSelection(view.template));
      if (!preview.can_apply) { await reload(); setView({ ...view, preview, leaving: null }); return; }
    }
    const result = await api.apply(view.template.id, templateSelection(view.template), preview.preview_hash);
    await app.refresh().catch(() => {});
    await reload();
    setView({ kind: "applied", segment: view.segment, result, left });
  });
  const skip = () => run(async () => {
    setState(await api.choose("skip"));
    onSkip?.();
  });
  const startUndo = () => current && run(async () => {
    setView({ kind: "loading", label: "Conferindo o que pode sair…" });
    try { setView({ kind: "undo", preview: await api.undoPreview(current.template_id) }); }
    catch (failure) { setView({ kind: "choose" }); throw failure; }
  });
  const confirmUndo = (preview: UndoPreview) => run(async () => {
    const report = await api.undo(preview.template_id, preview.preview_hash);
    await app.refresh().catch(() => {});
    await reload();
    setView({ kind: "undone", report });
  });

  const back = <Button secondary disabled={busy} onClick={() => { setError(""); setView({ kind: "choose" }); }}><ArrowLeft size={16} /> Escolher outro ramo</Button>;
  const results = searchSegments(query);

  return (
    <section className="segment-picker" aria-labelledby="segment-title">
      {heading && (
        <header>
          <h2 id="segment-title">Qual é o seu negócio?</h2>
          <p>Escolha o ramo mais parecido com o seu. O sistema liga os módulos certos e cria os cadastros iniciais. Você pode mudar tudo depois.</p>
        </header>
      )}
      {error && <Notice tone="error" onClose={() => setError("")}>{error}</Notice>}

      {view.kind === "loading" && <Spinner label={view.label} />}

      {view.kind === "choose" && (
        <>
          {current && (
            <div className="segment-current">
              <span>Seu ramo hoje: <strong>{currentSegment?.label ?? current.name}</strong>. Escolher outro ramo troca o modelo (você vê antes o que sai e o que entra).</span>
              <Button secondary size="sm" disabled={busy} onClick={startUndo}><Undo2 size={15} /> Desfazer este modelo</Button>
            </div>
          )}
          <label className="segment-search">
            <Search size={16} aria-hidden />
            <input type="search" value={query} placeholder="Busque por palavra: advogado, oficina, pet, loja…" aria-label="Buscar ramo por palavra" onChange={(event) => setQuery(event.target.value)} />
          </label>
          {SEGMENT_GROUPS.map((group) => {
            const items = results.filter((segment) => segment.group === group.id);
            if (!items.length) return null;
            return (
              <div className="segment-group" key={group.id}>
                <h3>{group.label}</h3>
                <div className="segment-cards">
                  {items.map((segment) => (
                    <button type="button" key={segment.id} className={"segment-card" + (current && segment.template_id === current.template_id ? " segment-card-current" : "")} disabled={busy} onClick={() => void open(segment)}>
                      <strong>{segment.label}</strong>
                      <span>{segment.hint}</span>
                      {current && segment.template_id === current.template_id && <small><Check size={13} /> Seu ramo hoje</small>}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
          {!results.length && <p className="segment-empty">Nenhum ramo com "{query}". Tente outra palavra ou escolha <strong>Outro tipo de negócio</strong>.</p>}
          {!current && (
            <div className="segment-skip">
              <Button variant="ghost" disabled={busy} onClick={skip}>Pular por enquanto</Button>
              <small>Você pode escolher depois em Gestão → Sistema → Modelos de área.</small>
            </div>
          )}
        </>
      )}

      {view.kind === "preview" && (() => {
        const summary = ownerSummary(view.template, view.preview.changes);
        const alreadyApplied = current?.template_id === view.template.id;
        return (
          <div className="segment-preview">
            <h3>{view.segment.label}</h3>
            {view.leaving && (
              <div className="segment-switch">
                <h4>Trocar de ramo: o que sai de "{currentSegment?.label ?? current?.name}"</h4>
                <Kept report={view.leaving} />
              </div>
            )}
            {view.leaving && <h4>O que entra com "{view.segment.label}"</h4>}
            {summary.turn_on.length > 0 && <p><strong>Vamos ligar:</strong> {spoken(summary.turn_on)}.</p>}
            {summary.already_on.length > 0 && <p><strong>Já está ligado:</strong> {spoken(summary.already_on)}.</p>}
            {summary.create.length > 0 && <p><strong>Vamos criar:</strong> {spoken(summary.create)}.</p>}
            {!summary.turn_on.length && !summary.create.length && <p>{alreadyApplied ? "Este ramo já está montado. Não há nada novo para criar." : "Não há nada novo para criar: o que este ramo traz já existe aqui."}</p>}
            <p><strong>Não vamos mexer em:</strong> {spoken(summary.untouched)}.</p>
            <p className="segment-note">Os exemplos vêm com "(exemplo)" no nome: é só editar ou apagar. Você pode mudar tudo depois.</p>
            {view.preview.conflicts.length > 0 && (
              <Notice tone="warn">
                Este ramo não pode ser montado do jeito que a área está agora:
                <ul>{view.preview.conflicts.map((conflict, index) => <li key={index}>{conflict.message}</li>)}</ul>
                Abra a revisão detalhada abaixo, em "Todos os modelos", para escolher item por item.
              </Notice>
            )}
            <div className="segment-actions">
              {back}
              <Button disabled={busy || !view.preview.can_apply} busy={busy} onClick={() => void apply(view)}>
                {view.leaving ? `Trocar para ${view.segment.label}` : `Montar o sistema para ${view.segment.label}`}
              </Button>
            </div>
          </div>
        );
      })()}

      {view.kind === "applied" && (
        <div className="segment-preview">
          <Notice tone="ok">{view.result.applied ? `Pronto! O sistema foi montado para ${view.segment.label}.` : "Este ramo já estava montado. Nada foi alterado."}</Notice>
          {view.left && view.left.kept.length > 0 && (
            <div className="segment-switch">
              <h4>Do ramo anterior, ficou:</h4>
              <ul>{view.left.kept.map((entry, index) => <li key={index}><strong>{entry.label}</strong> {entry.reason}</li>)}</ul>
            </div>
          )}
          {view.result.manual_steps.length > 0 && (
            <>
              <h4>Próximos passos</h4>
              <ul>{view.result.manual_steps.map((step, index) => <li key={index}>{step}</li>)}</ul>
            </>
          )}
          <div className="segment-actions">
            <a className="button secondary" {...linkProps({ area: "admin", page: "modules" })}>Ver os módulos ligados</a>
            {onDone && <Button onClick={onDone}>Continuar a configuração</Button>}
          </div>
        </div>
      )}

      {view.kind === "undo" && (
        <div className="segment-preview">
          <h3>Desfazer "{currentSegment?.label ?? view.preview.template_name}"</h3>
          <p>Desligamos os módulos que só este modelo ligou e apagamos o que ele criou e ninguém alterou nem usou. O que foi alterado ou já está em uso fica.</p>
          <Kept report={view.preview} />
          <div className="segment-actions">
            {back}
            <Button variant="danger" disabled={busy} busy={busy} onClick={() => void confirmUndo(view.preview)}>Desfazer este modelo</Button>
          </div>
        </div>
      )}

      {view.kind === "undone" && (
        <div className="segment-preview">
          <Notice tone="ok">Modelo desfeito.</Notice>
          <Kept report={view.report} />
          <div className="segment-actions">{back}</div>
        </div>
      )}

      {view.kind === "other" && (
        <div className="segment-preview">
          <h3>Outro tipo de negócio</h3>
          <p>Sem problema. Você começa do zero e liga só o que usar em Gestão → Módulos (Agenda, Ordem de Serviço, Pedido, Mensalidade, Vendas e as outras partes).</p>
          <div className="segment-actions">
            {back}
            <Button disabled={busy} onClick={() => void run(async () => { setState(await api.choose("other")); onDone?.(); })}>Continuar sem modelo</Button>
            <a className="button secondary" {...linkProps({ area: "admin", page: "modules" })}>Abrir Módulos</a>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Primeiro acesso do administrador: sem ramo respondido e sem modelo
 * aplicado, abre a configuração guiada na pergunta do ramo (uma vez por sessão).
 */
export function SegmentFirstVisit() {
  const app = useApp();
  useEffect(() => {
    if (!app.isAdmin || !app.profile || app.demo) return;
    const key = "wabotia:segment-asked:" + app.root;
    try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, "1"); } catch { return; }
    let alive = true;
    createSegmentApi(app.api, app.root).state().then((state) => {
      if (!alive || !state.ask) return;
      try { sessionStorage.setItem("wabotia:setup-step:" + app.root, "0"); } catch { /* etapa opcional */ }
      navigate({ area: "admin", page: "setup" }, { replace: true });
    }).catch(() => {});
    return () => { alive = false; };
  }, [app.isAdmin, app.profile, app.demo, app.root]);
  return null;
}

/** Lembrete discreto para quem pulou a pergunta; some quando dispensado. */
export function SegmentReminder() {
  const app = useApp();
  const api = useMemo(() => createSegmentApi(app.api, app.root), [app.api, app.root]);
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!app.isAdmin || !app.profile || app.demo) return;
    let alive = true;
    api.state().then((state) => alive && setShow(state.remind)).catch(() => {});
    return () => { alive = false; };
  }, [api, app.isAdmin, app.profile, app.demo]);
  if (!show) return null;
  return (
    <div className="setup-return segment-reminder">
      <span>Você ainda não disse qual é o seu negócio. Com isso, o sistema se monta sozinho.</span>
      <a className="text-link" {...linkProps({ area: "admin", page: "area-templates" })}>Escolher o ramo</a>
      <button type="button" className="icon-button sm" aria-label="Dispensar lembrete do ramo" onClick={() => { setShow(false); void api.choose("dismiss").catch(() => {}); }}>×</button>
    </div>
  );
}
