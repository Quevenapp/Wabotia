# Fase 1 — identidade no caminho de mensagens

## Estado da entrega e causa da falha atual

Relato completo atualizado em 18/11/2026. Trabalho limitado aos arquivos de
`f1-identidade` na Parte B. Sem commit, rede, Vitest ou Wrangler nesta sessão;
nenhuma asserção existente removida e nenhum teto aumentado.

O `.codex-verificacao.log` atual registra `npm run check` aprovado e
**35 testes aprovados, 3 falhos, de 38** na execução externa:

| Arquivo | Aprovados | Falhos |
| --- | ---: | ---: |
| `tests/f1-identity.test.ts` | 13 | 0 |
| `tests/f1-inbound.test.ts` | 17 | 3 |
| `tests/d1-budget.test.ts` | 5 | 0 |

As três falhas são os casos de queda antes, dentro e depois do lote da inbox.
A criação da conversa omitia `epoch`, herdando `DEFAULT 0` da migração.
O teste exige época **1** antes da confirmação e **2** depois; o código
produzia **0** e **1**. O incremento da mensagem já era atômico com a inbox,
mas a época inicial não atendia à regressão. A execução local anterior não
conferia esses valores absolutos e, por isso, não detectou a diferença.

Correção: o `INSERT ... RETURNING` do ramo que cria a conversa em `inbound`
agora declara `epoch=1`. O incremento da mensagem permanece no lote da inbox;
uma repetição reutiliza a conversa criada e não repete a inicialização.
Isso não acrescenta instruções nem viagens e não modifica migrações.
As asserções que falharam foram preservadas. Foram acrescentados três casos
para conversas existentes na época 37: queda antes/dentro mantém 37;
confirmação ou retomada termina em 38; repetição não avança novamente.

A causa foi reproduzida localmente antes da correção (`0 !== 1`). Após a
correção, **112 verificações explícitas passaram** com SQLite local.
**Ainda falta nova execução externa da revisão final no runtime D1**;
os três testes falhos e os três novos não foram executados com Vitest nesta
sessão e não são apresentados como aprovados nesse runtime.

O relato anterior registrava 28 aprovações e seis falhas numa rodada mais
antiga. Permanecem entregues as duas correções daquela rodada: alias SQL
`indexed` substituído por `indexed_phones` no preenchimento, e redução da
primeira entrada de 31 instruções/15 viagens para 20/9. O log atual confirma
o preenchimento e os testes de orçamento aprovados; aqueles números antigos
são histórico do relato, não o resultado do `.codex-verificacao.log` atual.

## Medição antes/depois e limites da evidência

A execução local usa Node 26.4.0, `node:sqlite` / SQLite 3.54.1 em memória,
todas as migrações existentes, chaves estrangeiras habilitadas e os módulos
reais de `service`, `identity`, `backfill`, `ports` e `db`. Um adaptador
implementa `prepare/bind/first/all/run/batch`; `batch` executa uma transação
SQLite real. O contador é o próprio `tests/d1-counter.ts`.

Não há banco em rede nem runtime Cloudflare nessa execução local. O bundle
foi reconstruído a partir dos fontes atuais com o esbuild já instalado.
Os números contam instruções SQL e chamadas ao banco/adaptador, sem medir
latência de produção, linhas lidas, retries internos ou cobrança real de D1.
Há duas fontes de evidência, indicadas na tabela: o log externo fornecido
(anterior à correção de época) e a execução SQLite desta revisão.
O construtor, o script e o resultado estão em
`/private/tmp/f1-identidade-verificacao/{build,verify}.mjs` e
`/private/tmp/f1-identidade-verificacao/result.json` (artefatos locais,
fora dos arquivos entregues ao repositório).

| Cenário | Instruções | Viagens | Evidência |
| --- | ---: | ---: | --- |
| Primeira entrada antes da otimização | 31 | 15 | Histórico preservado do relato anterior |
| Primeira entrada, legado incompleto | 20 | 9 | Log externo atual e SQLite desta revisão |
| Primeira entrada com os dez módulos do teste de orçamento ligados | 20 | 9 | Log externo atual e SQLite desta revisão |
| Primeiro número, preenchimento completo | 20 | 9 | Log externo atual e SQLite desta revisão |
| Mensagem seguinte na conversa resolvida | 10 | 7 | Log externo atual e SQLite; identidade acrescenta zero SQL |
| Mesmo webhook repetido | 1 | 1 | Log externo atual e SQLite; somente deduplicação |
| Segundo canal da mesma área | 17 | 9 | Log externo atual e SQLite; reutiliza contato |
| LID sem prova | 12 | 8 | Log externo atual e SQLite; pending, sem contato |
| Aplicação | 10 | 6 | Log externo atual e SQLite; excluded |
| Número ambíguo | 18 | 9 | Log externo atual e SQLite; sem terceira ficha |
| Rodada dedicada, página de contatos vazia do namespace app | 5 | 3 | Log externo atual e SQLite desta revisão |
| Preenchimento de 20 contatos legados | 9 | 3 | Execução local SQLite; checkpoint atômico |
| Referência controlada: mesma entrada com porta simulada sem SQL | 11 | 8 | Log externo atual e SQLite; somente comparação de custo |

