// Obrigações em arquivo (src/erp/sped): SPED Fiscal, EFD-Contribuições e
// SINTEGRA montados de notas fictícias (XML de NF-e, NFC-e, NFS-e e uma nota
// recebida) e conferidos linha a linha: campos de cada registro pelo layout,
// contagens do bloco 9 recontadas aqui, linhas de cada bloco, totais do E110
// recalculados dos itens, apuração do PIS/COFINS, 126 posições e totais do
// registro 90 do SINTEGRA. Nenhuma rede.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSpedFile, spedFilename } from "../../../src/erp/sped/build.ts";
import { asReceived, cancelled, parseNfeXml, parseNfseXml } from "../../../src/erp/sped/xml.ts";
import { EFD_CONTRIBUICOES_LAYOUT, EFD_ICMS_IPI_LAYOUT, SINTEGRA_LAYOUT, SINTEGRA_RECORD_SIZE, layoutVersion, EFD_ICMS_IPI_VERSIONS } from "../../../src/erp/sped/layout.ts";
import { validateSped, validateSintegra } from "../../../src/erp/sped/validate.ts";
import { decimal, latin1, money, fromLatin1 } from "../../../src/erp/sped/format.ts";
import { entryCfop, cstIcms } from "../../../src/erp/sped/common.ts";
import { inventoryDay, regimeNotice, spedPeriod, spedPeriodLabel, spedFileId } from "../../../src/erp/sped/contract.ts";

const KEY = (n, model = "55") => `35261111222333000181${model}001${String(n).padStart(9, "0")}1${String(n).padStart(8, "0")}`.slice(0, 43) + "0";

