# Relato consolidado — f3-corr-fila

Data: 19/11/2026. Este relato cobre todas as mudanças desta tarefa presentes na
árvore, inclusive as anteriores às retomadas pelo log de verificação.

**Liberação pendente.** As correções locais não bastam para declarar a fase
aprovada: o motor desta árvore ainda rejeita a interface de manutenção combinada,
e há testes existentes que exigem o contrato anterior. Nenhum desses testes foi
apagado, enfraquecido ou alterado para aceitar a falha. A matriz de arquivos da
tarefa foi preservada; os ajustes de outros donos estão em “Pedidos”.

## Causas da verificação externa

O arquivo `.codex-verificacao.log` foi preservado. Seu rodapé registra 22 falhas
e 78 aprovações em quatro arquivos. O trecho disponível começa no final da falha
13/22; só contém o diagnóstico completo das falhas 14–22. Não é possível atribuir
as primeiras 13 falhas individualmente a partir desse trecho.

1. **Depósito fictício no teste novo com motor real.** A fixture compartilhada
   cria UUIDs de configuração para um ERP simulado. O teste novo substituía
   cliente e categoria por registros reais, mas conservava o depósito fictício.
   Reproduzido com SQL e endpoint reais: a primeira aplicação retorna
   `22023 / erp_document_warehouse_unavailable`, antes de criar documento.
   O teste novo agora cria também o depósito no motor, sem alterar suas
   expectativas de sequência, conclusão, documento ou título.
2. **Manutenção incompatível no motor atual.** Com configuração válida, a
   sequência 1 prepara o documento. A sequência 2, `lifecycle` ao enviar o
   orçamento, recebe `22023 / module_commercial_invalid`: o adaptador cumpre a
   interface 1 (`contact_id: null`), mas `validateModuleBody` ainda exige contato
   não nulo. O código do motor também conserva acessos a `policy.auto_post`,
   omitido na manutenção conforme a interface 2. A sondagem real termina com
   um documento, nenhum título e os sucessores pendentes. **Não corrigido aqui:
   arquivos da tarefa de capacidade.** O teste integrado continua exigindo
   sucesso integral; não foi trocado pelo fluxo mais simples de preço fixo.
   A última retomada acrescentou essa mesma sequência como teste Node permanente,
   separado do caso de preço fixo: ele reproduz a falha na sequência 2 e exige
   conclusão de todos os eventos, documento único, título único e replay sem
   duplicação. Portanto a suíte direcionada agora expõe essa pendência também
   sem executar Vitest.
3. **Referência comercial recusada virava erro genérico terminal.** O adaptador
   tratava depósito, categoria e forma de pagamento indisponíveis como
   `failed/invalid_request`. Agora reconhece somente os três códigos exatos do
   motor e retorna `blocked/default_inactive`, com mensagem sanitizada. Três
   provas novas atravessam o motor, corrigem a configuração, substituem o comando
   e confirmam documento único e pedido antigo imutável. As três falham em um
   bundle temporário sem essa correção e passam com ela.
4. **Expectativas antigas em `tests/f3-base.test.ts`.** O teste da 12ª falha
   exige `failed`, apesar de a aplicação poder ter perdido a resposta; o contrato
   novo exige `uncertain` e consulta do mesmo comando. Outro exige que o original
   já esteja fechado quando a projeção substituta falha, precisamente a ordem
   insegura proibida pela tarefa. Dois esperam `waiting_manual` no estado público,
   substituído por `skipped/automation_off` com pendência manual explícita. O teste
   do agendador não fornece o callback de `waitUntil`, mas exige drenagem síncrona.
   Não se restauraram esses comportamentos para satisfazer as asserções antigas.
5. **Cascata fora desta matriz.** O teste chama `module.set` com `cascade:true`
   sem `confirmed_dependents`; `src/modules/registry.ts` exige a lista confirmada
   e recusa com `module_cascade_conflict`. Essa guarda foi preservada.
6. **Testes de Trabalho confundem sequência remota e cronologia local.**
   `ORDER BY seq` não ordena fatos com `seq=null`; a sondagem reproduziu a ordem
   de revisões `3,1,2`, embora a ordem real fosse `1,2,3`, terminando em
   `lifecycle`. A leitura de produção usa `source_revision,seq`. A asserção de
   privacidade também usa `seq===1` para reconhecer a abertura; a abertura agora
   tem `seq=null`. Seu pagador continua nulo até confirmação explícita. Não foi
   colocado pagador em evento anterior à autorização para satisfazer o teste.
