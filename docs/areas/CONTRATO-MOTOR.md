# Contrato do motor de trabalhos do Wabotia

**Base:** commit `efc7e54`, versão `0.21.1`. A versão consta em `package.json:3`.

Este documento define a implementação. Os blocos identificados como **contrato proposto** ainda não existem no repositório. As referências indicam o comportamento atual que precisa ser preservado.

A inspeção foi somente de leitura. Não foram executados testes, alterações de arquivos ou consultas à rede. Os resultados dos testes futuros estão **a conferir**.

## 1. Onde os estados e os campos fixos estão espalhados

| Camada | Arquivo:linha | Premissa atual |
|---|---|---|
| Banco | `migrations/0035_os_orders.sql:12` | A ordem tem `number`, `status`, `item` e `problem`. Não tem tipo, etapa própria ou campos extras. |
| Banco | `migrations/0035_os_orders.sql:57` | `number` é único por área. Não pode passar a repetir entre tipos sem violar o índice existente. |
| Banco | `migrations/0035_os_orders.sql:7` | Há um contador por área. |
| Banco | `migrations/0035_os_orders.sql:64` | O histórico registra estados de origem e destino, ator, nota e data. |
| Modelo | `src/modules/os/model.ts:6` | Os nove códigos de estado são fixos. |
| Modelo | `src/modules/os/model.ts:19` | Os rótulos dos estados são fixos. |
| Modelo | `src/modules/os/model.ts:32` | Somente `delivered` e `cancelled` são encerrados. |
| Modelo | `src/modules/os/model.ts:41` | As transições manuais estão em uma tabela fixa. |
| Modelo | `src/modules/os/model.ts:53` | O orçamento pode ser editado em `received`, `analyzing`, `quoted` e `declined`. |
| Modelo | `src/modules/os/model.ts:65` | `nextStatuses` acrescenta envio e decisão de orçamento às transições manuais. |
| Configuração | `src/modules/os/model.ts:75` | Há oito chaves de mensagem. Elas não correspondem a nove mensagens, uma por estado. |
| Configuração | `src/modules/os/model.ts:102` | Termos, validade, garantia, aviso de paralisação e retirada têm padrões fixos. |
| Configuração | `src/modules/os/model.ts:150` | `service_orders` tem validação estrita. A configuração salva pode ser parcial. |
| Mensagens | `src/modules/os/model.ts:306` | `{estado}` usa o rótulo do estado de base. `{numero}` usa `number`. |
| Declaração | `src/modules/os/definition.ts:7` | Nome do módulo, navegação e papel “Técnico” são fixos. |
| Menus | `src/modules/os/definition.ts:28` | `os_open` e `os_track` ainda não declaram `reference`. |
| Eventos | `src/modules/os/definition.ts:42` | O catálogo contém abertura, orçamento, decisões, mudança de estado, entrega e paralisação. |
| WhatsApp | `src/modules/os/os.ts:52` | O formulário usa campos fixos de item, problema e aceite. O `ref` é nulo. |
| WhatsApp | `src/modules/os/os.ts:125` | Os dois manipuladores de menu não usam o item recebido para selecionar um tipo. |
| WhatsApp | `src/modules/os/os.ts:188` | A conclusão do formulário lê item e problema fixos e cria uma ordem. |
| API | `src/modules/os/os.ts:211` | Lista e detalhe retornam a projeção atual da ordem. |
| API | `src/modules/os/os.ts:230` | A criação recebe os campos fixos. |
| API | `src/modules/os/os.ts:267` | Mudança de estado, orçamento e decisão usam operações distintas. |
| API do cliente | `src/modules/os/os.ts:351` | `os_situacao` consulta pela conversa. Não recebe um telefone arbitrário como autoridade. |
| Projeção | `src/modules/os/store.ts:92` | A resposta contém `status`, `status_label`, `item`, `problem`, orçamento e `next_statuses`. |
| Privacidade | `src/modules/os/store.ts:166` | A filtragem existente trata contatos e notas. Não conhece metadados de campos extras. |
| Lista | `src/modules/os/store.ts:215` | Filtros, busca, paginação e contagem usam estados e campos fixos. |
| Contagem | `src/modules/os/store.ts:257` | `counts` agrega a área inteira, sem os filtros da lista. Estados sem registros ficam ausentes. |
| Paginação | `src/modules/os/store.ts:267` | O cursor usa o número global da ordem. |
| Criação | `src/modules/os/store.ts:353` | A criação valida os textos fixos e reserva um número no contador da área. |
| Edição | `src/modules/os/store.ts:449` | Uma ordem encerrada só admite alteração das observações internas. |
| Transição | `src/modules/os/store.ts:516` | A mudança controla concorrência por estado e versão do orçamento. Também altera datas, garantia e avisos. |
| Orçamento | `src/modules/os/store.ts:640` | Editar um orçamento enviado devolve a ordem a `analyzing`. |
| Orçamento | `src/modules/os/store.ts:714` | O resumo usa o texto fixo “Item”. |
| WhatsApp | `src/modules/os/store.ts:731` | Botões de orçamento carregam ID da ordem, versão do orçamento e decisão. |
| WhatsApp | `src/modules/os/store.ts:900` | A resposta confere conversa, versão e ordem. A aprovação textual usa o número global. |
| Acompanhamento | `src/modules/os/store.ts:1027` | A consulta do cliente usa conversa ou telefone verificado, limita a quantidade e considera os estados encerrados. |
| Lembretes | `src/modules/os/reminders.ts:19` | Retirada depende de `ready`; paralisação exclui `delivered` e `cancelled`. |
| Painel | `web/modules/os/shared.ts:5` | Estados, rótulos, cores e nomes das ações são fixos. |
| Painel | `web/modules/os/ServiceOrdersPage.tsx:150` | O formulário usa item, problema e observações com limites fixos. |
| Painel | `web/modules/os/ServiceOrdersPage.tsx:390` | Ações são derivadas de `next_statuses`, com tratamento especial do orçamento. |
| Painel | `web/modules/os/ServiceOrdersPage.tsx:521` | A possibilidade de editar orçamento é calculada pelos estados de base. |
| Painel | `web/modules/os/ServiceOrdersPage.tsx:655` | Os totais são somados pelos códigos conhecidos. |
| Painel | `web/modules/os/ServiceOrderSettings.tsx:36` | A tela conhece as oito mensagens atuais. |
| Painel | `web/modules/os/ServiceOrderSettings.tsx:80` | A presença de menu é verificada pelo tipo do item. Isso não distingue dois `os_open` de tipos de trabalho diferentes. |
| Conversa web | `web/modules/os/ConversationServiceOrders.tsx:58` | A apresentação usa número e item. O formulário de abertura também é fixo. |
| Android | `mobile/android/app/src/main/java/br/com/queven/wabotia/modules/os/ServiceOrderClient.kt:63` | O DTO conhece os campos atuais e usa `Int` para `number`. |
| Android | `mobile/android/app/src/main/java/br/com/queven/wabotia/modules/os/ServiceOrderClient.kt:162` | Estados, encerramento, orçamento e filtros são conhecidos pelo aplicativo. |
| Android | `mobile/android/app/src/main/java/br/com/queven/wabotia/modules/os/ServiceOrderViewModels.kt:190` | `quoted` chama envio; `approved` e `declined` chamam decisão; os demais chamam `/status`. |
| Android | `mobile/android/app/src/main/java/br/com/queven/wabotia/printing/ServiceOrderReceipt.kt:75` | O comprovante usa “Cliente”, “Item” e “Problema”. |
| iOS | `mobile/ios/Wabotia/Modules/ServiceOrders/ServiceOrderClient.swift:60` | O DTO usa campos atuais, estado textual e contagem por código. |
| iOS | `mobile/ios/Wabotia/Modules/ServiceOrders/ServiceOrderClient.swift:163` | Estados, encerramento, orçamento e filtros são fixos. |
| iOS | `mobile/ios/Wabotia/Modules/ServiceOrders/ServiceOrderViewModels.swift:166` | As ações também escolhem rotas a partir do estado de destino. |
| iOS | `mobile/ios/Wabotia/Modules/ServiceOrders/ServiceOrderReceipt.swift:64` | Os rótulos do comprovante são fixos. |
| Demonstrações | `mobile/android/app/src/main/java/br/com/queven/wabotia/demo/DemoModules.kt:285`; `mobile/ios/Wabotia/Core/Demo/DemoModules.swift:291` | Cada aplicativo reproduz o motor de OS em memória. Essas cópias também contêm estados e regras. |
| Testes do servidor | `tests/os-orders.test.ts:100`; `tests/os-orders.test.ts:265` | Cobrem abertura, sequência, transições, orçamento, entrega e histórico atuais. |
| Testes do WhatsApp | `tests/os-whatsapp.test.ts:116`; `tests/os-whatsapp.test.ts:245`; `tests/os-whatsapp.test.ts:424` | Cobrem formulário, identidade, respostas e lembretes. |
| Testes móveis | `mobile/android/app/src/test/java/br/com/queven/wabotia/modules/ServiceOrderTest.kt:35`; `mobile/ios/WabotiaTests/ServiceOrderTests.swift:66` | Fixam ações e interpretação dos estados. |
| OpenAPI | `src/modules/openapi.ts:731` | As rotas atuais são declaradas individualmente. |
| OpenAPI | `src/modules/openapi.ts:1261` | A entrada de `/status` enumera os destinos manuais atuais. |
| OpenAPI | `src/modules/openapi.ts:1330` | `counts` aceita somente os nove códigos e documenta a ausência como zero. |
| Documentação | `docs/API.md:303`; `docs/ORDEM-DE-SERVICO.md:74` | O contrato publicado descreve lista, contagem global e fluxo atual. |

Há quatro restrições de integração que afetam a implementação:

| Ponto | Evidência | Consequência |
|---|---|---|
| Referência de menu | `src/modules/types.ts:19`; `src/service.ts:2101` | A referência atual procura um ID em uma lista de configuração. O tipo embutido virtual precisa de suporte explícito. |
| Validação de configuração | `src/modules/api.ts:1476` | O validador recebe somente o valor novo. Comparar revisões exige um gancho adicional. |
| Parâmetros de escrita | `src/index.ts:1849` | O adaptador atual acrescenta automaticamente somente `id`. Rotas filhas precisam receber todos os parâmetros declarados. |
| Agendamento | `src/modules/hooks.ts:129` | Um segundo registro de agendador para `os` substitui o primeiro. Deve existir um único agregador. |

## 2. O que os aplicativos assumem e o que pode quebrar

### Contrato efetivamente consumido

| Aspecto | Android | iOS | Obrigação do servidor |
|---|---|---|---|
| Estado | `String`, com padrão `received` quando ausente. | `String`, com o mesmo padrão. | Continuar enviando um dos nove códigos. |
| Rótulo | Prefere `status_label`; tem tabela local de reserva. | Mesmo comportamento. | Manter `status_label` como rótulo do estado de base. Acrescentar `stage_label` separadamente. |
| Campos novos | O JSON está configurado para ignorar chaves desconhecidas. | O DTO `Decodable` não declara os campos novos. | Acrescentar propriedades. Não alterar o tipo das existentes. |
| Número | `Int?`, de 32 bits. | `Int?`. | Manter `number` numérico, positivo e limitado a `2.147.483.647`. |
| Cursor | Aceita texto e alguns números. | O DTO exige texto ou nulo. | Continuar retornando `next_cursor: string \| null`. |
| Contagem | Mapa de inteiros. Chave ausente vale zero. | Mapa de inteiros. Relê as chaves originais para evitar conversão de nomes. | Preservar códigos exatos e valores inteiros. |
| Abertas | Soma somente estados conhecidos que não são encerrados. | Mesmo cálculo. | Não introduzir estados novos em `status` ou `counts`. |
| Ações | Interpreta `next_statuses` como destinos e escolhe rotas especiais de orçamento. | Mesmo comportamento. | Não colocar IDs de etapas em `next_statuses`. |
| Criação | Envia item e problema. Não envia tipo. | Mesmo comportamento. | Ausência de `type_id` significa o tipo embutido. |
| Impressão | Usa número global e rótulos fixos. | Mesmo comportamento. | Não transformar `item`, `problem` ou `number` em objetos. |

