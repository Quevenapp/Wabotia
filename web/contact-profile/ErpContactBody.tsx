import { RawContactEditor, type RawContactEditorProps } from "../erp/app/components/ContactEditor";

/** A7 monta este corpo com sessão/controlador/autorização existentes em raiz exclusiva. */
export function ErpContactBody(props: RawContactEditorProps) {
  return <RawContactEditor {...props} embeddedProfile />;
}
export default ErpContactBody;
