# Canais — registro de aceite

Atualizado no fechamento da primeira leva: 19/11/2026. Referência contratual: `20e15da9`. **Aceite final pendente: a última execução externa passou em `check` e na comparação D1, com delta zero de linhas escritas, mas a suíte completa terminou com quatro falhas. As correções da ficha e da fixture de junção desta rodada aguardam nova verificação; o timeout cadastral precisa de repetição isolada.** Esta máquina restringe rede, Vitest e Wrangler na sessão de edição; nenhum resultado abaixo deve transformar revisão de código ou resultado informado por outra tarefa em execução nova.

## Proveniência e estado inicial

O orquestrador informou que a cópia inicial contém a base e as oito tarefas de implementação integradas. Informou também `tsc --noEmit` verde, 348 casos na execução conjunta de `tests/cn-*.test.ts` e legados relacionados pelo servidor, além de Android `assembleDebug` e testes unitários compilados nesta máquina. Esses são resultados de entrada, não uma execução da suíte completa no aceite. O iOS não foi compilado no Windows.

`20e15da9` é a referência da comparação; a distribuição 0.22.0 identifica outro commit e não serve como baseline. O artefato externo `output/cn-aceite/baseline-reference.json` resolveu a referência para **`20e15da9f249f49ff6ec28d273347063950a4c56`**. Na rodada 1, o harness SHA-256 foi `227e955476ec684125c43727ada538d71677b520abf21b8b5e552f4c068d79b5` (fixture v1); na rodada 2, foi `1815d1b2f54c7d9fe0893b36f30f12d5e0cdb49778547b3e04b4e11f5f070ab4` (fixture v2, snapshot `baseline-7sTpLP`). Ambos identificam execuções que falharam. Os hashes do resultado e do harness de cada nova execução devem ser preservados com seus relatórios; não são preenchidos por estimativa. As rodadas abaixo são histórico anterior ao fechamento.

## Falha externa e correção da rodada 2

O `npm run check` externo passou, incluindo 4.348 arquivos de texto verificados em UTF-8 e TypeScript. A etapa seguinte falhou no próprio snapshot de `20e15da9`: `tests/cn-baseline-probe.test.ts` esperava no máximo 20 instruções na primeira entrada, mas mediu **22**. O log daquela execução registrou a assertion original; `output/cn-aceite/baseline.log` é atualizado a cada execução. O probe do resultado, a comparação de custo e as etapas posteriores da linha não chegaram a executar.

A fixture v1 configurava `service.mode=human` e menu desligado. Nesse modo, o `inbound` já acrescentava na referência a consulta `gatedArea()` e a instrução do evento `conversation.updated` para a entrada na fila. O teto de 20 em `tests/d1-budget.test.ts` corresponde à linha herdada (`inherit`), com menu automático. Aplicá-lo à linha humana misturava dois cenários. `tests/cn-orcamento.test.ts`, ainda não alcançado pela verificação, repetia esse erro de fixture.

Correção, somente em arquivos B10:

- `tests/cn-baseline-probe.test.ts`: preserva integralmente o cenário humano `first` e sua comparação sem aumento, inclusive as duas instruções; acrescenta `inherit_first` em área separada, pelo Coordinator real, com menu humano simples e os tetos originais de **20** na entrada e **30** no motor. Confere inbox concluída e menu enfileirado para impedir aprovação de fase vazia. Mantém o teto de 30 também no motor humano, replay 1/1 e identidade pronta sem I/O. O harness passa a v2.
- `tests/cn-orcamento.test.ts`: usa linha herdada com menu automático no caso dos tetos históricos, com as mesmas verificações de processamento. O SQL medido acompanha falhas dos tetos.
- `scripts/cn-baseline.mjs`: identifica a fixture v2, recusa relatório antigo e inclui as últimas 80 linhas do log na falha do subprocesso, preservando também o arquivo completo. Autotestes cobrem causa original, timeout e versão incompatível.
- `docs/CANAIS-ACEITE.md`: registra causa, correção, evidência recebida e verificações desta rodada.

Nenhum teto foi aumentado, nenhuma instrução foi descontada da comparação, nenhum teste legado foi alterado e nenhum arquivo de implementação precisou de correção nesta rodada. Portanto não há nova exceção em `INTEGRATION_FIXES`. A correção foi relida contra o código de referência e o atual; passar no runtime continua sendo requisito externo.

## Falha externa e correção da rodada 3

O `npm run check` externo passou novamente, incluindo 4.348 arquivos de texto em UTF-8 e TypeScript. A fixture v2 avançou até a falha proposital antes do lote da inbox. O runtime registrou `cn: queda antes do lote` e `broken.inputGateBroken`; o Worker respondeu com `internal_error`, mas o teste terminou com a mesma exceção. A comparação de custo, a suíte inteira e as demais etapas continuaram sem execução completa.

