// Página de acompanhamento do passo web (spec.page "track", docs/MODULOS.md):
// o módulo devolve o que mostrar (onWebStepPage) e o núcleo monta a página,
// sem script. O mapa é uma grade de blocos do OpenStreetMap (só imagens HTTPS,
// já permitidas pela política da página) com os marcadores por CSS; a página
// se atualiza sozinha com <meta http-equiv="refresh">.
import { escape, page, type PageBrand } from "./web-steps";

export interface TrackPoint {
  lat: number;
  lng: number;
}

/** O que a página de acompanhamento mostra (devolvido pelo módulo). */
export interface TrackView {
  /** Título ("Pedido nº 12"). */
  title: string;
  /** Situação em poucas palavras ("A caminho", "Entregue"). */
  status_label: string;
  /** Frase principal ("Chega por volta de 19:40, em cerca de 12 min"). */
  headline?: string | null;
  /** Linhas curtas abaixo ("Entregador: Ana", "Posição de 19:28"). */
  lines?: string[];
  /** Aviso em destaque ("Sem sinal do entregador desde 19:20"). */
  notice?: string | null;
  /** Mapa: posição do entregador e destino; sem os dois, a página não tem mapa. */
  map?: {
    courier?: TrackPoint | null;
    destination?: TrackPoint | null;
  } | null;
  /** Segundos até a página recarregar; null ou 0 não recarrega (encerrada). */
  refresh_seconds?: number | null;
}

/** Blocos do mapa. Troque por um servidor próprio se o uso crescer. */
export const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

const rad = (deg: number) => (deg * Math.PI) / 180;
/** Posição fracionária do ponto em blocos (Web Mercator). */
export function tileXY(p: TrackPoint, zoom: number) {
  const n = 2 ** zoom;
  const latRad = rad(Math.max(-85.0511, Math.min(85.0511, p.lat)));
  return {
    x: ((p.lng + 180) / 360) * n,
    y:
      ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
      n,
  };
}

/** Maior zoom (até 16) em que os pontos cabem com folga na grade. */
export function fitZoom(points: TrackPoint[], cols = 3, rows = 3) {
  for (let z = 16; z >= 3; z--) {
    const xy = points.map((p) => tileXY(p, z));
    const xs = xy.map((p) => p.x),
      ys = xy.map((p) => p.y);
    if (
      Math.max(...xs) - Math.min(...xs) <= cols - 1 &&
      Math.max(...ys) - Math.min(...ys) <= rows - 1
    )
      return z;
  }
  return 3;
}

