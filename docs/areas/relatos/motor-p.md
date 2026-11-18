Criei somente os seis arquivos da tarefa P:

- `people/model.ts`: validação e normalização.
- `people/privacy.ts`: DTO explícito e projeções de privacidade.
- `people/store.ts`: cadastro, edição, arquivamento, paginação, versões e limite de 200 pessoas.
- `people/extension.ts`: descritor exportado, sem registro.
- `migrations/0102_os_people.sql`: DDL exato do contrato.
- `tests/os-people.test.ts`: 14 testes, incluindo vínculo sem concessão de acesso.

Passaram: `npx tsc --noEmit`, checagem TypeScript adicional do teste com bindings temporários já removidos, verificação de conflitos, comparação do DDL e UTF-8/LF. Não executei Vitest nem Wrangler.

Pendências e desvios: o contrato congelado não contém catálogo de papéis nem campo de documento. Mantive papel livre validado, conforme seção 9; documento é rejeitado e omitido da projeção. Persistência completa, histórico e eventos dependem de M; os testes de CRUD usam adaptador local explícito.

O integrador precisa acrescentar em `src/modules/os/extensions.ts`:

```ts
import { peopleExtension } from "./people/extension";
```

E dentro de `osExtensions`:

```ts
peopleExtension,
```

Em `src/modules/os/definition.ts`, dentro de `events`:

```ts
"os.person.created",
"os.person.updated",
"os.person.archived",
```

Dentro de `bot.deny`, acrescentar:

```ts
"os.person.",
```

Verificação externa pendente: `npx vitest run tests/os-people.test.ts`.