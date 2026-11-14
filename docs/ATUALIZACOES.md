# Atualização direta, sem repositório próprio

Desde a versão 0.3, novas instalações baixam um pacote oficial já preparado e publicam diretamente na sua conta Cloudflare. Não precisam de conta GitHub, cópia do repositório, Cloudflare Builds ou Deploy Hook. O código continua aberto no repositório oficial; uma versão só aparece no painel depois que seu pacote foi publicado pelo mantenedor.

## Usar o botão

1. Abra **sua instalação → Sistema e atualizações**.
2. Clique **Verificar atualização**. A consulta é armazenada por cinco minutos.
3. Confira a versão e clique **Atualizar Wabotia**.
4. Acompanhe as etapas: baixar e verificar o pacote, preparar arquivos, migrar o banco e publicar.
5. Espere **Atualização publicada e verificada**. Clique **Reabrir painel atualizado**.

A confirmação compara o commit solicitado com o código em execução. O banco, as mídias, os domínios e os secrets permanecem na sua conta. Migrações são aplicadas com recibo na mesma transação antes de ativar código. Alterações incompatíveis em Durable Objects precisam de procedimento manual.

## Atualizações automáticas

Em **Sistema → Atualizações automáticas**, ligue **Instalar novas versões automaticamente**, escolha a hora inicial e uma janela de uma a seis horas e salve. O padrão sugerido é das 03:00 às 05:00, no fuso `America/Sao_Paulo`; a opção começa desligada. É necessário que a instalação direta já tenha autorização Cloudflare. O painel reutiliza essa autorização, sem pedir outro token.

O agendamento existente verifica a janela a cada cinco minutos. Dentro dela, consulta uma vez o catálogo oficial e inicia somente uma versão de número maior que a instalada. Não faz downgrade, não troca o código de uma versão com o mesmo número e não executa pacotes que falhem na conferência de integridade ou compatibilidade. A janela define quando um trabalho pode começar; uma publicação iniciada termina normalmente mesmo depois da janela.

A checagem e a instalação compartilham uma trava persistente com os comandos manuais. Falhas temporárias de consulta e falhas de rede antes da publicação têm até três tentativas, com espera crescente e dentro da janela. Pacote inválido, erro de migração, falha não temporária e publicação com resultado incerto exigem revisão. O painel mostra estado, última consulta, tentativa e erro. A confirmação continua dependendo do novo código estar em execução, sem considerar apenas a resposta do upload.

Desligar a opção cancela a criação de novos trabalhos e um trabalho automático que ainda não começou. Uma atualização já iniciada continua; desligar não tenta reverter migrações. Os processos Hermes e QR continuam sendo mantidos separadamente. Mantenha uma rotina de backup: não há rollback automático do banco.

Contrato administrativo: `POST /api/v1/system/updates/automatic`, com `{"enabled":true,"hour":3,"window_hours":2}` e `Idempotency-Key`. A política e seu acompanhamento ficam em `updates.automatic` de `GET /api/v1/system`. A migração aditiva `0011_auto_updates.sql` cria a trava de concorrência; a configuração permanece protegida na instalação.

A versão `0.10.0` inclui as migrações `0010` a `0013`: pareamento, trava de atualizações, setores/menus e decisões JEV. Aplique-as antes de ativar o Worker novo. O agendador só instala versões maiores; cada pacote publicado é imutável.

A versão `0.11.0` substitui a integração direta Meta pela Zernio e permite excluir telefones preservando o histórico. Faça backup antes: a migração `0014_zernio.sql` pausa as conexões Meta existentes e cancela seus envios ainda pendentes. As credenciais antigas não são convertidas. Depois de atualizar, siga o [guia Zernio](ZERNIO-WHATSAPP.md) para cadastrar a conta intermediária e reconectar os números. O atendimento só deve ser ativado após conferir o recebimento e o envio com suas credenciais. Hermes e QR continuam disponíveis.

