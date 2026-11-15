// Typed WhatsApp interactive messages (docs/ZERNIO-WHATSAPP.md, "Mensagens
// interativas"). Each spec builds the Meta Cloud API `interactive` object the
// Zernio inbox forwards unchanged, and the numbered text with links used by
// lines without interactive messages (QR) and stored as the message text.
//
// Limits follow Meta's Cloud API reference, which the Zernio `interactive`
// field mirrors; Zernio adds: product without header, product_list with a text
// header, carousel of 2 to 10 cards without top-level header/footer.
import { ApiError, uid } from "./types";

/** Shown on lines without the native element (QR) and when it is absent. */
export interface InteractiveFallback {
  /** Extra text, e.g. the price list or the instructions for a web step. */
  text?: string;
  /** Web page that does the same thing (store, form, web step). */
  url?: string;
}

interface Common {
  /** Text header (not allowed on product, carousel and location request). */
  header?: string;
  footer?: string;
  fallback?: InteractiveFallback;
}

export interface CtaUrlSpec extends Common {
  type: "cta_url";
  body: string;
  /** Button label, up to 20 characters. */
  display_text: string;
  url: string;
}
export interface ListRow {
  /** Returned in `interactive_reply_id` when tapped; up to 200 characters. */
  id: string;
  title: string;
  description?: string;
}
export interface ListSpec extends Common {
  type: "list";
  body: string;
  /** Label of the button that opens the list, up to 20 characters. */
  button: string;
  sections: { title?: string; rows: ListRow[] }[];
}
export interface MediaCard {
  media: "image" | "video";
  /** Public HTTPS address of the image or video. */
  link: string;
  body?: string;
  display_text: string;
  url: string;
}
export interface MediaCarouselSpec {
  type: "media_carousel";
  body: string;
  cards: MediaCard[];
  fallback?: InteractiveFallback;
}
export interface LocationRequestSpec {
  type: "location_request";
  body: string;
  fallback?: InteractiveFallback;
}
export interface ProductSpec {
  type: "product";
  catalog_id: string;
  product_retailer_id: string;
  body?: string;
  footer?: string;
  fallback?: InteractiveFallback;
}
export interface ProductListSpec {
  type: "product_list";
  catalog_id: string;
  /** Required by WhatsApp. */
  header: string;
  body: string;
  footer?: string;
  sections: { title: string; product_retailer_ids: string[] }[];
  fallback?: InteractiveFallback;
}
export interface CatalogSpec {
  type: "catalog";
  body: string;
  footer?: string;
  /** Product shown as thumbnail; WhatsApp uses the first item otherwise. */
  thumbnail_product_retailer_id?: string;
  fallback?: InteractiveFallback;
}
/** A published Flow sent inside the conversation (the regular outbox). */
export interface FlowSpec extends Common {
  type: "flow";
  flow_id: string;
  /** Button label. */
  flow_cta: string;
  body: string;
  /** Correlates the answer; see flowToken(). */
  flow_token: string;
  flow_action?: "navigate" | "data_exchange";
  /** For navigate: { screen, data? }. */
  flow_action_payload?: Record<string, unknown>;
}

export type InteractiveSpec =
  | CtaUrlSpec
  | ListSpec
  | MediaCarouselSpec
  | LocationRequestSpec
  | ProductSpec
  | ProductListSpec
  | CatalogSpec
  | FlowSpec;

/** Characters as WhatsApp counts them (code points, not UTF-16 units). */
const size = (value: string) => Array.from(value).length;

function invalid(message: string): never {
  throw new ApiError(422, "invalid_interactive", message);
}

function text(value: unknown, max: number, label: string, required = true) {
  if (value === undefined || value === null || value === "") {
    if (required) invalid(`Informe ${label}.`);
    return "";
  }
  if (typeof value !== "string" || !value.trim()) invalid(`Informe ${label}.`);
  if (size(value) > max)
    invalid(`${capitalize(label)} aceita até ${max} caracteres.`);
  return value;
}

const capitalize = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1);

function address(value: unknown, label: string) {
  const url = text(value, 2000, label);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    invalid(`${capitalize(label)} precisa ser um endereço http(s) válido.`);
  }
  if (!["https:", "http:"].includes(parsed.protocol) || !parsed.hostname)
    invalid(`${capitalize(label)} precisa ser um endereço http(s) válido.`);
  return url;
}

function id(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) invalid(`Informe ${label}.`);
  return value;
}

const textHeader = (value?: string) =>
  value
    ? { header: { type: "text", text: text(value, 60, "o cabeçalho") } }
    : {};
const footer = (value?: string) =>
  value ? { footer: { text: text(value, 60, "o rodapé") } } : {};

