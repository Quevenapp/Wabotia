// Configuração da Entrega (chave "entrega" de PUT /settings). Padrões pensados
// para não inundar o cliente nem gastar bateria: previsão a cada 10 minutos,
// no máximo 6 atualizações, posições a cada 15 s enviadas em lote a cada
// minuto. Uso em docs/ENTREGA.md.
import { requireValue } from "../../types";
import { routeProviderIds } from "./geo";

export const UPDATE_MODES = [
  "eta",
  "location",
  "eta_and_location",
  "off",
] as const;
export type UpdateMode = (typeof UPDATE_MODES)[number];

export const TEXT_KEYS = [
  "started",
  "eta",
  "location",
  "arriving",
  "delivered",
  "cancelled",
] as const;
export type TextKey = (typeof TEXT_KEYS)[number];

export interface EntregaConfig {
  /** Ids das pessoas da equipe que fazem entregas. */
  couriers: string[];
  /** Velocidade média para a previsão (km/h). */
  speed_kmh: number;
  /** Fator de ruas sobre a linha reta. */
  road_factor: number;
  /** Fonte da previsão: hoje só straight_line (sem custo). */
  route_provider: string;
  updates: {
    /** O que vai ao cliente a cada intervalo. */
    mode: UpdateMode;
    every_minutes: number;
    /** Máximo de atualizações periódicas por entrega (avisos fora). */
    max: number;
  };
  /** Botão com o link da página de acompanhamento ao sair. */
  tracking_link: boolean;
  /**
   * Sem destino no mapa ao sair (o app não achou o endereço): pede ao
   * cliente, com a janela aberta, que envie a localização pelo WhatsApp.
   */
  ask_location: boolean;
  /** Validade do link de acompanhamento (horas). */
  link_hours: number;
  /** Raio do aviso "chegando" (metros). */
  arriving_radius_m: number;
  notices: { started: boolean; arriving: boolean; delivered: boolean };
  /**
   * Janela de 24 h fechada: "milestones" manda só os avisos (saída, chegada,
   * entrega) pelo modelo de notificação, com o consentimento de pedido;
   * "none" não manda nada. Atualizações periódicas só com a janela aberta.
   */
  outside_window: "milestones" | "none";
  /** O que o app do entregador usa (devolvido em GET /entrega e nos lotes). */
  app: {
    sample_seconds: number;
    upload_seconds: number;
    /** Envio mais frequente perto do destino (dentro de 2 × o raio). */
    near_upload_seconds: number;
    /** Sem posição por esse tempo: "sem sinal" para a equipe. */
    stale_minutes: number;
  };
  /** Horas depois do fim da entrega em que a posição é apagada. */
  retention_hours: number;
  texts: Record<TextKey, string>;
}

export const DEFAULT_TEXTS: Record<TextKey, string> = {
  started: "{rotulo} saiu para entrega com {entregador}.",
  eta: "Previsão de chegada: {horario} (cerca de {minutos} min).",
  location: "{entregador} está aqui agora ({hora_posicao}).",
  arriving: "{entregador} está chegando com {rotulo}.",
  delivered: "{rotulo} foi entregue. Obrigado!",
  cancelled: "A entrega de {rotulo} foi interrompida. A equipe vai falar com você por aqui.",
};

export const DEFAULT_CONFIG: EntregaConfig = {
  couriers: [],
  speed_kmh: 25,
  road_factor: 1.3,
  route_provider: "straight_line",
  updates: { mode: "eta", every_minutes: 10, max: 6 },
  tracking_link: true,
  ask_location: true,
  link_hours: 4,
  arriving_radius_m: 500,
  notices: { started: true, arriving: true, delivered: true },
  outside_window: "milestones",
  app: {
    sample_seconds: 15,
    upload_seconds: 60,
    near_upload_seconds: 30,
    stale_minutes: 5,
  },
  retention_hours: 24,
  texts: { ...DEFAULT_TEXTS },
};

const obj = (v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, any>)
    : {};

function int(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  what: string,
  strict: boolean,
) {
  if (value === undefined || value === null) return fallback;
  const ok = typeof value === "number" && Number.isFinite(value);
  if (strict)
    requireValue(
      ok && value >= min && value <= max,
      `${what}: de ${min} a ${max}.`,
    );
  if (!ok) return fallback;
  return Math.min(max, Math.max(min, value as number));
}
function bool(value: unknown, fallback: boolean, what: string, strict: boolean) {
  if (value === undefined || value === null) return fallback;
  if (strict)
    requireValue(typeof value === "boolean", `${what}: verdadeiro ou falso.`);
  return typeof value === "boolean" ? value : fallback;
}
function choice<T extends string>(
  value: unknown,
  options: readonly T[],
  fallback: T,
  what: string,
  strict: boolean,
): T {
  if (value === undefined || value === null) return fallback;
  if (strict)
    requireValue(
      options.includes(value as T),
      `${what}: use ${options.join(", ")}.`,
    );
  return options.includes(value as T) ? (value as T) : fallback;
}

