// Suporte pago no painel: nomes e formatos (o mesmo contrato de
// src/modules/suporte).
export const kindLabels: Record<string, string> = {
  subscription: "Assinatura em dia",
  installment: "Mensalidade paga",
  package: "Suporte avulso",
  courtesy: "Cortesia",
  team: "Confirmado pela equipe",
};

export const purchaseLabels: Record<string, string> = {
  pending: "Aguardando pagamento",
  paid: "Paga",
  expired: "Expirada",
  cancelled: "Cancelada",
  refunded: "Estornada",
};

export const purchaseTones: Record<string, "ok" | "warn" | "danger" | "muted"> =
  {
    pending: "warn",
    paid: "ok",
    expired: "muted",
    cancelled: "muted",
    refunded: "danger",
  };

export const money = (cents: number | null | undefined) =>
  typeof cents === "number"
    ? (cents / 100).toLocaleString("pt-BR", {
        style: "currency",
        currency: "BRL",
      })
    : "—";

export const stampLabel = (at: number | null | undefined) =>
  at
    ? new Date(at).toLocaleString("pt-BR", {
        timeZone: "America/Sao_Paulo",
        dateStyle: "short",
        timeStyle: "short",
      })
    : "—";

export const phoneLabel = (digits: string) => {
  const m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(digits || "");
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : digits || "—";
};

/** "49,00" → 4900; inválido → null. */
export function cents(value: string): number | null {
  const clean = String(value || "")
    .trim()
    .replace(/[R$\s]/g, "");
  const normalized = clean.includes(",")
    ? clean.replace(/\./g, "").replace(",", ".")
    : clean;
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const [whole, frac = ""] = normalized.split(".");
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
}
