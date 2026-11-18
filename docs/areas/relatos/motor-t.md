Criei somente arquivos da tarefa T:

- `tasks/model.ts`: validação e projeções de privacidade.
- `tasks/store.ts`: CRUD, versões, paginação e `my-tasks`.
- `tasks/reminders.ts`: lembretes idempotentes, limite de itens e contagem efetiva de SQL.
- `tasks/stages.ts`: criação recuperável de tarefas padrão por entrada de etapa.
- `tasks/extension.ts`: descritor, rotas e ferramenta `os_tarefas`.
- `migrations/0101_os_tasks.sql`: DDL exatamente igual ao contrato.
- `tests/os-tasks.test.ts`: cobertura com fixture comum e mocks locais explícitos de M.

Verificações: `npx tsc --noEmit` aprovado; checagem sintática do teste com `tsc --noCheck` aprovada; comparação do DDL sem diferenças. Sem marcadores de conflito, BOM ou CR encontrados. **Vitest não foi executado.**

O integrador precisa acrescentar em `src/modules/os/extensions.ts`:
```ts
import { tasksExtension } from "./tasks/extension";
```
E, dentro de `osExtensions`:
```ts
tasksExtension,
```

Em `src/modules/os/definition.ts`, dentro de `events`:
```ts
"os.task.created",
"os.task.updated",
"os.task.archived",
"os.task.due",
```
Dentro de `bot.deny`:
```ts
"service-orders/:id/private-tasks",
```
O prefixo `os.private` já cobre os comandos privados.

Complementos ao contrato: defini `my-tasks`, escritas `private-tasks`, proibição de reduzir sigilo e aviso único por prazo/destinatário. Responsável removido gera evento para a equipe sem destinatário individual.

**Pendência de integração:** F0 não define configuração nem gancho de tarefas padrão. M precisa definir sua persistência e chamar `createStageTasks` após confirmar ou recuperar a entrada na etapa. Portanto, essa criação ainda não dispara automaticamente. `commitChild`, integração completa e execução dos testes permanecem dependentes de M/I e do script externo.