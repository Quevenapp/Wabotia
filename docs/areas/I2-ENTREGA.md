# Entrega I2 — extensões, pendências e segurança

Relato consolidado de toda a integração, atualizado após a segunda verificação
externa registrada em `.codex-verificacao.log`: **build aprovado, 48 de 50
arquivos de teste aprovados e 587 de 589 testes aprovados**. A inicialização já
foi corrigida na rodada anterior; as duas falhas atuais eram expectativas
desatualizadas dos testes criados pelas peças D e O do motor. Foram corrigidas
com cobertura adicional, preservando o requisito de não capturar anexo comum e
as 48 rotas documentadas. As verificações locais desta rodada passaram; a
aprovação integral do Vitest/Cloudflare ainda depende da nova execução externa.

## Estado e registros

Os quatro módulos foram registrados, desligados por padrão e habilitados por
área. Nenhum modelo passa a ligá-los automaticamente. Os registros de I, os
17 modelos e o tipo embutido foram preservados. A migração nova é somente
aditiva: `0118_area_template_recovery.sql`, para recibos recuperáveis de aplicação
de modelo. Não há novo Durable Object, binding ou recurso Cloudflare.

| Arquivo | Registro ou alteração |
|---|---|
| `src/modules/registry.ts` | Jurídico, Condomínio, Saúde e Ensino no catálogo; os quatro descritores mantêm `default_enabled: false`. |
| `src/modules/runtime.ts` | Rotas, comandos e leituras das quatro extensões; menus/credenciais de Condomínio e Ensino; ferramenta de Ensino que apenas solicita acesso. Agendadores independentes de Jurídico e Condomínio, sem substituir OS. Saúde e Ensino não registram agendador. |
| `src/index.ts`, `src/modules/ensino/http.ts` | Middleware `no-store` nas rotas de Ensino, importado de um arquivo sem dependências de execução para evitar o ciclo de inicialização. Saúde conserva seus próprios retornos privados `no-store`. |
| `src/modules/openapi.ts` | Esquemas/operações de Ensino e complementos do motor: versão opcional do orçamento, definições privadas, capacidades fixadas, filtros e próxima tarefa. As outras extensões não forneceram descritor OpenAPI; seus guias continuam sendo a referência. |
| `web/workspace-navigation.ts`, `web/lib/routes.ts`, `web/admin/AdminArea.tsx` | Entradas, rotas e telas. Os novos módulos também ficam ocultos enquanto o estado da área ainda não foi carregado. Não foram adicionados a `adminPages`. |
| `web/main.tsx` | Portais `/condominio/acesso` e `/ensino/acesso`. O conteúdo exige a credencial temporária existente; o link público apenas inicia a troca. |
| `docs/API.md`, `docs/areas/CONTRATO-MOTOR.md` | Contratos sincronizados e links para as extensões. |
| `docs/ENSINO.md` | Guia de registro corrigido para importar o middleware HTTP separado dos descritores. |

Os pré-requisitos dos relatos (papel `os:sensitive`, Pessoas e seus eventos)
já estavam registrados em I; não foram duplicados. Jurídico e Saúde não têm
menu de WhatsApp nem ferramenta com conteúdo privado.

## Falhas das verificações externas e correções

### Rodada atual: duas expectativas desatualizadas

O log atual executou os **589 testes**. Os únicos reprovados foram:

| Falha | Causa | Correção e cobertura preservada |
|---|---|---|
| `os-documents.test.ts`: leitura de `outgoing.mock.calls.at(-1)[1]` sem chamada | O teste ainda esperava orientação ao enviar anexo com texto `segue`. O item 4 da tarefa I2 exige justamente retornar `false`, sem responder, nesse caso. A implementação de `delivery.ts` já estava correta. | O mesmo teste agora exige retorno `false`, nenhuma consulta a anexos, nenhuma mensagem e nenhuma gravação. Em seguida envia `DOCUMENTO` sem número e conserva a asserção de orientação sobre o número global e de ausência de gravação. Permanecem todas as verificações seguintes de recebimento válido, mesma mensagem, repetição idempotente, titular verificado e resposta indistinguível para número alheio/inexistente. |
| `os-openapi-contract.test.ts`: esperava 45 rotas, encontrou 48 | A formalização da pendência de `corr-tarefas-pessoas` acrescentou três escritas `private-tasks` às seções 5/7, mas o teste ainda contava apenas as 45 operações originais. Não havia registro duplicado. | A expectativa exata passou para 48, com uma asserção adicional dos três pares método/caminho privados. As verificações de unicidade, parâmetros, corpos, erros, permissões e referências continuam cobrindo todas as operações; nenhuma rota foi retirada ou escondida da tabela do contrato. |

