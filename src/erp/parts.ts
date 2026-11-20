/** Contrato puro, compartilhado por Worker, motor, agendador e painel. */
export type ErpModuleId =
  | "erp" | "erp-produtos" | "erp-vendas" | "erp-compras"
  | "erp-estoque" | "erp-financeiro" | "erp-fiscal" | "erp-cobranca" | "erp-pdv";
export interface ErpParts {
  customers: boolean;
  products: boolean;
  sales: boolean;
  purchases: boolean;
  stock: boolean;
  finance: boolean;
  fiscal: boolean;
  billing: boolean;
  pos: boolean;
}
export type ErpPartKey = keyof ErpParts;
export interface ErpPartsSnapshot {
  profile: string;
  revision: string;
  /** Origem temporal da concessão; ausente apenas em entregas legadas. */
  issued_at?: number;
  expires_at: number;
  parts: Readonly<ErpParts>;
}
export type ErpPartsControl = Omit<ErpPartsSnapshot, "parts">;
export interface ErpRequirement { all: readonly ErpModuleId[] }

export const ERP_PART_MODULES: Readonly<Record<ErpPartKey, ErpModuleId>> = Object.freeze({
  customers: "erp", products: "erp-produtos", sales: "erp-vendas", purchases: "erp-compras",
  stock: "erp-estoque", finance: "erp-financeiro", fiscal: "erp-fiscal", billing: "erp-cobranca", pos: "erp-pdv",
});
export const ERP_PART_KEYS = Object.freeze(Object.keys(ERP_PART_MODULES) as ErpPartKey[]);
export const ERP_MODULE_IDS = Object.freeze(Object.values(ERP_PART_MODULES));
export const ERP_PART_DEPENDENCIES: Readonly<Record<ErpModuleId, readonly ErpModuleId[]>> = Object.freeze({
  erp: [], "erp-produtos": ["erp"], "erp-vendas": ["erp-produtos"], "erp-compras": ["erp-produtos"],
  "erp-estoque": ["erp-produtos"], "erp-financeiro": ["erp"], "erp-fiscal": ["erp"],
  "erp-cobranca": ["erp-financeiro"], "erp-pdv": ["erp-vendas", "erp-financeiro", "erp-estoque"],
});
/** Nome de exibição de cada parte (tela Módulos, painel e mensagens). O identificador não muda. */
export const ERP_PART_NAMES: Readonly<Record<ErpModuleId, string>> = Object.freeze({
  erp: "Cadastros", "erp-produtos": "Produtos e serviços", "erp-vendas": "Vendas", "erp-compras": "Compras",
  "erp-estoque": "Estoque", "erp-financeiro": "Financeiro", "erp-fiscal": "Fiscal",
  "erp-cobranca": "Cobrança bancária", "erp-pdv": "Caixa / PDV",
});
const spokenList = (items: readonly string[]) =>
  items.length > 1 ? `${items.slice(0, -1).join(", ")} e ${items.at(-1)}` : items.join("");
/**
 * Frase de uma tela cuja parte está desligada: a parte dona e, quando ela
 * depende de outras também desligadas, a cadeia. Sem parte faltando, null.
 */
