// Frete: os provedores conhecidos (um adaptador por provedor). Um provedor
// novo implementa FreightProvider (./provider.ts) e entra aqui e em
// FREIGHT_PROVIDERS.
// Só sintaxe TypeScript apagável: os testes do Node importam este arquivo.
import { correiosProvider } from "./correios.ts";
import { melhorEnvioProvider } from "./melhorenvio.ts";
import type { FreightProvider, FreightProviderId } from "./provider.ts";

export const FREIGHT_PROVIDER_ADAPTERS: Readonly<Record<FreightProviderId, FreightProvider>> = Object.freeze({
  correios: correiosProvider,
  melhorenvio: melhorEnvioProvider,
});