function normalize(raw: unknown, strict: boolean): EntregaConfig {
  const v = obj(raw);
  const d = DEFAULT_CONFIG;
  let couriers: string[] = [];
  if (v.couriers !== undefined && v.couriers !== null) {
    if (strict)
      requireValue(
        Array.isArray(v.couriers) &&
          v.couriers.length <= 200 &&
          v.couriers.every(
            (id: unknown) =>
              typeof id === "string" && id.length >= 1 && id.length <= 100,
          ),
        "Entregadores: lista de até 200 ids de pessoas da equipe.",
      );
    couriers = Array.isArray(v.couriers)
      ? [
          ...new Set(
            v.couriers.filter((id: unknown) => typeof id === "string"),
          ),
        ].slice(0, 200) as string[]
      : [];
  }
  const updates = obj(v.updates),
    notices = obj(v.notices),
    app = obj(v.app),
    texts = obj(v.texts);
  const outTexts = { ...DEFAULT_TEXTS };
  for (const key of TEXT_KEYS) {
    const text = texts[key];
    if (text === undefined || text === null || text === "") continue;
    if (strict)
      requireValue(
        typeof text === "string" && Array.from(text.trim()).length <= 500,
        `Texto "${key}": até 500 caracteres.`,
      );
    if (typeof text === "string" && text.trim())
      outTexts[key] = text.trim().slice(0, 500);
  }
  if (strict)
    for (const key of Object.keys(texts))
      requireValue(
        (TEXT_KEYS as readonly string[]).includes(key),
        `Texto desconhecido: ${key}. Use ${TEXT_KEYS.join(", ")}.`,
      );
  const appCfg = {
    sample_seconds: int(app.sample_seconds, d.app.sample_seconds, 5, 120, "Intervalo de leitura do GPS (s)", strict),
    upload_seconds: int(app.upload_seconds, d.app.upload_seconds, 30, 300, "Intervalo de envio das posições (s)", strict),
    near_upload_seconds: int(app.near_upload_seconds, d.app.near_upload_seconds, 15, 300, "Envio perto do destino (s)", strict),
    stale_minutes: int(app.stale_minutes, d.app.stale_minutes, 2, 30, "Minutos sem posição até avisar a equipe", strict),
  };
  if (strict)
    requireValue(
      appCfg.sample_seconds <= appCfg.upload_seconds,
      "A leitura do GPS precisa ser mais frequente que o envio.",
    );
  return {
    couriers,
    speed_kmh: int(v.speed_kmh, d.speed_kmh, 5, 120, "Velocidade média (km/h)", strict),
    road_factor:
      Math.round(
        int(v.road_factor, d.road_factor, 1, 2, "Fator de ruas", strict) * 100,
      ) / 100,
    route_provider: choice(
      v.route_provider,
      routeProviderIds(),
      "straight_line",
      "Provedor de rotas",
      strict,
    ),
    updates: {
      mode: choice(updates.mode, UPDATE_MODES, d.updates.mode, "Atualizações ao cliente", strict),
      every_minutes: int(updates.every_minutes, d.updates.every_minutes, 5, 60, "Intervalo das atualizações (min)", strict),
      max: int(updates.max, d.updates.max, 0, 20, "Máximo de atualizações por entrega", strict),
    },
    tracking_link: bool(v.tracking_link, d.tracking_link, "Link de acompanhamento", strict),
    ask_location: bool(v.ask_location, d.ask_location, "Pedir a localização ao cliente", strict),
    link_hours: int(v.link_hours, d.link_hours, 1, 24, "Validade do link (h)", strict),
    arriving_radius_m: int(v.arriving_radius_m, d.arriving_radius_m, 100, 5000, "Raio do aviso de chegada (m)", strict),
    notices: {
      started: bool(notices.started, d.notices.started, "Aviso de saída", strict),
      arriving: bool(notices.arriving, d.notices.arriving, "Aviso de chegada", strict),
      delivered: bool(notices.delivered, d.notices.delivered, "Aviso de entrega", strict),
    },
    outside_window: choice(
      v.outside_window,
      ["milestones", "none"] as const,
      d.outside_window,
      "Fora da janela de 24 h",
      strict,
    ),
    app: appCfg,
    retention_hours: int(v.retention_hours, d.retention_hours, 1, 168, "Retenção da posição (h)", strict),
    texts: outTexts,
  };
}

/** PUT /settings com a chave "entrega": valida e devolve o valor normalizado. */
export const validateEntregaConfig = (value: unknown) => normalize(value, true);

/** Configuração da área, com os padrões no que faltar (nunca lança). */
export const entregaConfig = (settings: any): EntregaConfig =>
  normalize(settings?.entrega, false);

/** Preenche {campo} do texto; campos sem valor somem com a frase vazia. */
export function fill(text: string, values: Record<string, string | number>) {
  return text.replace(/\{([a-z_]+)\}/g, (all, key) =>
    values[key] === undefined ? all : String(values[key]),
  );
}