A diferença de 31/15 para 20/9 corresponde a **11 instruções e 6 viagens a
menos**. O log externo atual confirma 20/9; a correção de época mantém esse
custo na execução local. A referência controlada isola o acréscimo atual da
identidade: 9 instruções e 1 viagem.
Não equivale à execução de uma revisão antiga. `docs/LIMITES.md` registra
18 instruções históricas para a entrada anterior à fase 1, sem viagens;
esse número também não foi medido novamente nesta sessão.

A redução preserva as garantias:

- Afinidade, identificador exato e conversa de saída sem resposta são lidos
  numa instrução, nessa precedência; o fallback exige telefone exato provado.
- `INSERT/UPDATE ... RETURNING` evita reler a conversa recém-gravada.
- O incremento de época da mensagem compartilha o `UPDATE` final da inbox.
  A época inicial 1 é escrita no próprio `INSERT` da conversa, sem SQL extra.
  Conversa recém-criada não pode ter protocolos para retomar; em conversas
  existentes a consulta permanece e o `UPDATE` só roda quando há protocolos.
- Uma asserção reúne os guardiões do legado, versão do índice e estado de
  restrição do contato escolhido, inclusive após o preenchimento completo.
- A atualização da prova e do marcador também invalida as outras conversas
  do telefone. Quando o plano protegido é ready, um UPSERT substitui o
  vínculo atual; vínculos históricos permanecem imutáveis.

`tests/d1-budget.test.ts` preserva todos os tetos e testes anteriores e agora
exige o teto de 20 também nos dois cenários novos de primeira entrada.
Imprime `FASE1-CUSTO-D1-fluxos` e `FASE1-CUSTO-D1`, com instruções, viagens e
SQL sem parâmetros; ambos aparecem no log externo fornecido.

Os demais fluxos medidos nesse log também respeitaram os tetos originais.
Estes fluxos completos não foram reexecutados localmente nesta sessão:

| Fluxo | Instruções | Viagens | Teto de instruções |
| --- | ---: | ---: | ---: |
| Primeira mensagem: motor | 28 | 26 | 30 |
| Escolha no menu (Cardápio): motor | 40 | 39 | 43 |
| Palavra-chave atendente (Suporte segura): motor | 33 | 31 | 37 |
| Conclusão do carrinho (Pix) | 57 | 55 | 59 |
| Webhook do Mercado Pago: Worker | 2 | 2 | 2 |
| Webhook do Mercado Pago: Coordinator | 28 | 26 | 30 |
| Rodada periódica dos módulos | 23 | 23 | 24 |
| Fila: emitir senha | 17 | 3 | 17 |
| Fila: chamar a próxima | 18 | 3 | 18 |
| Mesas: lançar pedido | 26 | 18 | 27 |
| Mesas: mapa das mesas | 6 | 6 | 8 |
| Mesas: fechar a conta | 21 | 11 | 21 |
| Alarme com mensagem e entregas pendentes | 70 | 69 | 71 |

`/inbound` e `/customer-tick` no Coordinator expõem `Server-Timing` com viagens
e tempo de D1. Não há gravação de telemetria por mensagem. A instrumentação
não acrescenta telefone, mensagem ou dados cadastrais aos logs.

## Alterações completas por arquivo

