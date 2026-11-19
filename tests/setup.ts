import { env, applyD1Migrations } from "cloudflare:test";
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
// O motor instala o enfileiramento dos canais ao ser carregado
// (src/channel-enqueue.ts). No Worker isso vem do ponto de entrada; aqui
// garante o mesmo para o teste que importa só o serviço.
await import("../src/engine");
