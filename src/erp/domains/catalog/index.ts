// RPCs portados do domínio: um import por arquivo de src/erp/domains/catalog/rpc/
// (cada um chama registerRpc). Só a sessão dona do domínio edita este arquivo.

import "./rpc/erp_catalog_employee_get.ts";
import "./rpc/erp_catalog_employee_page.ts";
import "./rpc/erp_catalog_employee_save.ts";
import "./rpc/erp_catalog_product_images.ts";
import "./rpc/erp_catalog_product_image_delete.ts";
import "./rpc/erp_catalog_product_image_order.ts";
import "./rpc/erp_catalog_product_image_stop.ts";
import "./rpc/erp_catalog_product_get.ts";
import "./rpc/erp_catalog_product_list.ts";
import "./rpc/erp_catalog_product_page.ts";
import "./rpc/erp_catalog_product_page_v2.ts";
import "./rpc/erp_catalog_product_page_v3.ts";
import "./rpc/erp_catalog_product_page_custom.ts";
import "./rpc/erp_catalog_product_export.ts";
import "./rpc/erp_catalog_product_export_v2.ts";
import "./rpc/erp_catalog_product_form_context.ts";
import "./rpc/erp_catalog_product_purchase_info.ts";
import "./rpc/erp_catalog_product_variations.ts";
import "./rpc/erp_catalog_product_price_preview.ts";
import "./pricing/index.ts";
