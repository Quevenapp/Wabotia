# Agendador do ERP

O que roda por tempo na instância `erp:<área>` (classe `Coordinator`, sem
classe nova de Durable Object). Plano aprovado em 16/11/2026, com os ajustes
da orquestração. O código fica em `src/erp/scheduler/`.

## Por que existe

No Fagoo o único agendamento é um Cron Trigger `*/2` do Worker `erp-api`, e
ele só roda o Origin. As tarefas da plataforma (`erp_platform_schedule`, com as
notificações de hora em hora e a limpeza diária das exportações) **nunca
disparavam**. No Wabotia elas passam a rodar no alarme do próprio objeto.

Desde a fatia [Receber dados do Bling](RECEBER-BLING.md), o mesmo alarme
também pode executar coleta interna para acervo. O envio e os aplicadores
operacionais legados continuam desligados. Adoção e escrita futura de volta
não são tarefas deste executor.

## Peças

| Peça | Onde | O que faz |
|---|---|---|
| Rotinas | `scheduler/routines.ts` | Lista em código: `platform.schedule` (hora cheia), `retention` (03:10 de São Paulo). Cada rotina tem bloco, próximo horário e passo (uma unidade). |
| `wb_routine` | Criada pelo `schema/migrate.ts` (`WB_ROUTINE_DDL`, `CREATE TABLE IF NOT EXISTS`, como a `erp_meta`: vale também para instância que já existe); declarada em `schema/structural.ts` ("agendador") | Estado de cada rotina: `next_run_us`, `last_run_us`, `last_status` (`ok`, `partial`, `error`, `skipped`), `last_error`, `last_ms`, `runs`, `failures`. Fica fora do DDL gerado e do backup. Na restauração, as rotinas vencem e rodam uma vez, sem duplicar tarefas (teste "backup e restauração" em `tests/erp-do-scheduler.test.ts`). |
| Despachante | `scheduler/dispatch.ts`, `runRound(db, opções)` | Roda as rotinas vencidas e depois drena a fila `erp_platform__task` com as funções da plataforma (domínio Preferências). Devolve a próxima acordada. |
| Alarme | `src/erp/hub.ts`, `alarm()` | Valida o KV `erp_parts` antes de importar/migrar o motor; fornece partes explícitas a cada unidade e revalida após cada `await`. |
| Estado/wake | `src/erp/hub.ts`, `/erp-parts` e `/erp-wake` | Persistência de fotografia completa revisionada e reconciliação do alarme; wake só antecipa uma autorização válida. |
| Cron | `scheduler/cron.ts`, `wakeErpAreas(env, scheduledTime)` | Renova a autorização em toda passagem de cinco minutos e entrega desligamentos pendentes. |

## Coleta do Bling subordinada ao trabalho operacional

`runBlingWake` é um executor assíncrono separado de `TASK_HANDLERS` e do
`TaskHandler` síncrono. A ordem operacional e de arquivos existente continua
primeiro. Se a rodada executou trabalho operacional, deixou `report.more`
ou há arquivo vencido, a coleta fica para outra acordada.

Uma acordada elegível permite uma unidade e no máximo um GET de dados,
até 4 s incluindo armazenamento, com HTTP de até 3 s. O deadline termina
250 ms antes do próximo vencimento operacional; menos de 1 s disponível
adia a coleta. XML separa gravação, verificação e manifesto em etapas
duráveis, e apagamento usa lotes SQL/R2 retomáveis. O alarme final é o
mínimo entre operação, arquivos e coleta; a coleta nunca posterga uma
tarefa operacional.

A fila de integração da fase 3 roda no alarme do `Coordinator` da área,
por `runModuleSchedules`/`drainIntegrationOutbox`; não pertence à instância
`erp:<área>`. A NF-e comercial retoma pelo comando explícito `com1.resume`,
com identidade e política sensível, sem rotina fiscal automática neste agendador.
Esses caminhos podem acessar o motor durante o I/O da coleta, que não mantém
uma transação SQLite aberta nem bloqueia a concorrência do objeto.

Não há `sleep` nem repetição interna: quota, intervalo mínimo, `Retry-After`
e backoff viram `not_before` persistido. Partes, aprovação, conta, geração,
revisão de credencial e posse são conferidas antes/depois do I/O. Base
desligada suspende a função; partes comerciais desligadas não impedem a
consulta histórica. Religar parte não adota dados. O guia da função
descreve os limites e o [roteiro do dono](RECEBER-BLING-PRIMEIRA-COLETA.md)
separa aceite simulado de conferência oficial e coleta real.

## Entrega de estado e `/erp-wake` (fase 2)

