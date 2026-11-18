Criados somente:

- [advogados.ts](/Volumes/Dev/wabotia/codex/motor-modelo-juridico/src/area-templates/models/advogados.ts): modelo do profissional sozinho.
- [escritorio-advocacia.ts](/Volumes/Dev/wabotia/codex/motor-modelo-juridico/src/area-templates/models/escritorio-advocacia.ts): modelo do escritório.
- [area-template-juridico.test.ts](/Volumes/Dev/wabotia/codex/motor-modelo-juridico/tests/area-template-juridico.test.ts): 17 casos sobre limites, IDs, grafos, orçamento, privacidade e referências.

`npx tsc --noEmit`, compilação isolada do teste, guardas de codificação/conflitos e conferência de whitespace passaram. Arquivos em UTF-8, sem BOM, com LF. Vitest não executado; fica para o script externo.

Nenhum campo ou etapa foi cortado. Nenhum afastamento do contrato. Adaptações ao levantamento:

- `sigilo` ficou opcional, conforme a regra para campos sensíveis.
- `{numero}` virou `{identificador}` nas mensagens; orçamento usa política própria, sem mensagens de etapa duplicadas.
- Menus ficaram planos; formulário, agenda e mensalidades usam encaminhamento humano até configuração manual.
- Tarefas automáticas, distribuição, horas, regras de acesso, configurações dos módulos e condições de encerramento ficaram em `manual_steps`.
- Avisos por etapa ficaram desligados; o contrato oferece apenas prazo por tipo. Bot permanece como sugestão, sem ativação ou concessões.

Ficaram fora a extensão Jurídico, migrações e registros centrais. Sem dúvidas bloqueantes; integração e execução do Vitest permanecem pendentes.

O integrador deve acrescentar em `src/area-templates/index.ts`:

```ts
import { advogadosTemplate } from "./models/advogados";
import { escritorioAdvocaciaTemplate } from "./models/escritorio-advocacia";
```

E, na lista existente do catálogo:

```ts
advogadosTemplate,
escritorioAdvocaciaTemplate,
```