/** Meta's `interactive` object for the spec, after checking every limit. */
export function buildInteractive(spec: InteractiveSpec): Record<string, any> {
  if (!spec || typeof spec !== "object")
    invalid("Mensagem interativa inválida.");
  switch (spec.type) {
    case "cta_url":
      return {
        type: "cta_url",
        ...textHeader(spec.header),
        body: { text: text(spec.body, 1024, "o texto da mensagem") },
        ...footer(spec.footer),
        action: {
          name: "cta_url",
          parameters: {
            display_text: text(spec.display_text, 20, "o texto do botão"),
            url: address(spec.url, "o link do botão"),
          },
        },
      };
    case "list": {
      const sections = spec.sections;
      if (!Array.isArray(sections) || !sections.length || sections.length > 10)
        invalid("A lista precisa de 1 a 10 seções.");
      const ids = new Set<string>();
      let rows = 0;
      const built = sections.map((section) => {
        if (!Array.isArray(section?.rows) || !section.rows.length)
          invalid("Cada seção da lista precisa de ao menos uma opção.");
        rows += section.rows.length;
        return {
          // WhatsApp requires a title on every section when there are several.
          ...(section.title || sections.length > 1
            ? { title: text(section.title, 24, "o título da seção") }
            : {}),
          rows: section.rows.map((row) => {
            const rowId = text(row?.id, 200, "o identificador da opção");
            if (ids.has(rowId))
              invalid("Os identificadores das opções não podem se repetir.");
            ids.add(rowId);
            return {
              id: rowId,
              title: text(row.title, 24, "o título da opção"),
              ...(row.description
                ? {
                    description: text(
                      row.description,
                      72,
                      "a descrição da opção",
                    ),
                  }
                : {}),
            };
          }),
        };
      });
      if (rows > 10) invalid("A lista aceita até 10 opções no total.");
      return {
        type: "list",
        ...textHeader(spec.header),
        body: { text: text(spec.body, 4096, "o texto da mensagem") },
        ...footer(spec.footer),
        action: {
          button: text(spec.button, 20, "o texto do botão da lista"),
          sections: built,
        },
      };
    }
    case "media_carousel": {
      const cards = spec.cards;
      if (!Array.isArray(cards) || cards.length < 2 || cards.length > 10)
        invalid("O carrossel precisa de 2 a 10 cartões.");
      const media = cards[0]?.media;
      return {
        type: "carousel",
        body: { text: text(spec.body, 1024, "o texto da mensagem") },
        action: {
          cards: cards.map((card, index) => {
            if (!["image", "video"].includes(card?.media))
              invalid("Cada cartão precisa de uma imagem ou um vídeo.");
            if (card.media !== media)
              invalid(
                "Todos os cartões do carrossel usam o mesmo tipo de mídia.",
              );
            return {
              card_index: index,
              type: "cta_url",
              header: {
                type: card.media,
                [card.media]: { link: address(card.link, "o link da mídia") },
              },
              ...(card.body
                ? { body: { text: text(card.body, 160, "o texto do cartão") } }
                : {}),
              action: {
                name: "cta_url",
                parameters: {
                  display_text: text(
                    card.display_text,
                    20,
                    "o texto do botão do cartão",
                  ),
                  url: address(card.url, "o link do cartão"),
                },
              },
            };
          }),
        },
      };
    }
    case "location_request":
      return {
        type: "location_request_message",
        body: { text: text(spec.body, 1024, "o texto da mensagem") },
        action: { name: "send_location" },
      };
    case "product":
      return {
        type: "product",
        ...(spec.body
          ? { body: { text: text(spec.body, 1024, "o texto da mensagem") } }
          : {}),
        ...footer(spec.footer),
        action: {
          catalog_id: id(spec.catalog_id, "o catálogo"),
          product_retailer_id: id(spec.product_retailer_id, "o produto"),
        },
      };
    case "product_list": {
      const sections = spec.sections;
      if (!Array.isArray(sections) || !sections.length || sections.length > 10)
        invalid("A lista de produtos precisa de 1 a 10 seções.");
      let items = 0;
      const built = sections.map((section) => {
        const ids = section?.product_retailer_ids;
        if (!Array.isArray(ids) || !ids.length)
          invalid("Cada seção precisa de ao menos um produto.");
        items += ids.length;
        return {
          title: text(section.title, 24, "o título da seção"),
          product_items: ids.map((item) => ({
            product_retailer_id: id(item, "o produto"),
          })),
        };
      });
      if (items > 30) invalid("A lista de produtos aceita até 30 itens.");
      return {
        type: "product_list",
        header: { type: "text", text: text(spec.header, 60, "o cabeçalho") },
        body: { text: text(spec.body, 1024, "o texto da mensagem") },
        ...footer(spec.footer),
        action: {
          catalog_id: id(spec.catalog_id, "o catálogo"),
          sections: built,
        },
      };
    }
    case "catalog":
      return {
        type: "catalog_message",
        body: { text: text(spec.body, 1024, "o texto da mensagem") },
        ...footer(spec.footer),
        action: {
          name: "catalog_message",
          ...(spec.thumbnail_product_retailer_id
            ? {
                parameters: {
                  thumbnail_product_retailer_id: id(
                    spec.thumbnail_product_retailer_id,
                    "o produto da miniatura",
                  ),
                },
              }
            : {}),
        },
      };
    case "flow": {
      if (
        spec.flow_action !== undefined &&
        !["navigate", "data_exchange"].includes(spec.flow_action)
      )
        invalid("Ação do Flow inválida.");
      if (
        spec.flow_action_payload !== undefined &&
        (typeof spec.flow_action_payload !== "object" ||
          spec.flow_action_payload === null ||
          Array.isArray(spec.flow_action_payload))
      )
        invalid("Dados iniciais do Flow inválidos.");
      return {
        type: "flow",
        ...textHeader(spec.header),
        body: { text: text(spec.body, 1024, "o texto da mensagem") },
        ...footer(spec.footer),
        action: {
          name: "flow",
          parameters: {
            flow_message_version: "3",
            flow_token: id(spec.flow_token, "o token do Flow"),
            flow_id: id(spec.flow_id, "o Flow"),
            flow_cta: text(spec.flow_cta, 30, "o texto do botão do Flow"),
            flow_action: spec.flow_action || "navigate",
            ...(spec.flow_action_payload
              ? { flow_action_payload: spec.flow_action_payload }
              : {}),
          },
        },
      };
    }
    default:
      invalid("Tipo de mensagem interativa não suportado.");
  }
}

