// Compra pela nota recebida: /api/v1/profiles/:area/erp-recebidas/* (operações
// em ./operations.ts). O Worker fala com o cofre da NFapi (só leitura das
// notas recebidas e a manifestação), guarda o XML no R2 da área (MEDIA) e
// chama o motor (src/erp/domains/inbound/rpc.ts) entre transações: nenhuma
// transação do motor espera o cofre.
//
// Regras do dono: nada busca no cofre sozinho; a busca e a manifestação em
// produção pedem a autorização explícita do administrador a cada vez; a
// manifestação nasce desligada (interruptor do administrador) e resultado
// incerto nunca é reenviado sem consultar o cofre e sem a pessoa confirmar.
import { ApiError, uid, type Actor, type Env } from "../../types";
import { canProfile, isEngineActor } from "../../security";
import { audit } from "../../events";
import { erpIdentity } from "../../modules/erp/identity";
import { erpBotDelegation } from "../../modules/erp/bot-access";
import { encodeIdentity, IDENTITY_HEADER, type IdentityPort } from "../engine/identity.ts";
import { erpFetch } from "../hub.ts";
import { ERP_PART_NAMES, type ErpModuleId } from "../parts.ts";
import { emissorConnection } from "../emissor/config.ts";
import { fiscalProviderFor } from "../emissor/index.ts";
import { FiscalError, type FiscalContext, type FiscalEnvironment, type FiscalReceivedNote } from "../emissor/provider.ts";
import { InboundXmlError, INBOUND_XML_MAX_BYTES, inboundXmlKey, parseInboundXml, xmlSha256 } from "./xml.ts";
import { RECEBIDAS_ROUTE, recebidasOperationFor, type RecebidasOperation } from "./operations.ts";
import { todaySaoPaulo as todayInSaoPaulo } from "../engine/time.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const noStore = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: noStore });

/** Parte do ERP (chave da identidade) de cada módulo. */
const PART_KEY: Partial<Record<ErpModuleId, string>> = {
  "erp-compras": "purchases", "erp-fiscal": "fiscal", "erp-estoque": "stock", "erp-financeiro": "finance", "erp-produtos": "products",
};

