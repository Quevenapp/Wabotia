// erp_catalog_contact_field_values (Wabotia, campos próprios de contato;
// esquema do ERP versão 20): os campos de um contato para o cadastro do
// painel, a ficha do atendimento ou o bot. Regras em ../contact-fields.ts.
import { registerRpc } from "../../../engine/registry.ts";
import { contactFieldValues } from "../contact-fields.ts";

registerRpc("erp_catalog_contact_field_values", contactFieldValues);
