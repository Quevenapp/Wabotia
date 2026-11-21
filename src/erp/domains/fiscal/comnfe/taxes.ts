/** Adaptação fiscal estrita: o motor existente calcula; esta camada confere
 * suas entradas e só projeta grupos que o contrato do cofre representa. */
import type { CommercialSnapshot, FiscalBlocker, FiscalChoices, JsonObject, JsonValue } from "../../../commercial-nfe/contracts.ts";
// @ts-expect-error O motor compartilhado é JavaScript, sem declaração TypeScript.
import { calculateInvoiceTaxes, matchRule, infoVariables, fillVariables, SIMPLES_CREDIT_MESSAGE } from "../../../fagoo/packages/fiscal-core/src/tax-engine.mjs";
// @ts-expect-error As funções decimais compartilhadas são JavaScript.
import { allocateCents, invoiceTotals, lineTotalCents } from "../../../fagoo/packages/erp-domain/src/fiscal-invoice-contract.mjs";
// @ts-expect-error O contrato decimal compartilhado é JavaScript.
import { centsOf, moneyOf, checkValue } from "../../../fagoo/packages/erp-domain/src/fiscal-invoice-dto.mjs";
import { add, compareNum, mul, neg, num, round, shift, text as decimalText } from "../../catalog/pricing/money.ts";
import { calculateReform, reformBaseFromItem, reformYearOf, type ReformCompanySettings, type ReformItemResult, type ReformSelectiveInput } from "../reform-calc.ts";
import { ICMS_MONOPHASE_CST, SUFRAMA_DESONERATION_REASON, specialGroupBlockMessage, specialGroupOfKey } from "./special-groups.ts";

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
const present = (value: unknown): boolean => value !== null && value !== undefined && value !== "";
const meaningful = (value: unknown): boolean => present(value) && value !== false && (!Array.isArray(value) || value.length > 0) && (typeof value !== "object" || Object.values(value as Obj).some(meaningful));
const nonzero = (value: unknown): boolean => meaningful(value) && !(typeof value === "number" ? value === 0 : typeof value === "string" && /^0+(?:\.0+)?$/.test(value));
const string = (value: unknown): string => present(value) ? String(value) : "";
const money = (value: unknown): bigint => centsOf(String(value)) as bigint;
const json = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;
const percentage = (amount: unknown, rate: unknown): string => decimalText(round(shift(mul(num(String(amount)), num(String(rate))), 2), 2));
const reduction = (baseRate: unknown): string => decimalText(add(num("100"), neg(num(String(baseRate)))));
const OWN = ["00", "10", "20", "51", "70", "90", "900"];
const ST = ["10", "30", "70", "201", "202", "203"];
const CREDIT = ["101", "201"];
const RETAINED = ["60", "500"];
const MONOPHASE: readonly string[] = ICMS_MONOPHASE_CST;
const RATED = ["01", "02", "49", "98", "99"];
const PIS_CST = /^(0[1-9]|49|5[0-6]|6[0-7]|7[0-5]|98|99)$/;
const CST = ["00", "10", "20", "30", "40", "41", "50", "51", "60", "70", "90"];
const CSOSN = ["101", "102", "103", "201", "202", "203", "300", "400", "500", "900"];

export interface PreparationTaxSources {
  snapshot: CommercialSnapshot;
  tax_sources: JsonObject;
  choices: FiscalChoices;
}
export interface TaxPreparationResult {
  invoice: JsonObject;
  item_taxes: JsonObject[];
  item_details: JsonObject[];
  /** Centavos como texto, nunca ponto flutuante. */
  allocations: { freight: string[]; insurance: string[]; discount: string[]; other_expenses: string[] };
  total_cents: string | null;
  calculation: JsonObject;
  blockers: FiscalBlocker[];
}

