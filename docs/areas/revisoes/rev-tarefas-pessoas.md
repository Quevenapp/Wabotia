1. **Grave — `src/modules/os/tasks/reminders.ts:96`: o lembrete usa uma cópia antiga da tarefa e só confere sua versão depois de enfileirar a mensagem.**

   **Cenário:** o agendador seleciona uma tarefa pública; durante uma espera assíncrona, um comando a transforma em sensível, com `client_visible=false` e `audience='staff'`; a rodada continua usando a linha anterior e envia seu título ao cliente. Concluir, cancelar ou arquivar nesse intervalo também não impede o aviso. O `UPDATE` condicionado das linhas 106–109 apenas falha depois do envio. O alarme em `src/coordinator.ts:623` não compartilha um bloqueio de toda essa operação com os comandos.

   **Correção:** serializar a revalidação e o enfileiramento com as mutações da tarefa, ou fazer a inclusão durável na fila depender atomicamente de área, pai, versão, estado e classificação atuais. Conferir a versão somente depois do enfileiramento não protege o conteúdo.

2. **Média — `src/modules/os/tasks/reminders.ts:76`: tarefas impossíveis de notificar podem bloquear indefinidamente todos os lembretes seguintes.**

   **Cenário:** existem dez tarefas vencidas destinadas ao cliente, em ordens sem conversa, seguidas de uma tarefa notificável. A consulta sempre começa pelas mesmas dez; a linha 92 as ignora sem alterar sua elegibilidade, e `rows.slice(0, limit)` nunca alcança a décima primeira. Todas as rodadas repetem esse resultado. A criação permite esse estado: `ctx.mayNotify(actor, null)` retorna verdadeiro.

   **Correção:** permitir avanço entre candidatos, mantendo tentativas futuras para os impedidos mediante adiamento ou estado de tentativa. Preservar os limites de itens e SQL, sem marcar como enviado aquilo que não entrou na fila.

3. **Média — `src/modules/os/tasks/store.ts:94` e `src/modules/os/tasks/reminders.ts:89`: trocar o responsável interno repete o lembrete ao mesmo cliente, sem mudança de prazo.**

   **Cenário:** uma tarefa com `audience='customer'` já foi notificada; a equipe altera apenas `assignee`. A edição limpa `notified_at`, e a chave de deduplicação muda porque inclui o responsável interno. A rodada seguinte envia novamente o mesmo vencimento à mesma conversa.

   **Correção:** calcular o destinatário efetivo conforme a audiência. Para avisos ao cliente, alterações de responsável interno não devem reiniciar o aviso nem mudar sua chave.

4. **Média — `src/modules/os/tasks/reminders.ts:96`: o vencimento da mensagem é apresentado em UTC, sem conversão para Brasília.**

   **Cenário:** um prazo de 18/11/2026 às 22h30 em Brasília aparece como `2026-11-19T01:30:00.000Z`. O cliente recebe outro horário e outra data no texto do lembrete.

   **Correção:** manter o instante armazenado e formatar a mensagem em português, com fuso explícito `America/Sao_Paulo`. Cobrir também vencimentos próximos da meia-noite.

5. **Média — `src/modules/os/tasks/stages.ts:47`: modelos de outras etapas podem impedir a criação das tarefas da etapa atual.**

   **Cenário:** a entrada em `execucao` tem um modelo público válido e a lista contém também um modelo sensível de `revisao`. Um operador sem `os:sensitive` recebe erro antes de criar a tarefa pública, porque a autorização é conferida antes do filtro `template.stage === entry.stage`, na linha 51. Um responsável removido em modelo de outra etapa provoca bloqueio semelhante.

   **Correção:** selecionar os modelos da etapa atual antes das verificações operacionais de sigilo, responsável e destinatário. Validar a estrutura da configuração separadamente.

6. **Média — `tests/os-tasks.test.ts:97`: o teste ainda exige o erro do antigo esqueleto F0, incompatível com a implementação atual de M.**

   **Cenário:** a chamada real a `commitChild`, com `statements: []`, chega a `commitChildMutation` e lança `409 version_conflict` em `src/modules/os/mutations.ts:44`; a asserção exige `501 not_implemented`. Essa incompatibilidade é demonstrável pela leitura, independentemente do registro dos descritores.

   **Correção:** substituir a expectativa obsoleta pelo comportamento atual. Acrescentar um caso com mutação válida usando a implementação real, verificando filho, histórico, atividade do pai e repetição idempotente.

