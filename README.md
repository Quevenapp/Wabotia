# Wabotia

Painel de atendimento em português, com bots Hermes, WhatsApp, equipe humana pelo Telegram e API para integrações. O painel e seus dados operacionais são hospedados na sua conta Cloudflare. O Hermes continua no computador, Docker ou servidor de sua escolha.

**Instalação direta na Cloudflare, sem conta GitHub, cópia de repositório ou Deploy Hook.**

**[Instalação ilustrada](https://wabotia.queven.app/install)** · **[API interativa](https://wabotia.queven.app/api-docs)** · **[PDF](https://wabotia.queven.app/guide/wabotia-instalacao.pdf)**

## Estado da versão

Versão 0.5.0, com mídia nativa, gravador de voz, grupos, ações de mensagem e ligações humanas pela Meta Calling API. Inclui agenda de contatos por perfil, importação CSV com prévia e cadastro/vínculo a partir das conversas. Inclui instalação guiada, diagnóstico de conexões, atualização pelo painel e assistente para preparar Hermes na Cloudflare. O núcleo é testado em `workerd`, com D1, R2 e Durable Objects, e por requisições ao ambiente Cloudflare de homologação. A conexão de produção exige homologar **seus** perfis e canais com as respectivas credenciais. Consulte [validação e limitações](docs/VALIDACAO.md) antes de ativar o atendimento.

## Instalar na Cloudflare

Requisitos: conta Cloudflare, Workers Paid como referência de produção, R2 habilitado, Node.js 22.13+ e npm. Comece pelo [passo a passo do Node.js para VPS/Ubuntu, Windows e macOS](https://wabotia.queven.app/install#nodejs), incluindo `libatomic1` no Ubuntu. O guia também explica as três permissões do token inicial.

```sh
curl -fL https://wabotia.queven.app/install-wabotia.mjs -o install-wabotia.mjs
node install-wabotia.mjs
```

Informe Account ID, token Cloudflare e nome novo. O instalador baixa um pacote oficial, cria os recursos, aplica migrações e gera as chaves. Abra a URL exibida com `/app` e use SETUP_TOKEN de `chaves.local.json`. Guarde a pasta privada criada; MASTER_KEY é necessária para recuperar credenciais.

As próximas versões são instaladas em **Sistema e atualizações → Verificar atualização → Atualizar Wabotia**. [Instalação, Windows, retomada e reinstalação](docs/INSTALACAO.md) · [Atualizações e publicação de versões](docs/ATUALIZACOES.md).

O repositório oficial continua público/MIT, com Actions desativado. Sua instalação recebe versões oficiais publicadas e mantém banco, mídias e secrets na sua própria Cloudflare.

## Conectar serviços

1. Crie um perfil no painel e cadastre a conexão Hermes com as URLs administrativas/API, o token administrativo e as chaves de cada perfil autorizado.
2. Teste a conexão, descubra os bots, habilite os selecionados e escolha o Atendente. A API Hermes deve anunciar `features.runs_idempotency.durable`.
3. Conecte um canal WhatsApp: Meta direto no Worker; QR pelo [conector Baileys](connectors/qr); ou WhatsApp pelo Hermes com o [transporte exclusivo](connectors/hermes).
4. Use um bot Telegram dedicado em grupo privado com tópicos. Cadastre cada atendente e seu ID Telegram. O Telegram não requer plugin no Hermes.
5. Cadastre conhecimento, menus, ações de especialistas e presença. Teste antes de ativar.

Para Hermes privado: `node scripts/connect-hermes.mjs` gera as instruções e configuração de Cloudflare Tunnel protegido por Access, para Linux, WSL2 e macOS. HTTPS público autenticado também é aceito.

Também é possível usar **Conexões → Preparar Hermes na Cloudflare**. Após ligar as APIs locais e autorizar um token Cloudflare em **Sistema e atualizações**, o painel cria Access, túnel e DNS e entrega um instalador privado para o conector. Veja [pré-requisitos, etapas e recuperação](docs/HERMES-CLOUDFLARE.md#deploy-da-configuração-pelo-painel).

## WhatsApp completo para atendimento

Receba e envie imagens, vídeos, áudio, voz, documentos, figurinhas, localização e contatos conforme o canal. Gerencie grupos pelo QR e grupos empresariais Meta elegíveis. Ligações de voz usam Meta direto e WebRTC no navegador; QR/Hermes não fazem chamadas e não há videochamadas. Todos esses recursos têm rotas autenticadas na API. [Guia e limites por modo](docs/WHATSAPP.md).

Atualize também o processo QR ou o transporte Hermes; o botão do painel atualiza somente a parte Cloudflare. Homologação com número real permanece pendente.

## Agenda de contatos

Abra **Agenda de contatos** para cadastrar, buscar e editar clientes. Importe arquivos CSV UTF-8 de até 500 contatos/1 MB, conferindo erros e linhas idênticas antes de salvar. Em **Conversas → Salvar contato**, crie um cadastro ou vincule uma pessoa da agenda. Nome, telefone, e-mail, empresa e observações ficam salvos no perfil; telefones não unem clientes automaticamente. [Passo a passo com telas](docs/CONTATOS.md) · [Modelo CSV](public/modelo-contatos.csv).

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

Atualizar pelo painel: [use a autorização direta configurada pelo instalador](docs/ATUALIZACOES.md) e use **Sistema e atualizações → Atualizar Wabotia**. Publicação manual: `npm run build`, `npx wrangler d1 migrations apply DB --remote --config wrangler.production.local.json`, `npx wrangler deploy --config wrangler.production.local.json`. [Backup, restauração e diagnóstico](docs/OPERACAO.md).

Uma organização por implantação; fuso America/Sao_Paulo. R2 é privado. O histórico do WABABOTAI não é importado automaticamente. Não há dependência de VPS ou Supabase para hospedar o Wabotia. Hermes e QR precisam permanecer ligados; a interface web permanece disponível quando eles estão offline.

## Licença e contribuição

MIT. Derivado das regras do WABABOTAI e de sua extensão genérica de entrada exclusiva; veja [atribuições](NOTICE). Não inclua credenciais, arquivos de clientes ou bancos em contribuições. Não há workflows GitHub Actions; execute as verificações manualmente.
