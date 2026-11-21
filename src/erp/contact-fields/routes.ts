// Campos próprios de contato do ERP: /api/v1/profiles/:profile/erp-contato-campos
// (contrato em ./contract.ts; regras no motor, src/erp/domains/catalog/contact-fields.ts).
//
//   GET    ?para=admin|cadastro|ficha|lista      definições (Preferências › Cadastros, cadastro, ficha, lista)
//   POST                                         criar campo {command_id, data}
//   PATCH  /:id                                  alterar campo {command_id, expected_version, data}
//   POST   /:id/excluir                          excluir campo {command_id, expected_version}
//   GET    /contato/:id?para=cadastro|ficha      campos e valores de um contato
//   PUT    /contato/:id                          gravar valores {command_id, valores}
//   POST   /valores                              valores de até 100 contatos {ids} (colunas e exportação)
//   POST   /importar                             valores da importação {command_id, itens:[{contato, valores}]}
//   GET    /lista?…&campos=[…]                   lista de contatos com filtro de campo próprio
//
// Pessoa da área com papel no ERP; só a parte Cadastros (módulo erp) precisa
// estar ligada. Pelo bot (ou aplicação): só as três operações de ./contract.ts,
// concedidas pelo administrador, e a gravação com a proposta confirmada pela
// pessoa; nesse caminho o motor nunca entrega campo sensível não liberado.
import { ApiError, type Actor, type Env } from "../../types";
import { canProfile } from "../../security";
import { requireModule } from "../../modules/registry";
import { erpBotDelegation } from "../../modules/erp/bot-access";
import { erpIdentity } from "../../modules/erp/identity";
import { localFetch } from "../api/local-fetch";
import { erpContactFieldOperationFor } from "./contract.ts";

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL = "https://erp.wabotia.invalid";
const AUDIENCE: Record<string, string> = { admin: "admin", cadastro: "panel", ficha: "card", lista: "list" };
const invalid = (message: string): never => { throw new ApiError(400, "invalid_request", message); };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

const FIELD_PROBLEMS: Record<string, string> = {
  name: "Informe o nome do campo com até 60 caracteres, sem quebra de linha.",
  field_type: "Escolha o tipo do campo: texto, número, data, lista de opções ou sim/não.",
  roles: "Marque para quais tipos de contato o campo vale: cliente, fornecedor, vendedor ou transportadora.",
  options: "A lista precisa de 1 a 50 opções, cada uma com até 60 caracteres.",
  options_repeated: "Há opções repetidas na lista. Deixe cada opção uma vez só.",
};
const VALUE_PROBLEMS: Record<string, (name: string) => string> = {
  required: n => `Preencha o campo ${n}: ele é obrigatório.`,
  text: n => `Confira o campo ${n}: até 255 caracteres, em uma linha.`,
  number: n => `Informe em ${n} um número com até 15 dígitos e 6 casas decimais (vírgula ou ponto, sem separador de milhar).`,
  date: n => `Informe em ${n} uma data válida (DD/MM/AAAA).`,
  list: n => `Escolha em ${n} uma das opções da lista.`,
  boolean: n => `Responda ${n} com Sim ou Não.`,
  not_applicable: n => `O campo ${n} não vale para este tipo de contato.`,
  inactive: n => `O campo ${n} está inativo. Reative-o em Preferências › Cadastros para preencher.`,
  unknown: () => "Um dos campos enviados não existe (ou não está liberado para este acesso). Atualize a tela.",
  not_found: () => "Contato não encontrado no ERP.",
  not_visible: () => "Este contato é da carteira de outro vendedor.",
};
export const contactFieldValueMessage = (error: { code: string; name: string | null }) =>
  (VALUE_PROBLEMS[error.code] ?? (() => "Confira os campos próprios e tente de novo."))(error.name ?? "do contato");

