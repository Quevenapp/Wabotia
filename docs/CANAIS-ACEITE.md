# Canais — registro de aceite

Data de preparação e correção da rodada 3: 19/11/2026. Referência contratual: `20e15da9`. **Aceite final pendente: a rodada 2 externa parou no baseline durante a injeção de falha; o harness v3 aguarda nova execução completa.** Esta máquina restringe rede, Vitest e Wrangler na sessão de edição; nenhum resultado abaixo deve transformar revisão de código ou resultado informado por outra tarefa em execução nova.

## Proveniência e estado inicial

O orquestrador informou que a cópia inicial contém a base e as oito tarefas de implementação integradas. Informou também `tsc --noEmit` verde, 348 casos na execução conjunta de `tests/cn-*.test.ts` e legados relacionados pelo servidor, além de Android `assembleDebug` e testes unitários compilados nesta máquina. Esses são resultados de entrada, não uma execução da suíte completa no aceite. O iOS não foi compilado no Windows.

`20e15da9` é a referência da comparação; a distribuição 0.22.0 identifica outro commit e não serve como baseline. O artefato externo `output/cn-aceite/baseline-reference.json` resolveu a referência para **`20e15da9f249f49ff6ec28d273347063950a4c56`**. Na rodada 1, o harness SHA-256 foi `227e955476ec684125c43727ada538d71677b520abf21b8b5e552f4c068d79b5` (fixture v1); na rodada 2, foi `1815d1b2f54c7d9fe0893b36f30f12d5e0cdb49778547b3e04b4e11f5f070ab4` (fixture v2, snapshot `baseline-7sTpLP`). Ambos identificam execuções que falharam. Hash do resultado, hashes do harness v3 e relatórios completos devem vir da nova execução dos scripts; não foram preenchidos por estimativa.

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

## Comandos e critérios

Executar externamente, na ordem contratual:

```text
npm run check && node scripts/cn-baseline.mjs && npm test && npm run build && node scripts/cn-bundle-check.mjs && node scripts/cn-ownership-check.mjs
```

| Etapa | Evidência exigida | Estado após a rodada 2 externa |
|---|---|---|
| `npm run check` | Geração/checks do projeto e TypeScript sem erro | Passou externamente nas rodadas 1 e 2; repetir após a correção |
| `node scripts/cn-baseline.mjs` | Mesmas fixtures/harness em `20e15da9` e resultado; hashes e métricas por cenário/fase | Falhou na fixture v2 ao reutilizar stub invalidado após falha injetada; v3 aguarda execução externa |
| `npm test` | Suíte completa, inclusive legados e três provas de aceite | Não alcançada; proibida nesta sessão |
| `npm run build` | Build web do conjunto | Não alcançada |
| `node scripts/cn-bundle-check.mjs` | Build Worker local equivalente a dry-run/minify, sem publicação | Não alcançada; Wrangler proibido nesta sessão |
| `node scripts/cn-ownership-check.mjs` | Propriedade única, alterações autorizadas, frente protegida e revisão de relações cadastrais | Não alcançada; Git somente no verificador externo |

O pacote deve somar os módulos descomprimidos: resultado até **41.943.040 bytes**, delta contra a referência até **524.288 bytes**. Build web não mede o Worker. Ausência de artefato, hash ou medição é pendência, nunca zero bytes ou aprovação.

Os três scripts possuem `--self-test`, executado durante a preparação com árvores/dados sintéticos. Esses autotestes passaram sem executar Git, Wrangler, rede ou build. O modo `node scripts/cn-ownership-check.mjs --source-check` inspeciona a matriz e referências locais sem Git; ele não substitui a comparação externa contra o commit-base.

Verificações locais repetidas na rodada 3, sem Vitest:

| Comando | Resultado em 19/11/2026 |
|---|---|
| `node node_modules/typescript/bin/tsc --noEmit` | Passou; o `tsconfig.json` normal não inclui os testes |
| Checagem TypeScript específica dos três testes, reproduzível por `node scripts/cn-baseline.mjs --typecheck` | Passou com os tipos Cloudflare e declaração temporária de bindings; não executa os casos |
| `node scripts/cn-baseline.mjs --self-test` | Passou: relatório ausente/vazio, versão antiga, cenários incompatíveis e aumento de custo são recusados; falhas preservam causa e timeout |
| `node scripts/cn-bundle-check.mjs --self-test` | Passou: limites exatos, excesso de um byte e soma dos módulos sintéticos |
| `node scripts/cn-ownership-check.mjs --self-test` | Passou: duplicidade de dona, arquivos protegidos e novas referências cadastrais |
| `node scripts/cn-ownership-check.mjs --source-check` | Passou: 151 arquivos, 10 donas, 19 relações no adaptador e quatro exceções históricas; 12 arquivos B10 em UTF-8 sem BOM e com LF |

Não houve correção nova em arquivos de implementação durante esta preparação. A revisão dos casos incluiu SQL, DTOs, autenticação, tratamento de falhas e chamadas externas esperadas; ela não substitui a execução no runtime.

### Baseline reproduzível

`node scripts/cn-baseline.mjs` é destinado ao verificador externo. Resolve `20e15da9` por Git, extrai um snapshot dentro de `output/cn-aceite/` e copia exatamente os bytes do probe, da fixture comum, do setup D1 e da configuração Vitest atuais. Não faz checkout, commit, troca de branch ou instalação. A junção de dependências é usada somente para leitura; o wrapper do runner desloca caches para a pasta de artefatos e usa o loader `runner` para evitar `.vite-temp` na junção compartilhada.

O script executa o probe separadamente na referência e no resultado, guarda os logs completos e rejeita qualquer aumento de chamadas, instruções, escritas tentadas ou linhas com metadata disponível, em cada cenário e fase. Mudança na cobertura de metadata exige revisão; não vira redução presumida. A comparação também exige o mesmo conjunto de cenários e fases. O JSON de cada chamada contém todo o SQL do batch, sem parâmetros pessoais e sem truncamento.

- `baseline-reference.json`: hash completo de `20e15da9`, versão da fixture, SHA-256 do harness, configuração gerada, runner e lockfiles.
- `baseline.log`/`current.log` e `baseline.json`/`current.json`: saída original e métricas extraídas de cada execução.
- `comparison.json`: hashes das fontes, deltas por cenário/fase, motivos de reprovação e resultado da comparação.

O probe v3 usa linha humana sem menu/IA e uma resposta autenticada para exercitar envio real pela outbox, com Zernio e push simulados. Mede primeira entrada, seguinte, duplicada, segunda conexão, mídia e replay de mídia, identidade pronta, replay interno, resposta e replay, ambiguidade, falhas antes/depois do lote e recuperação. O cenário adicional `inherit_first` mede entrada pelo Coordinator e motor em linha herdada com menu automático; só esse cenário recebe o teto histórico de entrada de 20. O primeiro motor de ambos os modos recebe teto de 30. Todos os subtotais e agregados, inclusive o custo completo da linha humana, continuam sujeitos a ausência de aumento contra a referência. Confere também concorrência do webhook e executa o alarme real com inbox e entrega pendentes. Se um alarme antecipado consumir o trabalho antes da fase medida, a prova falha em vez de registrar uma fase vazia como economia.

LID/QR, grupo e aplicação usam o endpoint interno real `/inbound` do Coordinator; suas fases não são descritas como prova dos endpoints públicos de QR/aplicação. O alarme completo tem subtotal próprio, pois inclui manutenção e os estágios que, no percurso separado, foram medidos individualmente. Somar o alarme aos mesmos estágios duplicaria o custo. Os testes existentes de `cn-servidor` verificam a criação única do trabalho de bot em concorrência; esta preparação não simula uma resposta completa de IA.

Os IDs são sintéticos e os horários são relativos à execução das mesmas rotinas de fixture. `first()`/`raw()` e lotes cuja resposta se perdeu não fornecem metadata ao contador: o trace usa `null`; os totais de linhas cobrem apenas resultados observáveis. Escritas SQL tentadas não equivalem a linhas confirmadas. Não há número medido de custo aprovado até os dois probes completarem.

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
