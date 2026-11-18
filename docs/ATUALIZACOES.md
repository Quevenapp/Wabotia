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

## Próxima versão: bots internos (rascunho)

- **Cache de prompt e PDF no bot de provedor de IA** ([PROVEDOR-IA.md](PROVEDOR-IA.md)):
  - migração aditiva `0090_bot_runs_uso.sql` (coluna `bot_runs.usage`, com os tokens de cada execução em **Registros**);
  - a opção **O modelo entende PDF** na conexão, para Anthropic e OpenAI.
- **Instruções personalizadas do bot: não precisa mexer.** O texto que você escreveu vai ao modelo igual.
  - Muda só a ordem do que o Wabotia acrescenta: menus, ações e categorias de protocolo vão num bloco "dados da área" antes do ponto de cache.
  - A situação da conversa (sem menu, retomada) vai depois do ponto de cache.
  - As respostas devem ser as mesmas. Se uma instrução sua dizia "veja o menu acima", ela continua valendo, porque os menus seguem antes da conversa.
- **OpenAI pela Responses API:** conserta o bot com ferramentas (módulos, `decidir` do JEV) nos modelos atuais da OpenAI.
  - Na 0.21.0 ele falhava em `gpt-6.1-terra` e `gpt-6.1-sol`, que só chamam ferramentas pela Responses API, e em `gpt-6-luna` com raciocínio ligado.
  - Nada muda na conexão: mesma chave, mesmo modelo.
  - O esforço ganha **Máximo**.
  - Não testado contra a API real.

## Atualização 0.21.0: acesso por pessoa, segundo fator, ERP em implantação, fila mais rápida

Use **Sistema e atualizações → Verificar atualização → Atualizar Wabotia**. Faça backup antes: esta versão aplica as migrações `0059` a `0089` e acrescenta a flag de compatibilidade `global_fetch_strictly_public` ao Worker (o atualizador a aplica sozinho). Não há recurso novo na Cloudflare. Depois de atualizar, clique em **Reabrir painel atualizado**.

**Licença.** A partir da 0.21.0 o servidor e o painel são distribuídos sob AGPL-3.0; `mobile/`, `connectors/` e `push-gateway/` seguem MIT. As versões até a 0.20.0 continuam sob MIT. O painel mostra o link do código-fonte do commit em execução.

**O pacote da instalação não traz mais os guias em PDF.** Eles continuam no site oficial, e as páginas apontam para lá. O Worker passou a ser publicado minificado. O pacote tem 23,7 MB, perto do teto de 24 MB do formato atual.

**Acesso por pessoa**, em **Gestão → Pessoas e acessos**: cada pessoa vê só os módulos e papéis que recebeu (só caixa, só garçom, só técnico). Quem não tem acesso recebe `403 access_denied`.

**Segundo fator (TOTP)** em **Minha conta**, com política opcional por instalação, e **e-mail** pelo Cloudflare Email Sending (convite, "esqueci minha senha" e alertas), configurado em **Gestão → Sistema → E-mail**.

**Bot que age pelo sistema:** a equipe pede ao bot, na conversa interna, para consultar e executar ações em nome dela, com confirmação antes de gravar; o cliente pode pedir pelo WhatsApp o que os módulos liberarem, e pedidos de desconto vão à equipe para aprovação.

**Módulos:** Mesas e Entrega em tempo real (o entregador entra pelo QR do pedido, sem login), endereço da entrega com cidade e UF, e o cadastro do **Estabelecimento** com endereço em campos e posição da loja.

**Fila de senhas mais rápida:** emitir e chamar senha fazem 2 idas ao banco em vez de 16; o painel de TV mostra em destaque a senha que está sendo falada.

**ERP (em implantação, desligado de fábrica).** O módulo **ERP** traz para dentro do Wabotia os cadastros, o estoque, o financeiro e os documentos do Fagoo, com os dados guardados na própria conta Cloudflare. Nesta versão já funcionam produtos e preços, lançamentos e conferência de estoque, contas a pagar e a receber, caixa, borderôs, dados da empresa, permissões, preferências, exportação da empresa e a gravação de propostas, pedidos de venda, pedidos de compra e ordens de serviço. Mudar a situação de um documento, lançar contas a partir dele, clientes e fornecedores, fiscal, cobrança bancária e frente de caixa ainda não estão nesta versão; as telas correspondentes ficam fora do menu ou avisam que a ação está em implantação. Ligue em **Gestão → Módulos** e dê um papel do ERP a cada pessoa em **Pessoas e acessos**. Aplicações podem receber os escopos `erp:read` e `erp:write`, com papel de consulta, vendas, estoque ou fiscal.

