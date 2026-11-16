// GET /api/v1/capabilities: o que este servidor oferece a quem pergunta. Os
// aplicativos consultam antes de mostrar telas de módulo (docs/MODULOS.md).
import { all } from "../db";
import { ApiError, json, type Actor, type Env } from "../types";
import { grantsFor } from "../module-grants";
import { canProfile } from "../security";
import { buildInfo } from "../build-info.generated";
import { modules, resolveStates } from "./registry";

/** Versão do formato desta resposta; muda só com quebra de contrato. */
export const CAPABILITIES_VERSION = 1;

/** Recursos do núcleo que um aplicativo pode precisar conferir. */
export const coreFeatures: string[] = [
  "modules",
  "web_steps",
  "establishment",
  // `grants` em cada área: papéis da pessoa nos módulos (docs/MODULOS.md).
  "module_grants",
];

export async function capabilities(
  env: Env,
  actor: Actor,
  only?: string | null,
) {
  const areas = (
    await all(
      env,
      "SELECT id,name,enabled,settings FROM profiles ORDER BY created,id",
    )
  ).filter((p) => canProfile(actor, p.id) && (!only || p.id === only));
  if (only && !areas.length)
    throw new ApiError(404, "not_found", "Área de atendimento não encontrada.");
  const rows = areas.length
    ? await all(
        env,
        "SELECT profile_id,module_id,enabled FROM profile_modules WHERE profile_id IN (SELECT value FROM json_each(?))",
        JSON.stringify(areas.map((p) => p.id)),
      )
    : [];
  return {
    capabilities_version: CAPABILITIES_VERSION,
    server: {
      service: "wabotia",
      version: buildInfo.version,
      commit: buildInfo.commit,
    },
    features: coreFeatures,
    actor: { id: actor.id, kind: actor.kind, role: actor.role },
    profiles: areas.map((p) => {
      const states = resolveStates(
        Object.fromEntries(
          rows
            .filter((r) => r.profile_id === p.id)
            .map((r) => [r.module_id, r.enabled]),
        ),
      );
      return {
        id: p.id,
        name: p.name,
        enabled: !!p.enabled,
        modules: modules
          .filter((m) => states[m.id])
          .map((m) => ({ id: m.id, name: m.name, version: m.version })),
        // Papéis da pessoa nesta área ("os:technician"), só de módulos
        // ligados; vazio para aplicações e aparelhos pareados.
        grants: grantsFor(json(p.settings), actor, states),
      };
    }),
  };
}
