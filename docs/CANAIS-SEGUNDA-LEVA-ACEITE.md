# Aceite da segunda leva de canais

Este documento distingue provas automatizadas preparadas, execuções desta tarefa e resultados informados pelo orquestrador. A existência de um teste não comprova sua aprovação. Nenhum teste de conta real, publicação ou implantação foi realizado neste aceite.

## Referências e critério de comparação

| Conjunto | Referência local | Exigência |
|---|---|---|
| WhatsApp, aplicação e conversa interna | `20e15da9` | Delta zero de instruções, chamadas, escritas e linhas D1 disponíveis, por cenário equivalente. |
| DMs Instagram/Facebook | `13a9d9c3` | Delta zero das mesmas métricas. É a primeira leva fechada, substituindo `081951d6` no contrato original. |
| Pacote e propriedade da segunda leva | `13a9d9c3` | Delta de módulos até 524.288 bytes; total até 41.943.040 bytes; alterações cobertas pela matriz e exceções autorizadas. |

As referências devem existir no repositório local; a reprodução não busca rede nem troca a branch. A sonda usa as mesmas fixtures e tempo controlado em cópias locais, distinguindo a quantidade de chamadas da quantidade de instruções. Os resultados do Worker passam por `task.meta` e pelo reporter JSON do Vitest: `console` não é transporte de relatório neste ambiente.

Além da igualdade de custo, o caminho das mensagens antigas não pode consultar tabelas criadas pelas migrações `0144`–`0147`. A leitura adicional de conexões na ficha do contato é medida à parte, fora do caminho de mensagem; seu custo deve aparecer numericamente no fechamento, sem ser confundido com custo de entrada.

O pacote é a soma de módulos descomprimidos produzidos pelo dry-run minificado equivalente ao release. A contribuição funcional isolada de `postal-mime` é medida pelo mesmo empacotador. Tamanho de fonte, tarball, diagnóstico de esbuild ou estimativa não substituem o dry-run. O verificador deve falhar fechado se não puder produzir a medição real e deve conferir `index.js`.

## Estado das execuções desta tarefa

As regras desta máquina proíbem rede, Vitest e Wrangler durante a edição. O orquestrador executa a verificação externa e devolve o log se houver falha. A primeira rodada externa falhou em seis casos dos testes novos; a segunda aprovou os 668 casos e reprovou a comparação D1. As correções e o conflito entre a exigência de igualdade e as reduções já presentes na primeira leva estão registrados abaixo. A repetição externa após os ajustes da sonda permanece pendente. Não há aprovação presumida de D1, pacote ou conta real.

| Prova | Resultado desta tarefa |
|---|---|
| TypeScript (`node node_modules/typescript/bin/tsc --noEmit`) | Executado nesta tarefa, retorno 0. |
| TypeScript dos três testes novos (`node scripts/c2-baseline.mjs --typecheck`) | Executado, retorno 0; o `tsconfig.json` normal não inclui testes. |
| Autotestes dos três scripts (`--self-test`) | Executados, retorno 0; não executam Vitest nem Wrangler e não medem o Worker. |
| Referências locais (`node scripts/c2-baseline.mjs --snapshot-only`) | Executado, retorno 0; snapshots e hashes gerados dentro de `output/c2-aceite/`, sem trocar branch nem buscar rede. |
| Marcadores de conflito, codificação e `git diff --check` | Executados, retorno 0. Arquivos de aceite em UTF-8 sem BOM e LF. |
| Prova integrada e regressões `tests/c2-*`, `tests/cn-*`, entrada, ficha, identidade, e-mail e rotas | Segunda verificação externa: 48 arquivos e 668 testes aprovados, em 355,87 s. As correções da rodada 2 passaram. Vitest não executado pelo agente; a alteração posterior da sonda ainda precisa de repetição externa. |
| Custo D1 por cenário, ambas as referências | Segunda verificação externa: reprovado nos dois grupos. Relatórios e SQL preservados em `output/c2-aceite/`; números e diagnóstico abaixo. Nenhum delta foi descartado pelo comparador. |
| Leitura adicional da ficha fora do caminho de mensagem | Na execução externa recebida: +1 chamada, +1 instrução e zero escritas por ficha; +5 linhas lidas em Instagram, +4 em Facebook. Sem acréscimo de linhas gravadas. A sonda estabilizada precisa confirmar os novos valores. |
| Bytes do Worker em `13a9d9c3` | Não medidos nesta tarefa. |
| Contribuição isolada de `postal-mime` 4.2.1 | Não medida com Wrangler nesta tarefa. |
| Bytes finais e delta da segunda leva | Não medidos nesta tarefa; teto adicional 524.288 e absoluto 41.943.040 bytes mantidos. |
| Build do painel | Aguardando verificação externa. |
| Matriz de propriedade e infraestrutura | `node scripts/c2-ownership-check.mjs`: retorno 0, 150 arquivos alterados contra a referência, 12 donas (incluindo exceções do orquestrador), sem sobreposição; infraestrutura idêntica. |
| Suíte completa sobre o resultado final | Aguardando o orquestrador no Mac. |
| Nova compilação Android/iOS neste aceite | Não executada; evidências anteriores abaixo. |