`POST /erp-parts` recebe `{profile, revision, expires_at, parts}`. Os nove
booleanos são obrigatórios; a revisão é decimal não negativa e a validade
não ultrapassa seis minutos desde a leitura confiável no D1. O objeto
valida o vínculo à área e grava no KV antes de importar o motor.

Revisão menor não substitui maior. A mesma revisão exige mapa idêntico e
só pode renovar validade. O ACK identifica a área e a revisão entregues;
`delivered_revision` confirma apenas esse número, sem encobrir revisão
mais recente. Perda de entrega ou ACK mantém a pendência durável.

`POST /erp-wake` aceita somente `{at?: ms}` e usa a fotografia já entregue.
Mapa parcial `blocks` não autoriza mais produção. Ganha o alarme mais cedo;
ausência, expiração ou Base desligada removem o alarme sem carregar o motor.
Chamadas RPC autenticadas também renovam o KV pelo envelope, na própria
ida ao objeto. Seu ACK administrativo é reconciliado por comando/modelo/cron,
sem uma segunda ida ao D1 por leitura de metadados.

`erp_sync.status=applied` confirma a entrega daquela revisão; não significa
que alguma tarefa executou. A reconciliação de partes no objeto usa a
fotografia recebida, sem consultar D1. A função de coleta consulta configuração,
sessão e cofre do núcleo no D1 fora da transação SQLite; alarme sem trabalho
de coleta/limpeza não acessa essas dependências. A transação síncrona já
iniciada termina com sua fotografia; não existe transação D1 + SQLite.

**Acordar no pedido.** RPC registrado com `registerRpc(…, { wake: true })`
cria trabalho para o agendador. Depois que ele dá certo, a rota `/erp-rpc`
antecipa o alarme para daqui a 1 s (`wakeSoon`, e ganha o mais cedo). Hoje só
o `erp_platform_export_request` tem isso: a exportação pedida no painel
começava só na próxima acordada, até 1 h depois (achado da K: "Na fila" por
uma hora). É o único pedido do painel que cria tarefa da plataforma.
Teste de ponta a ponta: `tests/erp-do-scheduler.test.ts`, "caminho do
painel". Ele faz o pedido pela rota da erp-api, roda só os alarmes que o
objeto agendou, pede o link pela rota e baixa o
`wabotia-exportacao-….zip` pela URL pública.

## O alarme não segura quem usa o ERP

- **Uma transação por unidade.** Uma unidade é um passo de rotina, um claim,
  ou a execução de uma tarefa somada à conclusão dela. Falha no meio não
  desfaz o que já foi feito.
- **Cede a vez entre as unidades** com um `await` de verdade (`setTimeout 0`,
  não microtarefa). Uma chamada ao objeto que chega no meio da rodada é
  atendida entre duas unidades.
  - Prova: `tests/erp-do-scheduler.test.ts`. Uma rodada de 40 unidades, com
    `/erp-ping` e um RPC chegando no meio, responde antes do fim.
  - Controle: com só microtarefa, as duas chamadas esperam as 40 unidades.
- **Orçamento por acordada:** 2 s de relógio e 200 unidades. A sobra fica
  `partial` (a rotina continua vencida) e o alarme volta 1 s depois.
- **Meta de 50 ms por unidade.** A retenção usa lotes de 100 tarefas. A
  `notifications_run` é uma unidade só (todas as pessoas e tipos numa
  transação, como no Fagoo). Medir na instalação de teste. Se passar de
  50 ms, a G a divide por tipo.
- O relógio de parede (`performance.now`) no workerd só anda com E/S. Com
  `await` entre as unidades ele anda, mas a medida de uma unidade é grosseira.
  O teto de unidades protege quando o relógio não anda.

## Quando roda

- **Primeira rodada** de uma instância (ou depois de uma restauração): toda
  rotina está vencida e roda uma vez. Sem efeito repetido: as tarefas têm chave
  `(purpose, operation_id)`, e as notificações usam `ON CONFLICT DO NOTHING`
  por `(user, type, day)`. O próximo horário parte de agora. Por isso uma
  rotina diária vista pela primeira vez pouco antes do horário roda de novo
  nele (a retenção às 03:05 e às 03:10). A segunda passada não acha nada novo,
  e daí em diante é uma vez por dia.
- **Vencida no milissegundo:** o relógio do motor é monotônico em µs, e o
  `Date` do workerd fica parado durante o código síncrono. Uma tarefa criada
  na rodada nasce alguns µs depois do "agora" e conta como vencida no mesmo
  milissegundo, que é a resolução do alarme.
- **Dias parado:** cada rotina roda uma vez e vai para o próximo horário depois
  de agora. Horas perdidas não são recuperadas (o digest das notificações é
  acumulativo, como no Fagoo).
