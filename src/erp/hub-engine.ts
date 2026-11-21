// Parte pesada da instância ERP (esquema gerado, semeadura, motor, domínios,
// backup). Carregada só na primeira chamada /erp-* (src/erp/hub.ts, import
// dinâmico): uma área com o ERP desligado nunca avalia este módulo, e a
// partida do Worker não paga por ele (docs/ERP-FASE0.md, prova 7).
export { ERP_SCHEMA_VERSION, migrate } from "./schema/migrate.ts";
export { engineClock, handleRpc } from "./engine/rpc-endpoint.ts";
export { storageDriver } from "./engine/driver.ts";
export { CONTINUE_AFTER_MS, runRound, nextWake, TASK_HANDLERS } from "./scheduler/dispatch.ts";
export { FILE_PURPOSES, runFileTasks } from "./scheduler/files.ts";
export { backupToR2, dumpAll, readBackup, restoreAll, ErpBackupTooLargeError, ErpRestoreBusyError } from "./engine/dump.ts";
export { startBackup, startRestore, runBackupJob, ErpBackupJobError } from "./engine/backup-pages.ts";
export { beginArchiveRestore, endArchiveRestore } from "./bling/xml.ts";
export { ROUTINES } from "./scheduler/routines.ts";
export { handleBlingOperation, runBlingWake, nextBlingWake } from "./bling/assembly.ts";
export { handleContadorRequest, runContadorWake, nextContadorWake } from "./contador/do.ts";
export { handleSpedRequest, runSpedWake, nextSpedWake } from "./sped/do.ts";
