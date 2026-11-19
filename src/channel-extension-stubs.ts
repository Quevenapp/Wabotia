import { ApiError } from "./types";
import type { ChannelExtension, ExtensionKey } from "./channel-c2-contracts";
import type { ChannelId, ChannelSpec } from "./channel-contracts";

export const EXTENSION_KEYS: readonly ExtensionKey[] = [
  "instagram/comment", "facebook/comment", "telegram/direct", "googlebusiness/review", "email/direct", "tiktok/direct",
];
export function channelNotReady(): never {
  throw new ApiError(503, "channel_not_ready", "Este canal ainda não está disponível.");
}
function stub(key: ExtensionKey): ChannelExtension {
  const [id, context] = key.split("/") as [ChannelId, "direct" | "comment" | "review"];
  const spec: ChannelSpec = {
    id, label: id, enabled: false, transport: id === "telegram" ? "telegram_bot" : id === "email" ? "email" : "zernio",
    serviceLine: id !== "googlebusiness", context, contexts: { [context]: { enabled: false, bot: false, publicReply: false } },
    text: { enabled: false, maxChars: null }, media: {}, menu: { buttons: 0, quickReplies: 0, listItems: 0, fallback: "numbered_text" },
    window: { kind: "none" }, initiation: "customer_first", templates: false, subject: false, replyTo: false, bold: "none",
  };
  return Object.freeze({ key, spec, normalize: async () => channelNotReady(),
    prepareInbound: async () => channelNotReady(), prepareSend: async () => channelNotReady(),
    deliver: async () => channelNotReady(), complete: async () => channelNotReady(), routes: [] });
}
/** Permanentes, fora do registro: instalar uma implementação não troca nem muta um stub. */
export const CHANNEL_EXTENSION_STUBS = Object.freeze(Object.fromEntries(
  EXTENSION_KEYS.map(key => [key, stub(key)]),
)) as Readonly<Record<ExtensionKey, ChannelExtension>>;
