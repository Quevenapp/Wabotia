Implementado somente nos arquivos da tarefa A:

- `src/area-templates/validation.ts`: validação estrita do manifesto, seleção e sugestões.
- `src/area-templates/engine.ts`: prévia, hash, aplicação atômica pelo F0, preservação, reaplicação e exportação/importação JSON.
- `src/area-templates/index.ts`: catálogo, descritor das rotas e registro reservado.
- `src/area-templates/models/assistencia-tecnica.ts`: um modelo, com embutido preservado e quatro tipos opcionais.
- `migrations/0105_os_area_templates.sql`: DDL exato do contrato.
- `tests/os-area-templates.test.ts`: testes novos de validação, atomicidade, concorrência, preservação e acesso.

**Verificação:** `npx tsc --noEmit`, guarda de codificação e guarda de conflitos aprovados. DDL conferido. Vitest e Wrangler não executados.

O integrador precisa acrescentar em `src/modules/runtime.ts`:

```ts
import { onSettingsSave, registerAdminExtension } from "./api";
import { areaTemplatesExtension, validateAreaSetup } from "../area-templates";

onSettingsSave("os", "os_area_setup", validateAreaSetup);
registerAdminExtension(areaTemplatesExtension);
```

**Adaptações:** o rascunho usa agora IDs normativos, `service_order` e menus planos. Recursos não representáveis — tarefas automáticas, configurações opcionais e conferências específicas — viraram passos manuais; paralisação dos tipos adicionais ficou em sete dias. `message` é convertido para `content`, conforme F0. Também são recusados downgrade e alteração de manifesto sem incrementar sua versão.

Ficaram fora os registros centrais, os outros seis modelos e a execução externa do Vitest. Nenhum arquivo existente foi alterado. Sem dúvidas bloqueantes.