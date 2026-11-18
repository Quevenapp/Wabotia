# Entrega I — junção e orçamento D1

## Estado da entrega

Registros integrados, quatro testes desatualizados corrigidos e testes de junção/orçamento acrescentados. O retorno externo foi analisado e suas duas causas foram corrigidas: fixture incoerente de T na consulta de prazos e cópia de documento por stream dentro do bloqueio do Coordinator. Nenhum teste anterior ao motor foi alterado. Os 17 modelos passaram pela rota de prévia/aplicação em áreas limpas e pela validação real de M, tanto no log externo recebido quanto no ensaio local atualizado. Nenhum modelo precisou de correção; a validação não foi relaxada.

O TypeScript instalado (`node node_modules/typescript/bin/tsc --noEmit`, equivalente local a `npx tsc --noEmit`) e `npm run build` passaram nesta rodada. O ensaio sem rede também passou, incluindo recuperação, rollback e as novas regressões. **Não executei Vitest nem o runtime Workers nesta rodada**. O log externo anterior registrou **352 testes aprovados e 3 falhas, em 27 arquivos (24 aprovados/3 com falha)**; a aprovação após estas correções depende de uma nova execução externa. O adaptador SQLite/R2 em memória não reproduz o runtime Cloudflare.

## Registros

- `src/modules/os/extensions.ts`: `tasksExtension`, `peopleExtension`, `documentsExtension`, `entriesExtension`, nesta ordem. Leituras, comandos, rotas JSON/binárias, ferramentas, turnos e manutenção passam pelo runtime agregado de F0.
- `src/modules/os/definition.ts`: seis eventos de M, quatro de T, três de P, três de D e três de L; grant explícito `os:sensitive`; negações de bot pedidas por T/P/D/L; navegação `work`, `my-deadlines`, `work-types` após as entradas legadas. As negações de F0 permanecem.
- `src/modules/runtime.ts`: validação de `os_area_setup` e extensão administrativa de modelos, disponível com OS desligado. Não há segundo `onSchedule("os")`.
- `src/area-templates/index.ts`: Assistência técnica, Serviços, Oficina mecânica, Lavanderia/costura, Gráfica, Despachante, Imobiliária, Engenharia, Arquitetura, Construtora, Advogados, Escritório de advocacia, Clínica médica, Clínica veterinária, Escolas, Professores e Condomínios.
- `web/app/Shell.tsx` e `MoreArea.tsx`: rótulo da coleção no trilho/Mais via `useWorkNavigation`.
- Migrações `0100`–`0105`: os arquivos existentes já são descobertos pelo diretório de migrações. A aplicação HTTP exercitou a tabela de procedência de `0105`. Não foi necessário inventar um registro SQL no núcleo, editar migrações ou aplicá-las em instalação externa.

`registry.ts`, `api.ts`, `hooks.ts`, `src/index.ts` e `service.ts` já fornecem os adaptadores genéricos de F0, a lista de rotas limitadas à conversa e o planejador. Os relatos não exigem novos registros nesses arquivos; `api.ts` recebeu a correção do adaptador de anexos descrita abaixo. Não foram duplicados registros ou módulos de profissão. O prefixo de rotas de OS permanece `service-orders`; modelos continuam no núcleo administrativo.

## Divergências conciliadas e defeitos corrigidos

