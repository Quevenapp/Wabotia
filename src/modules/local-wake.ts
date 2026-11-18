import type { Env } from "../types";

// Capacidade interna, preservada pelos wrappers de env. Evita RPC ao próprio
// Coordinator enquanto seu input gate protege uma rodada/comando.
const localWake = Symbol("module-local-wake");
type Wake = (options?: { modules?: boolean }) => Promise<void>;
type LocalEnv = Env & { [localWake]?: { profile: string; wake: Wake } };
export function withLocalModuleWake(env: Env, profile: string, wake: Wake): Env {
  return { ...env, [localWake]: { profile, wake } } as LocalEnv;
}
export function localModuleWake(env: Env, profile: string): Wake | undefined {
  const capability = (env as LocalEnv)[localWake];
  return capability?.profile === profile ? capability.wake : undefined;
}
