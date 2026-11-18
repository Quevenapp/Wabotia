import { basename } from "node:path";
import { defineConfig } from "vite";
import { fagooScope } from "./web/erp/css-scope.ts";
import { erpChunk } from "./web/erp/chunks.ts";

const backend = "http://127.0.0.1:8787";

export default defineConfig({
  build: {
    outDir: "dist",
    rolldownOptions: {
      // ERP (web/erp/app + packages): agrupado por módulo do menu, sempre
      // fora do pacote inicial do painel (web/erp/chunks.ts). Sem levar as
      // dependências junto: React e a casca continuam no pacote do painel.
      // Sem preservar a assinatura das entradas dinâmicas, uma tela agrupada
      // não ganha um arquivo-fachada só para reexportá-la.
      preserveEntrySignatures: false,
      output: {
        // Os grupos dividem módulos que se importam entre arquivos: a ordem de
        // execução tem de seguir a dos imports, não a dos arquivos.
        strictExecutionOrder: true,
        // Com a ordem estrita o painel vira um chunk comum, que o Rolldown
        // batizaria com o nome da pasta do projeto.
        chunkFileNames: (chunk) =>
          `assets/${chunk.name === basename(import.meta.dirname) ? "painel" : "[name]"}-[hash].js`,
        codeSplitting: {
          includeDependenciesRecursively: false,
          // Componente carregado sob demanda por outro (RealAccess, prévias)
          // fica no próprio arquivo; o resto vai para o grupo do módulo.
          groups: [
            {
              name: (id, ctx) =>
                /\/web\/erp\/app\/components\//.test(
                  id.replaceAll("\\", "/"),
                ) && ctx.getModuleInfo(id)?.dynamicImporters.length
                  ? null
                  : (erpChunk(id) ?? null),
            },
          ],
        },
      },
    },
  },
  css: {
    postcss: {
      // O CSS do Fagoo só vale dentro de .fagoo-root (web/erp/css-scope.ts).
      plugins: [
        fagooScope((file) => /\/web\/erp\/app\/.+\.css(\?|$)/.test(file)),
      ],
    },
  },
  server: {
    proxy: {
      "^/api/": {
        target: backend,
        changeOrigin: true,
        // O servidor confere a origem das escritas. No desenvolvimento a
        // página vem do Vite (5173); apresente a origem do próprio backend.
        configure: (proxy) => {
          proxy.on("proxyReq", (request) => {
            if (request.getHeader("origin"))
              request.setHeader("origin", backend);
          });
        },
      },
    },
  },
});
