#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
const io = createInterface({ input: stdin, output: stdout });
console.log(
  "Assistente de conexão Hermes → Wabotia. Este assistente não altera bots, modelos ou dados.",
);
console.log(
  "Disponível para Linux, Windows/WSL2 e macOS. Em Docker, exponha as portas somente em 127.0.0.1.",
);
const host = (
  await io.question("Hostname administrativo (ex.: hermes.seudominio.com): ")
).trim();
const api = (
  await io.question("Hostname da API (ex.: api-hermes.seudominio.com): ")
).trim();
const dashboardPort = Number(
  (await io.question("Porta local do backend administrativo [9119]: ")) || 9119,
);
const apiPort = Number(
  (await io.question("Porta local API Server [8642]: ")) || 8642,
);
const tunnel = (
  (await io.question("Nome de um NOVO túnel [wabotia-hermes]: ")) ||
  "wabotia-hermes"
).trim();
if (
  ![host, api].every((v) => /^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/.test(v)) ||
  !/^[-a-z0-9]+$/.test(tunnel) ||
  ![dashboardPort, apiPort].every((p) => p > 0 && p < 65536)
)
  throw Error("Hostnames, nome ou portas inválidos.");
const guide = `# Conexão ${tunnel}\n\n1. Confirme as portas do seu Hermes. Não exponha a porta do Vite; use o backend autenticado.\n2. Na Cloudflare Zero Trust > Access > Applications, crie uma aplicação Self-hosted para CADA hostname (${host} e ${api}), com política Service Auth. Crie um Service Token em Access > Service Auth > Service Tokens e inclua-o nas duas políticas.\n3. Instale cloudflared pelo site oficial https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/\n4. Execute os comandos abaixo no computador que alcança o Hermes.\n\n\`\`\`sh\ncloudflared tunnel login\ncloudflared tunnel create ${tunnel}\ncloudflared tunnel route dns ${tunnel} ${host}\ncloudflared tunnel route dns ${tunnel} ${api}\n\`\`\`\n\n5. Copie o UUID exibido e o caminho do arquivo de credenciais para o arquivo YAML gerado. Não publique o JSON de credenciais.\n6. Inicie com: cloudflared tunnel --config tunnel.${tunnel}.local.yml run\n7. No Wabotia > Conexões, informe https://${host}, https://${api}, Bearer do backend, chaves dos perfis e Client ID/Secret do Access. Clique em Testar conexão.\n8. Mantenha cloudflared como serviço do sistema conforme a documentação oficial; em Docker use restart: unless-stopped e volumes persistentes.\n\nWindows: execute pelo PowerShell com cloudflared instalado ou pelo Ubuntu/WSL2. macOS: brew install cloudflared. Linux: use o pacote oficial da sua distribuição. Nenhuma destas opções hospeda o painel localmente.\n`;
await writeFile(
  `tunnel.${tunnel}.local.yml`,
  `tunnel: COLE_O_UUID_DO_TUNEL\ncredentials-file: COLE_O_CAMINHO_DO_JSON\ningress:\n  - hostname: ${host}\n    service: http://127.0.0.1:${dashboardPort}\n    originRequest:\n      httpHostHeader: 127.0.0.1:${dashboardPort}\n  - hostname: ${api}\n    service: http://127.0.0.1:${apiPort}\n  - service: http_status:404\n`,
  { mode: 0o600 },
);
await writeFile(`connection.${tunnel}.local.md`, guide, { mode: 0o600 });
io.close();
console.log(
  `Passo a passo salvo em connection.${tunnel}.local.md. Configure o Access antes de publicar as rotas. Nenhum perfil do Hermes foi alterado.`,
);
