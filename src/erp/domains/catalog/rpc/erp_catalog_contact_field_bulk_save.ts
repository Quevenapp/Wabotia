// erp_catalog_contact_field_bulk_save (Wabotia, campos próprios de contato;
// esquema do ERP versão 20): valores da importação de contatos, até 50
// contatos por comando; cada linha passa ou fica de fora sozinha. Regras em
// ../contact-fields.ts.
import { registerRpc } from "../../../engine/registry.ts";
import { contactFieldBulkSave } from "../contact-fields.ts";

registerRpc("erp_catalog_contact_field_bulk_save", contactFieldBulkSave);