O harness conservava um único stub do Coordinator para toda a prova. A rejeição dentro de `blockConcurrencyWhile` invalida os stubs da instância; embora `quietCoordinator` obtenha um novo, o `finally` de `http` voltava a usar o stub antigo em `runInDurableObject`. Esse helper encaminha a chamada por `stub.fetch`, portanto a própria limpeza propagava outra vez o erro da instância encerrada, antes de conferir o HTTP e a recuperação.

Correção, somente em três arquivos B10:

- `tests/cn-baseline-probe.test.ts`: obtém um novo stub para cada acesso ao mesmo ID de Coordinator, inclusive na restauração do ambiente após falha. Continua executando Worker, Coordinator, serialização e reinício reais; preserva a injeção D1 antes/depois do lote, resposta HTTP de erro, contagem persistida e recuperação sem mensagem duplicada. Acrescenta a exigência de exatamente uma chamada falha, do tipo batch contendo o INSERT da inbox. Não captura genericamente nem ignora erros do runtime.
- `scripts/cn-baseline.mjs`: passa `FIXTURE_VERSION` para 3, em conjunto com o título e relatório do probe, para recusar evidência anterior à correção. O mesmo harness é copiado para referência e resultado.
- `docs/CANAIS-ACEITE.md`: registra diagnóstico, hashes da execução recebida, verificações locais e pendências desta rodada.

Nenhum arquivo de produto, migração, dependência, limite ou teste legado foi alterado. Não há nova correção a declarar em `INTEGRATION_FIXES` nem pedido de alteração à base por esta falha. A exceção injetada continua sendo obrigatória e pode aparecer no log do workerd; a evidência de sucesso exige que as assertions e a execução completa passem. O diagnóstico foi conferido por leitura do snapshot de referência, do código atual e do helper instalado, sem executar Vitest.

## Execução externa recebida no fechamento

Após as três rodadas de preparação, o orquestrador corrigiu o transporte do relatório no commit `fix(cn-aceite): relatorio da medicao pelos metadados do teste` e executou as etapas de verificação. **A saída de console dos testes do Worker não chega ao terminal neste ambiente.** O probe grava o JSON em `task.meta.cnBaselineReport`; `scripts/cn-baseline.mjs` o lê do arquivo do reporter JSON do Vitest. O relatório antigo de `tests/d1-budget.test.ts` continua sendo impresso no console e, portanto, não é visível aqui; esse teste não foi alterado.

Resultados informados pelo orquestrador, anteriores às correções desta tarefa:

- `check`, build web e conferência de donos passaram.
- A medição do pacote passou: acréscimo de **142.812 bytes**, dentro do teto de **524.288 bytes**. O total absoluto não foi fornecido no resumo; deve ser consultado no artefato da execução, sem estimativa.
- A comparação D1 falhou: por exemplo, `next/coordinator` gravou **17 → 18** linhas, `first/coordinator` **52 → 54**, `ambiguous/coordinator` leu **71 → 75** e `recovery_before/coordinator` **60 → 68**. `first/coordinator` leu menos (**51 → 45**), o que é permitido. O anexo do fechamento contém os demais deltas por chamada.
- A suíte completa falhou nos três casos E7 de `c-identidade` (**1.246**, **1.027** e **1.048** linhas lidas, limite mantido em **600**), nos doze casos de `f1-profile`, no Facebook de `cn-aceite` (`UNIQUE tickets.number`) e em um timeout de `c-cadastro` (**5.000 ms**; arquivo levou **25 s** nesta máquina).

Esses números são evidência anterior às correções. A execução posterior à primeira rodada de fechamento está registrada abaixo; não houve aprovação integral da suíte.

Correções de fechamento, com migrações ainda não publicadas:

| Defeito e arquivos | Causa e correção | Cobertura a executar no Worker |
|---|---|---|
| Escritas por mensagem — `migrations/0140_channels.sql`, `src/index.ts`, `tests/cn-api.test.ts` | O índice recente incluía WhatsApp/aplicações. Agora cobre somente `channel IS NOT NULL AND channel<>'whatsapp'`; o filtro social repete os predicados e preserva as exclusões de origem. WhatsApp usa o caminho legado | `cn-api` captura o SQL real da rota e exige o índice parcial por `EXPLAIN QUERY PLAN`; `cn-baseline` continua exigindo ausência de aumento por cenário |
| Leituras de identidade/E7 e escrita de contatos — `migrations/0142_customer_channels_and_merges.sql`, `src/customer/identity.ts`, `tests/cn-identidade.test.ts` | O índice de junções incluía contatos com `merged_into IS NULL` e desviava a busca do índice de telefone. Agora cobre só aliases (`merged_into IS NOT NULL`). A leitura residual no UPDATE com guarda de canal é corrigida pelo alvo unitário `id=?`, descrito abaixo; não há gatilho novo nas migrações 0140–0143 | `cn-identidade` exige `contacts_legacy_phone` no snapshot/assertion e compara o custo da guarda no alvo unitário; casos E7 e limites de `c-identidade` permanecem intactos |
| Ficha — `src/customer/profile.ts`, `tests/cn-juncao.test.ts` | Restaura projeção explícita e predicado literal `namespace='team'`; preserva a ficha simples de aplicação para humanos autorizados e fixa o namespace de origem ao seguir aliases. Canais/contribuições ficam em `team` | `f1-profile` e `c-ficha` intactos; prova de ficha social/alias/namespace e fixture corrigida em `cn-juncao` |
| Protocolo Facebook — `tests/cn-aceite.test.ts` | Artefato da fixture: Instagram e Facebook inseriam o número global fixo `10001`. Agora o protocolo nasce pela rota real do Coordinator; o número retornado alimenta as assertions e o vínculo cadastral é conferido | Mantidos `Promise.all` dos webhooks e todas as provas de unicidade e isolamento; produto já calcula a numeração dentro do `INSERT` |
| Timeout cadastral — teste inalterado | O caso exato não foi identificado no log recebido. A importação de 500 contatos pagava uma escrita adicional no índice de junções por contato, removida pela correção da 0142. Não é possível atribuir o timeout apenas ao Windows | Repetir o caso isolado e a suíte `c-cadastro`, sem aumentar timeout |