7. **Contrato antigo também na aceitação Node.** O caso “SQL compacto da saída”
   de `tests/erp/unico/f3-aceitacao.test.mjs:288` cria um fato com todos os destinos
   inelegíveis, mas exige `enqueued_seq=1`. A implementação nova mantém zero,
   conforme a interface 3. A execução isolada reproduziu essa falha na linha 372.
   A asserção antiga foi preservada e deve ser alinhada pelo dono, conservando
   as provas de CAS, rollback, lacunas e propriedade do alias.
8. **Nove falhas da fase 2 já presentes em HEAD.** A suíte completa identificou
   cinco casos em `tests/erp/unico/f2-catalogo.test.mjs` e quatro em
   `tests/erp/unico/f2-documentos.test.mjs`. Eles esperam fornecedores, custo,
   categoria, conta, comissão, depósito ou lotes na resposta enquanto suas partes
   estão desligadas; a projeção atual os omite, conforme o contexto da tarefa.
   Para separar causa anterior de regressão, extraí `HEAD` em diretório temporário,
   sem checkout, commit ou alteração da árvore, e executei os dois arquivos:
   **as mesmas nove falhas**, com 20 aprovações. A preservação dos dados no banco
   deve continuar sendo testada, junto da ausência desses campos no retorno.

| Arquivo da fase 2 | Linhas de início dos casos que falharam também em HEAD |
|---|---|
| `tests/erp/unico/f2-catalogo.test.mjs` | 80, 101, 125, 147, 201 |
| `tests/erp/unico/f2-documentos.test.mjs` | 95, 137, 179, 269 |

Além disso, a retomada corrigiu a apresentação de uma substituição reservada:
consulta da origem, comercial de Trabalho e contadores agora mostram igualmente
`blocked/correction_in_progress`. A prova de perda da resposta do fechamento
verifica os três caminhos antes de retomar a mesma solicitação.

Na última revisão do caminho de tentativas, confirmou-se uma **lacuna adicional
do achado 5**, não atribuída a uma das falhas truncadas do log: a leitura inicial
de `module_erp_requests` acontecia antes de qualquer incremento. Quando essa
leitura falhava, a entrega voltava à seleção com contador zero, sem atingir o
limite nem aumentar o recuo. O consumidor agora registra a tentativa antes de
ler o corpo. A existência do pedido, conferida na própria atualização SQL,
decide entre preparação e consulta; um envio incerto ainda pode consultar seu
recibo depois de esgotar os envios. Três regressões com D1/ERP em SQLite reais
e falha injetada somente nessa leitura cobrem pedido ausente, preparado e
último envio incerto. **As três falharam antes e passaram depois**; verificam
12 tentativas, recuo, suspensão da seleção, retry humano, documento único e
ausência de reaplicação de um efeito já confirmado no ERP.

## Situação de cada achado da tarefa

| Achado | Resultado consolidado |
|---|---|
| 1 — Trabalho sem orçamento consome sequência | Corrigido na fila: abertura local tem `seq=null`; só eventos elegíveis incrementam `enqueued_seq`. Motor real confirma documento e título no fluxo de preço fixo. A aprovação por orçamento ainda depende da adequação de manutenção no motor, descrita acima; não se declara esse fluxo aceito. |
| 2 — Inelegível tenta para sempre e bloqueia sucessores | Corrigido: o lote encerra o fato localmente, inclusive atrás de predecessor pendente. Não cria pedido, recibo remoto ou dívida ao religar. Lotes mistos compactam a sequência dos comandos elegíveis. |
| 3 — WhatsApp espera o ERP | Corrigido: o alarme entrega a drenagem a `ctx.waitUntil`; a rodada dos módulos retorna sem aguardá-la. Prazo global cobre chamada e leitura de resposta em curso, inclusive transporte que ignora aborto. |
| 4 — Correção fecha antes de validar substituição | Corrigido para substituição sem sucessores: valida projeção, reserva origem e plano, depois consulta/fecha o original; confirmação e instalação são atômicas no D1. Retomada conserva a chave. Com sucessores, recusa antes de fechar com `replacement_successors`. Substituição automática de uma cadeia permanece adiada: requer protocolo que preserve fatos e efeitos incertos; não há renumeração nem fechamento parcial. |
| 5 — Tentativas e resposta perdida no último envio | Corrigido: preparação, consulta e envio têm contadores, limite e recuo, inclusive quando falha a leitura inicial do pedido. Incerteza conserva a identidade e continua por consulta, sem 13º envio. Esgotar consultas deixa incerteza explícita; retry humano reabre consultas sem zerar o limite de envios incertos. |
| 6 — Religar automação lança fatos do período desligado | Corrigido: autorização por destino e época da política são capturadas no mesmo lote do fato e são imutáveis. Religamento não autoriza o passado; substituição automática herda a autorização original. Pendência manual permanece visível. |
| 7 — Contato e `auto_post` na manutenção | Adaptador corrigido: cancelamento, reversão e lifecycle vinculado levam contato nulo e política sem `auto_post`, sem promover cliente novamente. Implementação ponta a ponta depende do motor usar o contato e os efeitos históricos; pedido ao dono da capacidade. |
| 8 — Política financeira exposta a Estoque | Já corrigido na base recebida: `commercialPolicyView` e a rota GET projetam por papel. Não houve mudança artificial nessa proteção. As provas novas conferem ausência de categoria, forma, contas e consumidor para Estoque. |
| 9 — Estado falso de confirmação | Corrigido no servidor: `none`, `skipped`, `pending`, `blocked`, `failed`, `uncertain` e `done`, com motivos, destinos aplicados e pendência manual. Fato local não gera confirmação ERP. Reserva de correção é bloqueio nas três projeções. A tela e seus contratos pertencem a outro dono. |
| 10 — Restauração unilateral | Implementado o mínimo seguro solicitado: conflitos de sequência/comando constatados pelo ERP viram `blocked`, com “ERP e fila divergentes (restauração?)”; retry não os libera. Provas cobrem ERP sem predecessor e D1 restaurado que tenta reutilizar sequência com outro fato. Não há reconciliação automática. |

