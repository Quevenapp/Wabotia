import { defineConfig } from "vite";

const backend = "http://127.0.0.1:8787";

export default defineConfig({
  build: { outDir: "dist" },
  server: {
    proxy: {
      "^/api/": {
        target: backend,
        changeOrigin: true,
        // O servidor confere a origem das escritas. No desenvolvimento a
        // página vem do Vite (5173); apresente a origem do próprio backend.
        configure: (proxy) => {
          proxy.on("proxyReq", (request) => {
            if (request.getHeader("origin")) request.setHeader("origin", backend);
          });
        },
      },
    },
  },
});
