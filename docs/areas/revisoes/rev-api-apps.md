## Achados

### 1. `/stage` recusa as transições que o servidor anuncia para o tipo embutido

**Arquivos:** `src/modules/os/stages.ts:61`; `src/modules/os/work-types.ts:106`; `src/modules/openapi.ts:3246`.  
**Gravidade: média.**

O servidor publica transições executáveis em `next_stages` para `service_order`, mas rejeita todas elas em `/stage`.

**Cenário:** uma ordem embutida em `received` retorna `transition_id: "received_analyzing"`; enviar esse identificador com a versão atual para `POST /service-orders/{id}/stage` resulta em `409 invalid_transition`, porque `changeStage` exige um snapshot personalizado. O OpenAPI não informa essa restrição.

**Correção sugerida:** mudar o servidor. Segundo a seção 5 do contrato, `next_stages` contém ações que o solicitante pode executar ou solicitar. Para o embutido, resolver a transição virtual e encaminhá-la à operação legada correspondente, preservando histórico, mensagens e regras anteriores.

### 2. A documentação encaminha operações sensíveis para caminhos que as recusam

**Arquivos:** `docs/TRABALHOS.md:145`; `docs/API.md:397`; `docs/API.md:405`; `src/modules/openapi.ts:3446`.  
**Gravidade: média.**

A documentação omite as famílias privadas de tarefas e documentos e apresenta os caminhos comuns como suficientes para operar conteúdo sensível.

**Cenário:** mesmo uma pessoa com `os:sensitive` recebe `403 sensitive_forbidden` ao criar uma tarefa ou reservar um documento com `sensitive: true` pelo caminho documentado. Baixar um documento sensível por `/documents/{document_id}/content` retorna `404`, embora a descrição do OpenAPI diga que basta possuir o papel.

Isso é explícito em `tasks/store.ts:34`, `documents/store.ts:55` e `documents/access.ts:59`. Os descritores oferecem:

- `POST /service-orders/{id}/private-tasks`;
- `PATCH /service-orders/{id}/private-tasks/{task_id}`;
- `POST /service-orders/{id}/private-tasks/{task_id}/archive`;
- a família `/service-orders/{id}/private-documents`, com listagem, reserva, upload, download, confirmação e arquivamento.

**Correção sugerida:** mudar documentação, OpenAPI e seus testes. Publicar os caminhos privados e distinguir seus corpos e permissões dos caminhos comuns. Preservar a separação do servidor: a seção 6 exige operações privadas fora do catálogo de IA e rejeição de valores sensíveis nas operações comuns.

### 3. O esquema de `/status` proíbe um destino válido dos tipos personalizados

**Arquivos:** `src/modules/openapi.ts:1213`; `tests/os-openapi-contract.test.ts:183`.  
**Gravidade: média.**

O esquema de entrada exclui `received`, embora o motor permita esse destino em uma transição personalizada manual e inequívoca.

**Cenário:** o modelo de condomínio contém `pedir_ajustes`, de `em_analise` para `ajustes`, cujo estado de base é `received` (`src/area-templates/models/condominios.ts:834`). O servidor anuncia esse estado em `next_statuses` e aceita `{"status":"received"}` por `customStatus`; um consumidor que valide pelo OpenAPI rejeita a mesma requisição. O teste fixa expressamente a enumeração incompleta.

**Correção sugerida:** mudar OpenAPI e teste. Representar também os destinos permitidos aos personalizados, distinguindo as restrições do embutido. Não restringir o servidor: essa transição satisfaz as condições da seção 5 do contrato.

### 4. O histórico real dos personalizados viola o esquema e expõe uma incompatibilidade de apresentação móvel

**Arquivos:** `src/modules/openapi.ts:1156`; `mobile/android/app/src/test/resources/work-orders/motor-custom-order.json:34`; `mobile/ios/WabotiaTests/Fixtures/WorkOrders/motor-custom-order.json:34`.  
**Gravidade: média.**

