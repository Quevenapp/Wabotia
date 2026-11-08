# Wabotia

Painel de atendimento em português, com bots Hermes, WhatsApp, equipe humana pelo Telegram e API para integrações. O painel e seus dados operacionais são hospedados na sua conta Cloudflare. O Hermes continua no computador, Docker ou servidor de sua escolha.

**Instalação direta na Cloudflare, sem conta GitHub, cópia de repositório ou Deploy Hook.**

**[Instalação ilustrada](https://wabotia.queven.app/install)** · **[API interativa](https://wabotia.queven.app/api-docs)** · **[PDF](https://wabotia.queven.app/guide/wabotia-instalacao.pdf)**

## Estado da versão

Versão 0.9.0, com atendimento por linha, menus e submenus por número, bots atribuídos a uma ou várias linhas e conversas internas entre pessoas e bots. O roteador alterna novos atendimentos desde o início, prioriza franquias gratuitas e mantém conversas no mesmo número com serviço pago após a franquia, respeitando a janela de 24 horas. Web, Android e iOS usam as mesmas configurações e permissões. Mantém login móvel por token de sessão (`wabu_`), push, protocolos, mídia, voz, grupos, ligações Meta, agenda/CSV e integrações Hermes. O núcleo é testado em `workerd`, com D1, R2 e Durable Objects. A conexão de produção exige homologar **seus** perfis e canais com as respectivas credenciais. Consulte [validação e limitações](docs/VALIDACAO.md) antes de ativar o atendimento.

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

**Primeiro número na API oficial:** [passo a passo para iniciantes](docs/META-WHATSAPP.md) · [telas e requisitos no site](https://wabotia.queven.app/install#meta-whatsapp) · [caderno em PDF](https://wabotia.queven.app/guide/wabotia-meta-whatsapp.pdf).

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

## Aplicativos Android e iOS

Os aplicativos nativos em [`mobile/`](mobile) funcionam com qualquer servidor Wabotia: na primeira tela a pessoa digita o endereço da própria instalação (por exemplo `wabotia.queven.com.br` ou `wabotia.fagoo.com.br`) e entra com o e-mail e a senha cadastrados em **Pessoas**. O aplicativo recebe um token de sessão de usuário (`wabu_`), com os mesmos perfis e papel do painel, e oferece conversas, mensagens WhatsApp com mídia, ligações, protocolos, bots, presença e notificações push de mensagens, fila, transferências, protocolos e ligações.

As notificações saem do seu servidor para um gateway de push (padrão operado pela Queven; pode ser o seu) ou direto para o Firebase Cloud Messaging; o administrador escolhe em **Sistema e atualizações → Notificações dos aplicativos**, inclusive o conteúdo mínimo para não expor trechos de mensagens. Rotas, contrato do gateway, compilação e limites estão em [docs/MOBILE.md](docs/MOBILE.md).

## Agenda de contatos

Abra **Agenda de contatos** para cadastrar, buscar e editar clientes. Importe arquivos CSV UTF-8 de até 500 contatos/1 MB, conferindo erros e linhas idênticas antes de salvar. Em **Conversas → Salvar contato**, crie um cadastro ou vincule uma pessoa da agenda. Nome, telefone, e-mail, empresa e observações ficam salvos no perfil; telefones não unem clientes automaticamente. [Passo a passo com telas](docs/CONTATOS.md) · [Modelo CSV](public/modelo-contatos.csv).

## Roteador WhatsApp

Em **Roteador de números**, conecte uma WABA, adicione os números habilitados na Meta e configure um único webhook. A quantidade permitida é definida pela Meta, sem limite fixo de linhas no Wabotia. Os grupos alternam os números desde o primeiro atendimento e priorizam quem ainda possui franquia gratuita. Autorize os números/grupos de cada aplicação. A API aceita `number_id` ou `pool_id`. O atendimento mantém o remetente original e respeita a janela de 24 horas desse número. O link público distribui novos contatos entre números disponíveis, inclusive com serviço pago quando todas as franquias acabam.

Em cada cartão, **Função e permissões** permite separar a linha oficial das linhas de integração com 24 horas, ou escolher cada capacidade individualmente. Restrições do número prevalecem sobre grupos/aplicações e são conferidas novamente antes do envio. Alterar a função preserva histórico e consumo.

A franquia gratuita configurada é de até 1.000 mensagens por número/mês, conforme o [FAQ Meta](https://whatsappbusiness.com/resources/faq/) desde 01/10/2026. Ela orienta o rodízio e a estimativa de consumo; o excedente de serviço pode ser cobrado e não bloqueia o atendimento. Modelos ficam separados e exigem autorização explícita e consentimento em cada pedido. Contadores não substituem a fatura Meta. [Configuração e exemplos](docs/ROTEADOR.md) · [Guia ilustrado](https://wabotia.queven.app/install#roteador).

## Linhas, menus e equipe interna

- **Linhas de atendimento:** escolha equipe humana, bot específico ou bot padrão por número. Linhas de atendimento direto podem ficar fora dos grupos de roteamento.
- **Menus e submenus:** selecione as linhas autorizadas e apresentação automática ou quando uma pessoa ou bot chamar o menu. Submenus respeitam as restrições dos pais. Na conversa, use **Enviar menu ao cliente**.
- **Equipe Bot:** autorize todas as linhas, algumas linhas ou apenas conversas internas para cada bot.
- **Conversas internas:** pessoas e bots aparecem com disponibilidade online/offline. Mensagens internas têm histórico privado entre participantes e não são enviadas pelo WhatsApp. Conversas de clientes podem ser transferidas para pessoas ou bots, preservando seu número.

A migração aditiva `0009_service_team.sql` mantém os atendimentos e configurações existentes e acrescenta as atribuições e o histórico interno. Os recursos novos nos aplicativos exigem o servidor 0.9.0.

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
