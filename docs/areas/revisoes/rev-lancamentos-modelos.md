## Achados

### 1. Recuperação após falha não funciona pelo caminho real dos comandos

**Arquivos:** `src/area-templates/engine.ts:195`, `src/area-templates/index.ts:42`, `src/modules/os/entries/store.ts:222`.  
**Gravidade: média.**

**Defeito:** uma operação já gravada pode ficar sem resposta recuperável e sem concluir sua publicação.

**Cenário:** o lote D1 confirma um lançamento ou a aplicação de um modelo, mas ocorre uma falha antes do fechamento do recibo → repetir com a mesma `Idempotency-Key` retorna `409 operation_unknown`, antes de alcançar os mecanismos de recuperação. Isso está explícito em `src/coordinator.ts:235`; o fechamento recuperável contempla somente as operações de fila enumeradas em `src/queue.ts:1526`.

Nos modelos há uma segunda barreira: mesmo que o manipulador seja chamado novamente, o estado e a procedência já mudaram, portanto o hash original é recusado como `preview_stale`. Uma nova prévia também não recupera os eventos perdidos: os módulos já aparecem no estado desejado e deixam de integrar `module_changes`. A publicação ocorre depois da confirmação, em `src/service.ts:1934`.

**Correção sugerida:** integrar L e A à recuperação durável do recibo no Coordinator existente. Gravar uma referência da operação e seu resultado no mesmo lote dos dados; reconhecer repetições confirmadas antes de validar novamente a prévia; retomar publicações pendentes com chaves estáveis. Em A, encaminhar o identificador da operação ao motor, hoje descartado pelo descritor.

### 2. Menus do tipo embutido são acrescentados mesmo quando ele não foi selecionado

**Arquivo:** `src/area-templates/engine.ts:128`.  
**Gravidade: média.**

**Defeito:** a condição que ignora menus de tipos não selecionados exclui expressamente `service_order`.

**Cenário:** um manifesto contém menus de um tipo personalizado e do embutido; o administrador envia `work_type_ids: ["projeto"]` e `menus: true` → a aplicação acrescenta também os menus de abertura e acompanhamento da Ordem de Serviço. Com OS desligado, nenhuma seleção de tipos e apenas menus informativos desejados, esses menus embutidos ainda podem provocar `dependency_conflict`.

O embutido aparece como escolha explícita em `work_type_ids`, mas sua ausência não controla seus menus.

**Correção sugerida:** aplicar a seleção também aos novos menus que referenciam `service_order`. Quando não selecionado, marcar esses menus como `skip`, sem registrar seus IDs como já tratados, permitindo incluí-los numa aplicação posterior. Preservar menus existentes.

### 3. Testes de lançamentos exigem respostas provisórias que o núcleo já não produz

**Arquivo:** `tests/os-entries.test.ts:112` e `tests/os-entries.test.ts:119`.  
**Gravidade: média.**

**Defeito:** dois testes continuam exigindo `501 not_implemented` da base F0 após a implementação de M.

**Cenário:** o teste da linha 119 chama `resolveWorkType` para `projeto`, que a fixture não cadastra → o código atual retorna `404 type_not_found`, conforme `src/modules/os/public.ts:68`, e a expectativa de 501 falha. O teste da linha 112 deixa `commitChild` real, que agora chama `commitChildMutation` e pode efetivamente gravar; a expectativa de ausência de escrita também deixou de representar o contrato atual.

**Correção sugerida:** substituir essas expectativas provisórias por casos do núcleo implementado: tipo inexistente retorna 404; tipo cadastrado permite a operação; falha transacional efetiva reverte a escrita. Manter a fixture comum intacta e configurar os cenários localmente.

## Partes sem achados confirmados

- **Lançamentos — validação e persistência:** nada encontrado em precisão das quantidades, conservação do original na correção, filtros SQL por área e ordem ou conversão de fuso. `quantity_milli` exige inteiro seguro; a soma usa inteiro SQL convertido para texto; o resumo padrão exclui arquivados; correção e arquivamento do original integram o mesmo lote. Foram lidos os quatro arquivos de `entries/`, a migração e os testes, além dos auxiliares de autorização, privacidade e mutação.
- **Modelos — demais controles:** nada encontrado em sobrescrita direta de cadastros manuais, duplicação na reaplicação normal, aplicação parcial de configuração/módulos/procedência, ativação de módulos fora da seleção ou escrita em outra área. O hash é recalculado e inclui área, configuração, módulos e procedência. A importação limita tamanho, rejeita propriedades desconhecidas e prefixa os IDs globais.
- **Migrações:** nada encontrado. `0104` e `0105` são aditivas e correspondem aos respectivos DDLs da seção 4.

A análise foi somente por leitura; nenhum teste foi executado.

## Suspeitas não confirmadas

- **`src/modules/os/entries/store.ts:17`:** a identificação de audiência pública ignora `actor.module`, enquanto `projectChildForStaff`, em `src/modules/os/privacy.ts:82`, trata esse ator como público. Se um ator de módulo alcançar essas funções, o resumo incluirá lançamentos internos não sensíveis e a paginação poderá considerar registros posteriormente omitidos. Faltou confirmar um chamador de produção que consulte lançamentos com esse tipo de ator.

## Afastamentos do contrato

- **Seleção de modelos:** os menus embutidos ignoram a seleção de tipos, conforme o achado 2.
- **Recuperação:** o caminho real não cumpre a recuperação de publicação após confirmação prevista na seção 4 e atribuída a M/D/A pela entrega F0, conforme o achado 1.
- **Resumo adicional:** `GET service-orders/:id/entries/summary` não consta da seção 5. Seu `include_archived=1` soma também os originais substituídos: uma quantidade de 1.000 corrigida para 2.000 produz total histórico de 3.000. Esse comportamento está explicitamente documentado em `entries/README.md:80`; o resumo padrão retorna somente 2.000.
- **Versão de manifesto:** `src/area-templates/engine.ts:163` acrescenta rejeição de versões anteriores e de conteúdo alterado sem incremento de versão, condições não explicitadas na seção 7.

**Arquivos lidos inteiros:** `src/modules/os/entries/model.ts`, `src/modules/os/entries/store.ts`, `src/modules/os/entries/extension.ts`, `src/modules/os/entries/README.md`, `migrations/0104_os_entries.sql`, `tests/os-entries.test.ts`, `src/area-templates/validation.ts`, `src/area-templates/engine.ts`, `src/area-templates/index.ts`, `migrations/0105_os_area_templates.sql`, `tests/os-area-templates.test.ts`, `src/modules/os/public.ts`, `src/modules/os/privacy.ts`, `src/modules/os/mutations.ts`, `src/modules/os/validation.ts`, `tests/os-motor-fixture.ts`, `docs/areas/F0-ENTREGA.md`, `docs/areas/relatos/motor-l.md`, `docs/areas/relatos/motor-a.md`.