O esquema e a fixture preservam os códigos antigos de histórico, enquanto o detalhe real também retorna os novos códigos `os.*`.

**Cenário:** criar uma tarefa grava `kind: "os.task.created"` e estados nulos (`src/modules/os/mutations.ts:54`). O detalhe padrão carrega todos os registros (`os.ts:272`), e `orderView` copia `kind` sem conversão (`store.ts:158`). Essa resposta viola a enumeração `opened/status/quote/edit` do OpenAPI.

Nos aplicativos, o mesmo registro aparece literalmente como **`os.task.created`**: os métodos de apresentação só reconhecem os códigos antigos e retornam o código desconhecido quando não há `to_status`:

- `mobile/android/app/src/main/java/br/com/queven/wabotia/modules/os/ServiceOrderClient.kt:215`;
- `mobile/ios/Wabotia/Modules/ServiceOrders/ServiceOrderClient.swift:223`.

A fixture personalizada usa `kind: "status"` para uma mudança que o motor grava como `os.stage_changed`. Também coloca no histórico embutido campos como `from_stage` e `changed_fields`, que `orderView` não retorna nesse formato.

**Correção sugerida:** ampliar o esquema do histórico e corrigir as fixtures conforme cada endpoint. Acrescentar cobertura dos códigos reais e sua apresentação nos aplicativos. Preservar os registros antigos do embutido, conforme o contrato; não converter artificialmente todos os eventos novos para códigos antigos.

### 5. Ambos os aplicativos oferecem orçamento para tipos que o desativaram

**Arquivos:** `mobile/android/app/src/main/java/br/com/queven/wabotia/modules/os/ServiceOrderClient.kt:206`; `mobile/ios/Wabotia/Modules/ServiceOrders/ServiceOrderClient.swift:210`.  
**Gravidade: média.**

`canEditQuote` considera somente o estado de base e ignora a disponibilidade de orçamento no tipo personalizado.

**Cenário:** um trabalho do modelo de lavanderia nasce em `received`, com `features.quote: null` (`src/area-templates/models/lavanderia-costura.ts:41`). Android e iOS exibem **Montar orçamento**; ao salvar, o servidor responde `409 feature_disabled` por `customQuotePolicy` (`src/modules/os/stages.ts:22`).

Os novos testes passam apenas pelo personalizado em `in_progress`, onde o editor já fica oculto pela regra antiga: teste Android na linha 85 e teste iOS na linha 66.

**Correção sugerida:** mudar os aplicativos e os testes C. Ocultar o editor para personalizados sem capacidade de orçamento confirmada e considerar a definição fixada na ordem ao implementar esse suporte. Acrescentar o caso inicial de um tipo sem orçamento. O servidor deve continuar recusando a operação; o contrato permite desativar esse recurso.

### 6. Os testes de listagem e paginação usam respostas que o servidor não produziria

**Arquivos:** `mobile/android/app/src/test/java/br/com/queven/wabotia/modules/ServiceOrderMotorCompatibilityTest.kt:101`; `mobile/ios/WabotiaTests/ServiceOrderMotorCompatibilityTests.swift:82`.  
**Gravidade: média.**

Os simuladores devolvem uma única página fictícia para consultas diferentes, permitindo que a verificação de compatibilidade passe sem representar a paginação real.

**Cenário:** ambos chamam a lista com `q=Processo` e limite padrão 50, mas recebem:

- uma ordem de “Celular / Tela trincada / Bia Exemplo”, que não corresponde à busca;
- somente duas linhas e `next_cursor: "120"`, embora `counts` indique apenas 11 ordens na área;
- `history` dentro das linhas e `facets`, apesar de a consulta não solicitar facetas;
- as mesmas ordens 121 e 120 novamente após enviar `cursor=120`.

O servidor filtra a busca em `store.ts:254`, aplica `number < cursor` na linha 282, só emite cursor quando há mais linhas que o limite na linha 300, omite histórico na listagem e só inclui facetas mediante `facets=1`.

