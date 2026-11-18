// Endereço da entrega para o app do entregador (docs/ENTREGA.md, "Endereço"):
// os campos separados além do texto, completados com a cidade e a UF da loja
// quando o pedido não as tem, e a posição da loja como referência de busca.
// Sem provedor de mapa no servidor: quem procura o endereço é o app, perto da
// loja (store.position), ou vai direto ao destino quando há coordenadas.
import { requireValue } from "../../types";
import type { ModuleContext } from "../api";
import { validLat, validLng } from "./geo";

/** Mesmos nomes do endereço da Empresa do ERP e do pedido. */
export interface DeliveryAddress {
  street: string;
  number: string;
  complement: string;
  district: string;
  city: string;
  /** UF, duas letras. */
  state: string;
  /** CEP, 8 dígitos. */
  postal_code: string;
  reference: string;
}

const KEYS: (keyof DeliveryAddress)[] = [
  "street",
  "number",
  "complement",
  "district",
  "city",
  "state",
  "postal_code",
  "reference",
];
const LIMITS: Record<keyof DeliveryAddress, number> = {
  street: 200,
  number: 30,
  complement: 200,
  district: 100,
  city: 100,
  state: 2,
  postal_code: 9,
  reference: 200,
};

/** Endereço gravado (JSON) ou vindo do pedido, com todos os campos; null se vazio. */
export function readAddress(raw: unknown): DeliveryAddress | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out = {} as DeliveryAddress;
  for (const k of KEYS) out[k] = typeof r[k] === "string" ? (r[k] as string) : "";
  return KEYS.some((k) => out[k]) ? out : null;
}

/** Endereço informado na criação manual da entrega (POST entrega/deliveries). */
export function addressInput(raw: unknown): DeliveryAddress | null {
  if (raw === undefined || raw === null) return null;
  requireValue(typeof raw === "object" && !Array.isArray(raw), "Endereço: envie um objeto.");
  const r = raw as Record<string, unknown>;
  const out = {} as DeliveryAddress;
  for (const k of KEYS) {
    const v = r[k];
    if (v === undefined || v === null) {
      out[k] = "";
      continue;
    }
    requireValue(
      typeof v === "string" && Array.from(v.trim()).length <= LIMITS[k],
      `Endereço, ${k}: até ${LIMITS[k]} caracteres.`,
    );
    out[k] = (v as string).trim();
  }
  out.state = out.state.toUpperCase();
  requireValue(!out.state || /^[A-Z]{2}$/.test(out.state), "Endereço, state: a UF com duas letras.");
  out.postal_code = out.postal_code.replace("-", "");
  requireValue(!out.postal_code || /^\d{8}$/.test(out.postal_code), "Endereço, postal_code: 8 dígitos.");
  return KEYS.some((k) => out[k]) ? out : null;
}

/** Endereço numa linha: "Rua X, 200 - Bairro, Apto 2, Cidade - UF (referência)". */
export function formatAddress(a: DeliveryAddress) {
  const street = [a.street, a.number].filter(Boolean).join(", ");
  const place = [a.city, a.state].filter(Boolean).join(" - ");
  return [[street, a.district].filter(Boolean).join(" - "), a.complement, place]
    .filter(Boolean)
    .join(", ")
    .concat(a.reference ? ` (${a.reference})` : "");
}

/** A loja como referência para o app procurar o destino (Estabelecimento). */
export interface StoreRef {
  name: string;
  city: string;
  state: string;
  /** Posição da loja; o app procura o endereço perto dela. */
  position: { lat: number; lng: number } | null;
}

export async function storeRef(ctx: ModuleContext): Promise<StoreRef> {
  const est: any = await ctx.establishment().catch(() => ({}));
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const lat = est.latitude,
    lng = est.longitude;
  return {
    name: s(est.name),
    city: s(est.city),
    state: s(est.state),
    position: validLat(lat) && validLng(lng) ? { lat, lng } : null,
  };
}

/**
 * Endereço que a entrega grava: o estruturado (ou o texto, como rua), com a
 * cidade e a UF da loja quando faltam. O texto passa a terminar na cidade;
 * texto livre que já cita a cidade da loja fica como veio.
 */
export function completeAddress(
  structured: DeliveryAddress | null,
  text: string,
  store: Pick<StoreRef, "city" | "state">,
): { address: DeliveryAddress | null; address_text: string } {
  const base: DeliveryAddress | null =
    structured ?? (text ? { ...(readAddress({ street: text }) as DeliveryAddress) } : null);
  if (!base) return { address: null, address_text: text };
  let filled = false;
  if (!base.city && store.city) {
    base.city = store.city;
    base.state = base.state || store.state;
    filled = true;
  }
  if (structured) return { address: base, address_text: formatAddress(base) };
  const cites = store.city && text.toLowerCase().includes(store.city.toLowerCase());
  const place = [base.city, base.state].filter(Boolean).join(" - ");
  return {
    address: base,
    address_text: filled && !cites ? `${text}, ${place}` : text,
  };
}

/** Sem cidade em lugar nenhum e sem destino: o app avisa em vez de procurar às cegas. */
export const addressIncomplete = (address: DeliveryAddress | null, hasDestination: boolean) =>
  !hasDestination && !address?.city;
