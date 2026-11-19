# Ponte administrativa D1–ERP — fase 1

18/11/2026. A prova de cadastro está **aprovada**, conforme o resultado externo informado na tarefa: `tests/unico-prova-cadastro.test.ts`, 11 testes aprovados. O código experimental e sua tabela `contact_erp_links` não foram incorporados. Esta implementação usa somente as migrações 0130–0132 da base e o SQLite ERP existente.

**Estado atualizado da entrega:** a primeira verificação externa da ponte falhou: `.codex-verificacao.log` registra **15 falhas e 4 aprovações, em 19 testes**. A causa foi reproduzida e corrigida; as verificações locais permitidas passaram, conforme os detalhes abaixo. A suíte Worker corrigida ainda precisa de nova execução externa. A aprovação da prova de 11 testes não equivale à aprovação da ponte.

## Arquivos da entrega completa

| Arquivo | Implementação acumulada |
| --- | --- |
| `src/customer/erp-bridge.ts` | Porta `CustomerErpBridge`: promoção, associação explícita, patch autorizado com CAS, intenção cifrada e imutável, recuperação pelo mesmo comando, candidatos duplicados, leitura e varredura. A conferência de uma ficha existente remove `roles` de uma cópia do corpo; o save/replay conserva o corpo original. |
| `src/customer/sync.ts` | Espelho por versão, guarda de edição local, índice e conclusão do job em lote atômico, marca durável anterior à escrita e manutenção com checkpoint/orçamento compartilhado. |
| `src/modules/erp/customer-provider.ts` | Listas comerciais e financeiras de leitura com identidade humana, autorização própria, projeção limitada, cursores autenticados e indicação de incompletude. Registra participação na manutenção. |
| `src/erp/api/local-fetch.ts` | Instala a ponte/provedor sem I/O na importação; marca reconciliação antes de escritas e tenta leitura direcionada após sucesso, sem transformar falha de espelho em falha da gravação ERP. |
| `src/modules/erp/identity.ts` | Registra de verdade a identidade `contact-erp-link` como agente `vendas`, presente também nos diretórios dos envelopes humanos enquanto ERP está ligado. |
| `src/erp/engine/identity.ts` | Define UUID, operação interna de varredura e campos administrativos da capacidade estreita. |
| `src/erp/engine/rpc-endpoint.ts` | Restringe operações e campos desse executor; mantém autorização/portão do motor, filtra respostas e implementa varredura interna por ID sem mudar esquema. |
| `tests/f1-erp-bridge.test.ts` | 19 casos da ponte com D1/Coordinator reais e portas simuladas delimitadas. Asserções adicionais conferem corpos antes/depois da criação, recusam `roles` em fichas existentes e comprovam que cada queda alcançou o save e o estado esperado no ERP. Nenhuma asserção foi removida. |
| `docs/FASE1-PROVA-CADASTRO.md` | Relato consolidado da prova, implementação, falha externa, correção, validação, pedidos à base e limites. |

## Decisões comprovadas

- Executor: `systemUserId("contact-erp-link")`, UUID `a20b5668-6799-547a-9d10-5166158359b5`, nome **Sistema · Cadastro**, papel `vendas`, agente, `aal1`, sem sessão ou fator. Está registrado em `systemActors` e em todos os diretórios `erpPeople`, inclusive os envelopes humanos. Desligar o cadastro remove a identidade do próximo diretório. Nenhum papel foi atribuído ao atendimento.
- O endpoint restringe esse UUID a cinco operações administrativas: obter, listar, conferir, salvar contato e varrer IDs. Salvar aceita apenas os campos de `CustomerPatch` convertidos, mais `roles: ["customer"]` exclusivamente na criação e `p_acknowledged: []`. A restrição vale mesmo sem marca adicional no envelope. Permanecem o portão, a carteira do vendedor e as permissões finas do motor. Não há exceção para MFA, operação financeira, estoque, fiscal, observações, classificação, comentários ou tipos privados.
- Nome não vazio é o mínimo padrão. Documento, tipo de pessoa e telefone não são inventados. Preferências obrigatórias (documento, CEP e outras) retornam `needs_data`, gravam `contact_required` e pausam o job. Esses jobs aguardam correção humana; não ficam em repetição automática.
- O ERP gera seu UUID. `contacts.id` continua canônico. Antes de associar, a ponte consulta o proprietário D1 do UUID ERP, e o índice único da base protege a corrida final.
- Telefone normalizado em `phone` **ou** `mobile` é candidato. A conferência ERP verifica igualdade canônica; fax/substring não comprovam identidade. Legado D1 do mesmo namespace também participa. Há limites de cem candidatos locais e cinco páginas ERP por telefone; atingir o limite sem concluir a conferência gera revisão, nunca presunção de ausência. Avisos de documento não são confirmados automaticamente. IDs associados a aplicações ou contatos restritos não aparecem como candidatos de `team`.
- Conferência e gravação são chamadas distintas. Há nova conferência após criar: concorrente detectado gera conflito durável `possible_duplicate_after_save`; o ERP já criado é conservado, sem associar nem apagar automaticamente. **Não há garantia de unicidade global por telefone**, nem alegação de transação D1–ERP. Escrita posterior à última conferência também pode produzir duplicado; revisão humana continua necessária.
- `app:<id>` e atores de aplicação permanecem locais, com `awaiting_proof`, sem resolver o objeto. Associação explícita exige pessoa e leitura ERP autorizada. Uma atualização da ficha já ligada passa também pela conferência ERP com a identidade humana antes de preparar a execução técnica.

