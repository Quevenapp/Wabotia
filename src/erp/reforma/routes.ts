// Rotas da reforma tributária no ERP, em /api/v1/profiles/:profile/erp-reforma
// (operações em ./contract.ts).
//
// Conferências: pessoa da área com papel no ERP (o bot fica de fora: tudo é
// pela tela), módulo ERP ligado e as partes do ERP da operação ligadas
// (desligada: 409 module_disabled e qual ligar). O motor confere de novo
// papel, permissão, horário de acesso e segundo fator.
import { ApiError, type Actor, type Env } from "../../types";
import { canProfile } from "../../security";
import { moduleStates, requireModule } from "../../modules/registry";
import { erpIdentity } from "../../modules/erp/identity";
import { localFetch } from "../api/local-fetch.ts";
import { erpPartOffMessage, erpRequirement } from "../parts.ts";
import { erpReformOperationFor, reformRpcArgs, ReformArgsError, type ErpReformOperation } from "./contract.ts";
import { reformReportCsv, type ReformReport } from "./csv.ts";

const noStore = { "Cache-Control": "no-store" };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: noStore });
const bad = (message: string): never => { throw new ApiError(400, "invalid_request", message); };

/** Motivos conhecidos do motor, em palavras de quem usa. */
const REASONS: Readonly<Record<string, [number, string, string]>> = {
  erp_fiscal_invoice_forbidden: [403, "forbidden", "Seu papel no ERP não alcança a parte fiscal (ou falta a permissão de Notas fiscais). Peça ao administrador o papel Fiscal ou Administrador em Pessoas e acessos."],
  erp_fiscal_reform_cst_invalid: [400, "invalid_request", "CST de IBS/CBS desconhecido: escolha um CST da lista."],
  erp_fiscal_reform_cclasstrib_invalid: [400, "invalid_request", "Classificação tributária inválida: são 6 dígitos e os 3 primeiros têm de ser o CST escolhido."],
  erp_fiscal_reform_nbs_invalid: [400, "invalid_request", "NBS inválido: são 9 dígitos, sem pontos."],
  erp_fiscal_reform_selective_invalid: [400, "invalid_request", "Imposto Seletivo inválido: confira o CST, a classificação (6 dígitos começando pelo CST) e a alíquota (até 100%)."],
  erp_fiscal_reform_rates_invalid: [400, "invalid_request", "Alíquotas inválidas: informe percentuais de 0 a 100, com até 4 casas, só para os anos de 2026 a 2033."],
  erp_fiscal_reform_settings_invalid: [400, "invalid_request", "Configuração inválida: confira a opção do Simples e as alíquotas."],
  erp_fiscal_reform_class_invalid: [400, "invalid_request", "Regra de classificação inválida: confira o escopo (todos, NCM, produtos ou grupos) e as listas (até 10 itens)."],
  erp_fiscal_reform_product_invalid: [400, "invalid_request", "Um dos produtos da regra não existe mais. Atualize a tela."],
  erp_fiscal_reform_group_invalid: [400, "invalid_request", "Um dos grupos de produtos da regra não existe mais. Atualize a tela."],
  erp_fiscal_reform_default_repeated: [400, "invalid_request", "A natureza só pode ter uma classificação padrão (para todos os produtos)."],
  erp_fiscal_reform_report_invalid: [400, "invalid_request", "Confira o período do relatório: início antes do fim e até 400 dias."],
  erp_fiscal_command_invalid: [400, "invalid_request", "Pedido incompleto. Atualize a tela e tente de novo."],
  erp_fiscal_reform_settings_changed: [409, "conflict", "A configuração da reforma mudou enquanto você editava. Atualize a tela e salve de novo."],
  erp_fiscal_reform_product_changed: [409, "conflict", "A classificação deste produto mudou enquanto você editava. Atualize a tela e salve de novo."],
  erp_fiscal_reform_class_changed: [409, "conflict", "A classificação desta natureza mudou enquanto você editava. Atualize a tela e salve de novo."],
  erp_fiscal_command_conflict: [409, "conflict", "Este pedido já foi usado com outros dados. Atualize a tela e tente de novo."],
  erp_fiscal_reform_product_not_found: [404, "not_found", "O produto não foi encontrado. Atualize a tela."],
  erp_fiscal_nature_not_found: [404, "not_found", "A natureza de operação não foi encontrada ou foi excluída. Atualize a tela."],
  erp_fiscal_invoice_contact_not_found: [404, "not_found", "O cliente do documento não foi encontrado. Confira o cliente."],
  erp_fiscal_query_invalid: [400, "invalid_request", "Confira o tipo do documento e os produtos (até 250)."],
};

