import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  // O Worker importa ../src/push-fcm.ts do repositório raiz.
  server: { fs: { allow: [".."] } },
  test: { include: ["test/**/*.test.ts"], fileParallelism: false },
});
