// Rotas dos Contratos de serviço, em /api/v1/profiles/:profile/erp-contratos
// (operações e argumentos em ./contract.ts).
//
// Conferências: pessoa da área com papel no ERP (ou o bot com a operação
// concedida e, nas sensíveis, a proposta que a pessoa confirmou), a parte
// Contratos ligada (e o Financeiro, de que ela depende) — desligada: 409
// module_disabled dizendo qual ligar. O motor confere de novo papel,
// permissão, horário de acesso e segundo fator (o portão roda no objeto).
// O anexo (PDF do contrato assinado) fica no R2 da área (MEDIA), na chave
// erp/<área>/contratos/<contrato>/<sha256>.pdf; o motor guarda só o índice.
import { ApiError, type Actor, type Env } from "../../types";
import { canProfile, sha } from "../../security";
import { moduleStates } from "../../modules/registry";
import { erpBotDelegation } from "../../modules/erp/bot-access";
import { erpIdentity } from "../../modules/erp/identity";
import { localFetch } from "../api/local-fetch.ts";
import { erpPartOffMessage, erpRequirement } from "../parts.ts";
import { ContractArgsError, ERP_CONTRATOS_PART, contractRpcArgs, erpContractOperationFor, uuidArg, type ErpContractOperation } from "./contract.ts";

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const bad = (message: string): never => { throw new ApiError(400, "invalid_request", message); };
export const CONTRACT_FILE_MAX_BYTES = 10 * 1024 * 1024;
const PART_OFF = "Esta rotina depende de uma parte do ERP desligada (Contratos ou Financeiro). Ligue em Gestão → Módulos.";

