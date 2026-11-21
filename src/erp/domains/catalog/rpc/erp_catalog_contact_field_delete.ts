// erp_catalog_contact_field_delete (Vinki, campos próprios de contato;
// esquema do ERP versão 20): exclui uma definição sem valores guardados
// (administrador); com valores, a tela oferece inativar. Regras em
// ../contact-fields.ts.
import { registerRpc } from "../../../engine/registry.ts";
import { contactFieldDelete } from "../contact-fields.ts";

registerRpc("erp_catalog_contact_field_delete", contactFieldDelete);
