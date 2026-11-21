// erp_catalog_contact_field_save (Vinki, campos próprios de contato; esquema
// do ERP versão 20): cria ou altera a definição (administrador). Liberar um
// campo sensível pede o aviso confirmado e fica registrado. Regras em
// ../contact-fields.ts.
import { registerRpc } from "../../../engine/registry.ts";
import { contactFieldSave } from "../contact-fields.ts";

registerRpc("erp_catalog_contact_field_save", contactFieldSave);