/** Recusa do motor em palavras: o que aconteceu e o que fazer. */
function refusal(status: number, body: any): ApiError {
  const message = String(body?.message ?? body?.error?.code ?? ""), code = String(body?.code ?? "");
  if (status >= 500) return new ApiError(503, "dependency_unavailable", "O ERP não respondeu agora. Tente de novo em instantes.");
  if (code === "module_disabled" || message === "module_disabled" || status === 409 && /parte desligada/.test(String(body?.message)))
    return new ApiError(409, "module_disabled", "Ligue o módulo Cadastros do ERP para usar os campos próprios de contato.");
  if (message === "erp_contact_field_permission") return new ApiError(403, "forbidden", "Só o administrador do ERP cria, altera, exclui ou libera campos próprios de contato.");
  if (message === "erp_catalog_contact_not_visible") return new ApiError(403, "forbidden", "Este contato é da carteira de outro vendedor. Peça ao administrador se precisar dele.");
  if (message === "erp_customer_restricted") return new ApiError(403, "erp_customer_restricted", "Este cadastro está restrito nesta área.");
  if (status === 403 || code === "42501") return new ApiError(403, "forbidden", "Seu papel no ERP não permite esta operação nos contatos. Peça ao administrador em Pessoas e acessos.");
  if (message === "erp_catalog_not_found") return new ApiError(404, "not_found", "Contato não encontrado no ERP.");
  if (message === "erp_contact_field_not_found") return new ApiError(404, "not_found", "Campo não encontrado: ele pode ter sido excluído. Atualize a tela.");
  if (message === "erp_contact_field_conflict") return new ApiError(409, "conflict", "O campo foi alterado por outra pessoa. Atualize a tela e tente de novo.");
  if (message === "erp_catalog_command_conflict") return new ApiError(409, "conflict", "Este pedido já foi usado com outros dados. Atualize a tela e tente de novo.");
  if (message === "erp_contact_field_exposure_ack") return new ApiError(400, "exposure_ack_required", "Para liberar um campo sensível, leia o aviso e confirme.");
  if (message === "erp_contact_field_filter_unavailable") return new ApiError(400, "invalid_request", "Este campo não pode ser usado como filtro da lista. Atualize a tela.");
  if (message === "erp_catalog_invalid_query") return new ApiError(400, "invalid_request", "Confira os filtros da lista (datas e números de/até, opções).");
  const field = /^erp_contact_field_invalid:(\w+)$/.exec(message);
  if (field) return new ApiError(400, "invalid_request", FIELD_PROBLEMS[field[1]!] ?? "Confira os dados do campo e tente de novo.");
  if (message.startsWith("erp_contact_field_invalid")) return new ApiError(400, "invalid_request", "Pedido com formato inválido. Atualize a tela e tente de novo.");
  return new ApiError(400, "invalid_request", "O ERP recusou o pedido. Confira os dados e tente de novo.");
}

const GATE: Record<string, string> = {
  outside_schedule: "Fora do horário de acesso ao ERP definido para você. Tente no horário liberado ou fale com o administrador.",
  mfa_required: "Confirme o segundo fator de acesso para continuar no ERP.",
  agent_out_of_scope: "Este acesso automático não alcança o ERP.",
};

async function rpc(env: Env, profile: string, actor: Actor, method: string, path: string, name: string, args: Record<string, unknown>, read: boolean) {
  const identity = await erpIdentity(env, actor, profile, method, path);
  const gate = { denied: null as string | null, partsDenied: undefined as string | undefined };
  let response: Response;
  try {
    response = await localFetch(env, profile, actor, identity, { read, gate, trackCustomers: false })(
      `${LOCAL}/rest/v1/rpc/${name}`, { method: "POST", body: JSON.stringify({ ...args, p_user_id: identity.actor!.user_id }) });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, "dependency_unavailable", "O ERP não respondeu agora. Tente de novo em instantes.");
  }
  if (gate.partsDenied) throw new ApiError(409, "module_disabled", "Ligue o módulo Cadastros do ERP para usar os campos próprios de contato.");
  if (gate.denied) throw new ApiError(403, "forbidden", GATE[gate.denied] ?? GATE.outside_schedule!);
  const body = await response.json<any>().catch(() => null);
  if (!response.ok) throw refusal(response.status, body);
  if (!object(body)) throw new ApiError(503, "dependency_unavailable", "Resposta do ERP inválida. Tente de novo em instantes.");
  return body;
}

function uuidOf(value: unknown, what: string): string {
  if (typeof value !== "string" || !UUID.test(value)) invalid(`Identificador ${what} inválido.`);
  return (value as string).toLowerCase();
}
function onlyKeys(body: Record<string, unknown>, keys: string[]) {
  if (Object.keys(body).some(k => !keys.includes(k))) invalid(`Informe só: ${keys.join(", ")}.`);
}
/** Valores recusados: 400 com a primeira mensagem e a lista (campos) para a tela marcar cada campo. */
function valueErrors(result: any): Response {
  const errors = Array.isArray(result.errors) ? result.errors : [];
  return json({ error: { code: "invalid_values", message: errors.length ? contactFieldValueMessage(errors[0]) : "Confira os campos próprios e tente de novo.",
    campos: errors.map((e: any) => ({ field_id: e.field_id, code: e.code, message: contactFieldValueMessage(e) })) } }, 400);
}