Fontes: `mobile/android/app/src/main/java/br/com/queven/wabotia/core/model/Json.kt:16`; `mobile/android/app/src/main/java/br/com/queven/wabotia/modules/os/ServiceOrderClient.kt:63`; `mobile/android/app/src/main/java/br/com/queven/wabotia/modules/os/ServiceOrderClient.kt:93`; `mobile/android/app/src/main/java/br/com/queven/wabotia/modules/os/ServiceOrderClient.kt:189`; `mobile/ios/Wabotia/Modules/ServiceOrders/ServiceOrderClient.swift:60`; `mobile/ios/Wabotia/Modules/ServiceOrders/ServiceOrderClient.swift:94`; `mobile/ios/Wabotia/Modules/ServiceOrders/ServiceOrderClient.swift:113`; `mobile/ios/Wabotia/Modules/ServiceOrders/ServiceOrderClient.swift:191`.

### Falhas previsíveis

| Mudança incompatível | Efeito |
|---|---|
| Enviar `status: "citacao"` | Pode ser decodificado como texto, mas não ganha filtro, cor, contagem de abertas ou ação correta. |
| Usar `counts` para contagens por etapa | As telas ignoram chaves desconhecidas. Os totais ficam incorretos. |
| Tornar `counts` dependente de `type_id`, busca ou estado | Muda o significado dos indicadores já publicados. |
| Enviar `number` como `"PROC-12"` | Pode impedir a decodificação. No Android, uma linha inválida da lista pode ser descartada silenciosamente. |
| Retornar cursor como objeto | Incompatível com o DTO do iOS. |
| Colocar uma etapa própria em `next_statuses` | O aplicativo tenta tratá-la como estado ou envia uma ação para a rota errada. |
| Permitir duas transições para o mesmo estado de base e aceitar `/status` sem desambiguação | O servidor pode executar uma etapa diferente da pretendida. |
| Reutilizar `quoted` para uma aprovação sem orçamento | Os aplicativos apresentam controles e textos de orçamento. |
| Ocultar item e problema sem substituição compatível | Listas, detalhe, abertura e comprovantes perdem seus campos principais. |

O descarte de linhas inválidas no Android está em `mobile/android/app/src/main/java/br/com/queven/wabotia/modules/os/ServiceOrderClient.kt:113`. Os filtros e as regras locais estão em `mobile/android/app/src/main/java/br/com/queven/wabotia/modules/os/ServiceOrderClient.kt:162` e `mobile/ios/Wabotia/Modules/ServiceOrders/ServiceOrderClient.swift:163`.

**Garantia deste contrato:** o tipo embutido conserva a operação completa dos aplicativos antigos. Tipos novos conservam leitura e ações antigas que tenham interpretação única. A edição completa de tipos novos exige aplicativos atualizados.

Há uma divergência anterior a este trabalho. O servidor retorna `decision.decision = "approved"`, mas trechos de apresentação móvel comparam com `"approve"`. Isso deve ter uma correção própria. Não se deve mudar a resposta do servidor para acomodar a divergência. Evidências: `src/modules/os/store.ts:826`; `tests/os-orders.test.ts:348`; `mobile/android/app/src/main/java/br/com/queven/wabotia/printing/ServiceOrderReceipt.kt:110`; `mobile/ios/Wabotia/Modules/ServiceOrders/ServiceOrderReceipt.swift:78`.

## 3. Formato do tipo de trabalho

### Armazenamento escolhido

**Contrato proposto:** guardar os tipos personalizados em `profiles.settings.os_work_types`. A chave contém uma lista. O tipo embutido é virtual e não ocupa essa lista.

A escolha aproveita três contratos existentes:

- A configuração do módulo já passa pelo `PUT /settings` e por validação declarada pelo módulo. Fontes: `src/modules/os/os.ts:122`; `src/service.ts:2006`.
- A referência de menu já aponta para IDs de uma lista de configuração. Fonte: `src/service.ts:2101`.
- Modelos existentes aplicam configurações comuns pela operação de configurações. Fonte: `src/service-templates.ts:445`.

Não será criada uma tabela de cadastro de tipos nesta fase.

Cada ordem personalizada guardará uma **cópia imutável da definição usada na abertura**. Isso evita mudar o significado de ordens existentes quando o administrador edita um tipo. Essa cópia fica em `os_orders.type_snapshot_json`.

As alterações de um tipo valem para ordens abertas depois da alteração. Não haverá atualização automática das definições das ordens antigas.

### Tipos TypeScript normativos

O arquivo novo será `src/modules/os/contracts.ts`. O código abaixo define o formato público. Comentários indicam restrições complementadas pelas regras de validação.

```ts
export type BaseStatus =
  | "received"
  | "analyzing"
  | "quoted"
  | "approved"
  | "declined"
  | "in_progress"
  | "ready"
  | "delivered"
  | "cancelled";

export type FieldValue = string | number | boolean | null;
export type ExtraValues = Record<string, FieldValue>;

export interface FieldBase {
  id: string;
  label: string;
  help: string;
  required: boolean;
  client_visible: boolean;
  sensitive: boolean;
}

export type WorkField =
  | (FieldBase & {
      kind: "text";
      multiline: boolean;
      max_length: number;
    })
  | (FieldBase & {
      kind: "integer";
      min: number;
      max: number;
    })
  | (FieldBase & {
      kind: "decimal";
      min: number;
      max: number;
      scale: number;
    })
  | (FieldBase & {
      kind: "boolean";
    })
  | (FieldBase & {
      kind: "date";
      min: string | null; // YYYY-MM-DD
      max: string | null;
    })
  | (FieldBase & {
      kind: "choice";
      options: Array<{
        id: string;
        label: string;
      }>;
    });

export interface WorkStage {
  id: string;
  label: string;
  base_status: BaseStatus;
  message: string; // vazio: não envia mensagem ao entrar
}

export interface TransitionBase {
  id: string;
  from: string;
  to: string;
  label: string;
}

export type WorkTransition =
  | (TransitionBase & {
      kind: "manual";
    })
  | (TransitionBase & {
      kind: "customer_approval";
      valid_hours: number;
      request_text: string;
    });

export interface WorkQuotePolicy {
  default_valid_days: number;
  source_stages: string[];
  sent_stage: string;
  approved_stage: string;
  declined_stage: string;
  edited_stage: string;
}

export interface WorkFeatures {
  customer_open: boolean;
  tasks: boolean;
  people: boolean;
  documents: boolean;
  entries: boolean;
  quote: WorkQuotePolicy | null;
  warranty_days: number;
  pickup_reminder_days: number;
  stale_days: number;
}

export interface WorkLabels {
  singular: string;
  plural: string;
  item: string;
  problem: string;
  customer_singular: string;
  customer_plural: string;
}

export interface CustomWorkType {
  schema_version: 1;
  kind: "custom";
  id: string;
  revision: number;
  archived: boolean;
  labels: WorkLabels;
  number_prefix: string;
  terms: string | null;
  fields: WorkField[];
  retired_field_ids: string[];
  stages: WorkStage[];
  retired_stage_ids: string[];
  initial_stage: string;
  transitions: WorkTransition[];
  features: WorkFeatures;
  pickup_reminder_text: string;
}

export interface BuiltinWorkType {
  schema_version: 1;
  kind: "builtin";
  id: "service_order";
  revision: 1;
}

export type WorkType = BuiltinWorkType | CustomWorkType;

export interface WorkTypeSnapshot {
  schema_version: 1;
  type: CustomWorkType;
}

export interface OsVocabulary {
  collection_label: string;
  customer_singular: string;
  customer_plural: string;
}

export interface WorkTypeSettings {
  os_work_types?: CustomWorkType[];
  os_vocabulary?: OsVocabulary;
}

export interface PendingStageApproval {
  version: number;
  transition_id: string;
  from_stage: string;
  to_stage: string;
  state: "pending" | "approved" | "declined" | "expired" | "cancelled";
  requested_at: number;
  expires_at: number;
  decided_at: number | null;
  decided_by: string | null;
}

export interface WorkOrderAdditions {
  type_id: string;
  type_revision: number;
  type_number: number;
  type_label: string;
  type_plural_label: string;
  display_number: string;
  stage: string;
  stage_label: string;
  labels: WorkLabels;
  extra: ExtraValues;
  fields: WorkField[]; // somente definições visíveis ao solicitante
  version: number;
  next_stages: Array<{
    transition_id: string;
    stage: string;
    stage_label: string;
    base_status: BaseStatus;
    kind: WorkTransition["kind"];
  }>;
  stage_approval: PendingStageApproval | null;
}
```

### Limites

Os limites abaixo são propostos. A configuração inteira continua sujeita ao limite existente de `150.000` unidades de comprimento da string JSON. Esse limite atual usa `JSON.stringify(next).length`; não é uma garantia de 150 KB em UTF-8. Fonte: `src/service.ts:2022`.

| Elemento | Limite |
|---|---:|
| Tipos personalizados por área, incluindo arquivados | 20 |
| Definição serializada de um tipo | 12 KiB em UTF-8 |
| Cópia da definição na ordem | 16 KiB em UTF-8 |
| Campos extras por tipo | 24 |
| Etapas por tipo | 32 |
| Transições declaradas por tipo | 128 |
| Opções de um campo de escolha | 32 |
| ID de tipo | 64 caracteres |
| ID de campo, etapa, opção ou transição | 32 caracteres |
| Nome singular, plural ou vocabulário | 80 caracteres |
| Rótulo de campo, etapa, opção ou transição | 80 caracteres |
| Ajuda de campo | 240 caracteres |
| Texto de campo extra | Até 2.000 caracteres |
| Objeto completo de valores extras | 16 KiB em UTF-8 |
| Mensagem de etapa, retirada ou pedido de aprovação | 900 caracteres |
| Termos | 1.400 caracteres |
| Prefixo de numeração | 12 caracteres |
| Validade de aprovação de etapa | De 1 a 720 horas |
| Número global e número por tipo | De 1 a `2.147.483.647` |

Limites de texto contam pontos de código Unicode, depois de aparar espaços externos. Os limites de JSON contam bytes UTF-8, exceto o limite global já existente.

### Regras de validação