- **Fila:** cada tarefa guarda o próprio `next_attempt_at`. A regra é do Fagoo:
  - posse de 5 min;
  - backoff de `min(60, 2^tentativas)` min;
  - posse vencida conta tentativa.
- **Rotina que falha:** grava `error`, e a nova tentativa sai em
  `min(1 h, 1 min·2^falhas)`, sem passar do próximo horário. As outras rotinas
  e a fila seguem.
- **Parte desligada:** seleção, claim e próximo wake consideram os requisitos
  do payload persistido. Tarefa bloqueada permanece pendente, sem consumir
  tentativa, sem falha e sem ciclo de alarme vazio. Mudança após claim devolve
  a posse à espera se ela ainda pertence ao executor. As rotinas comuns exigem Base.
- **Próxima acordada** é o menor de:
  - a próxima rotina;
  - a próxima tentativa de tarefa com executor;
  - a posse que vence.

  Teto de 1 h, arredondado para cima em ms (o relógio do motor é em µs).

## Finalidades da fila

| Finalidade | Executor | Situação |
|---|---|---|
| `notifications_generate` | `erp_platform_notifications_run`, depois `task_finish` na mesma transação | Ligada, na rodada síncrona. |
| `export_cleanup` | `exportStorage.remove` de cada pacote vencido (`export_expired`/`export_removed`) | Ligada, pelo executor de arquivos. |
| `company_export` | ZIP da empresa em fatias no R2 da área (`runExportStreamed`, A) | Ligada, pelo executor de arquivos. |

**Rodada síncrona** (`TASK_HANDLERS`, `scheduler/dispatch.ts`): a unidade é
uma transação, com `await` entre as unidades.

**Executor de arquivos** (`scheduler/files.ts`), para `company_export` e
`export_cleanup`:

- Chama o `runErpPlatformTasks` da A (`src/erp-export.ts`, o laço do Fagoo
  com a exportação em fatias), com três adaptadores locais. Não há ida ao
  Worker nem volta ao objeto, e não é preciso ator.
  - `rpc`: o `callRpc` no SQLite do objeto, com os objetos e a listagem do
    R2 lidos antes (`rpcStorage`, a mesma leitura da rota `/erp-rpc`) e os
    erros do `createServiceRpc` do Fagoo (`PG_<código>`).
  - `exportStorage` e `attachments`: os do Fagoo, com um fetch que responde o
    `/storage/v1` pelo `erpStorage` direto no R2. Os dois buckets são do bloco
    `erp`, então o objeto continua sem ler o D1.
- A rodada só sinaliza (`fileDue`) e conta essas finalidades para a próxima
  acordada. O alarme roda uma tarefa com arquivo (`maxTasks 1`) só numa
  acordada em que a rodada não fez rotina nem tarefa. Se a rodada fez, a
  acordada seguinte, 1 s depois, é dela.

**Limitação conhecida: a exportação não cabe nos 2 s por acordada.**

- Ela não retoma em outra acordada: o estado do ZIP (diretório central,
  CRCs, a parte em enchimento) fica na memória.
- Por isso roda até o fim numa acordada só, sozinha. Cede a vez a cada
  compressão e a cada ida ao R2: uma gravação por parte de 5 MiB, e no fim
  as partes do envio multiparte.
- O pior caso, 50 MiB, dá umas 10 partes, cerca de 30 operações no R2 e um
  a dois segundos de CPU de compressão. Cabe nos 30 s de CPU do objeto.
- Exportação interrompida: as partes temporárias (`.upload/`) são apagadas
  pela exportação seguinte da área depois de um dia. A tarefa recomeça do
  `export_plan` na próxima posse (regra do Fagoo: nova tentativa com
  backoff).

## Retenção (rotina `retention`, diária, 03:10 de São Paulo)

- **Apaga:** tarefa `done` ou `failed` terminada há mais de 90 dias, com as
  tentativas, em lotes de 100.
- **Fica:**
  - tarefa na fila ou em execução;
  - tarefa ligada a uma exportação (a linha de `erp_platform__export` é
    imutável e tem FK para a tarefa);
  - recibos de comando (as tabelas `*command` de cada domínio).
- **Desvio declarado** em `schema/structural.ts` ("retencao-tarefas"). No
  Fagoo, `task_guard` e `attempt_guard` recusam DELETE e nada limpa. No motor
  os gatilhos são cumpridos em código (`domains/preferences/platform.ts`), e o
  SQLite não tem gatilho contra o DELETE (há um teste para isso).
- **Pacotes de exportação vencidos:** são a tarefa diária `export_cleanup`,
  rodada pelo executor de arquivos.

## Certificado A1

