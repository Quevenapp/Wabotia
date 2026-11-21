// erp_catalog_contact_field_values_save (Wabotia, campos próprios de contato;
// esquema do ERP versão 20): grava os campos de um contato (painel ou bot),
// com recibo do comando. Regras em ../contact-fields.ts.
import { registerRpc } from "../../../engine/registry.ts";
import { contactFieldValuesSave } from "../contact-fields.ts";

registerRpc("erp_catalog_contact_field_values_save", contactFieldValuesSave);
