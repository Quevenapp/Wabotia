# Validação e limites

## Publicação 0.12.2 de 12/11/2026: exclusão de integrações e diagnóstico Zernio

Publicada na distribuição oficial `https://wabotia.queven.app` e na instalação operacional `https://wabotia.queven.com.br`, no commit `dfa22b734d6816a0d5d11ca320d3ca4a78639e8f`. **Excluir integração** remove cadastros locais Meta ou Zernio sem telefones, preservando o histórico. Grupos desativados sem vínculos são limpos atomicamente; vínculos ativos ou históricos bloqueiam a exclusão. O painel atualiza a seleção depois da remoção e libera nova tentativa manual após rejeições definitivas, sem repetir operações automaticamente.

Erros Zernio apresentam mensagem, código e campo retornados pelo provedor, com ocultação de credenciais. Timeout, falhas 5xx e operações sem confirmação continuam tratados como resultado incerto. A suíte geral passou com **320 testes em 26 arquivos**; após reforçar a ocultação de credenciais em mensagens com HTML, passaram os **34 testes** focados de normalização e adaptador. TypeScript, build e empacotamento passaram. A interface foi conferida em desktop e 390 × 844, incluindo erro 400 seguido de nova tentativa manual, barreira 409 na exclusão, seleção atualizada e descarte de formulário de uma integração removida.

Backups D1/R2 completos precederam a publicação. Não houve migrações novas; dez tabelas e os bindings ficaram idênticos durante o deploy. O catálogo mantém as 15 versões anteriores e oferece o pacote 0.12.2 com SHA-256 conferido. Uma instalação temporária recebeu 0.12.1 e atualizou pelo próprio atualizador para 0.12.2: **85 verificações** passaram, incluindo preservação de dados, mídia, permissões e exclusão de integrações sintéticas. Worker, D1, R2 e Durable Object temporários foram removidos e sua ausência foi confirmada. Evidências: [distribuição](reference/release-0.12.2-distribution.json), [operacional](reference/release-0.12.2-operational.json) e [atualizador](reference/release-0.12.2-upgrade.json).

Após verificar a preservação, os dois cadastros Meta operacionais sem telefones foram removidos pela API autenticada, com auditoria. A comparação confirmou histórico e credenciais Zernio preservados. Um teste de **Conectar WhatsApp** revelou `profile_not_found` (HTTP 404): o Account ID de um telefone havia sido informado no campo Profile ID. Não houve envio de mensagens nem autorização adicional na Meta.

## Publicação 0.12.1 de 12/11/2026: ajuda das credenciais Zernio

Publicada na distribuição oficial `https://wabotia.queven.app` e na instalação operacional `https://wabotia.queven.com.br`, no commit `59bd2add2a8ea72ffc516958eac61bbd2e56f007`. A tela **Integração Zernio** mostra links e instruções junto de API key, ID da integração e segredo de assinatura. O painel explica os campos técnicos **Profile ID** e **Account ID**, a exibição única da API key e o uso do mesmo segredo nos dois sistemas. Após salvar, há um link direto para cadastrar a URL em Webhooks da Zernio.

Backups D1/R2 foram concluídos antes de publicar. Não houve migração de banco nem mudança nos handlers ou payloads do formulário. Dez tabelas e os bindings foram comparados e preservados em cada ambiente. O catálogo oferece 0.12.1 com integridade SHA-256 verificada e mantém as 14 versões anteriores. Os arquivos JavaScript servidos nos dois domínios contêm os links e as instruções esperados. Evidências: [distribuição](reference/release-0.12.1-distribution.json) e [instalação operacional](reference/release-0.12.1-operational.json).

A atualização real 0.12.0 → 0.12.1 passou em **68 verificações HTTP** na instalação temporária: pacote e bundle idênticos, links de credenciais, dados de oito tabelas, arquivo R2, área compartilhada, permissões e bindings preservados. As 14 migrações existentes continuam aplicadas. Os recursos temporários foram removidos, com ausência confirmada do Worker, D1, R2 e Durable Object. [Evidência da atualização](reference/release-0.12.1-upgrade.json).

TypeScript, os cinco testes do atualizador e do pacote, build web e empacotamento do Worker passaram. O preview foi conferido no Chrome em desktop e 390 × 844, sem sobreposição, rolagem horizontal ou erros de console observados. Links externos usam `target="_blank"` e `rel="noopener noreferrer"`, com URLs estáticas sem dados do formulário. Nenhuma credencial foi preenchida ou enviada durante a inspeção, e não houve mensagem para provedores reais.

O formulário **Nova integração** também foi conferido numa nova aba autenticada da produção, preservando a aba anterior do usuário: instruções de cada credencial e links corretos, sem sobreposição. Nenhum campo foi preenchido ou salvo. A URL de webhook de uma integração Zernio salva foi conferida no demo; a integração legada selecionada em produção não permite essa etapa antes de um novo cadastro.

## Publicação 0.12.0 de 12/11/2026: área automática e nomes do painel

