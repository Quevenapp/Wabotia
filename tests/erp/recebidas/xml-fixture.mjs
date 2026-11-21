// XML de NF-e de fornecedor feito à mão para os testes (nenhum dado real). Sem
// dependência do Node: serve ao motor (node --test) e ao Worker (Vitest).
export const SUPPLIER_CNPJ = "44555666000181";
export const COMPANY_CNPJ = "11222333000181";

/** Chave de acesso sintética de 44 dígitos (UF 35, modelo 55). */
export const accessKey = (number = 101, model = "55") => `35261144555666000181${model}001${String(number).padStart(9, "0")}1876543213`.slice(0, 44);

const money = (cents) => (cents / 100).toFixed(2);

/**
 * NF-e do fornecedor. items: [{ code, gtin, description, unit, quantity, price, ipi?, freight?, lot? }].
 * Totais calculados dos itens; frete total opcional (para o rateio).
 */
export function nfeXml(options = {}) {
  const items = options.items ?? [
    { code: "F-001", gtin: "7891234567895", description: "Biscoito de polvilho pacote", unit: "CX", quantity: "2.0000", price: "120.0000000000", ipi: 1200 },
    { code: "F-002", gtin: null, description: "Leite integral caixinha", unit: "UN", quantity: "10.0000", price: "5.0000000000", lot: { code: "L2026A", made: "2026-10-01", expires: "2027-04-01" } },
  ];
  const freight = options.freight ?? 1000;
  const lines = items.map((item, n) => {
    const total = Math.round(Number(item.quantity) * Number(item.price) * 100);
    return { ...item, n: n + 1, total };
  });
  const products = lines.reduce((s, l) => s + l.total, 0), ipi = lines.reduce((s, l) => s + (l.ipi ?? 0), 0);
  const total = options.total ?? products + ipi + freight;
  const duplicates = options.duplicates ?? [{ n: "001", due: "2026-12-20", cents: Math.floor(total / 2) }, { n: "002", due: "2027-01-19", cents: total - Math.floor(total / 2) }];
  const det = lines.map((l) => `<det nItem="${l.n}"><prod><cProd>${l.code}</cProd><cEAN>${l.gtin ?? "SEM GTIN"}</cEAN><xProd>${l.description}</xProd><NCM>19053100</NCM>` +
    `<CFOP>${options.cfop ?? "5102"}</CFOP><uCom>${l.unit}</uCom><qCom>${l.quantity}</qCom><vUnCom>${l.price}</vUnCom><vProd>${money(l.total)}</vProd>` +
    `<cEANTrib>SEM GTIN</cEANTrib><uTrib>${l.unit}</uTrib><qTrib>${l.quantity}</qTrib><vUnTrib>${l.price}</vUnTrib><indTot>1</indTot>` +
    (options.order ? `<xPed>${options.order}</xPed>` : "") +
    (l.lot ? `<rastro><nLote>${l.lot.code}</nLote><qLote>${l.quantity}</qLote><dFab>${l.lot.made}</dFab><dVal>${l.lot.expires}</dVal></rastro>` : "") +
    `</prod><imposto><ICMS><ICMS00><orig>0</orig><CST>00</CST><vBC>${money(l.total)}</vBC><pICMS>18.00</pICMS><vICMS>${money(Math.round(l.total * 0.18))}</vICMS></ICMS00></ICMS>` +
    (l.ipi ? `<IPI><cEnq>999</cEnq><IPITrib><CST>50</CST><vBC>${money(l.total)}</vBC><pIPI>5.00</pIPI><vIPI>${money(l.ipi)}</vIPI></IPITrib></IPI>` : "") +
    `</imposto></det>`).join("");
  const key = options.key ?? accessKey(options.number ?? 101);
  return `<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe><infNFe Id="NFe${key}" versao="4.00">` +
    `<ide><cUF>35</cUF><natOp>${options.nature ?? "Venda de mercadoria"}</natOp><mod>55</mod><serie>1</serie><nNF>${options.number ?? 101}</nNF>` +
    `<dhEmi>${options.issued ?? "2026-11-18"}T10:00:00-03:00</dhEmi><tpNF>1</tpNF><tpAmb>${options.production ? "1" : "2"}</tpAmb><finNFe>${options.finality ?? "1"}</finNFe></ide>` +
    `<emit><CNPJ>${options.supplier ?? SUPPLIER_CNPJ}</CNPJ><xNome>Fornecedor Sintetico Ltda</xNome><xFant>Sintetico</xFant><enderEmit><xLgr>Rua A</xLgr><nro>10</nro>` +
    `<xBairro>Centro</xBairro><cMun>3550308</cMun><xMun>Sao Paulo</xMun><UF>SP</UF><CEP>01001000</CEP><fone>1133334444</fone></enderEmit><IE>110042490114</IE><CRT>3</CRT></emit>` +
    `<dest><CNPJ>${options.recipient ?? COMPANY_CNPJ}</CNPJ><xNome>Empresa de Ensaio</xNome></dest>${det}` +
    `<total><ICMSTot><vBC>0.00</vBC><vICMS>${money(lines.reduce((s, l) => s + Math.round(l.total * 0.18), 0))}</vICMS><vST>0.00</vST><vProd>${money(products)}</vProd>` +
    `<vFrete>${money(freight)}</vFrete><vSeg>0.00</vSeg><vDesc>0.00</vDesc><vIPI>${money(ipi)}</vIPI><vOutro>0.00</vOutro><vNF>${money(total)}</vNF></ICMSTot></total>` +
    (duplicates.length ? `<cobr>${duplicates.map((d) => `<dup><nDup>${d.n}</nDup><dVenc>${d.due}</dVenc><vDup>${money(d.cents)}</vDup></dup>`).join("")}</cobr>` : "") +
    `<pag><detPag><tPag>15</tPag><vPag>${money(total)}</vPag></detPag></pag></infNFe></NFe>` +
    `<protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><chNFe>${key}</chNFe><nProt>135260000000001</nProt><cStat>100</cStat></infProt></protNFe></nfeProc>`;
}