`scripts/cn-ownership-check.mjs` registra arquivo, motivo e teste das correções integradoras, preservando donas e verificações. Os ajustes de tipos nas fixtures de `cn-identidade` não alteram suas assertions em execução. O checkout Windows trouxe CRLF; os arquivos conferidos pelo aceite e os editados são normalizados para LF, sem alteração de conteúdo dos demais arquivos.

Verificações locais da primeira rodada de fechamento, sem Vitest, Wrangler ou rede:

| Comando | Resultado em 19/11/2026 |
|---|---|
| `node node_modules/typescript/bin/tsc --noEmit` | Passou; não executa os testes do Worker |
| TypeScript específico de `cn-aceite`, `cn-api`, `cn-identidade` e `cn-juncao`, com os tipos Cloudflare e declaração temporária dos bindings | Passou após corrigir somente anotações de tipos nas fixtures de `cn-identidade`; não executa os casos |
| `node scripts/cn-baseline.mjs --self-test` | Passou; valida o comparador com dados sintéticos, sem medir D1 |
| `node scripts/check-encoding.mjs` | Passou |
| `node scripts/check-conflict-markers.mjs` e `git diff --check` | Passaram |
| `node scripts/cn-ownership-check.mjs` | Passou após normalizar o checkout para LF: 150 arquivos da leva conferidos contra a referência, 10 donas, nenhuma sobreposição ou alteração protegida. O relatório está em `output/cn-aceite/ownership.json` |
| `node --no-warnings --test output/cn-identity-plan.test.mjs` | Passaram dois testes temporários com `node:sqlite` e as migrações reais: telefone usa `contacts_legacy_phone`, paginação usa `contacts_identity_page`, lista Instagram usa `conversations_channel_recent` e WhatsApp/sem filtro usa `conversations_recent`. O arquivo auxiliar foi removido; essa prova local de plano não é medição de linhas do D1 |

A primeira correção da ficha selecionava somente `namespace='team'`, inclusive ao seguir alias. Isso fez `f1-profile` passar, mas bloqueou a ficha simples de aplicação que `c-ficha` já protegia. A rodada 3 abaixo corrige essa regressão e a expectativa do teste novo; testes antigos permanecem intactos. A seção de canais continua condicionada à existência de identidade social visível ou conexão social, verificada por índices na mesma leitura de contato `team`.

## Fechamento, rodada 2 — leitura residual no cenário ambíguo

O log externo passou em `npm run check` (4.357 arquivos de texto em UTF-8) e parou em `node scripts/cn-baseline.mjs`: `ambiguous/coordinator/rowsRead` **70 → 71**, com agregado **121 → 122**. Os artefatos recebidos `baseline.json`, `current.json` e `comparison.json` confirmam que o lote de identidade passou de **68 → 69** linhas lidas e manteve **29 → 29** escritas. Todos os cenários/fases tiveram delta zero de linhas escritas; não houve outro aumento de métrica. `recovery_before` voltou ao custo de referência. Como a linha usa `&&`, suíte completa, build, pacote e conferência de donos não foram executados novamente por essa linha após a reprovação.

A guarda `AND (channel IS NULL OR channel='whatsapp')` no UPDATE telefônico preservava o isolamento social, mas fazia o SQLite ler a conversa ao materializar o conjunto de IDs de `IN (json_each(?))` e depois lê-la novamente para atualizar. O plano local confirmou a perda de cobertura de `conversations_id_profile` e o cursor `OpenRead` da tabela antes de `OpenWrite`. Os planos dos outros dez comandos do lote permaneceram iguais.