const LIST_PARAMS: Record<string, string> = { page: "p_page", size: "p_size", sort: "p_sort", q: "p_query", situation: "p_situation", type: "p_type",
  person_type: "p_person_type", state: "p_state", city: "p_city", phone: "p_phone", email: "p_email", seller_id: "p_seller_id", period: "p_period",
  from: "p_from", to: "p_to", tag: "p_tag", price_list_id: "p_price_list_id" };
function listArgs(params: URLSearchParams): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const key of params.keys()) {
    if (params.getAll(key).length !== 1) invalid("Filtro repetido na lista.");
    const value = params.get(key)!;
    if (key === "campos") {
      let parsed: unknown;
      try { parsed = JSON.parse(value); } catch { invalid("Filtro de campo próprio inválido."); }
      if (!Array.isArray(parsed) || parsed.length > 10) invalid("Use até 10 filtros de campos próprios.");
      args.p_fields = parsed;
    } else if (key === "sale_statuses") args.p_sale_statuses = value.split(",").filter(Boolean);
    else if (LIST_PARAMS[key]) args[LIST_PARAMS[key]!] = ["page", "size"].includes(key) ? (/^[1-9]\d{0,5}$/.test(value) ? Number(value) : invalid("Página inválida.")) : value;
    else invalid(`Filtro desconhecido: ${key}.`);
  }
  return args;
}