## Mudanças por arquivo

| Arquivo | Mudança acumulada |
|---|---|
| `migrations/0135_module_erp_integration.sql` | Sequência remota anulável; épocas de automação por destino; autorização imutável por evento; contadores de preparação/consulta, marcador de envio sem confirmação e estado `uncertain`; reserva de substituição na origem. Apenas tabelas/colunas de integração D1; nenhum esquema ERP alterado. |
| `src/coordinator.ts` | Somente o ponto autorizado do alarme: passa `ctx.waitUntil` à rodada dos módulos. |
| `src/modules/schedule.ts` | Agenda a drenagem em background quando há Base e callback; não aguarda o ERP. |
| `src/integrations/contracts.ts` | Distingue `seq=null` de comando remoto; separa estados públicos (`SourceIntegrationState`) e de entrega (`DeliveryIntegrationState`, incluindo `uncertain`). O tipo legado do painel fica identificado para migração pelo dono da interface. |
| `src/integrations/keys.ts` | Identidade própria de fato local, isolada por área/origem, sem ocupar identidade remota. |
| `src/integrations/outbox.ts` | Normaliza eventos locais e compacta sequência remota; captura automação no lote; recusa preparar fato local; concessão considera incerteza e reserva de correção; confirmação pode instalar substituto no mesmo lote. |
| `src/integrations/automation.ts` | Consulta autorização de nascimento e corte atual por destino; ambos precisam autorizar a execução automática. |
| `src/integrations/policy.ts` | Incrementa épocas por destino quando a escolha de automação muda, no mesmo CAS da política. A projeção por papel já existia. |
| `src/integrations/consumer.ts` | Contagem por fase antes de ler o corpo persistido, com seleção atômica do contador de preparação/consulta; recuo e limite; consulta de resultado antes de corte; recuperação de incerteza; seleção sem fatos locais nem origens reservadas; prazo global. |
| `src/integrations/deadline.ts` | Prazo absoluto com corrida de timeout e AbortSignal, incluindo chamada em curso. |
| `src/integrations/erp-adapter.ts` | Usa autorização de nascimento; manutenção sem contato/automação; propaga prazo aos RPCs; conserva incerteza diante de resposta inválida; mapeia divergência de restauração e referências indisponíveis por códigos exatos. |
| `src/integrations/privacy.ts` | Valida identidades/sequência de fatos locais; acrescenta códigos e mensagens sanitizadas de incerteza, divergência, automação desligada e reserva de correção. |
| `src/integrations/state.ts` | Projeção comum de estado, confirmação, destinos aplicados, pendência manual e bloqueio por correção reservada. |
| `src/integrations/routes.ts` | Reserva e retomada de substituição antes do fechamento; recusa segura de sucessores; retry conserva identidade incerta e bloqueia divergência; ordena fatos por revisão; expõe estados e contadores coerentes. |
| `src/modules/os/commercial/mutations.ts` | Remove o avanço local de `applied_seq`; o lote genérico trata fato sem destino sem consumir sequência ERP. |
| `src/modules/os/commercial/projection.ts` | Lê fatos por revisão e sequência e inclui erro/incerteza para projetar estado. |
| `src/modules/os/commercial/routes.ts` | Usa a projeção comum, incluindo pendência manual e reserva de correção. |
| `tests/f3-corr-fila.test.ts` | 14 casos novos de integração/contrato; configuração do cenário com motor real usa depósito real. Nenhuma expectativa de sucesso foi retirada. Não executado nesta sessão. |
| `tests/erp/unico/f3-corr-fila.test.mjs` | 29 provas novas com SQL D1, produtores, adaptador, identidade, endpoint e SQLite ERP reais; cobre sequência, concorrência, automação, tentativas, prazo, substituição, restauração, política e estado. Inclui referências inválidas recuperáveis, leitura de lifecycle sem promoção, cronologia de legado e três falhas de leitura inicial. O caso completo de orçamento/aprovação exige sucesso e permanece falhando pela incompatibilidade do motor; 28 casos passam. |
| `src/integrations/RELATO-F3-CORR-FILA.md` | Este relato completo, mantido dentro da matriz autorizada. |

