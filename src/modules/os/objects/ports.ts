import type { Os2Adapters } from "../os2-ports";
import { prepareObjectOpening, reauthorizeObjectOpening, prepareLegacyObjectLink, planObjectContactMerge } from "./store";
import { projectObjectSnapshot, projectObjectForActor, projectObjectPage, publicObjectLabel, getWorkObjectContext } from "./projection";
import { objectCustomerContribution } from "./customer-provider";
import { readObjectRoute, commandObjectRoute } from "./routes";

/** A integração instala estas portas no Worker e em cada Coordinator. */
export const objectAdapters = {
  prepareObjectOpening,
  reauthorizeObjectOpening,
  prepareLegacyObjectLink,
  projectObjectSnapshot,
  projectObjectForActor,
  projectObjectPage,
  publicObjectLabel,
  getWorkObjectContext,
  planObjectContactMerge,
  objectCustomerContribution,
  read: readObjectRoute,
  command: commandObjectRoute,
} satisfies Partial<Os2Adapters>;

export { prepareObjectOpening, reauthorizeObjectOpening, prepareLegacyObjectLink, planObjectContactMerge };
export { projectObjectSnapshot, projectObjectForActor, projectObjectPage, publicObjectLabel, getWorkObjectContext };
export { objectCustomerContribution, readObjectRoute, commandObjectRoute };
export { authorizeObjectContact, authorizeObjectAccess, authorizeObjectConversation } from "./access";
export { readAuthorizedObject } from "./routes";
export { previewLegacyObjectLink } from "./store";