1. **F0 versus M nos quatro testes.** Tipo personalizado não salvo resulta em `404 type_not_found`. Mutação interna vazia resulta em `409 version_conflict`, sem escrita. O teste de L agora confirma criação real, histórico, evento único e repetição; o teste de resolução também salva um tipo pela operação real e o resolve. As demais asserções de isolamento, módulo desligado e recursos do embutido permanecem.
2. **W versus T em Meus prazos.** W propunha `/work-tasks`; T entregou `/service-orders/my-tasks`. O cliente passou a usar a rota de T. A consulta aceita `assignee=me`, `state`, `type_id`, `period=overdue|today|next7|range|undated`, `due_from`, `due_to`, cursor e limite. Sem período, preserva a consulta anterior de tarefas com vencimento. Datas civis usam Brasília; o cursor incorpora ator/área/filtros/visibilidade e janela civil. O DTO acrescenta tipo, número exibido e etapa, sem contatos. Um JOIN traz o snapshot; não há leitura de pai por linha personalizada. O caminho anterior consultava cada pai separadamente. A assinatura normativa de `Task` não mudou.
3. **W versus T/D nas escritas privadas.** W marcava `sensitive` mas enviava à rota comum, recusada pelos filhos. `work-api.ts` escolhe `private-tasks`/`private-documents`; ações de tarefa propagam a classificação, e documentos usam a mesma coleção na reserva, upload, confirmação, download e arquivamento. A aba oferece consulta privada para pessoa com concessão explícita. P/L mantêm suas rotas com autorização humana no manipulador e escritas fora do catálogo do bot, conforme os relatos.
4. **W versus M nas definições de campos privados.** O editor dependia de `Order.fields`, mas M retirava todas as definições sensíveis, inclusive do humano autorizado. O detalhe agora inclui somente as definições autorizadas do snapshot para quem passa por `mayReadSensitive`; os valores continuam exclusivamente em `/private-fields`. Assim, uma revisão atual diferente não reinterpreta os controles da ordem antiga. Cliente/bot continuam sem essas definições/valores.
5. **M versus F0 na concessão.** O grant foi declarado para permitir atribuição explícita. `src/team.ts` preserva `/grants` da área somente com embutido: exibe `os:sensitive` quando há tipos personalizados ou alguém já possui a concessão. Administrador e `*` continuam sem acesso sensível automático. O teste antigo `module-grants.test.ts` ficou intacto.
6. **Inicialização de A.** O registro direto da constante podia acontecer antes de sua inicialização no ciclo `service → runtime → catálogo → engine/security → service`. A fábrica `createAreaTemplatesExtension()` constrói descritores cujos handlers resolvem os dados ao atender. O export original continua disponível. Não há espera assíncrona ou janela com rotas ausentes.
7. **Transporte binário de F0/D.** `binaryCommand` não enviava `requestId` ao Coordinator. A auditoria tentava vincular `undefined` ao D1; D recuperava o transporte, mas deixava o recibo técnico incompleto. Agora cada chamada tem identificação de auditoria. O teste integrado exige os dois recibos técnicos fechados, além de hash, bytes e replay.
8. **Recuperação de M barrada no Coordinator.** Para filhos e operações novas de etapa/campos privados com recuperação própria, um recibo existente sem resposta agora permite retomar a operação com o mesmo `operationId`. Antes o núcleo respondia `operation_unknown` sem chegar a `commitChild`/replay de M. O teste preserva filho e histórico, simula a fronteira de publicação/recibo e comprova recuperação sem duplicação. O tratamento genérico das demais operações foi preservado.
9. **Registro dos filhos versus custo/fluxo legado.** O agregado de agenda e turno não executa os filhos quando não há tipos personalizados. Reutiliza a configuração já cacheada pelo núcleo, preservando a OS embutida e evitando consultas de tarefas/documentos a cada mensagem ou alarme legado.
10. **Tarefas padrão de T versus contrato/modelos.** O tipo normativo não define modelos de tarefa por etapa nem sua persistência. Não foi inventado campo/gancho novo. `createStageTasks` continua disponível internamente; os modelos mantêm a criação dessas tarefas como passo manual, conforme A e os seis relatos de modelos.
11. **Complementos compatíveis mantidos.** P usa papel livre e não ganha campo de documento. L usa `quantity_milli` e `kind` livre, sem dinheiro ou financeiro automático; mantém o resumo exato textual. D mantém MIME explícito, coleções privadas, cursor de limpeza no R2 e tentativa exclusiva. A mantém a conversão `message → content`, prefixos e preservação de edições. O snapshot de abertura de M permanece na tabela auxiliar aditiva já entregue em `0100`. Nenhuma dessas escolhas exigiu afrouxar o contrato.
12. **Fixture de T versus etapa persistida de M (retorno externo).** `setup()` criava uma OS embutida com etapa `received` antes de simular `motorWorkType()`, cujo início é `entrada`. A consulta agregada passou a ler a etapa real via JOIN e não encontrava esse ID no tipo simulado, produzindo `TypeError` ao acessar `.label`. A fixture local de T agora salva o tipo pelo comando real de configurações e abre uma ordem desse tipo antes dos mocks do filho. O corpo e todas as asserções do teste que falhou permanecem intactos; a fixture congelada de F0 também. Os mocks restantes continuam explícitos e não são apresentados como prova da atomicidade de M.
13. **Validação da projeção de prazos.** A consulta agora traz também o estado do pai no mesmo JOIN e confere a etapa efetiva e seu `base_status`, como o detalhe de M. Uma linha inconsistente retorna `409 invalid_snapshot`; não escolhe arbitrariamente a etapa inicial nem lança `TypeError`. O cenário novo usa dois pais reais, etapas diferentes, empate de vencimento, cursor, tarefas concluídas, sem responsável e sem prazo, além de corromper/restaurar a etapa para conferir ambos os erros de consistência. A contagem D1 permanece igual.
14. **F0/D: bloqueio no envio de documentos (retorno externo).** As duas falhas de I chegavam a `/documents/:id/send`, esperavam cerca de 30 segundos em `blockConcurrencyWhile` e terminavam com reset do Durable Object e HTTP 500. O caminho era `sendDocument → outgoingAttachment → storeRemoteMedia → putStream`: `pipeTo(FixedLengthStream)` alimentava o R2 enquanto o comando mantinha o input gate bloqueado. O adaptador de módulos agora lê no máximo 10 MiB, confere o tamanho real e grava `ArrayBuffer` diretamente no R2 antes dos metadados D1. Conserva a serialização, a chave estável, a autorização, o MIME e a idempotência. `readBinaryContent` aceita também `Response` para reutilizar a contagem limitada e o hash; a interface `OutgoingAttachment` não mudou. O transporte genérico de arquivos de até 100 MiB e seus outros consumidores ficaram intactos.

