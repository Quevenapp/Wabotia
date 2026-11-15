// Normalizes the WhatsApp extras Zernio puts in `metadata` of
// message.received (docs.zernio.com/webhooks/inbox/message-received) into the
// inbound message content the engine receives. Plain text, media, button and
// list taps keep the fields they always had; this adds:
//
//   content.type "flow_reply" + content.flow_reply   (nfm_reply: Flow answer
//                                                     or address_message)
//   content.type "order"      + content.order        (cart from the catalog)
//   content.type "location"   + content.location     ({latitude, longitude,
//                                                     name, address[, url]})
//   content.interactive_type, content.referred_product, content.contacts_origin
//
// Flow answers and orders also get a short readable summary in `text` (alone,
// or after the customer's own text), so history, notifications and bots see
// what arrived. Other messages keep their text unchanged.
import { flowIdFromToken } from "./whatsapp-interactive";

export interface FlowReply {
  /** "flow" for a Flow, "address_message" for the native address form. */
  name: string;
  /** Token sent with the Flow; null when Meta did not return one. */
  flow_token: string | null;
  /** Flow id when the token follows `<flowId>:<reference>`. */
  flow_id: string | null;
  /** Submitted fields, without flow_token. */
  data: Record<string, unknown>;
}
export interface OrderItem {
  product_retailer_id: string;
  quantity: number;
  /** Unit price as sent by WhatsApp; null when absent. */
  item_price: number | null;
  currency: string;
}
export interface CatalogOrder {
  catalog_id: string;
  /** Customer's note on the cart. */
  note: string;
  items: OrderItem[];
  /** Sum of quantity × price, only when every item has price and one currency. */
  total: { value: number; currency: string } | null;
}
export interface SharedLocation {
  latitude: number;
  longitude: number;
  name: string;
  address: string;
  url?: string;
}

const object = (value: unknown): Record<string, any> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null;
const string = (value: unknown) => (typeof value === "string" ? value : "");
const number = (value: unknown) => {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};
const clip = (value: string, max: number) =>
  Array.from(value).length > max
    ? `${Array.from(value).slice(0, max).join("")}…`
    : value;

export function flowReply(metadata: Record<string, any>): FlowReply | null {
  let data = object(metadata.flowResponseData);
  if (!data && typeof metadata.flowResponseJson === "string")
    try {
      data = object(JSON.parse(metadata.flowResponseJson));
    } catch {
      data = null;
    }
  if (!data && metadata.interactiveType !== "nfm_reply") return null;
  const { flow_token, ...fields } = data || {};
  const token = string(flow_token) || null;
  return {
    name: string(metadata.nfmReplyName) || "flow",
    flow_token: token,
    flow_id: flowIdFromToken(token),
    data: fields,
  };
}

export function catalogOrder(value: unknown): CatalogOrder | null {
  const order = object(value);
  if (!order || !Array.isArray(order.product_items)) return null;
  const items: OrderItem[] = order.product_items
    .map(object)
    .filter((item: any) => item && string(item.product_retailer_id))
    .map((item: any) => ({
      product_retailer_id: item.product_retailer_id,
      quantity: number(item.quantity) ?? 1,
      item_price: number(item.item_price),
      currency: string(item.currency).toUpperCase(),
    }));
  const currencies = new Set(items.map((item) => item.currency));
  const priced =
    items.length > 0 &&
    currencies.size === 1 &&
    !currencies.has("") &&
    items.every((item) => item.item_price !== null);
  return {
    catalog_id: string(order.catalog_id),
    note: string(order.text),
    items,
    total: priced
      ? {
          // Cents avoid binary rounding in sums like 0.1 + 0.2.
          value:
            Math.round(
              items.reduce(
                (sum, item) => sum + item.quantity * item.item_price! * 100,
                0,
              ),
            ) / 100,
          currency: items[0].currency,
        }
      : null,
  };
}

export function sharedLocation(value: unknown): SharedLocation | null {
  const location = object(value);
  if (!location) return null;
  const latitude = number(location.latitude),
    longitude = number(location.longitude);
  if (
    latitude === null ||
    longitude === null ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  )
    return null;
  return {
    latitude,
    longitude,
    name: string(location.name),
    address: string(location.address),
    ...(string(location.url) ? { url: location.url } : {}),
  };
}

function money(value: number, currency: string) {
  try {
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency,
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`.trim();
  }
}

function fieldValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value)) return value.map(fieldValue).join(", ");
  return JSON.stringify(value);
}

export function flowReplyText(reply: FlowReply) {
  const lines = Object.entries(reply.data)
    .map(([key, value]) => [key, clip(fieldValue(value), 500)])
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}: ${value}`);
  const title =
    reply.name === "address_message"
      ? "Endereço enviado"
      : "Formulário enviado";
  return clip([`${title}.`, ...lines].join("\n"), 3800);
}

export function orderText(order: CatalogOrder) {
  const lines = order.items.map(
    (item) =>
      `${item.quantity} x ${item.product_retailer_id}${item.item_price === null ? "" : ` (${money(item.item_price, item.currency)} cada)`}`,
  );
  return clip(
    [
      "Pedido pelo catálogo:",
      ...lines,
      ...(order.total
        ? [`Total: ${money(order.total.value, order.total.currency)}`]
        : []),
      ...(order.note.trim() ? [`Observação: ${order.note.trim()}`] : []),
    ].join("\n"),
    3800,
  );
}

/**
 * Content fields and text for an inbound Zernio WhatsApp message. `content`
 * holds only the fields to add; `text` is the customer's text, with the
 * summary of a Flow answer or order when there is one.
 */
export function normalizeZernioMetadata(
  metadata: unknown,
  text: string,
): { content: Record<string, unknown>; text: string } {
  const meta = object(metadata) || {};
  const content: Record<string, unknown> = {};
  let summary = "";
  if (string(meta.interactiveType))
    content.interactive_type = meta.interactiveType;
  if (string(meta.contactsOrigin))
    content.contacts_origin = meta.contactsOrigin;
  const referred = object(meta.referredProduct);
  if (referred && string(referred.product_retailer_id))
    content.referred_product = {
      catalog_id: string(referred.catalog_id),
      product_retailer_id: referred.product_retailer_id,
    };
  if (meta.location) {
    // Coordinates are numbers in the content, like the location we send. An
    // unreadable value is kept as received, as before.
    content.type = "location";
    content.location = sharedLocation(meta.location) || meta.location;
  }
  const reply = flowReply(meta);
  if (reply) {
    content.type = "flow_reply";
    content.flow_reply = reply;
    summary = flowReplyText(reply);
  }
  const order = catalogOrder(meta.order);
  if (order) {
    content.type = "order";
    content.order = order;
    summary = orderText(order);
  }
  const own = text.trim();
  if (!summary) return { content, text };
  // WhatsApp's own label of an nfm_reply ("Sent") says nothing; a cart note
  // that Zernio also copies into the text is already in the summary.
  if (!own || /^sent$/i.test(own) || summary.includes(own))
    return { content, text: summary };
  return { content, text: `${text}\n\n${summary}` };
}
