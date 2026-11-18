1. **`src/modules/os/stage-replies.ts:25` — Uma resposta ambígua pode aprovar o cancelamento da ordem em vez do orçamento.**
   
   **Gravidade: grave.** Uma ordem personalizada está em `quoted`, com orçamento pendente, e recebe também uma solicitação `customer_approval` de cancelamento — configuração aceita por `validation.ts:112`. O cliente responde `APROVAR` ao orçamento. A consulta retorna uma única ordem, embora existam duas decisões pendentes; `pending.length === 1` faz o manipulador escolher a aprovação de etapa e cancelar o trabalho. Esse manipulador roda antes do orçamento em `os.ts:54`.
   
   **Correção sugerida:** distinguir decisões pendentes, não apenas ordens. Havendo orçamento e aprovação de etapa simultâneos, exigir identificação explícita do fluxo ou botão correspondente, sem executar uma decisão ambígua.

2. **`src/modules/os/stages.ts:60` — A rota `/stage` rejeita todas as transições anunciadas para o tipo embutido.**
   
   **Gravidade: grave.** Uma OS embutida em `received` anuncia `received_analyzing` em `next_stages`, por `work-types.ts:106`. Enviar essa transição com a versão correta retorna `409 invalid_transition`, porque `snapshotType()` retorna `null` para o embutido. O caminho existe na interface: com tipos personalizados cadastrados, o cartão da OS na conversa abre `WorkDetailPage`, cujos botões usam `/stage` (`ConversationWorkOrders.tsx:62` e `work/WorkDetailPage.tsx:103`).
   
   **Correção sugerida:** resolver as transições virtuais do embutido e encaminhá-las às operações legadas, preservando validações, histórico, mensagens e garantia. Não anunciar em `next_stages` ações que o motor rejeita.

3. **`src/modules/os/mutations.ts:77` — A recuperação implementada pelo motor não é alcançada na repetição HTTP após falha posterior à gravação.**
   
   **Gravidade: média.** Uma chamada de `os.stage` confirma ordem e histórico no D1, mas `ctx.publish()` lança um erro de infraestrutura. O recibo fica sem resposta. Repetir a mesma `Idempotency-Key` retorna `409 operation_unknown` em `src/coordinator.ts:235`, antes de executar `replayOrderMutation()`. A exceção para recuperação no Coordinator contempla somente `queue.issue` e `queue.call_next` (`src/queue.ts:1526`). A ordem permanece alterada, sem completar os eventos e mensagens pendentes.
   
   **Correção sugerida:** integrar as mutações do motor ao mecanismo recuperável do Coordinator existente, com identificação durável da mutação e retomada antes da rejeição do recibo incompleto. Apenas registrar os descritores não resolve esse bloqueio.

4. **`src/modules/os/stage-replies.ts:23` — Uma aprovação de etapa encerrada bloqueia respostas textuais de orçamento da mesma ordem.**
   
   **Gravidade: média.** O cliente recusa uma aprovação de etapa; depois a equipe envia um orçamento dessa ordem. `stage_approval_json` continua preenchido com estado `declined`. Ao receber `APROVAR 12`, o manipulador considera a mera existência desse JSON, tenta decidir a etapa já encerrada e responde que a aprovação não está pendente. Como retorna `true`, o manipulador de orçamento não recebe a resposta.
   
   **Correção sugerida:** interpretar o estado da aprovação antes de capturar comandos sem a palavra `ETAPA`. Aprovações encerradas não devem interceptar a resposta destinada ao orçamento.

5. **`src/modules/os/motor-routes.ts:101` — A decisão de aprovação de etapa ignora a autorização calculada para enviar mensagens.**
   
   **Gravidade: média.** Uma aplicação com `conversations:write`, mas que não atende a conversa, aprova uma etapa pendente pela API. `notifyCustomer` é `false`, porém não é passado a `decideStageApproval()`. Essa função chama `customMove()` sem restringir a notificação (`stages.ts:108`), e a mensagem configurada para a etapa é enviada ao cliente.
   
   **Correção sugerida:** propagar `notifyCustomer` pela decisão até `customMove()`, como já acontece na mudança manual de etapa. A execução inicial e a retomada precisam aplicar a mesma autorização.

6. **`src/modules/os/store.ts:336` — Mensagens válidas na configuração podem exceder o limite de envio depois da expansão dos marcadores.**
   
   **Gravidade: média.** Um campo público `descricao`, com limite de 2.000 caracteres, contém 2.000 caracteres ASCII; a mensagem da etapa é `{campo_descricao}{campo_descricao}`. Ambos passam pela validação, mas a expansão produz 4.000 caracteres. `ctx.sendMessage()` aceita no máximo 3.800 (`src/modules/api.ts:758`). Na mudança de etapa, a ordem e o histórico já foram confirmados antes desse erro (`stages.ts:48`), deixando a operação gravada, a resposta com erro e o cliente sem aviso. O mesmo problema em retirada interrompe `runDue()` antes dos demais lembretes.
   
   **Correção sugerida:** verificar o limite do conteúdo expandido e definir uma composição compatível com o transporte, mantendo no máximo uma mensagem de etapa. Não deixar uma falha previsível de tamanho ocorrer somente depois da confirmação da mutação.

