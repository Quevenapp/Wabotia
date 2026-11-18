Criei somente os três arquivos autorizados:

- [escolas.ts](/Volumes/Dev/wabotia/codex/motor-modelo-ensino/src/area-templates/models/escolas.ts): modelos de Matrícula e Solicitação.
- [professores.ts](/Volumes/Dev/wabotia/codex/motor-modelo-ensino/src/area-templates/models/professores.ts): acompanhamento de alunos e pacotes.
- [area-template-ensino.test.ts](/Volumes/Dev/wabotia/codex/motor-modelo-ensino/tests/area-template-ensino.test.ts): 11 testes de grafos, estados, referências, IDs, limites e privacidade.

Nenhum campo ou etapa foi cortado. Adaptações do levantamento ao contrato:

- Todos os extras ficaram sensíveis, opcionais e internos; o assunto público passou a exigir título administrativo genérico.
- Acrescentei cancelamento após ativação, garantindo saída de todas as etapas abertas.
- Menus ficaram planos, com encaminhamento humano onde o formato não admite Agenda/Mensalidade.
- Tarefas automáticas, prazos por etapa, configurações financeiras, assinatura e classificações de registros filhos ficaram como orientações manuais. Paralisação automática ficou desligada.
- IDs dos modelos foram normalizados; módulos e papéis não suportados foram omitidos.

**Verificações:** `npx tsc --noEmit`, compilação isolada do teste e `node scripts/check-conflict-markers.mjs` passaram. Arquivos conferidos em UTF-8, sem BOM, com LF. Vitest e Wrangler não foram executados.

**Integração em `src/area-templates/index.ts`:** acrescentar os imports:

```ts
import { escolasTemplate } from "./models/escolas";
import { professoresTemplate } from "./models/professores";
```

E estas entradas na lista existente do catálogo:

```ts
escolasTemplate,
professoresTemplate,
```

Ficaram fora Ensino, migrações, mecanismo de modelos e registro central. Nenhuma alteração no embutido ou desvio do contrato congelado. Sem dúvidas bloqueantes; a forma exata da lista do catálogo depende da entrega A.