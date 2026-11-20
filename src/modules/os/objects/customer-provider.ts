import type { Os2Adapters } from "../os2-ports";
import { authorizeObjectContact } from "./access";
import { listAuthorizedObjects, objectPageLimit } from "./routes";

/** Coleção do módulo: o núcleo continua dono da ficha cadastral. */
export const objectCustomerContribution: Os2Adapters["objectCustomerContribution"] = async (
  ctx, actor, contactId, query,
) => {
  // A autorização antecede até a abertura do cursor e o LIMIT da consulta.
  const owner = await authorizeObjectContact(ctx, actor, contactId);
  const page = await listAuthorizedObjects(ctx, actor, owner, {
    limit: objectPageLimit(query.limit), cursor: query.cursor,
    include_archived: true, collection: "contact-profile",
  });
  return { items: page.data.map(object => ({
    id: object.id,
    cells: {
      identifier: object.identifier, type: object.type.labels.singular,
      status: object.archived ? "Arquivado" : "Ativo",
    },
    target: { module: "os", resource: "service-objects", id: object.id },
  })), nextCursor: page.next_cursor, incomplete: false };
};
