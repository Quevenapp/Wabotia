# Validação e limites da versão 0.8.0

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

O teto é uma proteção local de até 1.000 mensagens de atendimento por número/mês. A [referência Meta consultada](https://whatsappbusiness.com/resources/faq/) informa essa franquia desde 01/10/2026; condições e faturamento são definidos pela Meta. Envios por outros sistemas, uso inicial incorreto, fuso diferente ou atraso de recibos podem fazer o contador divergir. O Wabotia não estima custos nem promete ausência de cobrança. Janela e remetente não migram para outro número quando a cota acaba. Modelos pagos exigem aprovação Meta, permissões, consentimento e autorização naquele pedido.

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

| Área | Evidência | Resultado |
|---|---|---|
| Runtime | Vitest com `@cloudflare/vitest-plugin`, D1/R2/DO em workerd | 50 testes passam; provedores externos simulados |
| API remota | `scripts/smoke.mjs` contra Worker de staging | 20 verificações HTTP, dados fictícios; sem canal conectado |
| Credenciais | Testes de hash, criptografia, expiração e revogação | Chaves inválidas recusadas; credenciais não ficam no frontend |
| Autorizações | Testes de perfis, bots e namespaces de aplicações | Aplicações não escolhem identidade nem acessam conversas externas umas das outras |
| Consistência | Idempotência/conflito, inbox/outbox, limites, época da conversa e recibos | Repetições deduplicadas; tomada humana invalida resposta antiga |
| Bots | API assíncrona simulada, cancelamento, confirmação perdida e recuperação | Sem execução automática adicional após resultado ambíguo |
| Arquivos de bots | Download único, R2 recuperável e isolamento de ator | Não repete download ambíguo nem libera arquivo para outra aplicação |
| Conhecimento | Texto, importação e pesquisa FTS em testes | Base consultável; importação depende de conteúdo e acesso da fonte |
| Webhooks | HMAC, retry e permissões testados com HTTP simulado | Eventos mantêm IDs estáveis; destinatário precisa deduplicar |
| Clientes de exemplo | JavaScript, Python e cURL contra staging | Criam conversa, assumem, respondem e abrem protocolo; bot real não executado |
| Backup e restauração | D1 e R2 remotos em destino novo/vazio | Contagens, FTS e mídia por SHA-256 conferidos; banco preenchido recusado |
| Transporte Hermes | 3 testes Python | Diário e recibos; sem gateway/canal real conectado |
| Interface | Chrome desktop e viewport 390 × 844 | Landing, painel, formulários e navegação móvel revisados |
| Repositório | Quevenapp/Wabotia público, MIT | Actions desativado antes do primeiro push; sem workflows |

Resultados remotos sanitizados: [API](reference/live-validation.json), [exemplos](reference/examples-validation.json) e [restauração](reference/restore-validation.json). Os arquivos não contêm chaves nem dados de clientes.

O site e o guia estão publicados em https://wabotia.queven.app. Desde 0.3, novas instalações usam o instalador independente e a API Cloudflare; o fluxo de cópia GitHub permanece somente como legado.

## Matriz para homologar seus canais

Use staging, perfis e destinatários autorizados. Registre versão do Hermes, versão do conector, data e resultado. Uma linha só está concluída depois de executar o teste no serviço real.

| Cenário | Ainda requer teste real |
|---|---|
| Hermes nativo e Docker | Descoberta, cada chave de perfil, run/stop, reconexão, áudio, imagem e exportação de artefato |
| Tunnel + Access | Service Auth nos dois hostnames, renovação do serviço, reinício do host, recusa sem credenciais |
| Meta direto | Webhook/assinatura, mensagem e anexo, janela 24h, consentimento/template UTILITY |
| QR direto | Pareamento Baileys, entrada/saída, anexo, reinício mantendo sessão, confirmação perdida |
| Meta/QR pelo Hermes | Extensão exclusiva compatível, spool/replay, isolamento de perfil, ausência de dupla resposta |
| Telegram direto | Bot dedicado, grupo privado/tópicos, vínculo de IDs, presença, comandos, notas e anexos |
| Tomada humana | Assumir durante inferência; nenhuma resposta obsoleta; transferência com mensagens pendentes |
| Indisponibilidade | Desligar Hermes/túnel/QR e restaurar; painel continua acessível; pendências conferidas |
| Integração externa | Entrega HMAC a endpoint do integrador, duplicata após timeout, retry manual e limites na carga prevista |
| Troca de modo do número | Pausa, reconciliação, ativação do novo consumidor, retomada sem duplicidade |

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