A limitação que ocultava a falha no ensaio anterior também foi corrigida: o substituto Node de `FixedLengthStream` agora recusa uso dentro de `blockConcurrencyWhile`. Com essa guarda, o código anterior falhou no mesmo endpoint e mostrou a cadeia acima; o código corrigido passou. Isso detecta o caminho problemático, **não reproduz o timeout/input gate do workerd**. A confirmação no runtime real continua pendente. Nenhum timeout ou teto foi aumentado, nenhum caso foi removido e nenhuma asserção foi relaxada.

## Arquivos adicionais de teste e suporte

| Arquivo | Conteúdo |
|---|---|
| `tests/os-integration.test.ts` | 20 casos: um por modelo registrado (17), fluxo completo com recuperação, regressão de prazos e regressão do adaptador de anexos. |
| `tests/os-d1-budget.test.ts` | Tetos da seção 10, medidos separadamente por invocação Worker/Coordinator; relatório `OS_D1_BUDGET`. |
| `tests/os-integration-fixture.ts` | Fixture local de I, HTTP real, interceptação apenas para contar D1 nas invocações do Coordinator e controle do alarme. |
| `tests/os-integration-scenarios.ts` | Cenários compartilhados: modelos, etapas/aprovação, filhos, paginação, privacidade, catálogo do bot, clientes web, replay e rollback. Acrescentadas conferências dos bytes/MIME/ator da cópia pública e da entrega única na outbox; tamanhos divergentes e excesso de 10 MiB recusados antes de gravar D1/R2; conflito de metadados no replay. |
| `scripts/check-os-integration.mjs` | Execução dos mesmos cenários sem rede nem Vitest: SQL real em SQLite, classes Worker/Coordinator existentes, adaptadores locais de R2/estado DO, guarda contra `FixedLengthStream` em comando serializado e bloqueio de `fetch` externo. Artefato temporário de bundle removido ao terminar. |
| `tests/os-documents.test.ts` | Atualização do caso de fronteira F0/M, preservando as outras asserções. |
| `tests/os-entries.test.ts` | Atualização dos dois casos de fronteira F0/M e provas positivas de persistência/resolução. |
| `tests/os-tasks.test.ts` | Atualização da recusa da mutação vazia e preparação de pai personalizado coerente na fixture local; preservadas as asserções de prazos, isolamento e ausência de escrita. |

