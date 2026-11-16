// Funções do Catálogo que as listas de preço e os produtos usam, num lugar só:
// o acesso (erp_catalog.require_access, allowed, detail_uuid) da P, direto de
// access.ts para não criar ciclo com public.ts (que reexporta pricing/).
export { detailUuid, requireAccess } from "../access.ts";
