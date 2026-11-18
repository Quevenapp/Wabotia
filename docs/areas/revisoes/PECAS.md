# Peças e donos na correção dos achados

| Tarefa | Arquivo de revisão | Arquivos seus |
|---|---|---|
| `corr-motor` | `rev-motor.md` | `src/modules/os/*.ts` fora das subpastas, **menos** `contracts.ts`, `definition.ts`, `extensions.ts` e `extension-runtime.ts`; `migrations/0100_os_work_types.sql` não muda; `tests/os-work-types.test.ts`, `tests/os-compatibility.test.ts` |
| `corr-f0` | `rev-f0.md` | `src/service.ts`, `src/index.ts`, `src/coordinator.ts`, `src/modules/api.ts`, `binary.ts`, `hooks.ts`, `registry.ts`, `runtime.ts`, `types.ts`, `src/modules/os/contracts.ts`, `definition.ts`, `extensions.ts`, `extension-runtime.ts`; `tests/os-foundation.test.ts`, `tests/os-route-registration.test.ts`, `tests/os-integration.test.ts`, `tests/os-d1-budget.test.ts` |
| `corr-tarefas-pessoas` | `rev-tarefas-pessoas.md` | `src/modules/os/tasks/*`, `src/modules/os/people/*`, `tests/os-tasks*.test.ts`, `tests/os-people*.test.ts` |
| `corr-documentos` | `rev-documentos.md` | `src/modules/os/documents/*`, `tests/os-document*.test.ts` |
| `corr-lancamentos-modelos` | `rev-lancamentos-modelos.md` | `src/modules/os/entries/*`, `src/area-templates/*` fora de `models/`, `tests/os-entries*.test.ts`, `tests/os-area-templates*.test.ts` |
| `corr-painel` | `rev-painel.md` | tudo em `web/` e os testes web que este trabalho criou |
| `corr-api-apps` | `rev-api-apps.md` | `src/modules/openapi.ts`, `docs/API.md`, `docs/MODULOS.md`, `docs/ORDEM-DE-SERVICO.md`, `docs/TRABALHOS.md`, `tests/os-openapi-contract.test.ts`, e os testes e fixtures novos em `mobile/android/app/src/test/` e `mobile/ios/WabotiaTests/` |
| `corr-conteudo` | `rev-conteudo.md` | `src/area-templates/models/*`, `tests/area-template-*.test.ts` |

A revisão de segurança (`rev-seguranca.md`) atravessa as peças e é tratada depois, numa tarefa própria, sobre o resultado destas.
