## Achados

### 1. Documento pode ser enviado ao telefone antigo da ordem

**Arquivo:linha:** `src/modules/os/documents/delivery.ts:38`; autorização em `src/modules/os/public.ts:92`.

**Defeito:** o envio aceita a conversa vinculada à ordem sem exigir que seu telefone verificado corresponda ao telefone atual do cliente.

**Cenário:** uma ordem vinculada à conversa do telefone A tem seu telefone corrigido para B, operação permitida por `src/modules/os/store.ts:494`. Depois, a equipe anexa um documento destinado a B e chama `/send` sem informar conversa. O código seleciona a conversa A; `authorizedOrder` autoriza porque o ID coincide, apesar do telefone divergente; o documento é enviado a A. A mesma autorização também permite consultar os metadados públicos pela conversa antiga.

**Gravidade: grave** — vazamento entre titulares.

**Correção sugerida:** nos caminhos de documentos destinados ao cliente, exigir telefone verificado não vazio e igual ao telefone normalizado da ordem. A coincidência de `conversation_id` não deve dispensar essa conferência. Aplicar a regra também à listagem e ao recebimento pelo WhatsApp.

### 2. Comando de documento interrompe o atendimento mesmo em área somente com o embutido

**Arquivo:linha:** `src/modules/os/documents/delivery.ts:108`.

**Defeito:** a proteção de compatibilidade do embutido só cobre mensagens que não correspondem à expressão `DOCUMENTO <número>`.

**Cenário:** numa área sem tipos personalizados, o cliente envia `DOCUMENTO 999`, sendo 999 inexistente. A expressão é aceita, a verificação de configuração das linhas 88–95 é pulada e o manipulador lança `404`. Se o número pertencer a outra pessoa, a autorização também lança antes de verificar `features.documents`. A exceção interrompe a passagem pelos manipuladores em `src/engine.ts:366`, antes do menu e do bot. Antes, o manipulador de orçamento retornava `false` para esse texto (`_antes/src/modules/os/store.ts:947`), deixando o atendimento seguir.

**Gravidade: grave** — regressão do comportamento embutido.

**Correção sugerida:** verificar a aplicabilidade do recurso antes de assumir o comando ou lançar erros. Em área somente com o embutido, retornar `false` também para números inexistentes ou de terceiros. Quando documentos estiverem disponíveis, tratar entradas inválidas com resposta controlada ao cliente.

### 3. Repetição do upload fica presa à concessão vencida

**Arquivo:linha:** `src/modules/os/documents/transport.ts:334`; reutilização da tentativa em `src/modules/os/documents/transport.ts:67`.

**Defeito:** a mesma chave recupera uma tentativa vencida, mas o transporte exige concessão ativa antes de verificar se o objeto já foi gravado.

**Cenário:** o PUT grava o arquivo no R2, ocorre uma interrupção antes do registro técnico no D1 e a requisição é repetida após seis minutos, ainda dentro das 24 horas da reserva. `beginUpload` devolve a tentativa anterior; o transporte responde `upload_expired` antes do `head` e da recuperação do objeto. Todas as repetições com essa chave continuam falhando. No recebimento pelo WhatsApp, a chave é fixa por mensagem/anexo (`delivery.ts:121`), impedindo a retomada automática; a reserva acaba abortada pela limpeza.

**Gravidade: média**.

**Correção sugerida:** recuperar e verificar um objeto existente antes de exigir concessão ativa para escrever. Se não houver objeto, permitir renovação ou nova tentativa por comando serializado, mantendo exclusividade e proteção contra sobrescrita. Considerar também o recibo antigo do Coordinator.

### 4. Recuperação da confirmação não funciona através do despacho HTTP após interrupção

**Arquivo:linha:** `src/modules/os/documents/transport.ts:200`; bloqueio em `src/coordinator.ts:235`.

**Defeito:** a confirmação implementa repetição em `commitChild`, mas o Coordinator impede que ela seja executada quando o recibo ficou sem resposta.

**Cenário:** `/complete` confirma documento e histórico no D1; ocorre uma interrupção antes da publicação do evento ou do fechamento do recibo. Repetir a mesma `Idempotency-Key` retorna `operation_unknown` no Coordinator, sem chegar a `completeDocument`. Tentar uma chave nova não recupera a mutação original: `commitChildMutation` encontra o documento na versão seguinte e rejeita a versão esperada (`src/modules/os/mutations.ts:49`). A publicação pendente não é retomada por esse fluxo.

