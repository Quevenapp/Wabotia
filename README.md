# Wabotia

Painel de atendimento em português, com bots Hermes, WhatsApp, equipe humana pelo Telegram e API para integrações. O painel e seus dados operacionais são hospedados na sua conta Cloudflare. O Hermes continua no computador, Docker ou servidor de sua escolha.

Cada nova instalação cria automaticamente uma **Área de atendimento**, compartilhada pela equipe da empresa. Nela ficam telefones, conversas, bots e configurações de automação. A automação começa desativada. Instalações existentes mantêm suas áreas e permissões, sem unir dados.

**Instalação direta na Cloudflare, sem conta GitHub, cópia de repositório ou Deploy Hook.**

**[Instalação ilustrada](https://wabotia.queven.app/install)** · **[API interativa](https://wabotia.queven.app/api-docs)** · **[WhatsApp pela Zernio](docs/ZERNIO-WHATSAPP.md)**

## Estado da versão

Versão 0.14.1, em que o menu principal recebe o cliente quando não há bot, com o painel web refeito no estilo dos aplicativos e a [central de atendimento por modelo](docs/CENTRAL-ATENDIMENTO.md): prazo de protocolo em dias úteis, seis estados, categorias, abertura de protocolo pelo cliente, saudação do menu e o modelo pronto **Central de aplicativos**. Mantém o arraste para ordenar menus e mudar sua hierarquia, preservando os filhos ao mover um submenu. **Adicionar item** reúne o cadastro de ações e submenus, com explicação de cada tipo. O salvamento detecta alterações concorrentes. A Área de atendimento é automática e a configuração se organiza em Integração Zernio e Telefones. O Wabotia importa telefones já cadastrados na Zernio, consulta seus templates e contabiliza mensagens entregues por categoria, sem limites locais. O roteador alterna novos atendimentos e mantém o telefone de cada conversa, respeitando a janela de 24 horas desde a última mensagem do cliente. Inclui atendimento por linha, bots, equipe humana, conversas internas, protocolos, mídia e integrações Hermes. O núcleo é testado em `workerd`, com D1, R2 e Durable Objects. Consulte [validação e limitações](docs/VALIDACAO.md).

## Navegação e configuração guiada

O painel reúne as tarefas em **Início**, **Atendimento**, **Contatos**, **Equipe**, **Automação**, **Canais**, **Avaliações e relatórios**, **Integrações** e **Sistema**. O assistente de configuração tem um atalho próprio para orientar os primeiros passos. O **modo avançado** revela consentimentos, execuções, entregas, webhooks e detalhes técnicos, usando as mesmas configurações do modo guiado.

Em **Automação**, o Bot Atendente conversa com o cliente e consulta especialistas internos do Hermes para operações nos sistemas; as credenciais desses sistemas ficam nos especialistas. O [pareamento Vinki/Fagoo](docs/PAREAMENTO.md) usa código temporário, sem copiar tokens. As [atualizações automáticas](docs/ATUALIZACOES.md) são opcionais, com janela diária. O [JEV](docs/JEV.md) pode decidir após a interpretação do Atendente. Consulte a [matriz de capacidades e dependências externas](docs/ESCOPO-DO-PAINEL.md).

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

**WhatsApp oficial pela Zernio:** [passo a passo](docs/ZERNIO-WHATSAPP.md) · [guia no site](https://wabotia.queven.app/install#zernio-whatsapp).

1. Na área de atendimento criada automaticamente, cadastre a conexão Hermes com as URLs administrativas/API, o token administrativo e as chaves dos bots autorizados no Hermes.
2. Teste a conexão, descubra os bots, habilite os selecionados e escolha o Atendente. A API Hermes deve anunciar `features.runs_idempotency.durable`.
3. Adicione um canal WhatsApp: importe um telefone já cadastrado na Zernio; use QR pelo [conector Baileys](connectors/qr); ou WhatsApp pelo Hermes com o [transporte exclusivo](connectors/hermes).
4. Use um bot Telegram dedicado em grupo privado com tópicos. Cadastre cada atendente e seu ID Telegram. O Telegram não requer plugin no Hermes.
5. Cadastre conhecimento, menus, ações de especialistas e presença. Teste antes de ativar.

**Ferramentas do Wabotia dentro do Hermes:** a instalação publica um servidor MCP em `/api/mcp`, incluído em cada deploy na Cloudflare. Em **Integrações → Ferramentas do Wabotia no Hermes Agent (MCP)**, crie a aplicação e a chave e cole o bloco `mcp_servers` no `config.yaml` do perfil Hermes. O agente passa a consultar e responder conversas, abrir protocolos, usar a agenda e executar bots com as permissões da chave. [Detalhes e lista de ferramentas](docs/API.md#mcp-para-o-hermes-agent).

Para Hermes privado: `node scripts/connect-hermes.mjs` gera as instruções e configuração de Cloudflare Tunnel protegido por Access, para Linux, WSL2 e macOS. HTTPS público autenticado também é aceito.

Também é possível usar **Conexões → Preparar Hermes na Cloudflare**. Após ligar as APIs locais e autorizar um token Cloudflare em **Sistema e atualizações**, o painel cria Access, túnel e DNS e entrega um instalador privado para o conector. Veja [pré-requisitos, etapas e recuperação](docs/HERMES-CLOUDFLARE.md#deploy-da-configuração-pelo-painel).

## WhatsApp completo para atendimento

Receba e envie imagens, vídeos, áudio, voz, documentos, figurinhas, localização e contatos conforme o canal. Gerencie grupos pelo QR e grupos empresariais elegíveis pela Zernio. Chamadas com áudio pelo navegador não estão disponíveis na integração Zernio; o histórico de ligações anteriores é mantido. QR/Hermes não fazem chamadas e não há videochamadas. Todos esses recursos têm rotas autenticadas na API. [Guia e limites por modo](docs/WHATSAPP.md).

Atualize também o processo QR ou o transporte Hermes; o botão do painel atualiza somente a parte Cloudflare. Homologação com número real permanece pendente.

## Aplicativos Android e iOS

Os aplicativos nativos em [`mobile/`](mobile) funcionam com qualquer servidor Wabotia: na primeira tela a pessoa digita o endereço da própria instalação (por exemplo `wabotia.queven.com.br` ou `wabotia.fagoo.com.br`) e entra com o e-mail e a senha cadastrados em **Pessoas**. O aplicativo recebe um token de sessão de usuário (`wabu_`), com os mesmos acessos e papel do painel, e oferece conversas, mensagens WhatsApp com mídia, ligações, protocolos, bots, presença e notificações push de mensagens, fila, transferências, protocolos e ligações.

As notificações saem do seu servidor para um gateway de push (padrão operado pela Queven; pode ser o seu) ou direto para o Firebase Cloud Messaging; o administrador escolhe em **Sistema e atualizações → Notificações dos aplicativos**, inclusive o conteúdo mínimo para não expor trechos de mensagens. Rotas, contrato do gateway, compilação e limites estão em [docs/MOBILE.md](docs/MOBILE.md).

## Agenda de contatos

Abra **Agenda de contatos** para cadastrar, buscar e editar clientes. Importe arquivos CSV UTF-8 de até 500 contatos/1 MB, conferindo erros e linhas idênticas antes de salvar. Em **Conversas → Salvar contato**, crie um cadastro ou vincule uma pessoa da agenda. Nome, telefone, e-mail, empresa e observações ficam salvos na área de atendimento; telefones não unem clientes automaticamente. [Passo a passo com telas](docs/CONTATOS.md) · [Modelo CSV](public/modelo-contatos.csv).

## Roteador WhatsApp

Em **Integração Zernio**, salve o **ID da integração na Zernio** (campo técnico Profile ID) e a API key, conecte o WhatsApp pela Zernio, importe os telefones e configure um único webhook na Zernio. A quantidade permitida é definida pela Meta, sem limite fixo de linhas no Wabotia. Os grupos alternam os telefones desde o primeiro atendimento e priorizam linhas com saldo na cota local. Autorize os telefones/grupos de cada aplicação. A API aceita `number_id` ou `pool_id`. O atendimento mantém o remetente original e respeita a janela de 24 horas desse telefone. O link público distribui novos contatos entre telefones disponíveis e respeita o bloqueio de excedentes configurado por linha.

Em cada cartão, **Função e permissões** permite separar a linha oficial das linhas de integração com 24 horas, ou escolher cada capacidade individualmente. Restrições do número prevalecem sobre grupos/aplicações e são conferidas novamente antes do envio. Alterar a função preserva histórico e consumo.

Não há limite local de mensagens. O painel mostra mensagens entregues no mês por categoria: atendimento na janela de 24 horas, atendimento por template e marketing por template. A última mensagem recebida do cliente renova a janela no mesmo telefone; o painel mostra seu vencimento. Os templates cadastrados na Zernio podem ser consultados dentro do Wabotia. Templates continuam exigindo autorização e consentimento. [Configuração e exemplos](docs/ROTEADOR.md) · [Tarifas Zernio](https://docs.zernio.com/platforms/whatsapp/pricing).

**Excluir telefones:** em Telefones ou Conexões, use **Excluir telefone**. O histórico é preservado; mensagens ainda na fila serão canceladas. Envios em andamento ou sem confirmação e ligações abertas devem ser resolvidos antes. Isso não cancela a conta no provedor. Linhas da integração Meta anterior são pausadas na atualização e precisam ser conectadas novamente pela Zernio.

## Linhas, menus e equipe interna

- **Linhas de atendimento:** escolha equipe humana, bot específico ou bot padrão por número. Linhas de atendimento direto podem ficar fora dos grupos de roteamento.
- **Menus e submenus:** use **Adicionar item**, escolhendo ação ou submenu. Arraste pela alça para ordenar ou mudar de nível; os filhos acompanham o submenu movido. Selecione as linhas autorizadas e a apresentação automática ou manual; os filhos respeitam as restrições dos pais. Ramos vazios não aparecem no atendimento. **VOLTAR** sobe um nível e **MENU** abre o principal. Na conversa, use **Enviar menu ao cliente**.
- **Equipe Bot:** autorize todas as linhas, algumas linhas ou apenas conversas internas para cada bot.
- **Conversas internas:** pessoas e bots aparecem com disponibilidade online/offline. Mensagens internas têm histórico privado entre participantes e não são enviadas pelo WhatsApp. Conversas de clientes podem ser transferidas para pessoas ou bots, preservando seu número.

As migrações aditivas `0010` a `0013` acrescentam pareamento, trava de atualizações, setores/menus e registro JEV. Aplique-as antes de publicar o Worker. Protocolos e atendimentos anteriores são preservados. Veja [menus interativos, setores e consulta de protocolos](docs/MENUS-PROTOCOLOS.md). O pareamento exige a implantação coordenada dos clientes Vinki e Fagoo descrita no guia.

## API

REST/JSON em `/api/v1`, OpenAPI 3.1 em `/api/openapi.json`. Cada integração tem identidade própria, permissões de acesso à área de atendimento e bots autorizados. Chaves Bearer são exibidas na emissão, persistidas como hash e podem expirar, ser rotacionadas ou revogadas. Recibos de operações que devolvem secrets são criptografados.

As escritas operacionais exigem `Idempotency-Key`; o pareamento usa códigos de uso único e transições atômicas próprias. Execuções de bots retornam `202` e são acompanhadas por consulta ou webhooks HMAC. Timeouts sem confirmação exigem reconciliação; não iniciam outra execução automaticamente. [Exemplos cURL, JavaScript e Python](docs/API.md).

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