async function callReformRpc(env: Env, profile: string, actor: Actor, pathname: string, method: string, operation: ErpReformOperation, args: Record<string, unknown>) {
  const identity = await erpIdentity(env, actor, profile, method, pathname);
  const gate = { denied: null as string | null, partsDenied: undefined as string | undefined };
  let response: Response;
  try {
    response = await localFetch(env, profile, actor, identity, { read: method === "GET", gate, trackCustomers: false })(
      `https://erp.wabotia.invalid/rest/v1/rpc/${operation.rpc}`, { method: "POST", body: JSON.stringify({ ...args, p_user_id: identity.actor!.user_id }) });
  } catch (error) {
    if ((error as { code?: string })?.code === "erp_unavailable") throw new ApiError(503, "dependency_unavailable", "O ERP está temporariamente indisponível. Tente de novo em instantes.");
    throw error;
  }
  if (gate.partsDenied === "module_disabled") throw new ApiError(409, "module_disabled", "A reforma tributária depende da parte Fiscal do ERP, que está desligada. Ligue em Gestão › Módulos.");
  if (gate.denied) throw new ApiError(403, gate.denied === "mfa_required" ? "erp_mfa_required" : "erp_access_denied",
    gate.denied === "mfa_required" ? "O ERP desta área pede o segundo fator para o seu papel. Confirme o código em Minha conta e tente de novo."
      : "Seu acesso ao ERP está fora do horário permitido agora. Fale com o administrador.");
  const body = await response.json<any>().catch(() => null);
  if (!response.ok) {
    const code = typeof body?.message === "string" ? body.message : typeof body?.code === "string" ? body.code : "";
    if (body?.code === "module_disabled" || response.status === 409 && /parte desligada/.test(code))
      throw new ApiError(409, "module_disabled", "A reforma tributária depende da parte Fiscal do ERP, que está desligada. Ligue em Gestão › Módulos.");
    const known = REASONS[code];
    if (known) throw new ApiError(known[0], known[1], known[2]);
    if (response.status === 403 || body?.code === "42501") throw new ApiError(403, "forbidden", "Seu acesso no ERP não permite esta rotina fiscal. Peça ao administrador em Pessoas e acessos.");
    if (response.status >= 500) throw new ApiError(503, "dependency_unavailable", "O ERP está temporariamente indisponível. Tente de novo em instantes.");
    throw new ApiError(400, "invalid_request", "O ERP recusou o pedido. Confira os dados e tente de novo.");
  }
  return body;
}

/** GET/POST /api/v1/profiles/:profile/erp-reforma/… */
export async function erpReformaRoute(env: Env, request: Request, profile: string, actor: Actor): Promise<Response> {
  if (!canProfile(actor, profile)) throw new ApiError(404, "not_found", "Área de atendimento não encontrada.");
  const url = new URL(request.url);
  const marker = `/profiles/${encodeURIComponent(profile)}/`;
  const path = url.pathname.slice(url.pathname.indexOf(marker) + marker.length);
  const match = erpReformOperationFor(request.method, path);
  if (!match) throw new ApiError(404, "not_found", "Rota não encontrada.");
  if (actor.kind !== "user" || actor.via) throw new ApiError(403, "user_required", "A reforma tributária do ERP é usada pela tela, por uma pessoa da área.");
  await requireModule(env, profile, "erp");
  const { operation, params } = match;
  const body = operation.method === "GET" ? undefined : await request.json<Record<string, unknown>>().catch(() => bad("Corpo do pedido inválido."));
  if (body !== undefined && (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !operation.body.includes(key))))
    bad(`Informe só: ${operation.body.join(", ")}.`);
  const states = await moduleStates(env, profile);
  const off = erpPartOffMessage(operation.parts[0], erpRequirement(...operation.parts), states);
  if (off) throw new ApiError(409, "module_disabled", off);
  let args: Record<string, unknown>;
  try {
    args = reformRpcArgs(operation, params, url.searchParams, body, () => crypto.randomUUID());
  } catch (error) {
    if (error instanceof ReformArgsError) throw new ApiError(400, "invalid_request", error.message);
    throw error;
  }
  const result = await callReformRpc(env, profile, actor, url.pathname, request.method, operation, args);
  if (operation.name === "erp.reforma.relatorio" && url.searchParams.get("formato") === "csv") {
    const report = result as ReformReport;
    return new Response(reformReportCsv(report), { headers: { ...noStore, "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="reforma-ibs-cbs-is_${report.from}_a_${report.to}.csv"`, "X-Content-Type-Options": "nosniff" } });
  }
  return json(result);
}