**Correção sugerida:** mudar fixtures e simuladores, nas duas plataformas. Separar lista de detalhe, responder conforme busca e cursor e conferir o conteúdo da segunda página. Os números globais, contagens esparsas e cursor textual do servidor estão de acordo com o contrato.

### 7. Os exemplos do OpenAPI contradizem as projeções e os estados das operações

**Arquivos:** `src/modules/openapi.ts:3763`; `src/modules/openapi.ts:2467`; `src/modules/openapi.ts:2897`.  
**Gravidade: leve.**

O gerador reutiliza exemplos de equipe em operações com respostas diferentes e inclui valores que não correspondem à implementação.

**Cenários confirmados:**

- O detalhe por conversa recebe exemplos com telefone, identificadores de contato/conversa, `notes`, `created_by` e ações. A projeção efetiva deixa `customer` somente com `name`, remove os campos internos e esvazia as ações (`privacy.ts:117`).
- A criação recebe como exemplo um personalizado já em `in_progress`, versão 3; uma criação nova começa na etapa inicial de base `received`, versão 1.
- Os identificadores de transição do exemplo embutido são `analyzing`, `in_progress` e `cancelled`; o servidor produz `received_analyzing`, `received_in_progress` e `received_cancelled`.
- O exemplo de lista apresenta os números 42 e 43 nessa ordem, contrariando a ordenação decrescente, e anuncia próxima página apesar de conter todas as duas ordens contabilizadas.

**Correção sugerida:** mudar os exemplos e suas verificações. Usar exemplos específicos por operação e audiência, coerentes com `store.ts`, `workOrderAdditions` e `customerProjection`. A projeção pública deve permanecer restrita; o exemplo não é evidência de vazamento real.

### 8. Duas leituras entregues pelas extensões não aparecem no contrato HTTP publicado

**Arquivos:** `src/modules/openapi.ts:3140`; `docs/API.md:394`; `tests/os-openapi-contract.test.ts:123`.  
**Gravidade: leve.**

O catálogo cobre apenas as rotas enumeradas originalmente e omite duas leituras adicionais implementadas.

**Cenário:** um cliente construído a partir da documentação não encontra:

| Rota | Implementação |
|---|---|
| `GET /service-orders/my-tasks` | `src/modules/os/tasks/extension.ts:16` |
| `GET /service-orders/{id}/entries/summary` | `src/modules/os/entries/extension.ts:13` |

O resumo retorna grupos com `kind`, `unit`, `count` e **`quantity_milli: string | null`**, não a quantidade numérica de um lançamento individual (`entries/store.ts:90`). O teste verifica as 45 rotas extraídas do documento original e não detecta essas omissões.

**Correção sugerida:** acrescentar rotas, filtros, respostas e autorização à documentação e ao OpenAPI; ampliar a conferência com os descritores entregues. São complementos aditivos: não remover as implementações. Este achado independe de seu registro central ainda estar pendente.

### 9. O tipo de conteúdo documentado para download difere do enviado

**Arquivos:** `src/modules/openapi.ts:3741`; `tests/os-openapi-contract.test.ts:340`.  
**Gravidade: leve.**

O OpenAPI declara exclusivamente `application/octet-stream` para downloads, mas o servidor retorna o MIME cadastrado no documento.

**Cenário:** baixar um PDF pronto produz `Content-Type: application/pdf` (`src/modules/os/documents/transport.ts:250`), resposta ausente do contrato publicado; o teste confirma somente a declaração incorreta de `application/octet-stream`.

**Correção sugerida:** mudar OpenAPI e teste para representar os tipos binários efetivos. Documentar também a lista permitida de MIME de `documents/model.ts`. Preservar o transporte do servidor e `Cache-Control: no-store`.

### 10. Faltam códigos de erro efetivamente retornados em operações documentadas

