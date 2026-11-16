// Contas de geografia da Entrega, sem rede e sem custo: distância em linha
// reta (haversine), velocidade média pelos últimos pontos, previsão de chegada
// e os blocos do mapa (OpenStreetMap) para a página de acompanhamento.
//
// A previsão por ruas fica atrás de RouteProvider: hoje só "straight_line"
// existe. Um provedor de rotas (OSRM próprio, OpenRouteService, Google…) entra
// aqui como outra implementação, com decisão do responsável pela instalação
// (custo, chave e envio do endereço do cliente a terceiros: docs/ENTREGA.md).

export interface Point {
  lat: number;
  lng: number;
}
/** Ponto do rastro: [instante em ms, latitude, longitude]. */
export type TrailPoint = [number, number, number];

const EARTH_M = 6371008.8;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Distância em metros entre dois pontos (linha reta sobre a esfera). */
export function distanceM(a: Point, b: Point) {
  const dLat = rad(b.lat - a.lat),
    dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const validLat = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 90;
export const validLng = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 180;

/**
 * Velocidade média em km/h pelo rastro (só trechos dos últimos 10 minutos,
 * ignorando paradas longas e saltos impossíveis do GPS), ou null.
 */
export function trailSpeedKmh(trail: TrailPoint[], at: number) {
  const recent = trail.filter(([t]) => at - t <= 10 * 60000);
  let meters = 0,
    ms = 0;
  for (let i = 1; i < recent.length; i++) {
    const [t0, la0, ln0] = recent[i - 1],
      [t1, la1, ln1] = recent[i];
    const dt = t1 - t0;
    if (dt <= 0 || dt > 5 * 60000) continue;
    const d = distanceM({ lat: la0, lng: ln0 }, { lat: la1, lng: ln1 });
    // Mais de 150 km/h entre dois pontos é salto do GPS.
    if (d / (dt / 1000) > 150 / 3.6) continue;
    meters += d;
    ms += dt;
  }
  if (ms < 60000) return null;
  return (meters / (ms / 1000)) * 3.6;
}

export interface EtaInput {
  from: Point;
  to: Point;
  /** Velocidade configurada da área (km/h). */
  speedKmh: number;
  /** Fator de ruas sobre a linha reta (1,3 = 30 % a mais). */
  roadFactor: number;
  /** Velocidade medida pelo rastro, se houver. */
  measuredKmh?: number | null;
}
export interface Eta {
  /** Distância em linha reta, metros. */
  distance_m: number;
  /** Distância estimada pelas ruas, metros. */
  route_m: number;
  minutes: number;
  /** Provedor usado: straight_line (linha reta × fator). */
  provider: string;
}

/** Fonte da previsão de chegada. Implementações sem rede devolvem na hora. */
export interface RouteProvider {
  id: string;
  eta(input: EtaInput): Promise<Eta> | Eta;
}

/**
 * Linha reta × fator de ruas, à velocidade média. A velocidade medida entra só
 * entre metade e o dobro da configurada: parado no semáforo não vira "nunca"
 * e um trecho de avenida não vira "já chegou".
 */
export const straightLine: RouteProvider = {
  id: "straight_line",
  eta({ from, to, speedKmh, roadFactor, measuredKmh }) {
    const distance = distanceM(from, to);
    const route = distance * roadFactor;
    const speed =
      measuredKmh && measuredKmh > 0
        ? Math.min(speedKmh * 2, Math.max(speedKmh / 2, measuredKmh))
        : speedKmh;
    const minutes = Math.max(1, Math.ceil(route / ((speed * 1000) / 60)));
    return {
      distance_m: Math.round(distance),
      route_m: Math.round(route),
      minutes,
      provider: "straight_line",
    };
  },
};

const providers = new Map<string, RouteProvider>([
  [straightLine.id, straightLine],
]);
/** Provedor pelo id da configuração; desconhecido cai na linha reta. */
export const routeProvider = (id: string | undefined) =>
  providers.get(id || "") || straightLine;
export const routeProviderIds = () => [...providers.keys()];