## Implementação e armazenamento

`src/customer/erp-bridge.ts` implementa a porta permanente: promoção, patch com CAS, associação, leitura humana e varredura. A entrada aceita apenas o contrato administrativo. O transporte usa `localFetch`, `withStubRetry` e `erp_catalog_contact_save` existentes. Repetição usa sempre o mesmo executor, comando, versão esperada e corpo persistido. Um hash adicional detecta alteração do corpo ou solicitante mesmo quando o chamador reutiliza `requestHash` incorretamente.

`src/customer/sync.ts` aplica o espelho, obtém as instruções de `identityPort.indexContact`, confirma o job e atualiza o checkpoint usando lotes D1 com guardas `customer_assert`. Mudança de versão, identidade restrita, alteração local pendente, proprietário concorrente ou retorno ERP antigo impedem sobrescrita. `company` e `notes` permanecem locais. `mirror_json` guarda exatamente `CustomerMirror`; `phone` projeta seu primeiro telefone e os dois telefones canônicos permanecem no JSON/índice. Endereço nunca entra no espelho.

A ponte usa um membro próprio de `customer_jobs.cursor_json`, preservando outros membros: `customerErp`. Antes de enviar, ele guarda `fingerprint` e `intent`, cifrado com `seal`; antes do save, grava também `sent`. A intenção inclui comando administrativo, dados RPC imutáveis, solicitante sem sessão/MFA e versão/cifra local de origem. Não depende do recibo de uma resposta que pode se perder. Um job com o mesmo `command_id` é reutilizado; caso ainda não exista, a ponte o cria. Jobs anteriores pendentes, em execução, pausados ou em conflito bloqueiam o mesmo contato. A retomada de manutenção respeita `lease_until` e `retry_at`; a fila geral continua responsável pela aquisição de lease.

Depois de um save ou replay, o GET atual substitui o conteúdo antigo do recibo como fonte do espelho. A confirmação do contato, índice e conclusão do job é atômica. Na conclusão, intenção, endereço e `payload_cipher` são removidos; ficam fingerprint e resultado cifrado administrativo. Queda depois desse lote pode produzir erro de transporte, mas a repetição encontra o job concluído e não recria o cliente.

A conferência anterior à criação aceita `roles: ["customer"]` com `p_id=null`. Na conferência posterior, `p_id` já é o UUID ERP: a ponte envia uma cópia dos dados administrativos sem `roles`, preservando a classificação atual da ficha. Essa cópia não modifica a intenção, o comando nem o corpo original de criação usado no replay. O endpoint continua recusando `roles` quando há um ID existente, tanto no check quanto no save.

`src/erp/api/local-fetch.ts` instala encaminhadores da ponte e do provedor na importação, **sem I/O**. Antes de encaminhar qualquer RPC de uma requisição de escrita, grava `customer_progress` (`team`, tarefa `erp.contacts.scan.v1`). Se a marca falha, a escrita não é enviada. Após sucesso, tenta GET direcionado quando há ID de contato na resposta. Falha nessa otimização conserva a resposta de sucesso do ERP e a marca durável.

`src/erp/engine/rpc-endpoint.ts` oferece exclusivamente à identidade técnica a leitura interna `erp_customer_bridge_scan`: seleção de IDs com `id > cursor ORDER BY id`, limite de 20, autorização existente e projeção administrativa. Não acrescenta RPC público de domínio, esquema, tabela, gatilho ou acesso ao D1 no objeto. A leitura aplica o portão mesmo na base vazia.