Outras alterações por arquivo: `src/coordinator.ts` (item 8), `src/modules/api.ts` (14), `src/modules/binary.ts` (7/14), `src/modules/os/extension-runtime.ts` (9), `src/modules/os/os.ts` (4), `src/modules/os/tasks/store.ts` (2/13), `src/team.ts` (5), `web/modules/os/work-api.ts` (2/3), `work-contracts.ts` (comentário da rota definitiva), `tasks/WorkTasksTab.tsx`, `tasks/MyDeadlinesPage.tsx` e `documents/WorkDocumentsTab.tsx` (3). Os demais arquivos alterados são os registros enumerados acima e este relatório.

A fixture congelada `tests/os-motor-fixture.ts`, os testes anteriores ao motor, `src/erp/` e `mobile/` permaneceram intactos.

## Medição D1 local

Cada instrução SQL conta, inclusive cada elemento de batch. As contas incluem autenticação/escopos, configuração/estado, recibos, auditoria e publicação/enfileiramento que pertencem à respectiva invocação. Worker e chamadas ao Coordinator não são somados como se fossem uma única invocação. Fixture/carga ficam fora da janela de medição. R2 é exercitado, mas não conta como D1.

Resultados do adaptador local, medidos novamente após as correções e sem alteração dos tetos; a reconfirmar pelo teste no runtime Cloudflare:

| Operação | Worker | Coordinator (máximo por chamada) | Teto contratual de cada invocação |
|---|---:|---:|---:|
| Catálogo de tipos | 3 | — | 15 |
| Lista, inclusive página de 50 | 4 | — | 20 |
| Lista com facetas | 5 | — | 25 |
| Detalhe sem histórico | 3 | — | 15 |
| Detalhe legado | 4 | — | 20 |
| Histórico paginado | 4 | — | 20 |
| Tarefas / pessoas / documentos / lançamentos, separadamente, página de 50 | 4 cada | — | 20 cada |
| Criação de ordem | 2 | 19 | 60 |
| Mudança de etapa com mensagem | 2 | 22 | 50 |
| Pedido / decisão de aprovação | 2 | 23 / 21 | 50 |
| Criar tarefa / pessoa / lançamento | 2 | 19 / 18 / 19 | 45 |
| Retificar lançamento | 2 | 22 | 45 |
| Reservar / confirmar documento | 2 | 19 / 18 | 45 |
| Prévia de modelo | 2 | 10 | 25 |
| Aplicação de modelo | 2 | 24 | 80 |
| Repetir criação / etapa / aplicação com recibo | 2 | 6 | 60 / 50 / 80 |
| Conflito de versão da etapa | 2 | 9 | 50 |

Medições adicionais: Meus prazos 3; upload 12 no Worker e no máximo 11 por comando técnico; replay de upload 12/6; download 4; envio de documento 2/22; recuperação de lançamento sem recibo concluído 2/12. Os testes não inventam tetos contratuais para upload/download/envio, que não têm linha própria na seção 10.