`src/customer/identity.ts` agora usa `id=?` para atualizar uma única conversa. A guarda de canal e o filtro de área permanecem; lotes com zero ou vários IDs conservam o caminho anterior. O plano local passa diretamente ao cursor de atualização, sem a leitura intermediária da conversa. `tests/cn-identidade.test.ts` acrescenta comparação de custo D1 da guarda para WhatsApp explícito/legado e provas de isolamento social/área; `scripts/cn-ownership-check.mjs` registra a correção integradora. Nenhum teto, comparador, harness do baseline ou teste legado foi alterado nesta rodada. `EXPLAIN` local não mede linhas do D1: os novos totais precisam da próxima execução externa.

Naquela rodada, o timeout de `c-cadastro` ainda não tinha caso identificado no log. A revisão do caminho de importação grande em `src/customer/jobs.ts` não encontrou diferença contra a referência; a escrita extra do índice de junções havia sido removida. O teste permaneceu intacto, sem atribuir o timeout apenas ao Windows. A rodada 3 abaixo identifica e revisa o caso efetivamente informado depois.

Verificações locais desta segunda rodada de fechamento, em 19/11/2026:

| Comando | Resultado |
|---|---|
| `node node_modules/typescript/bin/tsc --noEmit` | Passou |
| TypeScript explícito de `cn-aceite`, `cn-api`, `cn-identidade` e `cn-juncao`, com declaração de bindings em `output/cn-fecha-typecheck.d.ts` | Passou; não executa os casos |
| `node --no-warnings --test output/cn-identity-update.test.mjs` | Quatro testes passaram. Extrai a função atual por AST TypeScript, aplica as migrações reais em SQLite local e confere cursor, execução ambígua, isolamento social/área, lote vazio/misto, manutenção sem evidência e chaves estrangeiras. O auxiliar está em `output/`, fora do patch versionado; não mede D1 |
| `node scripts/cn-baseline.mjs --self-test` | Passou; somente dados sintéticos do comparador |
| `node scripts/check-encoding.mjs`, `node scripts/check-conflict-markers.mjs` e `git diff --check` | Passaram; UTF-8 sem BOM e LF conferidos nos arquivos do diff |
| `node scripts/cn-ownership-check.mjs` | Passou: 150 arquivos da leva, dez donas, nenhuma sobreposição nem alteração protegida |

Vitest, Wrangler, build e medição D1 não foram executados localmente. A linha externa inteira permanece necessária após o patch.

## Fechamento, rodada 3 — ficha de aplicação e fixture de junção

A execução externa recebida passou em `check` e na comparação de custo. O artefato `output/cn-aceite/comparison.json`, de 19/11/2026 às 12:02:42, registra `passed: true`, `failures: []`, **20 cenários e 85 fases**, incluindo agregados. Nenhuma métrica aumentou; todas as fases mantiveram delta zero de linhas escritas. Exemplos extraídos de `baseline.json` e `current.json` dessa mesma execução:

| Fase | Instruções, referência → resultado | Linhas lidas | Linhas escritas |
|---|---|---|---|
| `first/coordinator` | 22 → 22 | 51 → 47 | 52 → 52 |
| `next/coordinator` | 10 → 10 | 6 → 6 | 17 → 17 |
| `ambiguous/coordinator` | 19 → 19 | 70 → 67 | 29 → 29 |
| `recovery_before/coordinator` | 21 → 21 | 60 → 56 | 50 → 50 |
| `application/coordinator` | 10 → 10 | 8 → 8 | 21 → 21 |

Proveniência: referência `20e15da9f249f49ff6ec28d273347063950a4c56`, snapshot `baseline-nXxGGp`, fixture v3, harness SHA-256 `21b76a414c7fed563fe5979cfe90bea24b2d6c8133ceae65b9fafc3620f10e00` e fontes do resultado SHA-256 `4f728df4d2d0f9051ad47902be4b1a8a35c18559ac75ff0b9d0bf3d77c1e86b6`. O HEAD era `bcce8df87e399a787dd00d1ce58028015090ce40` com alterações locais; o fingerprint, e não somente o commit, identifica o resultado medido. Esses artefatos precedem as correções da ficha desta rodada e não as validam.

A suíte externa terminou com **304 arquivos aprovados e três reprovados; 3.223 casos aprovados e quatro reprovados**, em 2.444,20 s. Os três E7, os doze casos `f1-profile`, `cn-api`, `cn-identidade` e o Facebook de `cn-aceite` não figuram entre as falhas dessa execução. A linha parou em `npm test`; build, pacote e donos não foram reexecutados por ela. O delta de pacote **+142.812 bytes** continua sendo evidência histórica informada, sem nova medição nesta rodada.

Correções mínimas após esse log:

- `src/customer/profile.ts`: a leitura exclusiva de `team` retornava 404 para contatos `app:<id>` que humanos autorizados já podiam abrir. A consulta mantém projeção explícita, admite os dois espaços de nomes e prende cada alias ao namespace inicial e à área. A ficha de aplicação retorna simples antes de canais, ERP e contribuições; a expressão social só é avaliada para `team`. Isso atende `c-ficha` sem alterar `f1-profile` nem conceder contribuições de equipe a aplicações.
- `tests/cn-juncao.test.ts`: a conversa social da fixture omitia `last_customer`, obrigatório desde a migração inicial. Preenche o horário sintético e corrige a expectativa nova de ficha de aplicação para o contrato simples já existente; continuam obrigatórias a preservação do canal no alias e a rejeição de alias `team → app`.
- `scripts/cn-ownership-check.mjs`: atualiza o motivo da correção da ficha; os três documentos `CANAIS-*` passam a registrar esta evidência e suas pendências.

O timeout identificado é `tests/c-cadastro.test.ts:172`, caso **P2/F4/E8: associação exclusivamente ERP é durável, autorizada no domínio e não concede agenda/notas** (limite 5.000 ms; arquivo levou 24.421 ms). O teste, `jobs.ts`, `erp-bridge.ts`, `sync.ts` e helper de módulos permanecem iguais à referência. O caso não passa pela ficha nem pela entrada/identidade social: cria um cadastro sem telefone e processa dois vínculos. A leitura nova de `merged_into` em `indexContact` consulta por chave primária o contato ainda não inserido; sem telefones ou candidatos, não gera escritas de identidade. Não foi encontrada regressão de custo que explique o timeout. Teste e prazo permanecem intactos; repetir isoladamente é necessário para distinguir carga da máquina de falha persistente. O log não comprova que seja apenas Windows.

Os logs de falhas injetadas `cn: queda antes do lote` e `cn: resposta perdida depois do lote` fazem parte da prova de recuperação, cujo comparador passou. Os erros de publicação e `returnValue` da outra frente não autorizam mudanças nos arquivos protegidos; não foram modificados. O aceite depende da próxima linha completa, sem ocultar esses logs.

Verificações locais desta terceira rodada de fechamento:

| Comando | Resultado |
|---|---|
| `node node_modules/typescript/bin/tsc --noEmit` | Passou |
| TypeScript explícito de `cn-aceite`, `cn-api`, `cn-identidade` e `cn-juncao`, com os mesmos tipos Cloudflare e declaração local da rodada anterior | Passou; não executa os testes |
| `node --no-warnings --test output/cn-profile-namespace.test.mjs` | Cinco casos passaram: ficha app simples em área social, restrições, alias social, isolamento entre namespaces/áreas e ciclos. Executa as funções atuais da ficha por AST/transpile e SQL em SQLite com todas as migrações; fronteiras de autorização, módulos e leitor social são controladas. Não substitui D1/Worker |
| `node --no-warnings --test output/cn-identity-update.test.mjs` | Quatro casos passaram; custo do cursor e isolamento do SQL local, sem medição D1 |
| `node scripts/cn-baseline.mjs --self-test`, `node scripts/cn-bundle-check.mjs --self-test` e `node scripts/cn-ownership-check.mjs --self-test` | Passaram; dados sintéticos, sem Vitest, Wrangler ou build |
| `node scripts/cn-ownership-check.mjs` | Passou: 150 arquivos da leva, dez donas, nenhuma sobreposição nem alteração protegida |
| `node scripts/check-encoding.mjs`, `node scripts/check-conflict-markers.mjs`, `git diff --check` e inspeção dos bytes do patch | Passaram: 4.357 arquivos de texto em UTF-8; arquivos do patch em LF, sem BOM |

Os auxiliares Node de `output/` estão ignorados pelo Git e não fazem parte da suíte versionada. A cobertura permanente continua nos testes Worker novos e antigos citados acima. Nenhum teste antigo, teto ou timeout foi alterado nesta rodada.

Uma sondagem com `git -c core.autocrlf=false diff --check` acusou CRLF preexistente em arquivos fora do patch. A opção foi removida, sem alteração de configuração ou arquivos: o check com a configuração normal passou, e os bytes dos arquivos do patch foram conferidos diretamente.

## Comandos e critérios

Executar externamente, na ordem contratual:

```text
npm run check && node scripts/cn-baseline.mjs && npm test && npm run build && node scripts/cn-bundle-check.mjs && node scripts/cn-ownership-check.mjs
```

| Etapa | Evidência exigida | Última execução externa recebida; repetir após as correções |
|---|---|---|
| `npm run check` | Geração/checks do projeto e TypeScript sem erro | Passou |
| `node scripts/cn-baseline.mjs` | Mesmas fixtures/harness em `20e15da9` e resultado; hashes e métricas por cenário/fase | Passou em 20 cenários/85 fases; delta zero de linhas escritas e nenhum aumento das demais métricas |
| `npm test` | Suíte completa, inclusive legados e três provas de aceite | 3.223 casos passaram; quatro falharam em `c-cadastro`, `c-ficha` e `cn-juncao`; execução local proibida |
| `npm run build` | Build web do conjunto | Não alcançado na última linha; passou na execução anterior |
| `node scripts/cn-bundle-check.mjs` | Build Worker local equivalente a dry-run/minify, sem publicação | Não alcançado na última linha; antes passou com delta +142.812 bytes; Wrangler local proibido |
| `node scripts/cn-ownership-check.mjs` | Propriedade única, alterações autorizadas, frente protegida e revisão de relações cadastrais | Não alcançado na última linha; passou na execução anterior |