/** Mensagens dos recusados do motor, em palavras de quem usa a tela. */
const MESSAGES: Record<string, string> = {
  inbound_access_denied: "Seu acesso ao ERP desta área não está ativo. Peça ao administrador em Pessoas e acessos.",
  inbound_role_denied: "Seu papel no ERP não permite esta ação nas notas recebidas. Peça ao administrador (papéis: administrador, estoque, financeiro ou fiscal).",
  inbound_note_not_found: "Nota recebida não encontrada. Atualize a lista.",
  inbound_note_invalid: "Os dados da nota não puderam ser lidos. Importe o XML de novo.",
  inbound_access_key_invalid: "A chave de acesso da nota não é válida.",
  inbound_environment_invalid: "Escolha o ambiente: homologação ou produção.",
  inbound_company_document_missing: "Preencha o CNPJ em Dados da empresa antes de importar notas recebidas.",
  inbound_not_for_company: "Esta nota não é para a sua empresa: o CNPJ do destinatário não é o de Dados da empresa.",
  inbound_xml_conflict: "Já existe uma nota com esta chave e outro XML. Confira o arquivo com o fornecedor.",
  inbound_environment_conflict: "Esta chave já está na lista em outro ambiente.",
  inbound_xml_missing: "Esta nota ainda não tem o XML completo. Faça a ciência da operação ou importe o XML que o fornecedor mandou.",
  inbound_xml_changed: "O XML guardado não confere com o índice. Importe o XML de novo.",
  inbound_choices_invalid: "Alguma escolha da conferência não é válida. Atualize a tela e confira de novo.",
  inbound_factor_invalid: "Informe quantas unidades vêm em cada embalagem com até 6 casas (por exemplo, 12).",
  inbound_lot_invalid: "Informe o lote com até 60 caracteres e as datas no formato do calendário.",
  inbound_order_unavailable: "O pedido de compra escolhido não está mais em aberto para este fornecedor.",
  inbound_warehouse_unavailable: "O depósito escolhido não está ativo.",
  inbound_category_unavailable: "A categoria escolhida não é uma categoria de despesa ativa.",
  inbound_payment_method_unavailable: "A forma de pagamento escolhida não está ativa para pagamentos.",
  inbound_command_invalid: "Pedido sem identificador. Atualize a tela e tente de novo.",
  inbound_command_conflict: "Este pedido já foi usado para outra ação. Atualize a tela.",
  inbound_reason_required: "Escreva o motivo do estorno (de 3 a 500 caracteres).",
  inbound_entry_not_found: "Esta nota não tem entrada ativa para estornar.",
  inbound_reverse_stock_part_disabled: "A entrada lançou estoque e o Estoque está desligado. Ligue o Estoque em Gestão → Módulos para estornar.",
  inbound_reverse_finance_part_disabled: "A entrada gerou contas a pagar e o Financeiro está desligado. Ligue o Financeiro em Gestão → Módulos para estornar.",
  inbound_reverse_stock_role: "A entrada lançou estoque: o estorno precisa de alguém com papel de estoque ou administrador.",
  inbound_reverse_finance_role: "A entrada gerou contas a pagar: o estorno precisa de alguém com papel financeiro ou administrador.",
  inbound_title_not_found: "Uma conta a pagar desta entrada não foi encontrada no Financeiro.",
  inbound_settings_invalid: "Configuração inválida. Atualize a tela.",
  inbound_settings_version_conflict: "A configuração foi alterada por outra pessoa. Atualize a tela.",
  inbound_fiscal_act_acknowledgement_required: "Para permitir a manifestação, marque que você sabe que manifestar é ato fiscal perante a SEFAZ.",
  inbound_manifest_disabled: "A manifestação de notas recebidas está desligada. O administrador liga em Notas recebidas → Configuração.",
  inbound_manifest_type_invalid: "Escolha a manifestação: ciência, confirmação, desconhecimento ou operação não realizada.",
  inbound_justification_required: "A operação não realizada exige justificativa de 15 a 255 caracteres.",
  inbound_manifest_not_from_vault: "Esta nota foi importada pelo XML e não está no cofre: manifeste pelo portal da SEFAZ ou busque as notas no cofre.",
  inbound_manifest_pending_other: "Há outra manifestação desta nota sem resposta conclusiva. Consulte essa primeiro.",
  inbound_manifest_not_found: "Manifestação não encontrada.",
  inbound_production_authorization_required: "Em produção, só o administrador busca ou manifesta, e precisa marcar a autorização a cada vez.",
  inbound_vault_invalid: "O endereço do cofre configurado não é válido. Confira em Fiscal → Configuração do emissor.",
  inbound_fetch_not_claimed: "A busca no cofre não foi iniciada. Tente de novo.",
  erp_finance_active_payments: "Uma conta a pagar desta nota já tem pagamento. Estorne o pagamento no Financeiro antes de estornar a entrada.",
  erp_finance_billed_locked: "Uma conta a pagar desta nota está em cobrança no banco. Resolva a cobrança no Financeiro antes de estornar a entrada.",
  erp_finance_cancelled_title: "Uma conta a pagar desta nota já foi cancelada no Financeiro.",
  erp_finance_version_conflict: "Uma conta a pagar desta nota foi alterada agora. Atualize e tente de novo.",
  erp_finance_invalid_due_date: "Um vencimento da nota é anterior à emissão. Confira as duplicatas com o fornecedor.",
  erp_stock_insufficient_or_excess_quantity: "O estorno deixaria o estoque negativo ou a quantidade passa do limite. Confira as saídas do produto.",
  erp_stock_negative_balance: "O estorno deixaria o estoque negativo. Confira as saídas do produto antes de estornar.",
  erp_stock_insufficient: "O estorno deixaria o estoque negativo. Confira as saídas do produto antes de estornar.",
  erp_stock_lot_insufficient: "O lote desta nota já saiu do estoque. Confira as saídas do lote antes de estornar.",
  erp_stock_lot_expiry_required: "As preferências do estoque exigem a validade do lote. Informe a validade na conferência.",
  erp_stock_lot_manufacture_required: "As preferências do estoque exigem a data de fabricação do lote. Informe na conferência.",
  erp_stock_lot_invalid: "O lote ou as datas não são válidos (a fabricação não pode ser depois da validade).",
  erp_stock_lot_inactive: "O lote informado está inativo no estoque.",
  erp_stock_version_conflict: "O estoque do produto mudou agora. Atualize a conferência e tente de novo.",
  erp_stock_composition_launch_required: "Um produto é um kit que lança pelos componentes. Escolha outro produto para o item.",
  erp_stock_price_decimals_exceeded: "O custo passa das casas do preço de entrada. Confira a preferência de casas decimais.",
  erp_stock_reverse_via_document: "Este lançamento é de um documento e se estorna pelo documento.",
  erp_catalog_warning_unacknowledged: "O cadastro do fornecedor tem avisos a confirmar. Cadastre-o pela tela de contatos.",
  // Produto pelo XML, reposição e inventário.
  inbound_product_items_invalid: "Escolha os itens da nota que viram produto (com nome, unidade, NCM, CEST e GTIN em texto).",
  inbound_product_supplier_missing: "Cadastre o fornecedor da nota antes de cadastrar os produtos dela.",
  erp_catalog_access_denied: "Seu papel no ERP não cadastra produtos. Peça a alguém com o papel de estoque ou ao administrador.",
  erp_catalog_invalid_text: "Um dado do produto passa do tamanho aceito ou tem caractere inválido. Confira o nome e a unidade.",
  erp_catalog_invalid_identifier: "O CEST ou o GTIN do produto não é válido. Corrija ou apague o campo.",
  erp_catalog_invalid_data: "Os dados do produto não puderam ser gravados. Confira o nome, a unidade e o NCM.",
  inbound_replenishment_denied: "Seu papel no ERP não vê pedidos de compra, por isso não vê a reposição. Peça ao administrador.",
  inbound_replenishment_order_denied: "Seu papel no ERP não cria pedidos de compra. Peça a alguém com o papel de estoque ou ao administrador.",
  inbound_replenishment_invalid: "Alguma escolha da reposição não é válida. Atualize a tela e confira de novo.",
  inbound_warehouse_not_found: "O depósito escolhido não existe mais. Atualize a tela.",
  inbound_supplier_not_found: "O fornecedor escolhido não está ativo no cadastro de contatos.",
  inbound_inventory_date_invalid: "Escolha a data do inventário no calendário (entre 1900 e 2100).",
  inbound_inventory_invalid: "Algum filtro do inventário não é válido. Atualize a tela.",
  erp_stock_access_denied: "Seu papel no ERP não consulta o estoque. Peça ao administrador em Pessoas e acessos.",
  erp_document_access_denied: "Seu papel no ERP não cria pedidos de compra. Peça a alguém com o papel de estoque ou ao administrador.",
};
const PRODUCT_PROBLEMS: Record<string, string> = {
  name_missing: "falta o nome", unit_missing: "falta a unidade", already_linked: "o item já está ligado a um produto",
  gtin_exists: "o GTIN já é de outro produto (case o item com ele)", code_exists: "o código já é de outro produto",
};
const BLOCKERS: Record<string, string> = {
  note_not_authorized: "a nota não está autorizada (cancelada ou denegada)",
  third_party: "a empresa aparece só como terceiro (transportador ou autorizado)",
  supplier_missing: "falta cadastrar o fornecedor",
  warehouse_missing: "escolha o depósito",
  items_pending: "há item sem produto, sem conversão de unidade ou sem lote",
  installments_missing: "a nota não tem valor para gerar contas a pagar",
  nothing_chosen: "escolha lançar o estoque, as contas a pagar ou os dois",
  already_entered: "a nota já deu entrada",
  order_received_before: "o pedido de compra já recebeu estes itens pela tela do pedido e a nota traz mais do que falta (desmarque o estoque ou estorne o recebimento do pedido)",
};
/** Quem depende da parte desligada, na mensagem de parte desligada. */
const OFF_SUBJECT: Record<string, string> = {
  "recebidas.buscar": "Buscar e manifestar notas pelo cofre dependem", "recebidas.manifestar": "Buscar e manifestar notas pelo cofre dependem",
  "recebidas.produto_previa": "Cadastrar produto pela nota depende", "recebidas.criar_produto": "Cadastrar produto pela nota depende",
  "recebidas.reposicao": "A reposição pelo estoque mínimo depende", "recebidas.gerar_pedidos": "A reposição pelo estoque mínimo depende",
  "recebidas.inventario": "O inventário valorizado depende",
};
const DONE: Record<string, string> = { part_disabled: "parte desligada", role_missing: "seu papel não permite", not_chosen: "não escolhido", nothing: "nada a lançar" };