/** Ordered choices a numbered reply refers to ("1", "2"…), for lists. */
export function numberedOptions(spec: InteractiveSpec) {
  return spec.type === "list"
    ? spec.sections.flatMap((section) => section.rows)
    : [];
}

const fallbackTail = (fallback?: InteractiveFallback) =>
  [fallback?.text?.trim(), fallback?.url ? `Acesse: ${fallback.url}` : ""]
    .filter(Boolean)
    .join("\n");

/**
 * The same content as plain text: numbered options and links in the body.
 * Lines without interactive messages send exactly this; the official lines
 * keep it as the stored text of the message.
 */
export function interactiveFallbackText(spec: InteractiveSpec): string {
  const blocks: string[] = [];
  const head = (header?: string, body?: string) =>
    [header?.trim(), body?.trim()].filter(Boolean).join("\n");
  switch (spec.type) {
    case "cta_url":
      blocks.push(
        head(spec.header, spec.body),
        `${spec.display_text}: ${spec.url}`,
      );
      break;
    case "list": {
      let index = 0;
      const several = spec.sections.length > 1;
      const lines = spec.sections.flatMap((section) => [
        ...(several && section.title ? [`${section.title}:`] : []),
        ...section.rows.map(
          (row) =>
            `${++index}. ${row.title}${row.description ? ` - ${row.description}` : ""}`,
        ),
      ]);
      blocks.push(
        head(spec.header, spec.body),
        lines.join("\n"),
        "Responda com o número da opção.",
      );
      break;
    }
    case "media_carousel":
      blocks.push(
        spec.body.trim(),
        spec.cards
          .map(
            (card, index) =>
              `${index + 1}. ${card.body?.trim() ? `${card.body.trim()} - ` : ""}${card.display_text}: ${card.url}`,
          )
          .join("\n"),
      );
      break;
    case "location_request":
      blocks.push(
        spec.body.trim(),
        "Para enviar, toque no clipe, escolha Localização e envie a sua localização atual.",
      );
      break;
    case "product":
      blocks.push(
        spec.body?.trim() ||
          "Separamos um produto do nosso catálogo para você.",
      );
      break;
    case "product_list":
      blocks.push(head(spec.header, spec.body));
      break;
    case "catalog":
      blocks.push(spec.body.trim());
      break;
    case "flow":
      blocks.push(head(spec.header, spec.body));
      break;
  }
  blocks.push(fallbackTail(spec.fallback));
  if ("footer" in spec && spec.footer?.trim()) blocks.push(spec.footer.trim());
  return blocks.filter(Boolean).join("\n\n");
}

const plain = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim();

/**
 * The list row a text reply chose on a line without lists: its number in the
 * fallback text or its exact title (accents and case ignored).
 */
export function numberedReply(spec: InteractiveSpec, reply: string) {
  const options = numberedOptions(spec),
    value = plain(reply);
  if (/^\d+$/.test(value)) return options[Number(value) - 1]?.id || null;
  return options.find((row) => plain(row.title) === value)?.id || null;
}

/**
 * Correlation token for a Flow. Keeps Zernio's `<flowId>:` prefix, so the
 * answers are also listed by GET /v1/whatsapp/flow-responses?flowId=.
 */
export function flowToken(flowId: string, reference: string = uid()) {
  id(flowId, "o Flow");
  id(reference, "a referência do Flow");
  return `${flowId}:${reference}`;
}

/** The Flow id carried by a token made by flowToken() or by Zernio. */
export function flowIdFromToken(token: unknown) {
  if (typeof token !== "string") return null;
  const index = token.indexOf(":");
  return index > 0 ? token.slice(0, index) : null;
}