`integrationPendencies` também passou a testar literalmente `segue`, a ausência
de consulta à mídia e de gravação, além da orientação para `DOCUMENTO` e
`DOCUMENTO inválido`. Esse cenário passou no ensaio Node/SQLite e voltou a
falhar contra a implementação anterior, que capturava o anexo comum. A
conferência independente do OpenAPI reproduziu a divergência 45/48 e aprovou
as 48 operações únicas, 69 erros específicos e 3.681 referências de esquemas.
Ela inicializa `src/service` como o teste existente; não pressupõe que qualquer
descritor possa ser importado isoladamente antes do runtime.

O histórico local confirma que os testes ajustados pertencem ao trabalho do
motor: `os-documents.test.ts` foi criado em `0f36f752` (peça D),
`os-openapi-contract.test.ts` em `0707633f` (peça O). Não foram alterados testes
antigos do produto. Nenhum caso foi removido, pulado ou marcado como falha
esperada. Nesta rodada não foi necessária outra alteração de produção.

### Rodada anterior: inicialização do Worker

O log recebido na rodada anterior registrava build aprovado e **50 suítes com
falha, sem nenhum teste executado**. Todas pararam no mesmo erro de importação:
`TypeError: ensinoReads is not iterable`, em `src/modules/runtime.ts:40`.
O log atual confirma que esse bloqueio foi superado: todas as suítes chegaram
a executar seus testes.

A primeira importação de `src/index.ts` buscava `ensinoNoStore` no arquivo de
descritores `ensino/ensino.ts`. Ela entrava em
`ensino.ts → access.ts → security.ts → module-credentials.ts → web-steps.ts → service.ts → runtime.ts`.
O runtime tentava percorrer `ensinoReads` enquanto a avaliação de `ensino.ts`
ainda estava suspensa, antes de inicializar essa constante. O ensaio local
anterior começava pelo Coordinator; essa ordem de carregamento escondia o
defeito da entrada HTTP. TypeScript e o build do painel também não executavam
essa inicialização do Worker.

A correção move o middleware, sem alterar seus cabeçalhos ou comportamento,
para `src/modules/ensino/http.ts`, que só possui imports de tipos. O Worker
importa esse arquivo diretamente; `ensino.ts` mantém a reexportação para
compatibilidade. Não há adiamento assíncrono do registro, descarte de rotas ou
tratamento que ignore descritores ausentes.

Foi acrescentado `tests/os-i2-bootstrap.test.mjs`, executado pelo test runner
do Node. Ele empacota e carrega primeiro cada entrada real — Worker e
Coordinator — em processos separados, sem reaproveitar o cache de imports.
Além de inicializar, confere registros únicos de rotas, comandos, menus,
credenciais, ferramenta de Ensino, agendadores e módulos desligados por
padrão. **Antes da correção: 1/2 passou**, e a entrada Worker reproduziu o
mesmo erro e encadeamento do log externo. **Depois: 2/2 passaram**, com as
mesmas asserções. Somente a classe-base de Durable Object é adaptada nesse
teste; ele não substitui a execução Cloudflare.

`scripts/check-os-integration.mjs` também passou a carregar o Worker antes
do Coordinator, cobrindo essa inicialização no ensaio integrado habitual.
Os dois testes de inicialização foram repetidos e passaram nesta rodada.

## Pendências dos relatos de correção

