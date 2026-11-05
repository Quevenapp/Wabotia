# Instalar o Wabotia, passo a passo

Este guia instala o painel na **sua conta Cloudflare**. O computador só precisa ficar ligado se nele estiverem Hermes, o túnel ou o conector QR. Não há servidor Wabotia para instalar em VPS e não é necessário Supabase.

O [PDF ilustrado](https://wabotia.queven.app/guide/wabotia-instalacao.pdf) reúne telas reais sem credenciais e referências de preenchimento identificadas. Os nomes de menus da Cloudflare podem aparecer em inglês. Esta edição cobre a versão 0.2.0: valide os seus canais antes de atender clientes, conforme [VALIDACAO.md](VALIDACAO.md).

Já instalou? Use [Atualizar Wabotia pelo painel](ATUALIZACOES.md). Para preparar o acesso ao Hermes, veja o [deploy da configuração Cloudflare pelo painel](HERMES-CLOUDFLARE.md#deploy-da-configuração-pelo-painel): ele cria Access, túnel e DNS após a preparação das APIs locais.

## 1. Primeiro, vincule a Cloudflare ao GitHub

Para instalar pelo botão **Deploy to Cloudflare**, faça a vinculação **antes de abrir o botão do Wabotia**. Se sua conta GitHub já aparece na lista **Git account** da Cloudflare, a conexão está feita; siga para os requisitos dos serviços abaixo. Se escolher o instalador pelo terminal (opção B), essa vinculação não é necessária.

1. Entre na [Cloudflare, em Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages), e selecione a conta onde vai instalar o Wabotia.
2. Clique em **Create application / Criar aplicativo** e escolha **GitHub**. Dependendo da tela, a opção fica em **Import a repository / Importar repositório**.
3. Clique em **Connect GitHub / Conectar GitHub** ou **+ Add account / Adicionar conta**. Entre no GitHub, escolha a conta ou organização que receberá sua cópia e autorize o aplicativo **Cloudflare Workers and Pages**. Confira a conta e o acesso aos repositórios solicitado antes de confirmar.
4. Volte à Cloudflare e confirme que sua conta aparece em **Git account**. A vinculação está concluída. Volte ao site Wabotia, confira os requisitos abaixo e depois gere as chaves para continuar com o botão específico do projeto; não é preciso publicar um projeto vazio nesse assistente.

**A tela fechou depois de autorizar pelo botão de deploy?** Isso pode acontecer na primeira vinculação. Volte a [wabotia.queven.app/install](https://wabotia.queven.app/install) e clique novamente em **Deploy to Cloudflare**. Escolha a conta GitHub já vinculada e continue. A autorização do GitHub, por si só, ainda não significa que o Wabotia foi instalado. Se a conta não aparecer, confira se está na mesma conta Cloudflare e conclua **Adicionar conta** antes de tentar o deploy novamente.

### Antes do deploy: para que serve cada serviço da Cloudflare

A Cloudflare é a plataforma que mantém o Wabotia disponível na internet e guarda seus dados. Os serviços trabalham juntos, mas a ativação de um não habilita automaticamente todos os outros.

| Serviço | Para que serve no Wabotia | O que você prepara |
|---|---|---|
| **Workers** | Executa o painel web, a API e as regras do atendimento. | Escolha o plano da conta. Workers Paid é a referência de produção do projeto. |
| **D1** | Banco de dados: guarda usuários, configurações, conversas, protocolos e registros. | Confira acesso ao D1. O deploy cria ou conecta o banco exclusivo da instalação. |
| **R2** | Armazena documentos, imagens, áudios e outros anexos. Uma pasta de armazenamento é chamada de *bucket*. | Ative a assinatura R2 e use um bucket privado. |
| **Durable Objects e alarmes** | Coordenam as conversas e os trabalhos pendentes, preservando ordem e evitando operações duplicadas. Os alarmes retomam tarefas agendadas. | O deploy configura esses recursos. Não precisa criar um servidor nem contratar cada alarme. |
| **Zero Trust** | Área da Cloudflare para administrar a segurança do acesso ao Hermes. | Ative um plano, como Zero Trust Free, antes de configurar o Access. |
| **Access** | Verifica se a chamada ao Hermes vem do Wabotia autorizado. | Cadastre aplicações e políticas Service Auth; crie Client ID/Client Secret para a conexão. |
| **Tunnel e cloudflared** | Fazem a ponte da Cloudflare até a máquina do Hermes sem abrir portas no roteador. cloudflared é o programa instalado nessa máquina. | Crie o túnel e mantenha cloudflared e Hermes ligados. |
| **DNS** | Liga nomes como `api-hermes.seudominio.com` ao destino correto. | Use domínio ativo na Cloudflare para os hostnames do túnel e confira os registros criados. |
| **Workers Builds** | Busca o código no GitHub, prepara e publica o aplicativo pelo botão de deploy. | Vincule o GitHub antes do botão. Esse serviço é separado do GitHub Actions. |
| **Workers Secrets** | Guardam as chaves de instalação no ambiente protegido do Worker. | Preencha MASTER_KEY e SETUP_TOKEN sem publicar os valores no GitHub. |

**Exemplo de uma conversa:** a mensagem chega ao Worker, o registro vai para o D1 e os anexos para o R2. Durable Objects organizam o processamento. Quando um bot é necessário, o Worker usa Access + Tunnel para chegar ao Hermes, que executa o modelo no computador ou na VPS.

### Requisito 1 - Ative a assinatura R2, mesmo com franquia gratuita

1. Na conta Cloudflare da instalação, abra **Armazenamento e bancos de dados > R2 > Visão geral** (*Storage & databases > R2 > Overview*).
2. Se aparecer a adesão ao serviço, conclua a ativação da assinatura R2. Confira os termos e valores e preencha os dados de cobrança que a Cloudflare solicitar. A franquia gratuita não dispensa a adesão.
3. Confirme que você consegue acessar a lista de buckets ou o botão **Criar bucket**. Esse é o sinal de que o serviço está disponível para o deploy.
4. Você pode criar antes um bucket privado chamado `wabotia-media` e selecioná-lo no formulário. Se o bucket dessa instalação já existe, use-o; não habilite acesso público.

R2 tem uma franquia mensal gratuita e cobrança conforme o uso excedente. Confira a [ativação oficial do R2](https://developers.cloudflare.com/r2/get-started/) e os [preços vigentes](https://developers.cloudflare.com/r2/pricing/) antes de confirmar.

### Requisito 2 - Confira D1 e o plano Workers

1. Abra **Armazenamento e bancos de dados > Banco de dados SQL D1**. Confira que consegue abrir a lista e encontrar **Criar banco de dados**.
2. **D1 já está incluído nos planos Workers Free e Paid.** Ele não exige uma assinatura separada equivalente à adesão do R2; limites e eventuais cobranças dependem do plano Workers. Consulte os [planos oficiais do D1](https://developers.cloudflare.com/d1/platform/pricing/).
3. O deploy do Wabotia cria ou conecta o banco. Não é preciso criar um banco de teste para habilitar o serviço. Se já instalou o Wabotia, confira o banco existente em **Worker > Bindings > DB**, sem criar outro para substituí-lo.
4. Para produção, prepare **Workers Paid** conforme a referência do projeto. Confira o plano e as condições na área de assinatura do Workers. Uma assinatura Zero Trust Free ou um plano do site/domínio não muda automaticamente o plano Workers.

O Worker usa as ligações **DB** e **MEDIA** criadas no deploy para acessar D1 e R2. Você não precisa gerar chaves D1 nem credenciais S3/R2 para colocar no painel Wabotia.

### Requisito 3 - Ative Zero Trust antes do Hermes privado

1. Para seguir o caminho **Tunnel + Access**, abra **Zero Trust > Controles de acesso > Aplicativos**. Se aparecer a apresentação, clique **Começar** e conclua a ativação do plano escolhido. O **Zero Trust Free** atende esta configuração inicial.
2. Confira os termos e eventuais informações de cobrança mesmo selecionando o plano gratuito. Se pedir nome de equipe, escolha um disponível.
3. Confirme que consegue acessar **Aplicativos** e **Credenciais de serviço**. Se já consegue, não precisa repetir a adesão.
4. Depois de ativar o plano, ainda será necessário criar o Service Token, as políticas Access e o túnel. O [roteiro Hermes + Cloudflare](HERMES-CLOUDFLARE.md#d-cloudflare-access-chave-e-proteção-antes-do-túnel) mostra esses campos.

O plano Zero Trust é separado de Workers e R2. Um Hermes com HTTPS autenticado já acessível ao Worker pode dispensar Tunnel + Access; este guia usa essa proteção para Hermes local/privado.

### Confira os requisitos antes de gerar as chaves

- [ ] Conta correta selecionada e GitHub visível em **Git account**, para instalar pelo botão.
- [ ] R2 ativado: lista de buckets ou **Criar bucket** disponível.
- [ ] D1 disponível: lista de bancos e **Criar banco de dados** acessíveis.
- [ ] Plano Workers conferido para o uso pretendido.
- [ ] Zero Trust ativado para o caminho privado: **Aplicativos** e **Credenciais de serviço** acessíveis.
- [ ] Domínio ativo na Cloudflare para os hostnames do túnel.
- [ ] Hermes funcionando, com modelo e provedor configurados; não apagar os bots existentes.
- [ ] Número de teste e, se usar Telegram, bot dedicado e grupo privado com tópicos.

Só depois continue. **Gratuito significa uso dentro dos limites do serviço**, não consumo ilimitado nem dispensa de adesão. Se já ativou ou instalou algum item, confira o existente em vez de contratar novamente.

### Agora, gere e guarde as duas chaves do Wabotia

Tenha um gerenciador de senhas ou local privado para guardar `MASTER_KEY` e `SETUP_TOKEN`. O [gerador do site](https://wabotia.queven.app/install#chaves) cria as duas para você, com 64 caracteres aleatórios cada.

`MASTER_KEY` permite ler as credenciais criptografadas do seu banco. `SETUP_TOKEN` autoriza a criação da primeira conta. A senha do administrador é uma terceira informação, escolhida por você.

**Como gerar e guardar:** no site, clique em **Gerar minhas duas chaves**. Use **Copiar MASTER_KEY** e **Copiar SETUP_TOKEN** para preencher os campos de mesmo nome na Cloudflare. Guarde as duas em seu gerenciador de senhas ou clique em **Baixar minhas chaves (.txt)** e proteja o arquivo. Depois do deploy, anote junto delas a URL da instalação. A geração acontece só no navegador; o site não recebe nem salva os valores. Atualizar ou fechar a página apaga o par da tela. O botão Deploy abre outra aba para você poder voltar e copiar.

O gerador é para uma **nova instalação**. Se já instalou, preserve as chaves originais, especialmente MASTER_KEY. Se escolher o instalador pelo terminal (opção B), ele gera e salva as duas automaticamente; não precisa usar o gerador do site.

## 2. Escolha uma forma de publicar

### Opção A - Botão Deploy to Cloudflare

1. Com GitHub vinculado e os requisitos R2, D1, Workers e Zero Trust conferidos, abra [wabotia.queven.app/install](https://wabotia.queven.app/install), gere e guarde as duas chaves conforme explicado acima. Depois clique em **Deploy to Cloudflare**; o formulário abre em outra aba.
2. Entre na sua conta Cloudflare. Confira que o projeto de origem é `Quevenapp/Wabotia`.
3. Escolha sua conta e a conta GitHub onde ficará a cópia. Dê um nome ao projeto, por exemplo `meu-atendimento`. Autorize somente o repositório necessário.
4. Confira os recursos sugeridos: banco D1, bucket R2 e Durable Object. O provisionamento é automático. Mantenha o bucket privado.
5. Preencha os secrets `MASTER_KEY` e `SETUP_TOKEN` com os valores que guardou. Eles são secrets do Worker; não são variáveis `VITE_*` nem arquivos para enviar ao GitHub.
6. Em **Build command**, mantenha `npm run build`. Em **Deploy command**, mantenha `npm run deploy`. Esse comando publica e aplica as migrações do banco usando a ligação `DB`.
7. Desative Enable Preview builds até configurar recursos isolados para testes. Clique em publicar e aguarde a indicação de sucesso. Guarde a URL `https://seu-projeto.sua-conta.workers.dev`. Se ela não abrir, vá ao Worker > Settings > Domains & Routes (Domínios e rotas) e habilite o endereço `workers.dev` de produção se estiver desativado.
8. Em Workers & Pages > seu Worker > Settings > Variables and Secrets, confira apenas a existência dos dois secrets. Se a tela inicial não os solicitou, adicione-os com tipo **Secret** e publique a alteração.
9. Abra **a URL da sua instalação**, acrescente `/app` e continue na etapa 3.

O botão usa Cloudflare Builds. Não precisa de GitHub Actions. Na cópia do repositório, você também pode abrir Settings > Actions > General e selecionar **Disable actions**. O repositório original Quevenapp/Wabotia já mantém Actions desativado.

O botão foi validado com uma instalação real, incluindo banco, mídias, migrações e primeiro administrador. Se o assistente falhar ao provisionar R2, abra Armazenamento e bancos de dados > R2 > Criar bucket, crie `wabotia-media` privado e volte ao deploy para selecionar o bucket existente. Se houver erro interno antes de criar qualquer recurso, confira a vinculação GitHub, volte ao botão e tente novamente usando o R2 já preparado; um erro interno isolado não permite determinar sua causa. Se o banco estiver vazio porque o comando de deploy foi alterado, use a opção B ou, numa cópia local da configuração com os IDs do seu Worker, rode `npx wrangler d1 migrations apply DB --remote`. Não crie um segundo atendimento para resolver uma migração pendente.

### Opção B - Instalador pelo terminal

É outra forma de publicação validada nesta versão. Os comandos são iguais em Linux, macOS e Windows/WSL2.

1. Instale [Node.js LTS](https://nodejs.org/) (22.13 ou superior; preferencialmente 24 LTS) e [Git](https://git-scm.com/downloads).
2. Windows: abra o Ubuntu no WSL2; macOS: abra Terminal; Ubuntu/Linux: abra Terminal. No Windows também é possível usar PowerShell com Node e Git instalados.
3. Cole **uma linha de cada vez**, pressionando Enter:

```sh
git clone https://github.com/Quevenapp/Wabotia.git
cd Wabotia
npm ci
npx wrangler login
npm run setup
```

4. O login abre o navegador: selecione a mesma conta Cloudflare. Volte ao terminal quando ele indicar que o acesso foi concluído.
5. O instalador cria Worker, D1, R2 e Durable Object, prepara o banco e gera os secrets sem mostrá-los no terminal. Não fecha nem reconfigura seu Hermes.
6. Abra o arquivo **`.secrets.production.local.json`** na pasta Wabotia em um editor. Arquivos iniciados por ponto podem estar ocultos. Copie somente o valor de `SETUP_TOKEN` quando o painel pedir. Guarde o arquivo em local protegido.
7. Abra a URL informada pelo instalador com `/app` no final.

Para uma instalação de teste separada: `npm run setup -- --environment staging`. Para usar domínio próprio desde a primeira instalação: `npm run setup -- --domain painel.seudominio.com`. O domínio precisa estar na mesma conta Cloudflare. Se já existir uma instalação, mantenha os arquivos `wrangler.*.local.json` e `.secrets.*.local.json`; eles identificam e protegem seus recursos.

Não execute novamente o instalador sobre uma implantação feita pelo botão com secrets diferentes. Para administrar uma instalação já existente, baixe a configuração correspondente e use seus IDs e a MASTER_KEY original.

## 3. Crie a conta e o perfil de atendimento

1. Na sua URL `/app`, preencha nome, e-mail, senha de pelo menos 12 caracteres e código `SETUP_TOKEN`.
2. Clique **Criar conta e entrar**. O código inicial não cria outras contas depois que o administrador existe.
3. Clique **Criar perfil de atendimento** ou no botão **+** ao lado do seletor de perfil. Exemplo de nome: `Atendimento da loja`.
4. Mantenha o atendimento pausado enquanto prepara os serviços.
5. Em **Pessoas**, adicione uma conta para cada atendente e marque os perfis autorizados. Evite compartilhar uma única conta. A edição permite alterar nome, perfis, identidade Telegram e senha; a desativação encerra o acesso.

## 4. Ligue a API do Hermes, mesmo se estiver desligada

Siga o [roteiro completo Hermes + Cloudflare](HERMES-CLOUDFLARE.md). Ele mostra onde abrir o terminal, como criar o perfil `wabotia`, gerar e guardar as chaves, habilitar a API, iniciar os serviços e testar. Há caminhos separados para **Ubuntu/Linux/WSL2/macOS nativo** e **VPS Ubuntu com Docker**, preservando o Hermes existente.

O assistente `python3 scripts/prepare-hermes.py --profile wabotia --create-profile` faz backup e configura a API nativa. Ele não inicia serviços sozinho. O manual mostra os comandos de início, reinício e diagnóstico, inclusive quando a API é desligada depois. Dois serviços precisam responder: backend administrativo na 9119 e API dos bots na 8642, ambos autenticados e restritos ao loopback. Use `--check` para verificar os dois antes de abrir um túnel.

As chaves Hermes geradas ficam em `~/.config/wabotia/hermes/chaves.local.txt`. Elas são adicionais às chaves de instalação do Wabotia. Não substitua MASTER_KEY/SETUP_TOKEN. Não copie credenciais dos canais de outro bot.

## 5. Configure a Cloudflare para alcançar o Hermes

O [roteiro ilustrado, etapas C a E](HERMES-CLOUDFLARE.md#c-cloudflare-domínio-e-zero-trust), detalha a sequência:

1. Confirmar domínio ativo e ativar Zero Trust, caso ainda não esteja disponível.
2. Criar Service Token e guardar o par Client ID/Client Secret.
3. Criar duas aplicações Access Self-hosted, com política Service Auth limitada a esse token.
4. Criar um túnel novo, instalar cloudflared na máquina do Hermes e aguardar o estado Íntegro.
5. Publicar somente `/api/profiles` no hostname administrativo e `/p/wabotia/v1/…` no hostname dos bots, com portas e HTTP Host Header conforme a tabela do roteiro.
6. Conferir os registros DNS criados, testar a proteção e cadastrar as URLs e chaves no Wabotia.

O manual também explica como instalar um serviço cloudflared separado se já existir outro túnel na máquina. Não sobrescreva o túnel existente. Não abra portas no roteador e não publique todas as rotas do painel Hermes.

O assistente alternativo `node scripts/connect-hermes.mjs` gera um YAML para túnel gerenciado localmente. Ele não liga a API. Use esse caminho somente se preferir administrar o YAML; não misture os comandos de túnel local com o túnel gerenciado pelo dashboard.

O computador precisa permanecer ligado enquanto hospedar Hermes e túnel. Se ele dormir, o painel Wabotia continua disponível, mas os bots ficam offline; o atendimento humano permanece nos canais ainda conectados.

## 6. Conecte e escolha a Equipe Bot

1. Wabotia > **Conexões > Nova conexão**. Selecione **Hermes**, dê um nome e preencha as URLs HTTPS administrativa e da API.
2. Cole o token administrativo e a `API_SERVER_KEY` de cada perfil. Abra **Conexão protegida por Cloudflare Access** e preencha o Client ID e Client Secret criados na Cloudflare. Para vários perfis, o campo JSON aceita um mapa `{"atendente":"CHAVE","financeiro":"OUTRA_CHAVE"}`. Essas chaves são exemplos; insira seus valores somente no painel. Máximo de 20 perfis por conexão.
3. Salve, clique **Testar conexão** e **Descobrir bots**. A verificação exige idempotência durável anunciada pelo Hermes.
4. Ative a conexão. Em **Equipe Bot**, habilite os bots autorizados e selecione o **Atendente**.
5. Crie ações de especialistas: informe qual bot consultar, em que condição e qual ação ele pode executar. Os perfis não recebem permissão para chamar outros especialistas livremente.
6. Em **Conhecimento**, cadastre texto, URL pública, PDF com texto, DOCX ou legendas autorizadas. Vídeos exigem legendas públicas; a importação não contorna restrições da plataforma. Arquivos: até 20 MB.
7. Em **Menus e preferências**, escolha o modo de resposta, prazo, avaliações, menus e instruções. Aplicativos/menus avançados podem ser editados em JSON. JEV é opcional e usa uma chave no backend.

Arquivos produzidos por bots precisam ser exportados como artefatos da API nativa e retornar IDs em `files`. Um caminho local no texto não vira um download. A API de artefatos é de uso único: um download interrompido sem confirmação exige nova exportação no Hermes.

## 7. Escolha um modo WhatsApp por número

### Meta direto no Worker

1. Na Meta, prepare uma aplicação WhatsApp Business, número de teste, token com as permissões necessárias, Phone Number ID, WABA ID e App Secret.
2. Em Conexões, selecione **WhatsApp · API oficial Meta**. Preencha número com DDI (somente dígitos), IDs e tokens. Crie um Verify Token aleatório.
3. Salve. Copie o endereço de webhook exibido (`SUA_URL/webhooks/meta/ID_DA_CONEXAO`). Na aplicação Meta, cadastre essa URL e o mesmo Verify Token; assine os eventos `messages`.
4. Teste a conexão, ative-a e use o número de teste autorizado no painel Meta.
5. Fora da janela de atendimento de 24 horas, notificações exigem consentimento e um template **UTILITY aprovado**, no idioma configurado. Nesta versão o corpo deve usar `{{1}}` para protocolo e `{{2}}` para andamento. Templates com outros componentes/formato não são liberados automaticamente.

Neste modo, o Worker recebe o WhatsApp e usa as APIs nativas Hermes; não há plugin Wabotia no Hermes.

### QR direto, ao lado do Hermes

1. Cadastre **WhatsApp · QR direto**, com o número correto. Salve e emita a **chave do conector**. Guarde também o ID da conexão.
2. No host que ficará ligado (pode ser o do Hermes), abra `connectors/qr`, copie `.env.example` para `.env` e preencha URL, ID e chave. Não envie esse arquivo ao GitHub.
3. Com Node 22.13+ instalado, execute `npm ci` e `npm start` nessa pasta. O processo usa somente conexões HTTPS de saída; não requer abrir porta nem túnel.
4. Ative a conexão no painel. Abra a conexão para ver o QR, vá em **Aparelhos conectados** no WhatsApp e leia o código. Use um número reservado ao teste.
5. Mantenha a pasta `data/`: contém sessão e diário de entregas. Não apague para resolver timeout. Configure supervisão/reinício do processo e backup com ele parado.

Para Docker, use o Dockerfile/Compose em `connectors/qr` conforme seu README. O processo é externo ao Worker; desligá-lo interrompe esse canal. Baileys é um cliente não oficial e precisa ser revalidado quando o WhatsApp mudar.

### WhatsApp já configurado no Hermes

Meta/QR continuam configurados no Hermes. Instale somente o transporte mínimo descrito em [connectors/hermes/README.md](../connectors/hermes/README.md). Ele exige a extensão compatível de entrada exclusiva no gateway: mantém o canal sob um único consumidor e entrega suas mensagens ao Wabotia. Não instala o painel no Hermes.

Antes de trocar de modo: pause o canal antigo, pare seu consumidor, confira entregas em **Entregas**, resolva estados `unknown` e só então ative o novo. O Wabotia recusa dois modos ativos para o mesmo número. Também confira que não existe consumidor antigo fora do Wabotia.

## 8. Telegram para a equipe, sem plugin Hermes

1. No Telegram, abra **@BotFather**, use `/newbot` e crie um bot exclusivo para o Wabotia. Guarde o token. Não reutilize um bot que esteja ligado ao gateway Hermes.
2. Crie um **grupo privado**, ative **Tópicos** e adicione o bot como administrador, com permissão de gerenciar tópicos e enviar mensagens/anexos.
3. Obtenha o ID numérico do grupo (normalmente começa com `-100`). Você pode conferir pelo Bot API `getUpdates` antes de configurar o webhook; evite bots terceiros para ler dados do seu grupo.
4. Wabotia > Conexões > **Telegram**: informe token e ID do grupo. Salve, **Teste a conexão**, clique **Ligar recebimento Telegram** e ative.
5. Em Menus e preferências, cole o ID da conexão Telegram e informe o mesmo grupo da equipe.
6. No grupo, cada pessoa envia `/identificar`. Cadastre o ID retornado na conta correspondente em **Pessoas**. Vincule somente o ID verificado daquela pessoa.
7. Envie `/presente`. No tópico de uma conversa, use `/assumir` antes de responder. Comandos: `/responder texto`, `/nota texto`, `/transferir ID`, `/encerrar`, `/retomar`, `/ausente` e `/ajuda`.
8. No modo **por comando**, texto comum vira nota interna. No modo **direto**, o responsável pode responder sem `/responder`, conforme as regras de resposta do tópico. Teste anexos com legenda e a transferência antes de usar com clientes.

O Worker recebe o webhook Telegram e executa as regras. Nenhum plugin Telegram é instalado no Hermes.

## 9. Conecte seus outros sistemas

1. Abra **API e integrações > Nova aplicação**.
2. Dê um nome, marque os perfis, as operações e os bots permitidos. Selecione só o que o sistema precisa.
3. Clique **Gerar chave** e defina a validade. Copie o valor exibido uma vez para o backend do seu sistema.
4. Use a [documentação interativa](/api-docs) da sua própria instalação e os [exemplos](API.md). A chave não deve aparecer no JavaScript público de um site.
5. Para eventos, cadastre uma URL HTTPS de webhook e guarde o segredo de assinatura. **Webhooks** mostra as entregas e oferece reenvio. O destinatário precisa verificar HMAC e deduplicar IDs.
6. Para rotação, crie outra chave, atualize o sistema integrador e revogue a anterior. Desativar a aplicação interrompe suas chaves.

## 10. Teste antes de abrir o atendimento

Use pessoas e números de teste autorizados. Confira: pergunta com fonte, ausência da equipe, protocolo/prazo, presença, tomada humana durante uma resposta lenta, nota interna, transferência, anexo, consentimento, avaliação, webhook repetido, recuperação depois de desligar o Hermes/QR e troca pausada de modo.

Abra **Execuções** e **Entregas** para conferir erros. Em `unknown`, primeiro descubra o que ocorreu no canal/Hermes: o botão de reconciliação registra a confirmação; não inventa um resultado. Não repita uma mensagem só porque a tela demorou.

Após validar, ative **Atendimento** em Menus e preferências. Guarde os arquivos locais e faça um [backup](OPERACAO.md). Para ajuda técnica, envie apenas o ID da requisição e o erro sanitizado, nunca tokens ou conversas de clientes.

## Referências oficiais

- [Deploy to Cloudflare](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [Vinculação GitHub e Cloudflare Workers](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/)
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/)
- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)
- [Service tokens do Access](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
- [Hermes API Server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server)
- [Telegram Bot API](https://core.telegram.org/bots/api)