Publicada na distribuição oficial `https://wabotia.queven.app` e na instalação operacional `https://wabotia.queven.com.br`, no commit `be31a5379260ed351a6d9f0f09303054bb2da14a`. O painel usa **Área de atendimento → Integração Zernio → Telefones**. Novas instalações recebem a área compartilhada pela equipe na mesma transação do primeiro administrador. Instalações existentes reutilizam seus dados; o primeiro acesso administrativo prepara a área somente se ainda não houver nenhuma. O fluxo normal não pede criação nem seleção de áreas.

Backups D1/R2 foram concluídos antes da publicação. Não há migração de banco nesta versão. As dez tabelas comparadas e os bindings permaneceram inalterados nos dois ambientes; as 14 migrações anteriores continuam aplicadas e nenhuma ficou pendente. O catálogo oferece a versão 0.12.0, com SHA-256 conferido, e preserva as 13 anteriores. Evidências: [distribuição](reference/release-0.12.0-distribution.json) e [instalação operacional](reference/release-0.12.0-operational.json).

Uma instalação remota descartável executou a atualização real 0.11.0 → 0.12.0 pelo catálogo oficial. Passaram **66 verificações HTTP**, incluindo hashes e contagens de oito tabelas, arquivo R2, bindings, acesso dos operadores e três repetições do bootstrap sem criar área, auditoria ou permissões adicionais. Áreas legadas não são unidas automaticamente. Worker, D1, R2 e namespace Durable Object temporários foram removidos e sua ausência foi confirmada. [Evidência da atualização](reference/release-0.12.0-upgrade.json).

Validação local de **291 testes em 24 arquivos**, com reexecução aprovada dos arquivos afetados pelos novos textos; os sete testes novos cobrem setup, rollback, concorrência, autenticação e preservação das áreas anteriores. A reexecução de 15 testes dos contratos API também passou. TypeScript, build web e empacotamento do Worker passaram. O preview foi conferido no Chrome em desktop e 390 × 844: área fixa, assistente direto nas etapas, integração e telefones legíveis, sem sobreposição, rolagem horizontal ou erros de console observados. Nenhuma mensagem foi enviada a provedores reais.

A sessão administrativa operacional foi recarregada na versão publicada: Área de atendimento fixa, menu Integração Zernio, aba Telefones e assistente direto nas seis etapas, sem criar ou selecionar áreas. As duas integrações legadas e seus telefones continuaram visíveis e pausados, com a exclusão disponível. Layout íntegro e console sem erros observados; a inspeção não alterou dados.

## Publicação 0.11.0 de 12/11/2026: Zernio e exclusão de telefones

Publicada na distribuição oficial `https://wabotia.queven.app` e na instalação operacional `https://wabotia.queven.com.br`, com o commit `d9708df369bc481833a7997e9dafe2e6a47e74e6`. O catálogo oficial oferece o pacote 0.11.0 e preserva as 12 versões anteriores. A integridade SHA-256 do pacote baixado foi conferida, assim como versão/commit, painel, arquivos web, autenticação e contrato REST.

Backups completos D1/R2 foram concluídos antes da migração `0014_zernio.sql`. A comparação antes/depois confirmou a preservação de dez tabelas e dos bindings nos dois ambientes; nas conexões legadas, somente a pausa e a marcação para reconexão pela Zernio foram esperadas. Os dois números Meta operacionais ficaram pausados e o perfil permaneceu desativado como já estava. Nenhuma migração ficou pendente. Evidências sanitizadas: [distribuição](reference/release-0.11.0-distribution.json) e [instalação operacional](reference/release-0.11.0-operational.json).

Uma instalação remota descartável recebeu o pacote 0.10.0 e foi atualizada para 0.11.0 pelo próprio atualizador, usando o catálogo publicado. Passaram 55 verificações HTTP, incluindo preservação de oito tabelas, arquivo privado R2, bindings, aplicação única da migração e pausa de uma linha Meta fictícia. A exclusão de telefones sintéticos pela API cancelou filas ainda não enviadas e preservou conversas, protocolos e arquivos. Os recursos temporários foram removidos, com confirmação de ausência do Worker, D1, R2 e namespace Durable Object. [Evidência da atualização](reference/release-0.11.0-upgrade.json).

A suíte local passou novamente com **284 testes em 23 arquivos**; TypeScript, build web e empacotamento do Worker passaram. Não houve envio de mensagens a provedores reais. As credenciais e a entrega real pela Zernio continuam por configurar e homologar antes de ativar o atendimento; consulte o [guia Zernio](ZERNIO-WHATSAPP.md).

No Chrome, a sessão administrativa operacional exibiu **Zernio e números**, o aviso de migração e as duas linhas legadas pausadas, com **Ativar** desabilitado e **Excluir telefone** visível. O guia público Zernio e suas orientações expansíveis renderizaram corretamente. Não foram observados erros no console nem sobreposição no layout desktop. Esta inspeção não alterou nem excluiu dados de produção.

## Revisão local de 10/11/2026: Zernio e exclusão de telefones

Revisão local realizada antes da publicação. A conexão direta Meta foi substituída pela Zernio; as linhas legadas são pausadas pela migração `0014_zernio.sql`. Conversas, mensagens e protocolos são preservados. Excluir um telefone cancela a fila ainda não enviada; envios iniciados ou sem confirmação e chamadas abertas exigem resolução antes da exclusão.

