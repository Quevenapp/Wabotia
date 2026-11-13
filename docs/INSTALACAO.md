# Instalar o Wabotia, passo a passo

Este guia instala o painel na **sua conta Cloudflare**. O computador só precisa ficar ligado se nele estiverem Hermes, o túnel ou o conector QR. Não há servidor Wabotia para instalar em VPS e não é necessário Supabase.

O [guia online](https://wabotia.queven.app/install) reúne o fluxo atual de instalação e conexão pela Zernio. PDFs de versões anteriores são apenas referência histórica. Valide os seus canais antes de atender clientes, conforme [VALIDACAO.md](VALIDACAO.md).

Para conectar o WhatsApp oficial, siga [WhatsApp pela Zernio](ZERNIO-WHATSAPP.md). A Zernio intermedeia a Meta usando API key, Profile ID e webhook.

Já instalou? Use [Atualizar Wabotia pelo painel](ATUALIZACOES.md). Para preparar o acesso ao Hermes, veja o [deploy da configuração Cloudflare pelo painel](HERMES-CLOUDFLARE.md#deploy-da-configuração-pelo-painel): ele cria Access, túnel e DNS após a preparação das APIs locais.

## Antes de começar: instale o Node.js e o npm

**Node.js executa o instalador do Wabotia; npm vem junto e baixa as ferramentas necessárias.** Você pode fazer a instalação a partir do seu computador ou do terminal de uma VPS Ubuntu, inclusive da Hostinger. O painel será publicado na Cloudflare. Se fizer pela VPS, a pasta privada com as chaves ficará na VPS.

Escolha **um** dos caminhos abaixo. Faça as etapas do Node.js e do instalador Wabotia no **mesmo terminal e com o mesmo usuário**. A instalação por NVM pertence ao usuário: instalar como `root` não disponibiliza automaticamente Node.js para o usuário `hermes`.

### Ubuntu na VPS Hostinger, no computador ou no WSL2

**1. Abra o terminal correto.**

- Na Hostinger: abra **VPS**, selecione seu servidor e procure **Terminal** ou **Terminal do navegador**. Use o terminal do Ubuntu da VPS, **fora do contêiner Docker do Hermes**.
- No Ubuntu do computador: abra **Terminal**.
- No Windows com WSL2: abra o aplicativo **Ubuntu** pelo menu Iniciar. Os comandos desta seção vão dentro dele.

Digite e pressione Enter:

```sh
whoami
```

Se a resposta for `root`, use os comandos sem sudo. Se aparecer outro nome, use a alternativa com sudo. Cole uma linha de cada vez e espere o nome do usuário reaparecer antes da próxima. Copie apenas os comandos, sem o prefixo `root@servidor:~#`.

**2. Prepare os pacotes do Ubuntu, incluindo a biblioteca que o Node.js precisa.**

Se `whoami` respondeu **root** (comum na VPS Hostinger):

```sh
apt-get update
apt-get install -y ca-certificates curl git libatomic1
```

Se respondeu **outro nome**, com permissão administrativa:

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl git libatomic1
```

Use somente a alternativa correspondente ao seu usuário. A senha pedida por sudo é a do Ubuntu e não aparece enquanto você digita. `libatomic1` evita o erro `libatomic.so.1: cannot open shared object file`. Se a preparação terminar com erro, corrija antes de avançar.

**3. Instale o gerenciador NVM e o Node.js LTS.**

Execute uma linha de cada vez no mesmo terminal. O primeiro comando baixa e executa o instalador do [repositório oficial do NVM](https://github.com/nvm-sh/nvm/tree/v0.41.0). LTS é a versão com suporte prolongado. Não use sudo nestas linhas:

```sh
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.41.0/install.sh | bash
source "$HOME/.nvm/nvm.sh"
nvm install --lts
nvm alias default 'lts/*'
nvm use --lts
```

O download pode levar alguns minutos. Copie a linha `source` inteira, com as **duas aspas**. Se o NVM informar que já está instalado, continue com as linhas seguintes.

**4. Confira que Node.js e npm abrem sem erro.**

```sh
node -v
npm -v
```

Exemplo de resultado: `v26.13.0` e `11.20.0`. Esses números são uma referência de 05/11/2026 e podem mudar. O Wabotia exige **Node.js 22.13 ou superior e npm**. Só avance quando os dois comandos mostrarem suas versões sem erro. Depois siga para a conta Cloudflare e execute o instalador Wabotia nesse mesmo terminal, sem sudo.

### Se deu erro na instalação do Node.js

| Mensagem ou sintoma | Como resolver |
|---|---|
| `libatomic.so.1: cannot open shared object file` | O Node.js foi instalado, mas falta uma biblioteca do Ubuntu. Repita a etapa 2, conforme seu usuário, e teste `node -v` e `npm -v`. Não precisa apagar Node.js ou Wabotia. |
| `nvm: command not found` ou `node: command not found` no Ubuntu | Entre com o mesmo usuário da instalação. Execute `source "$HOME/.nvm/nvm.sh"` e `nvm use --lts`. Se o arquivo não existir, repita a etapa 3. |
| O terminal ficou mostrando somente `>` | Geralmente faltou fechar uma aspa. Pressione **Ctrl+C** e cole novamente o comando inteiro, sem retirar as aspas. |
| Falta de permissão no `apt-get` | Confira `whoami`. Usuário comum precisa de sudo; root não precisa. Se sua conta não puder usar sudo, use uma conta administradora. |
| `node` não reconhecido no Windows ou Mac | Termine o instalador gráfico, feche a janela antiga do terminal e abra uma nova. |
| PowerShell bloqueou `npm.ps1` | Confira com `npm.cmd -v`. Esse comando usa o executável do npm instalado. |

### Windows sem WSL2

1. Abra o [site oficial do Node.js](https://nodejs.org/en/download). Selecione a versão **LTS** e **Windows**.
2. Baixe **Windows Installer (.msi)**. Em um computador Intel/AMD comum, use **x64**; use ARM64 somente se o seu computador for ARM. Não copie os comandos Linux/NVM exibidos no site.
3. Abra o arquivo baixado e avance pelo assistente, mantendo **npm** e a configuração de **PATH** nas opções padrão. Conclua a instalação.
4. Feche terminais antigos e abra uma nova janela de **PowerShell** pelo menu Iniciar. Execute:

```powershell
node -v
npm.cmd -v
```

Os dois comandos devem mostrar versões. Use depois os comandos **Windows / PowerShell** do instalador Wabotia. Se for executar dentro do Ubuntu/WSL2, siga o caminho Ubuntu acima e instale o Node.js dentro dele.

### macOS

1. Abra o [site oficial do Node.js](https://nodejs.org/en/download), escolha **LTS**, **macOS** e baixe **macOS Installer (.pkg)** para o seu Mac.
2. Abra o arquivo e conclua o assistente com as opções padrão; ele instala Node.js e npm.
3. Feche terminais antigos. Abra **Aplicativos > Utilitários > Terminal** e execute `node -v` e `npm -v`.
4. Com as versões aparecendo sem erro, use os comandos **Linux/macOS** do instalador Wabotia. Os comandos `apt-get` deste guia são apenas para Ubuntu.

Se estiver gravando o passo a passo, pause a gravação antes de preencher tokens ou abrir o arquivo privado de chaves.

## 1. Prepare sua conta Cloudflare

Não é necessário ter conta GitHub ou criar uma cópia do repositório. O instalador oficial roda uma vez no seu computador e publica Worker, D1, R2 e Durable Objects na sua conta. Depois ele pode ser fechado; somente Hermes/QR/túnel precisam permanecer ligados no host escolhido.

Com Node.js e npm conferidos pelo roteiro acima, prepare os serviços a seguir antes de criar o token.

### Antes do deploy: para que serve cada serviço da Cloudflare

A Cloudflare é a plataforma que mantém o Wabotia disponível na internet e guarda seus dados. Os serviços trabalham juntos, mas a ativação de um não habilita automaticamente todos os outros.

| Serviço | Para que serve no Wabotia | O que você prepara |
|---|---|---|
| **Workers** | Executa o painel web, a API e as regras do atendimento. | Escolha o plano da conta. Workers Paid é a referência de produção do projeto. |
| **D1** | Banco de dados: guarda usuários, configurações, conversas, protocolos e registros. | Confira acesso ao D1. O instalador cria o banco exclusivo da instalação. |
| **R2** | Armazena documentos, imagens, áudios e outros anexos. Uma pasta de armazenamento é chamada de *bucket*. | Ative a assinatura R2 e use um bucket privado. |
| **Durable Objects e alarmes** | Coordenam as conversas e os trabalhos pendentes, preservando ordem e evitando operações duplicadas. Os alarmes retomam tarefas agendadas. | O deploy configura esses recursos. Não precisa criar um servidor nem contratar cada alarme. |
| **Zero Trust** | Área da Cloudflare para administrar a segurança do acesso ao Hermes. | Ative um plano, como Zero Trust Free, antes de configurar o Access. |
| **Access** | Verifica se a chamada ao Hermes vem do Wabotia autorizado. | Cadastre aplicações e políticas Service Auth; crie Client ID/Client Secret para a conexão. |
| **Tunnel e cloudflared** | Fazem a ponte da Cloudflare até a máquina do Hermes sem abrir portas no roteador. cloudflared é o programa instalado nessa máquina. | Crie o túnel e mantenha cloudflared e Hermes ligados. |
| **DNS** | Liga nomes como `api-hermes.seudominio.com` ao destino correto. | Use domínio ativo na Cloudflare para os hostnames do túnel e confira os registros criados. |
| **API da Cloudflare** | Recebe o pacote oficial e publica diretamente o Worker. | Autorize o token da instalação. Não é necessário configurar Builds. |
| **Workers Secrets** | Guardam as chaves de instalação no ambiente protegido do Worker. | O instalador gera e guarda as duas chaves. Preserve os valores originais. |

**Exemplo de uma conversa:** a mensagem chega ao Worker, o registro vai para o D1 e os anexos para o R2. Durable Objects organizam o processamento. Quando um bot é necessário, o Worker usa Access + Tunnel para chegar ao Hermes, que executa o modelo no computador ou na VPS.

### Requisito 1 - Ative a assinatura R2, mesmo com franquia gratuita

1. Na conta Cloudflare da instalação, abra **Armazenamento e bancos de dados > R2 > Visão geral** (*Storage & databases > R2 > Overview*).
2. Se aparecer a adesão ao serviço, conclua a ativação da assinatura R2. Confira os termos e valores e preencha os dados de cobrança que a Cloudflare solicitar. A franquia gratuita não dispensa a adesão.
3. Confirme que você consegue acessar a lista de buckets ou o botão **Criar bucket**. Esse é o sinal de que o serviço está disponível para o deploy.
4. O instalador cria um bucket privado com o nome escolhido seguido de `-media`. Não é preciso criar um bucket antes; não habilite acesso público.

R2 tem uma franquia mensal gratuita e cobrança conforme o uso excedente. Confira a [ativação oficial do R2](https://developers.cloudflare.com/r2/get-started/) e os [preços vigentes](https://developers.cloudflare.com/r2/pricing/) antes de confirmar.

### Requisito 2 - Confira D1 e o plano Workers

1. Abra **Armazenamento e bancos de dados > Banco de dados SQL D1**. Confira que consegue abrir a lista e encontrar **Criar banco de dados**.
2. **D1 já está incluído nos planos Workers Free e Paid.** Ele não exige uma assinatura separada equivalente à adesão do R2; limites e eventuais cobranças dependem do plano Workers. Consulte os [planos oficiais do D1](https://developers.cloudflare.com/d1/platform/pricing/).
3. O instalador do Wabotia cria o banco. Não é preciso criar um banco de teste para habilitar o serviço. Se já instalou o Wabotia, confira o banco existente em **Worker > Bindings > DB**, sem criar outro para substituí-lo.
4. Para produção, prepare **Workers Paid** conforme a referência do projeto. Confira o plano e as condições na área de assinatura do Workers. Uma assinatura Zero Trust Free ou um plano do site/domínio não muda automaticamente o plano Workers.

O Worker usa as ligações **DB** e **MEDIA** criadas no deploy para acessar D1 e R2. Você não precisa gerar chaves D1 nem credenciais S3/R2 para colocar no painel Wabotia.

### Requisito 3 (opcional) - Zero Trust, só para ligar o Hermes por túnel

O caminho recomendado para o Hermes é o **plugin** (seção 4): ele não usa Zero Trust, Access, túnel nem domínio. Pule este requisito, a menos que você prefira o túnel.

1. Para seguir o caminho **Tunnel + Access**, abra **Zero Trust > Controles de acesso > Aplicativos**. Se aparecer a apresentação, clique **Começar** e conclua a ativação do plano escolhido. O **Zero Trust Free** atende esta configuração inicial.
2. Confira os termos e eventuais informações de cobrança mesmo selecionando o plano gratuito. Se pedir nome de equipe, escolha um disponível.
3. Confirme que consegue acessar **Aplicativos** e **Credenciais de serviço**. Se já consegue, não precisa repetir a adesão.
4. Depois de ativar o plano, ainda será necessário criar o Service Token, as políticas Access e o túnel. O [roteiro Hermes + Cloudflare](HERMES-CLOUDFLARE.md#d-cloudflare-access-chave-e-proteção-antes-do-túnel) mostra esses campos.

O plano Zero Trust é separado de Workers e R2. Um Hermes com HTTPS autenticado já acessível ao Worker pode dispensar Tunnel + Access; este guia usa essa proteção para Hermes local/privado.

### Confira os requisitos antes de instalar

- [ ] Conta Cloudflare correta e seu Account ID copiado.
- [ ] Node.js 22.13+ e npm instalados no computador usado para publicar.
- [ ] R2 ativado: lista de buckets ou **Criar bucket** disponível.
- [ ] D1 disponível: lista de bancos e **Criar banco de dados** acessíveis.
- [ ] Plano Workers conferido para o uso pretendido.
- [ ] Hermes funcionando, com modelo e provedor configurados; não apagar os bots existentes.
- [ ] Número de teste.
- [ ] Somente para o Hermes por túnel: Zero Trust ativado e domínio ativo na Cloudflare.

Só depois continue. **Gratuito significa uso dentro dos limites do serviço**, não consumo ilimitado nem dispensa de adesão. Se já ativou ou instalou algum item, confira o existente em vez de contratar novamente.

## 2. Instale sem GitHub

Há dois caminhos para a mesma instalação. Os dois criam o banco, o armazenamento e o Worker na sua conta e geram as chaves.

### Caminho A: pelo navegador, sem Node.js nem terminal

Abra [wabotia.queven.app/instalar](https://wabotia.queven.app/instalar). Com o R2 ativado (requisito 1), você informa Account ID, o token (o link da página abre o formulário preenchido na Cloudflare) e um nome novo.

1. **Conferir a conta.** A página confere o token e os nomes. Nada é criado nesta etapa.
2. **Baixar as chaves.** As chaves são geradas no seu navegador. Baixe o arquivo `NOME-chaves.local.json` e guarde em local privado antes de continuar: a `MASTER_KEY` não pode ser recuperada depois.
3. **Instalar.** A página executa os passos e mostra o andamento. Não feche a aba; se um passo falhar, **Tentar este passo de novo** continua de onde parou.
4. **Criar o administrador.** O botão final abre sua instalação com o código de instalação preenchido.

O que muda em relação ao terminal: **o token passa pelo servidor do site oficial a cada passo**, só para ser repassado à Cloudflare. Ele não é gravado em banco, arquivo ou registro, e o andamento fica no seu navegador. Como no terminal, o token fica salvo no seu próprio Worker (`WABOTIA_UPDATE_TOKEN`) para as atualizações pelo painel. Se preferir que o token nunca passe pelo site, use o caminho B. Este instalador não tem pasta local nem `--resume`: se a aba for fechada no meio, apague na Cloudflare o Worker, o banco D1 e o bucket R2 com o nome escolhido e recomece, ou use outro nome.

O instalador pelo navegador só existe no site oficial. Em qualquer outra instalação, `/instalar` avisa que está desligado (a variável `WABOTIA_WEB_INSTALLER=1` do Worker é o que o liga).

### Caminho B: pelo terminal

Requer o Node.js da seção inicial. Neste caminho o token vai direto do seu computador para a Cloudflare.

### Crie o token e copie Account ID

1. Na conta Cloudflare escolhida, copie **Account ID** na visão geral da conta/domínio.
2. Abra o [formulário de token já preenchido](https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22d1%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22workers_r2%22%2C%22type%22%3A%22edit%22%7D%5D&accountId=*&zoneId=all&name=Wabotia%20instala%C3%A7%C3%A3o): a Cloudflare abre a criação do token com o nome e as três permissões. O instalador mostra o mesmo link antes de pedir o token.
3. Se o link não abrir o formulário, crie à mão: **My Profile → API Tokens → Create Token → Custom Token**, nome “Wabotia instalação” e permissões de conta **Workers Scripts: Edit**, **D1: Edit** e **Workers R2 Storage: Edit**.
4. Em **Account Resources**, selecione **Include → Specific account**, somente a conta da instalação. Defina a validade, confira e crie.
5. Copie o valor exibido uma vez e guarde em local privado. Esse token autoriza publicar Workers e administrar D1/R2 nessa conta. Ele será enviado diretamente à Cloudflare; o site Wabotia não o recebe.

### Baixe e execute

Ubuntu na VPS, Linux, WSL2 ou macOS: use o **mesmo terminal e usuário em que Node.js e npm funcionaram** e execute uma linha de cada vez:

```sh
curl -fL https://wabotia.queven.app/install-wabotia.mjs -o install-wabotia.mjs
node install-wabotia.mjs
```

Windows: abra **PowerShell**, com Node.js e npm instalados:

```powershell
Invoke-WebRequest https://wabotia.queven.app/install-wabotia.mjs -OutFile install-wabotia.mjs
node .\install-wabotia.mjs
```

O primeiro comando baixa o instalador oficial. O segundo o executa. Informe Account ID, o token (não aparece enquanto você digita) e um **nome novo**, como `wabotia-atendimento`.

**Como saber se está esperando você ou trabalhando:**

- **AGUARDANDO VOCÊ:** digite ou cole o dado pedido e pressione Enter. No token, os caracteres ficam invisíveis. Antes de receber Account ID, token e nome, o instalador não publica nada.
- **EM EXECUÇÃO:** a etapa começou. **AGUARDANDO RESULTADO** aparece a cada 10 segundos, com o tempo decorrido. Esse aviso confirma que o processo continua aguardando; não é uma porcentagem nem uma confirmação de que a Cloudflare terminou.
- A publicação pode levar alguns minutos, especialmente ao baixar npm/Wrangler pela primeira vez. **OK** confirma uma etapa. **5/5 · Pronto** confirma o término e mostra sua URL.
- Se surgir um erro, siga a orientação exibida. Se precisar interromper depois de iniciar a publicação, preserve a pasta e use a retomada abaixo; não abra outra instalação em paralelo nem apague os recursos.

O instalador verifica a integridade da versão, publica os recursos, prepara o banco, gera as chaves e habilita a atualização pelo painel. Aguarde as cinco etapas. Ele recusa sobrescrever um Worker ou uma pasta de outra instalação.

### Guarde a pasta privada

Será criada uma pasta com o nome escolhido. Nela:

| Arquivo | Para que serve |
|---|---|
| `chaves.local.json` | Guarda MASTER_KEY, SETUP_TOKEN e o token inicial de atualização. Não compartilhe. |
| `installation.local.json` | Identifica a instalação, a versão e o ponto de retomada. |
| `wrangler.jsonc` | Configuração dos recursos para recuperação manual. |
| `worker/`, `web/`, `migrations/` | Arquivos da versão instalada, sem repositório Git. |

Ao terminar, o instalador mostra o **link de primeiro acesso** (`…/app#setup=…`). Abra-o no navegador: ele já leva o código de instalação para a tela de criar o primeiro administrador, sem abrir arquivo nenhum. O código vai no fragmento da URL, que o navegador não envia ao servidor, e só serve até essa conta existir. Se preferir, abra `chaves.local.json` em um editor e copie **somente o valor de SETUP_TOKEN**. **MASTER_KEY** protege as credenciais criptografadas. A senha de login é escolhida por você. Não gere novas chaves para uma instalação existente. O gerador do site continua disponível para configuração manual, mas não é necessário neste fluxo.

Abra a URL exibida pelo instalador seguida de `/app`. Para domínio próprio, use **Cloudflare → seu Worker → Settings → Domains & Routes → Add → Custom domain**, em um domínio da mesma conta.

### Se parou no meio

Corrija a mensagem e execute, no mesmo diretório, substituindo o nome:

```sh
node install-wabotia.mjs --name wabotia-atendimento --resume
```

Informe a mesma conta e um token válido. A retomada usa a pasta privada original e não apaga recursos. Não exclua DB, MEDIA ou os arquivos de chaves para tentar novamente.

### Vou reinstalar

Use um nome novo, por exemplo `wabotia-atendimento`, preservando a instalação anterior até validar a nova. Faça backup se houver dados. O histórico não é importado automaticamente. Mantenha bots, APIs e túnel Hermes existentes; cadastre a conexão novamente usando os mesmos endereços e chaves autorizadas. Não execute o assistente de criar túnel nos endereços que já funcionam.

Pause os canais antigos antes de ativar os mesmos números/bots na nova instalação. Só depois de conferir os dados e canais você pode desativar os recursos antigos e remover a cópia GitHub anterior. A instalação nova não depende dela.

## 3. Crie sua conta e acesse a área de atendimento

1. Abra o link de primeiro acesso do instalador e preencha nome, e-mail e senha de pelo menos 12 caracteres; o código de instalação já vem preenchido. Sem o link, abra sua URL `/app` e cole o `SETUP_TOKEN`.
2. Clique **Criar conta e entrar**. O código inicial não cria outras contas depois que o administrador existe.
3. A **Área de atendimento** é criada automaticamente para a empresa nesta instalação e compartilhada pela equipe. Não é necessário criar uma área para cada pessoa.
4. Mantenha o atendimento pausado enquanto prepara os serviços.
5. Em **Pessoas**, adicione uma conta para cada atendente da mesma área de atendimento. Evite compartilhar uma única conta. A edição permite alterar nome, acesso e senha; a desativação encerra o acesso.

## 4. Conecte o Hermes pelo plugin (recomendado)

Um comando na máquina do Hermes, sem túnel, sem domínio e sem chaves do Hermes guardadas no Wabotia. Detalhes e limites em [Plugin Wabotia para o Hermes Agent](HERMES-PLUGIN.md).

1. Tenha o Hermes funcionando, com modelo e provedor configurados. Quem ainda não tem pode usar uma VPS com a imagem pronta do Hermes Agent, como a da Hostinger.
2. No painel: **Hermes e canais → Conectar Hermes**, mantenha **Plugin no Hermes** e salve.
3. No cartão da conexão, **Gerar comando de instalação**. O código vale 15 minutos e uma única vez.
4. Cole o comando no terminal da máquina do Hermes, com o usuário do Hermes. Para Hermes em Docker, a mesma janela mostra as duas formas do comando (do servidor e de dentro do contêiner).
5. Reinicie o gateway do Hermes (em Docker, `docker restart CONTEINER`).
6. No cartão: **Testar conexão → Descobrir bots → Ativar**. Depois siga os itens 5 a 7 da seção 6 para escolher o Atendente e cadastrar conhecimento e menus.

O comando instala o plugin, habilita a API local do Hermes somente em `127.0.0.1` e cria a `API_SERVER_KEY` do perfil se ainda não existir. Ele não abre portas e não reinicia nada sozinho. As seções 4-A, 5 e os itens 1 a 4 da seção 6 abaixo são o **caminho alternativo por túnel**; quem usa o plugin não precisa deles.

## 4-A. Caminho alternativo por túnel: ligue a API do Hermes

Siga o [roteiro completo Hermes + Cloudflare](HERMES-CLOUDFLARE.md). Ele mostra onde abrir o terminal, como criar o atendimento Hermes `wabotia`, gerar e guardar as chaves, habilitar a API, iniciar os serviços e testar. Há caminhos separados para **Ubuntu/Linux/WSL2/macOS nativo** e **VPS Ubuntu com Docker**, preservando o Hermes existente.

O assistente `python3 scripts/prepare-hermes.py --profile wabotia --create-profile` faz backup e configura a API nativa. Ele não inicia serviços sozinho. O manual mostra os comandos de início, reinício e diagnóstico, inclusive quando a API é desligada depois. Dois serviços precisam responder: backend administrativo na 9119 e API dos bots na 8642, ambos autenticados e restritos ao loopback. Use `--check` para verificar os dois antes de abrir um túnel.

As chaves Hermes geradas ficam em `~/.config/wabotia/hermes/chaves.local.txt`. Elas são adicionais às chaves de instalação do Wabotia. Não substitua MASTER_KEY/SETUP_TOKEN. Não copie credenciais dos canais de outro bot.

## 5. Caminho alternativo por túnel: configure a Cloudflare para alcançar o Hermes

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

Com o plugin, a conexão já está feita: comece no item 5. Os itens 1 a 4 valem para o caminho por túnel.

1. Wabotia > **Conexões > Nova conexão**. Selecione **Hermes**, escolha **URLs públicas com túnel Cloudflare**, dê um nome e preencha as URLs HTTPS administrativa e da API.
2. Cole o token administrativo e a `API_SERVER_KEY` de cada atendimento Hermes. Abra **Conexão protegida por Cloudflare Access** e preencha o Client ID e Client Secret criados na Cloudflare. Para vários atendimentos Hermes, o campo JSON aceita um mapa `{"atendente":"CHAVE","financeiro":"OUTRA_CHAVE"}`. Essas chaves são exemplos; insira seus valores somente no painel. Máximo de 20 atendimentos Hermes por conexão.
3. Salve, clique **Testar conexão** e **Descobrir bots**. A verificação exige idempotência durável anunciada pelo Hermes.
4. Ative a conexão. Em **Equipe Bot**, habilite os bots autorizados e selecione o **Atendente**.
5. Crie ações de especialistas: informe qual bot consultar, em que condição e qual ação ele pode executar. Os bots não recebem permissão para chamar outros especialistas livremente.
6. Em **Conhecimento**, cadastre texto, URL pública, PDF com texto, DOCX ou legendas autorizadas. Vídeos exigem legendas públicas; a importação não contorna restrições da plataforma. Arquivos: até 20 MB.
7. Em **Menus e preferências**, escolha o modo de resposta, prazo, avaliações, menus e instruções. Aplicativos/menus avançados podem ser editados em JSON. JEV é opcional e usa uma chave no backend.

Arquivos produzidos por bots precisam ser exportados como artefatos da API nativa e retornar IDs em `files`. Um caminho local no texto não vira um download. A API de artefatos é de uso único: um download interrompido sem confirmação exige nova exportação no Hermes.

## 7. Escolha um modo WhatsApp por número

### WhatsApp oficial pela Zernio

1. No painel Zernio, confira seus telefones já cadastrados e obtenha uma API key.
2. Em **Integração Zernio**, salve API key, fuso e segredo de assinatura do webhook. O ID pode ficar vazio inicialmente.
3. Use **Encontrar ID na Zernio**, confirme a integração pelo nome e abra **Telefones → Buscar telefones na Zernio**. O Wabotia importa o que já está cadastrado no provedor.
4. Cadastre na Zernio o webhook exibido, com o mesmo segredo e eventos de mensagens e recibos.
5. Em **Telefones**, adicione os números, teste e ative. Fora da janela de 24 horas, templates continuam exigindo aprovação e consentimento.

O [guia Zernio](ZERNIO-WHATSAPP.md) detalha o processo, a migração das linhas Meta anteriores e a exclusão de telefones preservando o histórico. O Worker conversa com a Zernio; o Hermes fornece os bots.

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

## 8. Conecte seus outros sistemas

1. Abra **API e integrações > Nova aplicação**.
2. Dê um nome e autorize as operações e os bots necessários na área de atendimento. Selecione só o que o sistema precisa.
3. Clique **Gerar chave** e defina a validade. Copie o valor exibido uma vez para o backend do seu sistema.
4. Use a [documentação interativa](/api-docs) da sua própria instalação e os [exemplos](API.md). A chave não deve aparecer no JavaScript público de um site.
5. Para eventos, cadastre uma URL HTTPS de webhook e guarde o segredo de assinatura. **Webhooks** mostra as entregas e oferece reenvio. O destinatário precisa verificar HMAC e deduplicar IDs.
6. Para rotação, crie outra chave, atualize o sistema integrador e revogue a anterior. Desativar a aplicação interrompe suas chaves.

## 9. Teste antes de abrir o atendimento

Use pessoas e números de teste autorizados. Confira: pergunta com fonte, ausência da equipe, protocolo/prazo, presença, tomada humana durante uma resposta lenta, nota interna, transferência, anexo, consentimento, avaliação, webhook repetido, recuperação depois de desligar o Hermes/QR e troca pausada de modo.

Abra **Execuções** e **Entregas** para conferir erros. Em `unknown`, primeiro descubra o que ocorreu no canal/Hermes: o botão de reconciliação registra a confirmação; não inventa um resultado. Não repita uma mensagem só porque a tela demorou.

Após validar, ative **Atendimento** em Menus e preferências. Guarde os arquivos locais e faça um [backup](OPERACAO.md). Para ajuda técnica, envie apenas o ID da requisição e o erro sanitizado, nunca tokens ou conversas de clientes.

## Referências oficiais

- [Publicação de Workers com Wrangler](https://developers.cloudflare.com/workers/wrangler/commands/#deploy)
- [Tokens da API Cloudflare](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/)
- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)
- [Service tokens do Access](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
- [Hermes API Server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server)
