/** Instalação compartilhada pela entrada histórica e pela fachada de composição. */
import { installChannelExtensions } from "../channel-extension-registry";
import { commentsExtensions } from "../c2/comments";
import { telegramExtension } from "../c2/telegram";
import { googleReviewsExtension } from "../c2/google-reviews";
import { emailChannel } from "../c2/email-channel";
import { tiktokExtension } from "../c2/tiktok";

export const C2_EXTENSIONS = Object.freeze([
  ...commentsExtensions, telegramExtension, googleReviewsExtension, emailChannel, tiktokExtension,
]);

/** Apenas registro em memória; sem I/O nem leitura de credenciais. */
export function installC2Worker(): void {
  installChannelExtensions(C2_EXTENSIONS);
}

installC2Worker();
