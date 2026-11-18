Criei somente os seis arquivos da tarefa L:

- `entries/model.ts`: validação e cursores.
- `entries/store.ts`: criação, correção preservando original, arquivamento, versões, paginação, somas e privacidade.
- `entries/extension.ts`: descritor sem registro automático.
- [entries/README.md](/Volumes/Dev/wabotia/codex/motor-l/src/modules/os/entries/README.md): integração e limitações.
- `migrations/0104_os_entries.sql`: DDL idêntico ao contrato.
- `tests/os-entries.test.ts`: testes com fixture comum intacta e mocks explícitos de M.

**Verificação:** `npx tsc --noEmit`, TypeScript isolado do teste e verificação de conflitos passaram. Vitest e Wrangler não foram executados. Nenhuma ligação financeira foi criada.

O integrador precisa acrescentar em `src/modules/os/extensions.ts`:

```ts
import { entriesExtension } from "./entries/extension";
```

E, dentro de `osExtensions`:

```ts
entriesExtension,
```

Em `src/modules/os/definition.ts`, dentro de `events`:

```ts
"os.entry.created",
"os.entry.revised",
"os.entry.archived",
```

E dentro de `bot.deny`:

```ts
"os.entry.",
```

Pendências e complementos ao contrato:

- **Valor monetário e catálogo de tipos de lançamento:** ausentes nos DTOs/DDL congelados. Não os inventei; `kind` permanece texto livre. Dependem de definição coordenada.
- Acrescentei `GET service-orders/:id/entries/summary`, agrupado por tipo e unidade, com soma textual exata.
- Datas usam milissegundos Unix não negativos; correções não reduzem sigilo.
- As operações de escrita ficam integralmente fora do catálogo do bot por também aceitarem dados sensíveis.

Ficam pendentes o Vitest externo e a integração real de atomicidade, histórico e recuperação durável com `commitChild` de M.