A versão `0.12.0` simplifica o painel para **Área de atendimento → Integração Zernio → Telefones**. Cada instalação recebe automaticamente uma área compartilhada pela equipe, sem etapa de cadastro ou seleção. Nas instalações existentes, o Wabotia reutiliza o atendimento e mantém dados, permissões e credenciais; se não houver área, ela é preparada no primeiro acesso administrativo. Não há migração de banco nesta versão. Instalações antigas com várias áreas mantêm acesso aos dados anteriores, sem fusão automática nem ampliação de permissões.

A versão `0.12.1` acrescenta à tela **Integração Zernio** links e instruções para obter a API key, copiar o ID da integração e definir o segredo do webhook. Depois de salvar, o painel orienta o cadastro da URL em Webhooks da Zernio. É uma atualização de ajuda da interface, sem migração de banco ou alteração das credenciais existentes.

## Autorização Cloudflare

O instalador configura automaticamente a atualização com o token usado na instalação. Para renovar, abra **Alterar configuração de atualização**, cole um token com **Workers Scripts: Edit** limitado à conta da instalação e salve. O servidor confere a identidade do Worker antes de aceitar o token. Ele é criptografado e nunca aparece nas consultas do painel.

O token inicial também possui D1/R2 para criar os recursos. Depois de instalar, você pode substituí-lo por um token com somente **Workers Scripts: Edit** e revogar o inicial. Essa permissão permite publicar Workers na conta autorizada; escolha uma conta adequada ao projeto e guarde a credencial em local privado.

## Se houver falha

- **Falha antes de publicar:** leia a mensagem, corrija token/permissão e libere nova tentativa. Um pacote inválido não é ativado.
- **Publicação sem confirmação:** confira o Worker em **Cloudflare → Implantações** e o endereço `/api/health`. Não repita enquanto pode estar em andamento. O painel permite liberar após 15 minutos, com confirmação de que a publicação anterior terminou.
- **Token expirado:** salve um novo token no painel. Não altere MASTER_KEY.
- **Migração falhou:** a transação da migração e seu recibo são revertidos. O código novo não é ativado. Corrija a versão/configuração antes de repetir.
- **Painel inacessível:** preserve a pasta privada criada pelo instalador. Uma recuperação manual deve usar a configuração e os secrets originais; não execute uma instalação nova sobre recursos existentes.

Faça backup antes de atualizar. Não há rollback automático de dados.

## Instalações anteriores e reinstalação

O fluxo anterior continua documentado em [ATUALIZACOES-LEGADO.md](ATUALIZACOES-LEGADO.md). Um hook já configurado não é apagado por uma atualização.

Para adotar o fluxo direto com uma instalação nova, siga [INSTALACAO.md](INSTALACAO.md). Use nome novo, guarde a instalação antiga até conferir a nova e reconecte o Hermes existente. Não crie outro túnel para os mesmos endereços. O histórico não é importado automaticamente. Pare os canais antigos antes de ligá-los na instalação nova; cada número deve ter um único consumidor.

## Publicar uma versão oficial (mantenedor)

1. Execute tipos, testes e homologação. Atualize versão e manual. Faça commit do código.
2. Execute `npm run release`. O script produz o instalador, o Worker, os arquivos web e o pacote com SHA-256. Publicações de uma versão são imutáveis: use outra versão para alterar o pacote.
3. Publique o site oficial com Wrangler, preservando as pastas das versões já publicadas. O arquivo `releases/latest.json` aponta para o novo pacote.
4. Valide a instalação e uma atualização real em staging. GitHub Actions permanece desativado.

Pacotes e instalador gerados não são enviados ao Git. Guarde os artefatos das versões publicadas em backup. Para gerar um candidato local sem alterar o catálogo, use `npm run release -- --candidate`.

