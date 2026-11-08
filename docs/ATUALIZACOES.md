# Atualização direta, sem repositório próprio

Desde a versão 0.3, novas instalações baixam um pacote oficial já preparado e publicam diretamente na sua conta Cloudflare. Não precisam de conta GitHub, cópia do repositório, Cloudflare Builds ou Deploy Hook. O código continua aberto no repositório oficial; uma versão só aparece no painel depois que seu pacote foi publicado pelo mantenedor.

## Usar o botão

1. Abra **sua instalação → Sistema e atualizações**.
2. Clique **Verificar atualização**. A consulta é armazenada por cinco minutos.
3. Confira a versão e clique **Atualizar Wabotia**.
4. Acompanhe as etapas: baixar e verificar o pacote, preparar arquivos, migrar o banco e publicar.
5. Espere **Atualização publicada e verificada**. Clique **Reabrir painel atualizado**.

A confirmação compara o commit solicitado com o código em execução. O banco, as mídias, os domínios e os secrets permanecem na sua conta. Migrações são aplicadas com recibo na mesma transação antes de ativar código. Alterações incompatíveis em Durable Objects precisam de procedimento manual.

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