O pacote deve somar os módulos descomprimidos: resultado até **41.943.040 bytes**, delta contra a referência até **524.288 bytes**. Build web não mede o Worker. Ausência de artefato, hash ou medição é pendência, nunca zero bytes ou aprovação.

Os três scripts possuem `--self-test`, executado durante a preparação com árvores/dados sintéticos. Esses autotestes passaram sem executar Git, Wrangler, rede ou build. O modo `node scripts/cn-ownership-check.mjs --source-check` inspeciona a matriz e referências locais sem Git; ele não substitui a comparação externa contra o commit-base.

Verificações locais históricas da rodada 3, sem Vitest (não validam as correções de fechamento):

| Comando | Resultado em 19/11/2026 |
|---|---|
| `node node_modules/typescript/bin/tsc --noEmit` | Passou; o `tsconfig.json` normal não inclui os testes |
| Checagem TypeScript específica dos três testes, reproduzível por `node scripts/cn-baseline.mjs --typecheck` | Passou com os tipos Cloudflare e declaração temporária de bindings; não executa os casos |
| `node scripts/cn-baseline.mjs --self-test` | Passou: relatório ausente/vazio, versão antiga, cenários incompatíveis e aumento de custo são recusados; falhas preservam causa e timeout |
| `node scripts/cn-bundle-check.mjs --self-test` | Passou: limites exatos, excesso de um byte e soma dos módulos sintéticos |
| `node scripts/cn-ownership-check.mjs --self-test` | Passou: duplicidade de dona, arquivos protegidos e novas referências cadastrais |
| `node scripts/cn-ownership-check.mjs --source-check` | Passou: 151 arquivos, 10 donas, 19 relações no adaptador e quatro exceções históricas; 12 arquivos B10 em UTF-8 sem BOM e com LF |

Não houve correção nova em arquivos de implementação naquela rodada 3. O fechamento atual corrige produto e provas no escopo autorizado pela integração; os resultados locais do fechamento devem ser registrados separadamente. Revisão de SQL, DTOs, autenticação, tratamento de falhas e chamadas externas não substitui a execução no runtime.

### Baseline reproduzível

`node scripts/cn-baseline.mjs` é destinado ao verificador externo. Resolve `20e15da9` por Git, extrai um snapshot dentro de `output/cn-aceite/` e copia exatamente os bytes do probe, da fixture comum, do setup D1 e da configuração Vitest atuais. Não faz checkout, commit, troca de branch ou instalação. A junção de dependências é usada somente para leitura; o wrapper do runner desloca caches para a pasta de artefatos e usa o loader `runner` para evitar `.vite-temp` na junção compartilhada.

O script executa o probe separadamente na referência e no resultado, guarda os logs completos e rejeita qualquer aumento de chamadas, instruções, escritas tentadas ou linhas com metadata disponível, em cada cenário e fase. Mudança na cobertura de metadata exige revisão; não vira redução presumida. A comparação também exige o mesmo conjunto de cenários e fases. O JSON de cada chamada contém todo o SQL do batch, sem parâmetros pessoais e sem truncamento.

- `baseline-reference.json`: hash completo de `20e15da9`, versão da fixture, SHA-256 do harness, configuração gerada, runner e lockfiles.
- `baseline.log`/`current.log` e `baseline.json`/`current.json`: saída original e métricas extraídas de cada execução; os relatórios são transportados pelos metadados do teste no `probe.vitest.json` do reporter, não pelo console do Worker.
- `comparison.json`: hashes das fontes, deltas por cenário/fase, motivos de reprovação e resultado da comparação.

O probe v3 usa linha humana sem menu/IA e uma resposta autenticada para exercitar envio real pela outbox, com Zernio e push simulados. Mede primeira entrada, seguinte, duplicada, segunda conexão, mídia e replay de mídia, identidade pronta, replay interno, resposta e replay, ambiguidade, falhas antes/depois do lote e recuperação. O cenário adicional `inherit_first` mede entrada pelo Coordinator e motor em linha herdada com menu automático; só esse cenário recebe o teto histórico de entrada de 20. O primeiro motor de ambos os modos recebe teto de 30. Todos os subtotais e agregados, inclusive o custo completo da linha humana, continuam sujeitos a ausência de aumento contra a referência. Confere também concorrência do webhook e executa o alarme real com inbox e entrega pendentes. Se um alarme antecipado consumir o trabalho antes da fase medida, a prova falha em vez de registrar uma fase vazia como economia.