| Nº | Regra obrigatória |
|---:|---|
| 1 | Rejeitar propriedades desconhecidas em tipos personalizados, campos, etapas e transições. Não aceitar funções, expressões, HTML executável ou URLs de código. |
| 2 | IDs seguem `[a-z][a-z0-9_]*`. `service_order` é reservado. IDs de campos também não podem usar `__proto__`, `constructor` ou `prototype`. |
| 3 | IDs são únicos no seu escopo. Tipo é único por área. Campo, etapa e transição são únicos dentro do tipo. |
| 4 | Tipo novo começa na revisão 1. Alteração de conteúdo exige a revisão anterior mais 1. Reenvio idêntico conserva a revisão. |
| 5 | Uma gravação informa a revisão de configuração que leu. Revisão divergente produz `409 settings_conflict`. |
| 6 | Tipo salvo não pode desaparecer da lista. Para interromper novas aberturas, usar `archived: true`. Ordens existentes continuam operáveis pela sua cópia da definição. |
| 7 | Remover um campo ou etapa exige incluir seu ID na lista correspondente de IDs aposentados. ID aposentado não pode ser reutilizado. |
| 8 | Um campo já classificado como sensível não pode ser reclassificado como não sensível. A classificação também não pode ser contornada removendo e recriando o mesmo ID. |
| 9 | `sensitive: true` exige `client_visible: false` e `required: false` nesta fase. Campos sensíveis obrigatórios ficam para extensões com fluxo próprio de captura. |
| 10 | Se `customer_open` estiver ligado, todo campo obrigatório precisa ser visível ao cliente e não sensível. |
| 11 | `item` e `problem` continuam obrigatórios e textuais. Apenas os rótulos mudam. Não são campos para armazenar conteúdo classificado como sensível. |
| 12 | Todo valor extra deve ter uma definição na cópia do tipo da ordem. Chaves desconhecidas são rejeitadas. |
| 13 | Campo ausente é diferente de `false`, zero e texto vazio. Campo obrigatório rejeita ausência, nulo e texto vazio. |
| 14 | Inteiros devem ser seguros em JavaScript. Decimais devem ser finitos, respeitar `min`, `max` e `scale`, de 0 a 6. Não arredondar silenciosamente. |
| 15 | Datas usam `YYYY-MM-DD` e devem existir no calendário. Comparar datas como datas civis. |
| 16 | Escolha aceita o ID de uma opção. Não aceita seu rótulo como substituto. |
| 17 | `initial_stage` deve existir e apontar para `received`. Todas as etapas ativas devem ser alcançáveis a partir dela. |
| 18 | Toda etapa aponta para exatamente um dos nove estados. `status` da ordem deve sempre ser igual ao `base_status` da etapa efetiva. |
| 19 | Etapas de `delivered` e `cancelled` são terminais. Não podem ter saídas. Deve existir caminho de encerramento e cancelamento a partir das etapas abertas. |
| 20 | Transição exige origem e destino existentes e diferentes. O cliente envia o ID da transição, não escolhe um destino livre. |
| 21 | `quoted`, `approved` e `declined` ficam reservados ao fluxo de orçamento nesta fase. Se forem usados, `features.quote` deve estar configurado. |
| 22 | A política de orçamento aponta para etapas com estados compatíveis: envio `quoted`; aprovação `approved`; recusa `declined`; edição de orçamento enviado `analyzing`. |
| 23 | As etapas que permitem orçamento devem apontar para estados aceitos por `QUOTABLE`. A política não pode criar uma autorização que o aplicativo antigo interpretaria incorretamente. |
| 24 | Entradas e saídas protegidas do orçamento são executadas pelas operações de orçamento. Não podem ser contornadas por transições manuais. |
| 25 | Aprovação de etapa é independente da decisão de orçamento. A recusa mantém a etapa de origem. A aprovação executa a transição registrada. |
| 26 | Alterar campos da ordem, orçamento ou etapa cancela uma aprovação de etapa pendente. Botão antigo não pode aprovar conteúdo alterado. |
| 27 | Garantia aceita de 0 a 3.650 dias. Retirada aceita de 0 a 365 dias. Paralisação aceita de 0 a 365 dias nos tipos personalizados; zero desliga o recurso. |
| 28 | Retirada exige uma etapa de `ready`. Garantia é calculada ao entrar em `delivered`. Trocar entre duas etapas do mesmo estado não reinicia essas datas. |
| 29 | Mensagens personalizadas aceitam somente os marcadores definidos na seção 6. Marcador desconhecido ou sensível é erro de configuração. |
| 30 | Rejeitar a alteração inteira se qualquer tipo, referência de menu, tamanho agregado ou dependência ficar inválido. Não salvar parcialmente. |

Para comparar revisões, o núcleo deverá acrescentar um gancho puro de validação entre configuração anterior e seguinte. O gancho existente continua válido para a validação isolada do valor. Hoje ele recebe apenas `value`. Fonte: `src/modules/api.ts:1476`.

### Representação do tipo embutido

O tipo virtual é:

```ts
const BUILTIN_WORK_TYPE: BuiltinWorkType = {
  schema_version: 1,
  kind: "builtin",
  id: "service_order",
  revision: 1,
};
```

Sua definição efetiva será construída a partir de `OS_STATUSES`, `STATUS_LABELS`, `MANUAL_TRANSITIONS`, `QUOTABLE`, `nextStatuses` e `osSettings`. Não haverá uma segunda cópia desses valores.

| Aspecto | Regra do tipo embutido |
|---|---|
| Ausência de `type_id` | Seleciona `service_order`. |
| Ausência de etapa na linha antiga | Etapa efetiva é o próprio `status`. |
| Campos extras | Objeto vazio. |
| Configuração | Continua em `service_orders`, com mesclagem dos padrões atuais. |
| Mensagens | Mesmos textos, marcadores, momentos de envio e interpretação de mensagem vazia. |
| Transições | Mesma tabela e mesmas rotas especiais de orçamento. |
| Encerramento | Mesma restrição de edição: somente observações internas. |
| WhatsApp | Mesmos formulários, aceite, botões, respostas textuais e identidade do cliente. |
| Lembretes | Mesmos prazos e condições. |
| Histórico | Mesmos registros para as operações antigas. Nenhum registro adicional apenas por resolver o tipo virtual. |
| Configuração salva | Não expandir padrões dentro de `service_orders`. Não gravar o tipo virtual na lista personalizada. |

Isso preserva as expectativas atuais de configuração parcial e sequência do histórico. Fontes: `tests/os-orders.test.ts:368`; `tests/os-orders.test.ts:542`; `src/modules/os/model.ts:137`.

## 4. Banco e migrações aditivas

### Numeração e linhas antigas

`number` continuará sendo o número global da área. Ele continuará a ordenar a lista, formar o cursor, aparecer nos aplicativos antigos e identificar comandos textuais antigos.

`type_number` será uma segunda sequência, própria do tipo. Não substituirá `number`.

Essa separação é necessária porque a restrição `UNIQUE(profile_id, number)` já existe e não pode ser removida. Fonte: `migrations/0035_os_orders.sql:57`.

| Campo | Linha antiga | Linha nova |
|---|---|---|
| `type_id` | Recebe o padrão `service_order` pela coluna adicionada. | Tipo selecionado. |
| `stage` | Continua nulo no armazenamento. A leitura usa `status`. | ID da etapa efetiva. |
| `extra_json` | `{}`. | Valores validados. |
| `type_snapshot_json` | Nulo. | Nulo no embutido; definição completa no personalizado. |
| `type_number` | Nulo. A leitura usa `number`. | Número reservado no contador do tipo. |
| `row_version` | 1. | Começa em 1 e sobe nas alterações da ordem. |
| `stage_approval_json` | Nulo. | Aprovação de etapa, quando houver. |

Antes da primeira criação pelo motor novo, inicializar o contador de `service_order` com o valor atual de `os_counters.last`. Fazer isso antes de incrementar qualquer contador. Essa inicialização também deve ocorrer se a primeira ordem nova for de um tipo personalizado.

Assim, a sequência por tipo começa depois da sequência histórica. Não há renumeração.

Após misturar tipos, o número global e o número por tipo podem divergir. As interfaces antigas e as mensagens antigas do embutido continuam usando o global. Interfaces novas apresentam o número por tipo nos tipos personalizados.

### Reserva de migrações

| Migração | Responsável |
|---|---|
| `0100_os_work_types.sql` | Motor |
| `0101_os_tasks.sql` | Tarefas e prazos |
| `0102_os_people.sql` | Pessoas ligadas |
| `0103_os_documents.sql` | Documentos |
| `0104_os_entries.sql` | Lançamentos |
| `0105_os_area_templates.sql` | Modelos de área; implementação da fase 3 |
| `0106` a `0119` | Reservadas. Sem uso por outras frentes deste trabalho. |

As quatro tabelas filhas são tarefas, pessoas, documentos e lançamentos. Contadores e registro de aplicação de modelos são tabelas de apoio.

### `0100_os_work_types.sql`

```sql
ALTER TABLE os_orders
  ADD COLUMN type_id TEXT NOT NULL DEFAULT 'service_order';

ALTER TABLE os_orders
  ADD COLUMN stage TEXT;

ALTER TABLE os_orders
  ADD COLUMN type_number INTEGER
  CHECK (type_number IS NULL OR
         type_number BETWEEN 1 AND 2147483647);

ALTER TABLE os_orders
  ADD COLUMN extra_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(extra_json) AND json_type(extra_json) = 'object');

ALTER TABLE os_orders
  ADD COLUMN type_snapshot_json TEXT
  CHECK (type_snapshot_json IS NULL OR
         (json_valid(type_snapshot_json) AND
          json_type(type_snapshot_json) = 'object'));

ALTER TABLE os_orders
  ADD COLUMN row_version INTEGER NOT NULL DEFAULT 1
  CHECK (row_version > 0);

ALTER TABLE os_orders
  ADD COLUMN stage_approval_json TEXT
  CHECK (stage_approval_json IS NULL OR
         (json_valid(stage_approval_json) AND
          json_type(stage_approval_json) = 'object'));

CREATE UNIQUE INDEX os_orders_profile_id
  ON os_orders(profile_id, id);

CREATE UNIQUE INDEX os_orders_type_number
  ON os_orders(profile_id, type_id, COALESCE(type_number, number));

CREATE INDEX os_orders_type_list
  ON os_orders(profile_id, type_id, number DESC);

CREATE INDEX os_orders_type_stage
  ON os_orders(profile_id, type_id, stage, number DESC);

CREATE INDEX os_orders_customer_type
  ON os_orders(profile_id, phone, type_id, number DESC);

CREATE TABLE os_type_counters (
  profile_id TEXT NOT NULL,
  type_id TEXT NOT NULL,
  last INTEGER NOT NULL
    CHECK (last BETWEEN 0 AND 2147483647),
  PRIMARY KEY (profile_id, type_id)
);

ALTER TABLE os_history ADD COLUMN from_stage TEXT;
ALTER TABLE os_history ADD COLUMN to_stage TEXT;
ALTER TABLE os_history ADD COLUMN entity_kind TEXT;
ALTER TABLE os_history ADD COLUMN entity_id TEXT;
ALTER TABLE os_history ADD COLUMN entity_version INTEGER;
ALTER TABLE os_history ADD COLUMN mutation_key TEXT;

ALTER TABLE os_history
  ADD COLUMN changed_fields_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(changed_fields_json) AND
         json_type(changed_fields_json) = 'array');

CREATE INDEX os_history_profile_order_page
  ON os_history(profile_id, order_id, created, id);

CREATE UNIQUE INDEX os_history_mutation
  ON os_history(profile_id, mutation_key)
  WHERE mutation_key IS NOT NULL;
```

### `0101_os_tasks.sql`

```sql
CREATE TABLE os_tasks (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  description TEXT NOT NULL DEFAULT ''
    CHECK (length(description) <= 4000),
  assignee TEXT,
  audience TEXT NOT NULL DEFAULT 'staff'
    CHECK (audience IN ('staff', 'customer')),
  due_at INTEGER,
  remind_at INTEGER,
  state TEXT NOT NULL DEFAULT 'open'
    CHECK (state IN ('open', 'done', 'cancelled')),
  notified_at INTEGER,
  completed_at INTEGER,
  client_visible INTEGER NOT NULL DEFAULT 0
    CHECK (client_visible IN (0, 1)),
  sensitive INTEGER NOT NULL DEFAULT 0
    CHECK (sensitive IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  archived_at INTEGER,
  CHECK (sensitive = 0 OR client_visible = 0),
  CHECK (audience <> 'customer' OR
         (client_visible = 1 AND sensitive = 0)),
  CHECK (remind_at IS NULL OR
         (due_at IS NOT NULL AND remind_at <= due_at)),
  UNIQUE (profile_id, order_id, id),
  FOREIGN KEY (profile_id, order_id)
    REFERENCES os_orders(profile_id, id)
);

CREATE INDEX os_tasks_order_page
  ON os_tasks(profile_id, order_id, archived_at, created, id);

CREATE INDEX os_tasks_due
  ON os_tasks(profile_id, remind_at, id)
  WHERE state = 'open' AND archived_at IS NULL
        AND notified_at IS NULL AND remind_at IS NOT NULL;

CREATE INDEX os_tasks_assignee
  ON os_tasks(profile_id, assignee, state, due_at);
```

