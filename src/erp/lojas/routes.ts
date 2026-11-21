// Rotas das lojas do ERP, em /api/v1/profiles/:profile/erp-lojas (operações
// em ./contract.ts): cadastro, limite da pessoa, loja em uso, operações por
// loja e o relatório que compara as lojas.
//
// Conferências: pessoa da área com papel no ERP (ou o bot com a operação
// concedida e, nas sensíveis, a proposta que a pessoa confirmou) e o módulo
// ERP ligado. O motor confere de novo papel, horário de acesso, segundo fator,
// o limite de lojas da pessoa e o do bot (pessoa ∩ bot) e a parte de cada
// seção (desligada: some do relatório; na lista, 409 module_disabled).
import { ApiError, type Actor, type Env } from "../../types";
import { canProfile, sha } from "../../security";
import { moduleStates, requireModule } from "../../modules/registry";
import { erpBotDelegation } from "../../modules/erp/bot-access";
import { erpIdentity } from "../../modules/erp/identity";
import { localFetch } from "../api/local-fetch.ts";
import { ERP_PART_NAMES, erpPartOffMessage, erpRequirement, type ErpModuleId } from "../parts.ts";
import { ERP_LOJAS_PART, STORE_OPERATION_KINDS, erpStoreOperationFor, type ErpStoreOperation } from "./contract.ts";

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const bad = (message: string): never => { throw new ApiError(400, "invalid_request", message); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Motivos conhecidos do motor, em palavras de quem usa. */
export const STORE_REASONS: Readonly<Record<string, [number, string, string]>> = {
  erp_store_access_denied: [403, "forbidden", "Seu usuário não tem papel no ERP desta área. Peça ao administrador em Gestão › Pessoas e acessos."],
  erp_store_admin_only: [403, "forbidden", "Só o administrador do ERP cadastra lojas e limita pessoas. Peça ao administrador."],
  erp_store_role_denied: [403, "forbidden", "Seu papel no ERP não vê este tipo de operação. Peça ao administrador um papel que veja (Vendas, Estoque, Financeiro ou Consulta)."],
  erp_store_denied: [403, "store_denied", "Esta loja não está liberada para você (ou para este bot). Peça ao administrador em Cadastros › Lojas › Pessoas."],
  erp_store_admin_unrestricted: [400, "invalid_request", "O administrador vê todas as lojas e não pode ser limitado. Para limitar, troque o papel da pessoa em Gestão › Pessoas e acessos."],
  erp_store_not_found: [404, "not_found", "Loja não encontrada (ou desativada). Atualize a tela."],
  erp_store_person_not_found: [404, "not_found", "Esta pessoa não tem papel ativo no ERP. Dê o papel em Gestão › Pessoas e acessos antes de limitar as lojas."],
  erp_store_record_not_found: [404, "not_found", "O documento ou a conta não existe mais. Atualize a tela."],
  erp_store_warehouse_not_found: [404, "not_found", "Um dos depósitos escolhidos não existe mais. Atualize a tela."],
  erp_store_account_not_found: [404, "not_found", "Uma das contas ou caixas escolhidos não existe mais. Atualize a tela."],
  erp_store_name_invalid: [400, "invalid_request", "Informe o nome da loja (até 80 letras)."],
  erp_store_name_taken: [409, "conflict", "Já existe uma loja com este nome. Escolha outro nome."],
  erp_store_main_active: [400, "invalid_request", "A loja principal não pode ser desativada. Desative a outra loja ou mude os dados da principal."],
  erp_store_default_warehouse_outside: [400, "invalid_request", "O depósito padrão precisa ser um dos depósitos da loja. Marque o depósito na lista da loja antes."],
  erp_store_address_invalid: [400, "invalid_request", "Confira o endereço da loja."],
  erp_store_postal_code_invalid: [400, "invalid_request", "O CEP tem 8 números."],
  erp_store_state_invalid: [400, "invalid_request", "Escolha a UF da loja (duas letras, como SP)."],
  erp_store_phone_invalid: [400, "invalid_request", "Confira o telefone da loja (com DDD, de 8 a 20 números)."],
  erp_store_cnpj_invalid: [400, "invalid_request", "O CNPJ da filial não confere. Confira os números (ou deixe em branco para usar o da empresa)."],
  erp_store_series_invalid: [400, "invalid_request", "A série das notas da loja vai de 0 a 999."],
  erp_store_period_invalid: [400, "invalid_request", "Confira o período (data inicial antes da final, até três anos)."],
  erp_store_invalid: [400, "invalid_request", "Confira os dados e tente de novo."],
  erp_store_command_missing: [400, "invalid_request", "Falta o identificador do pedido de gravação. Atualize a tela e tente de novo."],
  erp_store_command_conflict: [409, "conflict", "Este pedido de gravação já foi usado com outros dados. Atualize a tela e tente de novo."],
  erp_store_version_conflict: [409, "conflict", "Alguém mudou esta loja enquanto você editava. Atualize a tela e confira antes de salvar."],
  erp_document_access_denied: [403, "forbidden", "Seu usuário do ERP não vê este tipo de documento. O administrador libera em Sistema › Usuários › Permissões."],
};

async function commandId(value: unknown, idempotency: string | null, profile: string, name: string, body: Record<string, unknown>) {
  if (value !== undefined && value !== null) {
    if (typeof value !== "string" || !UUID.test(value)) bad("comando: identificador inválido.");
    return (value as string).toLowerCase();
  }
  const seed = idempotency && idempotency.length <= 200 ? `key:${idempotency}` : `body:${JSON.stringify(body)}`;
  const hash = await sha(JSON.stringify(["wabotia-erp-lojas-v1", profile, name, seed]));
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${((parseInt(hash[16], 16) & 3) | 8).toString(16)}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** Corpo e consulta em português → p_args do motor. */
export function storeArgs(op: ErpStoreOperation, query: URLSearchParams, body: Record<string, any> | undefined): Record<string, unknown> {
  const q = (k: string) => { const v = query.get(k); return v === null || v === "" ? undefined : v; };
  const ids = (v: string | undefined) => v === undefined ? undefined : v.split(",").map((x) => x.trim()).filter(Boolean);
  const int = (v: string | undefined, name: string) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n)) bad(`${name}: número inteiro.`);
    return n;
  };
  const b = body ?? {};
  const drop = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  switch (op.rpc) {
    case "erp_store_overview": return {};
    case "erp_store_report": {
      const regime = q("regime");
      if (regime !== undefined && !["caixa", "competencia"].includes(regime)) bad("regime: caixa ou competencia.");
      return drop({ from: q("de"), to: q("ate"), store_ids: ids(q("lojas")), basis: regime === "competencia" ? "competence" : regime === "caixa" ? "cash" : undefined });
    }
    case "erp_store_operations": {
      const kind = STORE_OPERATION_KINDS[q("tipo") ?? ""];
      if (!kind) bad("tipo: pedidos, propostas, compras, contas, estoque ou caixa.");
      return drop({ kind, store_id: q("loja"), from: q("de"), to: q("ate"), page: int(q("pagina"), "pagina"), limit: int(q("limite"), "limite") });
    }
    case "erp_store_save":
      return drop({ id: b.id, expected_version: b.versao, name: b.nome, address: b.endereco, phone: b.telefone, cnpj: b.cnpj, fiscal_series: b.serie,
        active: b.ativa, warehouse_ids: b.depositos, account_ids: b.contas, default_warehouse_id: b.deposito_padrao });
    case "erp_store_person_set": return { user_id: b.pessoa, store_ids: b.lojas };
    case "erp_store_select": return { store_id: b.loja ?? null };
    case "erp_store_assign": {
      const entity = b.registro === "documento" ? "document" : b.registro === "conta" ? "title" : bad("registro: documento ou conta.");
      return { entity, id: b.id, store_id: b.loja };
    }
    default: return bad("Operação desconhecida.");
  }
}

