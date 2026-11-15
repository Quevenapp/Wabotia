// Mensalidade no painel: nomes dos estados, tons e formatos (o mesmo contrato
// de src/modules/mensalidade/model.ts).
import type { PillTone } from "../../ui/controls";

export const installmentOrder = [
  "open",
  "overdue",
  "paid",
  "waived",
  "cancelled",
] as const;

export const installmentLabels: Record<string, string> = {
  open: "Aberta",
  paid: "Paga",
  overdue: "Vencida",
  cancelled: "Cancelada",
  waived: "Isenta",
};

export const installmentTones: Record<string, PillTone> = {
  open: "brand",
  paid: "ok",
  overdue: "danger",
  cancelled: "muted",
  waived: "muted",
};

export const subscriptionLabels: Record<string, string> = {
  active: "Ativa",
  paused: "Pausada",
  ended: "Encerrada",
};

export const subscriptionTones: Record<string, PillTone> = {
  active: "ok",
  paused: "warn",
  ended: "muted",
};

export const periodLabels: Record<string, string> = {
  monthly: "Mensal",
  quarterly: "Trimestral",
  yearly: "Anual",
};

export const money = (cents: number | null | undefined) =>
  typeof cents === "number"
    ? (cents / 100).toLocaleString("pt-BR", {
        style: "currency",
        currency: "BRL",
      })
    : "—";

/** "12,50", "1.234,56" ou "12.5" → centavos inteiros; inválido → null. */
export function cents(value: string): number | null {
  const clean = String(value || "")
    .trim()
    .replace(/[R$\s]/g, "");
  if (!clean) return null;
  const normalized = clean.includes(",")
    ? clean.replace(/\./g, "").replace(",", ".")
    : clean;
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const [whole, frac = ""] = normalized.split(".");
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
}

export const centsInput = (value: number | null | undefined) =>
  typeof value === "number" ? (value / 100).toFixed(2).replace(".", ",") : "";

/** "2026-11-10" → "10/11/2026" (datas de vencimento já em Brasília). */
export const dateLabel = (value: string | null | undefined) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "—";
};

export const stampLabel = (at: number | null | undefined) =>
  at
    ? new Date(at).toLocaleString("pt-BR", {
        timeZone: "America/Sao_Paulo",
        dateStyle: "short",
        timeStyle: "short",
      })
    : "—";

const MONTHS = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];
/** "2026-11" → "novembro de 2026". */
export const monthLabel = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return `${MONTHS[m - 1]} de ${y}`;
};

/** Mês atual (AAAA-MM) em Brasília. */
export const currentMonth = () =>
  new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 7);

export const shiftMonth = (month: string, delta: number) => {
  const [y, m] = month.split("-").map(Number);
  const index = y * 12 + (m - 1) + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
};

export const phoneLabel = (digits: string) => {
  const m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(digits || "");
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : digits || "—";
};

/**
 * Linhas coladas de uma planilha: "nome; telefone; plano; desconto; dia".
 * Aceita ponto e vírgula, tabulação ou vírgula; ignora linhas vazias e um
 * cabeçalho que comece por "nome".
 */
export function parseImport(text: string) {
  const rows: Record<string, any>[] = [];
  const problems: string[] = [];
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line, index) => {
      const parts = (
        line.includes(";") || line.includes("\t")
          ? line.split(/[;\t]/)
          : line.split(",")
      ).map((p) => p.trim());
      if (index === 0 && /^nome$/i.test(parts[0])) return;
      const [name, phone, plan, discount, day] = parts;
      if (!name || !phone || !plan) {
        problems.push(`Linha ${index + 1}: informe nome, telefone e plano.`);
        return;
      }
      const row: Record<string, any> = { customer_name: name, phone, plan };
      if (discount) {
        const value = cents(discount);
        if (value === null) {
          problems.push(`Linha ${index + 1}: desconto inválido (${discount}).`);
          return;
        }
        row.discount_cents = value;
      }
      if (day) row.due_day = Number(day);
      rows.push(row);
    });
  return { rows, problems };
}