### `0102_os_people.sql`

```sql
CREATE TABLE os_people (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (length(role) BETWEEN 1 AND 64),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  contact_id TEXT,
  phone TEXT NOT NULL DEFAULT '' CHECK (length(phone) <= 40),
  email TEXT NOT NULL DEFAULT '' CHECK (length(email) <= 254),
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
  client_visible INTEGER NOT NULL DEFAULT 0
    CHECK (client_visible IN (0, 1)),
  sensitive INTEGER NOT NULL DEFAULT 0
    CHECK (sensitive IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  archived_at INTEGER,
  CHECK (sensitive = 0 OR client_visible = 0),
  UNIQUE (profile_id, order_id, id),
  FOREIGN KEY (profile_id, order_id)
    REFERENCES os_orders(profile_id, id)
);

CREATE INDEX os_people_order_page
  ON os_people(profile_id, order_id, archived_at, created, id);

CREATE INDEX os_people_contact
  ON os_people(profile_id, contact_id, order_id);

CREATE INDEX os_people_phone
  ON os_people(profile_id, phone, order_id);
```

### `0103_os_documents.sql`

```sql
CREATE TABLE os_documents (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  mime_type TEXT NOT NULL CHECK (length(mime_type) BETWEEN 1 AND 120),
  expected_bytes INTEGER NOT NULL
    CHECK (expected_bytes BETWEEN 1 AND 10485760),
  byte_length INTEGER,
  sha256 TEXT,
  r2_key TEXT,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'ready', 'aborted')),
  upload_attempt TEXT,
  upload_request_key TEXT,
  upload_lease_until INTEGER,
  upload_expires_at INTEGER NOT NULL,
  source_message_id TEXT,
  source_media_id TEXT,
  client_visible INTEGER NOT NULL DEFAULT 0
    CHECK (client_visible IN (0, 1)),
  sensitive INTEGER NOT NULL DEFAULT 0
    CHECK (sensitive IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  archived_at INTEGER,
  CHECK (sensitive = 0 OR client_visible = 0),
  CHECK (state <> 'ready' OR
         (r2_key IS NOT NULL AND
          byte_length = expected_bytes AND
          sha256 IS NOT NULL)),
  UNIQUE (profile_id, order_id, id),
  UNIQUE (profile_id, r2_key),
  UNIQUE (profile_id, order_id, source_media_id),
  FOREIGN KEY (profile_id, order_id)
    REFERENCES os_orders(profile_id, id)
);

CREATE INDEX os_documents_order_page
  ON os_documents(profile_id, order_id, archived_at, created, id);

CREATE INDEX os_documents_pending
  ON os_documents(profile_id, upload_expires_at, id)
  WHERE state = 'pending';

CREATE INDEX os_documents_source
  ON os_documents(profile_id, source_message_id);
```

### `0104_os_entries.sql`

```sql
CREATE TABLE os_entries (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 64),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 4000),
  quantity_milli INTEGER
    CHECK (quantity_milli IS NULL OR
           quantity_milli BETWEEN 0 AND 1000000000000),
  unit TEXT NOT NULL DEFAULT '' CHECK (length(unit) <= 32),
  occurred_at INTEGER NOT NULL,
  replaces_id TEXT,
  client_visible INTEGER NOT NULL DEFAULT 0
    CHECK (client_visible IN (0, 1)),
  sensitive INTEGER NOT NULL DEFAULT 0
    CHECK (sensitive IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  archived_at INTEGER,
  CHECK (sensitive = 0 OR client_visible = 0),
  UNIQUE (profile_id, order_id, id),
  FOREIGN KEY (profile_id, order_id)
    REFERENCES os_orders(profile_id, id),
  FOREIGN KEY (profile_id, order_id, replaces_id)
    REFERENCES os_entries(profile_id, order_id, id)
);

CREATE INDEX os_entries_order_page
  ON os_entries(profile_id, order_id, archived_at, occurred_at, id);

CREATE INDEX os_entries_kind
  ON os_entries(profile_id, order_id, kind, occurred_at, id);

CREATE INDEX os_entries_replaces
  ON os_entries(profile_id, order_id, replaces_id);
```

### `0105_os_area_templates.sql`

Esta migração pertence à implementação dos modelos, na fase 3. O número fica reservado desde a fase 0.

```sql
CREATE TABLE os_area_template_applications (
  profile_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL CHECK (template_version > 0),
  manifest_hash TEXT NOT NULL,
  seen_ids_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(seen_ids_json) AND
           json_type(seen_ids_json) = 'array'),
  seen_paths_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(seen_paths_json) AND
           json_type(seen_paths_json) = 'array'),
  applied_by TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, template_id)
);

CREATE INDEX os_area_template_applications_date
  ON os_area_template_applications(profile_id, applied_at);
```

### Regras de persistência

| Tema | Contrato |
|---|---|
| Isolamento | Toda consulta nova inclui `profile_id`. Filhos também incluem `order_id`. ID global não substitui essa conferência. |
| Criação | Reservar contadores, inserir ordem e inserir histórico no mesmo lote transacional. Não usar `MAX(number) + 1`. |
| Repetição | Conferir a chave idempotente antes de incrementar contadores. Lacunas são aceitáveis; reutilização de números não é. |
| Limite numérico | Ao esgotar uma sequência, responder `409 sequence_exhausted`. |
| Concorrência da ordem | Alterar com `WHERE profile_id=? AND id=? AND row_version=?`. Incrementar versão no mesmo comando. |
| Concorrência de filho | Conferir versão do próprio filho. Não exigir a versão do pai para editar filhos independentes. |
| Histórico | Gravar alteração e histórico no mesmo lote. Usar `mutation_key` para reconhecer uma alteração já confirmada após falha de resposta. |
| Conteúdo do histórico novo | Guardar IDs, versões, transições e nomes de campos alterados. Não copiar valores sensíveis, textos de documentos ou dados de pessoas. |
| Atividade do pai | Alterar `updated` e limpar o aviso de paralisação quando houver atividade de um filho. Isso não altera a versão lógica dos campos e da etapa do pai. |
| Exclusão | Usar arquivamento. Não apagar ordens, filhos ou histórico pelas rotas deste contrato. |
| Lançamentos | Texto, quantidade e data são imutáveis. Correção cria outro lançamento com `replaces_id` e arquiva o anterior no mesmo lote. |
| Pessoas | Vincular uma pessoa não concede acesso à ordem. O titular continua sendo o cliente da ordem. |
| Eventos | Publicar com chave estável por entidade e versão. Uma repetição após confirmação no D1 deve concluir a publicação pendente, sem repetir a alteração. |

A busca atual de idempotência da criação usa apenas `source_key`. O trecho deve passar a conferir também a área antes de devolver uma ordem. Fonte: `src/modules/os/store.ts:353`. Não se deve converter chaves antigas por migração.

## 5. API

### Convenções

Neste capítulo:

- `P` significa `/api/v1/profiles/{profile}`.
- `B` significa `P/service-orders`.
- `O` significa `B/{id}`.
- `Order` significa a resposta atual acrescida de `WorkOrderAdditions`.
- `MutationRef` significa `{ id, order_id, version }`.
- `Page<T>` significa `{ data: T[], next_cursor: string | null }`.

As escritas JSON continuam no `Coordinator`, com `Idempotency-Key`. Esse é o contrato atual de `onCommand` e `onRoute`. Fontes: `src/modules/api.ts:1112`; `src/modules/api.ts:1152`.

Para operações novas, o núcleo deve repassar todos os parâmetros de caminho. Parâmetros do caminho prevalecem sobre valores homônimos do corpo. `profile` nunca vem do corpo.

### Resposta e contagem compatíveis

| Campo | Regra |
|---|---|
| `status` | Sempre um dos nove estados. |
| `status_label` | Rótulo atual do estado de base. |
| `counts` | Mapa esparso dos nove estados, referente à área inteira. Sem registros significa chave ausente. |
| `number` | Número global atual. |
| `next_cursor` | Texto com o número global ou nulo. |
| `item`, `problem` | Continuam sendo textos. |
| `next_statuses` | Somente códigos de base e somente ações antigas não ambíguas. |
| `type_id`, `type_revision` | Identificação do tipo usado pela ordem. |
| `type_number` | Sequência do tipo. Para linha antiga, reserva de leitura igual a `number`. |
| `stage`, `stage_label` | Etapa própria e seu rótulo. |
| `labels` | Vocabulário da cópia do tipo. |
| `extra` | Somente valores não sensíveis autorizados para o solicitante. |
| `fields` | Somente definições correspondentes aos campos autorizados. |
| `version` | Versão da ordem. |
| `next_stages` | Transições próprias que o solicitante pode executar ou solicitar. |

Não preencher `counts` com nove zeros. O teste atual exige o mapa esparso. Fonte: `tests/os-orders.test.ts:249`.

### Rotas existentes e catálogo de tipos

| Método e rota | Corpo ou consulta | Resposta | Erros específicos |
|---|---|---|---|
| `GET B` | Filtros atuais; acrescenta `type_id`, `stage`, `facets=1`. `stage` exige `type_id`. | Lista atual com `Order[]`, cursor e `counts`. `facets=1` acrescenta contagens por tipo e, quando houver tipo selecionado, por etapa. | `400 invalid_filter`; demais erros atuais. |
| `GET B/types` | `include_archived=1`, somente equipe. | `{ data: WorkTypeView[], settings_revision }`. Inclui o embutido. | `403 forbidden`. |
| `GET B/types/{type_id}` | Sem corpo. | Tipo atual resolvido e filtrado para o solicitante. | `404 type_not_found`. |
| `GET O` | `history=legacy` por padrão; `history=none` para a tela nova. | `Order`. | `404 not_found`. |
| `GET O/history` | `cursor`, `limit`, máximo 100. | Página do histórico completo, incluindo filhos. | `400 invalid_cursor`. |
| `POST B` | Corpo atual; acrescenta `type_id?` e `extra?`. | `Order`. | `404 type_not_found`; `409 type_archived`; `400 invalid_fields`. |
| `PATCH O` | Campos atuais; acrescenta `extra?` e `version?`. | `Order`. | `409 version_conflict`; `400 immutable_field`. |
| `POST O/status` | Corpo atual: `status`, `note?`. | `Order`. | Em tipo personalizado, `409 stage_required` se não houver correspondência única. |
| `POST O/stage` | `{ transition_id, version, note? }`. | `Order`. | `409 invalid_transition`; `409 version_conflict`; `409 approval_required`. |
| `PUT O/quote` | Corpo atual. | `Order`. | `409 feature_disabled` ou erros atuais. |
| `POST O/quote/send` | Corpo atual. | `Order`. | `409 feature_disabled` ou erros atuais. |
| `POST O/decision` | Corpo atual: `decision: "approve" \| "decline"`, `note?`. | `Order`; a decisão continua retornando `approved` ou `declined`. | Erros atuais de pendência e validade. |
| `POST O/stage-approval` | `{ transition_id, version }`. | `Order` com pedido pendente. | `409 approval_pending`; `409 invalid_transition`. |
| `POST O/stage-approval/decision` | `{ decision: "approve" \| "decline", approval_version, version }`. | `Order`. | `409 approval_expired`; `409 approval_not_pending`; `409 version_conflict`. |
| `GET O/private-fields` | Sem corpo. | `{ id, version, extra }`, somente campos sensíveis autorizados. | `403 sensitive_forbidden`. |
| `PATCH O/private-fields` | `{ version, extra }`. | `{ id, version, changed_fields }`. Não devolve valores. | `403 sensitive_forbidden`; `409 version_conflict`; `400 invalid_fields`. |

