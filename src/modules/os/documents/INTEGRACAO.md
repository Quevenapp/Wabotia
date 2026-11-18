# Tarefa D — documentos

Nenhum arquivo central foi alterado. O descritor `documentsExtension` é a única entrada de registro. Importá-lo não registra ganchos.

## Linhas para I

Em `src/modules/os/extensions.ts`, no bloco reservado, acrescentar:

```ts
import { documentsExtension } from "./documents/extension";
```

Na lista `osExtensions`, acrescentar:

```ts
documentsExtension,
```

Em `src/modules/os/definition.ts`, na lista `events`, acrescentar:

```ts
"os.document_reserved",
"os.document_ready",
"os.document_archived",
```

Na lista `bot.deny`, acrescentar:

```ts
"service-orders/:id/private-documents",
```

Os prefixos `"os.private"` e `"os.document.upload"` já estão em `bot.deny`; preservá-los. O papel explícito `os:sensitive` continua pertencendo a M/I. O runtime de F0 já registra leituras, escritas, ferramentas, binários, manutenção e turnos dos descritores; não acrescentar outro agendador. A rota GET de documentos por conversa já consta na lista de credenciais limitadas em `src/index.ts`.

## Contrato e escolhas locais

- `0103_os_documents.sql` reproduz exatamente o bloco DDL do contrato. Sua FK depende do índice composto de `0100`, de M. Os testes criam um índice equivalente apenas no banco de teste, enquanto M está ausente.
- As rotas normativas comuns permanecem em `service-orders/:id/documents`. Dados sensíveis usam a coleção adicional `service-orders/:id/private-documents`, com as mesmas operações de reserva, conteúdo, confirmação e arquivamento, mas sem envio. Até uma pessoa com o papel precisa usar essa rota. Operações privadas começam por `os.private.document`. A rota comum omite sensíveis e responde 404 no download deles; `/send` responde 403 `document_not_shareable`.
- O contrato não enumerava MIME permitidos. A lista explícita fica em `model.ts`: PDF, JPEG, PNG, WebP, texto simples, DOC, XLS, DOCX, XLSX e PPTX. Não há inspeção antivírus nem conversão. O download força anexo, `no-store`, `nosniff` e CSP restritiva.
- `features.documents` e a classificação da linha controlam a permissão. O DTO congelado não tem política adicional por MIME, tipo ou destinatário; nenhuma assinatura foi alterada.
- O transporte conserva a versão da reserva; `/complete` a incrementa. Concessões e confirmações técnicas usam comandos do Coordinator e CAS, sem publicar histórico de conteúdo. Reserva, confirmação de negócio e arquivamento usam `commitChild` com nomes de campos e códigos de evento.
- O recibo de F0 pode ficar sem resposta após interrupção. O adaptador recupera somente a tentativa persistida para a mesma área, ator, documento e chave. Se o objeto existe mas o registro técnico falhou, retorna o hash verificado; `/complete` relê o R2 e confirma tamanho/hash/estado no mesmo `ChildMutation`. Não escreve D1 no Worker nem depende de alterar o recibo central.
- Os objetos ficam em `os-documents/<área>/staff|sensitive/<ordem>/<documento>/<tentativa>`, nunca em `media`. PUT condicional impede sobrescrita. A manutenção aborta reservas expiradas e varre órfãos, com margem de 24 horas e cinco minutos para objetos de tentativas perdidas. Seu cursor fica em `os-document-maintenance/<área>/cursor`, no R2 existente. Documentos confirmados, mesmo arquivados, não são eliminados.
- A ferramenta `os_documentos` só lista metadados públicos pela conversa autenticada. A entrada de WhatsApp exige `DOCUMENTO <número_global>` e anexo resolvido pelo adaptador da mesma mensagem. A área só com o embutido preserva o tratamento anterior de anexos.

Esses detalhes completam pontos não especificados no contrato (nome da coleção privada, MIME, cursor de limpeza e recuperação do recibo F0). Não há alteração de assinatura, tabela extra, nova classe de Durable Object ou recurso Cloudflare.

## Verificação e limites

Os testes próprios são `tests/os-documents.test.ts` e `tests/os-document-privacy.test.ts`. Usam a fixture comum intacta, autorização real do embutido e substituições locais explícitas para o tipo personalizado e `commitChild`. O SQL da filha executa no D1 da fixture. A cobertura com o `commitChild` real, a publicação recuperável de M e o orçamento da invocação completa dependem de M/I.

O código e os testes passaram pela verificação TypeScript local. A configuração temporária usada para incluir os testes foi removida. Vitest e Wrangler não foram executados; o script externo deve rodar:

```sh
npx vitest run tests/os-documents.test.ts tests/os-document-privacy.test.ts
```

A lista de MIME é a decisão de produto ainda a confirmar; outros formatos podem ser acrescentados nesta filha quando definidos.
