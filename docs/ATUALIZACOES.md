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