function item(n, { cfop = "5102", qty = "2.0000", unit = "10.00", amount = "20.00", cst = "00", rate = "18.00", base = amount, icms, ipi = null, st = null, pis = "01", disc = null, freight = null } = {}) {
  const icmsValue = icms ?? (Number(base) * Number(rate) / 100).toFixed(2);
  return `<det nItem="${n}"><prod><cProd>P${n}</cProd><cEAN>SEM GTIN</cEAN><xProd>Produto ${n} | teste</xProd><NCM>61091000</NCM><CFOP>${cfop}</CFOP><uCom>UN</uCom><qCom>${qty}</qCom><vUnCom>${unit}</vUnCom><vProd>${amount}</vProd>${disc ? `<vDesc>${disc}</vDesc>` : ""}${freight ? `<vFrete>${freight}</vFrete>` : ""}</prod>
  <imposto><ICMS><ICMS${cst}><orig>0</orig><CST>${cst}</CST><modBC>3</modBC><vBC>${base}</vBC><pICMS>${rate}</pICMS><vICMS>${icmsValue}</vICMS>${st ? `<vBCST>${st.base}</vBCST><pICMSST>18.00</pICMSST><vICMSST>${st.value}</vICMSST>` : ""}</ICMS${cst}></ICMS>
  ${ipi ? `<IPI><cEnq>999</cEnq><IPITrib><CST>50</CST><vBC>${amount}</vBC><pIPI>${ipi.rate}</pIPI><vIPI>${ipi.value}</vIPI></IPITrib></IPI>` : ""}
  <PIS><PISAliq><CST>${pis}</CST><vBC>${amount}</vBC><pPIS>1.65</pPIS><vPIS>${(Number(amount) * 0.0165).toFixed(2)}</vPIS></PISAliq></PIS>
  <COFINS><COFINSAliq><CST>${pis}</CST><vBC>${amount}</vBC><pCOFINS>7.60</pCOFINS><vCOFINS>${(Number(amount) * 0.076).toFixed(2)}</vCOFINS></COFINSAliq></COFINS></imposto></det>`;
}
function nfe({ n, model = "55", tpNF = "1", date = "2026-10-05", items, dest = true, emit = "11222333000181", emitName = "Loja Exemplo", totals, cStat = "100", natOp = "Venda de mercadoria" }) {
  const sum = (tag) => items.reduce((s, x) => s + Number((new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(x) ?? [0, 0])[1]), 0);
  const vProd = sum("vProd"), vICMS = sum("vICMS"), vBC = sum("vBC") - sum("vBCST") - (items.join("").match(/<IPITrib>.*?<vBC>([^<]+)<\/vBC>/g) ?? []).length * 0, vIPI = sum("vIPI"), vST = sum("vICMSST");
  const t = totals ?? { vNF: (vProd + vIPI + vST - sum("vDesc") + sum("vFrete")).toFixed(2), vBC: items.reduce((s, x) => s + Number(/<ICMS\d+>.*?<vBC>([^<]+)<\/vBC>/s.exec(x)[1]), 0).toFixed(2) };
  return `<?xml version="1.0" encoding="UTF-8"?><nfeProc versao="4.00"><NFe><infNFe Id="NFe${KEY(n, model)}" versao="4.00">
  <ide><cUF>35</cUF><natOp>${natOp}</natOp><mod>${model}</mod><serie>1</serie><nNF>${n}</nNF><dhEmi>${date}T10:00:00-03:00</dhEmi><tpNF>${tpNF}</tpNF><finNFe>1</finNFe></ide>
  <emit><CNPJ>${emit}</CNPJ><xNome>${emitName}</xNome><enderEmit><xLgr>Rua A</xLgr><nro>10</nro><xBairro>Centro</xBairro><cMun>3550308</cMun><xMun>Sao Paulo</xMun><UF>SP</UF><CEP>01001000</CEP></enderEmit><IE>123456789012</IE><CRT>3</CRT></emit>
  ${dest ? `<dest><CNPJ>44555666000199</CNPJ><xNome>Cliente Ltda</xNome><enderDest><xLgr>Av. B</xLgr><nro>200</nro><xBairro>Jardim</xBairro><cMun>3304557</cMun><xMun>Rio de Janeiro</xMun><UF>RJ</UF><CEP>20000000</CEP><cPais>1058</cPais></enderDest><indIEDest>1</indIEDest><IE>87654321</IE></dest>` : ""}
  ${items.join("\n")}
  <total><ICMSTot><vBC>${t.vBC}</vBC><vICMS>${vICMS.toFixed(2)}</vICMS><vBCST>${sum("vBCST").toFixed(2)}</vBCST><vST>${vST.toFixed(2)}</vST><vProd>${vProd.toFixed(2)}</vProd><vFrete>${sum("vFrete").toFixed(2)}</vFrete><vDesc>${sum("vDesc").toFixed(2)}</vDesc><vIPI>${vIPI.toFixed(2)}</vIPI><vPIS>${sum("vPIS").toFixed(2)}</vPIS><vCOFINS>${sum("vCOFINS").toFixed(2)}</vCOFINS><vNF>${t.vNF}</vNF></ICMSTot></total>
  <transp><modFrete>${dest ? "0" : "9"}</modFrete></transp><pag><detPag><tPag>01</tPag><vPag>${t.vNF}</vPag></detPag></pag>
  </infNFe></NFe><protNFe><infProt><cStat>${cStat}</cStat><nProt>135260000000001</nProt></infProt></protNFe></nfeProc>`;
}
const nfse = `<?xml version="1.0"?><NFSe xmlns="http://www.sped.fazenda.gov.br/nfse"><infNFSe Id="NFS35503082211222333000181000000000000126100000000001"><nNFSe>17</nNFSe><dhProc>2026-10-12T09:00:00-03:00</dhProc>
<valores><vBC>500.00</vBC><pAliqAplic>2.00</pAliqAplic><vISSQN>10.00</vISSQN><vLiq>500.00</vLiq></valores>
<DPS><infDPS><dhEmi>2026-10-12T09:00:00-03:00</dhEmi><dCompet>2026-10-12</dCompet><serie>900</serie><nDPS>17</nDPS>
<toma><CNPJ>44555666000199</CNPJ><xNome>Cliente Ltda</xNome><end><endNac><cMun>3304557</cMun><CEP>20000000</CEP></endNac><xLgr>Av. B</xLgr><nro>200</nro><xBairro>Jardim</xBairro></end></toma>
<serv><cServ><cTribNac>140101</cTribNac><xDescServ>Manutenção de equipamento</xDescServ></cServ></serv>
<valores><vServPrest><vServ>500.00</vServ></vServPrest><trib><tribMun><tribISSQN>1</tribISSQN><tpRetISSQN>1</tpRetISSQN></tribMun></trib></valores></infDPS></DPS></infNFSe></NFSe>`;