Validação final: **284 testes aprovados em 23 arquivos**, executados no workerd com D1, R2 e Durable Objects. TypeScript, build web e empacotamento do Worker por `wrangler deploy --dry-run` passaram. O build web mantém um aviso de tamanho do bundle principal; não houve erro de compilação.

Os testes cobrem descoberta paginada, permissões e isolamento de contas/perfis, HMAC do webhook, deduplicação, roteamento e janela de atendimento, templates/consentimento, anexos por URL e multipart, grupos e cancelamento de fila com preservação do histórico. A migração foi testada sobre dados legados usando as próprias instruções SQL de atualização. Credenciais reais, número real e entrega na Zernio não foram homologados. Esta etapa local não enviou mensagens nem alterou a instalação em produção.

Ligações de áudio no navegador e envio de figurinhas não estão disponíveis pelo adaptador Zernio. Grupos precisam ser sincronizados antes do recebimento. Consulte formatos, limites e configuração no [guia Zernio](ZERNIO-WHATSAPP.md). Os PDFs antigos foram retirados dos links principais; seus geradores foram atualizados, mas os PDFs não foram regenerados nesta revisão. As publicações e evidências a seguir são históricas.

## Publicação 0.10.0 de 09/11/2026: configuração e integrações

Publicada na distribuição oficial `https://wabotia.queven.app` e na instalação operacional `https://wabotia.queven.com.br`, no commit `ba85167da900e087c9c6241c17d452b14996268d`. O painel simplificado e o assistente compartilham as configurações existentes. Foram acrescentados pareamento Vinki/Fagoo por código, atualização automática opcional, menus interativos, destinos por setor, consulta de protocolos por titularidade e interpretação do Atendente antes da decisão JEV.

Backups D1/R2 completos foram feitos antes das quatro migrações `0010`–`0013`. Na instalação operacional, os dois canais foram pausados durante a manutenção e restaurados ao estado anterior; o perfil permaneceu desabilitado como já estava. A comparação antes/depois confirmou conteúdo idêntico nas colunas existentes de usuários, perfis, conexões, bots e chaves. Bindings, namespace de Durable Object, banco, bucket, variáveis e nomes dos secrets foram preservados. Nenhuma migração ficou pendente.

Antes de publicar, uma instalação remota descartável executou o pacote oficial `0.9.0`, recebeu dados sintéticos e foi atualizada para o mesmo pacote `0.10.0` publicado. Passaram 26 verificações HTTP: preservação de perfil, conversa, protocolo e arquivo, menus/setores, JEV desligado, configuração de atualização automática e pareamento completo dos dois clientes com revogação e recusa de acesso. Os recursos remotos temporários foram removidos depois. Em produção, versão/commit, catálogo, SHA-256 do pacote e rotas públicas foram conferidos; o catálogo anterior `0.9.0` continua disponível. Não houve envio de mensagens reais. Evidências sanitizadas: [upgrade](reference/release-0.10.0-upgrade.json), [distribuição](reference/release-0.10.0-production.json) e [instalação operacional](reference/release-0.10.0-operational.json).

O roteamento mantém a janela de 24 horas no mesmo número e reserva a franquia atomicamente. Vinki pareado exige `free_only`, inclusive em envios diretos. Avisos podem definir `expires_at`; vencimento durante upload também impede a chamada de envio da mensagem. Os contadores são estimativas, não uma comprovação de gratuidade na fatura Meta.

A interface foi conferida no Chrome em desktop e 390 × 844: pareamento com a configuração manual recolhida, horários de atualização automática, destinos de menus e setores. Nenhum erro de console foi registrado. Os testes de backend usam D1/R2/Durable Objects reais em workerd e respostas simuladas dos provedores; não homologam as contas externas.

Validação final do Wabotia: `npm run check` aprovado; `npm test` com **216 testes aprovados em 17 arquivos**; `npm run build` aprovado; `git diff --check` sem erros. O build informa apenas o aviso de tamanho do pacote JavaScript principal (559 kB minificado).

Clientes em checkouts separados: Vinki Worker teve 56 testes aprovados; frontend com núcleo real teve 80 testes aprovados; Rust sem Quall teve 95 testes distintos aprovados, incluindo sete contra a nuvem local e a ponte Wabotia pela FFI. Não houve testes pulados nessas suítes. Rust 1.99.1 e LLVM-MinGW 23.1.5 foram instalados, e as bibliotecas Android arm64/armv7 foram compiladas. O APK de bancada passou em 110 testes Android; dois testes de aparelho físico foram pulados. Uma compilação adicional Android ARM64 com Quall também passou, em artefato separado. Windows com Quall falhou em `libdatachannel/configuration.cpp`: uso de `std::transform` sem incluir `<algorithm>` na dependência C++, rejeitado por libc++23. A dependência não foi alterada e esse build não substituiu o APK validado sem Quall. Fagoo teve três testes de pareamento, autenticação/MFA e PostgreSQL aprovados, sete testes de atualizações existentes aprovados e TypeScript aprovado; os procedimentos de publicação de cada cliente são independentes.

