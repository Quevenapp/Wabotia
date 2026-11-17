// Endereço de entrega do pedido além de rua, bairro, complemento e referência
// (que o carrinho do núcleo valida): número, cidade, UF, CEP e a localização.
// Sem cidade e UF no pedido, valem as do Estabelecimento (a cidade da loja):
// o app do entregador procura o destino na cidade certa.
import { requireValue } from "../../types";
import type { ModuleContext } from "../api";
import type { OrderAddress } from "./orders";

export const UFS = [
  "AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA", "MG", "MS", "MT", "PA",
  "PB", "PE", "PI", "PR", "RJ", "RN", "RO", "RR", "RS", "SC", "SE", "SP", "TO",
];

const text = (value: unknown, max: number, what: string) => {
  if (value === undefined || value === null) return "";
  requireValue(
    typeof value === "string" && Array.from(value.trim()).length <= max,
    `${what}: até ${max} caracteres.`,
  );
  return (value as string).trim();
};

export const validLat = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= -90 && v <= 90;
export const validLng = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= -180 && v <= 180;

/** Cidade e UF da loja (Estabelecimento), quando preenchidas. */
export async function storePlace(ctx: ModuleContext) {
  const est: any = await ctx.establishment().catch(() => ({}));
  return {
    city: typeof est.city === "string" ? est.city : "",
    state: typeof est.state === "string" ? est.state : "",
  };
}

/**
 * Campos além do carrinho, validados: number (30), city (100), state (UF),
 * postal_code (8 dígitos; aceita 00000-000), lat e lng (os dois ou nenhum).
 */
export function addressExtras(raw: any): Partial<OrderAddress> {
  const data = raw && typeof raw === "object" ? raw : {};
  const out: Partial<OrderAddress> = {};
  const number = text(data.number, 30, "Número");
  if (number) out.number = number;
  const city = text(data.city, 100, "Cidade");
  if (city) out.city = city;
  const state = text(data.state, 2, "UF").toUpperCase();
  if (state) {
    requireValue(UFS.includes(state), "UF: use a sigla do estado (SP, RJ…).");
    out.state = state;
  }
  const postal = text(data.postal_code, 9, "CEP").replace("-", "");
  if (postal) {
    requireValue(/^\d{8}$/.test(postal) && postal !== "00000000", "CEP: 8 dígitos.");
    out.postal_code = postal;
  }
  const hasLat = data.lat !== undefined && data.lat !== null;
  const hasLng = data.lng !== undefined && data.lng !== null;
  if (hasLat || hasLng) {
    requireValue(validLat(data.lat) && validLng(data.lng), "Localização: informe lat e lng em graus.");
    out.lat = data.lat;
    out.lng = data.lng;
  }
  return out;
}

/** Sem cidade, completa cidade e UF com as da loja (só o que faltar). */
export function withStorePlace(
  address: OrderAddress,
  place: { city: string; state: string },
): OrderAddress {
  if (address.city || !place.city) return address;
  return { ...address, city: place.city, state: address.state || place.state };
}