7. **Leve — `tests/os-people.test.ts:116`: o teste de ausência de escrita parcial substitui justamente a persistência que deveria verificar por uma rejeição imediata.**

   **Cenário:** mesmo que o `commitChild` real grave parcialmente antes de falhar, esse teste continua aprovando: ele instala um mock que lança `501` sem executar qualquer SQL e depois confere que a tabela está vazia.

   **Correção:** provocar uma falha dentro da transação real, após a instrução principal, e conferir a reversão do filho, do histórico e da atividade do pai. Manter o mock apenas como teste de propagação de erro.

## Partes sem achados confirmados

- **Pessoas ligadas, código de produção: nada encontrado** em isolamento por área/pai, validação do contato, controle de versão, arquivamento, paginação e projeção de telefone/notas para bot. Foram lidos todos os arquivos de `people/` e as funções compartilhadas de autorização, projeção e confirmação. O vínculo não é usado para conceder titularidade; documento não integra o DTO e é rejeitado na entrada.
- **DDL: nada encontrado.** As migrações `0101` e `0102` correspondem aos blocos da seção 4, são aditivas e usam chave estrangeira composta por área e ordem.
- **CRUD e listagem de tarefas: nada encontrado** em acesso entre áreas, associação a pai de outra área ou duas conclusões confirmadas com a mesma versão. “Meus prazos” filtra área e responsável autenticado. A paginação por `created,id`, sem alterações concorrentes, mantém os desempates.
- **Embutido: nada encontrado nos caminhos revisados.** As extensões recusam recursos desligados. Nenhuma ausência de registro central foi considerada achado.

Revisão exclusivamente estática, sem rede, escrita de arquivos ou execução de testes.

## Suspeitas não confirmadas

- **Reentrada de etapa — `src/modules/os/tasks/stages.ts:52`:** a chave inclui a versão da entrada, portanto reentrar na mesma etapa cria outro conjunto de tarefas, mesmo havendo tarefas anteriores abertas. O teste em `tests/os-tasks.test.ts:354` exige esse comportamento. Faltou uma regra normativa que determine se os modelos devem gerar tarefas uma vez por ordem ou uma vez por entrada; não classifiquei essa escolha como defeito confirmado.
- **Orçamento do alarme completo:** o teste em `tests/os-tasks.test.ts:333` mede somente `runTaskDue`. Ele não demonstra o teto de 800 instruções do alarme completo exigido pela seção 10. Não confirmei estouro; falta conferir a composição e a cobertura de carga da tarefa I.

## Afastamentos do contrato

- **Seção 5, criação e edição de tarefas:** os corpos documentados admitem `sensitive`, mas as operações comuns recusam tarefas sensíveis e exigem as rotas adicionais `private-tasks` (`src/modules/os/tasks/store.ts:34` e `:68`). A separação atende à orientação de privacidade da seção 6, porém altera o contrato de chamada e precisa ser refletida na especificação e nos consumidores.
- **Seção 6, proteção de mensagens:** a corrida do achado 1 permite enfileirar conteúdo após sua classificação como sensível.
- **Entrega F0, processamento do trabalho restante:** devolver `has_more=true` sem permitir avanço sobre candidatos impedidos produz reagendamento sem progresso, conforme o achado 2.

**Arquivos lidos inteiros:** `src/modules/os/tasks/extension.ts`; `src/modules/os/tasks/model.ts`; `src/modules/os/tasks/reminders.ts`; `src/modules/os/tasks/stages.ts`; `src/modules/os/tasks/store.ts`; `src/modules/os/people/extension.ts`; `src/modules/os/people/model.ts`; `src/modules/os/people/privacy.ts`; `src/modules/os/people/store.ts`; `migrations/0101_os_tasks.sql`; `migrations/0102_os_people.sql`; `tests/os-tasks.test.ts`; `tests/os-people.test.ts`; `tests/os-motor-fixture.ts`; `src/modules/os/public.ts`; `src/modules/os/privacy.ts`; `src/modules/os/mutations.ts`; `src/modules/os/extensions.ts`; `src/modules/os/extension-runtime.ts`; `src/modules/schedule.ts`; `src/db.ts`; `src/events.ts`; `docs/areas/F0-ENTREGA.md`; `docs/areas/relatos/motor-t.md`; `docs/areas/relatos/motor-p.md`; `_antes/src/modules/os/reminders.ts`.