export const COMPANY = {
  name: "Loja Exemplo Ltda", trade_name: "Loja Exemplo", cnpj: "11222333000181", ie: "123456789012", im: null, uf: "SP", city: "São Paulo", city_code: "3550308",
  postal_code: "01001000", street: "Rua A", number: "10", complement: null, district: "Centro", phone: "1133334444", email: "loja@exemplo.com.br", suframa: null, crt: "3", cnae: null,
};
export const SETTINGS = {
  profile: "A", activity: "1",
  accountant: { name: "Contadora Fictícia", cpf: "12345678909", crc: "SP123456O1", cnpj: null, postal_code: "01002000", street: "Rua C", number: "5", complement: null, district: "Sé", phone: "11999998888", email: "contadora@exemplo.com.br", city_code: "3550308" },
  pis_cofins: { incidence: "1", credit_method: "1", contribution_type: "1", cumulative_regime: "9", nature: "00", activity: "2" },
  icms_revenue_code: "046-2", icms_due_day: 20, sintegra: { nature: "3", purpose: "1", contact: "Fulana" }, in_package: true,
};

export function documents() {
  const sale1 = parseNfeXml(nfe({ n: 101, items: [item(1), item(2, { qty: "1.0000", unit: "50.00", amount: "50.00" })] }));
  const sale2 = parseNfeXml(nfe({ n: 102, date: "2026-10-08", items: [item(1, { cfop: "6102", rate: "12.00", amount: "100.00", qty: "4.0000", unit: "25.00" })] }));
  const voided = cancelled(parseNfeXml(nfe({ n: 103, date: "2026-10-09", items: [item(1)] })));
  const cupom1 = parseNfeXml(nfe({ n: 501, model: "65", dest: false, date: "2026-10-10", items: [item(1, { amount: "30.00", qty: "3.0000", unit: "10.00" })] }));
  const cupom2 = parseNfeXml(nfe({ n: 502, model: "65", dest: false, date: "2026-10-10", items: [item(1, { amount: "10.00", qty: "1.0000", unit: "10.00" }), item(2, { cst: "40", rate: "0", base: "0", icms: "0.00", amount: "5.00", qty: "1.0000", unit: "5.00" })] }));
  const xmlIn = nfe({ n: 9001, emit: "99888777000166", emitName: "Fornecedor Ltda", date: "2026-10-02", items: [item(1, { amount: "200.00", qty: "10.0000", unit: "20.00", ipi: { rate: "5.00", value: "10.00" } })] });
  const received = asReceived(parseNfeXml(xmlIn), xmlIn, "2026-10-03");
  const service = parseNfseXml(nfse);
  const inutil = { ...sale1, kind: "inutilizada", situation: "05", number: "110", number_to: "112", key: null, items: [], party: null };
  return [sale1, sale2, voided, cupom1, cupom2, received, service, inutil];
}
const input = (kind, extra = {}) => ({ kind, from: "2026-10-01", to: "2026-10-31", company: COMPANY, settings: SETTINGS, documents: documents(), inventory: null, previous_credit: 0, products: {}, ...extra });

/** Recontagem independente do bloco 9 e das linhas por bloco. */
function recount(lines) {
  const counts = new Map(), blocks = new Map();
  for (const l of lines) { const reg = l.split("|")[1]; counts.set(reg, (counts.get(reg) ?? 0) + 1); blocks.set(reg[0], (blocks.get(reg[0]) ?? 0) + 1); }
  return { counts, blocks };
}
const reg = (lines, name) => lines.filter((l) => l.startsWith(`|${name}|`)).map((l) => l.slice(1, -1).split("|"));

test("XML: NF-e, NFC-e, NFS-e e recebida normalizadas", () => {
  const [sale1, , voided, cupom1, , received, service] = documents();
  assert.equal(sale1.kind, "nfe"); assert.equal(sale1.items.length, 2); assert.equal(sale1.totals.icms, 1260); assert.equal(sale1.party.document, "44555666000199");
  assert.equal(sale1.items[0].description, "Produto 1 | teste");
  assert.equal(voided.situation, "02");
  assert.equal(cupom1.model, "65"); assert.equal(cupom1.party, null);
  assert.equal(received.own, false); assert.equal(received.direction, "0"); assert.equal(received.party.document, "99888777000166"); assert.equal(received.io_on, "2026-10-03");
  assert.equal(received.items[0].ipi.value, 1000);
  assert.equal(service.kind, "nfse"); assert.equal(service.service.amount, 50000); assert.equal(service.party.name, "Cliente Ltda"); assert.equal(service.number, "17");
});

