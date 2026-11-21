// erp_catalog_contact_fields (Wabotia, campos próprios de contato; esquema do
// ERP versão 20): as definições que o público vê (Preferências › Cadastros,
// cadastro, ficha do atendimento, lista e bots). Regras em ../contact-fields.ts.
import { registerRpc } from "../../../engine/registry.ts";
import { contactFieldList } from "../contact-fields.ts";

registerRpc("erp_catalog_contact_fields", contactFieldList);