LID/QR, grupo e aplicação usam o endpoint interno real `/inbound` do Coordinator; suas fases não são descritas como prova dos endpoints públicos de QR/aplicação. O alarme completo tem subtotal próprio, pois inclui manutenção e os estágios que, no percurso separado, foram medidos individualmente. Somar o alarme aos mesmos estágios duplicaria o custo. Os testes existentes de `cn-servidor` verificam a criação única do trabalho de bot em concorrência; esta preparação não simula uma resposta completa de IA.

Os IDs são sintéticos e os horários são relativos à execução das mesmas rotinas de fixture. `first()`/`raw()` e lotes cuja resposta se perdeu não fornecem metadata ao contador: o trace usa `null`; os totais de linhas cobrem apenas resultados observáveis. Escritas SQL tentadas não equivalem a linhas confirmadas. Os dois probes da última execução comprovaram ausência de aumento após as correções de custo; a linha completa deve ser repetida após o novo patch da ficha.

### Artefatos de pacote e propriedade

- `output/cn-aceite/bundle.json`: hashes e tamanhos por módulo, commits, fingerprint da árvore de trabalho, total, delta e resultado dos limites. O script usa o Wrangler instalado localmente com `deploy --dry-run --minify` nos dois snapshots; não executa release ou deploy remoto. Exclui `.map`/README da soma conforme o empacotamento do release.
- `output/cn-aceite/ownership.json`: comparação com `20e15da9`, incluindo arquivos não rastreados, matriz expandida e correções de integração declaradas em `INTEGRATION_FIXES`.

O verificador garante dona única por caminho, não atribui a autoria histórica de cada edição a uma tarefa. Arquivos com autorização de trecho, como `src/access.ts`, `src/service.ts`, `src/integrations.ts` e `web/lib/demo.ts`, ainda exigem inspeção humana do diff. O detector de referências contempla DDL com nomes diferentes de `contact_id` quando há chave estrangeira para `contacts(id)`; relações dinâmicas sem FK também precisam de revisão humana. Não declarar a frente protegida aprovada antes dessa conferência.

## Matriz de evidências

Os arquivos abaixo apontam onde inspecionar as provas. A existência do teste não afirma que passou nesta sessão.

| Critério | Prova e inspeção |
|---|---|
| A9.1, A9.5 — mesmo harness/fixtures, nenhum aumento por cenário WhatsApp | `tests/cn-baseline-probe.test.ts`, `tests/cn-orcamento.test.ts`, `scripts/cn-baseline.mjs`; comparação de instruções, chamadas, escritas e linhas quando disponíveis, por fase e agregado |
| A9.2–4 — Worker assinado → Coordinator → inbox → alarme/motor → outbox/push | Provas em `tests/cn-baseline-probe.test.ts` e `tests/cn-aceite.test.ts`; composição real, fronteiras remotas simuladas e rede inesperada fatal |
| A9.6–7 — limites históricos e identidade já pronta | `tests/d1-budget.test.ts`, `tests/f1-identity.test.ts`, `tests/cn-orcamento.test.ts`; primeira entrada até 20 instruções, motor até 30, replay do `inbound` uma instrução/uma chamada e identidade pronta sem instrução adicional |
| A9.8 — primeira/seguinte/repetida, segunda conexão, LID, grupo, mídia, ambiguidade, aplicação e falhas antes/depois do lote | Matriz do probe compartilhado e relatório do baseline; complementar com `tests/cn-servidor.test.ts` para atomicidade social. Conferir cada cenário no relatório; teto agregado não substitui ausência de regressão individual |
| A9.9 — repetição simultânea e falhas parciais | `tests/cn-aceite.test.ts`, `tests/cn-servidor.test.ts`, `tests/cn-identidade.test.ts`, `tests/cn-janelas.test.ts`; unicidade, recuperação e estado indeterminado |
| A9.10 — aparência e comportamento só WhatsApp | `tests/cn-web.test.ts`, `tests/cn-demo.test.ts`, `tests/cn-identidade-ui.test.ts`, `tests/cn-android.test.ts`, `tests/cn-ios.test.ts` e testes de transporte/janelas; SSR/funções puras não substituem inspeção em aparelhos |
| A4 — assinatura, roteamento, identidade automática e eventos | `tests/cn-aceite.test.ts`, `tests/cn-servidor.test.ts`, `tests/cn-transporte.test.ts`, `tests/cn-media.test.ts`; formatos remotos continuam pendentes |
| A5 — origem humana, janela, limites, módulos e IA | `tests/cn-janelas.test.ts`, `tests/cn-transporte.test.ts`, `tests/cn-servidor.test.ts` e prova integrada; nenhuma prova enviada pelo cliente concede extensão |
| A6 — junção/desfazer, isolamento do cliente e área | `tests/cn-aceite.test.ts`, `tests/cn-api.test.ts`, `tests/cn-juncao.test.ts`, `tests/cn-identidade.test.ts`; conferir allowlist contra qualquer relação nova da outra frente |
| A7 — todas as rotas novas, permissões, replay, transcrição e cotas | `tests/cn-aceite.test.ts`, `tests/cn-api.test.ts`, `tests/cn-email.test.ts`, `tests/cn-email-ui.test.ts`, `tests/cn-contas.test.ts`; mensagem pública, sem notas/anexos privados, cota reservada antes da rede |
| A2/B — migrações e propriedade | `tests/cn-migrations.test.ts`, `scripts/cn-ownership-check.mjs`; migrações de base somente aditivas, verificação de FK e dono único por arquivo |