| Arquivo | Entrega acumulada |
| --- | --- |
| `src/customer/identity.ts` | Implementação de IdentityPort: prova por origem autenticada, contato automático sem ERP, resolução por área/namespace, índice e invalidação, ambiguidade/restrição/bloqueio, guardiões concorrentes, vínculos atuais e sessões imutáveis, caminho sem SQL extra para identidade já pronta. |
| `src/customer/backfill.ts` | Preenchimento retomável de contatos e conversas, páginas de até 20 itens, checkpoint atômico, orçamento conservador de até 9 instruções por página, preservação de escolhas humanas e provas observadas; correção do alias SQL. |
| `src/service.ts` | Registro da porta no carregamento, validação de origem e prova no servidor, identidade no lote da inbox, busca telefônica exata por identidade resolvida, reaproveitamento da conversa de saída, retorno com nova sessão, encaminhamento do ID estável de perform e otimização para manter o teto de 20. Criação explícita na época 1; avanço da mensagem atômico com a inbox. |
| `src/coordinator.ts` | POST interno `/customer-tick`, fachada com orçamento fixo de 40 instruções/20 itens e Server-Timing; instrumentação da entrada; nenhum trabalho cadastral acrescentado ao alarme. |
| `src/protocol-lookup.ts` | verifiedPhone depende da prova e do estado ready; consulta cruzada exige identidade resolvida e registro do protocolo; fallback só para conversa original; textos em português atualizados. |
| `src/zernio.ts` | Remoção do fallback numérico de sender.id, normalização estrita de phoneNumber e reconhecimento de grupo explícito ainda não sincronizado. |
| `connectors/qr/features.mjs` | Telefone somente a partir de JID telefônico válido, inclusive sufixo de dispositivo; JID alternativo provado; LID e grupo não viram telefone. |
| `tests/f1-identity.test.ts` | Canais, áreas, namespaces, nono dígito, legado, duplicados, mudança de telefone, restrição, bloqueio, custo zero, preenchimento e edição concorrente; regressões adicionais para invalidação combinada e restrição entre plano e lote. |
| `tests/f1-inbound.test.ts` | QR/LID, Zernio, grupo/aplicação, origens forjadas, falhas antes/dentro/depois do lote em conversas novas e existentes, repetição sem incremento da época, retorno, saída, ID estável, protocolos e customer-tick; regressões de época atômica, precedência do roteador e retomada de protocolos. Nenhuma asserção anterior removida ou relaxada. |
| `tests/d1-budget.test.ts` | Relatórios imprimíveis dos fluxos existentes e novos, comparação controlada, contagem de manutenção, custo zero e deduplicação; tetos originais preservados. |
| `docs/FASE1-CUSTO-D1.md` | Este relato completo: custos e método, causas, verificação, atomicidade, pedidos à base, exclusões e dúvidas. |

## Verificação realizada nesta sessão

- `npm run check`: aprovado (geração local, marcadores de conflito,
  codificação, escopo CSS e TypeScript sem emissão).
- `node --check connectors/qr/features.mjs`: aprovado.
- Análise sintática TypeScript dos três arquivos de teste com o esbuild já
  instalado: aprovada; não executa os testes nem importa Vitest. O esbuild
  avisou sobre a chave `allowImportingTsExtensions` duplicada no `tsconfig.json`
  existente; esse arquivo não pertence à tarefa e foi preservado.
- Reprodução local antes da correção: falhou com `0 !== 1` na época após
  queda antes do lote, confirmando a mesma causa do log externo.
- Execução local após a correção: **112 verificações explícitas aprovadas**,
  incluindo rollback antes/dentro/depois do lote, repetição, reuso entre
  canais, ambiguidade, troca de telefone sem mover histórico, retomada de
  20+3 contatos, orçamento insuficiente sem SQL, edição concorrente sem
  avançar checkpoint, restrição após plano, prioridade do roteador,
  retomada de protocolo, época da mensagem, integridade de FKs e limpeza
  dos guardiões. Os seis cenários de queda conferem a época persistida,
  rollback, retomada, igualdade com o payload da inbox e repetição sem avanço,
  tanto na conversa nova (1 → 2) quanto na existente (37 → 38).
- `git diff --check`: aprovado. Arquivos modificados/criados limitados à
  lista de propriedade da tarefa; migrações e arquivos de outros donos
  preservados.

Comandos locais executados (dependências já instaladas, sem rede):

```sh
node /private/tmp/f1-identidade-verificacao/build.mjs
node /private/tmp/f1-identidade-verificacao/verify.mjs
npm run check
node --check connectors/qr/features.mjs
git diff --check
```

Para a próxima verificação externa permanece a sequência da tarefa
(registrada aqui, **Vitest não executado nesta sessão**):

```sh
npm run check
npx vitest run tests/f1-identity.test.ts tests/f1-inbound.test.ts tests/d1-budget.test.ts
```

## Atomicidade e retomada

- O contato automático tem `name=''`, `source='automatic'` e nenhum ID ERP.
- O lote que confirma a inbox contém candidatos, índice, associação atual,
  marcador e vínculo de sessão. A conversa pode existir antes desse lote, com
  marcador pending; a inbox não pode existir sozinha.
- A conversa nova criada pelo ramo de `inbound` começa na época 1. Para uma
  mensagem que avança a época, inbox, mensagem e avanço para 2 confirmam juntos.
  Queda antes/dentro do lote mantém 1; queda depois mantém 2. A deduplicação
  antecede a resolução e impede outro avanço. Conversas existentes mantêm sua
  época até o lote confirmar; nenhuma atualização em massa foi feita.
- Planos sobre índice/legado lidos antes do lote usam `customer_assert`.
  Edição concorrente cancela o lote; não se reutiliza um plano envelhecido.
