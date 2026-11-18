# Entrega I3 — fechamento da conferência do motor

Relato consolidado dos 13 itens e das correções após as verificações externas.
O fim do log atual, `.codex-verificacao.log`, registra **230 de 231 arquivos e
2.007 de 2.008 testes aprovados**. A única falha foi em
`tests/pedido-whatsapp.test.ts:774`: o pedido de balcão abriu a conversa na
segunda linha oficial. A causa foi reproduzida localmente com duas conexões
criadas no mesmo milissegundo; o desempate por UUID escolhia a segunda.
`conversationByPhone` agora desempata pela ordem de cadastro (`rowid`). O
teste antigo ficou intacto e o novo cenário passou após a correção.

Leitura inicial: [I2-ENTREGA.md](I2-ENTREGA.md). Os itens já corrigidos foram
confirmados no ensaio integrado, sem reaplicar mudanças. As cinco falhas da
primeira rodada I3, a falha do cache do alarme e o empate na escolha da linha
têm contraprovas. A correção anterior do alarme continua em **71/71 instruções**.
A decisão do produto sobre identificação residencial substitui a classificação
anterior dos modelos; nenhum outro campo teve sua classificação alterada.

**Resultado local atual:** TypeScript, build, oito cenários I3 e integração
offline completa aprovados. A suíte integral Vitest/Cloudflare ainda precisa
ser repetida externamente após esta correção; a execução registrada no log
é anterior a ela e não comprova aprovação integral desta revisão.

## Itens