As migrações Wabotia `0010`–`0013` já foram aplicadas nos dois destinos acima. A nuvem Vinki foi publicada em `vinki.queven.com.br` com as migrações `0001`–`0003`; cinco verificações HTTP passaram e o vínculo com o aparelho central permanece por configurar. O Fagoo `v0.3.1` foi publicado como release assinada e instalado em `demo.fagoo.com.br` pelo atualizador oficial, com backup, estado final `succeeded/complete`, serviços saudáveis e nova rota de pareamento administrativa funcional. Consulte [pareamento e implantação dos clientes](PAREAMENTO.md), [menus e protocolos](MENUS-PROTOCOLOS.md), [JEV](JEV.md) e [atualizações automáticas](ATUALIZACOES.md). As evidências abaixo são históricas das versões indicadas.

## Revisão 0.9.0: rodízio, atendimento por linha e equipe interna

Publicada em produção em 08/11/2026 em `https://wabotia.queven.app`, no commit `5be6e86d87cb6492bb9fcc6f80a879173f76facc`. O backup anterior foi concluído; a migração aditiva `0009_service_team.sql` foi aplicada antes da publicação. A verificação remota confirmou versão/commit, integridade SHA-256 do pacote oficial, rotas de linhas/equipe e contrato sem limite de 20 membros por grupo. Nenhuma migração ficou pendente. A suíte completa final passou com 157 testes em 12 arquivos. Os ambientes antigos de staging referenciados nos arquivos locais já não tinham os bancos D1; a migração foi validada localmente em workerd antes da aplicação em produção.

O teto de 20 linhas foi removido do cadastro, dos grupos, da interface e do contrato REST. A descoberta percorre as páginas retornadas pela Meta e recusa cursores repetidos, sem teto local de quantidade. Os 37 testes do roteador passaram, incluindo cadastro e seleção com 21 linhas, validação de pertencimento à conta e descoberta com 501 números em seis páginas. TypeScript e build web também passaram. A remoção do teto não exige outra migração além da `0009` dos novos recursos de atendimento.

Em 08/11/2026, 155 testes passaram em 12 arquivos no workerd com D1, R2 e Durable Objects. São 16 testes novos desde a 0.8.0: 4 do roteador e 12 de linhas, menus e equipe. A verificação TypeScript (`tsc --noEmit`) também passou. As regressões cobrem rodízio concorrente desde a primeira entrada, preferência pela franquia, continuidade paga no mesmo número e janela de 24 horas; atribuição e revogação de linhas por bot; menu manual durante atendimento humano; transferência imediata com fontes; presença de bots; preservação de configuração; isolamento de mensagens internas, execuções, eventos e relatórios; e cancelamento de entregas QR após revogação.

A migração aditiva `0009_service_team.sql` foi exercitada em bancos locais de teste. Provedores externos foram simulados; estes testes não enviaram mensagens reais, não conferiram a fatura Meta e não publicaram o servidor nem os aplicativos. A homologação nos canais reais continua pendente. [Funcionamento de linhas, menus e equipe](ATENDIMENTO-EQUIPE.md).

O pacote web compilou e o Worker passou em `wrangler deploy --dry-run`. No navegador, a interface foi conferida em desktop e em 390 × 844. Uma instalação local isolada confirmou persistência de atendimento humano e menu manual por linha, saída da linha do roteador e envio de conversa interna; a segunda conta conseguiu ler a mensagem pela API e a fila de mensagens externas permaneceu vazia. Nenhum erro ou aviso apareceu no console dessa validação. Android 0.9.0 (build 2): `assembleDebug` e 4 testes unitários passaram. iOS 0.9.0 (build 2): compilação no Mac e 14 testes XCTest passaram no simulador. O APK de depuração e os pacotes iOS estão em `mobile/android/app/build/outputs/apk/debug/` e `mobile/ios/build/`.

Os aplicativos foram atualizados diretamente, sem desinstalação ou limpeza de dados, em seis aparelhos: Samsung A10s (Android 11), A075M e tablet X230 (Android 16), iPhone 7 (iOS 15.8.8), iPhone X (iOS 16.7.16) e iPad A16 (iPadOS 26.6.2). Android manteve o pacote de depuração já instalado, `0.9.0-debug`/código 2. iOS ficou em `0.9.0`/build 2, assinado com o chaveiro existente através de `~/bin/xcb`; nenhuma senha foi exibida ou copiada. Para o iPhone 7, o mínimo foi adaptado para iOS 15, com alternativas de navegação, galeria e compartilhamento; o build final e os 14 XCTest passaram após a correção de identidade de destinos de links. Os três Apple abriram o app; iPhone 7 e X mostraram a tela de servidor e o iPad preservou a sessão na tela de conversas. A075M e X230 abriram em primeiro plano; no A10s a versão e o processo foram confirmados, mas o aparelho bloqueado impediu a conferência visual. Não houve publicação em App Store ou Play Store nem envio real de mensagens WhatsApp nesta validação.

## Revisão 0.8.0: aplicativos Android e iOS, login móvel e push

