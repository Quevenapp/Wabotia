import type { Api } from "./api";
import { loadChannelUi } from "../channel-ui-loader";

export const demoMe = { id: "demo-user", name: "Administrador", role: "admin" };
export const demoProfile = { id: "demo", name: "Atendimento Queven" };

/** Os cenários e seus contratos só são carregados ao usar a demonstração. */
export const demoApi: Api = async (...args) => {
  await loadChannelUi();
  return (await import("./demo")).demoApi(...args);
};
