// Textos dos relatórios e etiquetas: erp_preferences.report_clean.
import { PG_CNTRL, pgBtrim, pgLeft } from "../../engine/text.ts";

const CNTRL_ALL = new RegExp(PG_CNTRL, "gu");

/** report_clean(p, max): controles viram espaço, corta em max, apara; vazio vira nulo. */
export function reportClean(p: string | null, max: number): string | null {
  const v = pgBtrim(pgLeft((p ?? "").replace(CNTRL_ALL, " "), max));
  return v === "" ? null : v;
}