/** Chama o RPC no objeto erp: da área, como a pessoa (com o portão de horário e segundo fator). */
async function callStoreRpc(env: Env, profile: string, actor: Actor, pathname: string, method: string, rpc: string, args: Record<string, unknown>, read: boolean, states: Readonly<Record<string, boolean>>) {
  const identity = await erpIdentity(env, actor, profile, method, pathname);
  const gate = { denied: null as string | null, partsDenied: undefined as string | undefined };
  let response: Response;
  try {
    response = await localFetch(env, profile, actor, identity, { read, gate, trackCustomers: false })(
      `https://erp.wabotia.invalid/rest/v1/rpc/${rpc}`, { method: "POST", body: JSON.stringify({ ...args, p_user_id: identity.actor!.user_id }) });
  } catch (error) {
    if ((error as { code?: string })?.code === "erp_unavailable") throw new ApiError(503, "dependency_unavailable", "O ERP está temporariamente indisponível. Tente de novo em instantes.");
    throw error;
  }
  // Lista de um tipo cuja parte está desligada: diz qual módulo ligar.
  const kindPart: Record<string, ErpModuleId> = { sales_orders: "erp-vendas", sales_proposals: "erp-vendas", purchase_orders: "erp-compras", titles: "erp-financeiro", stock_moves: "erp-estoque", pos_sales: "erp-pdv" };
  const part = typeof args.p_args === "object" && args.p_args ? kindPart[String((args.p_args as Record<string, unknown>).kind)] : undefined;
  const off = (part && erpPartOffMessage(part, erpRequirement(part), states)) || `Esta consulta depende de uma parte do ERP desligada${part ? ` (${ERP_PART_NAMES[part]})` : ""}. Ligue em Gestão → Módulos.`;
  if (gate.partsDenied === "module_disabled") throw new ApiError(409, "module_disabled", off);
  if (gate.denied) throw new ApiError(403, gate.denied === "mfa_required" ? "erp_mfa_required" : "erp_access_denied",
    gate.denied === "mfa_required" ? "O ERP desta área pede o segundo fator para o seu papel. Confirme o código em Minha conta e tente de novo."
      : "Seu acesso ao ERP está fora do horário permitido agora. Fale com o administrador.");
  const body = await response.json<any>().catch(() => null);
  if (!response.ok) {
    const code = typeof body?.message === "string" ? body.message : typeof body?.code === "string" ? body.code : "";
    if (body?.code === "module_disabled" || response.status === 409 && /parte desligada/.test(code)) throw new ApiError(409, "module_disabled", off);
    const known = STORE_REASONS[code];
    if (known) throw new ApiError(known[0], known[1], known[2]);
    if (response.status === 403 || body?.code === "42501") throw new ApiError(403, "forbidden", "Seu acesso no ERP não permite esta ação nas lojas. Peça ao administrador em Pessoas e acessos.");
    if (response.status >= 500) throw new ApiError(503, "dependency_unavailable", "O ERP está temporariamente indisponível. Tente de novo em instantes.");
    throw new ApiError(400, "invalid_request", "O ERP recusou o pedido. Confira os dados e tente de novo.");
  }
  return body;
}