/** Motivos conhecidos do motor, em palavras de quem usa. */
export const CONTRACT_REASONS: Readonly<Record<string, [number, string, string]>> = {
  erp_contract_access_denied: [403, "forbidden", "Seu papel no ERP não alcança os contratos. Os contratos são de quem tem o papel Financeiro ou Administrador (Consulta e Vendas só veem). Peça ao administrador em Pessoas e acessos."],
  erp_contract_write_denied: [403, "forbidden", "Seu papel no ERP só consulta os contratos. Para cadastrar, ativar, reajustar ou encerrar, peça ao administrador o papel Financeiro."],
  erp_contract_bill_denied: [403, "forbidden", "Gerar a conta à mão pede a permissão de incluir contas a receber. Peça ao administrador em Pessoas e acessos."],
  erp_contract_not_found: [404, "not_found", "O contrato não foi encontrado. Atualize a lista."],
  erp_contract_invoice_not_found: [404, "not_found", "A fatura não foi encontrada. Atualize o contrato."],
  erp_contract_notice_not_found: [404, "not_found", "O aviso não foi encontrado. Atualize a lista de avisos."],
  erp_contract_attachment_not_found: [404, "not_found", "O anexo não foi encontrado. Atualize o contrato."],
  erp_contract_contact_not_found: [404, "not_found", "O cliente não foi encontrado. Escolha de novo na busca."],
  erp_contract_product_not_found: [404, "not_found", "O serviço não foi encontrado no catálogo. Escolha de novo na busca."],
  erp_contract_category_not_found: [404, "not_found", "A categoria não foi encontrada. Escolha outra."],
  erp_contract_payment_not_found: [404, "not_found", "A forma de pagamento não foi encontrada. Escolha outra."],
  erp_contract_seller_not_found: [404, "not_found", "O vendedor não foi encontrado ou está inativo. Escolha outro."],
  erp_contract_bling_not_found: [404, "not_found", "Este contrato não está no acervo do Bling. Faça uma coleta nova em Receber dados do Bling."],
  erp_contract_bling_unavailable: [409, "bling_unavailable", "O acervo do Bling não está disponível nesta área. Conecte e colete em Receber dados do Bling."],
  erp_contract_version_conflict: [409, "conflict", "O contrato mudou depois que você abriu (outra pessoa ou outra aba). Atualize e confira de novo."],
  erp_contract_command_conflict: [409, "conflict", "Este pedido já foi usado com outros dados. Atualize a tela e tente de novo."],
  erp_contract_invalid: [400, "invalid_request", "Confira os dados do contrato e tente de novo."],
  erp_contract_invalid_query: [400, "invalid_request", "Confira os filtros (o período começa antes de terminar)."],
  erp_contract_invalid_date: [400, "invalid_request", "Confira a data (dia, mês e ano válidos, a partir do início do contrato)."],
  erp_contract_invalid_month: [400, "invalid_request", "Informe o mês como 2027-03."],
  erp_contract_invalid_items: [400, "invalid_request", "Informe pelo menos um item (até 50), cada um com serviço ou descrição."],
  erp_contract_invalid_quantity: [400, "invalid_request", "A quantidade de cada item precisa ser maior que zero, com até 6 casas decimais."],
  erp_contract_invalid_price: [400, "invalid_request", "Informe o valor de cada item em reais, como 350,00."],
  erp_contract_invalid_percent: [400, "invalid_request", "Informe o percentual com até 4 casas, como 4,56."],
  erp_contract_invalid_index: [400, "invalid_request", "Escolha o índice: IPCA, IGP-M, INPC ou percentual fixo."],
  erp_contract_invalid_adjustment: [400, "invalid_request", "Confira o reajuste: índice, mês de aniversário (1 a 12) e, no fixo, o percentual."],
  erp_contract_invalid_periodicity: [400, "invalid_request", "Escolha a periodicidade: mensal, bimestral, trimestral, semestral ou anual."],
  erp_contract_invalid_due_day: [400, "invalid_request", "O dia de vencimento vai de 1 a 31 (nos meses mais curtos, vence no último dia)."],
  erp_contract_invalid_term: [400, "invalid_request", "O prazo da renovação vai de 1 a 600 meses."],
  erp_contract_invalid_notice_days: [400, "invalid_request", "O aviso de renovação vai de 0 a 365 dias antes do fim."],
  erp_contract_invalid_period: [400, "invalid_request", "O fim da vigência precisa vir depois do início."],
  erp_contract_invalid_billing_start: [400, "invalid_request", "Escolha o começo de um período do contrato, dentro da vigência."],
  erp_contract_invalid_period_start: [400, "invalid_request", "Escolha o começo de um período do contrato, dentro da vigência."],
  erp_contract_invalid_renewal: [400, "invalid_request", "O novo fim precisa vir depois do fim atual."],
  erp_contract_invalid_file: [400, "invalid_request", "Envie o contrato em PDF, com até 10 MB."],
  erp_contract_contact_inactive: [400, "invalid_request", "O cliente está inativo. Reative o cadastro em Contatos ou escolha outro."],
  erp_contract_product_inactive: [400, "invalid_request", "O serviço está inativo no catálogo. Reative em Produtos ou escolha outro."],
  erp_contract_category_invalid: [400, "invalid_request", "A categoria precisa ser de receita e estar ativa."],
  erp_contract_payment_invalid: [400, "invalid_request", "A forma de pagamento precisa estar ativa e valer para recebimentos."],
  erp_contract_contact_id_required: [400, "invalid_request", "Escolha o cliente do contrato."],
  erp_contract_object_required: [400, "invalid_request", "Escreva o objeto do contrato (o que é prestado)."],
  erp_contract_object_required_required: [400, "invalid_request", "Escreva o objeto do contrato (o que é prestado)."],
  erp_contract_starts_on_required: [400, "invalid_request", "Informe o início da vigência."],
  erp_contract_periodicity_required: [400, "invalid_request", "Escolha a periodicidade do faturamento."],
  erp_contract_due_day_required: [400, "invalid_request", "Informe o dia de vencimento."],
  erp_contract_reason_required: [400, "invalid_request", "Escreva o motivo (pelo menos 3 letras)."],
  erp_contract_no_value: [400, "invalid_request", "O contrato não tem valor nos itens. Informe o valor dos itens antes."],
  erp_contract_not_editable: [409, "conflict", "Contrato encerrado não muda."],
  erp_contract_not_active: [409, "conflict", "Isto só vale para contrato ativo (ou suspenso). Ative o contrato antes."],
  erp_contract_locked_field: [409, "conflict", "Depois de ativo, cliente, início, fim, periodicidade e itens só mudam por aditivo ou renovação."],
  erp_contract_status_invalid: [409, "conflict", "Essa mudança não vale para a situação atual do contrato. Atualize o contrato."],
  erp_contract_period_billed: [409, "conflict", "A conta deste período já foi gerada. Veja nas faturas do contrato."],
  erp_contract_invoice_state: [409, "conflict", "A nota desta fatura não estava marcada para emitir."],
  erp_contract_future_change: [409, "conflict", "Há um aditivo ou reajuste agendado depois desta data. Use uma data a partir dele."],
  erp_contract_amendment_empty: [400, "invalid_request", "O aditivo não muda nada: mude os itens ou o fim da vigência."],
  erp_contract_indefinite: [409, "conflict", "O contrato é por prazo indeterminado: não há o que renovar."],
  erp_contract_adjustment_missing: [409, "conflict", "O contrato não tem reajuste configurado. Escolha o índice e o mês de aniversário no cadastro."],
  erp_contract_adjustment_month_changed: [409, "conflict", "O mês do reajuste mudou depois da prévia (outro reajuste foi aplicado). Confira a prévia de novo."],
  erp_contract_adjustment_too_early: [409, "conflict", "Ainda não chegou o mês de aniversário deste reajuste."],
  erp_contract_rate_missing: [409, "rate_missing", "O índice do mês de referência ainda não foi informado. Informe na tabela de índices e confira a prévia de novo."],
  erp_contract_rate_changed: [409, "conflict", "O percentual mudou depois da prévia (a tabela de índices foi alterada). Confira a prévia de novo."],
  erp_contract_bling_changed: [409, "conflict", "O contrato mudou no Bling depois da prévia. Confira de novo antes de adotar."],
  erp_contract_bling_linked: [409, "conflict", "Este contrato do Bling já virou contrato de serviço."],
  erp_contract_bling_maintenance: [409, "conflict", "Este contrato do Bling já virou contrato de manutenção da Ordem de Serviço. Para não cobrar duas vezes, ele não vira contrato de serviço."],
  erp_contract_bling_incomplete: [400, "invalid_request", "O contrato do Bling está incompleto: falta o cliente adotado, a data de início, o valor ou a periodicidade. Veja os problemas na prévia."],
  erp_finance_permission_denied: [403, "forbidden", "Seu acesso ao Financeiro não permite incluir contas a receber. Peça ao administrador em Pessoas e acessos."],
};

