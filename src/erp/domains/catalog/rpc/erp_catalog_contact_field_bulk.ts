// erp_catalog_contact_field_bulk (Vinki, campos próprios de contato; esquema
// do ERP versão 20): valores de até 100 contatos para as colunas da lista e a
// exportação; campo sensível só depois de liberado. Regras em ../contact-fields.ts.
import { registerRpc } from "../../../engine/registry.ts";
import { contactFieldBulk } from "../contact-fields.ts";

registerRpc("erp_catalog_contact_field_bulk", contactFieldBulk);