/** GET/POST /api/v1/profiles/:profile/erp-lojas/… */
export async function erpLojasRoute(env: Env, request: Request, profile: string, actor: Actor): Promise<Response> {
  if (!canProfile(actor, profile)) throw new ApiError(404, "not_found", "Área de atendimento não encontrada.");
  const url = new URL(request.url);
  const marker = `/profiles/${encodeURIComponent(profile)}/`;
  const path = url.pathname.slice(url.pathname.indexOf(marker) + marker.length);
  const operation = erpStoreOperationFor(request.method, path);
  if (!operation) throw new ApiError(404, "not_found", "Rota não encontrada.");
  if (actor.kind !== "user")
    throw new ApiError(403, "user_required", "As lojas do ERP atendem uma pessoa da área (ou o bot, com a operação liberada por ela).");
  await requireModule(env, profile, "erp");
  const body = operation.method === "GET" ? undefined : await request.json<Record<string, unknown>>().catch(() => bad("Corpo do pedido inválido."));
  if (body !== undefined && (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !operation.body.includes(key))))
    bad(`Informe só: ${operation.body.join(", ") || "nada no corpo"}.`);
  if (body !== undefined) for (const key of operation.required) if (body[key] === undefined || body[key] === null || body[key] === "") bad(`${key}: obrigatório.`);
  for (const key of operation.required) if (operation.method === "GET" && !url.searchParams.get(key)) bad(`${key}: obrigatório.`);
  if (actor.via && (operation.bot === false || !await erpBotDelegation(env, actor, profile, request.method, url.pathname, body)))
    throw new ApiError(403, "erp_bot_grant_required", "Esta operação das lojas não foi liberada para este bot, ou falta a confirmação da pessoa.");
  const states = await moduleStates(env, profile);
  const off = erpPartOffMessage(ERP_LOJAS_PART, erpRequirement(ERP_LOJAS_PART), states);
  if (off) throw new ApiError(409, "module_disabled", off);
  const p_args = storeArgs(operation, url.searchParams, body);
  const args: Record<string, unknown> = { p_args };
  if (["erp_store_save", "erp_store_person_set", "erp_store_assign"].includes(operation.rpc))
    args.p_command_id = await commandId(body?.comando, request.headers.get("Idempotency-Key"), profile, operation.name, body ?? {});
  return json(await callStoreRpc(env, profile, actor, url.pathname, request.method, operation.rpc, args, operation.method === "GET", states));
}