| Item | Veredito | O que mudou ou foi confirmado | Teste |
|---|---|---|---|
| 1. Versão do orçamento | Já corrigido em I2 | `contracts.ts` já tem `QuoteRequest.version?`; `store.ts/saveQuote` confere a versão. Sem alteração adicional. | `integrationPendencies`: versão obsoleta retorna 409, embutido aceita corpo sem versão e orçamento personalizado conserva a política antiga e o replay. |
| 2. Corrida de sigilo do lembrete | Corrigido | `src/modules/os/tasks/reminders.ts` relê a tarefa imediatamente antes do envio ao cliente, depois de verificar a conversa. Exige mesma versão, estado aberto, ausência de arquivamento/notificação, destinatário cliente, visibilidade e ausência de sigilo. Preserva a serialização da I2. | `taskPrivacyRecheck`: intercala mudança de versão, sigilo, visibilidade, destinatário, conclusão, cancelamento, arquivamento e notificação; nenhum envio ou marcação indevidos. Controle sem mudança envia. `schedulerSerialization` continua passando. |
| 3. Formulário | Já corrigido em I2 | `src/web-steps.ts` aceita 1–32 opções e respeita `max_length`; `src/modules/os/forms.ts` transmite o limite e converte opções pelo snapshot. | `integrationPendencies`: 1, 21 e 32 opções; 1.500 caracteres aceitos e 1.501 recusados; HTML com o limite; compatibilidade dos links antigos e do padrão de 300. |
| 4. Recuperação do modelo | Já corrigido em I2 | `area-templates/engine.ts` recupera antes da prévia; recibo e efeitos são gravados com a configuração. Migração 0118 mantida. | `templateRecovery`: falha de publicação depois do commit, repetição da chave devolve exatamente o resultado persistido, publica sem duplicar e recusa corpo diferente com 409. |
| 5. Definições e política no DTO | Já corrigido em I2 | `fields`/`features` vêm do snapshot; definições sensíveis exigem papel explícito, valores ficam em `/private-fields`. `PrivateFieldsDialog.tsx` usa as definições autorizadas; `WorkDetailPage.tsx` usa capacidades fixadas. Projeções de cliente/bot continuam filtradas por `privacy.ts`. Sem alteração adicional no painel. | `integrationPendencies`: definições privadas autorizadas, ausência delas sem papel, capacidades e política de orçamento da revisão anterior. Cenários de segurança I2 também aprovados. |
| 6. Filtros `open`/`all` | Já corrigido; confirmação ampliada | Servidor usa `open=1` para abertas e `stage` como ID literal com `type_id`. Painel já distingue `filter:open`, `filter:all`, `stage:open` e `stage:all`. `docs/TRABALHOS.md` explicita a distinção. | Novo `literalStageFilters`: etapas reais `open` e `all`, abertas, todas e recusa de etapa sem tipo. Cobertura existente do painel em `os-web-review.test.ts` preservada para execução externa. |
| 7. Relógio instável | Já corrigido em I2 | `tests/os-integration-scenarios.ts` já usa um único `taskDueAt` para `due_at` e `remind_at` nas 12 tarefas. Sem alteração. | `budgetScenario` aprovado, com as 12 tarefas e todos os tetos originais. |
| 8. Anexo comum | Já corrigido em I2 | `documents/delivery.ts` retorna `false` antes de consultar a mídia se não houver comando `DOCUMENTO`. Sem alteração. | `integrationPendencies`: `segue`, foto, áudio, texto vazio e palavra semelhante não geram resposta, consulta de mídia ou documento; comando malformado conserva orientação. |
| 9. Cursor das tarefas | Corrigido | Migração aditiva `0119_os_task_reminder_cursors.sql`: uma linha por área, somente instante/ID. `tasks/reminders.ts` lê e atualiza no D1, contabiliza ambas as instruções e reserva a última ao checkpoint. Demais lembretes permanecem intactos. | `taskCursorD1`: R2 proibido, dez bloqueados não prendem o 11º, retomada com contexto novo, isolamento por área, volta aos bloqueados, dez envios no orçamento e checkpoint mesmo após esgotamento de 50 instruções. |
| 10. Aplicativos | Documentado | Seção “Aplicativos” em `docs/TRABALHOS.md`: códigos de histórico, oferta indevida de orçamento desativado e adoção pendente de etapas/capacidades fixadas em Android/iOS. | Conferência com `relatos/corr-api-apps.md`; nenhum código ou teste móvel alterado. |
| 11. Catálogo do bot | Corrigido | `src/modules/openapi.ts` descreve somente as operações novas como módulo de trabalhos. Conserva descrições legadas, catálogo e limite de dez. | `legacyCatalogSearch`: `os.create` e `consulta:service-orders` aparecem nos dez resultados de “ordem de serviço”. A base anterior excluía `os.create`. `tests/bot-actions.test.ts` intacto. |
| 12. Orçamento D1 legado | Corrigido e ampliado após a verificação externa | `src/modules/os/stage-replies.ts` retorna `false` quando não há tipos personalizados, usando a configuração em cache. `src/coordinator.ts` mantém o cache novo aberto dentro do bloqueio da rodada e o reutiliza no restante do alarme, eliminando duas leituras repetidas. | `legacyStageReplyBudget`: `1`, `2` e `APROVAR` acrescentam zero instruções; base anterior acrescentava três. Novo `legacyAlarmBudget`: reproduziu 73/71 antes da correção e passou com 71/71 depois, com mensagem processada, duas entregas antigas canceladas e uma leitura de configuração/estado dos módulos. `schedulerSerialization` continua aprovado. `tests/d1-budget.test.ts` e teto 71 intactos. |
| 13. Identificação residencial | Aplicada decisão do produto | `models/condominios.ts`: campo `unidade` (bloco e número) comum e visível nos quatro tipos. `models/construtoras.ts`: mesmo tratamento no pós-obra. Ajuda, termos e instruções permitem citação ao titular pela equipe/bot. Outros campos e nome do aluno preservados. | `residentialFields`: validação, captura comum, projeções de equipe/cliente/bot e mensagem. Testes dos modelos e de privacidade ajustados à decisão; `condominioIntegration` confirma unidade pública e mantém uma sentinela em `detalhes_restritos` para verificar sigilo. |
| Verificação externa: linha do pedido de balcão | Corrigida | `src/service.ts/conversationByPhone`: `ORDER BY created,rowid` preserva a primeira linha cadastrada quando os instantes empatam. Sem nova consulta ou migração. | Novo `legacyCounterLineChoice`: falha antes e passa depois, pelo HTTP e Coordinator reais; conserva consentimento, notificação, idempotência, conversa existente, escolha explícita e isolamento da área. `tests/pedido-whatsapp.test.ts` e `tests/conversation-by-phone.test.ts` intactos. |

## Falhas externas, causas e correções

### Rodada atual: escolha da linha do pedido