`WorkTypeView` é a definição resolvida, sem valores de ordens e com os campos sensíveis omitidos de quem não tem acesso. A configuração integral continua sendo administrativa.

As rotas estáticas `types` e `conversation` devem ser registradas antes da rota genérica de detalhe.

O histórico embutido das operações antigas conserva o formato e o conjunto de registros atual. A consulta paginada nova apresenta também os eventos dos filhos. O painel novo deve usar `history=none` e buscar o histórico paginado.

### Comportamento de `/status` em tipos personalizados

Uma transição é compatível com `/status` quando todas estas condições forem verdadeiras:

| Condição | Obrigação |
|---|---|
| Origem | É a etapa atual. |
| Destino | Existe uma única transição manual elegível para o estado solicitado. |
| Aprovação | Não exige aprovação do cliente. |
| Estado | O destino altera o estado de base. |
| Orçamento | Não contorna uma operação protegida de orçamento. |

Se não houver correspondência, usar `invalid_transition`. Se houver ambiguidade ou uma ação própria de etapa, usar `stage_required`.

Não escolher a primeira transição da lista.

Uma transição entre duas etapas de `in_progress`, por exemplo, aparece somente em `next_stages`. `status` continua sendo `in_progress`.

### Contratos dos filhos

Todos os filhos retornam `id`, `order_id`, `version`, datas e os campos autorizados. Não retornam `profile_id` como fonte de autorização.

| Entidade | Campos de criação |
|---|---|
| Tarefa | `title`, `description?`, `assignee?`, `audience`, `due_at?`, `remind_at?`, `client_visible`, `sensitive`. |
| Pessoa | `role`, `name`, `contact_id?`, `phone?`, `email?`, `note?`, `client_visible`, `sensitive`. |
| Documento | `name`, `mime_type`, `expected_bytes`, `client_visible`, `sensitive`. |
| Lançamento | `kind`, `text`, `quantity_milli?`, `unit?`, `occurred_at`, `client_visible`, `sensitive`. |

| Método e rota | Corpo ou consulta | Resposta | Erros específicos |
|---|---|---|---|
| `GET O/tasks` | `state?`, `cursor?`, `limit?`. | `Page<Task>`. | `400 invalid_filter`. |
| `POST O/tasks` | Campos de tarefa. | `MutationRef`. | `400 invalid_task`; `409 feature_disabled`. |
| `PATCH O/tasks/{task_id}` | `version` e campos alterados; admite `state`. | `MutationRef`. | `409 version_conflict`; `400 invalid_task`. |
| `POST O/tasks/{task_id}/archive` | `{ version }`. | `MutationRef`. | `409 version_conflict`. |
| `GET O/people` | `cursor?`, `limit?`. | `Page<LinkedPerson>`. | Erros comuns. |
| `POST O/people` | Campos de pessoa. | `MutationRef`. | `400 invalid_person`; `404 contact_not_found`. |
| `PATCH O/people/{person_id}` | `version` e campos alterados. | `MutationRef`. | `409 version_conflict`. |
| `POST O/people/{person_id}/archive` | `{ version }`. | `MutationRef`. | `409 version_conflict`. |
| `GET O/documents` | `cursor?`, `limit?`. | `Page<DocumentMetadata>`. | Erros comuns. |
| `POST O/documents` | Metadados de documento. | `{ id, order_id, version, upload_url, expires_at }`. | `413 document_too_large`; `415 unsupported_media_type`. |
| `PUT O/documents/{document_id}/content` | Corpo binário; `Idempotency-Key`; versão em `Upload-Version`. | `{ id, version, upload_attempt, byte_length, sha256 }`. | `409 upload_busy`; `409 upload_expired`; `413 document_too_large`. |
| `POST O/documents/{document_id}/complete` | `{ version, upload_attempt }`. | `MutationRef`. | `409 upload_incomplete`; `409 content_mismatch`. |
| `GET O/documents/{document_id}/content` | Sem corpo. | Binário autenticado, com `Cache-Control: no-store`. | `404 not_found`; `409 document_not_ready`. |
| `POST O/documents/{document_id}/send` | `{ version }`. | `{ id, message_id }`. | `403 document_not_shareable`; `409 no_conversation`. |
| `POST O/documents/{document_id}/archive` | `{ version }`. | `MutationRef`. | `409 version_conflict`. |
| `GET O/entries` | `kind?`, `cursor?`, `limit?`, `include_archived?`. | `Page<Entry>`. | `400 invalid_filter`. |
| `POST O/entries` | Campos de lançamento. | `MutationRef`. | `400 invalid_entry`; `409 feature_disabled`. |
| `POST O/entries/{entry_id}/revisions` | `version` do anterior e campos completos da correção. | `MutationRef` do novo lançamento. | `409 version_conflict`; `409 entry_replaced`. |
| `POST O/entries/{entry_id}/archive` | `{ version }`. | `MutationRef`. | `409 version_conflict`. |

Listas filhas usam limite padrão 50 e máximo 100. O cursor opaco contém a última chave de ordenação e o ID. Deve ser validado contra área, ordem, coleção e filtros. Não usar `OFFSET`.

Limites por ordem: 500 tarefas, 200 pessoas, 500 documentos e 10.000 lançamentos. O limite conta registros arquivados. Novas inclusões acima dele retornam `409 collection_limit`. A conferência ocorre no comando serializado.

### Documentos e R2

O R2 existente é `env.MEDIA`. Fonte: `src/types.ts:3`.

Documentos privados não devem ser expostos como mídia comum. A autorização atual de mídia permite leitura humana por área e tem regras próprias para aplicações. Ela não consulta o sigilo de um documento de OS. Fonte: `src/media.ts:162`.

| Etapa | Contrato |
|---|---|
| Reserva | Criar metadados pendentes. Upload expira em 24 horas. |
| Envio | Reservar uma tentativa no `Coordinator`. A tentativa usa uma chave R2 nova e privada. A chave não vem do cliente. |
| Exclusividade | A tentativa tem concessão de cinco minutos. Outra tentativa ativa retorna `upload_busy`. |
| Conteúdo | Limitar a 10 MiB. Conferir tamanho real. Calcular SHA-256 no servidor. |
| Repetição | A mesma chave idempotente recupera a tentativa já concluída. Não sobrescreve um objeto confirmado. |
| Confirmação | Conferir tentativa atual, objeto, tamanho e hash. Só então mudar para `ready`. |
| Falha | Objeto pendente não pode ser baixado. Limpeza posterior trata tentativas expiradas e objetos órfãos por prefixo. |
| Download | Conferir área, ordem, documento, classificação e solicitante antes de abrir o objeto. |
| Envio ao WhatsApp | Exigir `client_visible=true`, `sensitive=false` e autorização de mensagem. Usar o adaptador de mídia do núcleo para criar o anexo de saída. |
| Arquivamento | Retirar das listas correntes. Não apagar imediatamente o objeto. A política de eliminação definitiva fica fora destas fases. |

O adaptador atual de leitura dos módulos sempre produz JSON. Portanto, a integração deve acrescentar um registro de resposta binária e um adaptador de upload. Não basta devolver um `Response` por `onRead`. Fonte: `src/index.ts:1896`.

### Autorização e erros comuns

| Situação | Resposta |
|---|---|
| Corpo inválido | `400 invalid_request`, com indicação do caminho do campo, sem repetir seu valor sensível. |
| Escopo insuficiente | `403 forbidden`. |
| Acesso sensível sem papel | `403 sensitive_forbidden`. |
| Ordem ou filho fora da área ou do titular permitido | `404 not_found`. |
| Módulo desligado | `409 module_disabled`. |
| Recurso desligado no tipo | `409 feature_disabled`. |
| Versão desatualizada | `409 version_conflict`. |
| Tamanho excedido | `413 payload_too_large`. |
| Limitação de frequência | `429 rate_limited`, quando aplicada pelo núcleo. |

Leitura comum usa `conversations:read`. Escrita comum usa `conversations:write`. As restrições de contatos e notas continuam valendo.

Dados sensíveis exigem pessoa autenticada, papel explícito `os:sensitive` e ausência de atuação por bot. Aplicações, conectores, identidades `bot:*` e qualquer ator com `via` não recebem esses dados. O papel administrativo não substitui a concessão explícita.

O contrato atual de concessões não dá automaticamente todos os papéis ao administrador. Fonte: `src/modules/api.ts:403`.

### API limitada ao cliente

| Método e rota | Consulta | Resposta |
|---|---|---|
| `GET B/conversation/{id}` | `open?`, `type_id?`. | Ordens do cliente da conversa, sem campos internos ou sensíveis novos. |
| `GET B/conversation/{id}/orders/{order_id}` | Sem corpo. | Projeção pública da ordem. |
| `GET B/conversation/{id}/orders/{order_id}/tasks` | `cursor?`, `limit?`. | Somente tarefas visíveis ao cliente. |
| `GET B/conversation/{id}/orders/{order_id}/documents` | `cursor?`, `limit?`. | Somente metadados de documentos compartilháveis. |
| `GET B/conversation/{id}/orders/{order_id}/entries` | `cursor?`, `limit?`. | Somente lançamentos visíveis ao cliente. |

Essas rotas não aceitam telefone como substituto de identidade. A conversa vem da credencial e é conferida no servidor. Todas precisam entrar expressamente na lista de rotas permitidas para credenciais limitadas à conversa. A lista atual fica em `src/index.ts:1103`.

Os filhos nunca ampliam o conjunto de titulares. Ser tutor, responsável, advogado ou contratante registrado em `os_people` não concede acesso automaticamente.

## 6. WhatsApp, mensagens e proteção contra acesso da IA

### Referência dos menus

**Contrato proposto:** ampliar `ModuleMenuType.reference` de forma aditiva:

```ts
export interface ModuleMenuReference {
  field: string;
  setting: string;
  label: string;
  default_id?: string;
  builtins?: Array<{ id: string; label: string }>;
}
```

Os dois menus de OS declararão:

```ts
reference: {
  field: "type_id",
  setting: "os_work_types",
  label: "Tipo de trabalho",
  default_id: "service_order",
  builtins: [
    { id: "service_order", label: "Ordem de serviço" }
  ]
}
```

| Situação | Resultado |
|---|---|
| Menu antigo sem `type_id` | Continua apontando para `service_order`. |
| Menu com `type_id: "service_order"` | Usa o tipo virtual. |
| Menu com tipo personalizado existente | Usa esse tipo. |
| `os_open` para tipo arquivado | Não pode ser criado ou salvo como menu ativo. Menu já existente responde indisponibilidade sem abrir ordem. |
| `os_track` para tipo arquivado | Pode continuar acompanhando ordens existentes. |
| Dois menus `os_open` | São distintos pelo par `(type, type_id)`. |

A mudança é necessária porque a validação atual exige encontrar o ID dentro da lista de configuração, e o tipo embutido não estará nessa lista. Fonte: `src/service.ts:2101`.

### Abertura

| Etapa | Contrato |
|---|---|
| Seleção | Resolver `type_id` pelo item de menu. |
| Formulário | Usar rótulos do tipo. Manter item e problema. Acrescentar apenas campos públicos e não sensíveis. |
| Referência | Gravar no `ref` do passo web o tipo, sua revisão e a definição necessária para concluir aquela abertura. |
| Validação | Validar respostas antes de concluir o passo. |
| Mudança posterior do tipo | Concluir com a definição fixada no passo. Se o tipo tiver sido arquivado, recusar nova abertura. |
| Termos | Fixar o texto efetivamente apresentado ao cliente. |
| Repetição | Usar a identidade do passo como chave idempotente. |
| Embutido | Preservar o fluxo e os textos atuais. |