| Origem / pendência | Veredito e aplicação | Evidência |
|---|---|---|
| `corr-motor`: escolhas de 1 a 32 e textos acima de 300 | Aplicada em `src/web-steps.ts` e `src/modules/os/forms.ts`: escolhas indexadas e `max_length` opcional, validado e renderizado; padrões antigos de 300/2000 mantidos quando omitido. Links já emitidos que pediam o ID em texto continuam aceitos conforme o campo persistido. | `integrationPendencies`: 1, 21 e 32 opções, texto de 1500, recusa de 1501 e de 301 no campo legado; conversão da resposta para o ID original, link anterior e recusa de ID inexistente. |
| `corr-painel`: versão do orçamento | `QuoteRequest.version?` em `contracts.ts`, conferida em `store.ts` antes de salvar; omissão continua aceita. | Versão obsoleta retorna 409; chamada legada sem versão continua funcionando. |
| `corr-painel`: metadados privados | `privacy.ts` retorna `PrivateFields.fields` do snapshot; `PrivateFieldsDialog.tsx` usa exclusivamente esse contrato. O botão em `WorkDetailPage.tsx` exige o papel explícito. | Leitura privada contém a definição sensível; detalhe sem papel não a contém. O detalhe autorizado conserva os metadados já oferecidos em I, por compatibilidade; valores continuam exclusivamente privados. |
| `corr-painel`: capacidades após revisão | `work-types.ts`/`contracts.ts` fornecem `features` da definição fixada; `WorkDetailPage.tsx` usa essas capacidades para abas e orçamento. `privacy.ts` remove-as da projeção de cliente/IA. | Revisão atual desliga recursos; trabalho antigo mantém as capacidades e revisão originais. |
| `corr-painel`: responsável, prazo e próxima tarefa | `store.ts`, `os.ts`, `contracts.ts` e `WorkListPage.tsx`: filtros no servidor e na tela; resumo em consulta única para a página, filtrado antes de escolher a primeira tarefa. IDs da página seguem em JSON para não ultrapassar o limite de parâmetros SQL. | Responsável e intervalo inclusivo; contagens globais preservadas; tarefa sensível anterior não aparece para quem perdeu o papel. |
| `corr-tarefas-pessoas`: corrida de privacidade | `src/coordinator.ts` serializa a rodada de módulos até enfileirar. `src/modules/local-wake.ts` e `api.ts` permitem continuação local, evitando RPC ao próprio objeto bloqueado. A rodada começa com cache de leitura novo. | `schedulerSerialization` pausa a seleção e disputa com reclassificação, conclusão, cancelamento e arquivamento. Contraprova anterior intercala; implementação atual aguarda. |
| `corr-tarefas-pessoas`: rotas privadas | Contrato atualizado com `private-tasks` e recusa nas operações comuns. API.md/OpenAPI já continham a separação; mantida. | Regressões existentes de tarefas, cenário integrado de tarefa privada e conferência das 48 rotas do contrato, incluindo as três escritas privadas. |
| `corr-lancamentos-modelos`: retomada de aplicação | `area-templates/index.ts` encaminha o identificador; `engine.ts` recupera antes da prévia; `service.ts` grava resultado e publicações no mesmo lote da configuração/procedência; Coordinator aceita retomada. Migração 0118. | Gatilho SQLite falha depois do commit; mesma chave recupera resultado e publica eventos com chaves estáveis, sem duplicar. Corpo diferente com mesma chave continua 409. |
| `corr-lancamentos-modelos`: resumo histórico e versão | Formalizados no complemento do contrato: resumo padrão vigente, histórico opcional; sem downgrade nem alteração de manifesto na mesma versão. Não se desfizeram proteções já implementadas. | Testes existentes de lançamentos/modelos preservados; reaplicação dos 17 modelos e recuperação local passaram. |
| `corr-lancamentos-modelos`: recuperação de lançamentos / antigo 501 | Já resolvidos em I; nenhuma segunda implementação. | Cenário integrado de recuperação de filho e testes existentes preservados. |
| `corr-api-apps`: `/stage` do embutido | Já corrigido por `corr-motor`; encaminha às operações legadas. Nenhuma mudança adicional. | Cobertura existente em `os-compatibility` e fluxo legado do ensaio integrado. |
| `corr-api-apps`: corrida de relógio no teste D1 | Aplicado um único `taskDueAt` em `tests/os-integration-scenarios.ts`; prazo e lembrete usam o mesmo instante. As 12 tarefas, asserções e tetos não mudaram. | Ensaio completo de orçamento passou: filhos 45/200 e alarme 163/800 instruções. |
| `corr-api-apps`: rótulos de histórico e capacidades no Android/iOS | Continua fora: a tarefa proíbe código móvel de produção. O servidor agora fornece capacidades fixadas; os consumidores móveis ainda precisam adotá-las. | Testes/fixtures móveis e produção móvel intactos. |
| `corr-f0`, `corr-documentos`, `corr-conteudo` | Não deixaram outros registros centrais pendentes. Correções existentes mantidas. A integração revelou incompatibilidades de Condomínio/Ensino com os modelos agora privados, corrigidas abaixo. | 17 modelos, regressões de anexos e cenários das extensões no ensaio local. |