- `indexContact` devolve instruções para o lote do escritor. A troca do índice
  invalida os marcadores afetados. Quem modifica contatos deve usar essa porta
  no mesmo lote condicionado à versão do contato.
- O preenchimento mantém `identity.contacts.v1` e
  `identity.conversations.v1` em `customer_progress`, por área e namespace.
  Processa no máximo 20 registros por página; checkpoint e alterações são
  atômicos. O preenchimento não usa `conversations.phone` como prova.
- A manutenção é exclusivamente `/customer-tick`, POST interno no Coordinator
  da área, corpo `{ "profile": "<área>" }`. Orçamento do servidor: 40 instruções
  e 20 itens compartilhados pela fachada. Não agenda nem acrescenta trabalho ao
  alarme. Uma rodada com saldo insuficiente deixa pendência sem exceder o saldo.
- O vínculo de sessão usa `module_id='core'`, `kind='conversation'`,
  `record_id=conversationId:session`. Conflito não transfere registro antigo.
- A consulta de protocolos usa o registro próprio `kind='ticket'`,
  `record_id=ticket.id`, com área, contato, namespace e conversa conferidos.
  Sem vínculo inequívoco, só a conversa original pode consultar o protocolo.

## Pedidos à base e à integração

1. **Assinatura de `contactCommand` (f1-cadastro):** a base ainda declara cinco
   argumentos. `service.ts` já encaminha o sexto, o identificador estável de
   `perform`, por uma assinatura compatível. O dono de `contacts.ts` precisa
   recebê-lo e usá-lo no lugar de identificadores enviados pelo corpo.
2. **Desvinculação humana (f1-cadastro):** o comando antigo apenas apaga
   `conversation_contacts`. Deve gravar `customer_link_state='blocked'` no
   mesmo lote, com auditoria/versão aplicáveis. A identidade preserva blocked
   e não religa automaticamente. O arquivo de contatos não foi alterado aqui.
3. **Escritores de contatos (f1-cadastro/f1-ponte-erp):** chamar `indexContact`
   atomicamente, inclusive em restrições. Alteração direta de contatos que
   não invalide marcadores quebra a premissa do caminho de custo zero.
   Exclusão/restrição deve conservar candidato/túmulo que impeça reconstrução.
4. **Chaves dos registros (f1-historico/base):** A3/A6 fixam a chave da sessão,
   mas não enumeram `module_id`/`kind`. Adotados os valores acima; os leitores
   devem concordar com eles. Protocolos sem registro próprio não ganham acesso
   cruzado. `createTicket` fica em `service.ts`, fora dos trechos desta tarefa;
   é necessário garantir os vínculos nos chamadores autorizados do histórico.
5. **Agendamento externo:** a rota dedicada está disponível. Sua frequência e
   o chamador não foram especificados; nenhuma rodada foi somada ao alarme.
6. **Revisão após 180 dias:** confirmar o responsável, o estado persistido e
   o inventário de relações/interações usado para encaminhar contatos à
   revisão. A6 exige essa política, mas não define essa representação ou
   uma porta específica; não foi criado um estado fora do contrato.

## Fora do escopo, compatibilidade e dúvidas

Os testes novos cobrem canais, áreas, namespaces, legado, duplicados,
restrições, mudança de telefone, bloqueio explícito, edição durante preenchimento,
QR/LID, Zernio, grupo, aplicação, retorno, falhas antes/dentro/depois do lote,
repetição, protocolo e manutenção dedicada.

Há expectativas antigas incompatíveis com A6 em
`tests/conversation-by-phone.test.ts` (variantes de nono dígito autorizando busca
e retorno) e `tests/service-destinations.test.ts` (acesso cruzado só por telefone).
Esses arquivos pertencem a outros donos e foram preservados. A função legada
`phoneVariants` continua disponível para revisão; a entrada e as buscas desta
tarefa não a usam como autorização. Não se afirma falha executada desses testes:
a incompatibilidade foi identificada por leitura.


Permanecem fora desta entrega: comandos HTTP de cadastro/desvinculação e sua
auditoria, produtores de histórico de protocolos, motor/ponte ERP, promoção,
políticas de revisão dos contatos sem interação por 180 dias e agendamento
externo da manutenção. As migrações são as já entregues pela base; não foram
criadas classes de Durable Object, recursos Cloudflare ou mudanças no esquema
ERP. Não foram alterados testes de outros donos nem arquivos reservados.

Dúvidas de integração ainda abertas: qual serviço chama `/customer-tick` e
com que frequência; confirmação das chaves de sessão/protocolo pela frente
de histórico; adoção da assinatura com commandId e da invalidação atômica
pelos escritores. O próximo log externo deve confirmar os três cenários
corrigidos, os três novos e os custos da revisão final no D1. Os 35 testes
aprovados do log fornecido são evidência da revisão anterior à correção de época.
