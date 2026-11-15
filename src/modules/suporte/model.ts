// Regras puras do Suporte pago: configurações (chave "suporte" de PUT
// /settings), pacotes avulsos e textos. Sem banco.
import { requireValue } from "../../types";

export interface SupportPackage {
  id: string;
  name: string;
  price_cents: number;
  /** ticket: vale até o protocolo da conversa fechar; hours: vale N horas. */
  mode: "ticket" | "hours";
  hours?: number;
  active: boolean;
}

export interface SuporteSettings {
  /** Setor que recebe a conversa liberada (null: equipe geral). */
  department_id: string | null;
  /**
   * any: CPF/CNPJ vindo de telefone não vinculado libera, com aviso ao
   * atendente. linked_only: esse caso vai para a equipe confirmar antes.
   */
  identify: "any" | "linked_only";
  /** Tentativas de digitar o CPF/CNPJ (1 a 5). */
  max_attempts: number;
  packages: SupportPackage[];
  /** Oferecer os planos vendáveis da Mensalidade (exige o módulo ligado). */
  offer_plans: boolean;
  /** Planos oferecidos (vazio: todos os vendáveis). */
  plan_ids: string[];
  /** Formas de pagamento oferecidas. */
  methods: ("pix" | "link")[];
  texts: {
    /** Antes das opções de compra. */
    offer: string;
    /** Ao liberar, antes de passar para a equipe. */
    released: string;
  };
}

export const SUPORTE_DEFAULTS: SuporteSettings = {
  department_id: null,
  identify: "any",
  max_attempts: 3,
  packages: [],
  offer_plans: true,
  plan_ids: [],
  methods: ["pix", "link"],
  texts: {
    offer:
      "O atendimento humano é para clientes com suporte contratado. Escolha uma opção para continuar:",
    released: "Tudo certo! Vamos chamar um atendente para você.",
  },
};

export function suporteSettings(cfg: any): SuporteSettings {
  const raw =
    cfg?.suporte && typeof cfg.suporte === "object" ? cfg.suporte : {};
  return {
    ...SUPORTE_DEFAULTS,
    ...raw,
    texts: { ...SUPORTE_DEFAULTS.texts, ...(raw.texts || {}) },
  };
}

const intIn = (value: unknown, min: number, max: number, what: string) => {
  requireValue(
    Number.isInteger(value) &&
      (value as number) >= min &&
      (value as number) <= max,
    `Suporte: ${what} de ${min} a ${max}.`,
  );
  return value as number;
};

const text = (value: unknown, max: number, what: string, required = false) => {
  if (value === undefined || value === null || value === "") {
    requireValue(!required, `Suporte: informe ${what}.`);
    return "";
  }
  requireValue(
    typeof value === "string" && Array.from(value.trim()).length <= max,
    `Suporte: ${what} com até ${max} caracteres.`,
  );
  return (value as string).trim();
};

export const PACKAGES_LIMIT = 9;

export function validatePackages(value: unknown): SupportPackage[] {
  requireValue(
    Array.isArray(value) && value.length <= PACKAGES_LIMIT,
    `Suporte: até ${PACKAGES_LIMIT} pacotes avulsos.`,
  );
  const ids = new Set<string>();
  return (value as any[]).map((raw) => {
    requireValue(raw && typeof raw === "object", "Suporte: pacote inválido.");
    const id = text(raw.id, 60, "o identificador do pacote", true);
    requireValue(
      /^[A-Za-z0-9_-]+$/.test(id) && !ids.has(id),
      "Suporte: identificador de pacote inválido ou repetido.",
    );
    ids.add(id);
    const name = text(raw.name, 40, "o nome do pacote", true);
    requireValue(
      Number.isInteger(raw.price_cents) &&
        raw.price_cents >= 100 &&
        raw.price_cents <= 100_000_00,
      `Suporte: preço do pacote "${name}" em centavos (de R$ 1,00 a R$ 100.000,00).`,
    );
    const mode = raw.mode ?? "ticket";
    requireValue(
      mode === "ticket" || mode === "hours",
      `Suporte: validade do pacote "${name}" é ticket ou hours.`,
    );
    const pkg: SupportPackage = {
      id,
      name,
      price_cents: raw.price_cents,
      mode,
      active: raw.active === undefined ? true : raw.active === true,
    };
    if (mode === "hours")
      pkg.hours = intIn(raw.hours, 1, 720, `horas do pacote "${name}"`);
    return pkg;
  });
}

