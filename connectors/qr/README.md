# QR direto

Processo externo Node.js 22.13+ com Baileys. O painel, API e dados operacionais ficam na Cloudflare. Este conector não precisa do Hermes para enviar mensagens humanas; bots dependem das APIs Hermes.

1. No Wabotia, crie uma conexão `qr`, informe o número com DDI e emita o token do conector. Ative-a após preparar o processo.
2. Copie `.env.example` para `.env` e preencha URL HTTPS, ID da conexão e token. Guarde o arquivo em local privado.
3. Execute `npm ci` e `npm start`, ou `docker compose up -d --build` nesta pasta.
4. Veja o QR em **Conexões** no painel e leia pelo WhatsApp > Aparelhos conectados.

Não são publicadas portas de entrada. O processo usa HTTPS de saída e precisa permanecer ligado. O token autoriza apenas o transporte daquela conexão, não o painel/API administrativa.

A sessão e o diário SQLite ficam em `data/` (ou no volume `qr-data` no Compose). Faça backup com o conector parado. Não exclua o volume ao atualizar. O diário marca envio interrompido como desconhecido para conferência, evitando repetir automaticamente um efeito ambíguo. Monitore espaço: não há expurgo automático do spool nesta versão.

Para pausar/trocar modo, pause a conexão no painel, pare o processo, reconcilie pendências e só depois ative outro consumidor do número. Nunca execute duas cópias sobre a mesma sessão.

Baileys 7.0.0-rc13 foi instalado e importado em validação técnica; pareamento com conta real ainda precisa de homologação. O Compose é fornecido para operação e não foi validado com uma sessão WhatsApp real.