O formulário genérico admite até 30 campos. Com 24 extras, dois campos fixos e um aceite, o limite proposto permanece dentro desse teto. Fonte: `docs/MODULOS.md:785`.

Campos numéricos podem usar entrada textual no passo web, com conversão estrita no servidor. Booleanos usam escolha explícita “Sim” ou “Não”. Não usar o aceite obrigatório como booleano genérico.

### Marcadores

| Marcador | Valor |
|---|---|
| `{numero}` | Número global. Preservado. |
| `{item}` | Campo fixo `item`. Preservado. |
| `{estado}` | Rótulo do estado de base. Preservado. |
| `{total}`, `{validade}`, `{garantia}`, `{pronto}`, `{previsao}` | Significados atuais. |
| `{tipo}` | Nome singular do tipo. |
| `{etapa}` | Rótulo da etapa própria. |
| `{numero_tipo}` | Número na sequência do tipo. |
| `{identificador}` | Prefixo do tipo e número por tipo. |
| `{campo_ID}` | Valor de campo extra público e não sensível. |

O preenchimento atual deixa marcadores desconhecidos intactos. Esse comportamento deve continuar para os textos antigos de `service_orders`. A validação estrita de marcadores vale para os textos dos tipos novos. Fonte: `src/modules/os/model.ts:300`.

Ao entrar em uma etapa personalizada, enviar no máximo uma mensagem de etapa. Trocar entre etapas do mesmo estado também pode enviar essa mensagem. As notificações de orçamento continuam sendo produzidas pelo protocolo de orçamento.

A chave de envio deve incluir ordem, versão e evento. Isso impede duplicação por repetição do comando.

### Aprovações

| Fluxo | Identificação e regra |
|---|---|
| Orçamento embutido | Preservar os botões `os:<id>:<quote_version>:<approve|decline>` e as respostas textuais atuais. |
| Orçamento personalizado | Mesmo protocolo, com as etapas da política de orçamento. |
| Aprovação de etapa | Usar prefixo distinto, como `os:stage:<id>:<approval_version>:<approve|decline>`. |
| Conferência | Exigir mesma ordem, titular, etapa de origem, versão de aprovação e prazo válido. |
| Recusa da etapa | Registrar recusa e conservar a etapa de origem. |
| Grupo | Não aceitar abertura ou aprovação vinculada a grupo. |
| Ambiguidade textual | Pedir identificação da ordem. Não escolher pelo número local do tipo sem identificar o tipo. |

O número global continua sendo a forma textual inequívoca para os comandos legados. As verificações atuais de orçamento estão em `src/modules/os/store.ts:900`.

Aprovar uma etapa significa autorizar sua transição. Não constitui assinatura de documento, aceite de conteúdo clínico ou contagem de prazo jurídico.

### Documentos e tarefas pelo WhatsApp

| Ação | Contrato |
|---|---|
| Consultar tarefas | Mostrar somente tarefas públicas do titular. Separar pendentes e concluídas. |
| Enviar documento ao cliente | Somente documento pronto, público e não sensível. |
| Receber documento | Usar mensagem com identificação inequívoca da ordem, por exemplo `DOCUMENTO <numero_global>`, e anexo da mesma mensagem. |
| Vinculação do anexo | Resolver a mídia a partir da mensagem recebida e da conversa autenticada. Não aceitar um `media_id` arbitrário fornecido pelo texto ou pela IA. |
| Falta de identificação | Pedir a ordem. Não vincular automaticamente à mais recente. |
| Entrada sensível | O canal comum de anexos não oferece captura privada. Documento classificado como sensível deve entrar pelo painel autenticado. |
| Repetição | A combinação ordem e mídia de origem impede anexação duplicada. |

O gancho atual de conversa recebe texto, resposta interativa e ID da mensagem, mas não uma lista autorizada de anexos. A integração deverá fornecer uma função do núcleo para resolver os anexos daquela mensagem. Fonte: `src/modules/api.ts:1347`.

### Onde a proteção precisa ser implementada

**Não existe hoje uma barreira suficiente para campos extras sensíveis.**

| Ponto atual | Limitação | Alteração exigida |
|---|---|---|
| `src/modules/os/store.ts:166` | Filtra contatos e notas conhecidos. | Aplicar uma projeção baseada na definição do tipo e na classificação dos filhos. |
| `src/modules/api.ts:130` | O conjunto de nomes ocultos é fixo. | Não depender de nomes como `diagnostico` ou `cpf` para classificar dados. |
| `src/modules/api.ts:577` | A filtragem genérica pode ser dispensada em determinados contextos não mascarados. | Para dados sensíveis, bloquear qualquer atuação por bot, inclusive `via` sem máscara. |
| `src/modules/types.ts:97` | `bot.sensitive` exige segundo fator para operações. | Não tratá-lo como mecanismo de sigilo de dados. |
| `src/bot-actions/describe.ts:36` | A descrição genérica pode formatar parâmetros recebidos. | Operações privadas ficam fora do catálogo. Operações comuns rejeitam valores sensíveis. |
| `docs/MODULOS.md:817` | Respostas de passos web podem alimentar registros e mensagens do fluxo. | Não colocar campos sensíveis em passos web comuns. |
| `src/media.ts:162` | Autorização de mídia comum não conhece sigilo de OS. | Usar armazenamento e download privados dos documentos. |

A projeção única ficará em `src/modules/os/privacy.ts`. Ela deve ser usada nas leituras, respostas de comandos, ações de conversa, ferramentas, histórico, eventos e construção de mensagens.

As rotas privadas e operações correspondentes entram em `bot.deny`. A conferência também ocorre no manipulador. A ausência no catálogo não é autorização suficiente.

Para os recursos novos:

- Eventos levam IDs, versões e códigos. Não levam valores sensíveis.
- Histórico leva nomes de campos alterados, sem seus valores.
- Respostas de escritas privadas levam referências, sem conteúdo.
- Busca não pesquisa campos sensíveis.
- Contagens não revelam a existência de filhos ocultos.
- Mensagens usam uma lista explícita de valores públicos.
- O acesso por telefone nunca é ampliado pela lista de pessoas ligadas.

## 7. Modelo de área

Esta seção congela o contrato da fase 3. Ela não antecipa prontuário, ensino, prazos forenses ou unidades de condomínio.

O precedente atual distingue configuração de runtime e aplica alterações pela operação comum de configurações. Fontes: `src/service-templates.ts:14`; `src/service-templates.ts:445`.

### Formato declarativo

```ts
export type AreaModuleId =
  | "os"
  | "queue"
  | "forms"
  | "agenda"
  | "reserva"
  | "pedido"
  | "mensalidade"
  | "suporte"
  | "mesas"
  | "entrega"
  | "payments"
  | "erp";

export type TemplateMenu =
  | {
      id: string;
      label: string;
      type: "os_open" | "os_track";
      type_id: string;
    }
  | {
      id: string;
      label: string;
      type: "human";
      department_id: string | null;
    }
  | {
      id: string;
      label: string;
      type: "message";
      content: string;
    };

export interface AreaBotSuggestion {
  instructions: string;
  allowed_operations: string[];
  denied_operations: string[];
  suggested_roles: string[];
}

export interface AreaSetup {
  template_id: string;
  bot: AreaBotSuggestion;
  manual_steps: string[];
}

export interface AreaTemplate {
  schema_version: 1;
  id: string;
  version: number;
  name: string;
  description: string;

  work_types: CustomWorkType[];
  modules: Partial<Record<AreaModuleId, boolean>>;
  vocabulary: OsVocabulary;

  departments: Array<{
    id: string;
    name: string;
    members: [];
    enabled: true;
  }>;

  ticket_categories: Array<{
    id: string;
    name: string;
    enabled: true;
  }>;

  menus: TemplateMenu[];

  texts: {
    instructions?: string;
    menu_greeting?: string;
    protocol_confirmation?: string;
  };

  bot: AreaBotSuggestion;
  manual_steps: string[];
}

export type AreaTemplateSource =
  | { template_id: string; manifest?: never }
  | { manifest: AreaTemplate; template_id?: never };

export interface AreaTemplateSelection {
  work_type_ids: string[];
  module_ids: AreaModuleId[];
  menus: boolean;
  departments: boolean;
  ticket_categories: boolean;
  vocabulary: boolean;
  texts: boolean;
  bot_suggestions: boolean;
}

export interface TemplateChange {
  path: string;
  action: "add" | "set" | "keep" | "skip";
  reason: string;
}

export interface AreaTemplatePreview {
  preview_hash: string;
  template_id: string;
  template_version: number;
  changes: TemplateChange[];
  conflicts: Array<{
    path: string;
    code: string;
    message: string;
  }>;
  manual_steps: string[];
  can_apply: boolean;
}

export type AreaTemplatePreviewRequest = AreaTemplateSource & {
  selection: AreaTemplateSelection;
};

export type AreaTemplateApplyRequest = AreaTemplatePreviewRequest & {
  preview_hash: string;
};
```

Os IDs de módulos precisam ser conferidos pelo registro, não apenas pela união TypeScript. A resolução atual de dependências está em `src/modules/registry.ts:77`.

`AreaSetup[]` será salvo na chave validada `os_area_setup`. Ela guarda sugestões e pendências. Aplicar modelo não concede papéis a pessoas e não amplia permissões de um bot já conectado.

### Rotas

As rotas de modelos pertencem ao núcleo administrativo. Precisam funcionar com `os` desligado, pois aplicar um modelo pode ligá-lo.

| Método e rota | Corpo | Resposta | Erros |
|---|---|---|---|
| `GET P/area-templates` | — | Catálogo resumido. | `403 forbidden`. |
| `GET P/area-templates/{template_id}` | — | Manifesto declarativo. | `404 template_not_found`. |
| `POST P/area-templates/preview` | `AreaTemplatePreviewRequest`. | `AreaTemplatePreview`. Não grava nada. | `400 invalid_template`; `413 template_too_large`. |
| `POST P/area-templates/apply` | `AreaTemplateApplyRequest`; `Idempotency-Key`. | `{ applied, changes, manual_steps, settings_revision }`. | `409 preview_stale`; `409 template_conflict`; `409 dependency_conflict`. |
| `POST P/area-templates/export` | `{ id, name, type_ids }`. | `AreaTemplate`. Não grava nada. | `400 invalid_export`; `404 type_not_found`. |

A importação usa `manifest` nas rotas de prévia e aplicação. Não executa código.

O manifesto importado tem limite de 128 KiB. A configuração resultante também precisa passar pelos limites da seção 3 e pelos limites do núcleo.

### IDs e reaplicação

| Regra | Comportamento |
|---|---|
| Prefixo | IDs globais criados pelo modelo usam `area_<template_id>__<id_local>`. |
| Escopo local | IDs de campos, etapas e transições permanecem locais ao tipo. |
| Referências | A compilação do modelo reescreve referências entre tipos, menus, setores e categorias. |
| Tipo embutido | É referenciado por `service_order`. Não é copiado ou renomeado. |
| Colisão sem procedência | Se o prefixo já existir sem registro de aplicação correspondente, retornar conflito. |
| Cadastro já existente | Preservar seu conteúdo. Não sobrescrever uma edição manual. |
| Campo escalar já preenchido | Preservar. A prévia mostra `keep`. |
| Item apagado depois da aplicação | Não recriar na reaplicação. `seen_ids_json` registra que ele já foi tratado. |
| Campo escalar removido depois | Não repor automaticamente. `seen_paths_json` registra que o caminho já foi tratado. |
| Segunda aplicação idêntica | Nenhuma alteração de negócio. Retornar `applied: false`. |
| Versão posterior do modelo | Acrescentar somente novos IDs e caminhos ainda não tratados. Preservar os anteriores. |
| Módulos | Aplicar a seleção mostrada na prévia na primeira aplicação daquele caminho. Reaplicação não desfaz mudanças manuais posteriores. |
| Dependências | Validar o estado final completo. Não desligar uma dependência necessária nem fazer cascata silenciosa. |