function rpcError(status: number, body: { code?: string; message?: string } | null): ApiError {
  const message = body?.message ?? "";
  if (status === 409 && body?.code === "module_disabled")
    return new ApiError(409, "module_disabled", "Uma parte do ERP de que esta ação precisa está desligada. Peça ao administrador para ligá-la em Gestão → Módulos.");
  if (message.startsWith("inbound_blocked:"))
    return new ApiError(422, "recebidas_blocked", `Ainda não dá para dar entrada: ${message.slice(16).split(",").map((b) => BLOCKERS[b] ?? b).join("; ")}.`);
  if (message.startsWith("inbound_product_blocked:")) {
    const [, position, problems] = message.split(":");
    return new ApiError(422, "recebidas_product_blocked", `O item ${position} não vira produto novo: ${(problems ?? "").split(",").map((p) => PRODUCT_PROBLEMS[p] ?? p).join("; ")}.`);
  }
  if (message.startsWith("inbound_replenishment_supplier_missing:"))
    return new ApiError(422, "recebidas_supplier_missing", `O produto ${message.slice(39)} não tem fornecedor. Escolha o fornecedor na linha ou cadastre-o na aba Fornecedores do produto.`);
  if (message.startsWith("inbound_replenishment_quantity_invalid:"))
    return new ApiError(422, "recebidas_quantity_invalid", "Informe a quantidade a comprar maior que zero, com até 6 casas.");
  if (message.startsWith("inbound_replenishment_product_unavailable:"))
    return new ApiError(422, "recebidas_product_unavailable", "Um produto da sugestão foi inativado ou deixou de ser produto. Atualize a reposição.");
  if (message.startsWith("inbound_nothing_done:")) {
    const [stock, finance] = message.slice(21).split(",");
    return new ApiError(409, "recebidas_nothing_done", `Nada foi lançado: estoque (${DONE[stock] ?? stock}) e contas a pagar (${DONE[finance] ?? finance}). Ligue a parte ou peça a alguém com o papel.`);
  }
  const known = MESSAGES[message];
  const code = message || body?.code || "erp_error";
  if (known) return new ApiError(body?.code === "42501" ? 403 : body?.code === "P0002" ? 404 : body?.code === "40001" ? 409 : 422, code, known);
  if (status === 403) return new ApiError(403, code, "Seu acesso ao ERP não permite esta ação agora (horário de acesso ou segundo fator).");
  if (status === 503) return new ApiError(503, code, "O ERP está ocupado com um backup ou restauração. Tente de novo em alguns minutos.");
  return new ApiError(status >= 500 ? 503 : 422, code, `O ERP recusou a ação (${code}). Confira os dados da conferência e tente de novo.`);
}