**O plano pago do Cloudflare (Workers Paid) passa a ser exigido.** Na 0.20.0 ele era recomendado para os verticais; a partir da 0.21.0 é requisito para rodar o Wabotia. No plano gratuito, o alarme de cada área e a conclusão do carrinho passam de 50 consultas ao D1 por invocação e param no meio, com parte já gravada. Quem está no gratuito deve assinar o Workers Paid na [página de planos do Workers](https://dash.cloudflare.com/?to=/:account/workers/plans); a instalação não muda e nada precisa ser refeito. O instalador pelo navegador pede a confirmação do plano antes de criar qualquer recurso: ele não confere o plano pela API, porque isso exigiria dar ao token acesso aos dados de cobrança da conta. Detalhes em [Limites do Cloudflare](LIMITES.md).

**Cupom da senha configurável**, em **Gestão → Filas e guichês → Cupom da senha**: cada área liga ou desliga os dados do estabelecimento, a posição na fila, uma mensagem de rodapé e o QR do WhatsApp. Quando o QR não pode sair, o cartão diz o motivo: área sem linha de WhatsApp ou linha sem número registrado. Os aparelhos pareados recebem a mudança na hora; os aplicativos precisam da versão que lê o cupom (contrato em [Fila de espera com senha](FILA-SENHAS.md#cupom-da-senha)). Os aplicativos atuais continuam imprimindo como antes, e o QR desligado já some neles.

**QR do cupom mais simples para quem não está acostumado:** o WhatsApp abre com "Aperte ENVIAR para ser chamado pelo WhatsApp.", a senha com o código e um link para `/api/public/imagemwa`, cuja prévia mostra uma seta no botão de enviar. Cupons impressos antes continuam valendo. A prévia aparece depois do envio; no rascunho, depende do aplicativo do WhatsApp (a Meta não documenta).

**Botão com link no lugar do link solto** na linha oficial (Zernio): avisos e segunda via da Mensalidade, reenvio da cobrança do contrato e do Suporte avulso, e os itens de menu de link e de aplicativo. No Pix, o código copia e cola vem sozinho na mensagem seguinte. Na linha QR e fora da janela de 24 horas, a mensagem continua com o link no texto. O passo web e a Cobrança já usavam o botão. Lista completa em [WhatsApp pela Zernio](ZERNIO-WHATSAPP.md#onde-o-wabotia-usa-o-botão-com-link).

## Atualização 0.20.0: módulos, cobrança e verticais

Faça backup e use **Sistema e atualizações → Verificar atualização → Atualizar Wabotia**. Esta versão traz as migrações aditivas `0020` a `0058`, aplicadas pelo próprio atualizador. Elas criam as tabelas dos módulos e nenhum dado existente é apagado ou convertido. Não há Worker, banco, bucket nem Durable Object novos; nada muda na Cloudflare. Depois de atualizar, clique em **Reabrir painel atualizado**.

**Recomendação: plano pago do Cloudflare para usar os verticais.** No plano gratuito cada invocação pode fazer 50 consultas ao D1. O atendimento sozinho cabe nisso, mas com os módulos ligados o alarme da área com trabalho acumulado e a conclusão do carrinho com Pix passam de 50. Quando isso acontece, a invocação para no meio: o trabalho do alarme atrasa e se repete, e no carrinho o cliente pode ficar com o pedido criado e sem a cobrança. O plano pago (Workers Paid) aceita 1000 consultas por invocação. As medições e as alternativas para caber no gratuito estão em [Limites do Cloudflare](LIMITES.md).

**Módulos**, em **Gestão → Módulos**: cada um é ligado por área de atendimento e vem desligado, exceto a Fila nas instalações que já a usavam. Desligado, o módulo some do menu, do painel, dos aplicativos e das ferramentas dos bots. O contrato para integrações está em [Módulos](MODULOS.md).

- **Fila presencial:** a fila com senha da 0.18 passa a ser um módulo; quem já a usava continua com ela ligada. [Fila de espera com senha](FILA-SENHAS.md).
- **Formulários:** formulário enviado pela conversa como passo web (abaixo), com as respostas guardadas na conversa.
- **Agenda:** o cliente marca, confirma, remarca ou cancela horário pelo WhatsApp, com lembrete; a equipe vê o dia e a semana. [Agenda](AGENDA.md).
- **Ordem de Serviço:** entrada do item, orçamento aprovado ou recusado pelo WhatsApp e aviso de pronto, separados dos protocolos. [Ordem de Serviço](ORDEM-DE-SERVICO.md).
- **Reserva:** quartos, chalés, quadras e salões, com sinal por Pix ou link, check-in online, lembrete e mensagem de saída. [Reserva](RESERVA.md).
- **Pedido:** cardápio no menu do WhatsApp, carrinho numa página leve, quadro da cozinha e aviso a cada mudança de estado. [Pedido](PEDIDO.md).
- **Mensalidade:** planos, assinaturas e parcelas, com o Pix enviado antes do vencimento e a baixa só pela confirmação do Mercado Pago, contratação de plano pelo WhatsApp e pagadores por CPF/CNPJ com telefones autorizados. [Mensalidade](MENSALIDADE.md).
- **Suporte pago:** atendimento humano só depois de conferir o pagamento; quem não está em dia paga ali mesmo, compra suporte avulso ou contrata um plano, e a IA continua grátis. Exige a Mensalidade. [Suporte pago](SUPORTE.md).

**Passo web e carrinho.** Os módulos e a equipe mandam ao cliente um link curto, de uso único e com prazo, para preencher um formulário ou montar um carrinho no celular. Na linha oficial, o formulário pode ir como Flow do WhatsApp. A resposta volta à conversa e conclui o passo sem abrir o menu.

**Cobrança com Mercado Pago**, em **Gestão → Automação → Cobrança**: Pix (com o código copia e cola) e link de pagamento pela conversa, pela equipe ou pelos módulos. Um pagamento só é dado como pago depois do webhook assinado e da consulta ao Mercado Pago; "já paguei" ou o comprovante enviado pelo cliente nunca mudam o estado. Estorno e pagamento em duplicidade viram pendência para a equipe. O Access Token e a assinatura ficam cifrados. [Cobrança](COBRANCA.md).

**Recursos interativos da Zernio:** lista, botão com URL, carrossel, pedido de localização, produto e catálogo, Flows (criar, publicar e enviar) e o recebimento de formulário, endereço e carrinho. Em linha QR, cada um tem um equivalente em texto. [Integração Zernio](ZERNIO-WHATSAPP.md#mensagens-interativas-flows-e-catálogo).

**Muda para todas as instalações ao atualizar:**

- **Listas só como mensagem interativa** nas linhas Zernio, sem o texto numerado junto. Vale para os menus e a fila já publicados.
- **Consentimento por finalidade.** Notificações fora da janela de 24 horas com uma finalidade (cobrança, agendamento, pedido ou reserva) só saem com o consentimento dessa finalidade, registrado com data, módulo e evidência. A notificação de protocolo continua usando o consentimento de antes. REVOGAR revoga todas as finalidades.
- **Mensalidade:** atendente cadastra assinatura começando hoje e sem fim; início em outra data e fim da assinatura passam a ser só do administrador (ou de integração com `billing:write`). Assinatura com o fim já passado não deixa mais o pagador "em dia".
- **Avisos pela API:** uma integração que não atende a conversa remarca, cancela, muda o estado ou envia orçamento sem avisar o cliente, e não manda o link do check-in. Pessoas da equipe continuam avisando como antes.
- **Revisão de segurança.** A revisão de novembro encontrou 23 achados (4 altos, 8 médios, 11 baixos), a conferência trouxe mais 13 e a segunda conferência mais 5; todos estão corrigidos e têm teste. Entre as mudanças:
  - as ferramentas MCP montam o caminho só com identificadores;
  - a confirmação de pagamento é entregue até concluir;
  - CPF/CNPJ digitado nunca vincula telefone a um pagador;
  - dados pessoais e notas exigem `contacts:read` e `notes:read`;
  - operações financeiras de integrações exigem a permissão nova `billing:write`, que o painel nunca dá ao Vinki nem ao Fagoo;
  - o webhook do Mercado Pago só aceita a consulta assinada.
  
  O endereço público da instalação fica fixo depois do primeiro valor e só o administrador troca, em **Gestão → Sistema**. Tabela completa em [Revisão de segurança](SEGURANCA-REVISAO-2026-11.md).

**Para quem usa o Hermes com as ferramentas do Wabotia (MCP).** A chave criada em **Integrações → Ferramentas do Wabotia no Hermes Agent** passa a levar a permissão nova `conversations:bound`. Com ela, as ferramentas só alcançam as conversas que um bot da aplicação está atendendo (ou atendeu nos últimos 2 minutos), e o painel exige escolher o bot. Eventos, relatórios, presença e as outras conversas da área ficam de fora; para uma chave de área inteira, marque essa opção ao gerar a chave.

**Chave do Hermes criada antes desta versão: confira depois de atualizar.** Ela continua alcançando todas as conversas da área, e um cliente que convença o bot pode levá-lo até a conversa de outro. Nada é rebaixado sozinho. Passo a passo:

1. Abra **Integrações**. No topo, **Chaves de bot com acesso a toda a área** lista essas aplicações.
2. Toque em **Prender às conversas do bot** (recomendado). A mesma chave continua valendo: no Hermes, com plugin ou por URL, não há nada a trocar no `.env` nem no `config.yaml`.
3. No Hermes, envie `/reload-mcp` numa sessão aberta, ou reinicie o gateway, e confira com `hermes mcp test wabotia`.
4. Se o Hermes precisa mesmo da área inteira (relatórios, um bot interno que não atende clientes), toque em **Manter a área inteira**.

Detalhes em [MCP para o Hermes Agent](API.md#mcp-para-o-hermes-agent).

**Aplicativos.** Os aplicativos Android e iOS com modo aparelho (totem, painel e guichê), as verticais e a impressão de cupom estão no repositório ([mobile/README.md](../mobile/README.md)), mas não fazem parte desta atualização do servidor e saem pelas lojas à parte. Os aplicativos publicados continuam funcionando com esta versão.

**Ainda não validado com contas reais.** Os testes automáticos usam respostas simuladas do WhatsApp e do Mercado Pago. Antes de usar com clientes, confira numa área de teste:

- **Mercado Pago com uma conta real:**
  - o Pix criado com o e-mail configurado e o vencimento no horário de Brasília;
  - o link do Checkout Pro com prazo;
  - o webhook chegando com assinatura válida;
  - os estados de Pix vencido e de estorno;
  - **Testar credenciais**.
  
  A lista completa está em [Cobrança](COBRANCA.md#o-que-só-uma-conta-real-confirma).
- **Numa linha Zernio real:**
  - a exibição das listas e demais interativos, agora sem o texto numerado, inclusive nos menus e na fila já publicados;
  - o botão com URL e o código copia e cola da cobrança;
  - os Flows publicados e a resposta deles;
  - o carrinho e o formulário abertos no celular do cliente.
- **CPU no plano gratuito:** a medição de consultas está em [Limites do Cloudflare](LIMITES.md); o tempo de CPU não foi medido, e cardápios grandes são os primeiros candidatos a passar de 10 ms.

## Atualização 0.19.3: resumo no protocolo já aberto

Use **Sistema e atualizações → Verificar atualização → Atualizar Wabotia**. Não há migração de banco. Com a equipe ausente, cada conversa tem um protocolo aberto por vez; quando o bot transfere de novo e já existe um, o cliente recebe o mesmo número e o resumo do novo pedido entra nesse protocolo como nota interna ("Nova solicitação nesta conversa"), visível só para a equipe. Depois de atualizar, clique em **Reabrir painel atualizado**.

## Atualização 0.19.2: bot segue o atendimento, avaliação e notificações de protocolo

Use **Sistema e atualizações → Verificar atualização → Atualizar Wabotia**. Não há migração de banco e nada muda na Cloudflare.

- **O bot não volta ao menu** quando o cliente responde a uma pergunta dele; se ainda assim escolher o menu, o Wabotia pede a resposta de novo, sem o menu.
- **Avaliação depois do protocolo de ausência** (Regras de atendimento, desligada por padrão): depois da confirmação do protocolo e da pergunta de autorização, o cliente recebe o pedido de nota.
- **Notificações de protocolo pelo WhatsApp** agora se ligam em Regras de atendimento, com o nome e o idioma do modelo aprovado. Ligadas, o cliente recebe a pergunta de autorização ao abrir um protocolo.

Depois de atualizar, clique em **Reabrir painel atualizado**.

## Atualização 0.19.1: níveis de raciocínio, fila sem tempo de espera, bot de IA no menu

Use **Sistema e atualizações → Verificar atualização → Atualizar Wabotia**. Esta versão traz a migração de banco `0019_queue_wait_off.sql`, aplicada pelo próprio atualizador; nada muda na Cloudflare.

- **Esforço de raciocínio**: a conexão de provedor de IA lista todos os níveis de cada provedor (DeepSeek: Sem raciocínio, Baixo, Alto, Máximo; Anthropic: Baixo a Máximo; OpenAI: de Sem raciocínio a Muito alto). Em Muito alto e Máximo cada resposta pode levar até 3 minutos.
- **Fila**: o tempo de espera mostrado ao cliente pode ser **Desligado**; o WhatsApp, o painel e o totem mostram só quantas pessoas estão à frente. O Senhapp precisa tratar a ausência do tempo.
- **Cumprimentos**: um "Olá" respondido pelo bot não transfere mais para a equipe nem abre protocolo.
- **Menu**: um item do tipo bot pode apontar para um bot de provedor de IA, que assume a conversa a partir da opção escolhida.

Depois de atualizar, clique em **Reabrir painel atualizado**.

## Atualização 0.19.0: protocolo fácil de digitar, bot com a equipe ausente, Conhecimento editável

Use **Sistema e atualizações → Verificar atualização → Atualizar Wabotia**. Esta versão traz a migração de banco `0018_knowledge_usage.sql`, aplicada pelo próprio atualizador; nada muda na Cloudflare.

- **Protocolos novos só com dígitos**, em sequência a partir de 10001. O cliente consulta digitando o número (aceita `protocolo 10001`, `#10001`, espaços e pontos). Os protocolos antigos mantêm o número `WA-…` e continuam consultáveis, inclusive digitados em minúsculas ou com espaço.
- **Com a equipe ausente, devolver a conversa ao bot** (Regras de atendimento, desligado por padrão): o protocolo é aberto, a conversa sai da fila e o Bot Atendente continua atendendo; a equipe acompanha pelo protocolo.
- **Bot com conexão pausada não recebe conversas**: o cliente segue para o menu ou para a equipe. O protocolo aberto com a equipe ausente usa o resumo do bot ou o pedido do cliente como assunto, nunca uma mensagem de erro interna.
- **Resumo ao transferir**: o Bot Atendente pergunta o que falta e, ao passar para a equipe, escreve um resumo do pedido, que vira nota interna e, com a equipe ausente, o assunto do protocolo.
- **Como o atendimento começa**, em Quem atende cada linha: menu primeiro, bot primeiro ou sem menu.
- **Renomear bot** em Atendente e especialistas, e **editar fontes do Conhecimento**, com o campo "Quando e como o bot pode usar".

Depois de atualizar, clique em **Reabrir painel atualizado**.

## Atualização 0.18.0: fila de espera com senha, Senhapp, excluir setores

Use **Sistema e atualizações → Verificar atualização → Atualizar Wabotia**. Esta versão traz a migração de banco `0017_queue.sql`, aplicada pelo próprio atualizador; nada muda na Cloudflare.

- **Fila de espera com senha:** em **Gestão → Filas e guichês**, crie filas e guichês, ligue a fila no WhatsApp (item de menu do tipo fila e, se quiser, porta de entrada em que qualquer mensagem abre o menu), configure painéis de TV e a lista negra. A equipe chama, rechama e transfere senhas na área **Fila**; o painel de TV fica em `/painel`. Detalhes em [Fila de espera com senha](FILA-SENHAS.md).
- **Senhapp:** o quadro de Integrações passa a ser **Parear Senhapp** (totem, painel ou guichê). Códigos do Vinki e do Fagoo são recusados pelo painel; os pareamentos já feitos continuam funcionando e podem ser revogados ali.
- **Excluir setor**, em **Menus e ações → Setores de atendimento**: recusado enquanto um item de menu usa o setor; as conversas abertas dele voltam para a fila geral.
- **DeepSeek:** o esforço de raciocínio pode ser Sem raciocínio, Baixo (padrão) ou Alto. Conexões DeepSeek já cadastradas raciocinam em Alto até serem editadas e salvas; abra a conexão e salve para passar a Baixo.

Depois de atualizar, clique em **Reabrir painel atualizado**.

## Atualização 0.17.1: excluir conexões Hermes e de IA

Use **Sistema e atualizações → Verificar atualização → Atualizar Wabotia**. Não há migração de banco e nada muda na Cloudflare. Em **Hermes e canais**, o cartão de uma conexão Hermes ou de provedor de IA pausada ganha **Excluir conexão**, que apaga a conexão, os bots dela e a chave guardada; conversas, mensagens e execuções anteriores continuam no histórico. A exclusão é recusada, dizendo onde trocar, enquanto um bot da conexão for o Bot Atendente, especialista, item de menu, bot de uma linha ou estiver atendendo uma conversa, e enquanto houver execução em andamento. No Hermes por plugin, o token deixa de valer. O limite do pacote de atualização sobe de 20 MB para 24 MB; como as instalações até a 0.17.0 aceitam no máximo 20 MB, esta versão continua abaixo disso. Depois de atualizar, clique em **Reabrir painel atualizado**.

## Atualização 0.17.0: bot por provedor de IA, sem Hermes

Use **Sistema e atualizações → Verificar atualização → Atualizar Wabotia**. Não há migração de banco e nada muda na Cloudflare. Em **Hermes e canais → Nova conexão**, o serviço **Provedor de IA (sem servidor)** liga o Wabotia direto à Anthropic, à OpenAI, à DeepSeek ou a uma API compatível com a OpenAI, com uma chave de API: sem VPS, Docker ou Hermes. O formulário busca os modelos da conta e permite escolher o esforço de raciocínio. **Testar conexão** cria o bot, que pode ser Atendente, bot de linha, destino de transferência e conversa com a equipe; ele só conversa, então não pode ser especialista nem item de menu do tipo bot. A opção **Apenas mensagens**, ligada por padrão, responde a áudio e vídeo com um aviso pedindo texto e mantém a conversa com o bot. As conexões Hermes não mudam. O custo é cobrado pelo provedor, por uso. Detalhes em [Bot por provedor de IA](PROVEDOR-IA.md). Depois de atualizar, clique em **Reabrir painel atualizado**.

## Atualização 0.16.6: uma só conversa com cada bot

Use **Sistema e atualizações → Verificar atualização → Atualizar Wabotia**. Não há migração de banco. A tela do bot (**Pergunte ao bot**, no painel e nos aplicativos) e a conversa interna com o mesmo bot guardavam históricos separados, e cada aplicativo abria um deles. A pergunta feita pela tela do bot passa a ser gravada na conversa interna da pessoa com esse bot: os dois caminhos mostram a mesma conversa, em qualquer aparelho, e a memória do bot no Hermes é uma só para ela. Cada pessoa continua com a própria conversa, que os colegas não veem; por isso essas perguntas deixam de aparecer para o administrador em **Execuções de bots**. Arquivos devolvidos pelo bot aparecem na tela do bot; a conversa interna mostra só o texto. As perguntas diretas anteriores não são migradas: continuam na tela do bot, fora da conversa interna. Os aplicativos publicados não precisam de versão nova.

## Atualização 0.16.3: política de privacidade e teste de notificações

Use **Sistema e atualizações → Verificar atualização → Atualizar Wabotia**. Não há migração de banco e o servidor não muda. O site ganha a página `/privacidade`, com a política de privacidade dos aplicativos Android e iOS, e um link para ela no rodapé. Em **Notificações dos aplicativos**, o botão **Enviar teste** passa a mostrar quantos aparelhos aceitaram o teste; antes dizia sempre que não havia dispositivo registrado, mesmo com a notificação entregue. Os aplicativos 0.17.0 (sem ligações ao vivo) estão no repositório, mas não fazem parte desta atualização.
