// Identidade para o diferencial do Acesso: a porta agora é do harness
// (tests/erp/harness/identity.mjs e f.rpcAs, sessão L). Isto só mantém a
// assinatura antiga dos testes do Acesso.
export { pgIdentity, pgListing } from "../harness/identity.mjs";

/** RPC nos dois motores, com o envelope de identidade e a listagem tirados do oráculo. */
export function rpcAs(f, name, args, { session = null } = {}) {
  return f.rpcAs(name, args, session ? { session } : true);
}
