Criei somente os três arquivos autorizados:

- [clinica-medica.ts](/Volumes/Dev/wabotia/codex/motor-modelo-saude/src/area-templates/models/clinica-medica.ts): modelo administrativo médico.
- [clinica-veterinaria.ts](/Volumes/Dev/wabotia/codex/motor-modelo-saude/src/area-templates/models/clinica-veterinaria.ts): atendimento, internação e banho e tosa.
- [area-template-saude.test.ts](/Volumes/Dev/wabotia/codex/motor-modelo-saude/tests/area-template-saude.test.ts): limites, IDs, referências, estados, encerramento, orçamento e ausência de campos clínicos.

`npx tsc --noEmit` e a checagem TypeScript isolada do teste passaram. A conferência de whitespace não apontou problemas. Vitest ficou para o script externo. Sem alterações no embutido, migrações, commit ou rede.

Não houve desvio intencional do contrato nem corte por tamanho. Adaptações da fonte:

- Campos de saúde ficaram sensíveis, opcionais e ocultos; proteção ampliada para origem, acomodação e janela de contato.
- Presença médica confirmada usa `analyzing`.
- Orçamentos veterinários usam política própria, validade inicial de sete dias e etapas de revisão quando necessárias; mensagens duplicadas de orçamento foram retiradas.
- Acrescentado cancelamento administrativo em todas as etapas abertas.
- Internação e banho e tosa começam arquivados; retirada automática da internação e avisos de paralisação ficaram desligados.
- Menus não representáveis encaminham à equipe; configurações de módulos, tarefas padrão, regras condicionais e organização dos registros ficaram como passos manuais.

Prontuário, guardas clínicas e bloqueio técnico de IA permanecem fora desta entrega. O manifesto explicita essas pendências. Nenhuma dúvida bloqueante; falta validar integração e executar `tests/area-template-saude.test.ts`.

Em `src/area-templates/index.ts`, o integrador deve incluir:

```ts
import { clinicaMedicaTemplate } from "./models/clinica-medica";
import { clinicaVeterinariaTemplate } from "./models/clinica-veterinaria";
```

E acrescentar à lista do catálogo:

```ts
clinicaMedicaTemplate,
clinicaVeterinariaTemplate,
```