test("SPED Fiscal: layout confere linha a linha, bloco 9 recontado e E110 pelos itens", () => {
  const built = buildSpedFile(input("efd_icms_ipi"));
  assert.deepEqual(built.validation, []);
  assert.ok(built.text);
  const lines = built.text.trimEnd().split("\r\n");
  assert.ok(lines.every((l) => !/\r|\n/.test(l)));
  for (const l of lines) { const values = l.slice(1, -1).split("|"); assert.equal(values.length, EFD_ICMS_IPI_LAYOUT[values[0]].length, l); }
  assert.equal(lines[0].split("|")[2], "020");
  // Bloco 9: cada 9900 bate com a recontagem; 9990 e 9999.
  const { counts, blocks } = recount(lines);
  for (const [, , r, qty] of lines.filter((l) => l.startsWith("|9900|")).map((l) => l.split("|"))) assert.equal(Number(qty), counts.get(r), `9900 de ${r}`);
  assert.equal(reg(lines, "9900").length, counts.size);
  assert.equal(Number(reg(lines, "9990")[0][1]), blocks.get("9"));
  assert.equal(Number(reg(lines, "9999")[0][1]), lines.length);
  for (const b of ["0", "B", "C", "D", "E", "G", "H", "K", "1"]) assert.equal(Number(reg(lines, `${b}990`)[0][1]), blocks.get(b), `bloco ${b}`);
  // C100: 2 NF-e, 1 cancelada, 2 NFC-e, 1 recebida e 3 inutilizadas; C170 só na recebida.
  const c100 = reg(lines, "C100");
  assert.equal(c100.length, 9);
  assert.equal(reg(lines, "C170").length, 1);
  const cancelledLine = c100.find((f) => f[5] === "02");
  assert.deepEqual(cancelledLine.slice(9).filter(Boolean), []);
  assert.equal(c100.filter((f) => f[5] === "05").length, 3);
  const nfce = c100.filter((f) => f[4] === "65");
  assert.ok(nfce.every((f) => f[3] === "" && f[23] === "" && f[24] === ""));
  // C170 da entrada: CFOP de entrada e CST do IPI de entrada.
  const [c170] = reg(lines, "C170");
  assert.equal(c170[10], "1102"); assert.equal(c170[19], "00"); assert.equal(c170[2], "99888777-P1");
  // E110: débitos = ICMS dos C190 de saída (5/6/7); créditos = de entrada; refeitos dos itens.
  const debits = 0.18 * 20 + 0.18 * 50 + 0.12 * 100 + 0.18 * 30 + 0.18 * 10;
  const credits = 0.18 * 200;
  const e110 = reg(lines, "E110")[0];
  assert.equal(e110[1], money(Math.round(debits * 100)));
  assert.equal(e110[5], money(Math.round(credits * 100)));
  const c190 = reg(lines, "C190");
  const sumBy = (pred) => c190.filter(pred).reduce((s, f) => s + Math.round(Number(f[6].replace(",", ".")) * 100), 0);
  assert.equal(sumBy((f) => /^[567]/.test(f[2])), Math.round(debits * 100));
  assert.equal(sumBy((f) => /^[123]/.test(f[2])), Math.round(credits * 100));
  const balance = Math.round(debits * 100) - Math.round(credits * 100);
  assert.equal(e110[11], money(Math.max(0, balance)));
  assert.equal(e110[12], money(Math.max(0, balance)));
  assert.equal(reg(lines, "E116").length, balance > 0 ? 1 : 0);
  assert.equal(built.summary.debitos, Math.round(debits * 100));
  // 0150: só os participantes citados (cliente e fornecedor), 0200 só o item da entrada.
  assert.deepEqual(reg(lines, "0150").map((f) => f[1]).sort(), ["44555666000199", "99888777000166"]);
  assert.equal(reg(lines, "0200").length, 1);
  assert.equal(reg(lines, "0190").length, 1);
  assert.equal(reg(lines, "H001")[0][1], "1");
  // Barra vertical da descrição não quebra o registro.
  assert.ok(!lines.some((l) => l.includes("Produto 1 | teste")));
});

