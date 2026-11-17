// Rótulos e cores das situações-base (sem dependência de outros domínios, para
// sair pelo public.ts sem ciclo de carga). Portado de
// erp_preferences.situation_base_label e situation_base_color.
import { pgLeft } from "../../engine/text.ts";

const LABELS: Record<string, Record<string, string>> = {
  sales_orders: {
    draft: "Em digitação", open: "Em aberto", verified: "Verificado", in_progress: "Em andamento", agency_sale: "Venda Agenciada",
    partially_fulfilled: "Atendido parcialmente", partially_invoiced: "Faturado parcialmente", fulfilled: "Atendido", cancelled: "Cancelado",
  },
  purchase_orders: { open: "Em aberto", in_progress: "Em andamento", partially_fulfilled: "Atendido parcialmente", fulfilled: "Atendido", cancelled: "Cancelado" },
  service_orders: {
    open: "Em aberto", quoted: "Orçada", approved: "Aprovada", rejected: "Não aprovada", in_progress: "Em andamento", waiting_parts: "Aguardando componentes",
    service_done: "Serviço concluído", finalized: "Finalizada", no_repair: "Finalizada sem conserto", cancelled: "Cancelado",
  },
};
const COLORS: Record<string, string> = {
  draft: "#9e9e9e", open: "#e6a700", quoted: "#8d6e63", approved: "#43a047", rejected: "#e53935", verified: "#7e57c2", in_progress: "#1e88e5",
  agency_sale: "#ff7835", waiting_parts: "#fb8c00", partially_fulfilled: "#26a69a", partially_invoiced: "#b83147", service_done: "#00897b",
  fulfilled: "#2e7d32", finalized: "#2e7d32", no_repair: "#6d4c41", cancelled: "#d32f2f",
};

/** initcap do Postgres: maiúscula no início de cada palavra (letras e dígitos), o resto minúsculo. */
function initcap(s: string) {
  let out = "";
  let start = true;
  for (const ch of s) {
    const alnum = /[\p{L}\p{N}]/u.test(ch);
    out += alnum ? (start ? ch.toUpperCase() : ch.toLowerCase()) : ch;
    start = !alnum;
  }
  return out;
}

/** erp_preferences.situation_base_label(p_kind, p_status) */
export const situationBaseLabel = (kind: string, status: string) => LABELS[kind]?.[status] ?? pgLeft(initcap(status.replace(/_/g, " ")), 40);
/** erp_preferences.situation_base_color(p_status) */
export const situationBaseColor = (status: string) => COLORS[status] ?? "#607d8b";