export function erpPartOffMessage(owner: ErpModuleId, requirement: ErpRequirement, modules: Readonly<Record<string, boolean>>): string | null {
  const order = (ids: readonly ErpModuleId[]) => ERP_MODULE_IDS.filter(id => ids.includes(id));
  const names = (ids: readonly ErpModuleId[]) => spokenList(ids.map(id => ERP_PART_NAMES[id]));
  const off = order(requirement.all.filter(id => modules[id] !== true));
  if (!off.length) return null;
  if (modules[owner] === true)
    return `Esta tela também precisa de ${names(off)}, que ${off.length > 1 ? "estão desligados" : "está desligado"}. Ligue em Gestão → Módulos.`;
  const chain = order(erpRequirement(owner).all.filter(id => id !== owner && modules[id] !== true));
  const extra = off.filter(id => id !== owner && !chain.includes(id));
  const lines = [`Esta tela faz parte de ${ERP_PART_NAMES[owner]}, que está desligado. Ligue em Gestão → Módulos.`];
  if (chain.length) lines.push(`${ERP_PART_NAMES[owner]} depende de ${names(chain)}: ligue ${chain.length > 1 ? "todos" : "os dois"}.`);
  if (extra.length) lines.push(`Esta tela também precisa de ${names(extra)}.`);
  return lines.join(" ");
}
/** Compatibilidade do motor direto. Produção valida o mapa completo antes. */
export function normalizeErpParts(input?: Partial<ErpParts>): Readonly<ErpParts> {
  return Object.freeze(Object.fromEntries(ERP_PART_KEYS.map(key => [key, input?.[key] !== false])) as unknown as ErpParts);
}
export const partOn = (parts: Readonly<ErpParts>, key: ErpPartKey): boolean => parts[key] !== false;
export function erpRequirement(...ids: ErpModuleId[]): ErpRequirement {
  const found = new Set<ErpModuleId>();
  const visit = (id: ErpModuleId) => { if (!found.has(id)) { found.add(id); ERP_PART_DEPENDENCIES[id].forEach(visit); } };
  ids.forEach(visit);
  return Object.freeze({ all: Object.freeze([...found]) });
}
export function erpRequirementMet(parts: Readonly<ErpParts>, requirement: ErpRequirement): boolean {
  return requirement.all.every(id => ERP_PART_KEYS.some(key => ERP_PART_MODULES[key] === id && partOn(parts, key)));
}
export const ERP_PARTS_TTL_MS = 6 * 60_000;
export const ERP_PARTS_CLOCK_SKEW_MS = 5_000;
export function readErpPartsSnapshot(value: unknown, profile?: string, now = Date.now()): ErpPartsSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const s = value as ErpPartsSnapshot;
  // A concessão nova informa sua duração no relógio de origem. Reservamos
  // cinco segundos NO FIM, em vez de estender a autorização: mesmo com o
  // emissor adiantado pela margem inteira, o uso termina em até seis minutos.
  // O formato legado continua estrito, sem ganhar tolerância nem validade.
  const timed = s.issued_at !== undefined;
  if (timed && (!Number.isSafeInteger(s.issued_at) || s.issued_at! > now + ERP_PARTS_CLOCK_SKEW_MS ||
      s.expires_at <= s.issued_at! || s.expires_at - s.issued_at! > ERP_PARTS_TTL_MS)) return null;
  if (typeof s.profile !== "string" || !s.profile || (profile !== undefined && s.profile !== profile) ||
      typeof s.revision !== "string" || !/^(0|[1-9][0-9]*)$/.test(s.revision) ||
      !Number.isSafeInteger(s.expires_at) || s.expires_at - (timed ? ERP_PARTS_CLOCK_SKEW_MS : 0) <= now ||
      (!timed && s.expires_at > now + ERP_PARTS_TTL_MS) ||
      !s.parts || typeof s.parts !== "object" || Array.isArray(s.parts) ||
      Object.keys(s.parts).length !== ERP_PART_KEYS.length || ERP_PART_KEYS.some(k => typeof s.parts[k] !== "boolean")) return null;
  return Object.freeze({ profile: s.profile, revision: s.revision, ...(timed ? { issued_at: s.issued_at } : {}),
    expires_at: s.expires_at, parts: normalizeErpParts(s.parts) });
}
export const sameErpParts = (a: Readonly<ErpParts>, b: Readonly<ErpParts>) => ERP_PART_KEYS.every(key => a[key] === b[key]);

export const ERP_PARTS_DENIED_HEADER = "x-erp-parts-denied";

/** Identificador salvo transportado fora dos argumentos gerados/hash do comando. */
export interface ErpPartsReference { kind: "report" | "label"; id: string }
export const ERP_PARTS_REFERENCE_HEADER = "x-erp-parts-reference";
export function readErpPartsReference(value: unknown): ErpPartsReference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const ref = value as ErpPartsReference;
  if (!["report", "label"].includes(ref.kind) || typeof ref.id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(ref.id) ||
      Object.keys(ref).some(key => !["kind", "id"].includes(key))) return null;
  return Object.freeze({ kind: ref.kind, id: ref.id.toLowerCase() });
}
