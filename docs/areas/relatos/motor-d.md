Implementei **11 arquivos novos**, somente no escopo D. Nenhum arquivo existente foi alterado.

| Arquivo | Mudança |
|---|---|
| `documents/model.ts` | Validação, MIME, limites e metadados. |
| `documents/access.ts` | Isolamento e autorização privada. |
| `documents/store.ts` | Reserva, paginação e arquivamento. |
| `documents/transport.ts` | Upload, hash, repetição, recuperação, confirmação e download. |
| `documents/delivery.ts` | Recebimento e envio pelo WhatsApp. |
| `documents/cleanup.ts` | Limpeza de pendências e órfãos. |
| `documents/extension.ts` | Descritor exportado, sem registro central. |
| `0103_os_documents.sql` | DDL idêntico ao contrato. |
| `os-documents.test.ts` | Fluxos, falhas, concorrência e compatibilidade. |
| `os-document-privacy.test.ts` | Bloqueio de sensíveis nos caminhos comuns e de IA. |
| [INTEGRACAO.md](/Volumes/Dev/wabotia/codex/motor-d/src/modules/os/documents/INTEGRACAO.md) | Registros, decisões e dependências. |

**Verificações:** `npx tsc --noEmit` aprovado; tipagem dos testes aprovada com configuração temporária removida; guardas de conflitos e codificação aprovadas. Os novos arquivos têm UTF-8 sem BOM e LF. Vitest e Wrangler não foram executados.

O integrador precisa acrescentar em `src/modules/os/extensions.ts`:

```ts
import { documentsExtension } from "./documents/extension";

// Na lista osExtensions:
documentsExtension,
```

Em `src/modules/os/definition.ts`:

```ts
// Em events:
"os.document_reserved",
"os.document_ready",
"os.document_archived",

// Em bot.deny:
"service-orders/:id/private-documents",
```

**Complementos ao contrato:** coleção adicional `private-documents`, lista explícita de MIME, cursor de limpeza no R2 e recuperação de transporte sem recibo técnico concluído, com confirmação posterior em `/complete`. Nenhuma assinatura foi alterada.

**Ficaram para M/I:** integração central, grant `os:sensitive`, validação com `commitChild` real e orçamento completo D1. Os testes usam mocks locais explícitos desses pontos de M. A execução Vitest fica para o script externo. A lista de MIME é a decisão ainda a confirmar.