function fiscalError(error: FiscalError): ApiError {
  const retry = typeof error.details?.retry_at === "string" ? error.details.retry_at : null;
  const text: Record<string, string> = {
    fiscal_provider_not_configured: "O cofre fiscal não está configurado. Configure em Fiscal → Configuração do emissor.",
    fiscal_distribution_not_configured: "O cofre ainda não está configurado para receber as notas emitidas contra o CNPJ. Ative a distribuição no cofre.",
    fiscal_xml_unavailable: "O cofre só tem o resumo desta nota. Faça a ciência da operação para baixar o XML completo, ou importe o XML do fornecedor.",
    fiscal_manifestation_already_registered: "Esta manifestação já foi registrada antes (ou outra que não permite esta).",
    fiscal_manifestation_limit: "A nota já chegou ao limite de manifestações deste tipo.",
    fiscal_justification_required: "A operação não realizada exige justificativa de 15 a 255 caracteres.",
    fiscal_key_homologation_only: "A chave do cofre só opera em homologação.",
    fiscal_queries_blocked: `O Ambiente Nacional bloqueou as consultas do CNPJ por uma hora${retry ? ` (até ${retry})` : ""}. Espere para buscar de novo.`,
    fiscal_query_limit: `O limite de consultas da hora foi atingido${retry ? ` (libera ${retry})` : ""}.`,
    vault_outdated: "O cofre está desatualizado para notas recebidas (precisa da versão 0.9.0 ou mais nova). Atualize o cofre.",
    fiscal_provider_unreachable: "O cofre não respondeu. Tente de novo em alguns minutos.",
    fiscal_provider_unavailable: "O cofre está fora do ar agora. Tente de novo em alguns minutos.",
    fiscal_no_conclusive_answer: "O governo não deu resposta conclusiva. Consulte antes de tentar de novo.",
  };
  return new ApiError(error.status, error.code, text[error.code] ?? error.message);
}

export interface RecebidasRouteOptions {
  /** Só testes: o fetch do cofre simulado. */
  fetch?: typeof fetch;
  resolveIdentity?: typeof erpIdentity;
}

interface Call {
  env: Env; profile: string; actor: Actor; identity: IdentityPort; options: RecebidasRouteOptions;
}