Comando da verificação externa, a ser executado pelo orquestrador, não pelo agente nesta máquina:

```sh
npm run check && npm test -- tests/c2- tests/cn- tests/f1-inbound.test.ts tests/f1-profile.test.ts tests/c-identidade.test.ts tests/email.test.ts tests/worker-routes.test.ts && node scripts/c2-baseline.mjs && npm run build && node scripts/c2-bundle-check.mjs && node scripts/c2-ownership-check.mjs
```

A suíte inteira será repetida no Mac. No Dell, o caso antigo `tests/c-cadastro.test.ts`, “P2/F4/E8”, também excede cinco segundos no commit anterior aos canais; a verificação externa desta tarefa usa o conjunto indicado, sem apagar ou enfraquecer esse teste.

Os manifestos locais resolvem `20e15da9` para `20e15da9f249f49ff6ec28d273347063950a4c56` e `13a9d9c3` para `13a9d9c3bb7800c78399536cf1039f18904dcb99`. `reference-20e15da9.json` e `reference-13a9d9c3.json`, em `output/c2-aceite/`, identificam snapshots, hashes das fontes e das fixtures. Esses artefatos são reproduzíveis pelo script e não entram no patch. Sua criação não é uma medição de custo.

O comparador exige 23 cenários legados e 16 para cada rede social, com duas leituras de ficha separadas. Recusa relatórios ausentes/duplicados, diferenças de cobertura de metadados e qualquer delta de custo nas fases de mensagem. A saída recebida está em `comparison.json`, com os relatórios brutos `baseline-legacy.json`, `baseline-social.json` e `current.json`; o pacote será `bundle.json`, incluindo módulos, hashes e contribuição isolada do parser. A auditoria já executada está em `ownership.json`. Nenhum valor de D1 ou byte de pacote foi preenchido por estimativa.

Na primeira verificação externa, `npm run check` passou; o verificador de codificação leu 4.422 arquivos de texto em UTF-8. Os seis erros ocorreram somente em `c2-aceite` (quatro) e `c2-baseline-probe` (dois). Como a sequência usa `&&`, a falha interrompeu a execução antes de baseline, build e pacote. Os avisos de `cn: queda antes do lote` e `cn: resposta perdida depois do lote` vêm da injeção deliberada de falhas nas sondas; também aparecem na sonda legada aprovada. Não são, por si, aprovação ou reprovação: a prova confere o resultado persistido e a recuperação.

Na segunda verificação externa, `check` voltou a passar (4.422 arquivos em UTF-8) e todos os 668 testes passaram. As sondas também terminaram seus casos; foi o comparador entre seus resultados que reprovou D1. A sequência parou antes de build, pacote e auditoria externa de propriedade. Os avisos de cabeçalho não ASCII, NDJSON e sourcemap não foram a causa da reprovação. Não se removeu a injeção de falhas nem seus testes para silenciar o log.

## Evidências fornecidas pelo orquestrador

Estes resultados foram informados na tarefa; não foram produzidos novamente pelo aceite:

| Evidência | Resultado informado e limite |
|---|---|
| Primeira leva | Delta zero de linhas lidas/gravadas por mensagem WhatsApp contra `20e15da9`, suíte inteira verde no Mac e pacote aproximadamente +144 KB. Referência fechada: `13a9d9c3`. Não substitui a medição exata da segunda leva. |
| Segunda leva, commit `52746e3e`, Mac | `check` aprovado em 27 s. Vitest em 913 s: 325 arquivos aprovados e um falhou; 3.502 testes aprovados e um falhou. |
| Única falha desse Mac | `tests/worker-routes.test.ts`: uma constante `path` iniciada por `/` confundia a guarda estática. O orquestrador renomeou a variável para `extensionPath` em `src/index.ts` no commit base deste aceite; a guarda não foi alterada. A suíte inteira após essa correção não foi apresentada como aprovada. |
| Android | APK de depuração compilado neste Dell pela tarefa `c2-android`; 198 testes Kotlin passaram e seis foram ignorados. Não repetido neste aceite. |
| iOS | Compilado no Mac com Xcode 27.2 e testado no simulador: 259 testes, zero falhas e sete pulados. Não é prova em aparelho. |

Para o iOS, o orquestrador corrigiu inferência de um literal aninhado, acesso sobreposto a `rows` e validação de assunto de e-mail: `contains("\r")` não barrava `\r\n`, pois o par é um único caractere em Swift. Essas correções já pertencem ao commit base recebido. A antiga pendência genérica de “compilar iOS no Mac” foi resolvida para esse estado; continuam pendentes prova em aparelho, inspeção visual/acessibilidade e nova compilação se fontes nativas forem alteradas depois.

## Cobertura e interpretação das provas

O fechamento usa Worker, Coordinator, kernel, identidade, D1 e motor reais. Só fronteiras externas são simuladas. `tests/c2-entry.test.ts` exercita a composição de produção sem o helper que isola a instalação dos descritores. `tests/c2-fixtures.ts` fornece atalhos internos de ensaio; `c2Ingress` e `coordinatorTicket`, sozinhos, não provam autenticidade externa.

| Exigência | Provas a executar no conjunto de aceite |
|---|---|
| Canal não usado, catálogo/DOM antigo, caminho D1 sem extensões | `c2-entry`, `c2-web`, `c2-demo`, testes nativos, `c2-orcamento`, sondas e comparação de baseline. |
| HMAC/segredo incorreto sem efeito, mesma entrada simultânea sem duplicação | `c2-entry`, `c2-base` e testes de cada canal; entrada por webhook real ou runtime de e-mail. |
| Entrada → identidade/inbox → alarme → outbox → conclusão | `c2-aceite`, `c2-integra`, `c2-entry` e testes de outbox; rede inesperada deve falhar. |
| Revogação antes do replay/publicação, escopo da área e segredos | Testes de núcleo/extensões, integração e aceite. Tokens não devem aparecer em respostas, erros, recibos, auditoria, exportação ou logs. |
| Comentário sem bot e sem segunda privada | `c2-comentarios`, `c2-comentarios-outbox`, integração e aceite. |
| Google sem contato/conversa; versão, permissão, sync parcial | `c2-google`, `c2-google-sync`, integração e aceite. |
| E-mail hostil, automáticos, MIME/anexos, identidade não confirmada e quotas | `c2-email`, `c2-email-mime`, `c2-email-outbox`, entrada e aceite. Cabeçalho falso não é prova de pessoa; não se afirma que todo remetente falso será recusado. |
| TikTok: dez vagas, concorrência, eco, saída externa e duas entregas | `c2-tiktok`, `c2-tiktok-quota`, integração e aceite. |
| Migrações aditivas, banco anterior, unicidade/rollback/FK e infraestrutura | `c2-migrations`, testes de base, pacote e conferência de propriedade. |

Matriz é indicação de onde executar e ler os resultados, não alegação de aprovação ou de que todo caso passou. Demonstração visual não substitui teste de webhook, runtime ou fornecedor. Os contadores existentes de orçamento continuam valendo, além da exigência de delta zero.

## Matriz de propriedade e exceções

A conferência parte de `13a9d9c3`, incluindo arquivos novos e alterações presentes na cópia. As listas exatas por arquivo são materializadas em `scripts/c2-ownership-check.mjs`; diretórios abaixo são apenas resumo, não autorização ampla de edição.