- Trabalho adicional dos filhos: **45 instruções**, teto 200; no máximo 10 itens, com `has_more` e continuação sem descartar pendências.
- Alarme completo: **163 instruções**, teto 800. Inclui manutenção, todos os módulos operacionais ligados no cenário, 50 paralisações de ordens, continuação de prazos e três reservas documentais expiradas. O teste verifica os efeitos finais, não apenas o contador. Entregas dos comandos já foram verificadas antes e são canceladas na preparação desta carga; não há chamada a provedor externo.
- O lembrete ao cliente é medido com enfileiramento real e conferido duas vezes para garantir aviso único. A rodada agregada também verifica que existe apenas um agendador de OS.

## Verificações e pendências

O log externo recebido comprovou os 17 casos de aplicação/validação de modelos e as regressões antigas nele listadas, inclusive `os-orders`, `os-whatsapp`, privacidade, documentação, registro e painel. As três falhas foram uma em T e uma em cada arquivo de I, pelas causas acima. Como o teste de orçamento parou no envio do documento, esse log **não confirma os números D1 finais**. Também não contém resultado para todos os arquivos legados solicitados, como `module-grants`, `modules-api`, `modules` e os orçamentos antigos.

Executado localmente após as correções:

- `node node_modules/typescript/bin/tsc --noEmit`: aprovado, sem resolução/download de pacotes.
- `npm run build`: aprovado; avisos existentes sobre chunks/grupo e diretivas `use client` do React Router.
- TypeScript estrito adicional dos dois testes de I e seus auxiliares: aprovado, com tipos de teste Cloudflare e Node; sem executar Vitest.
- `node scripts/check-os-integration.mjs`: aprovado, os 17 modelos por HTTP, fluxo completo, regressões de prazos/anexos, sigilo, orçamento, recuperação e rollback. O embutido faz orçamento, aprovação, execução, retirada e entrega ao lado do tipo personalizado, conservando estados e sequência de histórico. O cenário de envio permanece dentro do Coordinator real, com estado DO/R2 adaptados localmente.
- `node scripts/check-conflict-markers.mjs`, `node scripts/check-encoding.mjs` e `git diff --check`: aprovados. A guarda de codificação conferiu 3.873 arquivos de texto versionados; os arquivos novos também foram conferidos em UTF-8 sem BOM e LF.

Na rodada anterior, uma checagem TypeScript opcional que incluiu os testes de T encontrou anotações preexistentes (`uid()` inferido como UUID literal em helpers e uniões com filtro opcional). Não foram alteradas essas anotações para acomodar a checagem; o `tsconfig` oficial passa e os testes de I passaram novamente na checagem estrita isolada. A alteração atual de T corrige somente a preparação incoerente do pai, além da atualização dos quatro testes já descrita.

Fica para a nova verificação externa: todos os `tests/os-*.test.ts`, `tests/area-template-*.test.ts` e a regressão antiga, incluindo `os-orders`, `os-whatsapp`, `module-grants`, `module-sensitive-data`, `modules-api`, `modules`, `module-query-limits`, `bot-tools-verticais`, `b9-conferencia`, `menu-module-types`, os orçamentos antigos e `command-receipt-closing`. Priorizar `os-tasks`, `os-integration` e `os-d1-budget`, que falharam no log, conferindo também `os-foundation` pelo adaptador de anexos. Não há afirmação de 100% da suíte antes desse retorno.

Sem execução/compilação dos testes móveis de C ou atualização de suas fixtures; as limitações móveis e contraprovas desativadas relatadas por C permanecem. Sem validação visual no navegador, implantação, migração remota, novo recurso Cloudflare, commit, push, troca de branch ou acesso à rede. Mantidas as pendências funcionais já declaradas nos modelos (prontuário, prazo forense, tarefas automáticas, permissões específicas, vínculo de aprovação à versão documental etc.). A ampliação da lista de MIME continua uma decisão de produto; não há dúvida bloqueante de registro.
