// Parte pesada da instância ERP (esquema gerado, semeadura, motor, domínios,
// backup). Carregada só na primeira chamada /erp-* (src/erp/hub.ts, import
// dinâmico): uma área com o ERP desligado nunca avalia este módulo, e a
// partida do Worker não paga por ele (docs/ERP-FASE0.md, prova 7).
export { ERP_SCHEMA_VERSION, migrate } from "./schema/migrate.ts";
export { engineClock, handleRpc } from "./engine/rpc-endpoint.ts";
export { storageDriver } from "./engine/driver.ts";
export { runRound } from "./scheduler/dispatch.ts";
export { backupToR2, dumpAll, readBackup, restoreAll } from "./engine/dump.ts";