/** Validação estrita da chave "suporte" em PUT /settings. */
export function validateSuporteSettings(
  value: unknown,
): Partial<SuporteSettings> {
  requireValue(
    value && typeof value === "object" && !Array.isArray(value),
    "Suporte: regras inválidas.",
  );
  const raw = value as any;
  const allowed = new Set(Object.keys(SUPORTE_DEFAULTS));
  for (const key of Object.keys(raw))
    requireValue(allowed.has(key), `Suporte: chave desconhecida ${key}.`);
  const out: Partial<SuporteSettings> = {};
  if (raw.department_id !== undefined)
    out.department_id =
      raw.department_id === null || raw.department_id === ""
        ? null
        : text(raw.department_id, 100, "o setor");
  if (raw.identify !== undefined) {
    requireValue(
      raw.identify === "any" || raw.identify === "linked_only",
      "Suporte: identificação any ou linked_only.",
    );
    out.identify = raw.identify;
  }
  if (raw.max_attempts !== undefined)
    out.max_attempts = intIn(raw.max_attempts, 1, 5, "tentativas de CPF/CNPJ");
  if (raw.packages !== undefined) out.packages = validatePackages(raw.packages);
  if (raw.offer_plans !== undefined) {
    requireValue(
      typeof raw.offer_plans === "boolean",
      "Suporte: offer_plans verdadeiro ou falso.",
    );
    out.offer_plans = raw.offer_plans;
  }
  if (raw.plan_ids !== undefined) {
    requireValue(
      Array.isArray(raw.plan_ids) &&
        raw.plan_ids.length <= 20 &&
        raw.plan_ids.every(
          (id: unknown) => typeof id === "string" && id.length <= 100,
        ),
      "Suporte: planos oferecidos inválidos.",
    );
    out.plan_ids = [...new Set<string>(raw.plan_ids)];
  }
  if (raw.methods !== undefined) {
    requireValue(
      Array.isArray(raw.methods) &&
        raw.methods.length >= 1 &&
        raw.methods.every((m: unknown) => m === "pix" || m === "link"),
      "Suporte: formas de pagamento pix e/ou link.",
    );
    out.methods = [...new Set<"pix" | "link">(raw.methods)];
  }
  if (raw.texts !== undefined) {
    requireValue(
      raw.texts && typeof raw.texts === "object" && !Array.isArray(raw.texts),
      "Suporte: textos inválidos.",
    );
    const texts: Partial<SuporteSettings["texts"]> = {};
    for (const [key, value] of Object.entries(raw.texts)) {
      requireValue(
        key === "offer" || key === "released",
        `Suporte: texto desconhecido ${key}.`,
      );
      texts[key as "offer" | "released"] = text(value, 600, "o texto");
    }
    out.texts = texts as SuporteSettings["texts"];
  }
  return out;
}

/** "R$ 1.234,56" */
export function money(cents: number) {
  const abs = Math.abs(Math.round(cents));
  const reais = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${cents < 0 ? "-" : ""}R$ ${reais},${String(abs % 100).padStart(2, "0")}`;
}

export const METHOD_LABELS: Record<"pix" | "link", string> = {
  pix: "Pix",
  link: "Cartão ou link",
};

export const packageValidity = (pkg: {
  mode: string;
  hours?: number | null;
}) =>
  pkg.mode === "hours"
    ? `${pkg.hours} ${pkg.hours === 1 ? "hora" : "horas"} de atendimento`
    : "até o fim deste atendimento";

export const normalize = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[.!]+$/g, "")
    .trim();