Em 08/11/2026, 139 testes passaram em workerd com D1, R2 e Durable Objects (19 novos em `tests/mobile.test.ts`), além de 6 testes do gateway de push (`push-gateway/`). Os novos testes cobrem login móvel com token `wabu_` sem verificação de origem, renovação e revogação, dispositivos (upsert, teto por pessoa, conflito de posse, limite de cadência), regras de alvo do push (responsável, fila, IA, exclusão do ator), deduplicação e cursor (semeadura no fim do histórico, falha no meio do lote), alertas de protocolo vencendo/atrasado uma única vez mesmo com mais de 100 protocolos antigos, modos gateway/FCM/desligado (404 do FCM só desativa aparelho com `UNREGISTERED`), configuração sem devolver a chave privada, e a listagem/detalhe de protocolos. Verificação TypeScript, `wrangler deploy --dry-run` da raiz e do gateway concluídos. Uma revisão adversarial independente (segurança e correção) apontou 11 defeitos, todos corrigidos com testes de regressão.

A migração `0008_mobile.sql` é aditiva e foi aplicada apenas em banco vazio (testes); não foi executada contra um D1 remoto com dados reais. FCM e Google OAuth foram simulados: nenhuma notificação real foi enviada. O gateway `push.wabotia.queven.app` ainda não foi publicado.

Aplicativos: o Android (`mobile/android`) compilou em Windows com JDK 17, Gradle 8.11.1 e SDK 35 (`assembleDebug` gera o APK de depuração; `lintDebug` sem erros). Uma revisão adversarial confirmou 6 defeitos no Android (entre eles encerrar a ligação ao sair da tela de acompanhamento e perda da chave de idempotência em repetições), todos corrigidos. O iOS (`mobile/ios`, 41 arquivos Swift) foi revisado estaticamente para Swift 5.10/iOS 16, teve 8 defeitos confirmados corrigidos e, ainda em 08/11/2026, foi compilado no Mac com Xcode 27.0 (projeto gerado pelo XcodeGen): build para simulador, build assinado para aparelho com o perfil gerenciado da equipe e 11 testes unitários (muxer OGG/Opus, normalização de servidor, deep links) passando no simulador de iPad. O app foi instalado e aberto no iPad A16 (iOS 26.6), mostrando a tela do servidor; no iPhone X (iOS 16.7) foi instalado e aberto após o usuário confiar no perfil de desenvolvedor, mostrando a mesma tela inicial. iPhone 7 (iOS 15) fica fora do alvo mínimo iOS 16. Nenhum dos dois foi executado em aparelho real nem contra um número WhatsApp real; isso permanece como etapa final com o proprietário. [Guia dos aplicativos](MOBILE.md).

## Revisão 0.7.0: função e permissões por número

Em 07/11/2026, 120 testes passaram em workerd com D1, R2 e Durable Objects. Incluem isolamento entre perfis, alterações restritas ao administrador, seleção de números elegíveis, bloqueio de templates/atendentes/bots/API conforme a política, cancelamento de envios pendentes após restrições e contadores separados de serviço e templates. Uma linha de integração continua recebendo e registrando revogações de consentimento sem disparar saudações ou bots. A versão mantém a janela e o remetente; nunca converte um envio bloqueado em mensagem paga ou troca o número.

TypeScript e build passaram. A prévia com dados fictícios confirmou as funções sugeridas, seleção individual e ausência de erros no console. Esses testes não enviaram mensagens reais nem verificaram a fatura Meta. Não há migração de banco. A mudança de função não ativa o perfil, o canal, uma integração ou uma autorização de cobrança.

## Revisão 0.6.2: atalho do guia

O link direto `/install#meta-whatsapp` passa a abrir a seção Meta após o carregamento do React. O problema foi observado no Chrome e a correção conferida na prévia local. Verificação TypeScript e build concluídos; sem alteração de backend ou banco.

## Revisão 0.6.1: cadastro Meta e compatibilidade Workers

Atualizado em 06/11/2026. O primeiro telefone real foi cadastrado na Meta; o aplicativo foi publicado e o webhook foi verificado e inscrito na conta. **Envio, recebimento, anexos e chamadas com o número real ainda dependem do teste final com o proprietário.** Nenhuma mensagem real foi enviada nesta revisão.

- Uma instalação existente foi atualizada para 0.6.1 pelo próprio painel. A busca autenticada na Meta encontrou o telefone real, que foi adicionado uma única vez ao roteador, pausado, com consumo inicial zero. A conta, o webhook e as credenciais foram preservados na atualização. O nome de exibição ainda estava em análise na Meta.
- 111 testes passaram em workerd com D1, R2 e Durable Objects. O teste de regressão reproduziu a falha ao construir a requisição nativa com `redirect: "error"`; a correção usa `manual` e recusa redirecionamentos sem encaminhar credenciais. Os testes também verificam download de mídia, rejeição de 302 e ausência de repetição automática após falha ambígua de envio.
- Verificação TypeScript concluída. Nenhuma migração de banco ou mudança no contrato dos recursos nesta revisão.
- Guia específico Meta com 15 páginas e manual completo com 69 páginas. As telas reais mostram cadastro, empresa verificada, app, localização do App Secret oculto, permissões e webhook; credenciais não são publicadas. O roteiro distingue registro, publicação, assinatura dos campos e inscrição da conta, e explica a renovação do token de 60 dias.

[Roteiro do primeiro número e próximos testes](META-WHATSAPP.md). As evidências das versões anteriores permanecem abaixo.

## Revisão 0.6.0: roteador de números Meta

Atualizado em 06/11/2026. **A homologação com números reais permanece para a etapa final com o proprietário.** Nenhuma mensagem real foi enviada nem canal real conectado nesta revisão.

