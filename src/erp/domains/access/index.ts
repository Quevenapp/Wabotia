// RPCs portados do domínio: um import por arquivo de src/erp/domains/access/rpc/
// (cada um chama registerRpc). Só a sessão dona do domínio edita este arquivo.
// Os 9 RPCs de gestão de usuários do Supabase Auth não se portam (src/erp/schema/structural.ts).
import "./identity.ts";
import "./rpc/me.ts";
import "./rpc/activity.ts";
import "./rpc/security.ts";
export {};