/** O comando: o do corpo, o da Idempotency-Key ou o do próprio pedido (a repetição devolve o mesmo resultado). */
async function commandId(value: unknown, idempotency: string | null, profile: string, name: string, body: Record<string, unknown>) {
  if (value !== undefined && value !== null) return uuidArg(value, "comando", true)!;
  const seed = idempotency && idempotency.length <= 200 ? `key:${idempotency}` : `body:${JSON.stringify(body)}`;
  const hash = await sha(JSON.stringify(["wabotia-erp-contratos-v1", profile, name, seed]));
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${((parseInt(hash[16], 16) & 3) | 8).toString(16)}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** Recusa do motor em palavras de quem usa: status HTTP, código e mensagem. */
export function contractFailure(status: number, body: any): ApiError {
  const code = typeof body?.message === "string" ? body.message : typeof body?.code === "string" ? body.code : "";
  if (body?.code === "module_disabled" || status === 409 && /parte desligada/.test(code)) return new ApiError(409, "module_disabled", PART_OFF);
  const known = CONTRACT_REASONS[code];
  if (known) return new ApiError(known[0], known[1], known[2]);
  if (status === 403 || body?.code === "42501") return new ApiError(403, "forbidden", "Seu acesso no ERP não permite esta operação. Peça ao administrador em Pessoas e acessos.");
  if (status >= 500) return new ApiError(503, "dependency_unavailable", "O ERP está temporariamente indisponível. Tente de novo em instantes.");
  return new ApiError(400, "invalid_request", "O ERP recusou o pedido. Confira os dados e tente de novo.");
}

async function callContractRpc(env: Env, profile: string, actor: Actor, pathname: string, method: string, rpc: string, args: Record<string, unknown>) {
  const identity = await erpIdentity(env, actor, profile, method, pathname);
  const gate = { denied: null as string | null, partsDenied: undefined as string | undefined };
  let response: Response;
  try {
    response = await localFetch(env, profile, actor, identity, { read: method === "GET", gate, trackCustomers: false })(
      `https://erp.wabotia.invalid/rest/v1/rpc/${rpc}`, { method: "POST", body: JSON.stringify({ ...args, p_user_id: identity.actor!.user_id }) });
  } catch (error) {
    if ((error as { code?: string })?.code === "erp_unavailable") throw new ApiError(503, "dependency_unavailable", "O ERP está temporariamente indisponível. Tente de novo em instantes.");
    throw error;
  }
  if (gate.partsDenied === "module_disabled") throw new ApiError(409, "module_disabled", PART_OFF);
  if (gate.denied) throw new ApiError(403, gate.denied === "mfa_required" ? "erp_mfa_required" : "erp_access_denied",
    gate.denied === "mfa_required" ? "O ERP desta área pede o segundo fator para o seu papel. Confirme o código em Minha conta e tente de novo."
      : "Seu acesso ao ERP está fora do horário permitido agora. Fale com o administrador.");
  const body = await response.json<any>().catch(() => null);
  if (!response.ok) throw contractFailure(response.status, body);
  return body;
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
/** Chave do PDF no R2 da área (o motor confere o final: /contratos/<contrato>/<sha256>.pdf). */
export const contractFileKey = (profile: string, contract: string, sha256: string) => `erp/${profile}/contratos/${contract}/${sha256}.pdf`;
/** "Contrato assinado.pdf" → nome seguro para o cabeçalho de download. */
const safeName = (name: string) => name.replace(/[^\p{L}\p{N} ._()-]+/gu, "_").slice(0, 120) || "contrato.pdf";

/** Envio do anexo: o corpo é o PDF; vai para o R2 e o índice para o motor. */
async function uploadAttachment(env: Env, request: Request, profile: string, actor: Actor, url: URL, operation: ErpContractOperation, params: Record<string, string>) {
  const contract = uuidArg(params.id, "id", true)!;
  const name = (url.searchParams.get("nome") ?? "").trim();
  if (!name || name.length > 200) bad("nome: informe o nome do arquivo (até 200 caracteres).");
  for (const key of url.searchParams.keys()) if (key !== "nome") bad(`Parâmetro não aceito: ${key}. Use nome.`);
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > CONTRACT_FILE_MAX_BYTES) throw new ApiError(413, "file_too_large", "O PDF passa de 10 MB. Reduza o arquivo (por exemplo, digitalizando em preto e branco) e envie de novo.");
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength) bad("Envie o arquivo PDF do contrato.");
  if (bytes.byteLength > CONTRACT_FILE_MAX_BYTES) throw new ApiError(413, "file_too_large", "O PDF passa de 10 MB. Reduza o arquivo (por exemplo, digitalizando em preto e branco) e envie de novo.");
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") throw new ApiError(415, "unsupported_file", "O arquivo não é um PDF. Salve o contrato assinado em PDF e envie de novo.");
  const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
  const key = contractFileKey(profile, contract, sha256);
  // Confere o contrato (e o acesso) antes de gravar no R2.
  await callContractRpc(env, profile, actor, url.pathname, "GET", "erp_contract_get", { p_args: { id: contract } });
  await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: "application/pdf" } });
  const command = await commandId(undefined, request.headers.get("Idempotency-Key"), profile, operation.name, { contract, sha256, name });
  return json(await callContractRpc(env, profile, actor, url.pathname, "POST", operation.rpc, {
    p_command_id: command, p_data: { contract_id: contract, filename: name, size_bytes: bytes.byteLength, sha256, storage_key: key },
  }));
}