A manutenção do provedor ERP percorre uma ficha por invocação, dentro do saldo compartilhado de até 40 instruções D1 e 20 itens. Conta também leituras de ativação, diretório e instruções de outras portas. Se não couber o lote, não avança o checkpoint. Espelho e checkpoint entram no mesmo lote; alteração da marca durante uma varredura invalida o lote. Ao terminar, nova varredura fica elegível após cinco minutos, na próxima invocação dedicada existente. Assim importações, caminhos desconhecidos e gravações internas posteriores são cobertos sem diário ERP e sem acréscimo ao alarme de mensagens. Uma ficha ERP sem ligação explícita é apenas candidata de `team`, não cria contato D1.

`src/modules/erp/customer-provider.ts` fornece `sales`, `open_titles` e `ledger`. Exige pessoa direta, área, contato ativo em `team`, papel e portão humanos, visibilidade do contato e autorização própria das consultas ERP. Não usa o executor técnico. Projeta somente referências, situação e data, sem notas/descrições. Os cursores são cifrados/autenticados, expiram em 15 minutos e vinculam área, namespace, contato, coleção, limite, pessoa, sessão, papel, acesso, corte e chaves. Cada página reautoriza a fonte.

Limites declarados: vendas usa a consulta existente dos últimos dez documentos e sempre informa `incomplete`. Títulos a receber usa a consulta existente de até cinquenta e informa truncamento. Extrato usa uma janela de 3.650 dias e até cem linhas da consulta autorizada, sempre `incomplete`. Os limites não são apresentados como histórico integral; a navegação leva ao ERP especializado.

## Falha externa e correção

O fim do log externo registra 15 falhas, 4 aprovações e duração total de 10,14 s. O erro recorrente está em `duplicateCandidates`, na chamada `erp_catalog_contact_check`. Há também asserções de job ainda pendente e de uma edição injetada antes do batch que não chegou a ocorrer.

A promoção persistia e enviava corretamente `roles: ["customer"]` para criar o cliente. Depois do save, reutilizava esse mesmo objeto na segunda conferência, agora com `p_id` preenchido. A capacidade estreita aceita esse campo apenas com `p_id=null`; portanto recusava a conferência com `403 / erp_customer_bridge_scope` **depois de o ERP já ter gravado**. Isso impedia o espelho/conclusão e fazia a recuperação encontrar a mesma recusa. Os testes que esperavam apenas uma exceção podiam aceitar essa falha antes de alcançar o ponto de queda pretendido.

O diagnóstico anterior à correção chamou `handleRpc` e o catálogo reais sobre o driver SQLite Node existente: check de criação **200**, save **200**, check com ID e `roles` **403**, um cliente já persistido. Não foi uma falha de registro da identidade ou do papel `vendas`.

A correção ficou em `erp-bridge.ts`: copiar os dados da conferência e retirar `roles` quando o ID ERP já existe. Nenhuma permissão, regra de MFA, validação do endpoint ou teste foi relaxado. Os testes agora também exigem exatamente as duas conferências com os corpos apropriados, o save original preservado, recusa de `roles` em fichas existentes e contagem de saves/clientes/auditorias nos quatro pontos de queda.

## Validação

Executado novamente nesta rodada, sem rede e sem Vitest:

- `./node_modules/.bin/tsc --noEmit`: aprovado, saída 0.
- `node --no-warnings --test tests/erp/fagoo/catalog-contacts-lane.test.mjs tests/erp/access/identity.test.mjs tests/erp/access/agent-gate.test.mjs`: **19 testes aprovados**, zero falhas, skips ou todos; 18,82 s no total. São 15 do catálogo SQLite/PGlite, 2 de identidade e 2 do portão de agentes. Este total de 19 pertence às suítes Node existentes, não à suíte Worker de 19 casos que falhou fora.
- Diagnóstico local temporário em `/private/tmp/f1-ponte-erp-yRVLpd/diagnostic.mjs`: **6 cenários aprovados** com o código atual da ponte compilado pelo esbuild local, todas as migrações D1 aplicadas em SQLite em memória, transporte local para `handleRpc`/catálogo reais e porta de índice simulada. Cobre promoção, queda antes/depois do commit ERP, queda antes/depois do lote do espelho e retomada por manutenção após lease vencida. Todos terminaram com **um cliente, uma auditoria de criação, job concluído e replay concluído sem novo RPC**. Os corpos de save foram idênticos e conservaram `roles`; a conferência posterior não o enviou. Na retomada, o contador externo e o orçamento interno concordaram em **29 instruções**, dentro do saldo de 40. É diagnóstico Node com adaptadores de armazenamento/transporte, não execução de D1, Coordinator ou Worker reais e não medição de custo do Worker.
- `node scripts/check-conflict-markers.mjs`, `node scripts/check-encoding.mjs`, `node scripts/erp-scope-css.mjs --check` e `git diff --check`: aprovados. A guarda de codificação inspecionou 4.220 arquivos.

