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
   * linked_only (único modo): CPF/CNPJ de um pagador cadastrado vindo de
   * telefone não vinculado fica "aguardando confirmação" até a equipe
   * confirmar. O antigo "any" (liberava direto) é lido como linked_only.
   */
  identify: "linked_only";
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
  identify: "linked_only",
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
    identify: "linked_only",
    texts: { ...SUPORTE_DEFAULTS.texts, ...(raw.texts || {}) },
  };
}

/** CPF/CNPJ diferentes que um telefone consulta por dia. */
export const DOCUMENTS_PER_DAY = 3;
/** Tentativas (válidas ou não) de um telefone por dia. */
export const LOOKUPS_PER_DAY = 10;

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

const HOUR = 3_600_000;
/** Liberação "até o protocolo fechar": no máximo 7 dias, mesmo com ele aberto. */
export const TICKET_RELEASE_MAX_MS = 7 * 24 * HOUR;
/** Qualquer liberação: no máximo 30 dias. */
export const RELEASE_MAX_MS = 30 * 24 * HOUR;
/** Telefone não vinculado ao pagador: liberação sempre curta. */
export const UNLINKED_RELEASE_MS = 4 * HOUR;

/** Prazo absoluto de uma liberação gravada (as antigas, sem a coluna, pelo início). */
export const releaseDeadline = (row: {
  expires_at?: number | null;
  until_ticket?: number;
  valid_until?: number | null;
  created: number;
}) =>
  row.expires_at ??
  row.created +
    (row.until_ticket && row.valid_until === null
      ? TICKET_RELEASE_MAX_MS
      : RELEASE_MAX_MS);

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
    // "any" ainda é aceito (regras salvas antes) e vale como linked_only.
    requireValue(
      raw.identify === "any" || raw.identify === "linked_only",
      "Suporte: identificação linked_only.",
    );
    out.identify = "linked_only";
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

/** Só dígitos, com 55 quando o número veio sem DDI (10 ou 11 dígitos). */
export function phoneDigits(value: unknown) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length === 10 || digits.length === 11 ? "55" + digits : digits;
}

const two = (n: number) => String(n).padStart(2, "0");
const BRT = 3 * 3_600_000;

/** "2026-11-10" → "10/11/2026" (data já em Brasília). */
export const dayLabel = (date: string | null | undefined) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
};

/** "08/11/2026 14:32" em Brasília. */
export function stamp(at: number) {
  const d = new Date(at - BRT);
  return `${two(d.getUTCDate())}/${two(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

/** Cópia profunda sem as chaves dadas (dados sensíveis nas respostas da API). */
export function withoutKeys(value: any, keys: Set<string>): any {
  if (Array.isArray(value)) return value.map((item) => withoutKeys(item, keys));
  if (value && typeof value === "object") {
    const out: Record<string, any> = {};
    for (const [key, item] of Object.entries(value))
      if (!keys.has(key)) out[key] = withoutKeys(item, keys);
    return out;
  }
  return value;
}

export const normalize = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[.!]+$/g, "")
    .trim();