async function rpc<T = any>(c: Call, name: string, input: Record<string, unknown>): Promise<T> {
  const response = await erpFetch(c.env, c.profile, `/erp-rpc/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", [IDENTITY_HEADER]: encodeIdentity(c.identity) },
    body: JSON.stringify({ p_user_id: c.identity.actor?.user_id ?? null, p_input: input }),
  });
  if (!response.ok) throw rpcError(response.status, (await response.json().catch(() => null)) as { code?: string; message?: string } | null);
  return (await response.json()) as T;
}

/** Portão do ERP (horário de acesso e segundo fator), como nas outras rotas fiscais. */
async function gate(c: Call) {
  const r = await erpFetch(c.env, c.profile, "/erp-rpc/erp_access_gate_v2", {
    method: "POST",
    headers: { "Content-Type": "application/json", [IDENTITY_HEADER]: encodeIdentity(c.identity) },
    body: JSON.stringify({ p_user_id: c.identity.actor?.user_id ?? null, p_session_id: c.identity.actor?.session_id ?? null }),
  });
  if (!r.ok) {
    const refused = (await r.json().catch(() => null)) as { code?: string } | null;
    if (refused?.code === "module_disabled") throw new ApiError(409, "module_disabled", "O ERP está desligado nesta área.");
    if (refused?.code === "42501") throw new ApiError(403, "erp_access_denied", "Seu acesso ao ERP desta área não está ativo.");
    throw new ApiError(503, "erp_unavailable", "O ERP não respondeu ao conferir o acesso. Tente de novo.");
  }
  const g = (await r.json()) as { open?: boolean; mfa_required?: boolean; mfa_ok?: boolean };
  if (g.open !== true) throw new ApiError(403, "ERP_ACCESS_OUTSIDE_SCHEDULE", "Fora do horário de acesso ao ERP.");
  if (g.mfa_required && g.mfa_ok !== true) throw new ApiError(403, "ERP_MFA_REQUIRED", "Confirme o segundo fator para continuar.");
}

const environmentOf = (value: unknown): FiscalEnvironment => {
  if (value === undefined || value === null || value === "homologacao") return "homologacao";
  if (value === "producao") return "producao";
  throw new ApiError(400, "invalid_request", "Escolha o ambiente: homologacao ou producao.");
};
const commandOf = (value: unknown) => {
  if (typeof value !== "string" || !UUID.test(value)) throw new ApiError(400, "invalid_request", "Informe command_id (uuid) para que repetir o pedido não duplique nada.");
  return value;
};

const uuidParam = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !UUID.test(value)) throw new ApiError(400, "invalid_request", "Identificador do depósito ou do fornecedor inválido.");
  return value;
};

/** Decimal do motor ("1234.5600") para a planilha brasileira ("1234,56"), sem zeros à direita além das casas pedidas. */
const csvNumber = (value: string | null, keep = 2) => {
  if (value === null || value === undefined) return "";
  const [whole, fraction = ""] = String(value).split(".");
  const trimmed = fraction.replace(/0+$/, "");
  const digits = trimmed.length < keep ? fraction.slice(0, keep).padEnd(keep, "0") : trimmed;
  return digits ? `${whole},${digits}` : whole;
};
const csvText = (value: unknown) => {
  const text = value === null || value === undefined ? "" : String(value);
  return /[";\n\r]/.test(text) || /^[=+\-@]/.test(text) ? `"${(/^[=+\-@]/.test(text) ? "'" : "") + text.replace(/"/g, '""')}"` : text;
};

/** Inventário em planilha: separador ponto e vírgula e vírgula decimal (o Excel em português abre direto). */
function inventoryCsv(result: { filters: { date: string }; cost_visible: boolean; items: Record<string, any>[]; totals: { value: string | null } }) {
  const head = ["Código", "Produto", "Unidade", "Depósito", "Quantidade", ...(result.cost_visible ? ["Custo médio na data", "Valor"] : [])];
  const lines = result.items.map((i) => [csvText(i.code), csvText(i.name), csvText(i.unit), csvText(i.warehouse_name), csvNumber(i.quantity, 0),
    ...(result.cost_visible ? [csvNumber(i.average_cost, 2), csvNumber(i.value, 2)] : [])].join(";"));
  if (result.cost_visible) lines.push(["", "Total", "", "", "", "", csvNumber(result.totals.value, 2)].join(";"));
  const body = "﻿" + [head.join(";"), ...lines].join("\r\n") + "\r\n";
  return new Response(body, { headers: { ...noStore, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="inventario-${result.filters.date}.csv"` } });
}

/** XML guardado no R2 da área, conferido pelo hash do índice. */
async function storedXml(c: Call, note: { xml: { key: string; sha256: string } | null }) {
  if (!note.xml) throw new ApiError(409, "recebidas_xml_missing", MESSAGES.inbound_xml_missing);
  if (!note.xml.key.startsWith(`erp/${c.profile}/recebidas/`)) throw new ApiError(409, "recebidas_xml_changed", MESSAGES.inbound_xml_changed);
  const object = await c.env.MEDIA.get(note.xml.key);
  if (!object) throw new ApiError(409, "recebidas_xml_missing", "O XML desta nota não está mais guardado. Importe o XML de novo.");
  const bytes = new Uint8Array(await object.arrayBuffer());
  if ((await xmlSha256(bytes)) !== note.xml.sha256) throw new ApiError(409, "recebidas_xml_changed", MESSAGES.inbound_xml_changed);
  const text = new TextDecoder().decode(bytes);
  return { bytes, text, parsed: parseInboundXml(text) };
}

/** Guarda o XML no R2 (o hash é o nome) e devolve o que o índice registra. */
async function putXml(c: Call, bytes: Uint8Array<ArrayBuffer>) {
  const sha256 = await xmlSha256(bytes);
  const key = inboundXmlKey(c.profile, sha256);
  await c.env.MEDIA.put(key, bytes, { httpMetadata: { contentType: "application/xml" } });
  return { key, sha256, size: bytes.byteLength };
}

const vaultContext = (c: Call): FiscalContext => ({ env: c.env, profile: c.profile, fetch: c.options.fetch });

/** O que o motor grava de uma nota do cofre (com o XML, quando o cofre já tem). */
async function vaultNote(c: Call, n: FiscalReceivedNote, withXml: boolean) {
  const base = {
    provider_ref: n.provider_ref, environment: n.environment, cnpj: n.cnpj, access_key: n.access_key, sequence: n.sequence, role: n.role, issuer: n.issuer,
    series: n.series, number: n.number, issued_at: n.issued_at, authorized_at: n.authorized_at, protocol: n.protocol, operation: n.operation, total: n.total,
    status: n.status, xml_available: n.xml_available,
    manifestation: n.manifestation?.type ? { type: n.manifestation.type, sequence: n.manifestation.sequence, registered_at: n.manifestation.registered_at, origin: n.manifestation.origin } : null,
    automatic_acknowledgement_refused: n.automatic_acknowledgement_refused, received_at: n.received_at, updated_at: n.updated_at,
  };
  if (!withXml || !n.xml_available || n.role !== "recipient") return { note: base, xml_error: null };
  try {
    const provider = await fiscalProviderFor(vaultContext(c));
    const text = await provider.receivedXml(vaultContext(c), n.provider_ref);
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength > INBOUND_XML_MAX_BYTES) return { note: base, xml_error: "xml_too_large" };
    const parsed = parseInboundXml(text);
    if (parsed.summary.access_key !== n.access_key) return { note: base, xml_error: "xml_key_mismatch" };
    return { note: { ...base, xml: await putXml(c, bytes), summary: parsed.summary }, xml_error: null };
  } catch (error) {
    // O resumo entra mesmo assim; o XML é baixado na próxima busca ou importado à mão.
    if (error instanceof InboundXmlError) return { note: base, xml_error: error.code };
    if (error instanceof FiscalError) return { note: base, xml_error: error.code };
    throw error;
  }
}

async function fetchFromVault(c: Call, body: Record<string, unknown>) {
  const environment = environmentOf(body.ambiente);
  const connection = await emissorConnection(c.env, c.profile);
  if (!connection) throw new ApiError(409, "fiscal_provider_not_configured", "O cofre fiscal não está configurado. Configure em Fiscal → Configuração do emissor.");
  const claim = await rpc<{ allowed: boolean; retry_at?: string; after: number }>(c, "erp_inbound_fetch_claim", {
    environment, production_authorized: body.autorizacao_producao === true, vault_url: connection.url,
  });
  if (!claim.allowed) {
    const response = json({ code: "recebidas_wait", message: `A última busca foi há pouco. Busque de novo a partir de ${claim.retry_at}.`, retry_at: claim.retry_at }, 429);
    response.headers.set("Retry-After", String(Math.max(1, Math.ceil((Date.parse(claim.retry_at ?? "") - Date.now()) / 1000)) || 120));
    return response;
  }
  const ctx = vaultContext(c);
  try {
    const provider = await fiscalProviderFor(ctx);
    const notes: Record<string, unknown>[] = [];
    const xmlErrors: string[] = [];
    let after = claim.after, last = claim.after;
    // Até 5 páginas por busca; o resto fica para a próxima (sem laço com o cofre).
    for (let page = 0; page < 5; page++) {
      const result = await provider.received(ctx, { after, limit: 100, environment });
      for (const n of result.items) {
        const v = await vaultNote(c, n, true);
        notes.push(v.note);
        if (v.xml_error) xmlErrors.push(`${n.access_key}:${v.xml_error}`);
      }
      last = result.last_sequence;
      if (!result.has_more || result.last_sequence <= after) break;
      after = result.last_sequence;
    }
    const recorded = await rpc(c, "erp_inbound_fetch_record", { environment, last_sequence: last, notes });
    const distribution = (await provider.distribution(ctx).catch(() => [])).find((d) => d.environment === environment) ?? null;
    await audit(c.env, c.actor, c.profile, "erp_recebidas.buscar", `${environment} ${claim.after}..${last}`, uid());
    return json({ ...recorded, environment, xml_pending: xmlErrors, distribution });
  } catch (error) {
    if (error instanceof FiscalError) {
      await rpc(c, "erp_inbound_fetch_record", { environment, error: { code: error.code, message: error.message } }).catch(() => null);
      throw fiscalError(error);
    }
    throw error;
  }
}

async function importXml(c: Call, body: Record<string, unknown>) {
  if (typeof body.xml !== "string" || !body.xml.trim()) throw new ApiError(400, "invalid_request", "Envie o conteúdo do arquivo XML da nota.");
  const bytes = new TextEncoder().encode(body.xml);
  if (bytes.byteLength > INBOUND_XML_MAX_BYTES) throw new ApiError(413, "recebidas_xml_too_large", "O arquivo passa de 1 MB. Confira se é o XML de uma NF-e.");
  let parsed;
  try { parsed = parseInboundXml(body.xml); }
  catch (error) { if (error instanceof InboundXmlError) throw new ApiError(422, `recebidas_${error.code}`, error.message); throw error; }
  const xml = await putXml(c, bytes);
  const note = await rpc(c, "erp_inbound_register", { note: parsed.summary, xml });
  await audit(c.env, c.actor, c.profile, "erp_recebidas.importar", parsed.summary.access_key, uid());
  return json(note, note.replayed ? 200 : 201);
}

async function noteWithXml(c: Call, id: string) {
  const note = await rpc(c, "erp_inbound_get", { id });
  return { note, xml: await storedXml(c, note) };
}

async function reviewNote(c: Call, id: string, choices: unknown) {
  const note = await rpc(c, "erp_inbound_get", { id });
  if (!note.xml) return json({ note, review: null, missing_xml: true });
  const xml = await storedXml(c, note);
  return json({ note, review: await rpc(c, "erp_inbound_review", { id, xml_sha256: note.xml.sha256, note: xml.parsed.note, choices: choices ?? {} }), missing_xml: false });
}

async function manifest(c: Call, id: string, body: Record<string, unknown>) {
  const type = String(body.tipo ?? "");
  const claim = await rpc<{ event_id: string; state: string; received_id: string; provider_ref: string; environment: FiscalEnvironment; consult_first?: boolean; resend?: boolean; replayed?: boolean; justification?: string | null }>(
    c, "erp_inbound_manifest_claim", {
      id, command_id: commandOf(body.command_id), type, justification: body.justificativa ?? null,
      production_authorized: body.autorizacao_producao === true, resend: body.reenviar === true, via: c.actor.via?.bot_id ?? null,
    });
  if (claim.replayed && claim.state === "registrado") return json({ state: "registrado", replayed: true });
  const ctx = vaultContext(c);
  const provider = await fiscalProviderFor(ctx);
  const record = (state: string, extra: Record<string, unknown> = {}) => rpc(c, "erp_inbound_manifest_record", { event_id: claim.event_id, state, ...extra });
  const registered = async (n: FiscalReceivedNote, consulted: boolean) => {
    const m = n.manifestations.filter((x) => x.type === type).at(-1) ?? n.manifestation;
    await record("registrado", { protocol: m?.protocol ?? null, sequence: m?.sequence ?? 1, registered_at: m?.registered_at ?? null, repeated: n.repeated === true, xml_available: n.xml_available });
    // Com a ciência, o cofre passa a ter o XML completo: guarda e indexa.
    if (n.xml_available) {
      const v = await vaultNote(c, n, true);
      await rpc(c, "erp_inbound_fetch_record", { environment: claim.environment, notes: [v.note] }).catch(() => null);
    }
    await audit(c.env, c.actor, c.profile, "erp_recebidas.manifestar", `${n.access_key} ${type}${consulted ? " consulta" : ""}`, uid());
    return json({ state: "registrado", consulted, repeated: n.repeated === true, xml_available: n.xml_available });
  };
  // Resultado incerto antes: consulta primeiro; só reenvia com a confirmação explícita.
  if (claim.consult_first || claim.resend) {
    const current = await provider.receivedGet(ctx, claim.provider_ref).catch((e) => { if (e instanceof FiscalError) throw fiscalError(e); throw e; });
    if (current.manifestations.some((m) => m.type === type)) return registered(current, true);
    if (claim.consult_first)
      return json({ code: "recebidas_manifest_uncertain", state: "incerto", message: "A manifestação anterior ficou sem resposta. Consultamos o cofre e ela ainda não aparece registrada. Para enviar de novo, confirme o reenvio." }, 409);
  }
  try {
    const result = await provider.manifest(ctx, { ref: claim.provider_ref }, { type: type as never, ...(type === "nao_realizada" && claim.justification ? { justification: claim.justification } : {}) });
    return await registered(result, false);
  } catch (error) {
    if (error instanceof FiscalError && !error.details?.retryable && error.status < 500) {
      await record("recusado", { messages: error.details?.messages ?? [{ code: error.code, description: error.message }] });
      throw fiscalError(error);
    }
    // Sem resposta conclusiva: fica incerto. Nada é reenviado sozinho.
    await record("incerto").catch(() => null);
    throw new ApiError(503, "recebidas_manifest_uncertain", "O cofre não deu resposta conclusiva sobre a manifestação. Nada foi reenviado: use Consultar para ver se ela foi registrada.");
  }
}

/** Entrada única para a tela, as aplicações e as propostas confirmadas dos bots. */
export async function erpRecebidasRoute(env: Env, request: Request, profile: string, actor: Actor, options: RecebidasRouteOptions = {}): Promise<Response> {
  try {
    if (isEngineActor(actor)) throw new ApiError(403, "recebidas_external_origin_forbidden", "A origem externa não alcança as notas recebidas.");
    if (actor.kind !== "user") throw new ApiError(403, "erp_user_required", "As notas recebidas atendem pessoas e os bots da equipe.");
    if (!canProfile(actor, profile)) throw new ApiError(404, "not_found", "Área de atendimento não encontrada.");
    const url = new URL(request.url);
    const prefix = `/api/v1/profiles/${encodeURIComponent(profile)}/${RECEBIDAS_ROUTE}/`;
    if (!url.pathname.startsWith(prefix)) throw new ApiError(404, "not_found", "Operação não encontrada.");
    const found = recebidasOperationFor(request.method, url.pathname.slice(prefix.length).replace(/\/+$/, ""));
    if (!found) throw new ApiError(404, "not_found", "Operação não encontrada.");
    const { operation, id } = found;
    if (id !== undefined && !UUID.test(id)) throw new ApiError(400, "invalid_request", "Identificador da nota inválido.");
    for (const key of url.searchParams.keys()) if (!operation.query.includes(key)) throw new ApiError(400, "invalid_request", `Parâmetro desconhecido: ${key}.`);
    let body: Record<string, unknown> = {};
    if (operation.method !== "GET") {
      const raw = await request.text();
      if (raw.length > INBOUND_XML_MAX_BYTES + 4096) throw new ApiError(413, "recebidas_body_too_large", "O pedido passa do tamanho aceito (1 MB de XML).");
      if (raw) {
        try { body = JSON.parse(raw); } catch { throw new ApiError(400, "invalid_json", "Corpo JSON inválido."); }
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "invalid_json", "Corpo JSON inválido.");
      }
      const extra = Object.keys(body).filter((key) => !operation.body.includes(key));
      if (extra.length) throw new ApiError(400, "invalid_request", `Informe só: ${operation.body.join(", ") || "nada"}.`);
    }
    // Pelo bot: só o que está no inventário, concedido, e a escrita com a proposta que a pessoa confirmou.
    if (actor.via) {
      if (!operation.bot) throw new ApiError(403, "erp_bot_grant_required", "Esta ação das notas recebidas é só pela tela.");
      if (!(await erpBotDelegation(env, actor, profile, request.method, url.pathname, operation.method === "GET" ? undefined : body)))
        throw new ApiError(403, "erp_bot_grant_required", "Esta operação das notas recebidas não foi liberada para este bot, ou falta a confirmação da pessoa.");
    }
    const identity = await (options.resolveIdentity ?? erpIdentity)(env, actor, profile, request.method, url.pathname);
    if (!identity.actor) throw new ApiError(403, "erp_access_denied", "Seu acesso ao ERP desta área não está ativo.");
    const parts = (identity.parts ?? {}) as Record<string, boolean>;
    const off = operation.parts.filter((part) => PART_KEY[part] && parts[PART_KEY[part]!] !== true);
    if (off.length)
      throw new ApiError(409, "module_disabled", `${OFF_SUBJECT[operation.name] ?? "As notas recebidas dependem"} de ${off.map((p) => ERP_PART_NAMES[p]).join(" e ")} ligado. Peça ao administrador para ligar em Gestão → Módulos.`);
    const c: Call = { env, profile, actor, identity, options };
    await gate(c);
    return await dispatch(c, operation, id, body, url);
  } catch (error) {
    if (error instanceof ApiError) {
      const extra = (error as ApiError & { details?: unknown }).details;
      return json({ code: error.code, message: error.message, error: { code: error.code, message: error.message }, ...(extra ? { details: extra } : {}) }, error.status);
    }
    if (error instanceof FiscalError) { const e = fiscalError(error); return json({ code: e.code, message: e.message, error: { code: e.code, message: e.message } }, e.status); }
    throw error;
  }
}

async function dispatch(c: Call, operation: RecebidasOperation, id: string | undefined, body: Record<string, unknown>, url: URL): Promise<Response> {
  switch (operation.name) {
    case "recebidas.listar": {
      const q = url.searchParams;
      const situacao = q.get("situacao") ?? "todas";
      const page = Number(q.get("pagina") ?? "1");
      if (!Number.isSafeInteger(page) || page < 1) throw new ApiError(400, "invalid_request", "Página inválida.");
      return json(await rpc(c, "erp_inbound_list", { environment: q.get("ambiente") ? environmentOf(q.get("ambiente")) : null, status: situacao, page }));
    }
    case "recebidas.conferir": return reviewNote(c, id!, {});
    case "recebidas.previa": return reviewNote(c, id!, body.escolhas ?? {});
    case "recebidas.buscar": return fetchFromVault(c, body);
    case "recebidas.importar_xml": return importXml(c, body);
    case "recebidas.cadastrar_fornecedor": {
      const { note, xml } = await noteWithXml(c, id!);
      return json(await rpc(c, "erp_inbound_supplier_create", { id, xml_sha256: note.xml.sha256, note: xml.parsed.note, command_id: commandOf(body.command_id) }));
    }
    case "recebidas.dar_entrada": {
      const { note, xml } = await noteWithXml(c, id!);
      const result = await rpc(c, "erp_inbound_enter", {
        id, xml_sha256: note.xml.sha256, note: xml.parsed.note, choices: body.escolhas ?? {}, command_id: commandOf(body.command_id), via: c.actor.via?.bot_id ?? null,
      });
      if (!result.replayed) await audit(c.env, c.actor, c.profile, "erp_recebidas.entrada", note.access_key, uid());
      return json(result, result.replayed ? 200 : 201);
    }
    case "recebidas.estornar": {
      const result = await rpc(c, "erp_inbound_reverse", { id, reason: body.motivo ?? "", command_id: commandOf(body.command_id) });
      if (!result.replayed) await audit(c.env, c.actor, c.profile, "erp_recebidas.estorno", String(result.note?.access_key ?? id), uid());
      return json(result);
    }
    case "recebidas.manifestar": return manifest(c, id!, body);
    case "recebidas.xml": {
      const { note, xml } = await noteWithXml(c, id!);
      return new Response(xml.bytes, { headers: { ...noStore, "Content-Type": "application/xml", "Content-Disposition": `attachment; filename="NFe${note.access_key}.xml"` } });
    }
    case "recebidas.configuracao": return json(await rpc(c, "erp_inbound_settings_get", {}));
    case "recebidas.configurar": {
      const saved = await rpc(c, "erp_inbound_settings_save", {
        expected_version: body.expected_version, manifest_enabled: body.manifestar, acknowledge_fiscal_act: body.ciente_ato_fiscal === true,
      });
      await audit(c.env, c.actor, c.profile, "erp_recebidas.configurar", `manifestar=${saved.manifest_enabled}`, uid());
      return json(saved);
    }
    case "recebidas.produto_previa": {
      const { note, xml } = await noteWithXml(c, id!);
      const raw = url.searchParams.get("posicoes");
      const positions = raw ? raw.split(",").map((p) => Number(p.trim())) : null;
      if (positions && positions.some((p) => !Number.isSafeInteger(p) || p < 1 || p > 990)) throw new ApiError(400, "invalid_request", "Informe os itens pelo número na nota, separados por vírgula (por exemplo, 1,3).");
      return json(await rpc(c, "erp_inbound_product_preview", { id, xml_sha256: note.xml.sha256, note: xml.parsed.note, ...(positions ? { items: positions.map((position) => ({ position })) } : {}) }));
    }
    case "recebidas.criar_produto": {
      const { note, xml } = await noteWithXml(c, id!);
      const result = await rpc(c, "erp_inbound_product_create", { id, xml_sha256: note.xml.sha256, note: xml.parsed.note, command_id: commandOf(body.command_id), items: body.itens ?? [] });
      if (!result.replayed) await audit(c.env, c.actor, c.profile, "erp_recebidas.produto", `${note.access_key} ${result.created.length}`, uid());
      return json(result, result.replayed ? 200 : 201);
    }
    case "recebidas.reposicao": {
      const q = url.searchParams;
      return json(await rpc(c, "erp_inbound_replenishment", { warehouse_id: uuidParam(q.get("deposito")), supplier_id: uuidParam(q.get("fornecedor")), only_below: q.get("todos") !== "1" }));
    }
    case "recebidas.gerar_pedidos": {
      const result = await rpc(c, "erp_inbound_replenishment_generate", { command_id: commandOf(body.command_id), warehouse_id: uuidParam(body.deposito ?? null), items: body.itens ?? [] });
      if (!result.replayed) await audit(c.env, c.actor, c.profile, "erp_recebidas.reposicao", `${result.orders.length} pedidos`, uid());
      return json(result, result.replayed ? 200 : 201);
    }
    case "recebidas.inventario": {
      const q = url.searchParams;
      const result = await rpc(c, "erp_inbound_inventory", { date: q.get("data") ?? todayInSaoPaulo(), warehouse_id: uuidParam(q.get("deposito")), include_zero: q.get("zerados") === "1" });
      if (q.get("formato") === "csv") return inventoryCsv(result);
      if (q.get("formato") !== null) throw new ApiError(400, "invalid_request", "O formato do inventário é csv (planilha) ou nenhum (tela).");
      return json(result);
    }
  }
  throw new ApiError(404, "not_found", "Operação não encontrada.");
}