O empacotamento temporário emitiu um aviso preexistente de chave `allowImportingTsExtensions` duplicada em `tsconfig.json` (linhas 12 e 14). O TypeScript passou; esse arquivo é reservado e não foi alterado.

`tests/f1-erp-bridge.test.ts` mantém 19 casos para nova verificação externa. Usa D1 e Coordinator reais, uma implementação simulada registrada da porta de índice (outra tarefa) e a fachada de varredura simulada num caso de orçamento. Cobre identidade registrada/restrita, mínimo/preferências, repetição e corpo/ator divergente, quatro pontos de queda, recibo antigo, patch/CAS, fila bloqueada por conflito, edição local concorrente, rollback do lote, telefone/mobile/documento e janela de duplicados, desligamento durante retorno com cache, zero chamadas desligado, isolamento de aplicação, associação explícita/única, importação e varredura por ID, espelho por versão/orçamento e autorização das listas.

**Não executados aqui:** Vitest, Wrangler e `npm run check` integral (inclui geração de `src/build-info.generated.ts`, fora da propriedade desta tarefa). As demais etapas de `check` foram executadas separadamente. A verificação externa pendente é `npm run check && npx vitest run tests/f1-erp-bridge.test.ts`. O trecho recebido não comprova o resultado do `check` externo e não há declaração de aprovação da suíte Worker corrigida.

## Pedidos à base

1. O contrato fixa tabelas e a porta, mas não fixa o protocolo interno entre a fila `f1-cadastro` e `CustomerErpBridge.apply`. Este adaptador conclui espelho/índice/job no mesmo lote e usa exclusivamente `cursor_json.customerErp` para sua intenção. O consumidor deve reler contato/job após `applied`, reconhecer `state='done'` e não executar um segundo CAS baseado na versão anterior. Preservar o membro reservado ao alterar `cursor_json`. Caso a fila pretenda ser a única dona da confirmação, é necessária uma porta explícita para entregar instruções de confirmação, ausente no contrato atual.
2. Publicar o formato compartilhado de `mirror_json` e `local_patch_cipher`. Aqui o primeiro é `CustomerMirror` exato; o segundo é tratado como alteração local opaca, preservada por CAS. Enquanto o codec e o modo/ator da alteração desligada não forem compartilhados, a varredura conserva os dois lados e abre conflito, inclusive em alterações possivelmente disjuntas. Ela não inventa autorização nem reaplica silenciosamente um payload desconhecido. A resolução/fila de `f1-cadastro` deve produzir outro comando autorizado com versões atuais.
3. `BridgeCommand` não transporta a versão D1 esperada nem `mode`. A fila deve verificar `CustomerWrite.expectedVersion` e `fill_empty`/`replace_confirmed` antes de chamar a porta. A ponte fixa a versão D1 observada ao persistir a intenção e impede retorno atrasado a partir daí; não pode reconstituir a versão esperada original omitida pelo contrato.
4. A invocação dedicada do Coordinator e a distribuição do orçamento pertencem a outras frentes. O participante ERP está registrado no provedor; confirmar que a manutenção continua sendo chamada periodicamente e que recebe saldo. Nenhum agendamento novo foi criado.

## Fora do escopo e dúvidas

Não alterados: migrações, esquema/DDL ERP, definições de módulos, motor de atendimento, telas, identidade financeira, Cloudflare ou branches. Nenhum commit/push. Testes de outras frentes não foram alterados; eventual incompatibilidade deve ser resolvida pelo contrato, sem enfraquecer as asserções.

Permanecem para produto/base: quem resolve conflitos, eventual compartilhamento de namespace de aplicações, convenção/posse do telefone principal e experiência de exigências adicionais. A ponte não funde fichas nem assume titularidade por documento ou telefone. Dependentes menores e conteúdo protegido não têm campo neste adaptador.