/** GET/POST/PATCH/PUT /api/v1/profiles/:profile/erp-contato-campos[/…]. */
export async function erpContactFieldsRoute(env: Env, request: Request, profile: string, actor: Actor): Promise<Response> {
  if (!canProfile(actor, profile)) throw new ApiError(404, "not_found", "Área de atendimento não encontrada.");
  const url = new URL(request.url);
  const marker = `/profiles/${encodeURIComponent(profile)}/`;
  const path = decodeURIComponent(url.pathname.slice(url.pathname.indexOf(marker) + marker.length)).replace(/\/$/, "");
  const rest = path.split("/").slice(1);
  const method = request.method.toUpperCase() === "HEAD" ? "GET" : request.method.toUpperCase();
  if (actor.kind !== "user" && actor.kind !== "app")
    throw new ApiError(403, "user_required", "Os campos próprios de contato são usados por uma pessoa da área, por um bot liberado ou por uma aplicação com acesso ao ERP.");
  await requireModule(env, profile, "erp");
  const body = method === "GET" ? undefined : await request.json<unknown>().catch(() => invalid("Corpo do pedido inválido."));
  if (body !== undefined && !object(body)) invalid("Corpo do pedido inválido.");
  // Bot e aplicação: só as operações do contrato; o bot, com a concessão do administrador (e a proposta confirmada para gravar).
  const agent = !!actor.via || actor.kind === "app";
  if (agent) {
    const operation = erpContactFieldOperationFor(method, path);
    if (!operation) throw new ApiError(403, "erp_bot_grant_required", "Esta operação de campos próprios de contato não está disponível para bots e aplicações.");
    if (actor.via && !await erpBotDelegation(env, actor, profile, method, url.pathname, body))
      throw new ApiError(403, "erp_bot_grant_required", "Esta operação de campos próprios de contato não foi liberada para este bot, ou falta a confirmação da pessoa.");
  }
  const call = (name: string, args: Record<string, unknown>, read = method === "GET") => rpc(env, profile, actor, method, url.pathname, name, args, read);
  const audience = (fallback: string, allowed: string[]) => {
    if (agent) return "agent";
    const asked = url.searchParams.get("para");
    if (asked === null) return fallback;
    const value = AUDIENCE[asked];
    if (!value || !allowed.includes(value)) invalid(`para: use ${allowed.map(a => Object.keys(AUDIENCE).find(k => AUDIENCE[k] === a)).join(" ou ")}.`);
    return value!;
  };
  const extraParams = (allowed: string[]) => { for (const key of url.searchParams.keys()) if (!allowed.includes(key)) invalid(`Parâmetro desconhecido: ${key}.`); };

  // Definições.
  if (rest.length === 0 && method === "GET") {
    extraParams(["para"]);
    return json(await call("erp_catalog_contact_fields", { p_audience: audience("panel", ["admin", "panel", "card", "list"]) }));
  }
  if (rest.length === 0 && method === "POST") {
    onlyKeys(body as Record<string, unknown>, ["command_id", "data"]);
    const b = body as Record<string, unknown>;
    return json(await call("erp_catalog_contact_field_save", { p_id: null, p_expected_version: 0, p_command_id: uuidOf(b.command_id, "do pedido"), p_data: b.data ?? null }));
  }
  if (rest.length === 1 && UUID.test(rest[0]!) && method === "PATCH") {
    onlyKeys(body as Record<string, unknown>, ["command_id", "expected_version", "data"]);
    const b = body as Record<string, unknown>;
    if (!Number.isSafeInteger(b.expected_version)) invalid("Versão do campo inválida. Atualize a tela.");
    return json(await call("erp_catalog_contact_field_save", { p_id: rest[0]!.toLowerCase(), p_expected_version: b.expected_version, p_command_id: uuidOf(b.command_id, "do pedido"), p_data: b.data ?? null }));
  }
  if (rest.length === 2 && UUID.test(rest[0]!) && rest[1] === "excluir" && method === "POST") {
    onlyKeys(body as Record<string, unknown>, ["command_id", "expected_version"]);
    const b = body as Record<string, unknown>;
    if (!Number.isSafeInteger(b.expected_version)) invalid("Versão do campo inválida. Atualize a tela.");
    return json(await call("erp_catalog_contact_field_delete", { p_id: rest[0]!.toLowerCase(), p_expected_version: b.expected_version, p_command_id: uuidOf(b.command_id, "do pedido") }, false));
  }
  // Valores de um contato.
  if (rest.length === 2 && rest[0] === "contato" && method === "GET") {
    extraParams(["para"]);
    return json(await call("erp_catalog_contact_field_values", { p_contact_id: uuidOf(rest[1], "do contato"), p_audience: audience("panel", ["panel", "card"]) }));
  }
  if (rest.length === 2 && rest[0] === "contato" && method === "PUT") {
    onlyKeys(body as Record<string, unknown>, ["command_id", "valores"]);
    const b = body as Record<string, unknown>;
    if (!object(b.valores)) invalid("valores: informe um objeto com o id do campo e o valor.");
    const result = await call("erp_catalog_contact_field_values_save", { p_contact_id: uuidOf(rest[1], "do contato"), p_command_id: uuidOf(b.command_id, "do pedido"),
      p_values: b.valores, p_audience: agent ? "agent" : "panel" });
    return result.saved === false ? valueErrors(result) : json(result);
  }
  // Lote: colunas da lista e exportação.
  if (rest.length === 1 && rest[0] === "valores" && method === "POST") {
    onlyKeys(body as Record<string, unknown>, ["ids"]);
    const ids = (body as Record<string, unknown>).ids;
    if (!Array.isArray(ids) || ids.length > 100) invalid("ids: até 100 contatos por vez.");
    return json(await call("erp_catalog_contact_field_bulk", { p_ids: (ids as unknown[]).map(id => uuidOf(id, "do contato")), p_audience: "list" }, true));
  }
  if (rest.length === 1 && rest[0] === "importar" && method === "POST") {
    onlyKeys(body as Record<string, unknown>, ["command_id", "itens"]);
    const b = body as Record<string, unknown>;
    if (!Array.isArray(b.itens) || !b.itens.length || b.itens.length > 50) invalid("itens: de 1 a 50 contatos por lote.");
    const items = (b.itens as unknown[]).map(item => {
      if (!object(item) || Object.keys(item).some(k => k !== "contato" && k !== "valores") || !object(item.valores)) invalid("Cada item precisa de contato e valores.");
      return { contact_id: uuidOf((item as Record<string, unknown>).contato, "do contato"), values: (item as Record<string, unknown>).valores };
    });
    const result = await call("erp_catalog_contact_field_bulk_save", { p_command_id: uuidOf(b.command_id, "do pedido"), p_items: items, p_audience: "panel" }, false);
    return json({ ...result, items: (result.items as any[]).map(item => item.saved ? item : { ...item, errors: item.errors.map((e: any) => ({ ...e, message: contactFieldValueMessage(e) })) }) });
  }
  if (rest.length === 1 && rest[0] === "lista" && method === "GET")
    return json(await call("erp_catalog_contact_field_page", listArgs(url.searchParams)));
  throw new ApiError(404, "not_found", "Rota não encontrada.");
}
