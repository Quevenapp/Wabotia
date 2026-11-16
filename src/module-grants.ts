// Papéis por pessoa nos módulos (docs/MODULOS.md, "Acessos e papéis"): o
// módulo declara os papéis em `grants` da definição (entregador, garçom,
// técnico, caixa) e o administrador marca na lista de acesso da pessoa
// (users.access, src/access.ts) o id `<módulo>:<papel>`. O "*" do atendente
// completo não dá papel; o administrador também não ganha papel sozinho.
// Aplicações e aparelhos pareados nunca têm papel.
import type { Actor } from "./types";
import { modules, type ModuleStates } from "./modules/registry";
import { rolesOf } from "./access";
import { storedAccess } from "./security";

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

/** Papéis da pessoa, só de módulos ligados (ator ou linha de users). */
export function grantsFor(
  person: Pick<Actor, "kind" | "access"> | { access: unknown },
  states: ModuleStates,
) {
  const actor =
    "kind" in person
      ? (person as Actor)
      : ({
          kind: "user",
          access: storedAccess((person as any).access),
        } as Actor);
  const held = rolesOf(actor);
  return declaredGrants(states)
    .map((g) => g.id)
    .filter((id) => held.includes(id));
}
