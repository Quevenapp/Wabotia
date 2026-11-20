// Inventários "só do sistema", sem dependências: a rota /erp-rpc
// (rpc-endpoint.ts) e a costura da erp-api (api/local-fetch.ts) usam os
// mesmos nomes sem carregar o motor na partida do Worker.

/**
 * RPCs do agendador e da plataforma, sem checagem de quem chama (no Fagoo só
 * têm GRANT para o service_role): na rota /erp-rpc, só com a marca de
 * chamada interna (SYSTEM_HEADER). Defesa em profundidade: o cliente nunca
 * escolhe nome de RPC nem p_user_id (as rotas da erp-api escolhem), mas um
 * caminho novo que repasse nome vindo de fora não alcança estas
 * (N-consulta-leituras.md; tests/erp-do-rpc-system.test.ts). A costura da
 * erp-api, que atende pessoas e aplicações, recusa estes nomes antes de pôr a
 * marca (local-fetch.ts).
 */
export const SYSTEM_RPCS: ReadonlySet<string> = new Set([
  "erp_platform_schedule",
  "erp_platform_task_claim",
  "erp_platform_task_progress",
  "erp_platform_task_finish",
  "erp_platform_notifications_run",
  "erp_platform_export_plan",
  "erp_platform_export_chunk",
  "erp_platform_export_complete",
  "erp_platform_export_expired",
  "erp_platform_export_removed",
  "erp_wabotia_state",
  // Sincronização com a origem (erp-api, origin-two-way.mjs): no Fagoo só o
  // service_role as chama (sem p_user_id). Ainda não portadas; ficam aqui
  // desde já para que, portadas, não sejam alcançáveis por pessoa.
  "erp_sync_ack",
  "erp_sync_census_add",
  "erp_sync_census_diff",
  "erp_sync_claim",
  "erp_sync_indicator_observe",
  "erp_sync_pull",
  "erp_sync_remote_deleted",
  "erp_sync_run_get",
  "erp_sync_run_update",
  "erp_sync_stage",
]);
/** Operações fiscais internas; preserva o inventário legado do agendador. */
export const COM1_INTERNAL_RPCS: ReadonlySet<string> = new Set([
  "erp_com1_claim", "erp_com1_record", "erp_com1_cancel_claim",
  "erp_com1_cancel_record", "erp_com1_cancel_xml_record",
]);
