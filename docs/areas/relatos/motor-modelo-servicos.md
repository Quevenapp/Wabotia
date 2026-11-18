Criados somente os cinco arquivos autorizados:

- `servicos.ts`: modelo Serviços.
- `oficina-mecanica.ts`: modelo Oficina mecânica.
- `lavanderia-costura.ts`: modelo Lavanderia e costura.
- `exemplos.ts`: Gráfica, Despachante e Imobiliária.
- `tests/area-template-servicos.test.ts`: estados, referências, IDs, limites, privacidade, orçamento e caminhos de encerramento/cancelamento.

Verificação: `npx tsc --noEmit` e compilação isolada do teste **aprovados**. Guarda de conflitos aprovada; arquivos UTF-8, sem BOM ou CR. Vitest não executado, conforme solicitado; sua execução fica para o script externo.

O contrato permaneceu intacto. Adaptações do levantamento:

- Acrescentadas etapas `analyzing` para revisão de orçamento. Agendamento e preparação/revisão de arte usam `in_progress`; `approved` fica reservado ao orçamento.
- Serviços ganhou aprovação separada para preço fixo/contrato. Gráfica ganhou referência da versão da arte; retrabalho exige novo aceite. Aprovações valem 168 horas.
- Dinheiro usa centavos inteiros; CPF/CNPJ usa texto com conferência humana. Mensagens usam `{identificador}`; notificações de decisão ficam com o protocolo de orçamento.
- Tarefas automáticas, catálogos, vínculos com Agenda/contratos e regras condicionais viraram passos manuais. Menus não suportados foram substituídos por orientação ou encaminhamento.
- Paralisação é por tipo: 3 dias em Oficina/Lavanderia/Gráfica, 7 no Despachante, desligada em Serviços/Imobiliária.
- Papéis e operações permitidas do bot ficam para configuração manual.

Limitações pendentes: aprovação de arte não vincula automaticamente uma versão de arquivo; garantia da Oficina também incide na entrega sem reparo; documentos sensíveis não podem usar o envio comum ao cliente. Esses pontos estão explicitados nos passos manuais.

Sem alterações no embutido, mecanismo de modelos, migrações ou registros centrais.

O integrador deve acrescentar em `src/area-templates/index.ts`:

```ts
import { servicosTemplate } from "./models/servicos";
import { oficinaMecanicaTemplate } from "./models/oficina-mecanica";
import { lavanderiaCosturaTemplate } from "./models/lavanderia-costura";
import {
  graficaTemplate,
  despachanteTemplate,
  imobiliariaTemplate,
} from "./models/exemplos";
```

E incluir no catálogo existente:

```ts
servicosTemplate,
oficinaMecanicaTemplate,
lavanderiaCosturaTemplate,
graficaTemplate,
despachanteTemplate,
imobiliariaTemplate,
```