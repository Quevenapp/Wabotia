// Emissor fiscal do ERP: o que o domínio Fiscal (quando portado) importa.
// A NFapi é a única implementação e se registra ao carregar este arquivo.
// Detalhes: README.md desta pasta.
import { emissorConnection } from "./config.ts";
import { createNfapiProvider } from "./nfapi-provider.ts";
import {
  fiscalProviderById,
  providerNotConfigured,
  registerFiscalProvider,
  type FiscalContext,
  type FiscalProvider,
} from "./provider.ts";

registerFiscalProvider(createNfapiProvider());

/** Provedor configurado na área; sem emissor: 409 fiscal_provider_not_configured. */
export async function fiscalProviderFor(ctx: FiscalContext): Promise<FiscalProvider> {
  const conn = await emissorConnection(ctx.env, ctx.profile);
  const provider = fiscalProviderById(conn?.provider);
  if (!conn || !provider) throw providerNotConfigured();
  return provider;
}

export * from "./provider.ts";
export { fiscalReference } from "./nfapi-provider.ts";
export { emissorView, emissorAlerts, type EmissorAlert, type EmissorCheck } from "./config.ts";
