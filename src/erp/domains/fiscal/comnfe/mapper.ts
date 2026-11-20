/** Montagem estrita do contrato do cofre a partir das fontes congeladas no servidor. */
import type { FiscalBlocker, FiscalEnvironment, JsonObject, PedidoNfe } from "../../../commercial-nfe/contracts.ts";
import { formatScaled, toScaled } from "../../../engine/dec.ts";
import { cnpj, cpfValid } from "../../company/internal.ts";
// @ts-expect-error Função decimal compartilhada em JavaScript, sem declaração TypeScript.
import { lineTotalCents } from "../../../fagoo/packages/erp-domain/src/fiscal-invoice-contract.mjs";
import type { PreparationSources } from "./source.ts";
import type { TaxPreparationResult } from "./taxes.ts";

type Obj = Record<string, unknown>;
const object = (v: unknown): Obj => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Obj : {};
const present = (v: unknown): boolean => v !== undefined && v !== null && v !== "";
const text = (v: unknown): string => typeof v === "string" || typeof v === "number" ? String(v) : "";
const digits = (v: unknown): string => text(v).replace(/[ ()./+\-]/g, "");
const UF = /^(AC|AL|AM|AP|BA|CE|DF|ES|GO|MA|MG|MS|MT|PA|PB|PE|PI|PR|RJ|RN|RO|RR|RS|SC|SE|SP|TO)$/;
const UF_CODE: Record<string, string> = { RO: "11", AC: "12", AM: "13", RR: "14", PA: "15", AP: "16", TO: "17", MA: "21", PI: "22", CE: "23", RN: "24", PB: "25", PE: "26", AL: "27", SE: "28", BA: "29", MG: "31", ES: "32", RJ: "33", SP: "35", PR: "41", SC: "42", RS: "43", MS: "50", MT: "51", GO: "52", DF: "53" };
const EMAIL = /^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
const PAYMENT_TYPES = new Set(["01", "02", "03", "04", "05", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "90", "91", "99"]);
const PRESENCES = new Set(["nao_se_aplica", "presencial", "internet", "teleatendimento", "entrega_domicilio", "presencial_fora", "outros"]);
const canon = (v: string): string => v.includes(".") ? v.replace(/0+$/, "").replace(/\.$/, "") : v;
const decimalText = (v: unknown): string | null => {
  const value = text(v);
  return /^(0|[1-9]\d*)(\.\d+)?$/.test(value) ? canon(value) : null;
};
const cents = (v: unknown): bigint | null => {
  const value = decimalText(v);
  if (value === null || (value.split(".")[1]?.length ?? 0) > 2) return null;
  return toScaled(value, 2);
};
const moneyNumber = (v: bigint): number => Number(formatScaled(v, 2));
const validDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const validCnpj = (value: string): boolean => { try { return cnpj(value) === value; } catch { return false; } };
/** GTIN ausente é omitido; código informado é conferido inclusive no dígito. */
export function validPreparationGtin(value: string): boolean {
  if (!/^(\d{8}|\d{12,14})$/.test(value) || /^0+$/.test(value)) return false;
  const raw = value.slice(0, -1);
  let sum = 0;
  for (let i = raw.length - 1, weight = 3; i >= 0; i--, weight = weight === 3 ? 1 : 3) sum += Number(raw[i]) * weight;
  return (10 - sum % 10) % 10 === Number(value.at(-1));
}

export interface PreparationMapping {
  body: PedidoNfe | null;
  calculation: JsonObject;
  blockers: FiscalBlocker[];
  total_cents: string | null;
}