/** Grade de cols × rows blocos centrada nos pontos, e onde cada ponto cai (%). */
export function mapGrid(points: TrackPoint[], cols = 3, rows = 3) {
  const zoom = fitZoom(points, cols, rows);
  const xy = points.map((p) => tileXY(p, zoom));
  const mid = (values: number[]) =>
    (Math.min(...values) + Math.max(...values)) / 2;
  const n = 2 ** zoom;
  const x0 = Math.floor(mid(xy.map((p) => p.x)) - cols / 2);
  const y0 = Math.max(
    0,
    Math.min(n - rows, Math.floor(mid(xy.map((p) => p.y)) - rows / 2)),
  );
  const tiles: { x: number; y: number }[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      tiles.push({ x: (((x0 + c) % n) + n) % n, y: y0 + r });
  const place = (p: TrackPoint) => {
    const t = tileXY(p, zoom);
    const clamp = (v: number) => Math.max(0, Math.min(100, v));
    return {
      left: clamp(((t.x - x0) / cols) * 100),
      top: clamp(((t.y - y0) / rows) * 100),
    };
  };
  return { zoom, cols, rows, tiles, place };
}

const valid = (p: TrackPoint | null | undefined): p is TrackPoint =>
  !!p &&
  Number.isFinite(p.lat) &&
  Number.isFinite(p.lng) &&
  Math.abs(p.lat) <= 90 &&
  Math.abs(p.lng) <= 180;

const TRACK_CSS = `.status{display:inline-block;padding:4px 10px;border-radius:12px;background:#d9fdd3;color:#005c4b;font-weight:600;font-size:14px;margin-bottom:10px}.headline{font-size:18px;font-weight:600}.notice{background:#fff3cd;color:#664d03;border-radius:10px;padding:10px 12px;margin:0 0 14px}.lines{color:#54656f;margin:0 0 14px;padding:0;list-style:none}.map{position:relative;width:100%;aspect-ratio:1;overflow:hidden;border-radius:12px;background:#e5e3df;margin-top:6px}.map .grid{position:absolute;inset:0;display:grid;grid-template-columns:repeat(3,1fr)}.map .grid img{width:100%;height:100%;display:block}.pin{position:absolute;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)}.pin.courier{background:#008069}.pin.dest{background:#c62828}.legend{display:flex;gap:16px;font-size:13px;color:#54656f;margin-top:8px}.legend span::before{content:"";display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:middle}.legend .c::before{background:#008069}.legend .d::before{background:#c62828}.attribution{font-size:11px;color:#667781;margin-top:4px}.attribution a{color:inherit}@media (prefers-color-scheme:dark){.status{background:#005c4b;color:#d9fdd3}.notice{background:#3d3200;color:#ffe08a}.lines,.legend{color:#8696a0}}`;

function mapHtml(view: TrackView) {
  const courier = valid(view.map?.courier) ? view.map!.courier! : null;
  const dest = valid(view.map?.destination) ? view.map!.destination! : null;
  const points = [courier, dest].filter(valid);
  if (!points.length) return "";
  const grid = mapGrid(points);
  const tiles = grid.tiles
    .map(
      (t) =>
        // Só a origem vai como Referer (política de uso do OpenStreetMap); o
        // código do link nunca sai da página.
        `<img src="${escape(
          TILE_URL.replace("{z}", String(grid.zoom))
            .replace("{x}", String(t.x))
            .replace("{y}", String(t.y)),
        )}" alt="" loading="lazy" referrerpolicy="strict-origin">`,
    )
    .join("");
  const pin = (p: TrackPoint, cls: string, label: string) => {
    const at = grid.place(p);
    return `<div class="pin ${cls}" style="left:${at.left.toFixed(2)}%;top:${at.top.toFixed(2)}%" role="img" aria-label="${escape(label)}"></div>`;
  };
  return `<div class="map"><div class="grid">${tiles}</div>${dest ? pin(dest, "dest", "Destino") : ""}${courier ? pin(courier, "courier", "Entregador") : ""}</div><div class="legend">${courier ? '<span class="c">Entregador</span>' : ""}${dest ? '<span class="d">Destino</span>' : ""}</div><div class="attribution">Mapa © <a href="https://www.openstreetmap.org/copyright" rel="noreferrer">colaboradores do OpenStreetMap</a></div>`;
}

/** Página de acompanhamento montada a partir da visão do módulo. */
export function trackPage(
  view: TrackView,
  brand: PageBrand,
  whatsapp?: string | null,
) {
  const refresh =
    view.refresh_seconds && view.refresh_seconds > 0
      ? Math.max(15, Math.min(600, Math.round(view.refresh_seconds)))
      : 0;
  const lines = (view.lines || []).filter(Boolean).slice(0, 8);
  const body = `<div class="card"><span class="status">${escape(view.status_label)}</span><h1>${escape(view.title)}</h1>${
    view.notice ? `<p class="notice" role="status">${escape(view.notice)}</p>` : ""
  }${view.headline ? `<p class="headline">${escape(view.headline)}</p>` : ""}${
    lines.length
      ? `<ul class="lines">${lines.map((l) => `<li>${escape(l)}</li>`).join("")}</ul>`
      : ""
  }${mapHtml(view)}${
    whatsapp
      ? `<a class="button secondary" href="${escape(whatsapp)}">Voltar ao WhatsApp</a>`
      : ""
  }</div>`;
  const html = page(view.title, body, brand, TRACK_CSS);
  return refresh
    ? html.replace(
        "<title>",
        `<meta http-equiv="refresh" content="${refresh}"><title>`,
      )
    : html;
}