/** GET/POST /api/v1/profiles/:profile/erp-contratos/… */
export async function erpContratosRoute(env: Env, request: Request, profile: string, actor: Actor): Promise<Response> {
  if (!canProfile(actor, profile)) throw new ApiError(404, "not_found", "Área de atendimento não encontrada.");
  const url = new URL(request.url);
  const marker = `/profiles/${encodeURIComponent(profile)}/`;
  const path = url.pathname.slice(url.pathname.indexOf(marker) + marker.length);
  const match = erpContractOperationFor(request.method, path);
  if (!match) throw new ApiError(404, "not_found", "Rota não encontrada.");
  if (actor.kind !== "user")
    throw new ApiError(403, "user_required", "Os contratos do ERP atendem uma pessoa da área (ou o bot, com a operação liberada por ela).");
  const { operation, params } = match;
  // Parte desligada antes de qualquer outra conferência: diz qual módulo ligar (e de quem ele depende).
  const states = await moduleStates(env, profile);
  const off = erpPartOffMessage(ERP_CONTRATOS_PART, erpRequirement(ERP_CONTRATOS_PART), states);
  if (off) throw new ApiError(409, "module_disabled", off);
  if (actor.via && operation.bot === false) throw new ApiError(403, "erp_bot_grant_required", "Esta operação dos contratos é só pela tela, não pelo bot.");
  if (operation.name === "erp.contratos.anexo_enviar") return uploadAttachment(env, request, profile, actor, url, operation, params);
  if (operation.name === "erp.contratos.anexo_baixar") {
    const file = await callContractRpc(env, profile, actor, url.pathname, "GET", operation.rpc, { p_args: { id: uuidArg(params.id, "id", true) } });
    if (!String(file.storage_key).startsWith(`erp/${profile}/contratos/`)) throw new ApiError(409, "file_changed", "O anexo não confere com o guardado. Envie o PDF de novo.");
    const object = await env.MEDIA.get(String(file.storage_key));
    if (!object) throw new ApiError(404, "file_missing", "O PDF deste anexo não está mais guardado. Envie o arquivo de novo.");
    return new Response(object.body, { headers: { "Content-Type": "application/pdf", "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="${safeName(String(file.filename)).replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(String(file.filename))}` } });
  }
  const body = operation.method === "GET" ? undefined : await request.json<Record<string, unknown>>().catch(() => bad("Corpo do pedido inválido."));
  if (body !== undefined && (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !operation.body.includes(key))))
    bad(`Informe só: ${operation.body.join(", ")}.`);
  const pathKeys = (operation.path.match(/:[a-z_]+/g) ?? []).map((key) => key.slice(1));
  if (body !== undefined) for (const key of operation.required) if (!pathKeys.includes(key) && (body[key] === undefined || body[key] === null || body[key] === "")) bad(`${key}: obrigatório.`);
  // Pelo bot: a operação concedida a ele e, nas sensíveis, a proposta que a pessoa confirmou.
  if (actor.via && !await erpBotDelegation(env, actor, profile, request.method, url.pathname, body))
    throw new ApiError(403, "erp_bot_grant_required", "Esta operação dos contratos não foi liberada para este bot, ou falta a confirmação da pessoa.");
  const args = await contractRpcArgs(operation, params, url.searchParams, body, (sent) => commandId(sent.comando, request.headers.get("Idempotency-Key"), profile, operation.name, sent)).catch((error: unknown) => {
    throw error instanceof ContractArgsError ? new ApiError(400, "invalid_request", error.message) : error;
  });
  return json(await callContractRpc(env, profile, actor, url.pathname, request.method, operation.rpc, args));
}