O teste “balcão só com telefone: com whatsapp_notices abre a conversa e
registra o consentimento” esperava a linha `9f18c223-…` e recebeu
`898201cf-…`. A fixture antiga insere as duas linhas oficiais em sequência,
chamando `now()` em cada inserção. Se ambas recebem o mesmo milissegundo, a
consulta `ORDER BY created,id` usa a ordem textual dos UUIDs. Nesse caso a
segunda linha pode vencer, embora a primeira tenha sido cadastrada antes.
O histórico local confirma que esse desempate já existia antes de I3; a
verificação completa expôs a falha latente.

A mudança de produção é restrita ao desempate em `src/service.ts`:
`ORDER BY created,rowid`. A seleção continua priorizando a data, filtrando
linha oficial ativa da área e respeitando a conexão explicitamente informada.
Conversa existente continua sendo reutilizada. O número de consultas não muda.

O novo `legacyCounterLineChoice` força instantes iguais e UUIDs em ordem
inversa à inserção, sem depender da velocidade do ambiente. Cria um pedido
pela API real e verifica exatamente a primeira linha, telefone normalizado e
ausência de janela de 24 horas; depois confere consentimento `order/panel`,
notificação com a finalidade correta e replay sem nova conversa. Também
confere pedido sem aceite, recusa de aceite sem evidência, data anterior,
conexão explícita, reutilização da conversa e recusa de linha QR, pausada,
de outra área ou ausência de linha oficial ativa.

Antes da correção, os sete cenários anteriores passaram e esse oitavo falhou
na escolha da linha (`00000000-…` em vez de `ffffffff-…`). Depois, os oito
passaram com as mesmas asserções. A contraprova com o serviço do HEAD também
reproduziu a falha. Nenhum teste antigo ou fixture compartilhada foi alterado.

### Rodada anterior: orçamento do alarme

A verificação anterior, registrada na versão precedente deste relato, teve
230/231 arquivos e 2.006/2.007 testes aprovados. A única falha era
`tests/d1-budget.test.ts:304`, “fluxos principais dentro dos tetos medidos”.
O caminho de aprovação de etapa já saía sem consultar `os_orders` em áreas
sem tipos personalizados; portanto, a primeira correção do item 12 estava
ativa. Restavam duas instruções repetidas:

- `SELECT module_id,enabled FROM profile_modules WHERE profile_id=?`;
- leitura de `profiles` com o estado dos módulos (`PROFILE_SETTINGS_SQL`).

A serialização introduzida em I2 abria um cache novo dentro de
`blockConcurrencyWhile`, necessário para começar a rodada com leituras atuais.
Esse cache era usado somente pelo agendador: `processInbox` e as entregas
continuavam com o cache anterior do alarme e repetiam as duas consultas.

A correção em `src/coordinator.ts` conserva a criação do cache dentro do
bloqueio e passa a usá-lo no restante da mesma invocação. O bloqueio entre
seleção, autorização e enfileiramento continua presente, assim como a
invalidação das leituras após gravações nas tabelas de configuração. Não há
cache persistente entre alarmes, redução do trabalho executado ou aumento de
teto.

O novo `legacyAlarmBudget` liga os mesmos dez módulos do teste antigo, deixa
uma resposta `2` ao Suporte na entrada e duas entregas de épocas antigas na
saída. Executa o alarme real e confere o efeito sobre entrada, entregas e
tentativa de identificação do cliente. Antes da alteração de produção, falhou
com as mesmas **73 instruções** do log; depois, passou com **71**, incluindo
as asserções de uma única leitura da configuração e dos módulos. A contraprova
contra o HEAD também falha, com **74**, pois essa base ainda contém a consulta
extra de aprovação de etapa removida na primeira rodada I3.

A suíte externa atual tem apenas a reprovação do pedido descrita acima;
a falha do alarme não se repetiu. O ensaio local desta rodada reconfirmou
71/71 e a serialização. As mensagens de erro de publicação no log pertencem
à injeção deliberada de falha de recuperação, cujo teste passou.

## Arquivos de teste e execução

- `tests/os-i3-scenarios.ts`: oito cenários compartilhados, executáveis tanto
  pelo ensaio local como pelo runtime Cloudflare.
