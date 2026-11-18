import { expect, it } from "vitest";
import * as mask from "../src/pii-mask";
import * as pdf from "../src/pii-pdf";
import * as loop from "../src/bot-tools";
import { piiCases } from "./pii-cases.mjs";

for (const [name, check] of piiCases({ ...mask, ...pdf, ...loop }))
  it(name, check);

it("rede de segurança: pega documento colado ou partido, sem recusar colunas de extrato", () => {
  const { hasUnmaskedDocument } = mask;
  // Documento que a máscara não pegaria: colado a letras, partido em linhas.
  expect(hasUnmaskedDocument("CPF529.982.247-25Nome")).toBe(true);
  expect(hasUnmaskedDocument("529.982.\n247-25")).toBe(true);
  expect(hasUnmaskedDocument("Empresa11.222.333/0001-81Ltda")).toBe(true);
  // Número de item antes do CPF formatado com espaços: o espaço separa.
  expect(hasUnmaskedDocument("1 529 . 982 . 247 - 25")).toBe(true);
  // Linha de extrato: datas, documentos de lançamento e valores lado a lado.
  // Janelas de 11 dígitos aqui poderiam passar no verificador por acaso.
  const extrato = [
    "12/11/2026 05/12/2026 0001 2345 6789 01 150,00 2.340,55",
    "Ag 0123 Cc 45678 9 Doc 529 982 247 25 98 Saldo 1.250,00",
    "Lote 11 222 333 0001 81 77 Seq 3",
  ].join("\n");
  expect(hasUnmaskedDocument(extrato)).toBe(false);
});