7. **`src/modules/os/forms.ts:25` — Campos de escolha com uma opção ou mais de vinte escondem as opções que o cliente precisa informar.**
   
   **Gravidade: média.** Um campo obrigatório tem uma única opção `{id: "retirada_loja", label: "Retirada na loja"}` e ajuda vazia. O formulário apresenta uma caixa de texto com “Informe o ID da opção”, mas não apresenta o ID nem o rótulo. Digitar o rótulo é rejeitado pela validação; o cliente precisa conhecer uma informação que não aparece no formulário. O problema também ocorre com 21 a 32 opções.
   
   **Correção sugerida:** oferecer seleção para todo o intervalo permitido pelo contrato. Se mantiver entrada textual, apresentar integralmente os IDs aceitos e seus rótulos.

8. **`src/modules/os/forms.ts:26` — O formulário impõe 300 caracteres a campos de texto cujo tipo permite até 2.000.**
   
   **Gravidade: média.** Um campo público tem `multiline: false` e `max_length: 500`. Uma resposta de 301 caracteres é válida para o motor, mas o formulário não transporta `max_length`; `validateAnswers()` aplica o limite fixo de 300 para texto de uma linha (`src/web-steps.ts:280`) e recusa a abertura antes da validação específica do tipo.
   
   **Correção sugerida:** transportar o limite declarado para a renderização e validação do passo web, preservando os limites legados quando essa propriedade estiver ausente.

## Partes sem achados confirmados

- **Numeração e migração:** nada encontrado na reserva conjunta dos contadores, ordem e histórico, na inicialização da sequência histórica ou na migração aditiva. Lidos `store.ts`, `work-types.ts`, `0100_os_work_types.sql`, `0035_os_orders.sql` e `db.ts`.
- **Linhas antigas, `counts`, cursor e definições imutáveis:** nada encontrado. A leitura mantém os valores de reserva das linhas antigas, a contagem global esparsa, o cursor pelo número global e a definição fixada das ordens personalizadas. Lidos `store.ts`, `work-types.ts`, `public.ts` e os testes de compatibilidade.
- **Validação estrutural:** nada encontrado quanto a estados de base inválidos, IDs repetidos, destinos inexistentes, etapas inalcançáveis, terminais com saídas ou ausência de caminhos de entrega e cancelamento. Lidos `validation.ts`, `contracts.ts` e `tests/os-work-types.test.ts`.
- **Isolamento e sigilo:** nada encontrado nos filtros de área das consultas novas do motor, nas projeções de campos sensíveis, nos marcadores públicos e na conferência de titular das respostas examinadas. Lidos `public.ts`, `privacy.ts`, `store.ts`, `mutations.ts`, `motor-routes.ts`, `forms.ts` e `stage-replies.ts`.
- **Regras legadas de orçamento, garantia e prazos de lembrete:** nada encontrado além dos caminhos identificados acima. Comparados `store.ts`, `os.ts` e `reminders.ts` com `_antes/`; lidos `model.ts`, `tests/os-orders.test.ts` e `tests/os-whatsapp.test.ts`.
- **Auxiliares de extensões:** nada encontrado em `contracts.ts`, `extensions.ts` e `extension-runtime.ts`. Ausência de registros centrais não foi considerada achado.

## Suspeitas não confirmadas

A equivalência textual de `model.ts` com `0b280f7` não pôde ser confirmada: `_antes/src/modules/os/model.ts` não existe nesta cópia. As regras atuais foram confrontadas com o contrato e os testes antigos, sem identificar uma divergência específica nesse arquivo.

## Afastamentos do contrato

- As ações anunciadas para o embutido deixam de funcionar pelo novo detalhe: achado 2.
- A separação entre aprovação de etapa e decisão de orçamento falha no despacho textual: achados 1 e 4.
- A repetição HTTP não recupera os efeitos pendentes de uma mutação confirmada, contrariando a recuperação exigida na seção 4: achado 3.
- A autorização de mensagem não é preservada na decisão de etapa, e mensagens configuradas podem falhar após a gravação: achados 5 e 6.
- O formulário altera a interação dos campos de escolha e aceita um conjunto menor de textos que a definição do tipo: achados 7 e 8.

Arquivos lidos inteiros: `docs/areas/CONTRATO-MOTOR.md`; `docs/areas/F0-ENTREGA.md`; `docs/areas/relatos/motor-m.md`; `src/modules/os/model.ts`; `src/modules/os/store.ts`; `src/modules/os/os.ts`; `src/modules/os/reminders.ts`; `src/modules/os/work-types.ts`; `src/modules/os/validation.ts`; `src/modules/os/privacy.ts`; `src/modules/os/public.ts`; `src/modules/os/contracts.ts`; `src/modules/os/forms.ts`; `src/modules/os/motor-routes.ts`; `src/modules/os/mutations.ts`; `src/modules/os/stage-replies.ts`; `src/modules/os/stages.ts`; `src/modules/os/extensions.ts`; `src/modules/os/extension-runtime.ts`; `migrations/0100_os_work_types.sql`; `migrations/0035_os_orders.sql`; `_antes/src/modules/os/store.ts`, `_antes/src/modules/os/os.ts` e `_antes/src/modules/os/reminders.ts` por comparação integral com os atuais; `tests/os-orders.test.ts`; `tests/os-whatsapp.test.ts`; `tests/os-work-types.test.ts`; `tests/os-compatibility.test.ts`; `src/db.ts`; `src/command-context.ts`; `web/modules/os/ConversationWorkOrders.tsx`.