test("SPED Fiscal: saldo credor anterior, inventário no bloco H e IPI na atividade industrial", () => {
  const inventory = { day: "2026-09-30", items: [
    { product_id: "p1", code: "PROD-1", description: "Camiseta", unit: "UN", ncm: "61091000", gtin: null, qty: "10.000000", unit_cost: "12.5", amount: 12500 },
    { product_id: "p2", code: "PROD-2", description: "Zerado", unit: "UN", ncm: "61091000", gtin: null, qty: "0.000000", unit_cost: "1", amount: 0 },
  ] };
  const built = buildSpedFile(input("efd_icms_ipi", { previous_credit: 100000, inventory, settings: { ...SETTINGS, activity: "0" } }));
  assert.deepEqual(built.validation, []);
  const lines = built.text.trimEnd().split("\r\n");
  const e110 = reg(lines, "E110")[0];
  assert.equal(e110[9], "1000,00");
  assert.equal(e110[11], "0,00");
  assert.equal(reg(lines, "E116").length, 0);
  assert.equal(e110[13], money(100000 + 3600 - (360 + 900 + 1200 + 540 + 180)));
  assert.deepEqual(reg(lines, "H005")[0], ["H005", "30092026", "125,00", "01"]);
  assert.deepEqual(reg(lines, "H010")[0], ["H010", "PROD-1", "UN", "10,000", "12,500000", "125,00", "0", "", "", "", ""]);
  assert.equal(reg(lines, "H010").length, 1);
  assert.ok(reg(lines, "0200").some((f) => f[1] === "PROD-1"));
  const e520 = reg(lines, "E520")[0];
  assert.equal(e520[3], "10,00"); // crédito do IPI da entrada
  assert.ok(reg(lines, "E510").length >= 1);
});

test("SPED Fiscal: ICMS a recolher sem código de receita impede o arquivo", () => {
  const built = buildSpedFile(input("efd_icms_ipi", { documents: documents().filter((d) => d.own), settings: { ...SETTINGS, icms_revenue_code: null } }));
  assert.equal(built.text, null);
  assert.ok(built.problems.some((p) => p.blocking && /código de receita/.test(p.message)));
});

test("EFD-Contribuições: layout, bloco 9, A100 da NFS-e, C175 da NFC-e e apuração M200/M600", () => {
  const built = buildSpedFile(input("efd_contribuicoes"));
  assert.deepEqual(built.validation, []);
  const lines = built.text.trimEnd().split("\r\n");
  for (const l of lines) { const values = l.slice(1, -1).split("|"); assert.equal(values.length, EFD_CONTRIBUICOES_LAYOUT[values[0]].length, l); }
  const { counts, blocks } = recount(lines);
  for (const [, , r, qty] of lines.filter((l) => l.startsWith("|9900|")).map((l) => l.split("|"))) assert.equal(Number(qty), counts.get(r));
  assert.equal(Number(reg(lines, "9999")[0][1]), lines.length);
  for (const b of ["0", "A", "C", "D", "F", "I", "M", "P", "1"]) assert.equal(Number(reg(lines, `${b}990`)[0][1]), blocks.get(b), `bloco ${b}`);
  assert.equal(reg(lines, "A100").length, 1);
  assert.equal(reg(lines, "A170")[0][9], "500,00");
  assert.equal(reg(lines, "C175").length, 2);
  // PIS: saídas de NF-e e NFC-e pelo XML (1,65%) e a NFS-e pelo básico (1,65% sobre 500).
  const pisGoods = documents().filter((d) => d.own && d.situation === "00" && (d.model === "55" || d.model === "65"))
    .reduce((s, d) => s + d.items.reduce((t, i) => t + i.pis.value, 0), 0);
  assert.ok(pisGoods > 0); // vPIS de cada item, como veio no XML
  const pisService = Math.round(50000 * 0.0165);
  const m200 = reg(lines, "M200")[0];
  assert.equal(m200[1], money(pisGoods + pisService));
  // Crédito da entrada: 200 + 10 de IPI − 36 de ICMS = 174, a 1,65%.
  const credit = Math.round(17400 * 0.0165);
  assert.equal(reg(lines, "M100")[0][7], money(credit));
  assert.equal(m200[2], money(credit));
  assert.equal(m200[12], money(pisGoods + pisService - credit));
  assert.equal(built.summary.pis_a_recolher, pisGoods + pisService - credit);
  assert.ok(built.warnings.some((w) => /NFS-e 17/.test(w)));
});