O harness Node substitui somente o suporte de runtime (DurableObject/KV/D1 local)
e os pontos de falha explicitamente controlados. Ele não executa o runtime
Cloudflare nem comprova a latência real do WhatsApp. A cobertura de prazo prova
o retorno independente da espera remota; a de dados usa as migrações e o motor
reais, sem chamadas de rede.

## Verificação desta retomada

- Restrições preservadas: sem commit, rede ou execução de Vitest. Nenhum teste
  existente de base, aceitação, trabalho, capacidade ou diferencial foi editado.
- Estado recebido: `npm run check` e os **62/62** casos Node direcionados
  existentes passaram. Esse conjunto ainda não executava o fluxo completo de
  aprovação por orçamento, apenas o de preço fixo e a preparação da manutenção.
- Prova antes/depois da correção de contagem: os três novos casos de falha na
  leitura do pedido deram **0/3 antes** (contador zero em vez de um) e **3/3
  depois**. Não houve alteração das asserções entre essas execuções.
- `npm run check`, após a correção: **aprovado**, saída 0, incluindo TypeScript,
  conflitos, codificação e CSS. A separação dos tipos públicos/de entrega feita
  na retomada anterior foi preservada.
- `node --no-warnings --test tests/erp/unico/f3-corr-fila.test.mjs tests/erp/unico/f3-capacidade.test.mjs`:
  **66 casos, 65 aprovações e 1 falha**, zero cancelados/pulados, saída 1.
  São 28 aprovações e a falha do orçamento/aprovação entre os 29 casos desta
  tarefa, mais **37/37 de capacidade**. A capacidade não foi editada. A nova
  prova não criou uma regressão de produção: tornou executável em Node o
  cenário já recusado no log externo e antes verificado só por sondagem.
- `npm run test:erp`: **1.143 casos, 1.131 aprovações, 11 falhas e 1 TODO**;
  zero cancelados/pulados, saída 1, duração de aproximadamente 11 minutos.
  As falhas são as mesmas nove da fase 2, a asserção antiga de sequência local
  da aceitação F3 e o novo caso de orçamento/aprovação, que reproduz a
  incompatibilidade do motor já vista no log externo. Nenhuma falha nos testes
  diferenciais contra o oráculo. A suíte integral **não está verde**.
- Evidência da execução integral anterior: **1.139 casos, 1.128 aprovações,
  10 falhas e 1 TODO**, saída 1. Nove falhas eram da fase 2; a décima era a
  asserção antiga de sequência local da aceitação F3. Nenhuma falha no
  diferencial contra o oráculo foi registrada nessa execução.
- Comparação isolada no HEAD original, realizada na retomada anterior e com
  log preservado: `f2-catalogo.test.mjs` e
  `f2-documentos.test.mjs` totalizaram 29 casos, 20 aprovações e as mesmas nove
  falhas. Cópia temporária somente para leitura/execução; sem mudar a árvore.
- Prova negativa anterior em bundle temporário: os três testes de configuração inválida
  falham sem o novo mapeamento e passam com ele; nenhum arquivo de produção foi
  revertido para essa prova.
- A sondagem anterior de orçamento enviado/aprovado identificou o erro bruto
  `22023 / module_commercial_invalid` na manutenção da sequência 2. A regressão
  permanente acrescentada agora confirma o bloqueio desse mesmo caminho;
  não se declara a aceitação do cenário.
- Cronologia legada: prova Node aprovada novamente; origem exclusivamente local,
  sem chamada ERP. A sondagem anterior com `ORDER BY seq` demonstrou a leitura
  enganosa dos testes antigos.