- 106 testes passaram em workerd com D1, R2 e Durable Objects, incluindo 22 novos testes do roteador. Cobrem webhook compartilhado com 20 números, HMAC/WABA, deduplicação, reserva concorrente da última unidade, mudança de mês/fuso, envio sem confirmação, permissões, idempotência, remetente fixo, janela real, modelos aprovados simulados, autorização individual, consentimento revogado, mídia privada, cancelamento e nova tentativa paga.
- Os 4 testes do instalador e 3 do atualizador Node passaram, incluindo preservação dos recursos e recusa de configuração incompatível.
- Os exemplos cURL, JavaScript e Python foram executados contra um servidor HTTP fictício local. Os exemplos recusam modelo pago sem confirmação. As rotas do roteador também foram exercitadas em workerd nos testes; provedores Meta são simulados, sem verificar faturamento ou entrega real.
- No Chrome, cadastro de conta, consumo inicial de dois números e grupo aleatório foram salvos numa instalação local isolada com dados fictícios. Confirmados retorno de sucesso e contador atualizado. O painel foi conferido em desktop e em 390 × 844, sem rolagem horizontal e sem erros registrados no console.
- Guia ilustrado atualizado para 54 páginas. Novas páginas 50–54 e páginas iniciais renderizadas e revisadas. Screenshots de referência não contêm credenciais. A migração 0007 é aditiva e o pacote mantém as políticas de segurança dos arquivos web.

