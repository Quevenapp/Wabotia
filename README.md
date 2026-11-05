# Wabotia

Painel de atendimento em português, com bots Hermes, WhatsApp, equipe humana pelo Telegram e API para integrações. O painel e seus dados operacionais são hospedados na sua conta Cloudflare. O Hermes continua no computador, Docker ou servidor de sua escolha.

**Antes do botão:** [vincule sua conta Cloudflare ao GitHub](https://wabotia.queven.app/install#vincular-contas). Se a tela fechar após autorizar a conexão, volte e clique no botão novamente para continuar a instalação.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Quevenapp/Wabotia)

**[Instalação ilustrada](https://wabotia.queven.app/install)** · **[API interativa](https://wabotia.queven.app/api-docs)** · **[PDF](https://wabotia.queven.app/guide/wabotia-instalacao.pdf)**

## Estado da versão

Versão 0.2.3, com diagnóstico visível de conexões, atualização pelo painel e assistente para preparar Hermes na Cloudflare. O núcleo é testado em `workerd`, com D1, R2 e Durable Objects, e por requisições ao ambiente Cloudflare de homologação. A conexão de produção exige homologar **seus** perfis e canais com as respectivas credenciais. Consulte [validação e limitações](docs/VALIDACAO.md) antes de ativar o atendimento.

## Instalar na Cloudflare

Requisitos: conta Cloudflare com Workers Paid como referência de produção, R2 habilitado, Node.js 22.13 ou superior, npm e Git. O instalador cria recursos novos e preserva o Hermes existente.

```sh
git clone https://github.com/Quevenapp/Wabotia.git
cd Wabotia
npm ci
npx wrangler login
npm run setup
```

O assistente publica o Worker, provisiona D1/R2, aplica migrações e gera secrets. Ao final, abra a URL publicada com `/app`. Crie seu administrador usando o `SETUP_TOKEN` do arquivo local `.secrets.production.local.json`. Guarde também `MASTER_KEY`: perder essa chave impede recuperar as credenciais criptografadas. **Nunca envie esses arquivos ao GitHub.**

Para teste isolado: `npm run setup -- --environment staging`. Para domínio próprio: `npm run setup -- --domain painel.seudominio.com`. O domínio deve estar na mesma conta Cloudflare. Configurações locais, bancos, mídias e secrets não integram o repositório.

O botão Deploy to Cloudflare importa o código na sua conta e publica o Worker. Preencha os secrets e mantenha `npm run deploy` como comando de publicação para aplicar as migrações automaticamente, conforme o [guia](docs/INSTALACAO.md). GitHub Actions não é necessário; o repositório Quevenapp/Wabotia mantém Actions desativado.

## Conectar serviços

1. Crie um perfil no painel e cadastre a conexão Hermes com as URLs administrativas/API, o token administrativo e as chaves de cada perfil autorizado.
2. Teste a conexão, descubra os bots, habilite os selecionados e escolha o Atendente. A API Hermes deve anunciar `features.runs_idempotency.durable`.
3. Conecte um canal WhatsApp: Meta direto no Worker; QR pelo [conector Baileys](connectors/qr); ou WhatsApp pelo Hermes com o [transporte exclusivo](connectors/hermes).
4. Use um bot Telegram dedicado em grupo privado com tópicos. Cadastre cada atendente e seu ID Telegram. O Telegram não requer plugin no Hermes.
5. Cadastre conhecimento, menus, ações de especialistas e presença. Teste antes de ativar.

Para Hermes privado: `node scripts/connect-hermes.mjs` gera as instruções e configuração de Cloudflare Tunnel protegido por Access, para Linux, WSL2 e macOS. HTTPS público autenticado também é aceito.

Também é possível usar **Conexões → Preparar Hermes na Cloudflare**. Após ligar as APIs locais e autorizar um token Cloudflare em **Sistema e atualizações**, o painel cria Access, túnel e DNS e entrega um instalador privado para o conector. Veja [pré-requisitos, etapas e recuperação](docs/HERMES-CLOUDFLARE.md#deploy-da-configuração-pelo-painel).

## API

REST/JSON em `/api/v1`, OpenAPI 3.1 em `/api/openapi.json`. Cada integração tem identidade própria, permissões, perfis e bots autorizados. Chaves Bearer são exibidas na emissão, persistidas como hash e podem expirar, ser rotacionadas ou revogadas. Recibos de operações que devolvem secrets são criptografados.

Escritas exigem `Idempotency-Key`. Execuções de bots retornam `202` e são acompanhadas por consulta ou webhooks HMAC. Timeouts sem confirmação exigem reconciliação; não iniciam outra execução automaticamente. [Exemplos cURL, JavaScript e Python](docs/API.md).

## Desenvolvimento e operação

```sh
npm run check
npm test
npm run build
npm run migrate:local
npm run dev
```

Copie `.dev.vars.example` para `.dev.vars` com valores locais antes de testar autenticação. O modo `/app?demo=1` mostra dados fictícios e não permite gravações. Desenvolvimento local não é uma opção de hospedagem de produção.

Atualizar pelo painel: [configure Cloudflare Builds e o Deploy Hook uma vez](docs/ATUALIZACOES.md) e use **Sistema e atualizações → Atualizar Wabotia**. Publicação manual: `npm run build`, `npx wrangler d1 migrations apply DB --remote --config wrangler.production.local.json`, `npx wrangler deploy --config wrangler.production.local.json`. [Backup, restauração e diagnóstico](docs/OPERACAO.md).

Uma organização por implantação; fuso America/Sao_Paulo. R2 é privado. O histórico do WABABOTAI não é importado automaticamente. Não há dependência de VPS ou Supabase para hospedar o Wabotia. Hermes e QR precisam permanecer ligados; a interface web permanece disponível quando eles estão offline.

## Licença e contribuição

MIT. Derivado das regras do WABABOTAI e de sua extensão genérica de entrada exclusiva; veja [atribuições](NOTICE). Não inclua credenciais, arquivos de clientes ou bancos em contribuições. Não há workflows GitHub Actions; execute as verificações manualmente.