## Fixtures e fronteiras

Os testes de canais usam IDs, pessoas, contas, horários e mensagens sintéticos. `tests/service-center-fixture.ts` fornece ambiente de área, atores, conexões e acesso ao Coordinator real; `tests/setup.ts` prepara o D1 do runtime Cloudflare. Os arquivos de aceite não devem substituir `index`, `service`, `engine`, identidade ou Coordinator por mocks. Apenas Zernio/Meta, IA, e-mail e push são respostas simuladas; injeção de falha na fronteira D1 deve continuar executando os componentes internos reais.

Os contadores devem discriminar cada instrução de um batch e a chamada única que o transporta. Escritas tentadas e linhas efetivamente reportadas pelo D1 são medidas diferentes; metadata indisponível deve ser marcada como indisponível. Worker, Coordinator, motor e push precisam de subtotais e soma sem dupla contagem. Configuração de fixtures, limpeza e consultas de assert não podem contaminar a fase medida.

Resultados históricos em comentários ou documentação não são baseline. A comparação precisa usar os mesmos insumos, incluindo dados que alterem paginação, identidade ou notificações. Rede inesperada deve falhar mesmo quando o componente capturar o erro para preservar a mensagem.

## Conciliações já declaradas

| Arquivo | Declaração recebida do orquestrador | Cobertura a conferir |
|---|---|---|
| `src/zernio.ts` | `cn-servidor` corrigiu concorrência compartilhando bytes lidos da resposta, sem compartilhar stream entre webhooks | Casos concorrentes de `tests/cn-servidor.test.ts` e prova integrada |
| `src/customer/channel-identity.ts` | `cn-servidor` preservou o limite de 1.024 caracteres do sujeito opaco | Caso de identificador longo/delimitadores de `tests/cn-servidor.test.ts` |
| `src/email.ts` | Avisos legados sem `module_id` com finalidade `billing`, `scheduling`, `order` e `booking` continuam na cota de módulos; transcrições ficam fora | `tests/cn-email.test.ts` e implementação `areaEmailCount` |

Correções adicionais de integração, se necessárias, devem ser mínimas, declarar arquivo/motivo/teste e constar na lista explícita do verificador de propriedade. Mudança de desenho, migração nova, dependência ou afrouxamento de teste não é correção de junção autorizada.

## Aplicativos

Android: o orquestrador informou compilação de `assembleDebug` e testes unitários aprovada nesta máquina antes do aceite. O comando reprodutível é `node scripts/cn-android-check.mjs`, que exige insumos instalados, usa modo offline e registra `mobile/android/.gradle/cn-check/result.log`. Não foi reexecutado pela preparação documental; não afirmar hash de APK ou validação visual sem artefato.

iOS: **pendente em Mac com Xcode e testes nativos**, incluindo `ChannelsTests` e `ChannelsDemoTests`. Testes TypeScript que inspecionam fontes e revisão de Swift no Windows não comprovam compilação, execução, layout ou acessibilidade iOS. Não houve publicação em lojas nem mudança de versão de loja.

## Pedidos à base e pendências

- Fechar a linha externa inteira antes de declarar o aceite. Falhas devem voltar com log; não ajustar limites para fazê-las desaparecer.
- Conferir hashes completos e preservar relatórios de baseline, resultado e pacote junto do log da verificação; nenhum número de custo/pacote foi inventado nesta preparação.
- Revisar novas referências a contatos da outra frente contra `MERGE_RELATIONS` e os marcadores de conversa. Uma referência desconhecida bloqueia o aceite até decisão explícita; não basta ignorar o arquivo por pertencer a outra frente.
- Conferir formatos, permissões e comportamento de contas reais conforme [CANAIS-ZERNIO.md](CANAIS-ZERNIO.md), inclusive retorno do e-mail. Pendência externa não é aprovação de integração com fornecedor.
- Compilar/testar iOS no Mac e fazer inspeção visual nos aplicativos e na web para os cenários só WhatsApp e multicanal. A demonstração sintética não comprova entrega real.

Ficaram fora: implantação, publicação, release, lojas, recursos Cloudflare novos, chamadas a serviços externos e ativação de canais futuros. O detalhamento funcional está em [CANAIS-PRIMEIRA-LEVA.md](CANAIS-PRIMEIRA-LEVA.md).
