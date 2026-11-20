import type { ModuleContext } from "../modules/api";
import type { Actor } from "../types";
import type { CommercialSnapshot, IntegrationModule, SourceRef } from "./contracts";
export type * from "./contracts";
export interface IntegrationProducer {
  module: IntegrationModule;
  authorizeSource(ctx: ModuleContext, actor: Actor, source: SourceRef, write: boolean): Promise<void>;
  project(ctx: ModuleContext, source: SourceRef): Promise<CommercialSnapshot>;
}
export { registerIntegrationProducer } from "./registry";
export { integrationStatements, aliasStatements, findIntegrationEvent } from "./outbox";
export { activationStatements, readIntegrationActivation, eventEpochOpen } from "./activation";
export { drainIntegrationOutbox } from "./consumer";
export { prepareErpRequest, applyErpRequest, closeErpCommand, getErpOrigin, manualApplyErpRequest } from "./erp-adapter";
export { ensureCommercialPolicy } from "./policy";
export { commandId, eventKey } from "./keys";

export { authorizeIntegrationSource, integrationSourceView, integrationCommand } from "./routes";
export { commercialCustomerRef, enrichCommercialCustomer, resolveCommercialCustomer, ensureConsumer } from "./customer-adapter";
export { catalogLink, saveCatalogLink } from "./catalog";
export { commercialReceiptStatements, allocationStatements, registerReceiptReverser } from "./receipts";