| Dona | Arquivos de sua fase |
|---|---|
| `c2-base` / `c2-base2` | Contratos/registro/kernel/stubs, pontos centrais enumerados em B1, slots web, `postal-mime` em package/lock, migrações `0144`–`0147`, fixtures/testes base e medição da dependência. |
| `c2-comentarios` | `src/c2/comments*.ts` e dois testes de comentários de B2. |
| `c2-telegram` | Três módulos Telegram e dois testes de B3. |
| `c2-google` | Dois módulos Google e dois testes de B4. |
| `c2-email` | Quatro módulos de e-mail e três testes de B5. |
| `c2-tiktok` | Dois módulos TikTok e dois testes de B6. |
| `c2-web` | Somente componentes, registro, estilo e demo enumerados em `web/c2/`, mais dois testes de B7. |
| `c2-android` | Somente modelos, rede, componentes, telas e demo enumerados em B8; testes e wrapper próprios. |
| `c2-ios` | Somente modelos, API, componentes, telas e demo enumerados em B9; testes próprios. |
| `c2-integra` / `c2-integra2` | Composição `src/c2-entry/`, instalação web e provas de integração; ajustes centrais autorizados pelo orquestrador. O `main` permanece `src/index.ts`. |
| `c2-aceite` | Três testes, três scripts, quatro documentos novos e atualizações de `docs/EMAIL.md` e `mobile/{README.md,DESIGN.md}` de B11. Correção de defeito de produto encontrada no aceite pode ser feita no menor trecho, conforme autorização adicional. |

Exceções explícitas do orquestrador a registrar sem tratá-las como sobreposição indevida:

- Arquivos centrais alterados pela base e integração.
- Duas expectativas atualizadas em `tests/cn-contas.test.ts` e `tests/cn-servidor.test.ts`.
- Correções iOS em `mobile/ios/Wabotia/Core/ChannelModels.swift`, `Core/Demo/ChannelsSecondWave.swift` e `Core/Demo/DemoServer.swift`.
- Ajustes de `src/channel-extension-registry.ts`, `tests/c2-fixtures.ts` e `tests/c2-base.test.ts`.
- Composição de produção em `src/c2-entry/install.ts`, importada pelo `main` histórico `src/index.ts`.
- Hooks centrais já recebidos em `src/contacts.ts` e `src/customer/http.ts`: exclusão e replay retomam a limpeza de e-mail por `eraseContactChannels`. São exceções observadas na integração recebida, identificadas na matriz; a auditoria por caminho não substitui revisão de seus trechos.
- Correção mínima de aceite em `scripts/c2-dependency-size.mjs`: leitura de vírgula final válida no JSONC real, isolamento do ambiente do dry-run e provas no self-test; o arquivo continua pertencendo à base na matriz e a exceção é identificada como correção do aceite.

Permanecem protegidas as pastas ERP, produtores de módulos, `src/access.ts`, `src/modules/registry.ts`, `web/lib/demo.ts`, a seção ERP da ficha e os demais arquivos fora das listas. Não há autorização para novo recurso Cloudflare, nova classe de DO, nova dependência ou migração além de `0144`–`0147`. A auditoria de infraestrutura compara nome, bindings, cron, assets, classes e configuração com a referência.

## Defeitos corrigidos no aceite

### Rodada 3: medição com fixtures diferentes e custo herdado

`scripts/c2-baseline.mjs` executava o grupo legado sozinho em `20e15da9`, mas juntava legado e social na execução atual. Os casos do arquivo `c2-baseline-probe.test.ts` conservam dados entre si: os dois casos sociais acrescentavam seis usuários antes da conversa interna somente no resultado atual. O SQL idêntico de participantes/presença lia seis linhas na referência e dezoito no resultado. Duas consultas em `internal_create` explicam +24 linhas; uma em `internal_replay`, +12. Isso era defeito da comparação, não custo acrescentado ao produto.

Agora cada grupo roda em processo separado também no resultado, com seleção idêntica à referência. `current-legacy.json/log` e `current-social.json/log` conservam as provas individuais; `current.json` continua sendo a composição dos dois grupos. Uma guarda e seu autoteste recusam executar os grupos misturados. As contagens continuam integrais, sem desconto de leituras.

O relógio já era controlado, mas os UUIDs eram aleatórios. As quatro diferenças de uma linha no Facebook ocorreram no mesmo `SELECT` de `channel_events`, com SQL e esquema iguais entre `13a9d9c3` e o resultado. A ordem variável das chaves é uma hipótese consistente com essas diferenças. O setup gerado agora controla também `crypto.randomUUID`, por nome de teste e sequência crescente. O contador aparece no prefixo para manter distintos os IDs de conta truncados a 24 hexadecimais. O autoteste verifica formato UUID, reprodutibilidade, ordem e 1.024 prefixos sem colisão. A confirmação de que isso elimina as diferenças é externa; não se simulam D1, Coordinator, identidade ou motor.