**Arquivos:** `src/modules/openapi.ts:3584`; `src/modules/openapi.ts:3594`; `src/modules/openapi.ts:3454`; `docs/API.md:409`; `docs/API.md:473`.  
**Gravidade: leve.**

As descrições de erro não incluem respostas específicas alcançáveis nos manipuladores.

**Cenários:**

| Entrada ou estado | Resposta real | Evidência |
|---|---|---|
| Prévia ou aplicação com `template_id` inexistente | `404 template_not_found`; o OpenAPI dessas operações só enumera `not_found` para 404 | `src/area-templates/engine.ts:46` |
| Envio ao cliente de documento público ainda `pending`, com versão correta | `409 document_not_ready`, ausente da descrição de `/send` | `src/modules/os/documents/delivery.ts:34` |

**Correção sugerida:** atualizar documentação, OpenAPI e expectativas dos testes com esses códigos por operação. Manter as recusas do servidor: elas correspondem à resolução do modelo e à exigência contratual de documento pronto antes do envio.

## Partes sem novos achados

- **Sintaxe Kotlin e Swift:** nada encontrado na leitura integral dos dois testes novos, confrontados com as assinaturas dos clientes e do `StubURLProtocol`. Não houve compilação nem execução de testes.
- **Decodificação dos tipos básicos:** nada encontrado para número global inteiro, cursor textual/nulo, nove estados e contagens esparsas nas respostas efetivamente montadas pelo servidor.
- **`docs/ORDEM-DE-SERVICO.md`:** nada encontrado além das divergências compartilhadas detalhadas acima.
- **`docs/MODULOS.md`, seção do motor:** nada encontrado nas assinaturas descritas de extensões, projeções e transporte confrontadas com o código.
- A comparação móvel de `approve` com a resposta `approved` permanece um problema preexistente, expressamente separado pelo contrato. As contraprovas com número textual ou cursor objeto não representam respostas novas do servidor.

## Suspeitas não confirmadas

Nenhuma suspeita adicional mantida. Ausência de erro sintático encontrado por leitura não constitui confirmação de compilação.

## Afastamentos do contrato

- O servidor anuncia ações do embutido em `next_stages` que `/stage` não executa, contrariando o significado desse campo na seção 5.
- O OpenAPI restringe `/status` além das condições contratuais dos personalizados, excluindo `received`.
- A documentação das operações sensíveis não incorpora a separação privada exigida pela seção 6 e concretizada nas extensões.
- As famílias privadas, `my-tasks` e `entries/summary` ampliam a superfície HTTP enumerada originalmente; esses complementos comportamentais precisam constar do contrato publicado.
- Os testes C não representam integralmente as respostas de lista e histórico que deveriam sustentar a garantia de compatibilidade.

**Arquivos lidos inteiros:** todos os arquivos de `src/modules/os/`; `src/area-templates/{engine,index,validation}.ts`; `src/area-templates/models/lavanderia-costura.ts`; `docs/{ORDEM-DE-SERVICO,TRABALHOS}.md`; `docs/areas/{CONTRATO-MOTOR,F0-ENTREGA}.md`; `docs/areas/relatos/{motor-o,motor-c}.md`; `tests/os-openapi-contract.test.ts`; `mobile/android/app/src/test/java/br/com/queven/wabotia/modules/ServiceOrderMotorCompatibilityTest.kt`; `mobile/android/app/src/main/java/br/com/queven/wabotia/modules/os/ServiceOrderClient.kt`; `mobile/ios/WabotiaTests/{ServiceOrderMotorCompatibilityTests,StubURLProtocol}.swift`; `mobile/ios/Wabotia/Modules/ServiceOrders/ServiceOrderClient.swift`; `mobile/ios/project.yml`; os cinco arquivos `motor-*.json` em `mobile/android/app/src/test/resources/work-orders/` e seus pares idênticos em `mobile/ios/WabotiaTests/Fixtures/WorkOrders/`.