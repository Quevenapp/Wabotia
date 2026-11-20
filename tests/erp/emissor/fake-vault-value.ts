import type { PedidoNfe } from "../../../src/erp/emissor/contract/types.generated.ts";
import { rescale, toScaled } from "../../../src/erp/engine/dec.ts";

const decimal = (value: number | undefined, scale: number): bigint => {
  const number = value ?? 0;
  // Números muito pequenos usam notação exponencial em JavaScript. A escala
  // do contrato é finita; esta expansão mantém a totalização em inteiros.
  const text = String(number).includes("e") ? number.toFixed(20) : String(number);
  return toScaled(text, scale);
};
const cents = (value: number | undefined) => decimal(value, 2);

/** Totaliza os valores declarados do pedido simulado de NF-e/NFC-e.
 * Não calcula tributos nem valida regras fiscais: alíquotas, bases e valores
 * já vêm do pedido. Pagamentos e troco não alteram o valor da mercadoria.
 */
export function fakeNfeValue(body: Pick<PedidoNfe, "itens">): number {
  const total = body.itens.reduce((sum, item) => {
    if (item.compoeTotal === false) return sum;
    const taxes = item.impostos;
    const gross = item.valorTotal === undefined
      ? rescale(decimal(item.quantidade, 4) * decimal(item.valorUnitario, 10), 14, 2)
      : cents(item.valorTotal);
    return sum + gross + cents(item.frete) + cents(item.seguro) + cents(item.outrasDespesas) - cents(item.desconto)
      + cents(taxes.ipi?.valor) + cents(taxes.ii?.valor) + cents(taxes.icms.st?.valor) + cents(taxes.icms.st?.fcp?.valor)
      - (taxes.icms.desoneracao?.deduzDoTotal ? cents(taxes.icms.desoneracao.valor) : 0n);
  }, 0n);
  return Number(total) / 100;
}