/** Sem I/O: todas as fontes foram lidas na mesma transação de preparação. */
export function calculatePreparationTaxes(sources: PreparationTaxSources): TaxPreparationResult {
  const { snapshot, tax_sources: taxSources, choices } = sources;
  const nature = obj(snapshot.nature), document = obj(snapshot.document), totals = obj(document.totals);
  const company = obj(snapshot.company), recipient = obj(snapshot.recipient), settings = obj(taxSources.settings);
  const products = new Map(snapshot.products.map(product => [string(product.id ?? product.record_id), obj(product)]));
  const blockers: FiscalBlocker[] = [], selections: Obj[] = [], itemTaxes: JsonObject[] = [], itemDetails: JsonObject[] = [];
  const allocations: TaxPreparationResult["allocations"] = { freight: [], insurance: [], discount: [], other_expenses: [] };
  let numericInvalid = false;
  const block = (code: string, field: string, message: string, index?: number, screen = "fiscal_natures") => {
    const item = index === undefined ? null : snapshot.items[index];
    const entity = screen === "products" ? item?.product_id : screen === "sales_orders" ? document.id : nature.id;
    blockers.push({ code, field, ...(item?.id ? { item_id: String(item.id) } : {}),
      ...(entity ? { entity_id: String(entity) } : {}), message,
      correction: { screen, ...(["fiscal_natures", "products", "sales_orders"].includes(screen) && entity ? { id: String(entity) } : {}), field } });
  };
  const missing = (field: string, tax: string, index: number) => block("fiscal_tax_data_missing", `items.${index}.${tax}.${field}`,
    `Falta ${field} de ${tax.toUpperCase()} no item ${snapshot.items[index].description ?? index + 1}. Corrija a regra da natureza.`, index);
  const unsupported = (field: string, feature: string, index?: number) => block("fiscal_operation_unsupported", field,
    `O item ou a operação usa ${feature}, ainda não atendido nesta fatia. Revise a operação com o contador.`, index);
  const reform = (field: string, index?: number) => block("fiscal_reform_required", field, "Esta operação precisa de IBS/CBS/IS, ainda não calculados nesta fatia.", index);
  // Reforma tributária: o que o cofre aceita (comnfe/source.ts, reform_calc).
  // Sem a leitura do contrato (teste de conexão antigo), a classificação
  // continua bloqueando, como antes; com o cofre que não aceita, a nota sai
  // como hoje, sem o grupo, e o cálculo fica só informativo.
  const reformSources = obj(taxSources.reform_calc);
  const vaultKnown = reformSources.vault_known === true;
  const vaultAccepts = vaultKnown && obj(reformSources.vault).ibs_cbs === true;
  const vaultSelective = vaultAccepts && obj(reformSources.vault).selective === true;
  const reformUnknown = (field: string, index?: number) => block("fiscal_reform_required", field,
    "Este item tem classificação de IBS/CBS, mas o Wabotia ainda não sabe se o seu cofre recebe a reforma tributária. Teste a conexão do cofre e salve a configuração da NF-e (Fiscal › Emissor fiscal) e prepare a nota de novo.", index, "fiscal_settings");
  const amount = (value: unknown, field: string, scale = 2, digits = 13, index?: number): string | null => {
    // Zeros finais de quantidade comercial com seis casas não mudam seu valor.
    const raw = typeof value === "string" || typeof value === "number" ? String(value).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "") : value;
    try {
      const canonical = checkValue(raw, `d:${scale}:${digits}`, field) as string | null;
      if (canonical === null) throw new Error("missing");
      return canonical;
    } catch {
      numericInvalid = true;
      block("fiscal_tax_data_missing", field, `Confira ${field}: informe um valor não negativo com até ${scale} casas decimais, dentro do limite fiscal.`, index, field.includes(".product.") ? "products" : "sales_orders");
      return null;
    }
  };
  const required = (data: Obj, fields: string[], tax: string, index: number) => {
    for (const field of fields) if (!present(data[field])) missing(field, tax, index);
  };
  const checkNumericFields = (data: Obj, tax: string, index: number) => {
    for (const [key, value] of Object.entries(data)) {
      if (!present(value) || !/(?:^rate$|_rate$|^base$|_base$|^value$|_value$|_mva$)/.test(key)) continue;
      const isMoney = /(?:^value$|^base$|_value$|_base$)/.test(key) && !key.includes("pauta") && !key.startsWith("unit");
      try { checkValue(String(value), `d:${isMoney ? 2 : 4}:${isMoney ? 13 : key.includes("pauta") || key.startsWith("unit") ? 11 : 3}`, key); }
      catch { missing(key, tax, index); numericInvalid = true; }
      if (key.endsWith("base_rate") && Number(value) > 100) { missing(key, tax, index); numericInvalid = true; }
    }
  };

  for (const [key, value] of Object.entries(nature)) if (/ibs|cbs|selective|seletivo|reform_required/i.test(key) && meaningful(value)) reform(`nature.${key}`);
  const others = obj(nature.others), retentions = obj(nature.retentions);
  for (const key of ["presumed_pis_cofins", "funrural_rate", "rural_producer_purchase", "deduct_funrural", "add_icms", "add_other_expenses"])
    if (nonzero(others[key])) unsupported(`nature.others.${key}`, key);
  if (Object.values(retentions).some(nonzero)) unsupported("nature.retentions", "retenções tributárias");
  if (["table", "product"].includes(String(others.approx_tax_type))) unsupported("nature.others.approx_tax_type", "tributos aproximados sem cálculo configurado");
  if (others.approx_tax_type === "fixed" && !present(others.approx_tax_rate)) block("fiscal_tax_data_missing", "nature.others.approx_tax_rate", "Informe a alíquota dos tributos aproximados na natureza.");

  const rules = Array.isArray(nature.rules) ? nature.rules as Obj[] : [];
  const difalByState = obj(taxSources.difal_by_state), productGroups = obj(taxSources.product_groups);
  const destination = string(recipient.state), interstate = destination !== string(company.state);
  const difalTarget = choices.final_consumer && recipient.taxpayer === "9" && interstate && destination !== "EX";
  const difalMode = difalByState[destination] ?? settings.difal_default;
  if (difalTarget && !present(difalMode)) block("fiscal_tax_data_missing", "settings.difal_default", "Configure a forma de cálculo do DIFAL antes de emitir.", undefined, "fiscal_parameters");
  if (difalTarget && present(difalMode) && !["none", "inside", "goods"].includes(String(difalMode))) unsupported("settings.difal_default", `DIFAL ${difalMode}`);

  const lineAmounts: bigint[] = [], lineDiscounts: bigint[] = [];
  const items: Obj[] = snapshot.items.map((saved, index) => {
    const product = products.get(string(saved.product_id)) ?? {};
    const quantity = amount(saved.quantity, `items.${index}.quantity`, 4, 11, index);
    const unitPrice = amount(saved.unit_price, `items.${index}.unit_price`, 10, 11, index);
    if (quantity !== null && !/[1-9]/.test(quantity)) { numericInvalid = true; unsupported(`items.${index}.quantity`, "quantidade não positiva", index); }
    const discount = amount(saved.discount, `items.${index}.discount`, 2, 13, index);
    const line = quantity !== null && unitPrice !== null ? lineTotalCents(quantity, unitPrice) as bigint : 0n;
    lineAmounts.push(line); lineDiscounts.push(discount === null ? 0n : money(discount));
    const gross = amount(saved.gross, `items.${index}.gross`, 2, 13, index), net = amount(saved.total, `items.${index}.total`, 2, 13, index);
    if (gross !== null && money(gross) !== line || net !== null && discount !== null && money(net) !== line - money(discount))
      block("fiscal_total_mismatch", `items.${index}.total`, "Pedido, parcelas e cálculo fiscal têm totais diferentes. Revise e salve o pedido.", index, "sales_orders");
    const classified = meaningful(product.reform_class) || meaningful(obj(taxSources.reform_by_product)[string(saved.product_id)]);
    if (classified && !vaultKnown) reformUnknown(`items.${index}.reform_class`, index);
    for (const source of [saved, product]) for (const [key, value] of Object.entries(source)) {
      // A classificação do cadastro é tratada acima (e calculada abaixo); grupos digitados no item continuam recusados.
      if (key === "reform_class" && source === product) continue;
      if (/^(ibs_?cbs|ibsCbs|ibs|cbs|is|impostoSeletivo|reform_required|reform_class)$/.test(key) && meaningful(value)) reform(`items.${index}.${key}`, index);
      if (["ii", "import", "importacao", "export", "exportacao", "fuel", "medicine", "weapon", "vehicle", "retentions", "issqn", "rastro"].includes(key) && meaningful(value)) {
        // Casos especiais (special-groups.ts): a mensagem diz o grupo que o cofre não recebe e o que fazer.
        const special = specialGroupOfKey(key);
        if (special) block("fiscal_operation_unsupported", `items.${index}.${key}`, specialGroupBlockMessage(special, `Item ${index + 1}`), index, source === product ? "products" : "sales_orders");
        else unsupported(`items.${index}.${key}`, key, index);
      }
    }
    for (const key of ["ipi_fixed_value", "pis_fixed_value", "cofins_fixed_value", "ipi_framework_class", "ipi_seal_code", "ipi_tipi_exception", "anp_code", "anp_description", "glp_percent", "glgnn_percent", "glgni_percent", "starting_value", "fci_number"]) {
      if (!nonzero(product[key])) continue;
      const special = specialGroupOfKey(key);
      if (special) block("fiscal_operation_unsupported", `items.${index}.product.${key}`, specialGroupBlockMessage(special, `Produto ${string(product.name ?? saved.description) || index + 1}`), index, "products");
      else unsupported(`items.${index}.product.${key}`, key, index);
    }
    const selected: Obj = {};
    for (const tax of ["icms", "ipi", "pis", "cofins", "ii"]) {
      const rule = matchRule(rules, tax, { state: destination, productId: saved.product_id, ncm: product.ncm, groupId: productGroups[string(saved.product_id)] ?? product.group_id ?? null }) as Obj | null;
      if (rule) selected[tax] = rule;
    }
    selections.push(selected);
    const ir = obj(obj(selected.icms).data), situation = string(ir.situation);
    if (!selected.icms) missing("regra aplicável", "icms", index);
    if (!present(ir.cfop)) block("fiscal_cfop_missing", `items.${index}.cfop`, `A natureza ${nature.description ?? "selecionada"} está sem CFOP para o produto ${saved.description ?? index + 1} e este destino.`, index);
    else if (!new RegExp(`^${interstate ? "6" : "5"}[0-9]{3}$`).test(String(ir.cfop))) unsupported(`items.${index}.cfop`, `CFOP ${ir.cfop} incompatível com saída nacional e destino`, index);
    const simple = ["1", "4"].includes(string(company.crt));
    if (MONOPHASE.includes(situation)) block("fiscal_operation_unsupported", `items.${index}.icms.situation`, specialGroupBlockMessage("icms_monophase", `Item ${index + 1}`), index);
    else if (!(simple ? CSOSN : CST).includes(situation)) missing(simple ? "CSOSN compatível com CRT" : "CST compatível com CRT", "icms", index);
    required(ir, ["situation"], "icms", index);
    if (OWN.includes(situation)) required(ir, ["bc_mode", "base_rate", "rate"], "icms", index);
    if (["1", "2"].includes(string(ir.bc_mode))) required(ir, ["pauta_value"], "icms", index);
    if (situation === "51") required(ir, ["deferral_rate"], "icms", index);
    if (nonzero(ir.fcp_rate) && !OWN.includes(situation)) unsupported(`items.${index}.icms.fcp_rate`, "FCP sem base própria calculada pelo motor", index);
    if (nonzero(ir.credit_rate) && !["101", "201", "900"].includes(situation)) unsupported(`items.${index}.icms.credit_rate`, "crédito fora do grupo calculado pelo motor", index);
    if (nonzero(ir.deferral_rate) && situation !== "51") unsupported(`items.${index}.icms.deferral_rate`, "diferimento fora do grupo calculado pelo motor", index);
    if (nonzero(ir.st_rate) && ![...ST, "90", "900"].includes(situation)) unsupported(`items.${index}.icms.st_rate`, "ST fora do grupo calculado pelo motor", index);
    if (present(ir.deson_reason) && !["20", "30", "40", "41", "50", "70", "90"].includes(situation)) unsupported(`items.${index}.icms.deson_reason`, "desoneração fora do grupo calculado pelo motor", index);
    if (CREDIT.includes(situation) && !present(ir.credit_rate) && !present(others.simples_credit_rate)) missing("credit_rate", "icms", index);
    if (ST.includes(situation) || present(ir.st_rate)) {
      required(ir, ["st_bc_mode", "st_base_rate", "st_rate"], "icms", index);
      if (["201", "202", "203"].includes(situation)) required(ir, ["rate", "base_rate", "bc_mode"], "icms", index);
      if (ir.st_bc_mode === "4") required(ir, ["st_mva"], "icms", index);
      if (["0", "1", "2", "3", "5"].includes(string(ir.st_bc_mode))) required(ir, ["st_pauta_value"], "icms", index);
      if (settings.st_contributor_differentiated === true && choices.final_consumer && recipient.taxpayer === "1") unsupported(`items.${index}.icms.st`, "ST diferenciada para consumidor contribuinte", index);
      if (!present(product.cest)) block("fiscal_product_incomplete", `items.${index}.cest`, `O produto ${saved.description ?? index + 1} está sem CEST, necessário para esta operação.`, index, "products");
    }
    if (RETAINED.includes(situation)) {
      required(ir, ["retained_rate"], "icms", index);
      if (settings.st_retained_from_sale === true) required(ir, ["retained_base_rate"], "icms", index);
      else for (const field of ["icms_st_retention_base", "icms_st_retention_value"])
        if (!present(product[field])) block("fiscal_product_incomplete", `items.${index}.product.${field}`,
          `O produto ${saved.description ?? index + 1} está sem ${field}, necessário para esta operação.`, index, "products");
    }
    if (difalTarget && difalMode !== "none" && ir.difal_type !== "I") {
      required(ir, ["rate", "difal_internal_rate", "difal_base_rate"], "icms", index);
      if (present(ir.rate) && ![4, 7, 12].includes(Number(ir.rate))) missing("alíquota interestadual de 4, 7 ou 12", "icms", index);
    }
    for (const key of ["st_pis_rate", "st_cofins_rate", "presumed_credit_code", "presumed_rate", "rbc_benefit_code", "reduction_reason", "fcp_deferral_rate", "st_fcp_value", "st_deson_value", "st_deson_reason"])
      if (nonzero(ir[key])) unsupported(`items.${index}.icms.${key}`, key, index);
    if (present(ir.deson_reason)) { required(ir, ["rate", "deson_deduct"], "icms", index); }
    // Desoneração "Suframa" exige a inscrição Suframa do cliente (dest/ISUF), que o cofre não recebe.
    if (string(ir.deson_reason) === SUFRAMA_DESONERATION_REASON) block("fiscal_operation_unsupported", `items.${index}.icms.deson_reason`, specialGroupBlockMessage("suframa", `Item ${index + 1}`), index);
    if (selected.ii && obj(obj(selected.ii).data).situation !== "N") unsupported(`items.${index}.ii`, "imposto de importação", index);
    for (const tax of ["icms", "ipi", "pis", "cofins"]) {
      const rule = obj(selected[tax]), data = obj(rule.data);
      checkNumericFields(data, tax, index);
      const fields = tax === "icms"
        ? ["situation", "cfop", "taxation", "bc_mode", "base_rate", "rate", "pauta_value", "credit_rate", "fcp_rate", "benefit_code", "st_bc_mode", "st_base_rate", "st_rate", "st_mva", "st_pauta_value", "retained_rate", "retained_base_rate", "difal_type", "difal_base_rate", "difal_internal_rate", "difal_fcp_rate", "deson_reason", "deson_deduct", "deferral_rate"]
        : ["situation", "taxation", "base_rate", "rate", ...(tax === "ipi" ? ["framing_code"] : [])];
      for (const [field, value] of Object.entries(data)) if (!fields.includes(field) && nonzero(value)) unsupported(`items.${index}.${tax}.${field}`, field, index);
      if (!rule.data && tax !== "ipi" && tax !== "icms") missing("regra aplicável", tax, index);
      if (tax === "ipi" && rule.data) {
        required(data, ["situation", "framing_code"], tax, index);
        if (!/^[0-9]{3}$/.test(string(data.framing_code))) missing("código de enquadramento com três dígitos", tax, index);
        if (!["50", "51", "52", "53", "54", "55", "99"].includes(string(data.situation))) unsupported(`items.${index}.ipi.situation`, "CST de IPI incompatível com saída", index);
        if (["00", "49", "50", "99"].includes(string(data.situation))) required(data, ["rate", "base_rate"], tax, index);
        if (present(data.unit_value)) unsupported(`items.${index}.ipi.unit_value`, "IPI por unidade", index);
      }
      if ((tax === "pis" || tax === "cofins") && rule.data) {
        if (!PIS_CST.test(string(data.situation))) missing("CST válido", tax, index);
        if (data.situation === "03" || present(data.unit_value)) unsupported(`items.${index}.${tax}.situation`, `${tax.toUpperCase()} por quantidade`, index);
        else if (RATED.includes(string(data.situation))) required(data, ["rate", "base_rate"], tax, index);
      }
    }
    const previousRetention: Obj = {};
    if (RETAINED.includes(situation)) {
      for (const [from, to] of [["icms_st_retention_base", "ret_base"], ["icms_st_retention_value", "ret_value"], ["icms_own_substitute_value", "ret_substitute_value"]])
        if (present(product[from])) previousRetention[to] = amount(product[from], `items.${index}.product.${from}`, 2, 13, index);
      if (present(ir.retained_rate)) previousRetention.ret_rate = ir.retained_rate;
    }
    return { product_id: saved.product_id, code: saved.code, description: saved.description, unit: saved.unit,
      quantity, unit_price: unitPrice, ncm: product.ncm, cest: product.cest, gtin: product.gtin, gtin_tax: product.gtin_tax,
      invoiced: true, discount, icms: { ...(present(product.origin) ? { origin: product.origin } : {}), ...previousRetention },
      ...(present(document.customer_po_number) ? { others: { purchase_order: document.customer_po_number } } : {}) };
  });

  for (const key of ["gross", "line_discount", "total", "freight", "other_expenses"]) amount(totals[key], `totals.${key}`);
  for (const key of ["ipi", "icms_st"]) if (present(totals[key])) amount(totals[key], `totals.${key}`);
  const headerDiscount = amount(totals.discount, "totals.discount"), freight = amount(document.freight, "freight"), otherExpenses = amount(document.other_expenses, "other_expenses");
  // O pedido comercial não tem seguro; ausência é inaplicável, não alíquota ausente.
  const insurance = present(document.insurance) ? amount(document.insurance, "insurance") : "0.00";
  const invoice: Obj = { nature_id: nature.id, direction: "1", issue_type: "N", final_consumer: choices.final_consumer,
    operation_destination: interstate ? "2" : "1", recipient: { ...recipient, ie_indicator: recipient.taxpayer },
    items, freight, insurance, other_expenses: otherExpenses, discount: null, transport: snapshot.transport };
  const result: TaxPreparationResult = { invoice: json(invoice), item_taxes: itemTaxes, item_details: itemDetails, allocations, total_cents: null, calculation: {}, blockers };
  if (numericInvalid || headerDiscount === null) return result;
  const shares = allocateCents(money(headerDiscount), lineAmounts.map((line, i) => line - lineDiscounts[i])) as bigint[];
  items.forEach((item, index) => { item.discount = moneyOf(lineDiscounts[index] + shares[index]); });
  invoice.discount = moneyOf(lineDiscounts.reduce((sum, value) => sum + value, money(headerDiscount)));
  let calculated: Obj, computed: { totals: Record<string, string>; allocation: Record<string, string[]>; lines: string[] };
  const preferences = obj(taxSources.preferences);
  try {
    calculated = calculateInvoiceTaxes(invoice, { natures: { [string(nature.id)]: nature }, settings, difalByState, productGroups,
      orders: [{ number: document.number }], options: { companyState: company.state,
        simplesCreditMessage: preferences.simples_credit_message === true, trackingInInfo: preferences.tracking_in_info === true,
        purchaseOrderInInfo: preferences.purchase_order_in_info === true } }).invoice as Obj;
    computed = invoiceTotals(calculated) as typeof computed;
  } catch {
    block("fiscal_total_mismatch", "totals", "Pedido, parcelas e cálculo fiscal têm totais diferentes. Revise e salve o pedido.", undefined, "sales_orders");
    return result;
  }
  const mappedItems = calculated.items as Obj[];
  // O motor limita textos para o formulário legado. Aqui um corte nunca pode
  // eliminar informação fiscal silenciosamente: conferimos o texto original.
  const vars = infoVariables(calculated, [{ number: document.number }]);
  const seen = new Set<string>(), textParts: Record<string, string[]> = { additional_info: [], fiscal_info: [] };
  const collect = (key: string, value: unknown) => {
    if (typeof value !== "string") return;
    const expanded = String(fillVariables(value, vars)).trim();
    if (expanded && !seen.has(expanded)) { seen.add(expanded); textParts[key].push(expanded); }
  };
  for (const key of Object.keys(textParts)) collect(key, nature[key]);
  for (const selection of selections) for (const rule of Object.values(selection)) for (const key of Object.keys(textParts)) collect(key, obj(rule)[key]);
  if (preferences.simples_credit_message === true && vars.VALOR_CREDITO_ICMS !== "0,00" && vars.ALIQUOTA_CREDITO_ICMS)
    collect("additional_info", SIMPLES_CREDIT_MESSAGE(vars.VALOR_CREDITO_ICMS, vars.ALIQUOTA_CREDITO_ICMS));
  if (preferences.tracking_in_info === true && present(snapshot.transport.tracking_code)) collect("additional_info", `Código de rastreio: ${snapshot.transport.tracking_code}`);
  if (preferences.purchase_order_in_info === true && vars.PEDIDO_COMPRA) collect("additional_info", `Ordem de compra: ${vars.PEDIDO_COMPRA}`);
  for (const [key, limit] of [["additional_info", 5000], ["fiscal_info", 2000]] as const)
    if ([...textParts[key].join(" ")].length > limit) unsupported(`nature.${key}`, `texto fiscal acima de ${limit} caracteres`);
  mappedItems.forEach((item, index) => {
    const icms = obj(item.icms), rule = obj(obj(selections[index].icms).data), situation = string(icms.situation);
    const out: JsonObject = {}, mapped: JsonObject = {}, details: JsonObject = {};
    /** Os limites de vNF não limitam bases e outros valores calculados. Cada
     * campo tem de caber no contrato e sobreviver ao JSON numérico sem perda. */
    const put = (target: JsonObject, key: string, value: unknown, group = "icms") => {
      if (!present(value)) return;
      const field = `items.${index}.${group}.${key}`;
      const percentages = ["aliquota", "reducaoBc", "mva", "percentual", "aliquotaConsumidorFinal", "aliquotaInterna", "aliquotaInterestadual"];
      const enumeration = key === "origem" ? { min: 0, max: 8 } : key === "modalidadeBc" ? { min: 0, max: group === "icms.st" ? 6 : 3 }
        : key === "motivo" ? { min: 1, max: 99 } : null;
      const descriptor = enumeration ? `e:${Array.from({ length: enumeration.max - enumeration.min + 1 }, (_, i) => enumeration.min + i).join("|")}`
        : percentages.includes(key) ? "d:4:3" : "d:2:13";
      try {
        const canonical = checkValue(String(value), descriptor, field) as string | null;
        if (canonical === null) throw new Error("missing");
        const valueAsNumber = Number(canonical);
        if (!Number.isFinite(valueAsNumber) || enumeration && (!Number.isInteger(valueAsNumber) || valueAsNumber < enumeration.min || valueAsNumber > enumeration.max))
          throw new Error("range");
        if (compareNum(num(canonical), num(JSON.stringify(valueAsNumber))) !== 0) throw new Error("precision");
        target[key] = valueAsNumber;
      } catch {
        block("fiscal_tax_data_missing", field, `O valor calculado de ${field} está fora do formato, limite ou precisão aceitos pelo cofre. Confira a regra da natureza.`, index);
      }
    };
    if (present(icms.origin) && /^[0-8]$/.test(String(icms.origin))) put(mapped, "origem", icms.origin);
    else block("fiscal_product_incomplete", `items.${index}.origin`,
      `O produto ${snapshot.items[index].description ?? index + 1} está sem origem fiscal válida, necessária para esta operação.`, index, "products");
    if (["1", "4"].includes(string(company.crt))) mapped.csosn = situation; else mapped.cst = situation;
    if (OWN.includes(situation)) {
      required(icms, ["base", "rate", "value"], "icms", index);
      put(mapped, "modalidadeBc", rule.bc_mode); put(mapped, "baseCalculo", icms.base); put(mapped, "aliquota", icms.rate); put(mapped, "valor", icms.value);
      if (present(icms.base_rate)) put(mapped, "reducaoBc", reduction(icms.base_rate));
    }
    if (present(icms.fcp_rate) || present(icms.fcp_value)) {
      required(icms, ["base", "fcp_rate", "fcp_value"], "icms", index);
      const fcp: JsonObject = {}; put(fcp, "baseCalculo", icms.base, "icms.fcp"); put(fcp, "aliquota", icms.fcp_rate, "icms.fcp"); put(fcp, "valor", icms.fcp_value, "icms.fcp"); mapped.fcp = fcp;
    }
    if (ST.includes(situation) || present(rule.st_rate)) {
      required(icms, ["st_base", "st_rate", "st_value"], "icms", index);
      const st: JsonObject = {}; put(st, "modalidadeBc", rule.st_bc_mode, "icms.st"); put(st, "mva", icms.st_mva, "icms.st");
      if (present(icms.st_base_rate)) put(st, "reducaoBc", reduction(icms.st_base_rate), "icms.st");
      put(st, "baseCalculo", icms.st_base, "icms.st"); put(st, "aliquota", icms.st_rate, "icms.st"); put(st, "valor", icms.st_value, "icms.st"); mapped.st = st;
    }
    if (present(icms.deson_value)) {
      required(icms, ["deson_reason", "deson_deduct"], "icms", index);
      const exempted: JsonObject = {};
      put(exempted, "valor", icms.deson_value, "icms.desoneracao"); put(exempted, "motivo", icms.deson_reason, "icms.desoneracao");
      if (typeof icms.deson_deduct === "boolean") exempted.deduzDoTotal = icms.deson_deduct;
      else missing("deson_deduct booleano", "icms", index);
      mapped.desoneracao = exempted;
    }
    if (situation === "51" && present(icms.base) && present(icms.rate) && present(icms.deferral_rate)) {
      const operation = percentage(icms.base, icms.rate), deferred = percentage(operation, icms.deferral_rate);
      const deferral: JsonObject = {};
      put(deferral, "valorOperacao", operation, "icms.diferimento"); put(deferral, "percentual", icms.deferral_rate, "icms.diferimento"); put(deferral, "valorDiferido", deferred, "icms.diferimento");
      mapped.diferimento = deferral;
      if (present(icms.value) && money(operation) - money(deferred) !== money(icms.value)) missing("diferimento consistente", "icms", index);
    }
    if (CREDIT.includes(situation) || present(icms.credit_rate)) {
      required(icms, ["credit_rate", "credit_value"], "icms", index);
      const credit: JsonObject = {}; put(credit, "aliquota", icms.credit_rate, "icms.creditoSimples"); put(credit, "valor", icms.credit_value, "icms.creditoSimples"); mapped.creditoSimples = credit;
    }
    if (RETAINED.includes(situation)) {
      required(icms, ["ret_base", "ret_rate", "ret_value"], "icms", index);
      const retained: JsonObject = {}; put(retained, "baseCalculo", icms.ret_base, "icms.retidoAnteriormente"); put(retained, "aliquotaConsumidorFinal", icms.ret_rate, "icms.retidoAnteriormente");
      put(retained, "valor", icms.ret_value, "icms.retidoAnteriormente"); put(retained, "valorSubstituto", icms.ret_substitute_value, "icms.retidoAnteriormente"); mapped.retidoAnteriormente = retained;
    }
    out.icms = mapped;
    for (const tax of ["ipi", "pis", "cofins"]) {
      const group = obj(item[tax]); if (!present(group.situation)) continue;
      const converted: JsonObject = { cst: String(group.situation) };
      if (tax === "ipi" && present(group.framing_code)) converted.codigoEnquadramento = String(group.framing_code);
      if ((tax === "ipi" ? ["00", "49", "50", "99"] : RATED).includes(String(group.situation))) required(group, ["base", "rate", "value"], tax, index);
      put(converted, "baseCalculo", group.base, tax); put(converted, "aliquota", group.rate, tax); put(converted, "valor", group.value, tax); out[tax] = converted;
    }
    if (difalTarget && difalMode !== "none" && rule.difal_type !== "I") {
      required(icms, ["difal_base", "difal_internal_rate", "difal_interstate_rate", "difal_dest_value"], "icms", index);
      const difal: JsonObject = {}; put(difal, "baseCalculo", icms.difal_base, "difal"); put(difal, "aliquotaInterna", icms.difal_internal_rate, "difal");
      put(difal, "aliquotaInterestadual", icms.difal_interstate_rate, "difal"); put(difal, "valorDestino", icms.difal_dest_value, "difal");
      if (present(icms.difal_fcp_rate) || present(icms.difal_fcp_value)) {
        required(icms, ["difal_base", "difal_fcp_rate", "difal_fcp_value"], "icms", index);
        const fcp: JsonObject = {}; put(fcp, "baseCalculo", icms.difal_base, "difal.fcp"); put(fcp, "aliquota", icms.difal_fcp_rate, "difal.fcp"); put(fcp, "valor", icms.difal_fcp_value, "difal.fcp"); difal.fcp = fcp;
      }
      out.difal = difal;
    }
    put(out, "valorAproximadoTributos", obj(item.others).approx_taxes, "impostos");
    if (present(item.cfop)) details.cfop = String(item.cfop);
    if (present(icms.benefit_code)) details.codigoBeneficioFiscal = String(icms.benefit_code);
    itemTaxes.push(out); itemDetails.push(details);
  });
  const reformResult = reformGroups({ snapshot, taxSources, mappedItems, computed, lineAmounts, itemTaxes, vaultKnown, vaultAccepts, vaultSelective, block });
  for (const key of Object.keys(allocations) as (keyof typeof allocations)[]) allocations[key] = computed.allocation[key].map(value => money(value).toString());
  const mismatch = (field: string) => block("fiscal_total_mismatch", field, "Pedido, parcelas e cálculo fiscal têm totais diferentes. Revise e salve o pedido.", undefined, "sales_orders");
  for (const [commercial, fiscal] of [["gross", "products"], ["total", "total"], ["freight", "freight"], ["other_expenses", "other_expenses"]])
    if (!present(totals[commercial]) || money(totals[commercial]) !== money(computed.totals[fiscal])) mismatch(`totals.${commercial}`);
  for (const [commercial, fiscal] of [["ipi", "ipi"], ["icms_st", "st"]])
    if (money(present(totals[commercial]) ? totals[commercial] : "0.00") !== money(computed.totals[fiscal])) mismatch(`totals.${commercial}`);
  if (money(totals.line_discount) !== lineDiscounts.reduce((sum, value) => sum + value, 0n)) mismatch("totals.line_discount");
  if (present(document.stored_total) && money(document.stored_total) !== money(computed.totals.total)) mismatch("document.stored_total");
  result.invoice = json(calculated); result.total_cents = money(computed.totals.total).toString();
  result.calculation = json({ totals: computed.totals, lines: computed.lines, allocation: computed.allocation,
    items: mappedItems, rules: selections.map((selected, index) => ({ item_id: snapshot.items[index].id ?? null,
      taxes: Object.fromEntries(Object.entries(selected).map(([tax, rule]) => [tax, { position: obj(rule).position, data: obj(rule).data }])) })),
    ...(reformResult ? { reform: reformResult } : {}) });
  // Evita NaN/Infinity no JSON do cofre mesmo em uma fonte corrompida.
  const finite = (value: JsonValue): boolean => typeof value === "number" ? Number.isFinite(value) : value !== null && typeof value === "object" ? Object.values(value).every(finite) : true;
  if (!itemTaxes.every(finite)) block("fiscal_tax_data_missing", "items.impostos", "Confira os valores calculados das regras tributárias.");
  return result;
}