A notificação `certificado_a1` (vencimento em 30 dias) fica desligada até o
porte do Fiscal. Ela lê `erp_a1__head` e `erp_a1__credential`, que existem no
DDL gerado e ficam vazias, então o digest dá zero sem erro (há um teste). A G
foi avisada: manter as tabelas, ou proteger a consulta, quando o Fiscal entrar.

## Limitação conhecida: fuso de São Paulo

As chaves das tarefas (`notificacoes:AAAA-MM-DDTHH`,
`limpeza-exportacoes:AAAA-MM-DD`), o "hoje" das notificações e o horário da
retenção (03:10) são de `America/Sao_Paulo`, como no Fagoo. Assim o
diferencial da G fecha. Consequências:

- Uma área em outro fuso recebe as notificações do "dia" de São Paulo.
- Em datas com horário de verão (até 2019), no dia do início a hora 00 não
  existe: não há tarefa com essa chave. No dia do fim, a hora 23 se repete e as
  duas viram a mesma tarefa. O Fagoo tem o mesmo comportamento.
- O fuso por área entra quando o núcleo tiver o fuso da área. Mudar as chaves
  quebra a idempotência com as tarefas já gravadas, então é preciso migrar.

## Cron

No `scheduled` de `src/index.ts`:

```ts
import { wakeErpAreas } from "./erp/scheduler/cron";
// ...
ctx.waitUntil(wakeErpAreas(env, event.scheduledTime));
```

- Age em toda passagem do cron de cinco minutos, sem filtro horário.
- Seleciona Base ligada e revisões pendentes, inclusive após exclusão da
  última linha de módulo. Faz leitura fresca consistente por área.
- Entrega `/erp-parts`; a entrega reconcilia o alarme e confirma a revisão no D1.
- Área desligada recebe o desligamento pendente, sem carregar seu motor.

Testes: `tests/erp-do-scheduler.test.ts`, `tests/f2-fundo.test.ts` e
`tests/erp/unico/f2-fundo.test.mjs`.

## Testes: relógio injetado

Teste que depende da hora em que a suíte roda é defeito do teste.

- **Node** (`tests/erp/scheduler/dispatch.test.mjs`): `runRound` recebe `now`,
  `elapsed` e `yieldTurn`, e o `Date.now` é trocado pelo relógio do teste.
- **Junção Bling/F3/NF-e** (`tests/erp/scheduler/bling-coexistence.test.mjs`):
  os dois `Coordinator` reais acordam no mesmo instante simulado, com fila
  F3, emissão interrompida e coleta ligada. Enquanto a montagem do Bling
  aguarda D1, a fila conclui e o serviço fiscal consulta a mesma referência
  por uma porta de cofre falsa. As notificações já foram executadas, a coleta
  permanece adiada e a limpeza conserva seu prazo. Outro caso exige zero
  acesso a D1, R2 ou HTTP no alarme ERP ocioso com coleta ausente/desligada.
- **Workerd** (`tests/erp-do-scheduler.test.ts`):
  - `at(ms)` fixa o `Date` com `vi.useFakeTimers({ toFake: ["Date"] })`. O
    objeto roda no mesmo isolado, então o relógio vale para o alarme, as
    funções da plataforma e o `Clock` do motor. O `setTimeout` das cessões de
    vez continua real.
  - Os instantes são o próximo "HH:MM" de São Paulo nas próximas 24 h do
    relógio real. Assim nenhum alarme agendado fica no passado, e o
    `erp_platform_schedule` aceita o `p_now`.
  - Janelas cobertas: virada de hora (05:59:59 → 06:00:00), a retenção das
    03:10 e a virada do dia em São Paulo (23:59:59 → 00:00:00).

## Fora deste corte

- **Fila de saída dos módulos** (Pedido, OS, Mensalidade e Mesas para o ERP):
  fica no D1, do lado da área, drenada pelo alarme da área. Ver o plano em
  `side-session-notes`, seção 5.
- **Fila do ERP para os módulos** (`outbox` com `claim`/`ack`): vem depois. O
  agendador só cuidará dos claims vencidos e da retenção.
- **Medição de CPU real** na instalação de teste: roteiro para a K.

## Partes das notificações

`notificationDigestFor` e `notifyMember`, em
`domains/preferences/notification-units.ts`, recebem estado explícito.
O executor filtra antes de calcular, gravar e exibir. Financeiro controla
atrasos e pagamentos; Estoque controla limites, saldo zerado e vencimento de
lotes; Produtos controla validade; Vendas controla próximo contato; Fiscal
controla certificado A1; Base controla cliente visitado. O mapa comum é
`erpNotificationRequirement`, em `parts-requirements.ts`.

Ao religar, alertas calculam a situação atual. Não há recuperação de rodadas
históricas, recorrência financeira nova ou automação comercial compensatória.
Demais limites da entrega: [ERP-FASE2.md](ERP-FASE2.md).
