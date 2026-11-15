// Ordem de Serviço no painel: nomes dos estados, tons e formatos (o mesmo
// contrato de src/modules/os/model.ts).
import type { PillTone } from "../../ui/controls";

export const statusOrder = [
  "received",
  "analyzing",
  "quoted",
  "approved",
  "declined",
  "in_progress",
  "ready",
  "delivered",
  "cancelled",
] as const;

export const statusLabels: Record<string, string> = {
  received: "Recebida",
  analyzing: "Em análise",
  quoted: "Orçamento enviado",
  approved: "Aprovada",
  declined: "Recusada",
  in_progress: "Em execução",
  ready: "Pronta",
  delivered: "Entregue",
  cancelled: "Cancelada",
};

export const statusTones: Record<string, PillTone> = {
  received: "brand",
  analyzing: "warn",
  quoted: "ticket",
  approved: "ok",
  declined: "danger",
  in_progress: "bot",
  ready: "ok",
  delivered: "muted",
  cancelled: "muted",
};

/** Rótulo do botão que leva a cada estado. */
export const moveLabels: Record<string, string> = {
  analyzing: "Em análise",
  in_progress: "Iniciar serviço",
  ready: "Marcar como pronta",
  delivered: "Registrar entrega",
  cancelled: "Cancelar ordem",
};

export const money = (cents: number | null | undefined) =>
  typeof cents === "number"
    ? (cents / 100).toLocaleString("pt-BR", {
        style: "currency",
        currency: "BRL",
      })
    : "—";

/** "12,50" ou "12.5" → 1250 centavos; inválido → null. */
export function cents(value: string): number | null {
  const clean = value.trim().replace(/[R$\s]/g, "");
  if (!clean) return null;
  const normalized = clean.includes(",")
    ? clean.replace(/\./g, "").replace(",", ".")
    : clean;
  const number = Number(normalized);
  return Number.isFinite(number) && number >= 0
    ? Math.round(number * 100)
    : null;
}

export const day = (at: number | null | undefined) =>
  at
    ? new Date(at).toLocaleDateString("pt-BR", {
        timeZone: "America/Sao_Paulo",
      })
    : "—";

/** Data AAAA-MM-DD do campo → 18h em Brasília daquele dia. */
export const dueFromInput = (value: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match
    ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 21)
    : null;
};
export const dueToInput = (at: number | null | undefined) => {
  if (!at) return "";
  const d = new Date(at - 3 * 3600000);
  return d.toISOString().slice(0, 10);
};

export const phoneLabel = (digits: string) => {
  const m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(digits || "");
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : digits || "—";
};
