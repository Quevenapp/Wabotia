// Casas decimais de Preferências › Empresa › Geral nas telas do ERP (decisão
// de 16/11: padrão de 2 casas para preço e quantidade, com o limite valendo no
// servidor). As telas que tinham casas fixas no código (Frente de caixa,
// cadastro de produto) passam a seguir a preferência:
// - exibem o valor com as casas da preferência, sem esconder casas
//   significativas (2 → 2,00; 2.000000 → 2,00; 2,12345 continua 2,12345);
// - recusam, antes de enviar, um valor digitado com mais casas significativas
//   que a preferência; a mensagem do servidor continua tratada.
// Zeros à direita não contam, como no servidor (erp_documents.price_decimals).
import { parsePreferencesPage } from "../../packages/erp-domain/src/preferences/dto.mjs";
import { preferencesPagePath } from "./app/lib/preferences-request.ts";

export interface DecimalPlaces {
  /** Quantidade (o ERP guarda até 6 casas; de 7 a 10 valem 6). */
  quantity: number;
  /** Preço nas entradas (pedido de compra, fornecedor do produto). */
  priceIn: number;
  /** Preço nas saídas (venda, Frente de caixa, preço de venda do produto). */
  priceOut: number;
  /** Peso do produto. */
  weight: number;
}

const FIELDS: Record<keyof DecimalPlaces, [key: string, max: number]> = {
  quantity: ["empresa.decimais_quantidade", 10],
  priceIn: ["empresa.decimais_preco_entrada", 10],
  priceOut: ["empresa.decimais_preco_saida", 10],
  weight: ["empresa.decimais_peso", 5],
};
/** Precisão guardada pelo ERP para quantidades. */
export const QUANTITY_STORAGE_PLACES = 6;

/** Casas da página empresa-geral; lança se a resposta não for a página. */
export function decimalPlaces(raw: unknown): DecimalPlaces {
  const page = parsePreferencesPage(raw, "empresa-geral") as {
    items: { key: string; value: unknown }[];
  };
  const read = ([key, max]: [string, number]) => {
    const value = page.items.find((item) => item.key === key)?.value;
    if (
      !Number.isInteger(value) ||
      (value as number) < 0 ||
      (value as number) > max
    )
      throw new Error("DECIMAL_PLACES_INVALID");
    return value as number;
  };
  return {
    quantity: Math.min(read(FIELDS.quantity), QUANTITY_STORAGE_PLACES),
    priceIn: read(FIELDS.priceIn),
    priceOut: read(FIELDS.priceOut),
    weight: read(FIELDS.weight),
  };
}

type PreferencesPort = {
  preferences?: (
    path: string,
    options: { signal: AbortSignal },
  ) => Promise<unknown>;
};
/**
 * Lê a preferência. Sem leitura (rede, perfil, resposta inválida), devolve
 * null: a tela não limita além do formato e o servidor confere.
 */
export async function loadDecimalPlaces(
  controller: PreferencesPort,
  signal: AbortSignal,
): Promise<DecimalPlaces | null> {
  if (typeof controller.preferences !== "function") return null;
  try {
    return decimalPlaces(
      await controller.preferences(preferencesPagePath("empresa-geral"), {
        signal,
      }),
    );
  } catch {
    return null;
  }
}

const DECIMAL = /^(-?)(\d+)(?:[.,](\d*))?$/;
/** Casas significativas de um decimal em texto ("1,500" tem 1). */
export function significantPlaces(value: string): number {
  const match = DECIMAL.exec(value.trim());
  return match ? (match[3] ?? "").replace(/0+$/, "").length : 0;
}
/**
 * O decimal exato, com ponto, com pelo menos `places` casas e sem perder casas
 * significativas. Sem preferência (null), só tira os zeros à direita. Texto que
 * não é decimal volta como veio.
 */
export function fitDecimal(value: string, places: number | null): string {
  const match = DECIMAL.exec(value.trim());
  if (!match) return value;
  const [, sign, whole, fraction = ""] = match;
  const significant = fraction.replace(/0+$/, "");
  const digits =
    places === null || significant.length >= places
      ? significant
      : significant.padEnd(places, "0");
  return `${sign}${whole}${digits ? `.${digits}` : ""}`;
}
/** Como fitDecimal, com vírgula, para exibir. */
export const showDecimal = (value: string, places: number | null) =>
  fitDecimal(value, places).replace(".", ",");
/** "O preço unitário aceita até 2 casas decimais (Preferências › Empresa › Geral)." */
export const placesMessage = (subject: string, places: number) =>
  `${subject} aceita até ${places} ${places === 1 ? "casa decimal" : "casas decimais"} (Preferências › Empresa › Geral).`;
/** Mensagem quando `value` passa das casas permitidas; null quando cabe ou sem preferência. */
export function placesProblem(
  value: string,
  places: number | null,
  subject: string,
): string | null {
  return places !== null && significantPlaces(value) > places
    ? placesMessage(subject, places)
    : null;
}