- `tests/os-i3-integration.test.ts`: registra os oito na suíte do produto.
- `scripts/check-os-integration.mjs`: opções `--i3`, `--i3-only` e
  `--i3-baseline`; continua usando SQLite real, R2/DO em memória e sem rede.
  A contraprova lê somente os sete arquivos anteriores de produção por
  `git show HEAD:caminho`, sem mudar arquivos, branch ou índice. Ela se refere
  ao HEAD da árvore atual; nenhuma alteração desta entrega foi commitada.
- `tests/area-template-condominio.test.ts`, `area-template-obras.test.ts` e
  `area-template-privacy.test.ts`: expectativas da identificação residencial
  atualizadas; barreiras dos demais campos e nomes de alunos preservadas.
- `tests/os-i2-scenarios.ts`: fluxo de Condomínio atualizado para a decisão,
  com valor reservado real em campo que continua sensível.

| Verificação executada | Resultado |
|---|---|
| Suíte externa registrada em `.codex-verificacao.log`, antes desta correção | 230/231 arquivos e 2.007/2.008 testes aprovados; única falha: linha do pedido de balcão em `pedido-whatsapp.test.ts:774`. Não foi executada novamente nesta sessão. |
| `./node_modules/.bin/tsc --noEmit` | Aprovado. Mesmo compilador local de `npx tsc --noEmit`, sem rede. |
| TypeScript estrito pela API local, incluindo seis arquivos de testes I3/modelos e dependências | Aprovado; com as declarações locais de `@cloudflare/vitest-plugin/types`, sem executar o runner nem emitir arquivos. |
| `npm_config_offline=true npm_config_update_notifier=false npm run build` | Aprovado. Apenas avisos do empacotador, incluindo a diretiva `use client` do React Router. |
| `node scripts/check-os-integration.mjs --i3-only`, antes da correção da linha | Sete cenários aprovados; novo `legacyCounterLineChoice` reprovado por selecionar a segunda linha no empate. |
| `node scripts/check-os-integration.mjs --i3-baseline --i3-only` | Sete falhas esperadas confirmadas, incluindo a escolha da linha; filtro literal já passa na base anterior. A execução retorna sucesso por comprovar as contraprovas. |
| `node scripts/check-os-integration.mjs --i3-only`, depois da correção | Oito cenários I3 aprovados, incluindo pedido de balcão, alarme legado em 71/71, esgotamento de orçamento e retomada do cursor. |
| `node scripts/check-os-integration.mjs --i3` | Oito cenários I3, 11 I2, nove barreiras clínicas, 17 modelos, recuperação e regressões de prazos/anexos aprovados. Orçamento: filhos 47/200, alarme com tipos personalizados 165/800; alarme legado 71/71. |
| `node --test tests/os-i2-bootstrap.test.mjs` | 2/2 aprovados; Worker e Coordinator inicializam em processos separados. |
| `node scripts/check-conflict-markers.mjs`, `node scripts/check-encoding.mjs`, `git diff --check` | Aprovados. Arquivos novos também conferidos como UTF-8 sem BOM e LF. |

As mensagens de falha de publicação/auditoria no ensaio são injeções
deliberadas dos testes de recuperação; suas asserções passaram.

## Limites e pendências

A migração 0119 foi aplicada apenas ao SQLite do ensaio. Deve acompanhar o
código na implantação habitual. O primeiro ciclo no D1 começa do início da
fila; os antigos objetos de cursor R2 deixam de ser usados. As marcas de
notificação e chaves idempotentes permanecem, sem apagar marcas de entrega ou reenviar
lembretes já concluídos.

A mudança dos modelos vale para novas aplicações; snapshots de ordens abertas
e configurações já aplicadas não são reclassificados retroativamente. As
proteções de revisão/reaplicação existentes permanecem.

Não foram executados Vitest, Wrangler, rede, testes nativos móveis, navegador
ou canal real nesta sessão. A nova execução da suíte integral do produto,
incluindo os testes antigos dos itens 11/12 e de pedido/conversa por telefone, fica para o
verificador externo. Sem alterações em
`src/erp/`, em testes antigos do produto, no código móvel ou na regra de
documentos por WhatsApp (telefone verificado precisa ser o da ordem). Sem
commit, push, troca de branch, novo Durable Object ou recurso Cloudflare.

Não há dúvida técnica bloqueante; falta a confirmação da suíte externa.