test("EFD-Contribuições cumulativa: sem crédito de entrada e código de contribuição 51", () => {
  const built = buildSpedFile(input("efd_contribuicoes", { settings: { ...SETTINGS, pis_cofins: { ...SETTINGS.pis_cofins, incidence: "2" } } }));
  assert.deepEqual(built.validation, []);
  const lines = built.text.trimEnd().split("\r\n");
  assert.equal(reg(lines, "M100").length, 0);
  assert.ok(reg(lines, "M210").every((f) => f[1] === "51"));
  assert.equal(reg(lines, "C100").filter((f) => f[2] === "1").length, 0);
  assert.deepEqual(reg(lines, "0110")[0], ["0110", "2", "", "", "9"]);
});

test("SINTEGRA: 126 posições, tipos 10, 11, 50, 54, 61, 61R, 74, 75 e totais do 90", () => {
  const inventory = { day: "2026-09-30", items: [{ product_id: "p1", code: "PRODUTO-COM-CODIGO-LONGO", description: "Camiseta Algodão", unit: "UN", ncm: "61091000", gtin: null, qty: "3.5", unit_cost: "10", amount: 3500 }] };
  const built = buildSpedFile(input("sintegra", { inventory }));
  assert.deepEqual(built.validation, []);
  const lines = built.text.trimEnd().split("\r\n");
  assert.ok(lines.every((l) => l.length === SINTEGRA_RECORD_SIZE));
  const types = (t) => lines.filter((l) => l.startsWith(t));
  assert.equal(types("10").length, 1); assert.equal(types("11").length, 1);
  assert.equal(types("50").length, 1 + 1 + 1 + 1 + 3); // NF-e 101 (1 grupo), 102, cancelada, recebida, 3 inutilizadas
  assert.equal(types("54").length, 2 + 1 + 1);
  assert.equal(types("61R").length, 2);
  assert.equal(lines.filter((l) => l.startsWith("61") && l[2] !== "R").length, 2); // dia 10: 18% e isento
  assert.equal(types("74").length, 1);
  const code74 = types("74")[0].slice(10, 24).trim();
  assert.ok(code74.length <= 14 && code74.startsWith("PRODU") && code74 !== "PRODUTO-COM-CO", code74); // código longo vira começo + resumo
  assert.ok(types("75").some((l) => l.slice(18, 32).trim() === code74));
  // Registro 50 da venda 101: valor 70,00, base 70,00, ICMS 12,60, 18%.
  const r50 = types("50").find((l) => l.slice(45, 51) === "000101");
  assert.equal(r50.slice(56, 69), "0000000007000"); assert.equal(r50.slice(82, 95), "0000000001260"); assert.equal(r50.slice(121, 125), "1800"); assert.equal(r50[125], "N");
  const cancelled50 = types("50").find((l) => l.slice(45, 51) === "000103");
  assert.equal(cancelled50[125], "S");
  // 90: totais por tipo e total geral.
  const [r90] = types("90");
  const pairs = {};
  for (let at = 30; at + 10 <= 125; at += 10) { const t = r90.slice(at, at + 2); if (t.trim()) pairs[t] = Number(r90.slice(at + 2, at + 10)); }
  assert.equal(pairs["50"], types("50").length); assert.equal(pairs["54"], types("54").length); assert.equal(pairs["61"], types("61").length);
  assert.equal(pairs["74"], 1); assert.equal(pairs["75"], types("75").length); assert.equal(pairs["99"], lines.length); assert.equal(r90[125], "1");
  for (const [type, layout] of Object.entries(SINTEGRA_LAYOUT)) assert.equal(layout.reduce((s, f) => s + f.size, 0), 126, type);
  assert.ok(!/[^\x20-\x7e]/.test(built.text.replace(/\r\n/g, "")));
});

