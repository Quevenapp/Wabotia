type ReadRequirement = { all?: readonly string[]; any: readonly string[] };

/** Papéis de leitura explícitos; não concedem escrita nem substituem a autorização do servidor. */
const requirements: Readonly<Record<string, ReadRequirement>> = {
  ensino: { any: ["ensino:secretaria", "ensino:professor"] },
  juridico: { all: ["os:sensitive"], any: ["juridico:lawyer", "juridico:curator"] },
  "juridico.deadlines": { all: ["os:sensitive"], any: ["juridico:lawyer"] },
};

/** Administrador, acesso legado nulo e "*" não substituem esses papéis. */
export function nativeReadAllows(target: string, access: readonly string[] | null | undefined): boolean {
  if (!Object.hasOwn(requirements, target)) return true;
  const rule = requirements[target];
  return !!access && (rule.all ?? []).every((grant) => access.includes(grant)) &&
    rule.any.some((grant) => access.includes(grant));
}