Os três arquivos de teste já versionados alterados nesta integração foram
criados pelo próprio trabalho do motor: o cenário de I citado acima e os
testes das peças D/O descritos na correção da rodada atual. Nenhum teste antigo
do produto foi modificado; as asserções de segurança, recuperação e limites
foram preservadas.

## Revisão de segurança

| Achado de `rev-seguranca.md` | Veredito nesta base | Correção e teste |
|---|---|---|
| 1. MCP consulta outra conversa do mesmo bot | Confirmado e corrigido. | `bot-actions/actions.ts` separa autenticação da execução de contexto de pessoa; `engine.ts` assina também execuções de atendimento; `mcp.ts` fixa área/conversa no servidor nas ferramentas OS de chaves ligadas a bots. Rejeita assinatura ausente, inválida, vencida ou execução encerrada. Duas conversas do mesmo bot: argumentos forjados não trocam o titular; tarefas/documentos alheios são negados. Chaves comuns de integração, sem bots, preservam o contrato anterior. |
| 2. Expansão de mensagem bloqueia lembretes | Parcialmente já corrigido; falha por registro ainda era real. | O limite após expansão já estava em `store.ts`. `reminders.ts` agora isola falhas, avança com cursores duráveis por área/fila no R2 existente e só marca após sucesso. Testes: texto expandido/Unicode dentro de 3800, embutido continua, uma falha não impede a seguinte, cinquenta falhas não prendem a 51ª ordem. |
| 3. Aprovação notifica sem permissão | Já corrigido por `corr-motor`; não reaplicado. | `stageNotificationAuthorization` confirma decisão permitida sem mensagem, incluindo retomada com recibo externo incompleto. Asserções existentes de encaminhamento de `notify` mantidas. |
| 4. Dez tarefas sem destinatário prendem a fila | Já corrigido por `corr-tarefas-pessoas`; não reaplicado. | Regressão integrada confirma avanço durável até a 11ª tarefa, notificável, sem marcar as dez inviáveis como entregues. |

Os oito caminhos de ataque da revisão ficam assim:

| Caminho | Resultado desta integração |
|---|---|
| Equipe A ler B | Nenhuma fuga confirmada; cada extensão testa 404 ao reutilizar IDs em outra área. |
| Pessoa sem papel ler sigilo | Barreira preservada; leitura privada e prontuário exigem papéis explícitos. |
| WhatsApp de A consultar B | Falha MCP corrigida pelo vínculo autenticado da execução. |
| Aplicação limitada notificar indevidamente | Correção anterior de aprovação confirmada com replay. |
| IA receber sigilo/outra conversa | MCP corrigido; nenhum catálogo clínico e recusa de chamadas de IA, inclusive sem máscara. |
| Modelo alterar área/conteúdo executável | Nenhum achado novo; validação e seleção existentes mantidas; 17 modelos reaplicados. |
| Negação barata por lembretes | Isolamento/cursor de ordens acrescentado; cursor de tarefas confirmado. |
| JSON/etapa inválidos persistirem | Nenhum achado novo; validadores e transações existentes preservados. |

As contraprovas são executáveis com `--i2-baseline --i2-only`: o adaptador lê
os arquivos anteriores com `git show HEAD:caminho`, sem checkout, escrita Git
ou alteração de teste. Os oito cenários esperados falharam: MCP, lembretes,
anexo comum, recuperação do modelo, Condomínio, Ensino, auditoria de Saúde e
serialização. A expansão e os achados 3/4 já estavam corrigidos no HEAD; os
testes atuais confirmam a proteção existente, não alegam falha nessa base.

