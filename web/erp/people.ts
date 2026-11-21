// Pessoas do ERP (decisão de 16/11; motor 308e227, domínio Acesso): a lista
// de pessoas e o papel no ERP vêm do núcleo do Vinki, não da erp-api.
//
// Núcleo (origin/feat/acessos-pessoa, docs/API.md "Pessoas da área"):
//   GET /api/v1/profiles/<área>/people
//   → { data: [{ id, name, role: "admin"|"operator", grants: ["erp:vendas", …] }] }
// O papel do ERP é o item erp:<papel> do acesso por pessoa, no máximo um; o
// administrador do Vinki vale erp:admin. Quem não tem papel não aparece.
// O id é users.id do Vinki, o mesmo user_id que o motor recebe no envelope
// de identidade (src/erp/engine/identity.ts) e que /v1/usuarios/:id/controles
// aceita.

export type ErpRole =
  "admin" | "consulta" | "vendas" | "financeiro" | "estoque" | "fiscal";
export const ERP_ROLES: readonly ErpRole[] = [
  "admin",
  "consulta",
  "vendas",
  "financeiro",
  "estoque",
  "fiscal",
];
export const ERP_ROLE_LABELS: Record<ErpRole, string> = {
  admin: "Administrador",
  consulta: "Consulta",
  vendas: "Vendas",
  financeiro: "Financeiro",
  estoque: "Estoque",
  fiscal: "Fiscal",
};

export interface ErpPerson {
  user_id: string;
  name: string;
  role: ErpRole;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GRANT = /^erp:(admin|consulta|vendas|financeiro|estoque|fiscal)$/;

/**
 * Pessoas com papel no ERP, em ordem de nome. Um registro fora do contrato
 * (id que não é UUID, mais de um papel erp:*) fica de fora, nunca com papel
 * adivinhado.
 */
export function erpPeople(raw: unknown): ErpPerson[] {
  const rows = (raw as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows)) throw new Error("ERP_PEOPLE_INVALID");
  const people: ErpPerson[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const { id, name, role, grants } = row as Record<string, unknown>;
    if (typeof id !== "string" || !UUID.test(id) || seen.has(id.toLowerCase()))
      continue;
    const roles = (Array.isArray(grants) ? grants : [])
      .map((grant) => (typeof grant === "string" ? GRANT.exec(grant) : null))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => match[1] as ErpRole);
    const erpRole: ErpRole | null =
      role === "admin" ? "admin" : roles.length === 1 ? roles[0]! : null;
    if (!erpRole) continue;
    seen.add(id.toLowerCase());
    people.push({
      user_id: id.toLowerCase(),
      name: typeof name === "string" && name.trim() ? name : "Sem nome",
      role: erpRole,
    });
  }
  return people.sort(
    (a, b) =>
      a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" }) ||
      a.user_id.localeCompare(b.user_id),
  );
}

export type PeoplePort = (signal: AbortSignal) => Promise<ErpPerson[]>;

/** Porta das pessoas da área, pelo cookie da sessão do Vinki. */
export function createPeoplePort(
  profile: string,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): PeoplePort {
  return async (signal) => {
    const response = await fetchImpl(
      `/api/v1/profiles/${encodeURIComponent(profile)}/people`,
      {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        signal,
      },
    );
    if (!response.ok)
      throw Object.assign(new Error("ERP_PEOPLE_UNAVAILABLE"), {
        status: response.status,
      });
    return erpPeople(await response.json());
  };
}
