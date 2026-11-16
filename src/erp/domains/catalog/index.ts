// RPCs portados do domínio: um import por arquivo de src/erp/domains/catalog/rpc/
// (cada um chama registerRpc). Só a sessão dona do domínio edita este arquivo.

import "./rpc/erp_catalog_employee_get.ts";
import "./rpc/erp_catalog_employee_page.ts";
import "./rpc/erp_catalog_employee_save.ts";
import "./rpc/erp_catalog_product_images.ts";
import "./rpc/erp_catalog_product_image_delete.ts";
import "./rpc/erp_catalog_product_image_order.ts";
import "./rpc/erp_catalog_product_image_stop.ts";
import "./pricing/index.ts";
