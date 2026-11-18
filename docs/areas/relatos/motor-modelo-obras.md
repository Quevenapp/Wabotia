Criados somente os quatro arquivos autorizados:

- `engenheiros.ts`: modelos de Projeto e Laudo/vistoria.
- `arquitetos.ts`: modelos de Projeto e Laudo/vistoria.
- `construtoras.ts`: modelos de Obra e Chamado de pós-obra.
- `tests/area-template-obras.test.ts`: valida estados, transições, encerramentos, IDs, referências, privacidade e limites, sem depender do mecanismo de modelos.

Verificações aprovadas: `npx tsc --noEmit`, checagem TypeScript específica do teste e conferência estática dos grafos, tamanhos e UTF-8 sem BOM/LF. Vitest e Wrangler não foram executados.

Nenhum campo ou etapa original precisou ser cortado por tamanho. Sem desvio do contrato; adaptações do levantamento:

- Campos sensíveis ficaram opcionais; `data_entrega` ficou interna por não existir configuração de campo público somente para leitura.
- Acrescentada revisão de proposta em cinco tipos; pós-obra reutiliza `analise`. Operações protegidas ficam na política de orçamento.
- Aprovações de etapa usam validade de 168 horas e apenas marcadores permitidos.
- Garantia automática, retirada e paralisação automática ficaram desligadas.
- Submenus foram achatados; menus de Agenda/Formulários encaminham ao atendimento até configuração manual.
- Tarefas automáticas, recorrência, condições técnicas de transição, versões documentais, medições estruturadas e opcionais do ERP ficaram como orientações manuais.
- Áreas usam duas casas decimais; dinheiro usa centavos inteiros.

Compra por obra, migrações, registros centrais e alterações do embutido ficaram fora. Nenhuma dúvida bloqueante.

O integrador deve acrescentar em `src/area-templates/index.ts`:

```ts
import { engenheirosTemplate } from "./models/engenheiros";
import { arquitetosTemplate } from "./models/arquitetos";
import { construtorasTemplate } from "./models/construtoras";
```

Na lista existente do catálogo:

```ts
engenheirosTemplate,
arquitetosTemplate,
construtorasTemplate,
```

Verificação externa pendente:

```sh
npx vitest run tests/area-template-obras.test.ts
```