import type { IntegrationProducer } from "./ports";
import type { IntegrationModule } from "./contracts";
import { IntegrationError } from "./privacy";

export const INTEGRATION_MODULES: readonly IntegrationModule[] = ["os", "pedido", "mesas", "entrega", "mensalidade", "agenda", "reserva", "suporte"];
const producers = new Map<IntegrationModule, IntegrationProducer>();
export function registerIntegrationProducer(producer: IntegrationProducer): void {
  if (!INTEGRATION_MODULES.includes(producer.module)) throw new IntegrationError("invalid_request", 400);
  if (producers.has(producer.module) && producers.get(producer.module) !== producer) throw new IntegrationError("producer_conflict", 409);
  producers.set(producer.module, producer);
}
export function integrationProducer(module: IntegrationModule): IntegrationProducer {
  const producer = producers.get(module);
  if (!producer) throw new IntegrationError("integration_not_implemented", 422);
  return producer;
}
/** A casca da casa única e o painel portável consomem o mesmo metadado. */
export const INTEGRATION_MENU_EXCLUSIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({ "erp.service-orders": ["os"] });