Na implementação atual, até 1.000 mensagens de atendimento por número/mês representam a franquia gratuita estimada, não um teto de envio. Novas entradas alternam desde o início entre linhas com franquia; quando todas esgotam, o rodízio continua com serviço pago. Conversas existentes permanecem no mesmo número com cobrança do excedente, sempre respeitando sua janela de 24 horas. Os antigos grupos de menor consumo ou aleatórios também passam a seguir esse rodízio. A [referência Meta consultada](https://whatsappbusiness.com/resources/faq/) informa essa franquia desde 01/10/2026; condições e faturamento são definidos pela Meta. Envios por outros sistemas, uso inicial incorreto, fuso diferente ou atraso de recibos podem fazer o contador divergir. O Wabotia informa unidades excedentes estimadas, não preços nem garantia de ausência de cobrança. Templates continuam exigindo aprovação Meta, permissões, consentimento e autorização naquele pedido; o serviço pago não é convertido em template.

[Configuração, limites e roteiro de homologação real](ROTEADOR.md). Os registros abaixo são evidências históricas das versões indicadas.

## Revisão 0.5.0: WhatsApp, grupos e voz

Atualizado em 06/11/2026. **A homologação com número real continua pendente, por escolha do proprietário, e será a etapa final.** Não foi iniciado nem alterado um consumidor WhatsApp real nesta revisão.

- 84 testes passaram em workerd com D1, R2 e Durable Objects. Cobrem mídias nativas, upload por partes/conflitos/expiração, acesso privado e ranges, recibos fora de ordem, grupos, tomada humana, chamadas, identidade da aplicação, paginação e webhooks HMAC. Provedores externos simulados.
- 6 testes Node do QR, 5 testes Python do transporte Hermes e 4 testes Python do assistente Hermes passaram. Mais 4 testes do instalador e 3 do atualizador Node passaram. O atualizador da extensão foi exercitado em cópia temporária conhecida: backup, repetição e recusa de arquivo modificado.
- Os exemplos novos JavaScript e Python foram executados contra workerd local com dados fictícios. Upload, criação do pedido e repetição com o mesmo recibo foram verificados. [Evidência sanitizada](reference/whatsapp-examples-validation.json). Isso não verifica entrega a um provedor real.
- No Chrome, foram conferidos anexos privados, reprodutor de áudio, citação, upload com progresso, fila, grupos, aviso de chamada e controles de voz simulada. Layout de conversa revisado também em 390 × 844, sem rolagem horizontal. O codificador real gerou OGG/Opus a partir de áudio sintético (1,22 s, 3.966 bytes), com prévia carregada sob as políticas de segurança de produção, sem solicitar microfone. A atualização direta preserva essas políticas nos metadados da API Cloudflare. Microfone real e áudio WebRTC com a Meta aguardam a homologação.
- Guia ilustrado atualizado para 49 páginas; páginas novas e páginas iniciais renderizadas e revisadas. A migração 0006 é aditiva. Conectores externos precisam ser atualizados separadamente.

[Guia WhatsApp e roteiro de teste real](WHATSAPP.md). Voz ao vivo exige **Meta direto** com Calling API elegível e permissão do cliente. QR e Hermes não iniciam/atendem chamadas; não há videochamadas. Meta Groups exige elegibilidade própria e não equivale aos grupos pessoais. O transporte Hermes oferece somente as funções nativas anunciadas pelo adaptador, sem administração completa de grupos ou todos os recibos.

As evidências abaixo pertencem às revisões anteriores, salvo indicação explícita; não são novas homologações de canais da 0.5.0.

## Revisão 0.3.1: instalação e orientação

Esta revisão acrescenta ao site e ao PDF o roteiro de Node.js para Ubuntu/VPS (incluindo `libatomic1` e a distinção root/sudo), Windows e macOS. O instalador mostra perguntas em linhas completas, distingue espera de entrada de espera por operação e informa tempo decorrido a cada 10 segundos. A publicação via npm/Wrangler é assíncrona para manter esses avisos ativos. Os testes Node cobrem entrada oculta, exibição da pergunta, encerramento dos avisos e propagação de falhas do processo. Não houve alteração no contrato dos recursos ou migrações nesta revisão. As homologações 0.3.0 abaixo são evidências históricas, não novas homologações de canais.

Atualizado em 05/11/2026. A implementação é uma versão inicial de código aberto. **Ainda não foi homologada ponta a ponta com contas reais de WhatsApp, Telegram e perfis Hermes nesta implantação.** Credenciais, perfis e destinatários de teste precisam ser escolhidos pelo proprietário.

## O que foi verificado

| Área                 | Evidência                                                                 | Resultado                                                                         |
| -------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Runtime              | Vitest com `@cloudflare/vitest-plugin`, D1/R2/DO em workerd               | 50 testes passam; provedores externos simulados                                   |
| API remota           | `scripts/smoke.mjs` contra Worker de staging                              | 20 verificações HTTP, dados fictícios; sem canal conectado                        |
| Credenciais          | Testes de hash, criptografia, expiração e revogação                       | Chaves inválidas recusadas; credenciais não ficam no frontend                     |
| Autorizações         | Testes de perfis, bots e namespaces de aplicações                         | Aplicações não escolhem identidade nem acessam conversas externas umas das outras |
| Consistência         | Idempotência/conflito, inbox/outbox, limites, época da conversa e recibos | Repetições deduplicadas; tomada humana invalida resposta antiga                   |
| Bots                 | API assíncrona simulada, cancelamento, confirmação perdida e recuperação  | Sem execução automática adicional após resultado ambíguo                          |
| Arquivos de bots     | Download único, R2 recuperável e isolamento de ator                       | Não repete download ambíguo nem libera arquivo para outra aplicação               |
| Conhecimento         | Texto, importação e pesquisa FTS em testes                                | Base consultável; importação depende de conteúdo e acesso da fonte                |
| Webhooks             | HMAC, retry e permissões testados com HTTP simulado                       | Eventos mantêm IDs estáveis; destinatário precisa deduplicar                      |
| Clientes de exemplo  | JavaScript, Python e cURL contra staging                                  | Criam conversa, assumem, respondem e abrem protocolo; bot real não executado      |
| Backup e restauração | D1 e R2 remotos em destino novo/vazio                                     | Contagens, FTS e mídia por SHA-256 conferidos; banco preenchido recusado          |
| Transporte Hermes    | 3 testes Python                                                           | Diário e recibos; sem gateway/canal real conectado                                |
| Interface            | Chrome desktop e viewport 390 × 844                                       | Landing, painel, formulários e navegação móvel revisados                          |
| Repositório          | Quevenapp/Wabotia público, MIT                                            | Actions desativado antes do primeiro push; sem workflows                          |

Resultados remotos sanitizados: [API](reference/live-validation.json), [exemplos](reference/examples-validation.json) e [restauração](reference/restore-validation.json). Os arquivos não contêm chaves nem dados de clientes.

O site e o guia estão publicados em https://wabotia.queven.app. Desde 0.3, novas instalações usam o instalador independente e a API Cloudflare; o fluxo de cópia GitHub permanece somente como legado.

## Matriz para homologar seus canais

Use staging, perfis e destinatários autorizados. Registre versão do Hermes, versão do conector, data e resultado. Uma linha só está concluída depois de executar o teste no serviço real.

| Cenário                 | Ainda requer teste real                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| Hermes nativo e Docker  | Descoberta, cada chave de perfil, run/stop, reconexão, áudio, imagem e exportação de artefato           |
| Tunnel + Access         | Service Auth nos dois hostnames, renovação do serviço, reinício do host, recusa sem credenciais         |
| Meta direto             | Webhook/assinatura, mensagem e anexo, janela 24h, consentimento/template UTILITY                        |
| QR direto               | Pareamento Baileys, entrada/saída, anexo, reinício mantendo sessão, confirmação perdida                 |
| Meta/QR pelo Hermes     | Extensão exclusiva compatível, spool/replay, isolamento de perfil, ausência de dupla resposta           |
| Telegram direto         | Bot dedicado, grupo privado/tópicos, vínculo de IDs, presença, comandos, notas e anexos                 |
| Tomada humana           | Assumir durante inferência; nenhuma resposta obsoleta; transferência com mensagens pendentes            |
| Indisponibilidade       | Desligar Hermes/túnel/QR e restaurar; painel continua acessível; pendências conferidas                  |
| Integração externa      | Entrega HMAC a endpoint do integrador, duplicata após timeout, retry manual e limites na carga prevista |
| Troca de modo do número | Pausa, reconciliação, ativação do novo consumidor, retomada sem duplicidade                             |

## Limites que precisam ser considerados

- A revisão Hermes examinada possui APIs nativas recentes de execução durável. Compatibilidade com outras revisões não é presumida; a descoberta recusa a ausência da capacidade exigida. O backend administrativo com login interativo/OAuth pode exigir outra configuração de integração.
- O conector pelo Hermes usa uma extensão do gateway e APIs internas do adaptador. Telegram e WhatsApp direto não precisam desse plugin. A extensão precisa ser revalidada a cada atualização Hermes.
- A API nativa de artefatos faz download de uso único. Caminhos locais e arquivos não exportados não são anexos. Sem confirmação de download, é necessária nova exportação; não há repetição automática.
- Envios de canais não participam da transação D1. Se o provedor recebeu a mensagem e a confirmação se perdeu, o estado pode ser `unknown`: confira e reconcilie. Deduplicação local não equivale a exatamente uma entrega no provedor.
- PDFs digitalizados sem camada de texto não têm OCR. Importação de vídeos usa apenas legendas públicas/autorizadas. O endpoint legado de upload e o download Telegram têm limite de 20 MiB. Upload em partes/entrada de mídia WhatsApp aceitam até 100 MiB, com limites menores por canal/tipo. Importações têm limites próprios do runtime Workers.
- Os spools e as sessões QR/Hermes estão no host externo. Monitore disco e preserve-os no backup; esta versão não faz expurgo automático desses diários.
- Não houve teste de carga representativo nem homologação de todos os fornecedores/modelos. Não há garantia de paridade automática com toda personalização privada do WABABOTAI original. As regras migradas cobrem os módulos descritos e os testes deste repositório.
- Histórico antigo não é importado. A cópia de backup deve ser feita com entradas pausadas para consistência entre banco e mídias.

## Reproduzir as verificações

```sh
npm ci
npm run check
npm test
node tests/installer.test.mjs
node tests/updater-build.test.mjs
node tests/qr-features.test.mjs
npm run build
python3 -m pip install httpx
python3 tests/hermes_transport_test.py
```

Os scripts remotos `smoke.mjs` e `validate-examples.mjs` são exclusivos para staging e criam dados sintéticos. `validate-restore.mjs` cria e remove recursos descartáveis novos; use somente a configuração staging e um backup controlado. Os exemplos de execução de bot são opcionais e exigem `WABOTIA_BOT` autorizado.

## Manutenção 0.2.0

17 testes adicionais em workerd verificam autorização, CSRF, idempotência, criptografia, conflitos DNS/Access, ordem da proteção antes do DNS, rotas restritas, interrupções sem repetição e atualização fixada por commit. Dois testes Node verificam preservação da implantação e rejeição de bindings/migrações incompatíveis. As APIs de criação Cloudflare e hooks foram simuladas; isso não equivale à homologação de um novo túnel real pelo assistente.

A interface de diagnóstico foi verificada no Chrome nos estados de espera, sucesso, vazio, falha e timeout, incluindo o atalho à Equipe Bot. O assistente de deploy foi exercitado com dados fictícios.

A atualização 0.2.0 foi publicada em uma instalação existente pelo Cloudflare Builds, com o commit aaea567 confirmado em /api/health e os recursos preservados. O painel autenticado confirmou a conexão e a descoberta de perfis no Hermes real; o bot autorizado permaneceu selecionado e o atendimento pausado. Isso valida o caminho de atualização inicial e o diagnóstico, sem substituir a homologação dos canais ou a criação automática de novos recursos Cloudflare.

0.2.1 ajusta o autocomplete dos campos de credenciais da manutenção para evitar que o gerenciador do navegador os confunda com o login do painel.

0.2.2 corrige o modo de redirecionamento da consulta ao GitHub para o valor suportado por Workers. O teste passou a validar as opções de Request no próprio workerd e reproduziu a falha antes da correção. Um teste adicional recusa redirecionamentos sem guardar uma versão. O script também aceita recuperação manual por SHA completo, com as mesmas verificações de origem oficial e preservação dos recursos; três testes Node passam. 0.2.3 documenta essa recuperação no site e no PDF.

## Instalação direta 0.3.0

O instalador independente foi executado em Linux contra a Cloudflare real, em uma instalação isolada. Criou Worker, D1 e R2, aplicou quatro migrações, publicou três secrets e confirmou o commit no endpoint de saúde. A pasta não contém repositório Git. O teste Node do instalador recusa bancos e buckets preexistentes, incluindo bancos encontrados em páginas posteriores. Windows e macOS têm instruções, mas ainda não foram homologados nesses sistemas.

Cinco testes adicionais em workerd cobrem o pacote oficial, preservação de bindings, identidade da instalação, autorização administrativa, início deduplicado, confirmação pelo código ativo, timeout sem nova publicação, integridade/caminhos, incompatibilidade de Durable Objects e rollback de migração. O tag de migração é lido nos metadados do serviço, porque o endpoint de settings não o retorna.

Os pacotes oficiais usam HTTPS e SHA-256; não têm assinatura assimétrica. Um commit só aparece como atualização depois de publicado no catálogo oficial. O fluxo anterior de Builds continua disponível para instalações que já têm hook configurado.

A atualização direta real foi concluída em 05/11/2026 no Worker isolado `wabotia-release-staging`, do candidato para o commit oficial `72916d2` (0.3.0). O painel/API registrou `completed` somente após o novo código responder. Repetir o início com a mesma Idempotency-Key retornou o mesmo trabalho; login e conversa sintética foram preservados. [Evidência sanitizada](reference/direct-release-validation.json). Nenhum canal externo foi conectado nesse teste.
