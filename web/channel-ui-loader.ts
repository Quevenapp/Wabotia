import { channelCatalogVisible } from "./channel-extensions";
import type { ChannelUiData } from "./channel-extension-contracts";

let pending: Promise<void> | undefined;

/** Só baixa os canais opcionais quando a área os usa ou o catálogo foi aberto. */
export function loadChannelUi(status: ChannelUiData = {}, search?: string): Promise<void> {
  if (!channelCatalogVisible(status, search)) return Promise.resolve();
  return pending ??= import("./c2/register").then(module => {
    module.installC2Web();
  }).catch(error => {
    pending = undefined;
    throw error;
  });
}
