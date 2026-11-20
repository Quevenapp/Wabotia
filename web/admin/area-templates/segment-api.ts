// Chamadas do "Qual é o seu negócio?": estado da escolha, pular/dispensar,
// prévia e aplicação do modelo do ramo, desfazer e trocar de ramo.
import { createIntents, type Api } from "../../lib/api";
import type { AreaTemplate, AreaTemplateApplyResult, AreaTemplatePreview, AreaTemplateSelection } from "../../modules/os/work-contracts";
import type { SegmentState, UndoPreview, UndoReport } from "../../../src/area-templates/footprint";

export type { SegmentState, UndoPreview, UndoReport };

/** Mensagem de erro em linguagem de dono: diz o que houve e o que fazer. */
export function segmentError(error: unknown): string {
  const e = error as { code?: string; message?: string; status?: number } | null;
  if (e?.code === "preview_stale") return "A configuração mudou enquanto você olhava a prévia. Abra a prévia de novo e confira antes de continuar.";
  if (e?.code === "template_not_applied") return "Este modelo já não está aplicado nesta área. Atualize a página para ver o que está valendo agora.";
  if (e?.code === "dependency_conflict") return e.message || "Um módulo depende de outro que ficaria desligado. Confira em Gestão → Módulos.";
  if (e?.status === 403 || e?.code === "forbidden") return "Só um administrador pode montar o sistema pelo ramo. Peça a quem administra a conta.";
  if (e?.status === 0 || e?.code === "network") return "Sem conexão com o servidor. Confira a internet e tente de novo.";
  return e?.message || "Algo deu errado ao falar com o servidor. Tente de novo em instantes.";
}

export function createSegmentApi(api: Api, root: string) {
  const write = createIntents(api);
  const base = root + "/area-templates";
  return {
    state: () => api(base + "/segment/state") as Promise<SegmentState>,
    choose: (action: "skip" | "other" | "dismiss", segment_id?: string) =>
      write(base + "/segment/choice", "POST", segment_id ? { action, segment_id } : { action }) as Promise<SegmentState>,
    template: (id: string) => api(base + "/" + encodeURIComponent(id)) as Promise<AreaTemplate>,
    preview: (template_id: string, selection: AreaTemplateSelection) =>
      write(base + "/preview", "POST", { template_id, selection }) as Promise<AreaTemplatePreview>,
    apply: (template_id: string, selection: AreaTemplateSelection, preview_hash: string) =>
      write(base + "/apply", "POST", { template_id, selection, preview_hash }) as Promise<AreaTemplateApplyResult>,
    undoPreview: (template_id: string) => write(base + "/undo/preview", "POST", { template_id }) as Promise<UndoPreview>,
    undo: (template_id: string, preview_hash: string) =>
      write(base + "/undo", "POST", { template_id, preview_hash }) as Promise<UndoReport & { settings_revision: string }>,
  };
}
export type SegmentApi = ReturnType<typeof createSegmentApi>;