O modo `replace` dos modelos atuais não deve ser reutilizado aqui. Ele altera listas de forma incompatível com a regra de preservação. O comportamento de mesclagem e substituição existente está em `src/service-templates.ts:341` e `src/service-templates.ts:405`.

### Prévia e aplicação atômica

A prévia deve usar o mesmo planejador de configuração da aplicação. O hash inclui:

| Componente | Conteúdo |
|---|---|
| Manifesto | Versão e conteúdo normalizado. |
| Seleção | Tipos, módulos e blocos escolhidos. |
| Configuração atual | Revisão da configuração completa. |
| Módulos | Estado atual dos módulos envolvidos e suas dependências. |
| Procedência | Registro de aplicação anterior. |
| Resultado | Alterações e preservações calculadas. |

Ao aplicar, o `Coordinator` relê os dados e recalcula o hash. Divergência retorna `preview_stale`.

O núcleo deverá separar **planejamento e validação** de **persistência** no fluxo de configurações. A aplicação confirma, no mesmo lote D1:

1. Configuração final da área.
2. Estados finais de módulos.
3. Registro de aplicação do modelo.

Não executar uma sequência independente de `module.set` e depois `settings`. A validação atual rejeita menus de módulos desligados, e uma falha intermediária deixaria aplicação parcial. Fontes: `src/service.ts:2093`; `src/modules/registry.ts:257`.

A validação usa o estado final planejado dos módulos. Eventos e invalidação de cache ocorrem depois da confirmação.

## 8. Divisão em tarefas paralelas

### Contrato compartilhado antes do paralelismo

A tarefa F0 deve ser integrada antes das demais. Ela congela:

| Interface | Responsabilidade |
|---|---|
| `contracts.ts` | Tipos públicos deste documento. |
| `public.ts` | Acesso autorizado à ordem, resolução do tipo e serviços de persistência usados pelos filhos. |
| `privacy.ts` | Projeções para equipe, cliente e bot. |
| `extensions.ts` | Lista de extensões internas do motor. Somente o integrador altera os registros. |
| `commitChild` | Conferência de versão, alteração do filho, histórico e atividade do pai. |
| `runDue` de extensão | Recebe orçamento e limite de itens. Não registra um segundo agendador de `os`. |
| Adaptador binário | Autorização e transporte de conteúdo. Não altera metadados sem comando do `Coordinator`. |
| Planejador de configurações | Usado por `PUT /settings` e por aplicação de modelo. |
| Fixtures | Uma fixture comum congelada. Cada tarefa cria suas próprias extensões de teste. |

As peças novas são internas ao módulo `os`. Não são novos módulos de profissão e não criam classes de Durable Object.

### Propriedade dos arquivos

| Tarefa | Arquivos que cria | Arquivos existentes que pode alterar | Dependências | Testes que entrega |
|---|---|---|---|---|
| **F0 — contrato e integração do núcleo** | `src/modules/os/contracts.ts`; contrato de extensões; planejador comum de configuração; fixture comum de testes | Exclusividade sobre `src/modules/types.ts`, `src/modules/api.ts`, `src/modules/hooks.ts`, `src/modules/registry.ts`, `src/modules/runtime.ts`, `src/index.ts`, `src/service.ts`, `src/coordinator.ts` e `src/modules/os/definition.ts` | Nenhuma | Revisão de configuração; referências com tipo embutido; parâmetros de rotas filhas; transporte binário; um único agendador; aplicação com módulo inicialmente desligado |
| **M — motor: tipos, etapas e campos** | `work-types.ts`, `validation.ts`, `privacy.ts`, `public.ts`, auxiliares sob `src/modules/os/`; `0100_os_work_types.sql`; `tests/os-work-types.test.ts`; `tests/os-compatibility.test.ts` | Exclusividade sobre `src/modules/os/model.ts`, `store.ts`, `os.ts`, `reminders.ts` | F0 | Cópia de definição; estados; campos; números; concorrência; compatibilidade; privacidade; aprovações de etapa |
| **T — tarefas e prazos** | `src/modules/os/tasks/*`; `0101_os_tasks.sql`; `tests/os-tasks.test.ts` | Nenhum arquivo existente | F0; interfaces de M | CRUD; versões; prazo; destinatário; lembrete único; isolamento; privacidade |
| **P — pessoas ligadas** | `src/modules/os/people/*`; `0102_os_people.sql`; `tests/os-people.test.ts` | Nenhum arquivo existente | F0; interfaces de M | Cadastro; vínculo válido; contatos; arquivamento; ausência de concessão automática de acesso |
| **D — documentos** | `src/modules/os/documents/*`; `0103_os_documents.sql`; `tests/os-documents.test.ts`; `tests/os-document-privacy.test.ts` | Nenhum arquivo existente | F0 binário; interfaces de M | Reserva; upload; hash; repetição; falhas; isolamento; envio; download sensível; limpeza |
| **L — lançamentos** | `src/modules/os/entries/*`; `0104_os_entries.sql`; `tests/os-entries.test.ts` | Nenhum arquivo existente | F0; interfaces de M | Quantidade; data; correção; arquivamento; histórico; concorrência |
| **A — modelos de área** | `src/area-templates/*`; arquivos declarativos; `0105_os_area_templates.sql`; `tests/os-area-templates.test.ts` | Nenhum arquivo existente | F0 planejador; M | Prévia; hash; atomicidade; prefixos; preservação; reaplicação; importação e exportação |
| **W — painel web** | Novos componentes e testes em `web/modules/os/`; tela de modelos | Exclusividade sobre `web/modules/os/*`, `web/menu-tree.ts`, `web/admin/AdminArea.tsx`, `web/workspace-navigation.ts`, registros web de rotas e `web/modules/conversation.tsx` | Contratos de F0; DTOs de M, T, P, D, L e A | Renderização por tipo; etapas iguais no estado de base; campos; menus por tipo; conflitos; abas paginadas; privacidade |
| **O — OpenAPI e documentação** | Documento do motor, esquemas auxiliares e `tests/os-openapi-contract.test.ts` | Exclusividade sobre `src/modules/openapi.ts`, `docs/API.md`, `docs/MODULOS.md`, `docs/ORDEM-DE-SERVICO.md` | F0; contratos congelados das demais | Cobertura de rotas; corpos; respostas; erros; enumeração dos nove estados; exemplos compatíveis |
| **C — compatibilidade móvel** | Novos testes e fixtures nos diretórios de teste Android e iOS | Nenhum arquivo de produção móvel nesta fase | DTO de M; exemplos de O | Decodificação de campos extras; contagem esparsa; cursor; ações antigas; respostas reais do servidor |
| **I — junção e orçamento D1** | `tests/os-integration.test.ts`; `tests/os-d1-budget.test.ts` | Somente os arquivos de registro já pertencentes a F0 | Todas | Fluxos completos; falhas entre etapas; orçamento D1; registro único; ausência de regressão |

### Regras contra conflito

| Regra | Aplicação |
|---|---|
| Um dono por arquivo existente | A tabela acima prevalece. Outra tarefa envia proposta ao dono. |
| Registro central | Somente F0/I acrescenta imports e entradas. Acrescentar no fim do bloco de registro reservado. |
| Sem registro direto pelos filhos | T, P, D e L exportam descritores. Não alteram `runtime.ts`, `definition.ts`, `os.ts` ou o registro de agendadores. |
| Migração própria | Cada tarefa usa somente o número reservado. Não modifica `0035`. |
| Teste antigo intacto | A suíte existente não é adaptada para aceitar mudança do embutido. |
| Fixture comum congelada | Necessidades específicas ficam em fixtures locais da tarefa. |
| Integração por dependência | O trabalho dos filhos pode começar com as interfaces congeladas. A junção exige a implementação do motor. |
| Alteração de contrato | Mudança posterior exige revisão única de F0 e atualização coordenada dos consumidores. |

O requisito de agregação do agendador é funcional. Registrar quatro `onSchedule("os", ...)` não produz quatro tarefas; substitui registros. Fonte: `src/modules/hooks.ts:129`.

## 9. Plano de testes

### Suíte atual que protege o tipo embutido

Nenhum resultado de execução é afirmado aqui. Estes são os testes lidos e os comportamentos que devem continuar aprovados.

| Teste atual | Prova exigida |
|---|---|
| `tests/os-orders.test.ts:56` | Módulo desligado continua bloqueando rotas e ações. |
| `tests/os-orders.test.ts:100` | Abertura, resposta, evento e idempotência continuam iguais. |
| `tests/os-orders.test.ts:181` | Criação concorrente conserva números únicos e sequência esperada. |
| `tests/os-orders.test.ts:227` | Busca, filtros, contagem global esparsa e cursor continuam iguais. |
| `tests/os-orders.test.ts:265` | Transições permitidas e recusadas não mudam. |
| `tests/os-orders.test.ts:312` | Envio incrementa versão e mantém validade. |
| `tests/os-orders.test.ts:330` | Editar orçamento enviado volta a `analyzing`. |
| `tests/os-orders.test.ts:348` | Decisão, execução, retirada e garantia mantêm seu contrato. |
| `tests/os-orders.test.ts:368` | Histórico conserva sequência e tipos de registros. |
| `tests/os-orders.test.ts:396` | Encerrada continua aceitando somente observações. |
| `tests/os-orders.test.ts:412` | Orçamento vencido continua recusando decisão. |
| `tests/os-orders.test.ts:459` | Escopos e isolamento de área continuam válidos. |
| `tests/os-orders.test.ts:492` | Funções de dinheiro, telefone, ações e configuração continuam iguais. |
| `tests/os-orders.test.ts:523` | Rotas antigas continuam no OpenAPI. |
| `tests/os-orders.test.ts:542` | Configuração parcial continua parcial e estrita. |
| `tests/os-whatsapp.test.ts:116` | Formulário, termos, conclusão e repetição continuam iguais. |
| `tests/os-whatsapp.test.ts:184` | Acompanhamento continua usando identidade verificada. |
| `tests/os-whatsapp.test.ts:245` | Botões e respostas de orçamento continuam funcionando. |
| `tests/os-whatsapp.test.ts:301` | Versão antiga e ambiguidades não aprovam a ordem errada. |
| `tests/os-whatsapp.test.ts:373` | Janela de notificação e textos vazios continuam respeitados. |
| `tests/os-whatsapp.test.ts:424` | Retirada e paralisação continuam idempotentes. |
| `tests/module-sensitive-data.test.ts:75` | Contatos e notas continuam filtrados nas respostas atuais. |
| `tests/module-sensitive-data.test.ts:213` | Telefone alegado por integração não concede acesso. |
| `tests/module-query-limits.test.ts:12` | Limites e listas de filtros continuam normalizados. |
| `tests/b9-conferencia.test.ts:111` | Aplicação sem atendimento da conversa não envia avisos indevidos. |
| `tests/bot-tools-verticais.test.ts:256` | Ferramenta consulta somente ordens do cliente da conversa. |
| `tests/menu-module-types.test.ts:24` | O editor não troca tipos de menu desconhecidos ou desligados. |
| `mobile/android/app/src/test/java/br/com/queven/wabotia/modules/ServiceOrderTest.kt:35` | Ações, contagens e comprovante atuais continuam coerentes. |
| `mobile/ios/WabotiaTests/ServiceOrderTests.swift:12` | Contagens, rotas, ações e fluxos do cliente continuam compatíveis. |
| `mobile/ios/WabotiaTests/ServiceOrderReceiptTests.swift:10` | Comprovante conserva os campos públicos e omite notas internas. |