/** Número do contrato do cofre a partir do texto decimal exato do cálculo (até 4 casas: sem perda). */
const contractNumber = (value: string): number => Number(value);

function selectiveOf(value: unknown): ReformSelectiveInput | null {
  const v = obj(value);
  return present(v.cst) && present(v.cclasstrib) && present(v.rate) ? { cst: string(v.cst), cclasstrib: string(v.cclasstrib), rate: string(v.rate) } : null;
}

/** Grupo ibsCbs do item no contrato do cofre (PedidoNfe.itens[].impostos.ibsCbs). */
function ibsCbsGroup(item: ReformItemResult): JsonObject | null {
  if (!item.cst || !item.cclasstrib) return null;
  const group: JsonObject = { cst: item.cst, classificacao: item.cclasstrib };
  if (item.status !== "calculated" || !item.base || !item.cbs || !item.ibs_uf || !item.ibs_mun) return group;
  const part = (p: NonNullable<ReformItemResult["cbs"]>): JsonObject => ({
    aliquota: contractNumber(p.rate), valor: contractNumber(p.value),
    ...(compareNum(num(p.reduction), num("0")) > 0 ? { reducao: { percentual: contractNumber(p.reduction), aliquotaEfetiva: contractNumber(p.effective_rate) } } : {}),
  });
  return { ...group, baseCalculo: contractNumber(item.base), ibsUf: part(item.ibs_uf), ibsMunicipio: part(item.ibs_mun), cbs: part(item.cbs) };
}