## Correções e fluxo principal de cada extensão

- **Jurídico:** registro completo; `scheduler.ts` solicita continuação com
  `modules: true`. Fluxo: modelo Advogados, calendário, cálculo/criação e
  confirmação de prazo ligado à tarefa; tarefa privada ausente para cliente,
  catálogo sem ferramenta jurídica e isolamento de área.
- **Condomínio:** `works.ts` aceita o campo unidade sensível dos modelos
  corrigidos, sem copiá-lo para extras públicos pelo ator técnico. O vínculo
  confiável fica em `cond_works`; tipos antigos não sensíveis seguem aceitos.
  `notices.ts` solicita continuação durável do agendador. Fluxo: modelo,
  bloco/unidade/morador, ocorrência e transição do trabalho, menu, troca real
  de credencial e consulta da unidade autorizada no portal. Unidade não sai
  em projeções comuns, eventos, histórico ou WhatsApp.
- **Saúde:** `access.ts` também rejeita identidade contendo bots; `store.ts`
  audita a consulta administrativa de atendimento, que antes não registrava
  leitura. Fluxo: modelo clínico, paciente, episódio, evolução e assinatura.
  Todas as famílias de leitura são conferidas quanto a auditoria e `no-store`;
  falha da auditoria impede a resposta. Há teste separado para WhatsApp, rota
  pública, exportação comum, evento, histórico, ferramenta de bot, chamada de
  IA, administrador sem papel e anexo/auditoria. Download e exportação clínica
  autorizada registram acesso; documentos comuns não contêm anexos clínicos.
- **Ensino:** `access.ts` aceita o modelo administrativo corrigido somente com
  extras sensíveis, nome privado e mensagens sem marcadores de identificação
  do aluno. Tipos antigos integralmente privados continuam aceitos. `store.ts`,
  `diary.ts` e `customer.ts` usam o nome privado nas consultas pedagógicas já
  autorizadas, sem usar o nome do responsável como aluno. Fluxo: modelo Escolas,
  matrícula, turma, aula/frequência, avaliação/nota, publicação do boletim,
  responsável vinculado e consulta pelo portal após troca de credencial.
  Conteúdo escolar não aparece no histórico/mensagens/eventos comuns ou bot.
  O middleware HTTP foi separado dos descritores para corrigir a falha de
  inicialização do Worker descrita acima, preservando `no-store, private` e
  `Referrer-Policy: no-referrer`.

`documents/delivery.ts` ainda capturava anexos sem comando em áreas com tipo
personalizado. Agora devolve `false` antes de inspecionar a mídia quando o texto
não começa pela palavra `DOCUMENTO`. Foto, áudio, legenda vazia e palavra apenas
parecida seguem para menu/bot; comando malformado continua recebendo orientação.
O teste original da peça D foi sincronizado com esse requisito nesta rodada,
sem perder a cobertura do recebimento válido, de titularidade e de idempotência.

## Verificação e limites

Novos arquivos: `tests/os-i2-bootstrap.test.mjs`, `tests/os-i2-harness.ts`, `tests/os-i2-scenarios.ts`,
`tests/os-i2-integration.test.ts`, quatro `tests/{juridico,condominio,saude,ensino}-i2-integration.test.ts`
e `tests/saude-i2-security.test.ts`. Usam o Worker, os comandos do Coordinator,
os modelos registrados e o padrão de fixture da primeira integração.
`scripts/check-os-integration.mjs` executa os mesmos cenários sem rede, com SQL
SQLite real, R2 em memória e adaptador de estado/input gate do Durable Object.
Esse adaptador não substitui a execução Cloudflare. Nesta rodada, o ensaio foi
repetido carregando primeiro a entrada HTTP corrigida, com as novas asserções
de anexo comum e comando malformado.