### Testes novos por tarefa

| Tarefa | Casos obrigatórios |
|---|---|
| F0 | Menu antigo sem referência; referência explícita ao embutido; referência inexistente; validação por revisão; corpo tentando sobrescrever IDs do caminho; registro de rota estática antes de `:id`; transporte binário autorizado. |
| M — migração | Banco com ordens em todos os nove estados; nenhuma conversão de linhas; etapa efetiva correta para cada linha antiga; número antigo preservado; configuração antiga ausente ou parcial. |
| M — tipos | Limites; propriedades desconhecidas; IDs duplicados; grafo inalcançável; etapa terminal com saída; revisão antiga; arquivamento; ID aposentado; tentativa de reduzir sigilo. |
| M — valores | Unicode; texto no limite; inteiro inseguro; decimal fora da escala; data inexistente; escolha inválida; campo desconhecido; obrigatório ausente; `false` e zero válidos. |
| M — compatibilidade | Mesmos dados antigos produzem os mesmos campos antigos, ações, mensagens e eventos. Desconsiderar somente as propriedades novas acrescentadas. |
| M — numeração | Duas áreas; dois tipos; criação concorrente; repetição antes e depois da confirmação; início após contador antigo; esgotamento de sequência. |
| M — etapas | Duas etapas com o mesmo estado; duas saídas para o mesmo estado; `/status` ambíguo; alteração de estado e etapa atômica; datas não reiniciadas indevidamente. |
| M — revisões | Editar tipo não muda ordem existente; formulário aberto usa sua definição fixada; tipo arquivado impede nova abertura, mas mantém acompanhamento. |
| M — aprovação | Botão antigo; outro telefone; outro perfil; prazo vencido; alteração da ordem; recusa sem transição; repetição da decisão. |
| T | Lembrete antes, no momento e depois do prazo; reprogramação; conclusão; cancelamento; responsável removido; destinatário cliente; repetição após falha; lote limitado. |
| P | Contato de outra área; papel livre validado; telefone normalizado; ausência de acesso automático; ocultação de telefone sem escopo; pessoa sensível invisível ao bot. |
| D | Tamanho real diferente; hash calculado no servidor; tipo não permitido; upload incompleto; tentativa concorrente; concessão expirada; repetição; objeto órfão; documento sensível pelo endpoint comum; envio público; envio recusado por sigilo. |
| L | Quantidade em milésimos; valores fora do intervalo; data; correção concorrente; cadeia de substituições; texto anterior preservado; ausência de lançamento financeiro automático. |
| A | Prévia sem escrita; configuração modificada entre prévia e aplicação; falha transacional; dependência desligada; prefixo ocupado; segunda aplicação sem alterações; edição manual preservada; item apagado não recriado; exportação sem dados pessoais. |
| W | Campos dinâmicos; etapas agrupadas no mesmo estado; ações pelo ID de transição; edição em conflito; menu por tipo; abas carregadas sob demanda; ausência de campos privados no DOM sem autorização. |
| O | Todas as rotas documentadas; esquemas antigos mantidos; enumeração de estados fechada; `counts` sem propriedades extras; exemplos completos de erro e compatibilidade. |
| C | Os DTOs antigos decodificam respostas ampliadas; cursor continua texto; chaves de contagem permanecem exatas; campos adicionais não somem com a linha; orçamento conserva entrada e saída distintas. |
| I | Criar ordem, tarefa, pessoa, documento e lançamento; trocar etapa; reiniciar ou repetir operações; verificar histórico, eventos, mensagens e consumo D1. |

A suíte nova de privacidade deve usar um valor sentinela exclusivo em cada campo sensível. Ela deve procurar esse valor em respostas comuns, respostas para bot, eventos, histórico, mensagens, propostas, metadados de mídia e conteúdo de passos web.

A aprovação exige ausência do valor em todos esses caminhos. Conferir somente a tela não basta.

## 10. Riscos, dúvidas e orçamento D1

### Limite conhecido na base local

A documentação do repositório informa que o Wabotia exige Workers Paid. Ela registra limite de **1.000 consultas D1 por invocação**, contra 50 no plano gratuito. Fontes: `docs/LIMITES.md:5`; `docs/LIMITES.md:14`.

A vigência externa desses limites em 18/11/2026 está **a conferir**. Não houve consulta à rede.

Worker, chamada ao `Coordinator` e alarme têm contas separadas. O alarme inteiro compartilha uma conta entre manutenção, módulos, processamento e entregas. Fonte: `docs/LIMITES.md:19`.

Para o orçamento deste contrato, contar cada instrução SQL. Um lote não vale uma única instrução. Esse é o critério conservador do instrumento de testes existente. Fonte: `tests/d1-counter.ts:39`.

### Orçamento proposto por rota

Os números abaixo são **metas de implementação**, não medições realizadas.

| Operação | Consultas de domínio esperadas | Teto proposto para a invocação completa |
|---|---:|---:|
| Catálogo de tipos | 1 leitura de configuração, reutilizável por cache | 15 instruções |
| Lista de ordens sem facetas | Configuração + lista + contagem: até 3 | 20 instruções |
| Lista com facetas | Até 4, com uma agregação adicional | 25 instruções |
| Detalhe sem histórico | Configuração + ordem: até 2 | 15 instruções |
| Detalhe com histórico legado | Até 3 | 20 instruções |
| Histórico paginado | Ordem + página, com configuração quando necessária | 20 instruções |
| Uma coleção filha | Ordem + página + configuração, sem consulta por linha | 20 instruções |
| Quatro coleções buscadas separadamente | Quatro invocações limitadas | 20 por invocação |
| Criação de ordem | Configuração, identidade, contadores, ordem, histórico e publicação | 60 instruções |
| Alteração de etapa ou aprovação | Ordem, validação, alteração, histórico e publicação | 50 instruções |
| Escrita de um filho | Ordem, filho, limite, alteração, histórico, atividade e publicação | 45 instruções |
| Reserva ou confirmação de documento | Metadados e conferências; R2 contado separadamente | 45 instruções |
| Prévia de modelo | Configuração, módulos e procedência; sem escrita | 25 instruções |
| Aplicação de modelo | Leituras anteriores e lote de confirmação | 80 instruções |

As quantidades de domínio não incluem autenticação, escopos, papéis, estado do módulo, recibos, auditoria ou entregas. Os tetos completos devem incluir tudo.

A documentação local atribui quatro instruções adicionais a determinados comandos pelo recibo e auditoria. Isso não deve ser tratado como custo universal de qualquer comando novo. Fonte: `docs/LIMITES.md:72`.

### Regras para manter o orçamento

| Regra | Motivo |
|---|---|
| Não carregar filhos na lista de ordens | Evita multiplicar quatro consultas por ordem. |
| Não consultar contato ou responsável por linha | Evita consultas proporcionais ao tamanho da página. |
| Carregar abas sob demanda | Limita consultas e volume de resposta. |
| Resolver configuração uma vez por invocação | Evita repetir leitura de tipos. |
| Não buscar revisões de tipo por ordem | A cópia está na própria linha. |
| Usar paginação por chave | Evita custo crescente de `OFFSET`. |
| Limitar lotes de lembrete | Evita consumir o orçamento inteiro em uma rodada. |
| Contar instruções em todos os ramos | Uma falha, uma notificação ou uma repetição também custa consultas. |
| Medir o alarme completo | Medir somente o agendador de OS não prova que o alarme cabe no limite. |

O agendador atual de OS usa lotes de 50 para retirada e paralisação. Somar outro lote de 50 tarefas sem medição não é aceitável. Fonte: `src/modules/os/reminders.ts:9`.

O contrato inicial para os recursos novos será:

| Item | Limite proposto |
|---|---|
| Tarefas novas notificadas por rodada | Até 10 |
| Trabalho adicional dos filhos no alarme | Até 200 instruções |
| Meta para alarme completo nos cenários de carga de teste | Até 800 instruções |
| Margem até o limite local documentado | 200 instruções |
| Trabalho restante | Reagendar. Não descartar nem marcar como enviado antes da inclusão durável na fila. |

Se os cenários completos excederem a meta, reduzir o lote e continuar em outra rodada. Não aumentar silenciosamente o teto do teste.

Os testes atuais já têm limites próprios, inclusive 71 instruções para um cenário de alarme. Isso é um cenário específico, não um limite superior de toda carga possível. Fonte: `tests/d1-budget.test.ts:84`.

### Riscos e decisões pendentes

| Risco ou dúvida | Decisão deste contrato ou verificação necessária |
|---|---|
| Confundir número global com número do tipo | Manter os dois. Não alterar cursor, comandos textuais antigos ou `number`. |
| Afirmar compatibilidade completa dos aplicativos com tipos novos | Não afirmar. Leitura é compatível; ações próprias exigem atualização. |
| Etapas diferentes com o mesmo estado | Usar ID de transição e versão. Recusar ações antigas ambíguas. |
| Alterar um tipo e reinterpretar ordens antigas | Usar cópia imutável por ordem. Conversão entre revisões fica fora destas fases. |
| Crescimento da configuração | Aplicar limites por tipo e agregado. Acima deles, rejeitar a alteração inteira. |
| Histórico legado muito grande | Preservar contrato antigo. Painel novo usa histórico paginado. Volume máximo já existente está **a conferir**. |
| Vazamento por bot sem máscara | Bloquear dados sensíveis por identidade e contexto de atuação, independentemente da máscara. |
| Vazamento por descrição de proposta | Operações privadas fora do catálogo. Operações comuns não aceitam campos sensíveis. |
| Vazamento por mídia comum | Documentos sensíveis usam namespace privado e autorização própria. |
| Reclassificar um documento já enviado como sensível | Não prometer recolhimento de conteúdo já entregue. Bloquear novos envios e registrar a alteração. |
| Vincular pessoa e dar acesso a outra família, unidade ou processo | Vínculo não concede acesso. Compartilhamento com novos titulares exige contrato posterior. |
| Garantir sigilo de conteúdo recebido espontaneamente pelo WhatsApp | O motor controla os campos classificados que produz e armazena. Captura privada não deve usar o canal comum. |
| Falha entre D1 e R2 | Usar estado pendente, tentativa exclusiva, confirmação e limpeza. Não prometer transação distribuída. |
| Falha depois da gravação e antes do evento | Usar chave de mutação e publicação idempotente recuperável. |
| Aplicação parcial de modelo | Planejar primeiro e confirmar configuração, módulos e procedência no mesmo lote. |
| Dois agendadores substituírem um ao outro | Um agregador do módulo. Extensões não chamam `onSchedule("os")`. |
| Prazos processuais | Tarefas guardam instantes e avisos. Não calculam dias úteis forenses nesta fase. |
| Prontuário | Não é entregue por campos extras. Exige extensão própria, regras de acesso, guarda e registro de leitura. |
| Dados de menores e saúde | Bases legais, avisos e regras profissionais estão **a conferir** nas respectivas extensões. |
| Financeiro do ERP | Lançamentos deste motor não geram movimentos financeiros automaticamente. |
| ERP somente para serviços | Separação de telas por papel está **a conferir**. Não foi definida por este contrato. |
| Desempenho D1, R2 e CPU | Medições estão **a conferir** na implementação. Os tetos acima são critérios de aceitação. |
| Nome do conjunto na interface | Usar `os_vocabulary.collection_label`; padrão “Trabalhos” somente quando houver tipos personalizados. A área apenas com o embutido conserva “Ordens de serviço”. |

A fase 1 só pode ser integrada com a suíte atual da Ordem de Serviço aprovada **sem alteração de expectativas**. A fase 2 exige, além disso, isolamento entre áreas e titulares, ausência de valores sensíveis nos caminhos públicos e de IA, recuperação de operações repetidas e orçamento D1 medido na invocação completa.