test("Conferência do layout pega contagem errada e campo inválido", () => {
  const built = buildSpedFile(input("efd_icms_ipi"));
  const lines = built.text.trimEnd().split("\r\n");
  const broken = lines.map((l) => l.startsWith("|9999|") ? "|9999|1|" : l);
  assert.ok(validateSped(broken, EFD_ICMS_IPI_LAYOUT, ["0", "B", "C", "D", "E", "G", "H", "K", "1", "9"]).some((p) => /9999/.test(p)));
  const badDate = lines.map((l) => l.startsWith("|E100|") ? "|E100|31022026|31102026|" : l);
  assert.ok(validateSped(badDate, EFD_ICMS_IPI_LAYOUT, ["0", "B", "C", "D", "E", "G", "H", "K", "1", "9"]).some((p) => /data inválida/.test(p)));
  const extra = [...lines.slice(0, 3), "|0190|UN|Unidade|extra|", ...lines.slice(3)];
  assert.ok(validateSped(extra, EFD_ICMS_IPI_LAYOUT, ["0", "B", "C", "D", "E", "G", "H", "K", "1", "9"]).some((p) => /campos/.test(p)));
  const sint = buildSpedFile(input("sintegra")).text.trimEnd().split("\r\n");
  assert.ok(validateSintegra(sint.slice(0, -1).concat([sint.at(-1).replace(/99\d{8}/, "9900000001")])).some((p) => /total/.test(p)));
});

test("Formatos, período, regime e utilidades", () => {
  assert.equal(money(123456), "1234,56"); assert.equal(money(5), "0,05"); assert.equal(decimal("1.655", 2), "1,66"); assert.equal(decimal("7.6", 4), "7,6000");
  assert.equal(fromLatin1(latin1("Ação “x”")), 'Ação "x"');
  assert.equal(entryCfop("5405"), "1403"); assert.equal(entryCfop("6102"), "2102"); assert.equal(entryCfop("1102"), "1102");
  assert.equal(cstIcms({ origin: "0", icms_cst: "102", csosn: true }), "090"); assert.equal(cstIcms({ origin: "2", icms_cst: "0", csosn: false }), "200");
  assert.deepEqual(spedPeriod("efd_icms_ipi", "2026-10-01", "2026-10-31"), { from: "2026-10-01", to: "2026-10-31" });
  assert.match(spedPeriod("efd_icms_ipi", "2026-10-01", "2026-10-15"), /mês inteiro/);
  assert.match(spedPeriod("sintegra", "2026-10-01", "2026-11-15"), /um mês só/);
  assert.deepEqual(spedPeriod("sintegra", "2026-10-01", "2026-10-15"), { from: "2026-10-01", to: "2026-10-15" });
  assert.equal(inventoryDay("2025-12-31", "2026-02-28"), "2025-12-31"); assert.equal(inventoryDay(undefined, "2026-02-28"), null); assert.ok(inventoryDay("2026-03-01", "2026-02-28").error);
  assert.match(regimeNotice("efd_icms_ipi", "1"), /Simples Nacional normalmente não entregam/); assert.equal(regimeNotice("efd_icms_ipi", "3"), null);
  assert.equal(spedPeriodLabel("2026-10-01", "2026-10-31"), "10/2026");
  assert.equal(layoutVersion(EFD_ICMS_IPI_VERSIONS, "2025-06-01"), "019"); assert.equal(layoutVersion(EFD_ICMS_IPI_VERSIONS, "2019-06-01"), null);
  assert.equal(spedFilename("efd_icms_ipi", "11.222.333/0001-81", "2026-10-01", "2026-10-31"), "SPED-EFD-ICMS-IPI_11222333000181_202610.txt");
});

test("Id do arquivo é estável por tipo, ambiente e período", async () => {
  const a = await spedFileId("efd_icms_ipi", "producao", "2026-10-01", "2026-10-31");
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(a, await spedFileId("efd_icms_ipi", "producao", "2026-10-01", "2026-10-31"));
  assert.notEqual(a, await spedFileId("sintegra", "producao", "2026-10-01", "2026-10-31"));
});