**Gravidade: média**.

**Correção sugerida:** integrar os comandos de negócio de documentos à recuperação de recibos, permitindo reexecutar com a identidade original da mutação e consultar o histórico antes de rejeitar a versão. Cobrir o caminho pelo Coordinator real, incluindo interrupção entre confirmação no D1 e publicação; os testes atuais substituem `commitChild`.

### 5. Teste de documentos ainda exige os stubs removidos pela implementação de M

**Arquivo:linha:** `tests/os-documents.test.ts:162` e `tests/os-documents.test.ts:180`.

**Defeito:** o teste exige `not_implemented` de funções que já possuem implementação real.

**Cenário:** com o código integrado presente, `resolveWorkType(ctx, "projeto")` não retorna mais o stub de F0: resolve o tipo ou lança `type_not_found` (`src/modules/os/public.ts:67`). A chamada seguinte de `commitChild`, com `statements: []`, também não retorna `not_implemented`; a implementação rejeita a mutação com `version_conflict` (`src/modules/os/mutations.ts:44`). Portanto, essas expectativas estão incompatíveis com o código revisado.

**Gravidade: média** — o teste acusa falha mesmo sem regressão no comportamento que deveria proteger.

**Correção sugerida:** substituir as expectativas transitórias de F0 por cenários da implementação integrada. Preservar as verificações de recurso desligado no embutido e módulo desligado; acrescentar confirmação e repetição com `commitChild` real.

## Partes sem achados adicionais

- **Isolamento entre áreas e ordens e documentos sensíveis:** nada encontrado nos filtros e barreiras de `access.ts`, `store.ts`, `transport.ts`, `extension.ts` e `privacy.ts`, além do problema de titular descrito no achado 1. Os caminhos privados exigem papel explícito e bloqueiam aplicações, bots e atuação por `via`.
- **Chaves R2, limites e hash:** nada encontrado em `model.ts`, `transport.ts` e `src/modules/binary.ts`. As tentativas são geradas pelo servidor, o PUT é condicional, os bytes reais têm limite e a confirmação recalcula SHA-256.
- **Limpeza e migração:** nada encontrado em `cleanup.ts` e `0103_os_documents.sql`. A limpeza protege registros `ready`, inclusive arquivados; a migração é aditiva e corresponde ao DDL contratado.
- **Testes de privacidade:** nada encontrado nas expectativas de `tests/os-document-privacy.test.ts`; elas não cobrem a divergência entre telefone atual e conversa vinculada.

Revisão estática, sem execução de testes. Ausência de registro central não foi considerada achado.

## Suspeitas não confirmadas

Nenhuma adicional.

## Afastamentos do contrato

- A autorização por conversa dispensa a igualdade do telefone verificado, contrariando a restrição de titular aplicada aos documentos.
- A preservação do embutido não cobre comandos `DOCUMENTO` com número inexistente ou de terceiros.
- A recuperação após falha fica incompleta tanto na concessão vencida quanto no recibo de confirmação, contrariando as garantias de repetição e publicação recuperável das seções 4 e 5.
- `private-documents` é uma coleção adicional obrigatória para documentos sensíveis, inclusive para pessoas autorizadas; a coleção normativa `documents` sempre os omite e recusa sua criação. É uma alteração comportamental documentada em `INTEGRACAO.md`, coerente com a separação privada exigida pela seção 6.

**Arquivos lidos inteiros:** `src/modules/os/documents/access.ts`, `src/modules/os/documents/cleanup.ts`, `src/modules/os/documents/delivery.ts`, `src/modules/os/documents/extension.ts`, `src/modules/os/documents/INTEGRACAO.md`, `src/modules/os/documents/model.ts`, `src/modules/os/documents/store.ts`, `src/modules/os/documents/transport.ts`, `src/modules/binary.ts`, `migrations/0103_os_documents.sql`, `tests/os-documents.test.ts`, `tests/os-document-privacy.test.ts`, `src/modules/os/public.ts`, `src/modules/os/privacy.ts`, `src/modules/os/mutations.ts`, `src/modules/os/extensions.ts`, `src/modules/os/extension-runtime.ts`, `src/modules/os/work-types.ts`, `docs/areas/F0-ENTREGA.md`, `docs/areas/relatos/motor-d.md`.