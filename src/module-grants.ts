// Papéis por pessoa nos módulos (docs/MODULOS.md, "Papéis por pessoa"): o
// módulo declara os papéis em `grants` da definição (entregador, garçom,
// técnico, caixa) e o administrador concede a pessoas da área. A concessão
// fica nas configurações da área, chave `module_grants`:
//   { "os:technician": ["<id da pessoa>", ...], "entrega:courier": [...] }
// Só pessoas recebem papel: aplicações e aparelhos pareados usam escopos.
// O administrador não ganha papel automaticamente; o módulo decide se ele
// também pode agir (actor.role === "admin").
import { all } from "./db";
import { requireValue, type Actor, type Env } from "./types";
import { modules, type ModuleStates } from "./modules/registry";

/** Limite de pessoas por papel numa área. */
export const GRANT_MAX_PEOPLE = 500;

export const grantId = (moduleId: string, role: string) =>
  `${moduleId}:${role}`;

/** Papéis declarados pelos módulos; com `states`, só os dos módulos ligados. */
export function declaredGrants(states?: ModuleStates) {
  return modules
    .filter((m) => !states || states[m.id])
    .flatMap((m) =>
      (m.grants || []).map((g) => ({
        id: grantId(m.id, g.id),
        module_id: m.id,
        module_name: m.name,
        role: g.id,
        label: g.label,
        description: g.description,
      })),
    );
}

/** Leitura tolerante: `{papel: [ids]}` só com listas de texto. */
export function savedGrants(cfg: any): Record<string, string[]> {
  const saved = cfg?.module_grants;
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(saved))
    if (Array.isArray(value))
      out[key] = value.filter((id): id is string => typeof id === "string");
  return out;
}

/** Papéis concedidos a uma pessoa, só dos módulos ligados. */
export function grantsFor(
  cfg: any,
  actor: Pick<Actor, "id" | "kind">,
  states: ModuleStates,
) {
  if (actor.kind !== "user") return [];
  const saved = savedGrants(cfg);
  return declaredGrants(states)
    .map((g) => g.id)
    .filter((id) => saved[id]?.includes(actor.id));
}

/**
 * Validação estrita de `module_grants` em PUT /settings (o objeto já vem
 * mesclado com o salvo: cada papel enviado substitui a lista dele). Papel
 * precisa estar declarado por um módulo desta versão; pessoa precisa estar
 * ativa e ter acesso à área. Lista vazia remove o papel.
 */
export async function validateModuleGrants(
  env: Env,
  profile: string,
  value: unknown,
): Promise<Record<string, string[]>> {
  requireValue(
    value && typeof value === "object" && !Array.isArray(value),
    "Papéis nos módulos: envie um objeto {papel: [pessoas]}.",
  );
  const known = new Set(declaredGrants().map((g) => g.id));
  const out: Record<string, string[]> = {};
  const wanted = new Set<string>();
  for (const [key, ids] of Object.entries(value as Record<string, unknown>)) {
    requireValue(known.has(key), `Papel desconhecido: ${key}.`);
    requireValue(
      Array.isArray(ids) &&
        ids.length <= GRANT_MAX_PEOPLE &&
        ids.every((id) => typeof id === "string" && id.length <= 100),
      `Papel ${key}: envie uma lista de até ${GRANT_MAX_PEOPLE} pessoas.`,
    );
    const unique = [...new Set(ids as string[])];
    if (unique.length) out[key] = unique;
    unique.forEach((id) => wanted.add(id));
  }
  if (wanted.size) {
    const people = new Set(
      (
        await all(
          env,
          "SELECT id FROM users WHERE disabled=0 AND id IN (SELECT value FROM json_each(?)) AND (role='admin' OR EXISTS(SELECT 1 FROM json_each(users.profiles) WHERE value=?))",
          JSON.stringify([...wanted]),
          profile,
        )
      ).map((row) => row.id as string),
    );
    const missing = [...wanted].filter((id) => !people.has(id));
    requireValue(
      !missing.length,
      "Papéis nos módulos: só pessoas ativas com acesso a esta área recebem papel.",
    );
  }
  return out;
}