/**
 * Reforma tributária no preparo da NF-e: calcula IBS, CBS e IS de cada item
 * (reform-calc.ts) sobre a base de 2026 (valor do item menos ICMS, PIS e
 * COFINS) e, só quando o cofre aceita, põe os grupos ibsCbs e
 * impostoSeletivo nos impostos do item. Não muda o total da nota. Devolve o
 * bloco calculation.reform, ou null quando a reforma não se aplica (sem
 * classificação nem configuração: a nota fica exatamente como antes).
 */
function reformGroups(p: {
  snapshot: CommercialSnapshot; taxSources: JsonObject; mappedItems: Obj[];
  computed: { allocation: Record<string, string[]> }; lineAmounts: bigint[]; itemTaxes: JsonObject[];
  vaultKnown: boolean; vaultAccepts: boolean; vaultSelective: boolean;
  block: (code: string, field: string, message: string, index?: number, screen?: string) => void;
}): JsonObject | null {
  const { snapshot, taxSources } = p;
  const reformSources = obj(taxSources.reform_calc);
  const byProduct = obj(taxSources.reform_by_product);
  const products = new Map(snapshot.products.map(product => [string(product.id ?? product.record_id), obj(product)]));
  const classes = snapshot.items.map(saved => {
    const id = string(saved.product_id), resolved = obj(byProduct[id]), own = obj(products.get(id)?.reform_class);
    const source = present(resolved.cst) ? resolved : own;
    return present(source.cst) && present(source.cclasstrib)
      ? { cst: string(source.cst), cclasstrib: string(source.cclasstrib), source: present(source.source) ? string(source.source) : null } : null;
  });
  if (!present(taxSources.reform_calc) && classes.every(value => value === null)) return null;
  const selective = obj(reformSources.selective), settings = obj(reformSources.settings), allocation = p.computed.allocation;
  const year = typeof reformSources.year === "number" ? reformSources.year : reformYearOf(undefined);
  const result = calculateReform(p.mappedItems.map((item, index) => {
    const icms = obj(item.icms), saved = snapshot.items[index];
    return {
      item_id: present(saved.id) ? string(saved.id) : null, description: present(saved.description) ? string(saved.description) : null,
      base: reformBaseFromItem({ gross: moneyOf(p.lineAmounts[index]), freight: allocation.freight?.[index], insurance: allocation.insurance?.[index],
        other_expenses: allocation.other_expenses?.[index], discount: item.discount, icms: icms.value, fcp: icms.fcp_value,
        difal_dest: icms.difal_dest_value, difal_fcp: icms.difal_fcp_value, pis: obj(item.pis).value, cofins: obj(item.cofins).value }),
      classification: classes[index], selective: selectiveOf(selective[string(saved.product_id)]),
    };
  }), { year, crt: string(snapshot.company.crt) || null,
    settings: { simples_regular: settings.simples_regular === true, rates: obj(settings.rates) as ReformCompanySettings["rates"] } });
  const sent = p.vaultAccepts && result.regime !== "simples";
  if (sent) result.items.forEach((item, index) => {
    if (item.status === "class_mismatch")
      return p.block("fiscal_reform_class_invalid", `items.${index}.reform_class`, `${item.message} Corrija a classificação de IBS/CBS do produto ou da natureza.`, index, "products");
    if (item.status === "rates_unpublished")
      return p.block("fiscal_reform_rates_missing", "reform.rates", String(item.message), undefined, "reform");
    const group = ibsCbsGroup(item);
    if (group) p.itemTaxes[index].ibsCbs = group;
    if (item.selective && p.vaultSelective)
      p.itemTaxes[index].impostoSeletivo = { cst: item.selective.cst, classificacao: item.selective.cclasstrib, baseCalculo: contractNumber(item.selective.base),
        aliquota: contractNumber(item.selective.rate), valor: contractNumber(item.selective.value) };
    else if (item.selective && compareNum(num(item.selective.value), num("0")) > 0)
      p.block("fiscal_reform_selective_unsupported", `items.${index}.impostoSeletivo`, "O item tem Imposto Seletivo, mas o seu cofre ainda não recebe esse grupo. Atualize o cofre e teste a conexão de novo.", index, "fiscal_settings");
  });
  const vault = !p.vaultKnown ? "unknown" : p.vaultAccepts ? "accepts" : "refuses";
  const message = vault === "refuses"
    ? "O seu cofre ainda não recebe IBS, CBS e IS (reforma tributária): a nota sai como hoje, sem esse grupo. Os valores abaixo são só para conferência."
    : vault === "unknown" ? "O Wabotia ainda não sabe se o seu cofre recebe a reforma tributária: teste a conexão do cofre e salve a configuração da NF-e."
    : result.regime === "simples" ? "Empresa do Simples Nacional: a nota sai sem o grupo IBS/CBS."
    : result.informative ? "Valores de IBS e CBS enviados na nota em caráter informativo (2026): não mudam o total a pagar." : null;
  return json({ ...result, vault, sent, message });
}
