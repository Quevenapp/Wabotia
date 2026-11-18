Implementei a tarefa M, com registros centrais pendentes para o integrador.

Arquivos alterados/criados:

- `validation.ts`, `work-types.ts`: validação, revisões, aposentadoria, definições fixadas e tipo embutido.
- `store.ts`, `mutations.ts`: numeração, campos extras, concorrência, histórico e recuperação de publicação.
- `public.ts`, `privacy.ts`: autorização e projeções para equipe, cliente e bot; removidos os `not_implemented`.
- `os.ts`, `motor-routes.ts`: configurações, catálogo, filtros e rotas novas.
- `stages.ts`, `stage-replies.ts`: transições, aprovações e respostas pelo WhatsApp.
- `forms.ts`: abertura com definição fixada e validação antes da conclusão.
- `reminders.ts`: prazos por tipo e marcação após publicação/envio.
- `0100_os_work_types.sql`: migração aditiva.
- `os-work-types.test.ts`, `os-compatibility.test.ts`: 19 testes novos.

Verificação: `npx tsc --noEmit`, checagem estática dos testes, `git diff --check` e UTF-8/LF **aprovados**. Não executei Vitest ou Wrangler; a aprovação funcional, inclusive dos testes antigos intactos, depende do script externo.

O integrador deve acrescentar em `src/modules/os/definition.ts`, dentro de `events`:

```ts
"os.updated",
"os.stage_changed",
"os.quote_saved",
"os.stage_approval_requested",
"os.stage_approval_decided",
"os.private_fields_changed",
```

E dentro de `grants`:

```ts
{
  id: "sensitive",
  label: "Dados sensíveis",
  description: "Permite acesso humano explícito aos dados sensíveis do motor.",
},
```

Desvios do contrato:

- A definição do formulário fica na tabela auxiliar `os_open_definitions`, adicionada à 0100; `ref_id` contém referência opaca, tipo e revisão, evitando expor definições privadas em eventos.
- Escolhas com uma opção ou mais de 20 usam entrada textual pelo ID, contornando o limite do formulário genérico.

Ficaram fora os registros centrais e a medição integrada de D1. Nenhuma assinatura pública foi alterada; sem dúvidas adicionais.