Existe ainda um conflito verificável com o critério recebido: as reduções de identidade WhatsApp já estavam em `13a9d9c3`. A otimização de `conversationIdentityStatements`, introduzida no fechamento da primeira leva, usa `id=?` para alvo único mantendo a guarda de canal. [CANAIS-ACEITE.md](CANAIS-ACEITE.md#fechamento-rodada-3--ficha-de-aplicação-e-fixture-de-junção) já registra `first/coordinator` 51 → 47 e `recovery_before/coordinator` 60 → 56. A guarda de módulos também já excluía aplicações, evitando duas consultas em `application/engine`. Reintroduzir essas leituras para fabricar igualdade aumentaria custo ou contrariaria o isolamento de módulos.

O comparador antigo da primeira leva rejeita aumentos, não reduções. Portanto a informação resumida de “delta zero” da primeira leva não corresponde à igualdade estrita de todas as métricas nos artefatos históricos. O novo comparador continua estrito, como solicitado. Sem uma decisão explícita sobre esse critério, o gate legado contra `20e15da9` continuará reprovando as reduções históricas; não se declara o aceite resolvido apenas pela correção das fixtures.

Para tornar a decisão reproduzível, o script agora também executa o grupo legado em `13a9d9c3`: `baseline-first-wave-legacy.json/log`. `comparison.json.historicalLegacy` separa `originalToFirstWave` (20 → 13) e `firstWaveToCurrent` (13 → resultado), com referências e hashes. É diagnóstico adicional, sem substituir nem relaxar o gate original. Não se altera código de produção ou teste legado nesta rodada.

Verificações locais desta rodada: `node node_modules/typescript/bin/tsc --noEmit`, `node scripts/c2-baseline.mjs --typecheck`, os três scripts `c2-*` de aceite com `--self-test`, `node scripts/c2-ownership-check.mjs`, guardas de conflitos/codificação e `git diff --check` retornaram zero. A auditoria contou 150 arquivos e 12 donas, sem sobreposição e com infraestrutura idêntica; a guarda de codificação conferiu 4.422 arquivos. Os avisos do Git sobre conversão futura para CRLF não descrevem os bytes atuais: a auditoria confere UTF-8 sem BOM e LF nos arquivos B11. Não se executaram Vitest, Wrangler, nova medição D1, build nativo ou rede.

### Números da segunda verificação externa, antes da correção da sonda

Os valores abaixo são os agregados de cada cenário nos relatórios recebidos, não uma nova medição após os patches. Valores únicos são iguais nos dois lados; setas mostram referência → resultado. `writes` é o classificador herdado de instruções de escrita; `rowsWritten` são as linhas efetivamente informadas pelo runtime. O classificador também reconhece a função SQL `replace(...)` como se fosse um comando: a redução 17 → 16 de `application` não representa uma gravação removida. Suas linhas gravadas permanecem 43 → 43. `first()`/`raw()` sem metadados não são tratados como prova de zero linhas.

| Legado contra `20e15da9` | Chamadas | Instruções | `writes` | Linhas lidas | Linhas gravadas |
|---|---:|---:|---:|---:|---:|
| first | 46 | 60 | 29 | 76 → 72 | 67 |
| next | 41 | 45 | 14 | 28 | 29 |
| duplicate | 15 | 15 | 1 | 12 | 2 |
| second_connection | 46 | 57 | 26 | 95 → 91 | 48 |
| media | 51 | 64 | 29 | 84 → 81 | 67 |
| media_duplicate | 15 | 15 | 1 | 12 | 2 |
| reply | 28 | 37 | 12 | 18 | 32 |
| reply_duplicate | 2 | 8 | 1 | 6 | 0 |
| alarm | 59 | 61 | 22 | 48 | 27 |
| lid | 24 | 30 | 12 | 19 | 31 |
| group | 23 | 30 | 13 | 19 | 44 |
| application | 30 → 28 | 36 → 34 | 17 → 16 | 18 | 43 |
| ambiguous | 71 | 82 | 47 | 122 → 118 | 58 |
| failure_before | 14 | 26 | 16 | 0 | 3 |
| recovery_before | 46 | 59 | 27 | 88 → 84 | 64 |
| failure_after | 14 | 26 | 16 | 0 | 3 |
| recovery_after | 37 | 38 | 13 | 28 | 14 |
| inherit_first | 29 | 43 | 23 | 59 → 57 | 63 |
| identity_ready | 0 | 0 | 0 | 0 | 0 |
| inbound_replay | 1 | 1 | 0 | 0 | 0 |
| internal_create | 6 | 6 | 1 | 16 → 40 | 4 |
| internal_send | 6 | 8 | 3 | 12 → 25 | 10 |
| internal_replay | 4 | 4 | 0 | 8 → 20 | 0 |

| Instagram contra `13a9d9c3` | Chamadas | Instruções | `writes` | Linhas lidas | Linhas gravadas |
|---|---:|---:|---:|---:|---:|
| first | 43 | 58 | 26 | 49 | 76 |
| next | 41 | 51 | 18 | 41 | 35 |
| replay | 16 | 16 | 0 | 14 | 0 |
| media | 46 | 61 | 27 | 50 | 78 |
| media_replay | 16 | 16 | 0 | 14 | 0 |
| reply | 42 | 51 | 12 | 19 | 32 |
| reply_replay | 2 | 8 | 1 | 6 | 0 |
| echo | 23 | 23 | 4 | 17 | 6 |
| event | 22 | 24 | 6 | 22 | 12 |
| failure_before | 13 | 27 | 15 | 0 | 0 |
| recovery_before | 43 | 58 | 26 | 51 | 76 |
| failure_after | 14 | 28 | 15 | 3 | 0 |
| recovery_after | 36 | 37 | 11 | 29 | 12 |
| alarm | 66 | 68 | 21 | 47 | 27 |
| delivery_failure | 37 | 44 | 7 | 16 | 17 |
| forged | 2 | 2 | 0 | 0 | 0 |

| Facebook contra `13a9d9c3` | Chamadas | Instruções | `writes` | Linhas lidas | Linhas gravadas |
|---|---:|---:|---:|---:|---:|
| first | 43 | 58 | 26 | 65 | 76 |
| next | 41 | 51 | 18 | 56 | 35 |
| replay | 16 | 16 | 0 | 28 | 0 |
| media | 46 | 61 | 27 | 65 | 78 |
| media_replay | 16 | 16 | 0 | 28 | 0 |
| reply | 41 | 50 | 11 | 23 | 30 |
| reply_replay | 2 | 8 | 1 | 6 | 0 |
| echo | 23 | 23 | 4 | 33 → 32 | 6 |
| event | 22 | 24 | 6 | 37 | 12 |
| failure_before | 13 | 27 | 15 | 0 | 0 |
| recovery_before | 43 | 58 | 26 | 67 → 66 | 76 |
| failure_after | 14 | 28 | 15 | 4 → 3 | 0 |
| recovery_after | 36 | 37 | 11 | 45 → 44 | 12 |
| alarm | 66 | 68 | 21 | 66 | 27 |
| delivery_failure | 37 | 44 | 7 | 19 | 17 |
| forged | 2 | 2 | 0 | 0 | 0 |

Não houve aumento de linhas gravadas nem acesso às onze tabelas novas em qualquer cenário antigo observado. As leituras de ficha, excluídas desses agregados de mensagem, acrescentaram uma chamada/instrução por ficha, cinco linhas no Instagram e quatro no Facebook, sem escrita. O SQL por fase permanece nos relatórios brutos. A sonda nova terá outros hashes e não pode reutilizar esses artefatos como resultado aprovado.

### Rodada 2: fixtures e expectativa de recuperação

| Arquivo e casos afetados | Causa | Correção e prova |
|---|---|---|
| `tests/c2-aceite.test.ts`: privada Instagram/Facebook, avaliação Google e quota TikTok | A fixture usava UUIDs em `account_id` e `zernio_profile_id`. O resolvedor real exige IDs hexadecimais de 24 caracteres, então o webhook devolvia HTTP 200 com `ignored:true` e `scope_mismatch`. Conferir apenas `response.ok` deixava a falha aparecer depois como recurso nulo. | A fixture agora usa o formato aceito, como os helpers da base. Os casos conferem o corpo da entrada aceita, persistência única e recusas sem efeitos, antes de executar as ações e os alarmes reais. Nenhuma validação produtiva foi relaxada. |
| `tests/c2-baseline-probe.test.ts`: falha social depois do lote, Instagram/Facebook | A sonda exigia HTTP 5xx tanto antes como depois do lote. Quando o lote já foi confirmado, `inboundSocial` consulta a inbox e reconhece o replay, retornando HTTP 202 com `duplicate:true`. Esse comportamento já existe em `13a9d9c3`. | A prova distingue falha antes do lote (5xx, sem persistência) da resposta perdida depois do lote (202, replay confirmado). Confere a injeção da falha, o estado persistido e a recuperação com uma única mensagem/identidade. As métricas e a exigência de delta zero permanecem. |

Esses seis erros tinham causa nos testes novos, sem necessidade de mudar o produto ou testes anteriores. A segunda verificação externa aprovou os casos corrigidos: 48 arquivos e 668 testes passaram. A compilação TypeScript e os autotestes offline, isoladamente, não substituem essa execução no Worker.

Nesta rodada, passaram o TypeScript do projeto e a checagem dedicada dos três testes novos após os patches, os três autotestes de scripts, a regeneração dos snapshots locais, a conferência de propriedade/infraestrutura, a guarda de codificação (4.422 arquivos), a guarda de conflitos e `git diff --check`. Os snapshots atuais incluem a sonda corrigida. Nenhum Vitest, Wrangler, build nativo ou acesso à rede foi executado pelo agente.

### Rodada 1: medidor do pacote

`scripts/c2-dependency-size.mjs` chamava `parseJsonc` com coleta de erros, mas sem `allowTrailingComma`. O `wrangler.jsonc` real usa vírgulas finais válidas em JSONC; a leitura acusava nove erros e abortava antes do dry-run. A correção permite essas vírgulas no parser e acrescenta ao self-test a leitura do arquivo real. Não altera a infraestrutura nem reduz os tetos. `scripts/c2-bundle-check.mjs` usa a referência explícita `13a9d9c3` e mantém falha fechada com o motivo original. Wrangler não foi executado nesta tarefa; a medição real continua pendente.

O mesmo medidor herdava `CLOUDFLARE_ENV` e credenciais do processo, diferentemente do transporte da primeira leva. O aceite remove esses valores do ambiente dos subprocessos para impedir seleção involuntária de outro ambiente e dispensa credenciais no dry-run. O self-test verifica essa remoção com valores sintéticos, preservando `PATH`. Ambos os autotestes passaram; não houve mudança nos adaptadores de produto, migrações ou configuração da instalação.

## Pendências de produto e entrega

O transporte de produção do canal de e-mail ainda está sem confirmação do contrato REST. `provider_contract_unverified` é um bloqueio deliberado: não cabe habilitar uma hipótese por campo da UI. Isso impede concluir envio real do canal e a entrega do desafio de recebimento. O handler e o processamento podem ser exercitados com fixtures, sem que isso habilite uma nova conexão de produção. Transcrição de conversa e envio do Sistema conservam contratos próprios.

O parser MIME tem limite local de 8 MiB, embora o recebimento bruto aceite até 25 MiB; acima de 8 MiB o processamento fica em quarentena sem abrir atendimento. O envio mede MIME e requisição REST codificados, com tetos próprios. Esses limites estão expostos no [guia de recebimento](CANAIS-EMAIL-RECEBIMENTO.md).

Continuam fora desta prova: formatos reais dos fornecedores; elegibilidade TikTok e reinício remoto de sua quota; regra e nomes atuais do Email Routing; convivência de MX de subdomínio com provedor externo; reentrega da Cloudflare após falha; envio/recebimento real; push real; prova em aparelho e acessibilidade. Não houve publicação, implantação ou alteração de recursos da instalação. Consulte [CANAIS-FORMATOS-PENDENTES.md](CANAIS-FORMATOS-PENDENTES.md).

## Pedidos à base

É necessária decisão do orquestrador sobre a contradição do baseline: registrar as reduções históricas `20e15da9 → 13a9d9c3` e exigir delta zero da segunda leva contra `13a9d9c3`, ou conservar a reprovação estrita contra `20e15da9`. A confirmação foi solicitada porque a regra explícita exige igualdade, enquanto o código e a documentação da primeira leva comprovam reduções já aprovadas. Até essa decisão, o script conserva o gate original; não há dispensa implícita de métrica.

As pendências de contrato remoto acima precisam de evidência autorizada da conta real antes de habilitar capacidades condicionadas. Os números atualizados da sonda corrigida, a medição real do pacote e a suíte completa no Mac devem ser incorporados antes de declarar o aceite concluído. Não há aprovação presumida enquanto esses resultados estiverem pendentes.
