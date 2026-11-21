# Atualização direta, sem repositório próprio

## 18/11/2026 — Máscara de dados pessoais por bot

Nova opção por bot, ligada também para bots existentes: documentos, telefones, e-mails e CEPs reconhecidos viram marcadores nas mensagens, histórico, ferramentas e JEV. O servidor restaura os valores nas ferramentas, propostas e respostas. O extrator de PDF lê object streams, xref streams, conteúdos Flate, ToUnicode e Differences com acentos portugueses; ignora logos e recusa páginas sem texto. Mantém os tetos de 4 MB, 10 páginas, 64 streams, 8 MiB descomprimidos, 200 mil caracteres e profundidade 32. Sem dependência nova nem migração.

**O que muda nas instalações existentes:** o modelo passa a ver marcadores como `[CPF_1]` no lugar dos valores. PDFs legíveis seguem como texto mascarado. Quando a leitura falha, o padrão continua sendo encaminhar à equipe; a nova opção `pdf_raw_fallback` permite enviar o PDF inteiro sem máscara, se a conexão aceitar PDF e os tetos de tamanho/páginas forem atendidos. A nova opção `image_to_team` permite encaminhar fotos e imagens à equipe em vez do provedor; desligada, elas continuam cruas. As duas começam desligadas, aparecem abaixo da máscara e só têm efeito com ela ligada. Também é possível desligar a própria máscara por bot. Detalhes em [Dados pessoais e IA](API.md#dados-pessoais-e-ia).

Desde a versão 0.3, novas instalações baixam um pacote oficial já preparado e publicam diretamente na sua conta Cloudflare. Não precisam de conta GitHub, cópia do repositório, Cloudflare Builds ou Deploy Hook. O código continua aberto no repositório oficial; uma versão só aparece no painel depois que seu pacote foi publicado pelo mantenedor.

## Retirada do Hermes: servidor e painel

O MCP HTTP e a porta para agente externo foram removidos. O Vinki trabalha com bots internos, conectados diretamente a um provedor de IA. A API v1 e a execução de bots por aplicação continuam disponíveis. Nas chaves, `conversations:all` deixa de valer. Uma chave antiga presa às conversas do bot (`conversations:bound`) fica sem permissão nenhuma em vez de ganhar a área inteira: emita uma chave nova se a integração ainda precisar dela. Quando a remoção automática apaga uma conexão do Hermes criada pela preparação na Cloudflare, as ações de especialista guardadas desligadas para os bots dela também saem; refaça-as num especialista interno. `conversations:bound` fica reservado ao ator interno do bot.

A migração `0094_retira_cloudflare.sql` apaga a autorização da preparação Cloudflare e as credenciais dos jobs. As conexões criadas por esses jobs são pausadas e marcadas como **sendo removidas**; o processamento periódico as remove sozinho, preservando o histórico. Não podem ser religadas durante a remoção. O token das atualizações automáticas é independente e continua funcionando.

**Os recursos que o Vinki criou na sua conta Cloudflare não somem com a retirada. Revogue-os no painel da Cloudflare: aplicação Access, service token, túnel e registros DNS.** Os nomes e IDs ficam no aviso **Hermes retirado**, em Conexões, mesmo depois da remoção local. Nenhum segredo é copiado para esse aviso.

## Usar o botão

1. Abra **sua instalação → Sistema e atualizações**.
2. Clique **Verificar atualização**. A consulta é armazenada por cinco minutos.
3. Confira a versão e clique **Atualizar Vinki**.
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

A versão `0.12.0` simplifica o painel para **Área de atendimento → Integração Zernio → Telefones**. Cada instalação recebe automaticamente uma área compartilhada pela equipe, sem etapa de cadastro ou seleção. Nas instalações existentes, o Vinki reutiliza o atendimento e mantém dados, permissões e credenciais; se não houver área, ela é preparada no primeiro acesso administrativo. Não há migração de banco nesta versão. Instalações antigas com várias áreas mantêm acesso aos dados anteriores, sem fusão automática nem ampliação de permissões.

A versão `0.12.1` acrescenta à tela **Integração Zernio** links e instruções para obter a API key, copiar o ID da integração e definir o segredo do webhook. Depois de salvar, o painel orienta o cadastro da URL em Webhooks da Zernio. É uma atualização de ajuda da interface, sem migração de banco ou alteração das credenciais existentes.

## Autorização Cloudflare

O instalador configura automaticamente a atualização com o token usado na instalação. Para renovar, abra **Alterar configuração de atualização**, cole um token com **Workers Scripts: Edit** limitado à conta da instalação e salve. O servidor confere a identidade do Worker antes de aceitar o token. Ele é criptografado e nunca aparece nas consultas do painel.

O token inicial também possui D1/R2 para criar os recursos. Depois de instalar, você pode substituí-lo por um token com somente **Workers Scripts: Edit** e revogar o inicial. Essa permissão permite publicar Workers na conta autorizada; escolha uma conta adequada ao projeto e guarde a credencial em local privado.

Enquanto o atualizador usa o token inicial, o painel avisa **Token inicial em uso**. Depois de salvar o token só de Workers, o inicial continua guardado no Worker como reserva; o painel oferece **Apagar o token inicial**, que apaga esse segredo do Worker usando o token do painel. Depois disso não há reserva: se o token do painel for revogado, a atualização para até você salvar outro. Revogue também o inicial na Cloudflare (**My Profile → API Tokens**).

Informar ou trocar o token e apagar o inicial são feitos só pela pessoa administradora, na própria sessão (nunca por um bot agindo por ela); apagar o inicial pede o segundo fator quando a pessoa tem um ou a política pede. Contrato: `POST /api/v1/system/updates/initial-token/delete` com `{"confirmed":true}` e `Idempotency-Key`; `GET /api/v1/system` traz `updates.token_source` (`panel`, `initial` ou `null`) e `updates.initial_token_stored`.

### Colar o token a cada atualização

Opção para não deixar token da Cloudflare guardado na instalação. Em **Colar o token a cada atualização**, a pessoa administradora cola um token com **Workers Scripts: Edit** e confirma. O servidor confere o token contra a identidade da instalação, apaga o token salvo no painel e o token inicial do Worker, e desliga a atualização automática, que precisa de token guardado.

Depois disso, cada atualização pede o token. Ele é conferido antes de criar o trabalho e fica cifrado, preso àquele trabalho, só enquanto o trabalho está em andamento e por até 60 minutos (o maior salto medido levou cerca de 10). Ao terminar, falhar, ser cancelado, ficar sem confirmação ou vencer o prazo, o token é apagado; uma nova tentativa é um trabalho novo e pede o token de novo.

Isso encolhe a janela de sempre para minutos por atualização. Não protege contra código rodando no Worker durante esses minutos. Para voltar a guardar o token, salve um em **Alterar configuração de atualização**. Quando o Fiscal tem cofre configurado, o painel sugere este modo.

Ligar o modo e iniciar uma atualização nele são feitos só pela pessoa administradora, na própria sessão, com o segundo fator quando ela tem um ou a política pede. Contrato: `POST /api/v1/system/updates/token-mode` com `{"token":"…","confirmed":true}`; nesse modo, `POST /api/v1/system/updates/start` leva `{"commit":"…","token":"…"}`. `updates.token_source` vale `per_update`.

### Cofre do certificado na mesma conta

Com o cofre do certificado e o Vinki na mesma conta Cloudflare, quem conseguir executar código no Worker do Vinki, ou obtiver o token de atualização, alcança também o cofre. A Cloudflare não oferece token restrito a um único Worker. As medidas de proteção (o token só digitado por pessoa, o token restrito no lugar do inicial, o modo "não guardar o token") reduzem essa chance; não a eliminam.

Opcional: quem quiser separar de vez pode manter o cofre numa conta Cloudflare própria. Custa uma segunda conta e não é necessário para usar o Vinki.

## Se houver falha

- **Falha antes de publicar:** leia a mensagem, corrija token/permissão e libere nova tentativa. Um pacote inválido não é ativado.
- **Publicação sem confirmação:** confira o Worker em **Cloudflare → Implantações** e o endereço `/api/health`. Não repita enquanto pode estar em andamento. O painel permite liberar após 15 minutos, com confirmação de que a publicação anterior terminou.
- **Token expirado:** salve um novo token no painel. Não altere MASTER_KEY.
- **Migração falhou:** a transação da migração e seu recibo são revertidos. O código novo não é ativado. Corrija a versão/configuração antes de repetir.
- **Painel inacessível:** preserve a pasta privada criada pelo instalador. Uma recuperação manual deve usar a configuração e os secrets originais; não execute uma instalação nova sobre recursos existentes.

Faça backup antes de atualizar. Não há rollback automático de dados.

## Reinstalação

Instalações criadas pelo fluxo antigo (cópia do repositório com Cloudflare Builds e Deploy Hook) não são mais atualizadas pelo painel: esse caminho saiu do código. Para adotar o fluxo direto, siga [INSTALACAO.md](INSTALACAO.md) com uma instalação nova. Use nome novo, guarde a instalação antiga até conferir a nova e reconecte o Hermes existente. Não crie outro túnel para os mesmos endereços. O histórico não é importado automaticamente. Pare os canais antigos antes de ligá-los na instalação nova; cada número deve ter um único consumidor.

## Publicar uma versão oficial (mantenedor)

Toda versão sai no **formato 2, assinada** (Ed25519). O formato, a assinatura, o prazo do índice, a troca de chaves e o ensaio estão em [ATUALIZACOES-FORMATO.md](ATUALIZACOES-FORMATO.md). Rode na cópia que guarda o catálogo publicado (`public/releases/`).

1. **Uma vez por máquina:** aponte a chave de assinatura. Crie `release-signing.local.json` na raiz (já está no `.gitignore`) com `{"key": "D:\\Code\\Env\\wabotia\\chaves-release\\principal.pem"}`, ou defina `WABOTIA_RELEASE_KEY` com esse caminho. A chave fica fora do repositório; nunca a copie para o projeto, para um segredo de CI ou para uma variável do Worker.
2. Execute tipos, testes e homologação. Atualize a versão (maior que a publicada) e o manual. Faça commit do código.
3. Execute `npm run release`. O script:
   - produz o instalador, o Worker minificado e os arquivos web;
   - grava `releases/<versão>/manifest.json` e `manifest.sig`, os arquivos em `releases/blobs/`, e o índice `releases/v2/latest.json` com `latest.sig`, válido por 90 dias;
   - para se faltar a chave, se a chave não estiver em `src/release-keys.json`, se a versão não for maior que a publicada e que a de `releases/latest.json`, ou se a mesma versão já tiver sido publicada com outro conteúdo.

   Toda versão depois da ponte exige a ponte instalada (`requires.min_version`); outra exigência sai com `--min-version x.y.z`, e o plano Workers Paid com `--workers-paid`.

   **Só uma vez, na versão ponte (0.21.1):** `npm run release -- --bridge` (ou `--bridge --slim`). Grava também o pacote de formato 1 que a 0.21.0 lê, aponta `releases/latest.json` para a ponte e registra `releases/v2/bridge.json`. Antes de publicar, rode `node scripts/erp/check-candidate.mjs public/releases/0.21.1`, que passa o pacote pelo leitor da própria 0.21.0. Detalhes, tamanhos e a saída de emergência em [ATUALIZACOES-FORMATO.md](ATUALIZACOES-FORMATO.md#versão-ponte-0211).
4. Publique o site oficial com Wrangler, preservando as pastas das versões já publicadas, `releases/blobs/`, `releases/v2/` e `releases/latest.json`. Esse último é o índice do formato antigo: congelado na ponte, o script só o escreve com `--bridge`, e ele não deve ser apagado (as instalações 0.21.0 e anteriores o leem).
5. Valide a instalação e uma atualização real em staging. GitHub Actions permanece desativado.
6. **Sem versão nova em 90 dias:** antes do vencimento, rode `npm run release -- --renew` e publique o site. A partir de 60 dias, o próprio `npm run release` avisa, e a tela Sistema do site oficial também. Com o índice vencido, as instalações recusam atualizar ("o mantenedor precisa renová-lo"), mas o atendimento continua normal.

Pacotes e instalador gerados não são enviados ao Git. Guarde os artefatos das versões publicadas em backup. Para conferir um pacote sem publicar, use `npm run release -- --candidate`: ele sai **sem assinatura** em `output/release-candidate/` e as instalações recusam. O build só de teste (`--test-origin`) é para o ensaio em staging e nunca vai ao site oficial.

Referência do protocolo: [upload direto de arquivos Cloudflare](https://developers.cloudflare.com/workers/static-assets/direct-upload/).


## Atualização 0.5.0: WhatsApp

Faça backup antes. A migração `0006_whatsapp.sql` adiciona metadados, uploads por partes, grupos, recibos e ligações; não importa nem apaga histórico. O pacote oficial contém o painel e o Worker. O processo QR ou o transporte Hermes **não** é atualizado pelo botão do painel: siga o [roteiro de atualização dos conectores](WHATSAPP.md#primeiro-atualize-os-dois-lados), preservando sessões, perfil e diários. O contrato novo é protocolo 2; conectores antigos não devem ser usados para as funções novas.

Habilitar chamadas Meta ou grupos elegíveis é uma configuração posterior no provedor e no painel; a atualização não solicita essas permissões automaticamente. A homologação com número real fica para o roteiro final do guia.

## Atualização 0.6.0: roteador de números

Faça backup e use **Sistema e atualizações → Verificar atualização → Atualizar Vinki**. A migração aditiva `0007_number_router.sql` cria contas Meta, grupos, permissões e contadores, mantendo conexões e histórico existentes. Ela não conecta números reais nem altera webhooks na Meta. Não é preciso reinstalar, criar outro túnel ou mudar Hermes/QR para usar o roteador Meta direto; os conectores 0.5 continuam adequados.

Depois, abra **Roteador de números** e siga o [guia da WABA, webhook e consumo inicial](ROTEADOR.md). Adotar um número já conectado exige pausa e entregas reconciliadas/confirmadas. A cobrança de modelos só é permitida por pedidos explícitos; notificações automáticas desses números não viram modelos pagos. O pacote oficial atualiza a Cloudflare, sem reconfigurar o aplicativo Meta.

## Atualização 0.6.1: conexão Meta e guia do primeiro número

Use **Sistema e atualizações → Verificar atualização → Atualizar Vinki**. Esta revisão corrige uma opção de requisição incompatível com Workers, que impedia consultas à Meta e o download de anexos. Redirecionamentos continuam recusados sem encaminhar os tokens a outro endereço. Após atualizar, repita **Buscar números na Meta**, que é uma consulta. Não repita mensagens com resultado incerto sem conferir a entrega anterior.

Não há nova migração nem necessidade de reinstalar, trocar tokens ou refazer o webhook. O [guia ilustrado Meta](META-WHATSAPP.md) está no site, no PDF específico e no manual completo.

## Atualização 0.6.3: navegação entre telas do painel

Corrige a tela em branco ao abrir Conversas depois de Conexões ou Protocolos. Cada tela mostra somente os registros do perfil, da página e da paginação atuais; respostas de consultas anteriores não substituem uma consulta mais recente. Não há migração de banco nem alteração das conexões Meta. Atualize em **Sistema e atualizações** e reabra o painel.

## Atualização 0.7.0: função e permissões por número

Em **Roteador de números → Uso por número → Função e permissões**, escolha **Atendimento oficial**, **Integração com janela de 24 horas (Vinki V4)** ou ajuste cada opção: respostas de serviço, templates, atendentes, aplicações externas, menu, bots e grupos. As restrições valem para painel, Telegram e API; grupos e aplicações não podem ampliar as permissões do número. Alterações são verificadas novamente antes da entrega e bloqueiam respostas de bots desativados. Recebimento, histórico, contadores e webhooks são preservados.

O contador de templates entregues aparece separado do teto de serviço. Nenhuma função autoriza cobrança automática ou cria uma janela de 24 horas. Os números existentes mantêm o comportamento anterior até o administrador salvar suas opções. Não há migração de banco, novas credenciais ou alteração na Meta; esta atualização não ativa canais nem o perfil. Consulte [as opções e exemplos de uso](ROTEADOR.md#31-defina-o-que-cada-número-pode-fazer).

## Atualização 0.8.0: aplicativos Android e iOS

Faça backup e use **Sistema e atualizações → Verificar atualização → Atualizar Vinki**. A migração aditiva `0008_mobile.sql` cria as tabelas de dispositivos, cursores de push e alertas de protocolo e acrescenta colunas à tabela de sessões; conversas, agenda, credenciais e histórico são preservados. Os aplicativos exigem esta versão: cada pessoa informa o endereço do seu servidor no aplicativo e entra com o e-mail e a senha de **Pessoas**; o token de sessão `wabu_` é separado das chaves de aplicação e não amplia o acesso de integrações.

Depois de atualizar, abra **Sistema e atualizações → Notificações dos aplicativos** e escolha o modo: **Gateway Vinki** (padrão, sem entregar credenciais Firebase ao gateway), **FCM direto** (conta de serviço própria, para quem compila o próprio aplicativo) ou **Desligado**. Com o conteúdo **mínimo**, nomes e trechos de mensagens não passam pelo gateway. Use **Enviar teste** após entrar no aplicativo. Sem configurar, os aplicativos funcionam em primeiro plano, sem push. Nada muda em canais, Hermes, QR ou Meta. Consulte [o guia dos aplicativos](MOBILE.md).

## Atualização 0.14.0: central de atendimento por modelo

Faça backup e use **Sistema e atualizações → Verificar atualização → Atualizar Vinki**. A migração aditiva `0016_service_center.sql` acrescenta a categoria e a origem dos protocolos, o estado "aguardando a descrição do protocolo" nas conversas e índices de consulta; nenhum protocolo, conversa ou configuração existente é alterado. Quem não usa os recursos novos continua com o comportamento da 0.13: prazo em horas corridas, sem categorias e sem modelo aplicado.

O que passa a existir, tudo opcional: prazo da primeira resposta em dias úteis com horário e feriados; seis estados de protocolo (Recebido, Em análise, Aguardando cliente, Aguardando terceiro, Resolvido, Encerrado); categoria por aplicativo ou assunto; mensagem de confirmação configurável; o destino de menu **Abrir protocolo** e a palavra **PROTOCOLO**, que registram o pedido sem colocar a conversa na fila humana; a prévia da última mensagem na lista de conversas; e os **Modelos de atendimento**, que preenchem menus, setores, categorias, prazo e textos de uma vez. O contrato completo está em [Central de atendimento por modelo](CENTRAL-ATENDIMENTO.md).

Dois textos mudam para todos: a consulta do cliente e as notificações dos aplicativos passam a chamar os estados antigos de **Recebido**, **Em análise** e **Encerrado** (antes Aberto, Em andamento e Concluído), e a mensagem enviada quando a equipe está ausente passa a trazer a confirmação configurável depois das instruções de ausência. Aplicativos 0.13 continuam funcionando; os estados novos aparecem neles como texto neutro até a atualização do aplicativo. Nada muda em canais, Hermes, QR ou Zernio.

## Atualização 0.15.0: servidor MCP para o Hermes Agent

Use **Sistema e atualizações → Verificar atualização → Atualizar Vinki**. Não há migração de banco. A instalação passa a publicar um servidor MCP em `POST /api/mcp`, no mesmo Worker do painel, para o Hermes Agent e outros clientes MCP usarem conversas, protocolos, agenda, conhecimento, bots, presença, eventos, relatórios e o roteador como ferramentas nativas. Cada ferramenta chama a rota equivalente da API v1 com a chave de aplicação do cliente, com as mesmas permissões, namespaces, idempotência e limites por minuto.

Depois de atualizar, abra **Integrações → Ferramentas do Vinki no Hermes Agent (MCP)**, crie a aplicação e a chave e cole o bloco `mcp_servers` no `config.yaml` do perfil Hermes, com a chave no `.env`. Chaves já emitidas também funcionam, com as permissões que tiverem. Nada muda para quem não configurar o Hermes; o endpoint recusa sessões de usuário e tokens dos aplicativos. [Ferramentas e detalhes do protocolo](API.md#mcp-para-o-hermes-agent).

## Atualização 0.16.0: plugin do Hermes, instalação mais simples e atendimento após o protocolo

Use **Sistema e atualizações → Verificar atualização → Atualizar Vinki**. Não há migração de banco nem mudança de Durable Object.

**Muda para todas as instalações ao atualizar:**

- **Telegram removido.** A equipe atende pelo painel e pelos aplicativos. A conexão Telegram, o espelho das conversas no grupo, os comandos e o vínculo de ID em Pessoas deixam de existir. Uma conexão Telegram antiga aparece em **Hermes e canais** apenas para ser excluída. Quem usava o Telegram com a equipe deve migrar para o painel ou os aplicativos antes de atualizar.
- **Assinatura de quem escreve.** Mensagens de texto de pessoas e bots chegam ao cliente com a primeira linha **Nome - Humano** ou **Nome - IA**. Confira os nomes em Pessoas e acessos e na Equipe Bot; para desligar, use **Regras de atendimento → Identificar quem escreve**.
- **Bot continua respondendo com a equipe ausente.** Com a conversa na fila e ninguém presente, o Bot Atendente responde às novas mensagens com o que já foi informado (protocolo e prazo), sem tirar a conversa da fila. Desligue em Regras de atendimento se preferir o silêncio de antes.
- **Digitando.** Linhas Zernio mostram "digitando…" enquanto o bot prepara a resposta; no WhatsApp isso marca a mensagem do cliente como lida.

**Passa a existir, sem efeito para quem não usar:**

- **Hermes por plugin.** Em **Hermes e canais → Conectar Hermes**, a opção **Plugin no Hermes** gera um comando para a máquina do Hermes e dispensa túnel, Access, domínio e chaves do Hermes no Vinki. Conexões por URL continuam como estão. [Contrato e limites](HERMES-PLUGIN.md).
- **Autorização de notificações** com os botões Autorizo / Não autorizo depois que um protocolo é aberto, somente com as notificações de protocolo ligadas.
- **Liga/desliga do protocolo aberto na ausência da equipe.**
- **Instalação:** link que abre o token da Cloudflare preenchido, link de primeiro acesso e o [instalador pelo navegador](INSTALACAO.md#caminho-a-pelo-navegador-sem-nodejs-nem-terminal), disponível só no site oficial.

As regras de atendimento novas estão em [Central de atendimento](CENTRAL-ATENDIMENTO.md).

## Atualização 0.16.1: painel com um único modo

Use **Sistema e atualizações → Verificar atualização → Atualizar Vinki**. Não há migração de banco e o servidor não muda. O seletor **Simplificado / Avançado** deixa de existir no menu de Gestão e nas preferências: Consentimentos, Execuções de bots, Entregas de mensagens e Eventos para sistemas aparecem sempre, assim como o ID de conexões e bots. Quem usava o modo simplificado passa a ver essas páginas; nenhuma configuração é alterada. A Configuração guiada continua disponível.

## Atualização 0.16.2: guia do site e textos do painel

Use **Sistema e atualizações → Verificar atualização → Atualizar Vinki**. Não há migração de banco e o servidor não muda. A página `/install` passa a começar pelo instalador pelo navegador, com o terminal como caminho alternativo, ganha a seção de Regras de atendimento e atalhos para o guia em PDF, que foi refeito (65 páginas). No painel, o aviso depois de **Descobrir bots** cita **Atendente e especialistas** e os botões **Parear novamente** e **Revogar plugin** deixam de aparecer colados. Depois de atualizar, clique em **Reabrir painel atualizado** para carregar as telas novas.

## Atualização 0.16.4: aviso de fila, privacidade do bot e memória por conversa

Use **Sistema e atualizações → Verificar atualização → Atualizar Vinki**. Não há migração de banco e o servidor não muda. O cliente passa a ser avisado toda vez que a conversa entra na fila; antes, uma segunda transferência na mesma sessão (depois de uma pessoa atender e devolver a conversa ao bot) não enviava nada. Quem já está na fila e já foi avisado não recebe o aviso repetido. Em **Equipe → Bots**, cada pessoa vê só as execuções que ela mesma pediu ao bot; o registro completo continua em **Execuções de bots**, para administradores. O Vinki envia ao Hermes uma chave de sessão por conversa de cliente, por conversa interna e por pessoa, para o bot não misturar a memória de contatos diferentes. Com o plugin de saída, a chave só é repassada pelo plugin 1.1.0: siga o passo a passo [Atualizar o plugin](HERMES-PLUGIN.md#21-atualizar-o-plugin) no servidor do Hermes. Com o plugin anterior tudo continua funcionando, sem a separação de memória.

## Atualização 0.16.5: comandos do plugin na janela de pareamento

Use **Sistema e atualizações → Verificar atualização → Atualizar Vinki**. Não há migração de banco e o servidor não muda. Em **Conexões**, a janela aberta por **Gerar comando de instalação** ou **Parear novamente** traz, em **Meu Hermes roda em Docker**, os comandos para descobrir o nome do contêiner, instalar o plugin, reiniciar o contêiner e conferir a versão instalada, cada um com botão de copiar. Em uma conexão já pareada, a janela avisa que os bots ficam fora do ar entre a execução do comando e o reinício do gateway. O plugin continua na versão 1.1.0; quem já o atualizou não precisa repetir. O roteiro completo está em [Atualizar o plugin](HERMES-PLUGIN.md#21-atualizar-o-plugin). Depois de atualizar, clique em **Reabrir painel atualizado**.

## Próxima versão: bots internos (rascunho)

- **Cache de prompt e PDF no bot de provedor de IA** ([PROVEDOR-IA.md](PROVEDOR-IA.md)):
  - migração aditiva `0090_bot_runs_uso.sql` (coluna `bot_runs.usage`, com os tokens de cada execução em **Registros**);
  - a opção **O modelo entende PDF** na conexão, para Anthropic e OpenAI.
- **Instruções personalizadas do bot: não precisa mexer.** O texto que você escreveu vai ao modelo igual.
  - Muda só a ordem do que o Vinki acrescenta: menus, ações e categorias de protocolo vão num bloco "dados da área" antes do ponto de cache.
  - A situação da conversa (sem menu, retomada) vai depois do ponto de cache.
  - As respostas devem ser as mesmas. Se uma instrução sua dizia "veja o menu acima", ela continua valendo, porque os menus seguem antes da conversa.
- **OpenAI pela Responses API:** conserta o bot com ferramentas (módulos, `decidir` do JEV) nos modelos atuais da OpenAI.
  - Na 0.21.0 ele falhava em `gpt-6.1-terra` e `gpt-6.1-sol`, que só chamam ferramentas pela Responses API, e em `gpt-6-luna` com raciocínio ligado.
  - Nada muda na conexão: mesma chave, mesmo modelo.
  - O esforço ganha **Máximo**.
  - Não testado contra a API real.

## Atualização 0.24.0: novos canais, módulos lançando no ERP, Ordem de Serviço por modelo e venda com NF-e

Exige a 0.21.1 ou posterior (pacote assinado). Faça backup, use **Sistema e atualizações → Verificar atualização → Atualizar Vinki** e acompanhe até o fim; depois clique em **Reabrir painel atualizado**. Ela aplica 11 migrações aditivas (`0135`, `0140` a `0147`, `0150` e `0151`) e não cria recurso novo na Cloudflare: nenhum banco, fila, bucket ou classe de Durable Object. O banco do ERP de cada área também se atualiza sozinho, só com tabelas novas. Se o painel ficar na mesma etapa por mais de 15 minutos, siga a [saída de emergência](ATUALIZACOES-FORMATO.md#saída-de-emergência-trabalho-preso-em-atualizando).

**Quem só usa WhatsApp não vê diferença.** O atendimento pelo WhatsApp continua igual, com os mesmos menus, modelos, janela e módulos; as conversas abertas por aplicações de integração também. A única novidade nessas áreas é a ação **Enviar conversa por e-mail**, para quem tem a permissão.

**Instagram e Facebook.** As mensagens diretas das contas empresariais entram na mesma caixa de entrada, com o selo do canal no canto da foto. A conta é importada em **Conexões → Integração Zernio → Buscar contas na Zernio**, com as credenciais da integração Zernio que você já usa. Conversas antigas não são importadas. Nas primeiras 24 horas depois da última mensagem do cliente, vale tudo: texto, mídia e automação. Até 7 dias, só texto escrito por uma pessoa da equipe. Depois disso, o envio fica bloqueado. Menus usam até 3 botões ou 13 respostas rápidas; o que não couber vira texto numerado. Agenda, Pedido, cobrança e os demais módulos continuam só no WhatsApp.

**Um cliente, vários canais.** A ficha do contato mostra os canais da pessoa. Na web, **Juntar com outro contato** une duas fichas com prévia e confirmação, e dá para desfazer enquanto nada mudou depois. O sistema nunca junta sozinho por nome ou foto.

**Enviar conversa por e-mail.** Manda a conversa para o seu e-mail, para o do contato ou, se o administrador permitir, para um endereço digitado. Antes do envio aparece uma prévia. Notas internas nunca vão junto, e documentos sensíveis aparecem só pelo nome. O envio usa o e-mail configurado em **Gestão → Sistema → E-mail**. Administradores começam autorizados; bots não exportam conversas.

**Comentários, Telegram, avaliações do Google, TikTok e e-mail.** Estes canais aparecem no catálogo de conexões abrindo o painel em `/app?canais=2`; abrir o catálogo não liga nada.
- **Comentários do Instagram e do Facebook:** cada publicação e autor vira uma conversa. A pessoa da equipe responde em público ou no privado. A resposta privada sai uma vez só, até 7 dias depois do comentário. O bot nunca responde em público. É preciso ligar os comentários na conexão.
- **Telegram:** funciona com o seu próprio bot, só em conversa privada. O token fica guardado cifrado e aparece apenas como "configurado".
- **Avaliações do Google:** ficam na área **Avaliações**, na web, sem abrir conversa. Uma pessoa autorizada responde; a IA só sugere o texto. Avaliações anteriores à ativação não são trazidas.
- **TikTok:** mensagens diretas iniciadas pelo cliente, com resposta em texto ou uma imagem. A resposta precisa sair em até 48 horas, com no máximo 10 envios a cada 48 horas.
- **E-mail como canal:** o recebimento depende de uma regra de Email Routing que o dono cria à mão na Cloudflare. O guia está em [E-mail como canal](CANAIS-EMAIL-RECEBIMENTO.md). Nesta versão o canal ainda não pode ser ativado: o envio, inclusive o e-mail do teste de recebimento, espera a confirmação do formato do provedor.

**Módulos lançando no financeiro e no estoque do ERP (desligado de fábrica).** Ordem de Serviço, Pedido, Mesas, Entrega, Mensalidade, Agenda, Reserva e Suporte avulso passam a gerar a parte comercial no ERP: documento, contas a receber, recebimentos e baixa de estoque. **O lançamento automático vem desligado.** Enquanto o administrador não ligar, cada venda, parcela ou recebimento fica como pendência de lançamento manual. Para ligar, abra **ERP → Integrações** (no grupo Comercial) → **Padrões comerciais da área**, marque **Lançar financeiro automaticamente** e/ou **Lançar estoque automaticamente**, escolha a categoria de receita, a forma de pagamento, a conta de baixa e o depósito, que precisam já existir, e clique em **Salvar padrões**. A escolha vale só daqui para a frente: o que aconteceu antes não é lançado. Cada destino precisa da parte correspondente do ERP (Financeiro ou Estoque) ligada.
- **Ordem de serviço:** lança na primeira execução, com orçamento aprovado ou preço fixo autorizado. Entregar a ordem não significa pagamento.
- **Agenda:** cobra só quando você pede ou ao concluir um atendimento com preço.
- **Reserva:** separa sinal e saldo.
- **Mensalidade:** lança cada parcela.
- **Mesas:** fechar a conta não cria uma segunda venda.

O atendimento não espera o ERP. Uma falha vira pendência visível, com **Tentar novamente**. Bots não fazem esses lançamentos.

**Ordem de Serviço por modelo.** A Ordem de Serviço tem uma entrada só, pelo botão **ERP**, e uma lista só, com a ordem clássica e os modelos próprios juntos. A lista filtra por **Modelo**, situação, responsável e prazo, e tem **Meus prazos** no topo. "Tipo de trabalho" passa a se chamar **Modelo**. **Configurar** ganha as abas **Modelos**, **WhatsApp** e **Prazos e garantia**. Um modelo pode começar do zero ou de um exemplo, sem aplicar a área inteira.
- **Objeto do serviço:** o veículo, equipamento, imóvel, animal ou evento é cadastrado uma vez e fica ligado ao cliente. Cada ordem guarda uma cópia do que era verdade naquela visita: a quilometragem de 60.000 km continua 60.000 km. O objeto tem tela própria, com o histórico de ordens e o último atendimento, e aparece na ficha do contato. No link do WhatsApp, o cliente escolhe "Qual veículo?" entre os dele.
- **Campos obrigatórios por etapa:** um campo pode ser exigido ao entrar numa etapa ou ao sair dela. Na oficina, por exemplo, a quilometragem é pedida ao sair de Recebido.
- **Colunas e filtros:** até quatro campos próprios podem virar coluna e filtro da lista. Campo sensível nunca vira.
- **Festas e eventos:** modelo novo, que usa o evento (data, tema e local) como objeto.

Ordens antigas não mudam. Os aplicativos continuam funcionando como antes. Uma mudança de etapa que deixe faltar um campo exigido é recusada com uma mensagem clara.

**Comercial do ERP.** Cinco telas que estavam em implantação voltam ao menu:
- **Meu negócio**, com painéis de venda e metas;
- **Cobrança operacional** e **Retornos operacionais**, para gerar o arquivo de remessa de boletos que você mesmo envia ao banco e conferir o retorno; importar o retorno não baixa nada sozinho;
- **Registro de atividades** e **Consulta de exclusões**, em Sistema.

Em **Preferências → Importações** dá para importar por planilha produtos, fornecedores de produto, composições, campos customizados, lotes, contatos, pedidos de compra e de venda, movimentações de estoque e contas a receber e a pagar. Há prévia antes de confirmar, até 10.000 linhas por arquivo. Pedidos importados não baixam estoque nem geram contas, e as contas entram abertas, sem baixa. Notas fiscais por planilha ainda não.

**Venda com NF-e pela NFapi.** Num pedido de venda salvo do ERP, use **Preparar NF-e**, confira e **Emitir NF-e**. Depois dá para consultar ou retomar a emissão, abrir o DANFE e o XML e cancelar com justificativa. O certificado e a senha ficam no cofre da NFapi e nunca passam pelo Vinki. No ERP você informa só o endereço e a chave do cofre, em Preferências, e a chave fica guardada cifrada. Tudo começa em homologação. Produção só depois de **Habilitar produção**, com confirmação do administrador. Vale para venda nacional de mercadorias (modelo 55). Ficam de fora NFC-e, NFS-e, devolução, carta de correção e inutilização. IBS/CBS/IS não são calculados, e a operação que os exija é bloqueada. Pedidos vindos dos módulos ainda não emitem nota por aqui. Revise a configuração com o seu contador antes da primeira nota: veja [Venda com NF-e](COMERCIAL-NFE.md).

**Receber dados do Bling.** Em **ERP → Sistema → Receber dados do Bling**, desligado de fábrica. O Vinki lê a sua conta do Bling e guarda um acervo de consulta histórica. Não cria cadastros, pedidos, contas nem saldos no ERP e não grava nada no Bling. Você usa um aplicativo próprio no Bling, e as credenciais ficam cifradas. Antes da primeira coleta real, siga o [roteiro da primeira coleta](RECEBER-BLING-PRIMEIRA-COLETA.md): cada recurso só é coletado depois de conferido na documentação oficial do Bling.

**Backup do ERP em partes (base, ainda sem botão).** O backup do banco do ERP de cada área foi refeito em partes e sai inteiro em qualquer tamanho. Enquanto ele lê o banco, as alterações do ERP daquela área ficam suspensas e as consultas continuam. Medido na Cloudflare, isso leva cerca de 5 minutos por GiB. A restauração confere tudo antes e troca o banco de uma vez: ou ele fica igual ao backup, ou como estava. Nesta versão ela cobre até 64 MiB de dados exportados; acima disso a medição na Cloudflare mostrou que a troca não cabe na memória. A restauração de bancos maiores fica para a próxima versão. XML e anexos ficam no armazenamento de arquivos, fora desse backup. O backup e a restauração do ERP ainda não têm botão no painel nem rota para quem administra: a recuperação continua sendo a recuperação no tempo da Cloudflare (até 30 dias).

**Bots no ERP.** O administrador pode liberar, por bot e por área, operações do ERP com nome próprio: Meu negócio, registro de atividades, cobrança por arquivo, importação por planilha, NF-e e Receber dados do Bling. O bot só as usa na conversa interna com a pessoa da equipe, nunca com cliente. A lista começa vazia e, ao liberar, aparece o aviso de que dados irão ao provedor de IA. Para gravar algo ou fazer uma leitura sensível, o bot propõe e a pessoa confirma, com segundo fator quando a política pede. A opção de deixar o bot fazer sozinho uma leitura sensível também começa vazia. O bot nunca ganha mais poder que a pessoa. Por enquanto essas liberações só são feitas pela API de bots; a tela vem depois.

**Cobrança bancária.** Uma conta a receber que está numa remessa de teste cancela normalmente. Numa remessa real, ela só cancela quando alguém declara que o boleto já foi baixado no banco. A declaração guarda o motivo, quem fez e quando, e exige o papel financeiro e o segundo fator da política financeira. Por enquanto essa declaração só é feita pela API; a tela do Financeiro ainda não a oferece.

Esta versão foi verificada por testes automáticos, por revisão de código e por um ensaio numa instalação de teste, não por uso em atendimento real. Nada foi testado contra os serviços reais: Zernio, Meta, Telegram, Google, TikTok, envio e recebimento de e-mail, o cofre da NFapi (só contra um cofre simulado, sem homologação na SEFAZ), o Bling e o banco. Os formatos desses provedores ainda estão a conferir com conta real. Nascem desligados o lançamento automático dos módulos no ERP, o recebimento do Bling, a Fiscal e a NF-e em produção, as operações do ERP liberadas a bots e a leitura sensível autônoma. O canal de e-mail ainda não pode ser ativado. A restauração do ERP cobre até 64 MiB de dados exportados e não tem entrada no painel. Ainda faltam telas para: a declaração de boleto baixado, as liberações de operações do ERP por bot, a leitura autônoma do bot e o backup e a restauração do ERP.

## Atualização 0.23.0: gestão numa casa só, cadastro único e ERP em partes

Exige a 0.21.1 ou posterior (pacote assinado). Faça backup, use **Sistema e atualizações → Verificar atualização → Atualizar Vinki** e acompanhe até o fim; depois clique em **Reabrir painel atualizado**. Ela aplica 5 migrações aditivas (`0130`, `0131`, `0132` e as duas `0133`) e não cria recurso novo na Cloudflare. Se o painel ficar na mesma etapa por mais de 15 minutos, siga a [saída de emergência](ATUALIZACOES-FORMATO.md#saída-de-emergência-trabalho-preso-em-atualizando).

**Gestão numa casa só.** O botão **ERP** do menu passa a ser a entrada de toda a gestão, inclusive Agenda, Trabalhos, Mensalidade, Pedido, Mesas, Reserva e os módulos de área. Ele está sempre no menu: com um módulo ligado, abre direto nele; com vários, mostra um cartão por grupo; com nada ligado, mostra "Nenhum módulo de gestão ligado" e o caminho para a tela Módulos. Os endereços antigos de `/app/gestao/...` continuam valendo e levam ao lugar novo. **Gestão** fica com a administração: Módulos, Pessoas, filas e modelos de área. O nome Fagoo saiu das telas; o ERP continua se chamando ERP.

**Cadastro único.** O contato do atendimento e o cliente do ERP passam a ser a mesma pessoa. Todo número que fala com a empresa vira um contato salvo, com o histórico das conversas, mesmo sem nome; quando a pessoa compra ou é cadastrada, os dados são acrescentados ao mesmo registro, sem criar um segundo. A ficha do contato reúne o que cada módulo ligado sabe sobre a pessoa, e o vocabulário acompanha a área (cliente, paciente, aluno, condômino). Dados sensíveis continuam fora do WhatsApp, da IA e das exportações comuns.

**ERP em nove partes.** O ERP deixa de ser um módulo só e passa a ter nove partes que se ligam e desligam na tela **Módulos**: Cadastro de clientes (a base), Produtos, Vendas, Compras, Estoque, Financeiro, Fiscal, Cobrança bancária e PDV. Quem já usava o ERP continua com as partes que usava. Parte desligada some das telas, recusa as chamadas e para as rotinas de fundo, e os dados dela ficam guardados para quando for ligada de novo; as outras partes continuam funcionando (documento de venda sem Estoque, Financeiro sem Vendas). Ao desligar algo de que outro módulo depende, a tela mostra a lista do que será desligado junto e pede confirmação. A Fiscal continua sem emissor e vem desligada nos modelos de área.

**Modelos de área.** O modelo de Advocacia passa a ligar o módulo Jurídico. Os modelos mostram as partes do ERP que vão ligar antes de aplicar.

Esta versão foi verificada por testes automáticos e por revisão de código, não por uso em atendimento real. O lançamento automático dos módulos no financeiro e no estoque **não** faz parte dela: fica para a versão seguinte.

## Atualização 0.22.0: módulos por área, bots internos sem Hermes e mais ERP

Exige a 0.21.1 instalada: é a primeira versão no pacote assinado. Faça backup, use **Sistema e atualizações → Verificar atualização → Atualizar Vinki** e acompanhe até o fim; depois clique em **Reabrir painel atualizado**. Ela aplica 24 migrações aditivas (`0090`, `0091`, `0092`, `0094` e `0100` a `0119`) e não cria recurso novo na Cloudflare. Se o painel ficar na mesma etapa por mais de 15 minutos, siga a [saída de emergência](ATUALIZACOES-FORMATO.md#saída-de-emergência-trabalho-preso-em-atualizando).

**Hermes retirado.** O Vinki passa a trabalhar só com bots internos, ligados direto a um provedor de IA. As conexões do Hermes ficam pausadas e são removidas sozinhas, com o histórico preservado; as linhas que atendiam com um bot do Hermes voltam à regra da área, e o Atendente da área que era um bot do Hermes fica vago até você escolher um bot interno. O servidor MCP (`/api/mcp`) e o plugin deixam de funcionar. Os recursos criados na sua conta Cloudflare pela preparação antiga (aplicação Access, service token, túnel e DNS) **não** somem: revogue-os no painel da Cloudflare, pelos nomes do aviso **Hermes retirado**, em Conexões. Detalhes em [Retirada do Hermes](#retirada-do-hermes-servidor-e-painel).

**Bots internos.** Máscara de dados pessoais por bot (ligada também nos bots existentes), leitura de PDF como texto mascarado, com duas opções por bot desligadas de fábrica (mandar ao provedor o PDF que não der para ler; encaminhar imagens à equipe), cache de prompt, o especialista de decisão JEV disponível aos bots internos e a OpenAI pela Responses API, que conserta o bot com ferramentas nos modelos atuais. Detalhes nas seções [Máscara de dados pessoais por bot](#18112026--máscara-de-dados-pessoais-por-bot) e [bots internos](#próxima-versão-bots-internos-rascunho). A Responses API não foi testada nesta versão contra a API real.

**Módulos por área (novo).** A Ordem de Serviço passa a aceitar **tipos de trabalho** por área de atendimento: nome próprio (processo, obra, atendimento, matrícula), campos extras, etapas com mensagem ao cliente, tarefas e prazos, pessoas ligadas, documentos e lançamentos. Quem só usa a Ordem de Serviço de antes não vê diferença. Em **Gestão → Modelos de área** há modelos prontos para advogados e escritórios, engenheiros, arquitetos, construtoras, clínicas médicas e veterinárias, assistência técnica, oficina, lavanderia e costura, serviços, escolas, professores e condomínios, com prévia antes de aplicar; depois de aplicado, tudo é configuração editável. Quatro módulos novos, desligados de fábrica, completam as áreas que pedem mais do que o modelo: **Jurídico** (calendários e prazos em dias úteis), **Condomínio** (unidades, moradores e assembleia), **Saúde** (prontuário, com papel próprio e registro de cada leitura; nada dele vai ao WhatsApp nem à IA) e **Ensino** (turmas, frequência e notas). Guias em [TRABALHOS.md](TRABALHOS.md), [JURIDICO.md](JURIDICO.md), [CONDOMINIO.md](CONDOMINIO.md), [SAUDE.md](SAUDE.md) e [ENSINO.md](ENSINO.md).

Esta parte é nova e foi verificada por testes automáticos e por leitura de código, não por uso em atendimento real. Os textos e as etapas dos modelos são um ponto de partida: revise-os com quem conhece a área antes de usar com clientes. O sistema nunca afirma que um prazo jurídico está certo: mostra o cálculo e pede a conferência do advogado. Os aplicativos Android e iOS atuais mostram os trabalhos pelo estado de base e ainda não exibem etapas nem campos próprios.

**ERP (em implantação, desligado de fábrica).** O servidor do ERP passa a ter completos os documentos (propostas, pedidos e ordens, com mudança de situação e lançamento de contas), o financeiro, o catálogo, o estoque e a frente de caixa, e os primeiros blocos do fiscal. As telas que ainda não têm o servidor correspondente continuam avisando que a ação está em implantação.

**Atualizador.** Botão para liberar uma atualização parada há mais de 30 minutos, nova tentativa de publicação que recomeça da preparação, e mensagens de erro da Cloudflare mais claras. Valem a partir da atualização seguinte a esta.

## Atualização 0.21.1: versão ponte para o pacote assinado

Use **Sistema e atualizações → Verificar atualização → Atualizar Vinki** e acompanhe até o fim; depois clique em **Reabrir painel atualizado**. O atendimento continua no ar durante a atualização. Não há migração de banco nem recurso novo na Cloudflare, e o funcionamento é o da 0.21.0: muda só o atualizador.

**Por que ela existe.** As próximas versões saem em outro formato de pacote, dividido em arquivos e assinado, que a 0.21.0 não sabe ler. A 0.21.1 é o degrau entre os dois: chega no formato antigo e, instalada, só aceita versões assinadas pelo mantenedor. Toda versão depois dela exige a 0.21.1 instalada. Uma instalação na 0.17.0 ou anterior não lê este pacote (já não lia o da 0.21.0) e precisa ser reinstalada.

**Atualize acompanhando.** Com a atualização automática ligada, a 0.21.1 entra sozinha na janela configurada; prefira atualizar à mão desta vez. Se o painel ficar em "Atualizando para 0.21.1" na mesma etapa por mais de 15 minutos, siga a [saída de emergência](ATUALIZACOES-FORMATO.md#saída-de-emergência-trabalho-preso-em-atualizando).

**Limites conhecidos do atualizador desta versão,** que valem só para o salto seguinte e serão corrigidos nele: se duas atualizações forem pedidas quase ao mesmo tempo, a segunda pode sumir da tela e precisar de um novo clique; uma falha ao publicar o código pede **Liberar nova tentativa** à mão, também na atualização automática. Detalhes em [Formato do pacote](ATUALIZACOES-FORMATO.md#versão-ponte-0211).

## Atualização 0.21.0: acesso por pessoa, segundo fator, ERP em implantação, fila mais rápida

Use **Sistema e atualizações → Verificar atualização → Atualizar Vinki**. Faça backup antes: esta versão aplica as migrações `0059` a `0089` e acrescenta a flag de compatibilidade `global_fetch_strictly_public` ao Worker (o atualizador a aplica sozinho). Não há recurso novo na Cloudflare. Depois de atualizar, clique em **Reabrir painel atualizado**.

**Licença.** A partir da 0.21.0 o servidor e o painel são distribuídos sob AGPL-3.0; `mobile/`, `connectors/` e `push-gateway/` seguem MIT. As versões até a 0.20.0 continuam sob MIT. O painel mostra o link do código-fonte do commit em execução.

**O pacote da instalação não traz mais os guias em PDF.** Eles continuam no site oficial, e as páginas apontam para lá. O Worker passou a ser publicado minificado. O pacote tem 23,7 MB, perto do teto de 24 MB do formato atual.

**Acesso por pessoa**, em **Gestão → Pessoas e acessos**: cada pessoa vê só os módulos e papéis que recebeu (só caixa, só garçom, só técnico). Quem não tem acesso recebe `403 access_denied`.

**Segundo fator (TOTP)** em **Minha conta**, com política opcional por instalação, e **e-mail** pelo Cloudflare Email Sending (convite, "esqueci minha senha" e alertas), configurado em **Gestão → Sistema → E-mail**.

**Bot que age pelo sistema:** a equipe pede ao bot, na conversa interna, para consultar e executar ações em nome dela, com confirmação antes de gravar; o cliente pode pedir pelo WhatsApp o que os módulos liberarem, e pedidos de desconto vão à equipe para aprovação.

**Módulos:** Mesas e Entrega em tempo real (o entregador entra pelo QR do pedido, sem login), endereço da entrega com cidade e UF, e o cadastro do **Estabelecimento** com endereço em campos e posição da loja.

**Fila de senhas mais rápida:** emitir e chamar senha fazem 2 idas ao banco em vez de 16; o painel de TV mostra em destaque a senha que está sendo falada.

**ERP (em implantação, desligado de fábrica).** O módulo **ERP** traz para dentro do Vinki os cadastros, o estoque, o financeiro e os documentos do Fagoo, com os dados guardados na própria conta Cloudflare. Nesta versão já funcionam produtos e preços, lançamentos e conferência de estoque, contas a pagar e a receber, caixa, borderôs, dados da empresa, permissões, preferências, exportação da empresa e a gravação de propostas, pedidos de venda, pedidos de compra e ordens de serviço. Mudar a situação de um documento, lançar contas a partir dele, clientes e fornecedores, fiscal, cobrança bancária e frente de caixa ainda não estão nesta versão; as telas correspondentes ficam fora do menu ou avisam que a ação está em implantação. Ligue em **Gestão → Módulos** e dê um papel do ERP a cada pessoa em **Pessoas e acessos**. Aplicações podem receber os escopos `erp:read` e `erp:write`, com papel de consulta, vendas, estoque ou fiscal.

**O plano pago do Cloudflare (Workers Paid) passa a ser exigido.** Na 0.20.0 ele era recomendado para os verticais; a partir da 0.21.0 é requisito para rodar o Vinki. No plano gratuito, o alarme de cada área e a conclusão do carrinho passam de 50 consultas ao D1 por invocação e param no meio, com parte já gravada. Quem está no gratuito deve assinar o Workers Paid na [página de planos do Workers](https://dash.cloudflare.com/?to=/:account/workers/plans); a instalação não muda e nada precisa ser refeito. O instalador pelo navegador pede a confirmação do plano antes de criar qualquer recurso: ele não confere o plano pela API, porque isso exigiria dar ao token acesso aos dados de cobrança da conta. Detalhes em [Limites do Cloudflare](LIMITES.md).

**Cupom da senha configurável**, em **Gestão → Filas e guichês → Cupom da senha**: cada área liga ou desliga os dados do estabelecimento, a posição na fila, uma mensagem de rodapé e o QR do WhatsApp. Quando o QR não pode sair, o cartão diz o motivo: área sem linha de WhatsApp ou linha sem número registrado. Os aparelhos pareados recebem a mudança na hora; os aplicativos precisam da versão que lê o cupom (contrato em [Fila de espera com senha](FILA-SENHAS.md#cupom-da-senha)). Os aplicativos atuais continuam imprimindo como antes, e o QR desligado já some neles.

**QR do cupom mais simples para quem não está acostumado:** o WhatsApp abre com "Aperte ENVIAR para ser chamado pelo WhatsApp.", a senha com o código e um link para `/api/public/imagemwa`, cuja prévia mostra uma seta no botão de enviar. Cupons impressos antes continuam valendo. A prévia aparece depois do envio; no rascunho, depende do aplicativo do WhatsApp (a Meta não documenta).

**Botão com link no lugar do link solto** na linha oficial (Zernio): avisos e segunda via da Mensalidade, reenvio da cobrança do contrato e do Suporte avulso, e os itens de menu de link e de aplicativo. No Pix, o código copia e cola vem sozinho na mensagem seguinte. Na linha QR e fora da janela de 24 horas, a mensagem continua com o link no texto. O passo web e a Cobrança já usavam o botão. Lista completa em [WhatsApp pela Zernio](ZERNIO-WHATSAPP.md#onde-o-wabotia-usa-o-botão-com-link).

## Atualização 0.20.0: módulos, cobrança e verticais

Faça backup e use **Sistema e atualizações → Verificar atualização → Atualizar Vinki**. Esta versão traz as migrações aditivas `0020` a `0058`, aplicadas pelo próprio atualizador. Elas criam as tabelas dos módulos e nenhum dado existente é apagado ou convertido. Não há Worker, banco, bucket nem Durable Object novos; nada muda na Cloudflare. Depois de atualizar, clique em **Reabrir painel atualizado**.

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
  - operações financeiras de integrações exigem a permissão nova `billing:write`, que o painel nunca dá ao Vinki V4 nem ao Fagoo;
  - o webhook do Mercado Pago só aceita a consulta assinada.
  
  O endereço público da instalação fica fixo depois do primeiro valor e só o administrador troca, em **Gestão → Sistema**. Tabela completa em [Revisão de segurança](SEGURANCA-REVISAO-2026-11.md).

**Para quem usa o Hermes com as ferramentas do Vinki (MCP).** A chave criada em **Integrações → Ferramentas do Vinki no Hermes Agent** passa a levar a permissão nova `conversations:bound`. Com ela, as ferramentas só alcançam as conversas que um bot da aplicação está atendendo (ou atendeu nos últimos 2 minutos), e o painel exige escolher o bot. Eventos, relatórios, presença e as outras conversas da área ficam de fora; para uma chave de área inteira, marque essa opção ao gerar a chave.

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

Use **Sistema e atualizações → Verificar atualização → Atualizar Vinki**. Não há migração de banco. Com a equipe ausente, cada conversa tem um protocolo aberto por vez; quando o bot transfere de novo e já existe um, o cliente recebe o mesmo número e o resumo do novo pedido entra nesse protocolo como nota interna ("Nova solicitação nesta conversa"), visível só para a equipe. Depois de atualizar, clique em **Reabrir painel atualizado**.

## Atualização 0.19.2: bot segue o atendimento, avaliação e notificações de protocolo

Use **Sistema e atualizações → Verificar atualização → Atualizar Vinki**. Não há migração de banco e nada muda na Cloudflare.

- **O bot não volta ao menu** quando o cliente responde a uma pergunta dele; se ainda assim escolher o menu, o Vinki pede a resposta de novo, sem o menu.
- **Avaliação depois do protocolo de ausência** (Regras de atendimento, desligada por padrão): depois da confirmação do protocolo e da pergunta de autorização, o cliente recebe o pedido de nota.
- **Notificações de protocolo pelo WhatsApp** agora se ligam em Regras de atendimento, com o nome e o idioma do modelo aprovado. Ligadas, o cliente recebe a pergunta de autorização ao abrir um protocolo.

Depois de atualizar, clique em **Reabrir painel atualizado**.

## Atualização 0.19.1: níveis de raciocínio, fila sem tempo de espera, bot de IA no menu

Use **Sistema e atualizações → Verificar atualização → Atualizar Vinki**. Esta versão traz a migração de banco `0019_queue_wait_off.sql`, aplicada pelo próprio atualizador; nada muda na Cloudflare.

- **Esforço de raciocínio**: a conexão de provedor de IA lista todos os níveis de cada provedor (DeepSeek: Sem raciocínio, Baixo, Alto, Máximo; Anthropic: Baixo a Máximo; OpenAI: de Sem raciocínio a Muito alto). Em Muito alto e Máximo cada resposta pode levar até 3 minutos.
- **Fila**: o tempo de espera mostrado ao cliente pode ser **Desligado**; o WhatsApp, o painel e o totem mostram só quantas pessoas estão à frente. O Senhapp precisa tratar a ausência do tempo.
- **Cumprimentos**: um "Olá" respondido pelo bot não transfere mais para a equipe nem abre protocolo.
- **Menu**: um item do tipo bot pode apontar para um bot de provedor de IA, que assume a conversa a partir da opção escolhida.

Depois de atualizar, clique em **Reabrir painel atualizado**.

## Atualização 0.19.0: protocolo fácil de digitar, bot com a equipe ausente, Conhecimento editável

Use **Sistema e atualizações → Verificar atualização → Atualizar Vinki**. Esta versão traz a migração de banco `0018_knowledge_usage.sql`, aplicada pelo próprio atualizador; nada muda na Cloudflare.

- **Protocolos novos só com dígitos**, em sequência a partir de 10001. O cliente consulta digitando o número (aceita `protocolo 10001`, `#10001`, espaços e pontos). Os protocolos antigos mantêm o número `WA-…` e continuam consultáveis, inclusive digitados em minúsculas ou com espaço.
- **Com a equipe ausente, devolver a conversa ao bot** (Regras de atendimento, desligado por padrão): o protocolo é aberto, a conversa sai da fila e o Bot Atendente continua atendendo; a equipe acompanha pelo protocolo.
- **Bot com conexão pausada não recebe conversas**: o cliente segue para o menu ou para a equipe. O protocolo aberto com a equipe ausente usa o resumo do bot ou o pedido do cliente como assunto, nunca uma mensagem de erro interna.
- **Resumo ao transferir**: o Bot Atendente pergunta o que falta e, ao passar para a equipe, escreve um resumo do pedido, que vira nota interna e, com a equipe ausente, o assunto do protocolo.
- **Como o atendimento começa**, em Quem atende cada linha: menu primeiro, bot primeiro ou sem menu.
- **Renomear bot** em Atendente e especialistas, e **editar fontes do Conhecimento**, com o campo "Quando e como o bot pode usar".

Depois de atualizar, clique em **Reabrir painel atualizado**.

## Atualização 0.18.0: fila de espera com senha, Senhapp, excluir setores

Use **Sistema e atualizações → Verificar atualização → Atualizar Vinki**. Esta versão traz a migração de banco `0017_queue.sql`, aplicada pelo próprio atualizador; nada muda na Cloudflare.

- **Fila de espera com senha:** em **Gestão → Filas e guichês**, crie filas e guichês, ligue a fila no WhatsApp (item de menu do tipo fila e, se quiser, porta de entrada em que qualquer mensagem abre o menu), configure painéis de TV e a lista negra. A equipe chama, rechama e transfere senhas na área **Fila**; o painel de TV fica em `/painel`. Detalhes em [Fila de espera com senha](FILA-SENHAS.md).
- **Senhapp:** o quadro de Integrações passa a ser **Parear Senhapp** (totem, painel ou guichê). Códigos do Vinki V4 e do Fagoo são recusados pelo painel; os pareamentos já feitos continuam funcionando e podem ser revogados ali.
- **Excluir setor**, em **Menus e ações → Setores de atendimento**: recusado enquanto um item de menu usa o setor; as conversas abertas dele voltam para a fila geral.
- **DeepSeek:** o esforço de raciocínio pode ser Sem raciocínio, Baixo (padrão) ou Alto. Conexões DeepSeek já cadastradas raciocinam em Alto até serem editadas e salvas; abra a conexão e salve para passar a Baixo.

Depois de atualizar, clique em **Reabrir painel atualizado**.

## Atualização 0.17.1: excluir conexões Hermes e de IA

Use **Sistema e atualizações → Verificar atualização → Atualizar Vinki**. Não há migração de banco e nada muda na Cloudflare. Em **Hermes e canais**, o cartão de uma conexão Hermes ou de provedor de IA pausada ganha **Excluir conexão**, que apaga a conexão, os bots dela e a chave guardada; conversas, mensagens e execuções anteriores continuam no histórico. A exclusão é recusada, dizendo onde trocar, enquanto um bot da conexão for o Bot Atendente, especialista, item de menu, bot de uma linha ou estiver atendendo uma conversa, e enquanto houver execução em andamento. No Hermes por plugin, o token deixa de valer. O limite do pacote de atualização sobe de 20 MB para 24 MB; como as instalações até a 0.17.0 aceitam no máximo 20 MB, esta versão continua abaixo disso. Depois de atualizar, clique em **Reabrir painel atualizado**.

## Atualização 0.17.0: bot por provedor de IA, sem Hermes

Use **Sistema e atualizações → Verificar atualização → Atualizar Vinki**. Não há migração de banco e nada muda na Cloudflare. Em **Hermes e canais → Nova conexão**, o serviço **Provedor de IA (sem servidor)** liga o Vinki direto à Anthropic, à OpenAI, à DeepSeek ou a uma API compatível com a OpenAI, com uma chave de API: sem VPS, Docker ou Hermes. O formulário busca os modelos da conta e permite escolher o esforço de raciocínio. **Testar conexão** cria o bot, que pode ser Atendente, bot de linha, destino de transferência e conversa com a equipe; ele só conversa, então não pode ser especialista nem item de menu do tipo bot. A opção **Apenas mensagens**, ligada por padrão, responde a áudio e vídeo com um aviso pedindo texto e mantém a conversa com o bot. As conexões Hermes não mudam. O custo é cobrado pelo provedor, por uso. Detalhes em [Bot por provedor de IA](PROVEDOR-IA.md). Depois de atualizar, clique em **Reabrir painel atualizado**.

## Atualização 0.16.6: uma só conversa com cada bot

Use **Sistema e atualizações → Verificar atualização → Atualizar Vinki**. Não há migração de banco. A tela do bot (**Pergunte ao bot**, no painel e nos aplicativos) e a conversa interna com o mesmo bot guardavam históricos separados, e cada aplicativo abria um deles. A pergunta feita pela tela do bot passa a ser gravada na conversa interna da pessoa com esse bot: os dois caminhos mostram a mesma conversa, em qualquer aparelho, e a memória do bot no Hermes é uma só para ela. Cada pessoa continua com a própria conversa, que os colegas não veem; por isso essas perguntas deixam de aparecer para o administrador em **Execuções de bots**. Arquivos devolvidos pelo bot aparecem na tela do bot; a conversa interna mostra só o texto. As perguntas diretas anteriores não são migradas: continuam na tela do bot, fora da conversa interna. Os aplicativos publicados não precisam de versão nova.

## Atualização 0.16.3: política de privacidade e teste de notificações

Use **Sistema e atualizações → Verificar atualização → Atualizar Vinki**. Não há migração de banco e o servidor não muda. O site ganha a página `/privacidade`, com a política de privacidade dos aplicativos Android e iOS, e um link para ela no rodapé. Em **Notificações dos aplicativos**, o botão **Enviar teste** passa a mostrar quantos aparelhos aceitaram o teste; antes dizia sempre que não havia dispositivo registrado, mesmo com a notificação entregue. Os aplicativos 0.17.0 (sem ligações ao vivo) estão no repositório, mas não fazem parte desta atualização.
