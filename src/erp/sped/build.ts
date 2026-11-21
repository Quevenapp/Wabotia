// Monta o arquivo do tipo pedido, confere linha a linha contra o layout e
// devolve o texto (CR LF) com o resumo, os avisos e as pendências. Pendência
// que impede o arquivo ou falha da conferência: não há texto.
// Só sintaxe TypeScript apagável: os testes do Node importam este arquivo.
import { SPED_KIND_LABELS, type SpedProblem } from "./contract.ts";
import { buildEfdContribuicoes } from "./efd-contribuicoes.ts";
import { buildEfdIcmsIpi } from "./efd-icms-ipi.ts";
import { onlyDigits } from "./format.ts";
import { BLOCK_ORDER, EFD_CONTRIBUICOES_LAYOUT, EFD_ICMS_IPI_LAYOUT } from "./layout.ts";
import type { SpedInput } from "./model.ts";
import { buildSintegra } from "./sintegra.ts";
import { validateSintegra, validateSped } from "./validate.ts";

export interface BuiltFile {
  /** null: não saiu (pendência que impede ou conferência que falhou). */
  text: string | null;
  lines: number;
  summary: Record<string, number | string>;
  warnings: string[];
  problems: SpedProblem[];
  /** O que a conferência do layout achou (vazio: confere). */
  validation: string[];
}

export function buildSpedFile(input: SpedInput): BuiltFile {
  const built = input.kind === "efd_icms_ipi" ? buildEfdIcmsIpi(input) : input.kind === "efd_contribuicoes" ? buildEfdContribuicoes(input) : buildSintegra(input);
  const validation = input.kind === "sintegra" ? validateSintegra(built.lines)
    : validateSped(built.lines, input.kind === "efd_icms_ipi" ? EFD_ICMS_IPI_LAYOUT : EFD_CONTRIBUICOES_LAYOUT, BLOCK_ORDER[input.kind]);
  const blocked = built.problems.some((p) => p.blocking) || validation.length > 0;
  return {
    text: blocked ? null : built.lines.join("\r\n") + "\r\n",
    lines: built.lines.length, summary: built.summary, warnings: built.warnings, problems: built.problems, validation,
  };
}

/** Nome do arquivo: tipo, CNPJ e mês (ou o período do SINTEGRA). */
export function spedFilename(kind: SpedInput["kind"], cnpj: string, from: string, to: string): string {
  const doc = onlyDigits(cnpj) || "empresa";
  const month = `${from.slice(0, 4)}${from.slice(5, 7)}`;
  if (kind === "efd_icms_ipi") return `SPED-EFD-ICMS-IPI_${doc}_${month}.txt`;
  if (kind === "efd_contribuicoes") return `EFD-CONTRIBUICOES_${doc}_${month}.txt`;
  return `SINTEGRA_${doc}_${from.replace(/-/g, "")}_${to.replace(/-/g, "")}.txt`;
}
export { SPED_KIND_LABELS };