- `npm run build`: aprovado; avisos do bundler sobre chunks/diretivas de módulos,
  sem erro de compilação.
- `git diff --check`: aprovado.
- O Vitest integrado permanece para verificação externa. A falha do motor e as
  expectativas conflitantes enumeradas acima precisam ser resolvidas pelos
  respectivos donos antes de esperar a verificação integral verde.

Logs da última retomada: `/tmp/f3-fila-retomada-inicial.log`,
`/tmp/f3-fila-retomada-regressao-antes.log`,
`/tmp/f3-fila-retomada-regressao-depois.log`,
`/tmp/f3-fila-retomada-direcionados.log`, `/tmp/f3-fila-retomada-erp.log`,
`/tmp/f3-fila-retomada-check-final.log` e `/tmp/f3-fila-retomada-build.log`.
Evidências anteriores preservadas: `/tmp/f3-fila-erp-inicial.log`,
`/tmp/f3-fila-f2-baseline.log`, `/tmp/f3-fila-probes.log` e
`/tmp/f3-fila-regressoes-sem-correcao.log`.

## Pedidos

1. **Capacidade/ERP — indispensável à liberação:** adequar
   `src/erp/domains/documents/module-policy.ts` e os RPCs de manutenção à interface
   combinada. Contato nulo deve usar o vínculo histórico; contato não nulo
   divergente deve ser recusado. A ausência de `auto_post` deve ser válida em
   manutenção. Cancelar/estornar deve seguir título, baixa e estoque reais,
   preservando bloqueios de efeitos irreversíveis. Conferir também o hash
   comercial congelado e o DTO do documento usando o contato histórico
   normalizado, para não interpretar o nulo de manutenção como troca de cliente.
   Reexecutar orçamento → aprovação → execução e manutenção com automação
   desligada. Não foi criado contorno no adaptador que viole essas interfaces.
2. **Donos dos testes existentes:** alinhar a preparação e os contratos dos casos
   apontados, mantendo ou ampliando a força das provas: confirmar a lista real
   de dependentes na cascata; verificar incerteza/consulta após envio sem resposta;
   provar ausência de fechamento quando projeção falha; fornecer coletor de
   `waitUntil` e provar retorno antes do ERP; verificar `skipped`, motivo e
   destinos manuais; ordenar fatos por revisão e conferir pagador pelo momento
   de autorização, não pelo número remoto; usar o contrato de fato inelegível
   sem sequência remota na aceitação Node, mantendo seus testes de CAS/rollback.
   Na fase 2, separar a prova de preservação no SQLite da projeção pública que
   omite campos de parte desligada; conservar as recusas de alteração indevida.
   Esses arquivos estão fora da matriz.
3. **Painel:** consumir os sete estados da interface 4, os motivos de salto e
   bloqueio e os destinos `applied`. “Confirmado no ERP” somente para `done`.
   Preservar a pendência manual mesmo quando um outro destino já foi confirmado.
   Migrar `SourceView`/contadores para `SourceIntegrationState` e entregas para
   `DeliveryIntegrationState`, incluindo `seq: number | null`, em
   `web/modules/integrations/contracts.ts`; atualizar os rótulos em
   `IntegrationStatus.tsx`. O tipo legado não descreve os novos retornos.
4. **Correção com sucessores:** definir e verificar um protocolo completo para
   substituir a cadeia sem alterar fatos imutáveis nem passar por cima de envio
   incerto. Até lá, `replacement_successors` preserva original e sucessores.
5. **Operação/restauração:** restaurar backups D1/ERP compatíveis e revisar a
   origem bloqueada. Não usar retry ou reenvio forçado para apagar divergência.
   Desaparecimento de recibo de origem já encerrada, sem próximo comando, e efeito
   remoto sem fato local não são descobertos por este mecanismo.

## Limites e dúvidas que permanecem

- Faltam as primeiras 13 falhas completas do log externo. Não se presume que
  todas tenham a mesma causa das reproduzidas.
- `0135` continua pressuposta inédita. Editá-la não atualiza automaticamente uma
  base que já a aplicou; não se criou migração de dados de uma instalação F3
  existente, pois esse não é o contrato da tarefa.
- A recusa segura de correção com sucessores não equivale a implementar a
  substituição dessa cadeia. Ela é um adiamento explícito e não destrutivo.
- Sem reconciliador geral de backups, medição de grande volume D1, aplicação em
  instalação real ou validação visual do painel nesta sessão.
- Os demais “Pedidos à base e aos donos” de `docs/FASE-3-INTEGRACOES.md` continuam
  fora desta correção: não foram assumidos como resolvidos por estes testes.