Referência do protocolo: [upload direto de arquivos Cloudflare](https://developers.cloudflare.com/workers/static-assets/direct-upload/).


## Atualização 0.5.0: WhatsApp

Faça backup antes. A migração `0006_whatsapp.sql` adiciona metadados, uploads por partes, grupos, recibos e ligações; não importa nem apaga histórico. O pacote oficial contém o painel e o Worker. O processo QR ou o transporte Hermes **não** é atualizado pelo botão do painel: siga o [roteiro de atualização dos conectores](WHATSAPP.md#primeiro-atualize-os-dois-lados), preservando sessões, perfil e diários. O contrato novo é protocolo 2; conectores antigos não devem ser usados para as funções novas.

Habilitar chamadas Meta ou grupos elegíveis é uma configuração posterior no provedor e no painel; a atualização não solicita essas permissões automaticamente. A homologação com número real fica para o roteiro final do guia.

## Atualização 0.6.0: roteador de números

Faça backup e use **Sistema e atualizações → Verificar atualização → Atualizar Wabotia**. A migração aditiva `0007_number_router.sql` cria contas Meta, grupos, permissões e contadores, mantendo conexões e histórico existentes. Ela não conecta números reais nem altera webhooks na Meta. Não é preciso reinstalar, criar outro túnel ou mudar Hermes/QR para usar o roteador Meta direto; os conectores 0.5 continuam adequados.

Depois, abra **Roteador de números** e siga o [guia da WABA, webhook e consumo inicial](ROTEADOR.md). Adotar um número já conectado exige pausa e entregas reconciliadas/confirmadas. A cobrança de modelos só é permitida por pedidos explícitos; notificações automáticas desses números não viram modelos pagos. O pacote oficial atualiza a Cloudflare, sem reconfigurar o aplicativo Meta.

## Atualização 0.6.1: conexão Meta e guia do primeiro número

Use **Sistema e atualizações → Verificar atualização → Atualizar Wabotia**. Esta revisão corrige uma opção de requisição incompatível com Workers, que impedia consultas à Meta e o download de anexos. Redirecionamentos continuam recusados sem encaminhar os tokens a outro endereço. Após atualizar, repita **Buscar números na Meta**, que é uma consulta. Não repita mensagens com resultado incerto sem conferir a entrega anterior.

Não há nova migração nem necessidade de reinstalar, trocar tokens ou refazer o webhook. O [guia ilustrado Meta](META-WHATSAPP.md) está no site, no PDF específico e no manual completo.

## Atualização 0.6.3: navegação entre telas do painel

Corrige a tela em branco ao abrir Conversas depois de Conexões ou Protocolos. Cada tela mostra somente os registros do perfil, da página e da paginação atuais; respostas de consultas anteriores não substituem uma consulta mais recente. Não há migração de banco nem alteração das conexões Meta. Atualize em **Sistema e atualizações** e reabra o painel.

## Atualização 0.7.0: função e permissões por número

Em **Roteador de números → Uso por número → Função e permissões**, escolha **Atendimento oficial**, **Integração com janela de 24 horas (Vinki)** ou ajuste cada opção: respostas de serviço, templates, atendentes, aplicações externas, menu, bots e grupos. As restrições valem para painel, Telegram e API; grupos e aplicações não podem ampliar as permissões do número. Alterações são verificadas novamente antes da entrega e bloqueiam respostas de bots desativados. Recebimento, histórico, contadores e webhooks são preservados.

O contador de templates entregues aparece separado do teto de serviço. Nenhuma função autoriza cobrança automática ou cria uma janela de 24 horas. Os números existentes mantêm o comportamento anterior até o administrador salvar suas opções. Não há migração de banco, novas credenciais ou alteração na Meta; esta atualização não ativa canais nem o perfil. Consulte [as opções e exemplos de uso](ROTEADOR.md#31-defina-o-que-cada-número-pode-fazer).

## Atualização 0.8.0: aplicativos Android e iOS

Faça backup e use **Sistema e atualizações → Verificar atualização → Atualizar Wabotia**. A migração aditiva `0008_mobile.sql` cria as tabelas de dispositivos, cursores de push e alertas de protocolo e acrescenta colunas à tabela de sessões; conversas, agenda, credenciais e histórico são preservados. Os aplicativos exigem esta versão: cada pessoa informa o endereço do seu servidor no aplicativo e entra com o e-mail e a senha de **Pessoas**; o token de sessão `wabu_` é separado das chaves de aplicação e não amplia o acesso de integrações.

Depois de atualizar, abra **Sistema e atualizações → Notificações dos aplicativos** e escolha o modo: **Gateway Wabotia** (padrão, sem entregar credenciais Firebase ao gateway), **FCM direto** (conta de serviço própria, para quem compila o próprio aplicativo) ou **Desligado**. Com o conteúdo **mínimo**, nomes e trechos de mensagens não passam pelo gateway. Use **Enviar teste** após entrar no aplicativo. Sem configurar, os aplicativos funcionam em primeiro plano, sem push. Nada muda em canais, Hermes, QR ou Meta. Consulte [o guia dos aplicativos](MOBILE.md).

## Atualização 0.14.0: central de atendimento por modelo

Faça backup e use **Sistema e atualizações → Verificar atualização → Atualizar Wabotia**. A migração aditiva `0016_service_center.sql` acrescenta a categoria e a origem dos protocolos, o estado "aguardando a descrição do protocolo" nas conversas e índices de consulta; nenhum protocolo, conversa ou configuração existente é alterado. Quem não usa os recursos novos continua com o comportamento da 0.13: prazo em horas corridas, sem categorias e sem modelo aplicado.

O que passa a existir, tudo opcional: prazo da primeira resposta em dias úteis com horário e feriados; seis estados de protocolo (Recebido, Em análise, Aguardando cliente, Aguardando terceiro, Resolvido, Encerrado); categoria por aplicativo ou assunto; mensagem de confirmação configurável; o destino de menu **Abrir protocolo** e a palavra **PROTOCOLO**, que registram o pedido sem colocar a conversa na fila humana; a prévia da última mensagem na lista de conversas; e os **Modelos de atendimento**, que preenchem menus, setores, categorias, prazo e textos de uma vez. O contrato completo está em [Central de atendimento por modelo](CENTRAL-ATENDIMENTO.md).

Dois textos mudam para todos: a consulta do cliente e as notificações dos aplicativos passam a chamar os estados antigos de **Recebido**, **Em análise** e **Encerrado** (antes Aberto, Em andamento e Concluído), e a mensagem enviada quando a equipe está ausente passa a trazer a confirmação configurável depois das instruções de ausência. Aplicativos 0.13 continuam funcionando; os estados novos aparecem neles como texto neutro até a atualização do aplicativo. Nada muda em canais, Hermes, QR ou Zernio.

## Atualização 0.15.0: servidor MCP para o Hermes Agent

Use **Sistema e atualizações → Verificar atualização → Atualizar Wabotia**. Não há migração de banco. A instalação passa a publicar um servidor MCP em `POST /api/mcp`, no mesmo Worker do painel, para o Hermes Agent e outros clientes MCP usarem conversas, protocolos, agenda, conhecimento, bots, presença, eventos, relatórios e o roteador como ferramentas nativas. Cada ferramenta chama a rota equivalente da API v1 com a chave de aplicação do cliente, com as mesmas permissões, namespaces, idempotência e limites por minuto.

Depois de atualizar, abra **Integrações → Ferramentas do Wabotia no Hermes Agent (MCP)**, crie a aplicação e a chave e cole o bloco `mcp_servers` no `config.yaml` do perfil Hermes, com a chave no `.env`. Chaves já emitidas também funcionam, com as permissões que tiverem. Nada muda para quem não configurar o Hermes; o endpoint recusa sessões de usuário e tokens dos aplicativos. [Ferramentas e detalhes do protocolo](API.md#mcp-para-o-hermes-agent).

## Atualização 0.16.0: plugin do Hermes, instalação mais simples e atendimento após o protocolo

Use **Sistema e atualizações → Verificar atualização → Atualizar Wabotia**. Não há migração de banco nem mudança de Durable Object.

**Muda para todas as instalações ao atualizar:**

- **Telegram removido.** A equipe atende pelo painel e pelos aplicativos. A conexão Telegram, o espelho das conversas no grupo, os comandos e o vínculo de ID em Pessoas deixam de existir. Uma conexão Telegram antiga aparece em **Hermes e canais** apenas para ser excluída. Quem usava o Telegram com a equipe deve migrar para o painel ou os aplicativos antes de atualizar.
- **Assinatura de quem escreve.** Mensagens de texto de pessoas e bots chegam ao cliente com a primeira linha **Nome - Humano** ou **Nome - IA**. Confira os nomes em Pessoas e acessos e na Equipe Bot; para desligar, use **Regras de atendimento → Identificar quem escreve**.
- **Bot continua respondendo com a equipe ausente.** Com a conversa na fila e ninguém presente, o Bot Atendente responde às novas mensagens com o que já foi informado (protocolo e prazo), sem tirar a conversa da fila. Desligue em Regras de atendimento se preferir o silêncio de antes.
- **Digitando.** Linhas Zernio mostram "digitando…" enquanto o bot prepara a resposta; no WhatsApp isso marca a mensagem do cliente como lida.

**Passa a existir, sem efeito para quem não usar:**

- **Hermes por plugin.** Em **Hermes e canais → Conectar Hermes**, a opção **Plugin no Hermes** gera um comando para a máquina do Hermes e dispensa túnel, Access, domínio e chaves do Hermes no Wabotia. Conexões por URL continuam como estão. [Contrato e limites](HERMES-PLUGIN.md).
- **Autorização de notificações** com os botões Autorizo / Não autorizo depois que um protocolo é aberto, somente com as notificações de protocolo ligadas.
- **Liga/desliga do protocolo aberto na ausência da equipe.**
- **Instalação:** link que abre o token da Cloudflare preenchido, link de primeiro acesso e o [instalador pelo navegador](INSTALACAO.md#caminho-a-pelo-navegador-sem-nodejs-nem-terminal), disponível só no site oficial.

As regras de atendimento novas estão em [Central de atendimento](CENTRAL-ATENDIMENTO.md).

## Atualização 0.16.1: painel com um único modo

Use **Sistema e atualizações → Verificar atualização → Atualizar Wabotia**. Não há migração de banco e o servidor não muda. O seletor **Simplificado / Avançado** deixa de existir no menu de Gestão e nas preferências: Consentimentos, Execuções de bots, Entregas de mensagens e Eventos para sistemas aparecem sempre, assim como o ID de conexões e bots. Quem usava o modo simplificado passa a ver essas páginas; nenhuma configuração é alterada. A Configuração guiada continua disponível.

## Atualização 0.16.2: guia do site e textos do painel

Use **Sistema e atualizações → Verificar atualização → Atualizar Wabotia**. Não há migração de banco e o servidor não muda. A página `/install` passa a começar pelo instalador pelo navegador, com o terminal como caminho alternativo, ganha a seção de Regras de atendimento e atalhos para o guia em PDF, que foi refeito (65 páginas). No painel, o aviso depois de **Descobrir bots** cita **Atendente e especialistas** e os botões **Parear novamente** e **Revogar plugin** deixam de aparecer colados. Depois de atualizar, clique em **Reabrir painel atualizado** para carregar as telas novas.

## Atualização 0.16.4: aviso de fila, privacidade do bot e memória por conversa

Use **Sistema e atualizações → Verificar atualização → Atualizar Wabotia**. Não há migração de banco e o servidor não muda. O cliente passa a ser avisado toda vez que a conversa entra na fila; antes, uma segunda transferência na mesma sessão (depois de uma pessoa atender e devolver a conversa ao bot) não enviava nada. Quem já está na fila e já foi avisado não recebe o aviso repetido. Em **Equipe → Bots**, cada pessoa vê só as execuções que ela mesma pediu ao bot; o registro completo continua em **Execuções de bots**, para administradores. O Wabotia envia ao Hermes uma chave de sessão por conversa de cliente, por conversa interna e por pessoa, para o bot não misturar a memória de contatos diferentes. Com o plugin de saída, a chave só é repassada pelo plugin 1.1.0: siga o passo a passo [Atualizar o plugin](HERMES-PLUGIN.md#21-atualizar-o-plugin) no servidor do Hermes. Com o plugin anterior tudo continua funcionando, sem a separação de memória.

## Atualização 0.16.5: comandos do plugin na janela de pareamento

Use **Sistema e atualizações → Verificar atualização → Atualizar Wabotia**. Não há migração de banco e o servidor não muda. Em **Conexões**, a janela aberta por **Gerar comando de instalação** ou **Parear novamente** traz, em **Meu Hermes roda em Docker**, os comandos para descobrir o nome do contêiner, instalar o plugin, reiniciar o contêiner e conferir a versão instalada, cada um com botão de copiar. Em uma conexão já pareada, a janela avisa que os bots ficam fora do ar entre a execução do comando e o reinício do gateway. O plugin continua na versão 1.1.0; quem já o atualizou não precisa repetir. O roteiro completo está em [Atualizar o plugin](HERMES-PLUGIN.md#21-atualizar-o-plugin). Depois de atualizar, clique em **Reabrir painel atualizado**.

## Atualização 0.17.1: excluir conexões Hermes e de IA

Use **Sistema e atualizações → Verificar atualização → Atualizar Wabotia**. Não há migração de banco e nada muda na Cloudflare. Em **Hermes e canais**, o cartão de uma conexão Hermes ou de provedor de IA pausada ganha **Excluir conexão**, que apaga a conexão, os bots dela e a chave guardada; conversas, mensagens e execuções anteriores continuam no histórico. A exclusão é recusada, dizendo onde trocar, enquanto um bot da conexão for o Bot Atendente, especialista, item de menu, bot de uma linha ou estiver atendendo uma conversa, e enquanto houver execução em andamento. No Hermes por plugin, o token deixa de valer. O limite do pacote de atualização sobe de 20 MB para 24 MB; como as instalações até a 0.17.0 aceitam no máximo 20 MB, esta versão continua abaixo disso. Depois de atualizar, clique em **Reabrir painel atualizado**.

## Atualização 0.17.0: bot por provedor de IA, sem Hermes

Use **Sistema e atualizações → Verificar atualização → Atualizar Wabotia**. Não há migração de banco e nada muda na Cloudflare. Em **Hermes e canais → Nova conexão**, o serviço **Provedor de IA (sem servidor)** liga o Wabotia direto à Anthropic, à OpenAI, à DeepSeek ou a uma API compatível com a OpenAI, com uma chave de API: sem VPS, Docker ou Hermes. O formulário busca os modelos da conta e permite escolher o esforço de raciocínio. **Testar conexão** cria o bot, que pode ser Atendente, bot de linha, destino de transferência e conversa com a equipe; ele só conversa, então não pode ser especialista nem item de menu do tipo bot. A opção **Apenas mensagens**, ligada por padrão, responde a áudio e vídeo com um aviso pedindo texto e mantém a conversa com o bot. As conexões Hermes não mudam. O custo é cobrado pelo provedor, por uso. Detalhes em [Bot por provedor de IA](PROVEDOR-IA.md). Depois de atualizar, clique em **Reabrir painel atualizado**.

## Atualização 0.16.6: uma só conversa com cada bot

Use **Sistema e atualizações → Verificar atualização → Atualizar Wabotia**. Não há migração de banco. A tela do bot (**Pergunte ao bot**, no painel e nos aplicativos) e a conversa interna com o mesmo bot guardavam históricos separados, e cada aplicativo abria um deles. A pergunta feita pela tela do bot passa a ser gravada na conversa interna da pessoa com esse bot: os dois caminhos mostram a mesma conversa, em qualquer aparelho, e a memória do bot no Hermes é uma só para ela. Cada pessoa continua com a própria conversa, que os colegas não veem; por isso essas perguntas deixam de aparecer para o administrador em **Execuções de bots**. Arquivos devolvidos pelo bot aparecem na tela do bot; a conversa interna mostra só o texto. As perguntas diretas anteriores não são migradas: continuam na tela do bot, fora da conversa interna. Os aplicativos publicados não precisam de versão nova.

## Atualização 0.16.3: política de privacidade e teste de notificações

Use **Sistema e atualizações → Verificar atualização → Atualizar Wabotia**. Não há migração de banco e o servidor não muda. O site ganha a página `/privacidade`, com a política de privacidade dos aplicativos Android e iOS, e um link para ela no rodapé. Em **Notificações dos aplicativos**, o botão **Enviar teste** passa a mostrar quantos aparelhos aceitaram o teste; antes dizia sempre que não havia dispositivo registrado, mesmo com a notificação entregue. Os aplicativos 0.17.0 (sem ligações ao vivo) estão no repositório, mas não fazem parte desta atualização.