| Comando / conferência | Resultado local acumulado |
|---|---|
| `node node_modules/typescript/bin/tsc --noEmit` | Repetido e aprovado nesta rodada; compilador instalado, sem resolução por `npx`. |
| TypeScript estrito pela API local do compilador | Aprovado nesta rodada para projeto, dez arquivos de testes I2/D/O e suas dependências; inclui a declaração instalada de `cloudflare:test`. Configuração em memória, sem emitir arquivos nem executar testes. |
| `npm_config_offline=true npm_config_update_notifier=false npm run build` | Repetido e aprovado nesta rodada; avisos do empacotador sobre tamanho de chunks, divisão e diretivas do React Router. |
| `node --test tests/os-i2-bootstrap.test.mjs` | 2/2 aprovados novamente; antes da correção anterior, o Worker falhava com `ensinoReads is not iterable` e o Coordinator passava. |
| `node scripts/check-os-integration.mjs --i2` | Repetido e aprovado: Worker carregado primeiro; 11 cenários I2, nove barreiras clínicas, 17 modelos, recuperação/regressões existentes e orçamento D1. Filhos 45/200; alarme 163/800. |
| `node scripts/check-os-integration.mjs --i2-baseline --i2-only` | Repetido nesta rodada: oito contraprovas falharam como esperado. |
| OpenAPI, conferência independente em Node/esbuild local | Aprovada nesta rodada: 48 operações únicas, 69 erros específicos, 3.681 referências resolvidas; métodos/caminhos privados, parâmetros e corpos obrigatórios conferidos. Expectativa anterior de 45 reproduzida como falha. |
| `node scripts/juridico-check.mjs` | Aprovado na rodada anterior: cálculo, migrações, chaves e proteções; não repetido nesta rodada, sem alterações nesses componentes. |
| `node scripts/check-saude.mjs` | Aprovado na rodada anterior: sintaxe, codificação, migrações e guardas; não repetido nesta rodada, sem alterações nesses componentes. |
| `node scripts/ensino-verify.mjs` | Aprovado na rodada anterior: cálculos, frequência, DDL, FKs, capacidade e rollback; não repetido nesta rodada, sem alterações nesses componentes. |
| Guardas de codificação/conflitos, UTF-8 sem BOM/LF dos arquivos alterados e `git diff --check` | Aprovadas nesta rodada. |

O log externo recebido nesta rodada comprova **587 aprovações e duas falhas**,
incluindo aprovação dos quatro fluxos I2 das extensões, dos nove testes de
segurança de Saúde e dos sete testes centrais I2. As falhas atuais foram
corrigidas nos testes D/O conforme explicado acima; esse log é anterior a esses
ajustes. Ficam para nova execução pelo script externo todos os `tests/os-*.test.ts`,
`tests/area-template-*.test.ts`, `tests/juridico-*.test.ts`,
`tests/condominio-*.test.ts`, `tests/saude-*.test.ts`, `tests/ensino-*.test.ts` e a
regressão antiga. Não executei Vitest, Wrangler, testes móveis, navegador,
canal real ou migração remota. Não há afirmação de aprovação integral dessas
suítes após a correção. O teste de inicialização `.mjs` usa Node, não Vitest,
e deve ser chamado pelo comando explícito da tabela.

Os erros de auditoria/publicação induzidos pelo ensaio local e pelas suítes
externas de recuperação são contraprovas deliberadas; suas asserções passaram.
Não são as duas falhas resumidas pelo verificador externo. Os logs locais
desta rodada estão em `/tmp/motor-i2-build.log`, `/tmp/motor-i2-integration.log`,
`/tmp/motor-i2-baseline.log`, `/tmp/motor-i2-openapi.log` e
`/tmp/motor-i2-typecheck.log`.

Permanecem os limites funcionais declarados nos guias: calendário jurídico
depende de curadoria; Condomínio não implementa rateio/contabilidade, reservas
ou controle físico; Saúde não implementa receita legal, certificado profissional,
entrega ao paciente/representante nem definição institucional de guarda, e a
exportação grande ainda precisa de medição; Ensino não implementa censo,
histórico oficial, PDF, financeiro/Agenda ou calendário automático. A interface
móvel ainda precisa consumir capacidades e rótulos novos. Reentrada em etapa
mantém a semântica atual; não há dúvida técnica bloqueante para este registro.

Sem mudanças em `src/erp/` ou no código de produção de `mobile/`, sem commit,
push, troca de branch, rede ou recursos Cloudflare novos.