/** Nunca recebe corpo fiscal do navegador. options contém identidade atribuída pelo store. */
export function mapPreparation(sources: PreparationSources, taxes: TaxPreparationResult, options: {
  environment: FiscalEnvironment; reference: string; series?: number | null;
}): PreparationMapping {
  const { snapshot, choices } = sources;
  const d = snapshot.document as Obj, company = snapshot.company as Obj, recipient = snapshot.recipient as Obj;
  const nature = snapshot.nature as Obj, invoice = taxes.invoice as Obj;
  const blockers: FiscalBlocker[] = [...sources.blockers, ...taxes.blockers];
  const orderId = text(d.id), recipientId = text(recipient.contact_id ?? recipient.id), natureId = text(nature.id ?? choices.nature_id);
  const add = (code: string, field: string, message: string, screen: string, entity?: unknown, item?: unknown) => {
    const id = text(entity), itemId = text(item);
    blockers.push({ code, field, message, correction: { screen, ...(id ? { id } : {}), field }, ...(id ? { entity_id: id } : {}), ...(itemId ? { item_id: itemId } : {}) });
  };
  const unsupported = (field: string, feature: string, entity: unknown = orderId, item?: unknown) => add("fiscal_operation_unsupported", field,
    `O item ou a operação usa ${feature}, ainda não atendido nesta fatia. Revise a operação com o contador.`, "sales_orders", entity, item);
  const validText = (value: unknown, min: number, max: number): boolean => typeof value === "string" && [...value].length >= min && [...value].length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
  const amount = (value: unknown, field: string, code: string, screen: string, entity?: unknown, item?: unknown, scale = 2, positive = false, max = 9999999999999.99): number | null => {
    const normalized = decimalText(value), number = normalized === null ? NaN : Number(normalized);
    const serialized = String(number).includes("e") && Number.isFinite(number) ? number.toFixed(scale) : String(number);
    if (normalized === null || (normalized.split(".")[1]?.length ?? 0) > scale || !Number.isFinite(number) || number > max || (positive && number <= 0) || canon(serialized) !== normalized) {
      add(code, field, `Confira ${field}: informe um valor ${positive ? "positivo" : "não negativo"} com até ${scale} casas e dentro do limite fiscal, sem arredondamento.`, screen, entity, item);
      return null;
    }
    return number;
  };
  const info = (value: unknown, field: string, max: number, entity = orderId): string | undefined => {
    if (!present(value)) return undefined;
    if (!validText(value, 1, max)) { unsupported(field, `texto fora do limite de ${max} caracteres`, entity); return undefined; }
    return value as string;
  };
  const participant = (data: Obj, issuer: boolean): Obj => {
    const prefix = issuer ? "emitente" : "destinatario", entity = issuer ? "1" : recipientId, screen = issuer ? "company" : "contacts";
    const incomplete = (field: string, label: string) => add(issuer ? "fiscal_issuer_incomplete" : "fiscal_recipient_incomplete", `${prefix}.${field}`,
      issuer ? `Complete ${label} em Dados da empresa antes de emitir.` : `O cliente ${text(data.name)} está sem ${label} válido. Corrija em Clientes e fornecedores.`, screen, entity);
    const output: Obj = {}, address: Obj = {};
    const name = data.legal_name ?? data.name;
    if (!validText(name, 2, 60)) incomplete("nome", "nome (2 a 60 caracteres)"); else output.nome = name;
    const doc = digits(issuer ? data.cnpj : data.document);
    if (issuer || data.person_type === "J") { if (!validCnpj(doc)) incomplete("cnpj", "CNPJ"); else output.cnpj = doc; }
    else if (data.person_type === "F") { if (!cpfValid(doc)) incomplete("cpf", "CPF"); else output.cpf = doc; }
    else unsupported(`${prefix}.documento`, "destinatário estrangeiro ou tipo de pessoa não definido", entity);
    for (const [from, to, min] of [["street", "logradouro", 2], ["number", "numero", 1], ["district", "bairro", 2], ["city", "municipio", 2]] as const) {
      const value = from === "city" ? data.municipality_name ?? data.city : data[from];
      if (!validText(value, min, 60)) incomplete(`endereco.${to}`, to); else address[to] = value;
    }
    const state = text(data.state), municipality = text(data.municipality_code), postal = digits(data.postal_code);
    if (!UF.test(state)) incomplete("endereco.uf", "UF nacional"); else address.uf = state;
    if (!/^\d{7}$/.test(municipality) || municipality.slice(0, 2) !== UF_CODE[state]) incomplete("endereco.codigoMunicipio", "código do município compatível com a UF"); else address.codigoMunicipio = municipality;
    if (!/^\d{8}$/.test(postal) || postal === "00000000") incomplete("endereco.cep", "CEP"); else address.cep = postal;
    if (present(data.complement)) { if (!validText(data.complement, 1, 60)) incomplete("endereco.complemento", "complemento (até 60 caracteres)"); else address.complemento = data.complement; }
    if (present(data.phone)) { const phone = digits(data.phone); if (!/^\d{6,14}$/.test(phone)) incomplete("endereco.telefone", "telefone"); else address.telefone = phone; }
    const ie = digits(data.ie);
    if (issuer) {
      if (!/^\d{2,14}$/.test(ie)) incomplete("inscricaoEstadual", "inscrição estadual"); else output.inscricaoEstadual = ie;
      const regimes: Record<string, string> = { "1": "simples_nacional", "2": "simples_excesso", "3": "normal", "4": "mei" };
      if (!regimes[text(data.crt)]) incomplete("regime", "CRT confirmado"); else output.regime = regimes[text(data.crt)];
      for (const [from, to, max] of [["trade_name", "fantasia", 60], ["municipal_registration", "inscricaoMunicipal", 15]] as const) {
        if (present(data[from])) { if (!validText(data[from], 1, max)) incomplete(to, `${to} (até ${max} caracteres)`); else output[to] = data[from]; }
      }
      if (present(data.cnae)) { if (!/^\d{4}-?\d\/?\d{2}$/.test(text(data.cnae))) incomplete("cnae", "CNAE"); else output.cnae = digits(data.cnae); }
    } else {
      const indicator = text(data.taxpayer ?? data.ie_indicator), indicators: Record<string, string> = { "1": "contribuinte", "2": "isento", "9": "nao_contribuinte" };
      if (!indicators[indicator] || (indicator === "1" && !/^\d{2,14}$/.test(ie)) || (indicator === "2" && present(data.ie) && text(data.ie).toUpperCase() !== "ISENTO") || (indicator !== "2" && present(data.ie) && !/^\d{2,14}$/.test(ie))) {
        add("fiscal_recipient_ie_invalid", "destinatario.indicadorIe", `Confira o indicador de contribuinte e a inscrição estadual do cliente ${text(data.name)}.`, screen, entity);
      } else { output.indicadorIe = indicators[indicator]; if (indicator !== "2" && present(ie)) output.inscricaoEstadual = ie; }
      const email = data.nfe_email ?? data.email;
      if (present(email)) { if (!validText(email, 6, 60) || !EMAIL.test(text(email))) incomplete("email", "e-mail fiscal"); else output.email = email; }
      if (present(data.country)) {
        if (!["BRASIL", "BRAZIL", "BR", "1058"].includes(text(data.country).toUpperCase())) unsupported("destinatario.endereco.pais", "destinatário no exterior", entity);
        else { address.pais = "Brasil"; address.codigoPais = "1058"; }
      }
    }
    output.endereco = address;
    return output;
  };
  const emitente = participant(company, true), destinatario = participant(recipient, false);
  if (!validText(nature.description, 1, 60) || nature.active === false || text(nature.direction) !== "1" || text(nature.crt) !== text(company.crt)) {
    add("fiscal_nature_missing", "naturezaOperacao", "Selecione uma natureza de operação compatível com esta venda.", "fiscal_natures", natureId);
  }
  if (nature.return_operation === true) unsupported("nature.return_operation", "devolução fiscal", natureId);
  if (nature.invoiced === false) unsupported("nature.invoiced", "operação não faturada", natureId);
  if (!PRESENCES.has(choices.presence)) unsupported("presenca", "presença não definida");
  if (typeof choices.final_consumer !== "boolean") unsupported("consumidorFinal", "condição de consumidor final não definida");
  const destination = company.state === recipient.state ? "interna" : "interestadual";
  if (present(d.operation_destination) && text(d.operation_destination) !== (destination === "interna" ? "1" : "2")) unsupported("destinoOperacao", "destino divergente das UFs cadastradas");
  for (const key of ["references", "notasReferenciadas", "exportacao", "intermediador", "import_declaration", "export", "intermediary", "delivery_address"]) {
    if (present(d[key]) && (!Array.isArray(d[key]) || (d[key] as unknown[]).length > 0)) unsupported(key, key === "delivery_address" ? "endereço de entrega diferente do destinatário" : key);
  }
  const otherItems = object(d.other_items);
  if (Object.keys(otherItems).length && (cents(otherItems.total) !== 0n || present(otherItems.content))) unsupported("other_items", "outros itens sem produto fiscal");
  const outputItems: Obj[] = [];
  if (!snapshot.items.length || snapshot.items.length > 990) unsupported("itens", "quantidade de itens fora do limite de 1 a 990");
  snapshot.items.forEach((raw, index) => {
    const item = raw as Obj, id = item.id, productId = text(item.product_id), prefix = `itens[${index}]`;
    const product = (snapshot.products.find(p => p.id === productId) ?? {}) as Obj;
    const name = text(product.name ?? item.description), productError = (field: string, label: string) => add("fiscal_product_incomplete", `${prefix}.${field}`, `O produto ${name} está sem ${label} válido, necessário para esta operação.`, "products", productId, id);
    const out: Obj = {};
    if (!productId || !Object.keys(product).length) add("fiscal_product_unlinked", `${prefix}.product_id`, `O item ${index + 1} precisa estar vinculado a um produto.`, "sales_orders", orderId, id);
    if (product.active === false) productError("product_id", "produto ativo");
    if (item.invoiced === false || item.compoeTotal === false) unsupported(`${prefix}.compoeTotal`, "faturamento parcial ou item fora do total", productId, id);
    if (product.kind !== "P") unsupported(`${prefix}.kind`, "item que não é mercadoria", productId, id);
    for (const [from, to, max] of [["code", "codigo", 60], ["description", "descricao", 120], ["unit", "unidade", 6]] as const) {
      if (!validText(item[from], 1, max)) add("fiscal_product_incomplete", `${prefix}.${to}`, `Complete ${to} do item ${index + 1} no pedido (até ${max} caracteres).`, "sales_orders", orderId, id);
      else out[to] = item[from];
    }
    const quantity = amount(item.quantity, `${prefix}.quantidade`, "fiscal_operation_unsupported", "sales_orders", orderId, id, 4, true, 99999999999.9999);
    const price = amount(item.unit_price, `${prefix}.valorUnitario`, "fiscal_operation_unsupported", "sales_orders", orderId, id, 10, false, 100000000000);
    if (quantity !== null) out.quantidade = quantity;
    if (price !== null) out.valorUnitario = price;
    if (quantity !== null && price !== null) {
      const gross = lineTotalCents(text(item.quantity), text(item.unit_price));
      if (gross > 999999999999999n) unsupported(`${prefix}.valorTotal`, "valor do item acima do limite", productId, id);
      else out.valorTotal = moneyNumber(gross);
      if (cents(item.gross) !== gross) add("fiscal_total_mismatch", `${prefix}.valorTotal`, "Pedido, parcelas e cálculo fiscal têm totais diferentes. Revise e salve o pedido.", "sales_orders", orderId, id);
    }
    if (!/^\d{8}$/.test(text(product.ncm))) productError("ncm", "NCM com oito dígitos"); else out.ncm = product.ncm;
    if (present(product.cest)) { if (!/^\d{7}$/.test(text(product.cest))) productError("cest", "CEST com sete dígitos"); else out.cest = product.cest; }
    for (const [from, to] of [["gtin", "ean"], ["gtin_tax", "tax_ean"]] as const) {
      if (present(product[from])) { if (!validPreparationGtin(text(product[from]))) productError(to, "GTIN"); else out[to] = product[from]; }
    }
    const details = object(taxes.item_details[index]);
    if (!/^[56]\d{3}$/.test(text(details.cfop)) || text(details.cfop)[0] !== (destination === "interna" ? "5" : "6")) {
      add("fiscal_cfop_missing", `${prefix}.cfop`, `A natureza ${text(nature.description)} está sem CFOP para o produto ${name} e este destino.`, "fiscal_natures", natureId, id);
    } else out.cfop = details.cfop;
    if (present(details.codigoBeneficioFiscal)) {
      if (!/^([A-Za-z0-9]{8}|[A-Za-z0-9]{10}|SEM CBENEF)$/.test(text(details.codigoBeneficioFiscal))) productError("codigoBeneficioFiscal", "código de benefício fiscal");
      else out.codigoBeneficioFiscal = details.codigoBeneficioFiscal;
    }
    // A unidade tributável igual usa os valores comerciais, conforme o contrato.
    // Conversão diferente só é possível com o trio já salvo; jamais usa fator presumido.
    const taxable = object(item.tributavel ?? item.taxable), taxUnit = taxable.unit ?? taxable.unidade ?? product.tax_unit ?? product.unit_tax;
    const taxableOut: Obj = { unidade: out.unidade, quantidade: out.quantidade, valorUnitario: out.valorUnitario };
    if (present(taxUnit) && taxUnit !== item.unit) {
      if (!validText(taxUnit, 1, 6)) productError("tributavel.unidade", "unidade tributável");
      taxableOut.unidade = taxUnit;
      const q = amount(taxable.quantity ?? taxable.quantidade, `${prefix}.tributavel.quantidade`, "fiscal_product_incomplete", "products", productId, id, 4, true, 99999999999.9999);
      const p = amount(taxable.unit_price ?? taxable.valorUnitario, `${prefix}.tributavel.valorUnitario`, "fiscal_product_incomplete", "products", productId, id, 10, false, 100000000000);
      if (q !== null) taxableOut.quantidade = q;
      if (p !== null) taxableOut.valorUnitario = p;
      if (q !== null && p !== null && lineTotalCents(text(taxable.quantity ?? taxable.quantidade), text(taxable.unit_price ?? taxable.valorUnitario)) !== cents(item.gross)) unsupported(`${prefix}.tributavel`, "conversão tributável com total diferente", productId, id);
    }
    if (present(out.tax_ean ?? out.ean)) taxableOut.ean = out.tax_ean ?? out.ean;
    delete out.tax_ean;
    out.tributavel = taxableOut;
    out.compoeTotal = true;
    for (const [from, to] of [["freight", "frete"], ["insurance", "seguro"], ["discount", "desconto"], ["other_expenses", "outrasDespesas"]] as const) {
      if (from === "insurance" && !present(d.insurance)) continue;
      const allocated = taxes.allocations[from]?.[index];
      if (allocated !== undefined && /^\d+$/.test(allocated)) out[to] = moneyNumber(BigInt(allocated));
    }
    if (!validText(text(d.number), 1, 15)) unsupported(`${prefix}.numeroPedido`, "número comercial fora do limite", orderId, id); else out.numeroPedido = text(d.number);
    const position = Number(item.position);
    if (!Number.isInteger(position) || position < 1 || position > 999999) unsupported(`${prefix}.itemPedido`, "posição comercial inválida", orderId, id); else out.itemPedido = position;
    const itemTexts = [...new Set([item.fiscal_info, item.additional_info, product.additional_info].filter(present).map(text))].join(" ");
    const additional = info(itemTexts, `${prefix}.informacoesAdicionais`, 500, productId);
    if (additional) out.informacoesAdicionais = additional;
    out.impostos = taxes.item_taxes[index] ?? {};
    outputItems.push(out);
  });

  const payments: Obj[] = [], duplicates: Obj[] = [], groups = new Map<string, { value: Obj; cents: bigint }>();
  let parcelSum = 0n;
  const parcels = snapshot.payments;
  if (!parcels.length) add("fiscal_payment_incomplete", "pagamentos", "Complete as parcelas e os dados fiscais da forma de pagamento.", "sales_orders", orderId);
  if (parcels.length > 120) add("fiscal_payment_incomplete", "cobranca.duplicatas", "O contrato permite até 120 parcelas.", "sales_orders", orderId);
  parcels.forEach((raw, index) => {
    const parcel = raw as Obj, method = object(parcel.payment_method), details = object(parcel.details), prefix = `pagamentos[${index}]`;
    const problem = (field: string, label: string) => add("fiscal_payment_incomplete", `${prefix}.${field}`, `Complete ${label} da forma de pagamento ou parcela ${index + 1}.`, "sales_orders", orderId);
    const value = amount(parcel.amount, `${prefix}.valor`, "fiscal_payment_incomplete", "sales_orders", orderId);
    const parsed = cents(parcel.amount);
    if (parsed !== null) parcelSum += parsed;
    const form = text(details.payment_type ?? method.payment_type ?? d.payment_means), indicator = text(parcel.payment_indicator ?? d.payment_indicator);
    if (!PAYMENT_TYPES.has(form)) problem("forma", "código fiscal");
    if (present(parcel.payment_method_id) && !Object.keys(method).length) problem("forma", "cadastro vinculado da forma de pagamento");
    if (method.active === false) problem("forma", "forma de pagamento ativa");
    if (present(method.applicable) && !["recebimentos", "ambos"].includes(text(method.applicable))) problem("forma", "forma de pagamento aplicável a recebimentos");
    if (form === "90" && parsed !== 0n) problem("valor", "valor zero para operação sem pagamento");
    if (present(method.pix_cnpj) || present(method.pix_integration) && method.pix_integration !== "sem") unsupported(`${prefix}.pix`, "detalhes de integração Pix não representáveis no contrato");
    if (!["0", "1"].includes(indicator)) problem("indicador", "indicador à vista/a prazo");
    const payment: Obj = { forma: form, indicador: indicator === "0" ? "a_vista" : "a_prazo" };
    if (form === "99") {
      const description = method.description ?? parcel.method;
      if (!validText(description, 2, 60)) problem("descricao", "descrição (2 a 60 caracteres)"); else payment.descricao = description;
    }
    const cardValues = { integracao: details.integration_type ?? method.card_integration, cnpjCredenciadora: details.acquirer_cnpj ?? method.card_cnpj,
      bandeira: details.card_brand ?? method.card_brand, autorizacao: details.authorization_code };
    const hasCard = Object.values(cardValues).some(present);
    if (["03", "04"].includes(form) || hasCard) {
      if (!["03", "04"].includes(form)) unsupported(`${prefix}.cartao`, "detalhes de cartão em outra forma de pagamento");
      const card: Obj = {}, integration = text(cardValues.integracao);
      if (!["1", "2"].includes(integration)) problem("cartao.integracao", "integração do cartão"); else card.integracao = integration === "1" ? "integrado" : "nao_integrado";
      if (present(cardValues.cnpjCredenciadora)) { const c = digits(cardValues.cnpjCredenciadora); if (!validCnpj(c)) problem("cartao.cnpjCredenciadora", "CNPJ da credenciadora"); else card.cnpjCredenciadora = c; }
      if (present(cardValues.bandeira)) { if (!/^\d{2}$/.test(text(cardValues.bandeira))) problem("cartao.bandeira", "bandeira"); else card.bandeira = cardValues.bandeira; }
      if (present(cardValues.autorizacao)) { if (!validText(cardValues.autorizacao, 1, 128)) problem("cartao.autorizacao", "autorização"); else card.autorizacao = cardValues.autorizacao; }
      if (integration === "1") for (const key of ["cnpjCredenciadora", "bandeira", "autorizacao"]) if (!present(card[key])) problem(`cartao.${key}`, key);
      payment.cartao = card;
    }
    const key = JSON.stringify(payment), group = groups.get(key);
    if (group && parsed !== null) group.cents += parsed;
    else if (parsed !== null) groups.set(key, { value: payment, cents: parsed });
    const due = text(parcel.due_date), number = text(parcel.id ?? parcel.position);
    if (!validDate(due)) problem("vencimento", "vencimento válido");
    if (!validText(number, 1, 60)) problem("numero", "identificador estável da parcela");
    if (value !== null) duplicates.push({ numero: number, vencimento: due, valor: value });
  });
  for (const group of groups.values()) {
    if (group.cents > 999999999999999n) add("fiscal_payment_incomplete", "pagamentos.valor", "O pagamento agrupado ultrapassa o limite fiscal.", "sales_orders", orderId);
    payments.push({ ...group.value, valor: moneyNumber(group.cents) });
  }
  if (payments.length > 100) add("fiscal_payment_incomplete", "pagamentos", "O contrato permite até 100 pagamentos com detalhes fiscais distintos.", "sales_orders", orderId);
  const total = taxes.total_cents !== null && /^\d+$/.test(taxes.total_cents) ? BigInt(taxes.total_cents) : null;
  const commercialTotal = cents(object(d.totals).total);
  const changeValue = d.change ?? d.troco;
  const change = present(changeValue) ? cents(changeValue) : 0n;
  if (present(changeValue)) amount(changeValue, "troco", "fiscal_payment_incomplete", "sales_orders", orderId);
  // Parcelas são os compromissos salvos pelo valor bruto; taxas de cartão não reduzem pagamentos.
  if (total === null || commercialTotal === null || change === null || commercialTotal !== total ||
      (present(d.stored_total) && cents(d.stored_total) !== commercialTotal) || parcelSum - (change ?? 0n) !== total || parcelSum !== commercialTotal) {
    add("fiscal_total_mismatch", "totais", "Pedido, parcelas e cálculo fiscal têm totais diferentes. Revise e salve o pedido.", "sales_orders", orderId);
  }

  const transport = snapshot.transport as Obj, mode = text(transport.freight_mode), carrier = object(transport.carrier), outTransport: Obj = {};
  const transportProblem = (field: string, label: string) => add("fiscal_transport_incomplete", `transporte.${field}`, `Complete ${label} do transporte ou corrija a modalidade de frete.`, "sales_orders", orderId);
  if (!["0", "1", "2", "3", "4", "9"].includes(mode)) transportProblem("modalidade", "modalidade salva"); else outTransport.modalidade = Number(mode);
  if (mode === "9" && ((cents(d.freight) ?? 0n) !== 0n || Object.keys(carrier).length || present(transport.vehicle) || present(transport.volume_count) || present(transport.gross_weight))) transportProblem("modalidade", "coerência entre sem frete e os dados informados");
  if (Object.keys(carrier).length) {
    const out: Obj = {}, document = digits(carrier.document);
    if (carrier.person_type === "J" && validCnpj(document)) out.cnpj = document;
    else if (carrier.person_type === "F" && cpfValid(document)) out.cpf = document;
    else transportProblem("transportadora.documento", "CPF/CNPJ da transportadora");
    for (const [from, to] of [["name", "nome"], ["city", "municipio"]] as const) {
      if (!validText(carrier[from], 2, 60)) transportProblem(`transportadora.${to}`, to); else out[to] = carrier[from];
    }
    const address = [carrier.street, carrier.number, carrier.district].filter(present).join(", ");
    if (!present(carrier.street) || !present(carrier.number) || !present(carrier.district) || !validText(address, 1, 60)) transportProblem("transportadora.endereco", "endereço completo da transportadora (até 60 caracteres)"); else out.endereco = address;
    if (!UF.test(text(carrier.state))) transportProblem("transportadora.uf", "UF da transportadora"); else out.uf = carrier.state;
    if (present(carrier.ie)) { if (!/^\d{2,14}$/.test(digits(carrier.ie))) transportProblem("transportadora.inscricaoEstadual", "IE da transportadora"); else out.inscricaoEstadual = digits(carrier.ie); }
    outTransport.transportadora = out;
  } else if (["0", "1", "2"].includes(mode) && present(transport.carrier_reference)) transportProblem("transportadora", "cadastro vinculado da transportadora");
  const vehicle = object(transport.vehicle ?? transport.veiculo);
  if (Object.keys(vehicle).length) {
    const plate = text(vehicle.plate ?? vehicle.placa), out: Obj = { placa: plate };
    if (!/^[A-Z0-9]{7}$/.test(plate)) transportProblem("veiculo.placa", "placa");
    const state = vehicle.state ?? vehicle.uf;
    if (present(state)) { if (!UF.test(text(state))) transportProblem("veiculo.uf", "UF do veículo"); else out.uf = state; }
    if (present(vehicle.rntc)) { if (!validText(vehicle.rntc, 1, 20)) transportProblem("veiculo.rntc", "RNTC"); else out.rntc = vehicle.rntc; }
    outTransport.veiculo = out;
  }
  const volumes = Array.isArray(transport.volumes) ? transport.volumes : [transport];
  const outVolumes: Obj[] = [];
  volumes.forEach((raw, index) => {
    const v = object(raw), out: Obj = {};
    for (const [from, alternate, to, scale] of [["volume_count", "quantity", "quantidade", 0], ["gross_weight", "pesoBruto", "pesoBruto", 6], ["net_weight", "pesoLiquido", "pesoLiquido", 6]] as const) {
      const rawValue = v[from] ?? v[alternate];
      if (present(rawValue)) { const val = amount(rawValue, `transporte.volumes[${index}].${to}`, "fiscal_transport_incomplete", "sales_orders", orderId, undefined, scale, false, Number.MAX_SAFE_INTEGER); if (val !== null) out[to] = val; }
    }
    for (const [from, to] of [["species", "especie"], ["brand", "marca"], ["numbering", "numeracao"]] as const) {
      const value = v[from] ?? v[to];
      if (present(value)) { if (!validText(value, 1, 60)) transportProblem(`volumes[${index}].${to}`, to); else out[to] = value; }
    }
    if (typeof out.pesoLiquido === "number" && typeof out.pesoBruto === "number" && out.pesoLiquido > out.pesoBruto) transportProblem(`volumes[${index}].pesoLiquido`, "peso líquido menor ou igual ao bruto");
    if (Object.keys(out).length) outVolumes.push(out);
  });
  if (outVolumes.length) outTransport.volumes = outVolumes;
  if (outVolumes.length > 5000) transportProblem("volumes", "limite de 5.000 volumes");

  const body: Obj = { ambiente: options.environment, referencia: options.reference, naturezaOperacao: nature.description, tipo: "saida", finalidade: "normal",
    presenca: choices.presence, consumidorFinal: choices.final_consumer, destinoOperacao: destination, emitente, destinatario,
    itens: outputItems, pagamentos: payments, transporte: outTransport };
  if (options.series !== undefined && options.series !== null) body.serie = options.series;
  if (present(changeValue) && change !== null) body.troco = moneyNumber(change);
  const departure = d.ship_datetime ?? d.ship_date;
  if (present(departure)) {
    const value = text(departure);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)) || !validDate(value.slice(0, 10))) unsupported("dataSaida", "data de saída sem horário e fuso salvos");
    else body.dataSaida = value;
  }
  for (const [field, values, max] of [["informacoesComplementares", [d.notes, d.fiscal_notes, invoice.nature_additional_info], 5000], ["informacoesFisco", [d.fiscal_info, invoice.nature_fiscal_info], 2000]] as const) {
    const combined = [...new Set(values.filter(present).map(text))].join(" ");
    const value = info(combined, field, max);
    if (value) body[field] = value;
  }
  const responsible = object(company.technical_responsible ?? object(sources.tax_sources.settings).technical_responsible);
  if (Object.keys(responsible).length) {
    const value = { cnpj: digits(responsible.cnpj), contato: responsible.contact ?? responsible.contato, email: responsible.email, telefone: digits(responsible.phone ?? responsible.telefone) };
    for (const [field, valid] of [["cnpj", validCnpj(value.cnpj)], ["contato", validText(value.contato, 2, 60)], ["email", validText(value.email, 6, 60) && EMAIL.test(text(value.email))], ["telefone", /^\d{6,14}$/.test(value.telefone)]] as const) {
      if (!valid) add("fiscal_issuer_incomplete", `responsavelTecnico.${field}`, `Complete ${field} do responsável técnico em Dados da empresa antes de emitir.`, "company", "1");
    }
    body.responsavelTecnico = value;
  } else if (company.technical_responsible_required === true || object(sources.tax_sources.settings).technical_responsible_required === true) {
    add("fiscal_issuer_incomplete", "responsavelTecnico", "Complete o responsável técnico em Dados da empresa antes de emitir.", "company", "1");
  }
  const discount = taxes.allocations.discount.reduce((sum, value) => sum + BigInt(value), 0n);
  if (commercialTotal !== null && commercialTotal + discount > 999999999999999n) add("fiscal_payment_incomplete", "cobranca.fatura.valorOriginal", "O valor original da fatura ultrapassa o limite fiscal.", "sales_orders", orderId);
  if (commercialTotal !== null && validText(text(d.number), 1, 60)) body.cobranca = { fatura: { numero: text(d.number), valorOriginal: moneyNumber(commercialTotal + discount), desconto: moneyNumber(discount), valorLiquido: moneyNumber(commercialTotal) }, duplicatas: duplicates };
  const calculation = { ...taxes.calculation, commercial_total_cents: commercialTotal?.toString() ?? null, installment_total_cents: parcelSum.toString(),
    fiscal_total_cents: total?.toString() ?? null, payments, transport: outTransport } as JsonObject;
  const sorted = [...new Map(blockers.map(b => [`${b.field}\u0000${b.code}\u0000${b.item_id ?? ""}`, b])).values()].sort((a, b) => a.field < b.field ? -1 : a.field > b.field ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  return { body: sorted.length ? null : body as PedidoNfe, calculation, blockers: sorted, total_cents: taxes.total_cents };
}
