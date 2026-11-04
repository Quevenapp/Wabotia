# Instalar o Wabotia, passo a passo

Este guia instala o painel na **sua conta Cloudflare**. O computador só precisa ficar ligado se nele estiverem Hermes, o túnel ou o conector QR. Não há servidor Wabotia para instalar em VPS e não é necessário Supabase.

As telas do [PDF ilustrado](https://wabotia.queven.app/guide/wabotia-instalacao.pdf) usam dados fictícios. Os nomes de menus da Cloudflare podem aparecer em inglês. Esta é a versão inicial 0.1.0: valide os seus canais antes de atender clientes, conforme [VALIDACAO.md](VALIDACAO.md).

## 1. Primeiro, vincule a Cloudflare ao GitHub

Para instalar pelo botão **Deploy to Cloudflare**, faça a vinculação **antes de abrir o botão do Wabotia**. Se sua conta GitHub já aparece na lista **Git account** da Cloudflare, a conexão está feita; siga para as chaves abaixo. Se escolher o instalador pelo terminal (opção B), essa vinculação não é necessária.

1. Entre na [Cloudflare, em Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages), e selecione a conta onde vai instalar o Wabotia.
2. Clique em **Create application / Criar aplicativo** e escolha **GitHub**. Dependendo da tela, a opção fica em **Import a repository / Importar repositório**.
3. Clique em **Connect GitHub / Conectar GitHub** ou **+ Add account / Adicionar conta**. Entre no GitHub, escolha a conta ou organização que receberá sua cópia e autorize o aplicativo **Cloudflare Workers and Pages**. Confira a conta e o acesso aos repositórios solicitado antes de confirmar.
4. Volte à Cloudflare e confirme que sua conta aparece em **Git account**. A vinculação está concluída. Volte ao site Wabotia para gerar as chaves e continuar com o botão específico do projeto; não é preciso publicar um projeto vazio nesse assistente.

**A tela fechou depois de autorizar pelo botão de deploy?** Isso pode acontecer na primeira vinculação. Volte a [wabotia.queven.app/install](https://wabotia.queven.app/install) e clique novamente em **Deploy to Cloudflare**. Escolha a conta GitHub já vinculada e continue. A autorização do GitHub, por si só, ainda não significa que o Wabotia foi instalado. Se a conta não aparecer, confira se está na mesma conta Cloudflare e conclua **Adicionar conta** antes de tentar o deploy novamente.

### Depois da vinculação, separe o que você vai usar

- Uma conta GitHub e uma conta Cloudflare. Considere Workers Paid para produção; habilite o R2 na Cloudflare. Custos dependem do plano e do uso, além dos modelos e canais externos.
- Um Hermes funcionando, com seus perfis, modelos e ferramentas já configurados. Não apague os perfis existentes.
- Um número de WhatsApp de teste e, se quiser atendimento pelo Telegram, um bot novo e um grupo privado com tópicos.
- Um gerenciador de senhas ou local privado para guardar duas chaves diferentes: `MASTER_KEY` e `SETUP_TOKEN`. O [gerador do site](https://wabotia.queven.app/install#chaves) cria as duas para você; cada uma tem 64 caracteres aleatórios.

`MASTER_KEY` permite ler as credenciais criptografadas do seu banco. `SETUP_TOKEN` autoriza a criação da primeira conta. A senha do administrador é uma terceira informação, escolhida por você.

**Como gerar e guardar:** no site, clique em **Gerar minhas duas chaves**. Use **Copiar MASTER_KEY** e **Copiar SETUP_TOKEN** para preencher os campos de mesmo nome na Cloudflare. Guarde as duas em seu gerenciador de senhas ou clique em **Baixar minhas chaves (.txt)** e proteja o arquivo. Depois do deploy, anote junto delas a URL da instalação. A geração acontece só no navegador; o site não recebe nem salva os valores. Atualizar ou fechar a página apaga o par da tela. O botão Deploy abre outra aba para você poder voltar e copiar.

O gerador é para uma **nova instalação**. Se já instalou, preserve as chaves originais, especialmente MASTER_KEY. Se escolher o instalador pelo terminal (opção B), ele gera e salva as duas automaticamente; não precisa usar o gerador do site.

## 2. Escolha uma forma de publicar

### Opção A - Botão Deploy to Cloudflare

1. Com Cloudflare e GitHub já vinculados, abra [wabotia.queven.app/install](https://wabotia.queven.app/install), gere e guarde as duas chaves conforme explicado acima. Depois clique em **Deploy to Cloudflare**; o formulário abre em outra aba.
2. Entre na sua conta Cloudflare. Confira que o projeto de origem é `Quevenapp/Wabotia`.
3. Escolha sua conta e a conta GitHub onde ficará a cópia. Dê um nome ao projeto, por exemplo `meu-atendimento`. Autorize somente o repositório necessário.
4. Confira os recursos sugeridos: banco D1, bucket R2 e Durable Object. O provisionamento é automático. Mantenha o bucket privado.
5. Preencha os secrets `MASTER_KEY` e `SETUP_TOKEN` com os valores que guardou. Eles são secrets do Worker; não são variáveis `VITE_*` nem arquivos para enviar ao GitHub.
6. Em **Build command**, mantenha `npm run build`. Em **Deploy command**, mantenha `npm run deploy`. Esse comando publica e aplica as migrações do banco usando a ligação `DB`.
7. Desative Enable Preview builds até configurar recursos isolados para testes. Clique em publicar e aguarde a indicação de sucesso. Guarde a URL `https://seu-projeto.sua-conta.workers.dev`.
8. Em Workers & Pages > seu Worker > Settings > Variables and Secrets, confira apenas a existência dos dois secrets. Se a tela inicial não os solicitou, adicione-os com tipo **Secret** e publique a alteração.
9. Abra **a URL da sua instalação**, acrescente `/app` e continue na etapa 3.

O botão usa Cloudflare Builds. Não precisa de GitHub Actions. Na cópia do repositório, você também pode abrir Settings > Actions > General e selecionar **Disable actions**. O repositório original Quevenapp/Wabotia já mantém Actions desativado.

Se o deploy informar falta de R2, habilite o serviço na conta e repita. Se o banco estiver vazio porque o comando de deploy foi alterado, use a opção B ou, numa cópia local da configuração com os IDs do seu Worker, rode `npx wrangler d1 migrations apply DB --remote`. Não crie um segundo atendimento para resolver uma migração pendente.

### Opção B - Instalador pelo terminal

É a alternativa validada integralmente nesta versão. Os comandos são iguais em Linux, macOS e Windows/WSL2.

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

## 4. Prepare as APIs do Hermes

O Wabotia usa dois serviços nativos: backend administrativo para descobrir perfis (`/api/profiles`) e API Server para executar bots (`/v1/capabilities`, `/v1/runs`). A compatibilidade foi examinada na revisão `0e427d788d253630d38a3a51cd76849e73cd6925`. Instalações antigas ou que só oferecem chat completions precisam de atualização compatível.

1. No Hermes, identifique o nome de cada perfil. Não crie outro perfil se o bot já existir.
2. No ambiente/configuração **do perfil correto**, habilite a API Server e configure uma chave forte. Exemplo dos campos, sem valores reais:

```ini
API_SERVER_ENABLED=true
API_SERVER_KEY=COLE_A_CHAVE_ALEATORIA_DO_PERFIL
```

3. Reinicie o gateway do Hermes pelo método que já utiliza. Confirme a porta no log; o padrão da API é **8642**. Não abra uma segunda instância sobre as mesmas portas.
4. Para descoberta, use o backend administrativo autenticado. O padrão usado pelo assistente é **9119**; confirme a porta na sua instalação. Uma instalação headless pode usar `hermes serve --host 127.0.0.1 --port 9119`, desde que não exista outro backend nessa porta. Configure `HERMES_DASHBOARD_SESSION_TOKEN` no ambiente desse processo com uma chave forte e estável.
5. Um dashboard público configurado para login/OAuth não aceita necessariamente esse Bearer. O Wabotia não faz login interativo nele: use uma API administrativa compatível e protegida, ou ajuste a implantação com seu administrador. Não desative a autenticação de um dashboard público.
6. No Docker, mantenha volumes persistentes dos perfis. Exponha portas do contêiner somente no loopback do host, ou use cloudflared na mesma rede Docker privada. As portas e o processo administrativo dependem da imagem Hermes que você usa.

Nunca use a porta de desenvolvimento do frontend Hermes como URL da API. As ferramentas, aprovações e credenciais dos bots continuam sob o controle do Hermes.

## 5. Hermes em computador local, VPS ou rede privada

Se já há HTTPS autenticado acessível ao Worker, vá à etapa 6. Se o Hermes só responde em localhost/rede privada, use Cloudflare Tunnel com Access:

1. No computador que alcança o Hermes, na pasta Wabotia, execute `node scripts/connect-hermes.mjs`.
2. Informe dois endereços do seu domínio: `hermes.seudominio.com` e `api-hermes.seudominio.com`. Confirme as portas reais e escolha um nome novo para o túnel.
3. O assistente gera um arquivo `connection.NOME.local.md` com os comandos e `tunnel.NOME.local.yml` com a configuração. Ele não modifica seus bots.
4. Na Cloudflare Zero Trust, abra **Access > Applications**. Crie uma aplicação **Self-hosted** para cada um dos dois hostnames. A política deve ser **Service Auth**.
5. Em **Access > Service Auth > Service Tokens**, crie um Service Token. Guarde o Client ID e o Client Secret; inclua esse token nas políticas dos dois hostnames.
6. Instale [cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/) e siga os comandos do arquivo gerado: login, criação do túnel e das duas rotas DNS.
7. No YAML, substitua o UUID e o caminho do arquivo de credenciais. O `httpHostHeader` do backend loopback é ajustado pelo assistente para a validação de Host do Hermes; o Access continua obrigatório no endereço externo.
8. Inicie o túnel conforme o guia gerado. No painel Wabotia, preencha Client ID/Secret do Access junto com as chaves Hermes.
9. Configure cloudflared para iniciar com o sistema. Em Windows/WSL2, o ambiente precisa permanecer ligado; no macOS, use o serviço conforme a documentação oficial. Em Docker, mantenha rede privada, volume de credenciais e política de reinício.

O túnel não substitui o Hermes: se o computador dormir, os bots param de executar. O Wabotia continua disponível e os atendentes podem usar os canais ainda conectados.

## 6. Conecte e escolha a Equipe Bot

1. Wabotia > **Conexões > Nova conexão**. Selecione **Hermes**, dê um nome e preencha as URLs HTTPS administrativa e da API.
2. Cole o token administrativo e a `API_SERVER_KEY` de cada perfil. Para vários perfis, o campo JSON aceita um mapa `{"atendente":"CHAVE","financeiro":"OUTRA_CHAVE"}`. Essas chaves são exemplos; insira seus valores somente no painel. Máximo de 20 perfis por conexão.
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
