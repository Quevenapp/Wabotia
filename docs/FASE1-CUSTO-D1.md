# Fase 1 — identidade no caminho de mensagens

## Integração das dez entregas — revisão após verificação externa, 19/11/2026

Esta seção substitui o estado e as pendências dos relatos individuais preservados
abaixo. Nenhum teste anterior a `f1-*` foi editado nesta integração. Migrações,
esquema ERP e arquivos reservados da casa permaneceram intactos.

O fim do log externo recebido nesta rodada registra **258 arquivos aprovados e
8 falhos; 2.484 testes aprovados e 10 falhos (2.494 no total)**. Esse é o resultado
**anterior às correções desta revisão**, não uma aprovação do estado atual.
As dez falhas foram analisadas e tratadas abaixo. A nova execução completa de
Vitest continua pendente da verificação externa. Sem commit, rede ou Vitest.

### Causas comuns corrigidas

1. A entrada recusava a conexão `meta` usada pelos fluxos publicados; o código de
   identidade reconhecia somente QR/Zernio. Meta volta a ser origem autenticada.
2. A exigência de índice cadastral pronto retirava a credencial telefônica dos
   canais legados e as variantes brasileiras da busca de conversas, protocolos,
   pedidos, reservas e OS de balcão. A compatibilidade é restrita à prova do canal;
   telefone de aplicação, texto arbitrário e LID continuam sem credencial.
3. A importação do serviço instalava uma identidade diferente da composição
   explícita dos testes. Defaults agora admitem uma composição explícita, em
   qualquer ordem; dois registros explícitos diferentes continuam sendo erro.
4. Contato automático ocupava a associação humana de `conversation_contacts`,
   quebrando APIs antigas e fixtures publicadas. O vínculo telefônico automático
   usa `customer_phones`; sessões preservam a prova histórica. A associação humana
   continua separada, e o adaptador antigo `ctx.contact` permanece nulo para ficha
   automática sem nome. `ctx.customer` devolve a referência canônica completa.
5. Produtores usavam `core/conversation`; o histórico consumia
   `conversations/session`. Protocolos também não tinham o vínculo na origem.
   As chaves agora coincidem e os vínculos são gravados no lote da origem.
6. A fila e a ponte tentavam concluir o mesmo job; a fila apagava metadados de
   retomada. A conclusão real da ponte agora é reconhecida e o cursor preservado.
   O ID hexadecimal do Coordinator vira UUID determinístico somente no recibo ERP.
7. A cron chamava um comando comum; a manutenção efetiva estava em
   `/customer-tick`. O chamador agora usa essa rota dedicada, com rodízio e saldo
   compartilhado de 40 instruções/20 itens.
8. A memória cadastral acrescentava `tools` mesmo com todas as ferramentas de
   cliente desligadas. Essa configuração publicada volta a produzir lista vazia.

9. A entrada interna sem conexão passou a ser rejeitada, mesmo quando só
   pretendia manter a conversa legada e receber associação humana. Ela volta a
   funcionar sem prova telefônica, sem contato automático e sem acesso cruzado.
10. Avisos administrativos de OS passaram a usar a regra estrita de documentos;
    um telefone de balcão diferente impedia avisos de uma conversa já vinculada.
    Avisos voltam a usar o vínculo; documentos mantêm a conferência do telefone.
11. A normalização legada de OS preservava números curtos não vazios; sua
    existência era tomada por validade. O número normalizado agora é validado
    antes de qualquer gravação, preservando DDD brasileiro e formatação.
12. A consulta da fila deixou de encontrar senhas emitidas no balcão antes da
    conversa. O fallback agora exige canal autenticado, senha `staff` sem outra
    conversa, mesma área e ausência de impedimentos; o totem ainda exige cupom.
13. O fallback telefônico do Ensino aceitou também contato conhecido pendente.
    Ele agora só atende legado sem referência/telefone cadastral; um contato
    conhecido pendente, ambíguo, bloqueado ou excluído é recusado.
14. Dois testes novos ainda descreviam a integração anterior: a projeção `contact`
    esperava três bindings SQL e o histórico confundia canal legado válido com
    ausência de prova. As expectativas foram alinhadas sem remover as recusas.

### As dez falhas do log e sua resolução

| Teste / quantidade | Causa e correção |
| --- | --- |
| `contacts` / 1 | `inbound` recusava `meta:test` sem conexão. A entrada legada é aceita para conversa/associação humana, conservando `verifiedPhone:null`. |
| `f1-base` / 1 | Mock esperava três parâmetros; a compatibilidade `team/panel` usa quatro. Expectativa corrigida, com novas asserções do namespace legado e da projeção de contato automático. |
| `f1-history` / 1 | O canal legado prova o telefone mesmo sem `verified_phone`; contato pendente recusa a associação com `customer_ambiguous`. O teste também mantém a recusa `forbidden` retirando a conexão e confere que o vínculo histórico não mudou. |
| `f1-private` / 1 | Contato conhecido em `pending` passava no fallback do Ensino. Corrigido no código; nenhuma asserção desse teste foi alterada. |
| `os-compatibility` / 1 | Aviso de etapa embutida era recusado por telefone diferente. `conversationOf` usa a autorização do vínculo, preservando a regra estrita dos documentos. |
| `os-orders` / 1 | `123` era aceito por ser não vazio. A validação exige telefone internacional válido depois da normalização brasileira. |
| `os-work-types` / 3 | A mesma regra de destinatário impedia os dois avisos expandidos e o lote de lembretes. Corrigida no ponto comum, sem alterar expansão, limite Unicode ou repetição. |
| `queue-module` / 1 | `SENHA` ignorava emissão `staff` sem conversa prévia. A consulta restaura o caminho autenticado em uma única instrução SQL, sem transferir senha já vinculada. |

### Medição conjunta, sem aumento de teto

Medição **local**, com Node 26.4.0, `node:sqlite`, migrações reais, transações,
`tests/d1-counter.ts` e os fluxos de `tests/d1-budget.test.ts`. O mesmo adaptador
executou os fontes de `31fb3ba5` via `git show`, sem checkout, e os fontes desta
integração. Ambos usaram o mesmo esquema aditivo atual. Mercado Pago, R2 e
superfície de Durable Object foram simulados; serviço, motor, módulos, SQL e
Coordinator foram os reais. Não é medição de latência, cobrança ou runtime D1.
O metadado gerado de build foi reutilizado, sem influência nas consultas.

`I/V` significa instruções SQL/viagens ao adaptador. Os tetos abaixo foram
conferidos em `git show 31fb3ba5:tests/d1-budget.test.ts` e não foram editados.
A comparação completa abaixo foi medida na rodada anterior da integração.
Nesta revisão foram medidos novamente os caminhos afetados de entrada e consulta
da fila: primeira entrada **20/9**, seguinte **10/7**, repetida **1/1**, consulta
de senha **1/1**. Não foi repetida toda a simulação de pagamentos/alarme/mesas;
essas linhas conservam a evidência anterior, sem se apresentarem como nova
medição. As correções atuais não acrescentam instruções nesses fluxos.

| Fluxo | Base I/V | Integração I/V | Teto de instruções, antes = depois |
| --- | ---: | ---: | ---: |
| Primeira mensagem: entrada | 18/14 | 20/9 | 20 |
| Primeira mensagem: motor | 28/26 | 28/26 | 30 |
| Menu Cardápio | 40/39 | 41/40 | 43 |
| Encaminhamento ao atendente | 33/31 | 34/31 | 37 |
| Conclusão do carrinho Pix | 55/53 | 57/54 | 59 |
| Webhook Mercado Pago: Worker | 2/2 | 2/2 | 2 |
| Webhook Mercado Pago: Coordinator | 28/26 | 28/26 | 30 |
| Rodada dos módulos | 23/23 | 23/23 | 24 |
| Fila: emitir senha | 17/3 | 17/3 | 17 |
| Fila: chamar próxima | 18/3 | 18/3 | 18 |
| Alarme com mensagem/entregas | 70/69 | 71/70 | 71 |
| Mesas: lançar pedido | 26/18 | 26/18 | 27 |
| Mesas: mapa | 6/6 | 6/6 | 8 |
| Mesas: fechar conta | 21/11 | 21/11 | 21 |

Na integração, mensagem seguinte na conversa resolvida: **10/7**, com **zero**
instrução de identidade. Webhook repetido: **1/1**, antes do resolvedor. A sessão
de Suporte continua em uma única viagem (3 instruções, incluindo vínculo).
O acréscimo no carrinho é a leitura da referência e a intenção de enriquecimento
no lote do pedido; o processamento dessa intenção fica na manutenção. No menu e
alarme aparece a consulta de identidade; no encaminhamento, o vínculo da sessão.
Quatro invocações conjuntas de manutenção tiveram consumo declarado igual ao
contador real do adaptador e respeitaram 40/20.

### Pedidos à base, um a um

| Origem | Pedido e solução |
| --- | --- |
| Identidade 1 | `perform` entrega o ID estável diretamente a `contactCommand`, sem captura antiga pelo registro de módulos. |
| Identidade 2 | Desvinculação mantém o `blocked` no lote do comando; leituras/entrada respeitam o bloqueio. |
| Identidade 3 | Escritores usam `indexContact` no lote condicionado; aliases observados são preservados enquanto representam o telefone atual. |
| Identidade 4 / Histórico 1 | Sessões usam `conversationId:session`, módulo `conversations`, tipo `session`, data da reabertura; protocolos usam `tickets/ticket`, no lote de criação. |
| Identidade 5 / Histórico 2 | Cron existente de cinco minutos chama `/customer-tick`; o Coordinator alterna participantes por cursor KV, sem acrescentar manutenção ao alarme. |
| Identidade 6 | Revisão é `GET /contacts?identity=phone_only&review=inactive180`, já consumida pelo painel. Inclui atividade recente da sessão atual e conclusão de formulário/fila; exige revisão humana, sem exclusão automática. |
| Cadastro 1 | Endereço permanece somente na intenção cifrada. Sem endereço no espelho, reconciliação divergente exige revisão; não se inventa equivalência. |
| Cadastro 2 | Recibo do Coordinator sem intenção persistida permite repetir comandos cadastrais com o mesmo ID. Jobs existentes continuam sendo a fonte de recuperação. |
| Cadastro 3 | `POST /contact-jobs/:id/resolve` recebe novo `CustomerWrite`, exige pessoa/versões atuais e cancela/substitui atomicamente a intenção em conflito, preservando a posição na fila. Intenção já enviada ao ERP não pode ser substituída: exige reconciliação do recibo existente. |
| Histórico 3 | Rotas usam a fachada e mantêm o `Cache-Control: no-store` do middleware. |
| Rotinas 1 | Confirmação do nome no carrinho grava intenção com ator interno limitado a contato/conversa/sessão, `fill_empty`, sem papel humano/ERP. A manutenção revalida canal, sessão, identidade e impedimentos de dependentes antes da escrita. Confirmações humanas continuam com o ator original. |
| Rotinas 2 | Balcão volta a usar a abertura autorizada de conversa e as variantes publicadas; aplicações não recebem essa credencial. |
| Pagadores | As cinco coleções de Mensalidade/Suporte declaram a coluna `relation` / “Vínculo”. |
| Condomínio 1 | Sem coluna de maioridade, dependentes permanecem fora da ficha comum e do enriquecimento automático. Não foi criada migração. |
| Condomínio 2 / Ficha 3 | Snapshot e comandos de `memberships`, `functions`, `subscriptions` foram separados no adaptador da ficha: somente diferenças, até dez operações, versão própria da função. Assinaturas expõem `linked`; papéis existentes não são editáveis silenciosamente. |
| Privados 1 | `CustomerModuleProvider.erasure` e `customerRetention` consultam impedimentos inclusive com módulo desligado, sem transportar conteúdo privado. O pedido durável guarda os motivos; eliminação integral continua `retained`. |
| Privados 2 | Navegação privada mantém `{target:{module,resource:"home",id}}`, aceito pelo registro e projetado pelo agregador. |
| Ficha 1 | **Pendente da casa:** A7 não está instalado nos arquivos reservados. O carregador preserva `dependency_unavailable`; esses arquivos não foram alterados. |
| Ficha 2 | O portão de `/contacts/:id/profile` delega ao agregador; papel de extensão alcança suas contribuições sem liberar cadastro comum. `readable:false` evita leituras gerais na interface. |
| Ponte 1 | Confirmação da ponte conclui espelho/índice/job atomicamente; fila reconhece `customerErp.done` e preserva os metadados em pendências. |
| Ponte 2 | A fila usa `CustomerMirror`, intenção `{base,patch}` cifrada e retorno com `contactId/version`; a ponte também conserva companhia/notas locais quando presentes. |
| Ponte 3 | A fila valida versão D1, versão ERP e `fill_empty` antes de montar o `BridgeCommand`; a ponte mantém seu CAS e a intenção imutável. |
| Ponte 4 | Mesma cron dedicada, orçamento compartilhado e rodízio descritos acima. |
| Trabalhos | Sem pedido adicional; compatibilidade de balcão/telefone foi restaurada, mantendo revogação de documentos quando o telefone da ordem muda e de avisos quando o contato vinculado muda. Avisos administrativos conservam o vínculo da conversa, como na versão publicada. |

### Arquivos alterados nesta integração

| Arquivos | Mudança |
| --- | --- |
| `src/customer/ports.ts`, `contracts.ts`, `phone.ts`, `identity.ts` | Composição de portas, origem Meta, vínculo automático, aliases e plano SQL de vínculos. |
| `src/service.ts`, `protocol-lookup.ts` | Entrada/telefone compatíveis, sessão/protocolo e ID estável dos comandos. |
| `src/contacts.ts`, `src/modules/api.ts`, `src/web-steps.ts` | Contato automático e associação humana compatíveis, mesma ficha ao enriquecer, formulários e revisão. |
| `src/queue.ts`, `src/modules/suporte/customer-provider.ts` | Fluxos antigos da fila e vínculo de Suporte sem viagem extra. |
| `src/modules/os/public.ts`, `store.ts` | Titularidade, telefone de balcão, acompanhamento, proteção do destinatário. |
| `src/modules/agenda/customer-provider.ts`, `src/modules/pedido/{customer-provider,orders,pedido}.ts`, `src/modules/reserva/bookings.ts` | Escopo legado autenticado e confirmação cadastral do carrinho. |
| `src/modules/ensino/{access,notices}.ts` | Acesso telefônico legado preservando a autorização privada e sua revogação; contato conhecido pendente é recusado. |
| `src/customer/{jobs,local,erp-bridge,sync}.ts` | Ator do autoatendimento, fila/recibo, retomada, conflito e espelho. |
| `src/coordinator.ts`, `src/index.ts`, `src/customer/http.ts` | Manutenção dedicada, recuperação antes da intenção, rotas e retenção. |
| `src/customer/{declarations,profile-contracts,profile}.ts`, `src/modules/{saude,ensino,juridico}/customer-provider.ts` | Colunas, autorização da ficha, contrato das seções e impedimentos privados. |
| `src/modules/condominio/customer-provider.ts`, `web/contact-profile/{model.ts,ContactProfile.tsx}` | Conversão de snapshot em comandos e edição administrativa da seção. |
| `src/customer/history.ts`, `src/modules/runtime.ts`, `src/erp/api/local-fetch.ts` | Registro explícito das implementações padrão, sem I/O de importação. |
| `src/bot-actions/customer.ts` | Preserva configuração sem ferramentas do cliente. |
| `tests/f1-base.test.ts`, `tests/f1-profile-ui.test.ts`, `tests/f1-integration.test.ts` | Novas regressões de composição, comandos do Condomínio e fluxo integrado real, incluindo resposta ERP perdida, associação legada, aviso vinculado e senha de balcão. |
| `tests/f1-history.test.ts` | Distingue contato pendente de canal sem prova, confere preservação histórica e explicita `required:false` na fixture do formulário para satisfazer `WebField`. |
| Demais `tests/f1-*` alterados | Ajustes de compatibilidade detalhados abaixo; nenhum teste antigo ou teto foi modificado. |

### Ajustes nos testes novos e limites da validação

- `f1-base`: acrescenta composição explícita/default nas duas ordens de carga;
  mantém erro para duas implementações explícitas. O mock de `contact` agora
  confere os quatro bindings, compatibilidade `panel` e contato automático.
- `f1-history`: diferencia `customer_ambiguous` com canal legado autenticado de
  `forbidden` sem conexão; preserva vínculo e demais asserções. A fixture declara
  `required:false`, equivalente ao valor antes implícito, sem mudar as respostas.
- `f1-profile-ui`: acrescenta regressão do adaptador de Condomínio: somente
  diferenças, versões próprias e máximo de dez operações.
- `f1-integration` (novo nesta integração): composição real, sem mock das portas,
  para identidade, sessões, enriquecimento, desvinculação, promoção e queda após
  save ERP. Nesta revisão ganhou três cenários: entrada legada sem credencial;
  avisos de OS com telefone diferente, rejeição de número curto, idempotência e
  revogação por troca de contato; fila de balcão com variantes, custo unitário,
  recusa de aplicação, bloqueio, não transferência e cupom do totem.

- `f1-identity`: variantes do nono dígito reaproveitam contato; prova automática
  conferida no índice, preservando o slot da associação humana publicada.
- `f1-inbound`: aplicação permanece pendente sem prova; consulta de protocolos
  conserva telefone autenticado entre linhas; vínculos usam a chave consumida
  pelo histórico. Contagens verificam índice/histórico sem exigir associação manual.
- `f1-history-privacy`: todas as ferramentas desligadas produzem lista vazia,
  conforme o teste antigo de IA; a memória direta continua isolada e sem ERP.
- `f1-rotinas`: balcão delega abertura com variantes à porta existente; a
  aplicação continua recusada.
- `f1-work`: fixture passa a representar canal autenticado real; documento
  legado do titular conserva acesso por telefone, conforme a especificação antiga.
  Permanecem as asserções de sigilo, troca de identidade e isolamento.

Na rodada anterior, o diagnóstico offline exercitou entrada Meta/QR/Zernio,
LID sem contato, repetição, alias, associação legada `panel`, sessão de Suporte,
OS de balcão, recusa de integração, confirmação cadastral do cliente, ficha
telefônica, revisão de inatividade, manutenção compartilhada, promoção
fila→ponte→ERP, resposta perdida após save e retomada sem cliente duplicado.
A tabela de custos conserva essa evidência. Os scripts daquela rodada foram
removidos e os cenários permanentes ficaram nos testes `f1-*`.

Nesta revisão, **11 cenários offline passaram**, com código real, migrações reais,
SQLite 3.54.1 e Node 26.4.0. Incluem as regressões de entrada, validação e avisos
OS (embutido, texto, Unicode, lembretes, repetição e troca de contato), fila de
balcão, totem, Ensino e os custos acima. As regressões também foram reproduzidas
num bundle temporário com as condições anteriores às correções. D1 é adaptado
sobre SQLite; R2 é simulado em memória e a superfície de DO não é exercitada.
`fetch` foi substituído por uma função que falha para impedir rede no diagnóstico.
Isso não equivale a executar Vitest ou o runtime Cloudflare. Scripts e resultado
ficaram em `/private/tmp/f1-integra-revisao/` para inspeção local.

Validação desta revisão:

- `npx --no-install tsc --noEmit`: passou.
- TypeScript estrito adicional de `f1-base`, `f1-history`, `f1-integration` e
  `f1-private`, com as declarações instaladas de `cloudflare:test`: passou.
  A primeira tentativa avulsa detectou a declaração `required` ausente na fixture
  e não carregava as declarações do plugin; ambas as causas foram resolvidas.
- `vite build --outDir /private/tmp/f1-integra-revisao/dist`: passou, 2.555 módulos.
  Permanecem avisos de tamanho de chunks, nome do grupo de divisão e diretivas
  `use client` de dependência; nenhum erro de compilação.
- `check-conflict-markers.mjs`, `check-encoding.mjs` (4.260 arquivos),
  `erp-scope-css.mjs --check` e `git diff --check`: passaram.
- `node --no-warnings --test tests/erp/access/identity.test.mjs tests/erp/access/agent-gate.test.mjs tests/erp/catalog/contact-scope.test.mjs`:
  **8 aprovados**, sem falhas/skips.
- Somente arquivos da matriz autorizada e `tests/f1-*` foram alterados;
  testes antigos, tetos, migrações e arquivos reservados foram preservados.

Não executei `npm run check` nem `npm run build` como wrappers: ambos chamam o
escritor de `src/build-info.generated.ts`, fora da matriz. Executei a checagem
TypeScript, os guardas e o build Vite diretamente, reutilizando o metadado já
existente. Os wrappers completos ficam com a verificação externa.

**Ainda não exercitado nesta revisão:** Vitest completo; suíte ERP completa;
runtime D1/Worker/Coordinator real; navegador e interação da ficha; provedores
externos; cron Cloudflare real; MFA interativo; hospedeiro A7. Não se afirma que
os 266 arquivos de Vitest passaram. A7 continua pendente da frente da casa porque
seus três arquivos são expressamente reservados. Eliminação integral, maioridade
sem prova e resolução automática de conflito já enviado ao ERP continuam
indisponíveis conforme as decisões de privacidade e retenção descritas acima.

---

## Relato individual anterior (histórico)

## Estado da entrega e causa da falha atual

Relato completo atualizado em 18/11/2026. Trabalho limitado aos arquivos de
`f1-identidade` na Parte B. Sem commit, rede, Vitest ou Wrangler nesta sessão;
nenhuma asserção existente removida e nenhum teto aumentado.

Na etapa individual de 18/11, o log então recebido registrava `npm run check`
aprovado e **35 testes aprovados, 3 falhos, de 38** na execução externa:

| Arquivo | Aprovados | Falhos |
| --- | ---: | ---: |
| `tests/f1-identity.test.ts` | 13 | 0 |
| `tests/f1-inbound.test.ts` | 17 | 3 |
| `tests/d1-budget.test.ts` | 5 | 0 |

As três falhas são os casos de queda antes, dentro e depois do lote da inbox.
A criação da conversa omitia `epoch`, herdando `DEFAULT 0` da migração.
O teste exige época **1** antes da confirmação e **2** depois; o código
produzia **0** e **1**. O incremento da mensagem já era atômico com a inbox,
mas a época inicial não atendia à regressão. A execução local anterior não
conferia esses valores absolutos e, por isso, não detectou a diferença.

Correção: o `INSERT ... RETURNING` do ramo que cria a conversa em `inbound`
agora declara `epoch=1`. O incremento da mensagem permanece no lote da inbox;
uma repetição reutiliza a conversa criada e não repete a inicialização.
Isso não acrescenta instruções nem viagens e não modifica migrações.
As asserções que falharam foram preservadas. Foram acrescentados três casos
para conversas existentes na época 37: queda antes/dentro mantém 37;
confirmação ou retomada termina em 38; repetição não avança novamente.

A causa foi reproduzida localmente antes da correção (`0 !== 1`). Após a
correção, **112 verificações explícitas passaram** com SQLite local.
**Ainda falta nova execução externa da revisão final no runtime D1**;
os três testes falhos e os três novos não foram executados com Vitest nesta
sessão e não são apresentados como aprovados nesse runtime.

O relato anterior registrava 28 aprovações e seis falhas numa rodada mais
antiga. Permanecem entregues as duas correções daquela rodada: alias SQL
`indexed` substituído por `indexed_phones` no preenchimento, e redução da
primeira entrada de 31 instruções/15 viagens para 20/9. O log atual confirma
o preenchimento e os testes de orçamento aprovados; aqueles números antigos
são histórico do relato, não o resultado do `.codex-verificacao.log` atual.

## Medição antes/depois e limites da evidência

A execução local usa Node 26.4.0, `node:sqlite` / SQLite 3.54.1 em memória,
todas as migrações existentes, chaves estrangeiras habilitadas e os módulos
reais de `service`, `identity`, `backfill`, `ports` e `db`. Um adaptador
implementa `prepare/bind/first/all/run/batch`; `batch` executa uma transação
SQLite real. O contador é o próprio `tests/d1-counter.ts`.

Não há banco em rede nem runtime Cloudflare nessa execução local. O bundle
foi reconstruído a partir dos fontes atuais com o esbuild já instalado.
Os números contam instruções SQL e chamadas ao banco/adaptador, sem medir
latência de produção, linhas lidas, retries internos ou cobrança real de D1.
Há duas fontes de evidência, indicadas na tabela: o log externo fornecido
(anterior à correção de época) e a execução SQLite desta revisão.
O construtor, o script e o resultado estão em
`/private/tmp/f1-identidade-verificacao/{build,verify}.mjs` e
`/private/tmp/f1-identidade-verificacao/result.json` (artefatos locais,
fora dos arquivos entregues ao repositório).

| Cenário | Instruções | Viagens | Evidência |
| --- | ---: | ---: | --- |
| Primeira entrada antes da otimização | 31 | 15 | Histórico preservado do relato anterior |
| Primeira entrada, legado incompleto | 20 | 9 | Log externo atual e SQLite desta revisão |
| Primeira entrada com os dez módulos do teste de orçamento ligados | 20 | 9 | Log externo atual e SQLite desta revisão |
| Primeiro número, preenchimento completo | 20 | 9 | Log externo atual e SQLite desta revisão |
| Mensagem seguinte na conversa resolvida | 10 | 7 | Log externo atual e SQLite; identidade acrescenta zero SQL |
| Mesmo webhook repetido | 1 | 1 | Log externo atual e SQLite; somente deduplicação |
| Segundo canal da mesma área | 17 | 9 | Log externo atual e SQLite; reutiliza contato |
| LID sem prova | 12 | 8 | Log externo atual e SQLite; pending, sem contato |
| Aplicação | 10 | 6 | Log externo atual e SQLite; excluded |
| Número ambíguo | 18 | 9 | Log externo atual e SQLite; sem terceira ficha |
| Rodada dedicada, página de contatos vazia do namespace app | 5 | 3 | Log externo atual e SQLite desta revisão |
| Preenchimento de 20 contatos legados | 9 | 3 | Execução local SQLite; checkpoint atômico |
| Referência controlada: mesma entrada com porta simulada sem SQL | 11 | 8 | Log externo atual e SQLite; somente comparação de custo |

A diferença de 31/15 para 20/9 corresponde a **11 instruções e 6 viagens a
menos**. O log externo atual confirma 20/9; a correção de época mantém esse
custo na execução local. A referência controlada isola o acréscimo atual da
identidade: 9 instruções e 1 viagem.
Não equivale à execução de uma revisão antiga. `docs/LIMITES.md` registra
18 instruções históricas para a entrada anterior à fase 1, sem viagens;
esse número também não foi medido novamente nesta sessão.

A redução preserva as garantias:

- Afinidade, identificador exato e conversa de saída sem resposta são lidos
  numa instrução, nessa precedência; o fallback exige telefone exato provado.
- `INSERT/UPDATE ... RETURNING` evita reler a conversa recém-gravada.
- O incremento de época da mensagem compartilha o `UPDATE` final da inbox.
  A época inicial 1 é escrita no próprio `INSERT` da conversa, sem SQL extra.
  Conversa recém-criada não pode ter protocolos para retomar; em conversas
  existentes a consulta permanece e o `UPDATE` só roda quando há protocolos.
- Uma asserção reúne os guardiões do legado, versão do índice e estado de
  restrição do contato escolhido, inclusive após o preenchimento completo.
- A atualização da prova e do marcador também invalida as outras conversas
  do telefone. Quando o plano protegido é ready, um UPSERT substitui o
  vínculo atual; vínculos históricos permanecem imutáveis.

`tests/d1-budget.test.ts` preserva todos os tetos e testes anteriores e agora
exige o teto de 20 também nos dois cenários novos de primeira entrada.
Imprime `FASE1-CUSTO-D1-fluxos` e `FASE1-CUSTO-D1`, com instruções, viagens e
SQL sem parâmetros; ambos aparecem no log externo fornecido.

Os demais fluxos medidos nesse log também respeitaram os tetos originais.
Estes fluxos completos não foram reexecutados localmente nesta sessão:

| Fluxo | Instruções | Viagens | Teto de instruções |
| --- | ---: | ---: | ---: |
| Primeira mensagem: motor | 28 | 26 | 30 |
| Escolha no menu (Cardápio): motor | 40 | 39 | 43 |
| Palavra-chave atendente (Suporte segura): motor | 33 | 31 | 37 |
| Conclusão do carrinho (Pix) | 57 | 55 | 59 |
| Webhook do Mercado Pago: Worker | 2 | 2 | 2 |
| Webhook do Mercado Pago: Coordinator | 28 | 26 | 30 |
| Rodada periódica dos módulos | 23 | 23 | 24 |
| Fila: emitir senha | 17 | 3 | 17 |
| Fila: chamar a próxima | 18 | 3 | 18 |
| Mesas: lançar pedido | 26 | 18 | 27 |
| Mesas: mapa das mesas | 6 | 6 | 8 |
| Mesas: fechar a conta | 21 | 11 | 21 |
| Alarme com mensagem e entregas pendentes | 70 | 69 | 71 |

`/inbound` e `/customer-tick` no Coordinator expõem `Server-Timing` com viagens
e tempo de D1. Não há gravação de telemetria por mensagem. A instrumentação
não acrescenta telefone, mensagem ou dados cadastrais aos logs.

## Alterações completas por arquivo

| Arquivo | Entrega acumulada |
| --- | --- |
| `src/customer/identity.ts` | Implementação de IdentityPort: prova por origem autenticada, contato automático sem ERP, resolução por área/namespace, índice e invalidação, ambiguidade/restrição/bloqueio, guardiões concorrentes, vínculos atuais e sessões imutáveis, caminho sem SQL extra para identidade já pronta. |
| `src/customer/backfill.ts` | Preenchimento retomável de contatos e conversas, páginas de até 20 itens, checkpoint atômico, orçamento conservador de até 9 instruções por página, preservação de escolhas humanas e provas observadas; correção do alias SQL. |
| `src/service.ts` | Registro da porta no carregamento, validação de origem e prova no servidor, identidade no lote da inbox, busca telefônica exata por identidade resolvida, reaproveitamento da conversa de saída, retorno com nova sessão, encaminhamento do ID estável de perform e otimização para manter o teto de 20. Criação explícita na época 1; avanço da mensagem atômico com a inbox. |
| `src/coordinator.ts` | POST interno `/customer-tick`, fachada com orçamento fixo de 40 instruções/20 itens e Server-Timing; instrumentação da entrada; nenhum trabalho cadastral acrescentado ao alarme. |
| `src/protocol-lookup.ts` | verifiedPhone depende da prova e do estado ready; consulta cruzada exige identidade resolvida e registro do protocolo; fallback só para conversa original; textos em português atualizados. |
| `src/zernio.ts` | Remoção do fallback numérico de sender.id, normalização estrita de phoneNumber e reconhecimento de grupo explícito ainda não sincronizado. |
| `connectors/qr/features.mjs` | Telefone somente a partir de JID telefônico válido, inclusive sufixo de dispositivo; JID alternativo provado; LID e grupo não viram telefone. |
| `tests/f1-identity.test.ts` | Canais, áreas, namespaces, nono dígito, legado, duplicados, mudança de telefone, restrição, bloqueio, custo zero, preenchimento e edição concorrente; regressões adicionais para invalidação combinada e restrição entre plano e lote. |
| `tests/f1-inbound.test.ts` | QR/LID, Zernio, grupo/aplicação, origens forjadas, falhas antes/dentro/depois do lote em conversas novas e existentes, repetição sem incremento da época, retorno, saída, ID estável, protocolos e customer-tick; regressões de época atômica, precedência do roteador e retomada de protocolos. Nenhuma asserção anterior removida ou relaxada. |
| `tests/d1-budget.test.ts` | Relatórios imprimíveis dos fluxos existentes e novos, comparação controlada, contagem de manutenção, custo zero e deduplicação; tetos originais preservados. |
| `docs/FASE1-CUSTO-D1.md` | Este relato completo: custos e método, causas, verificação, atomicidade, pedidos à base, exclusões e dúvidas. |

## Verificação realizada nesta sessão

- `npm run check`: aprovado (geração local, marcadores de conflito,
  codificação, escopo CSS e TypeScript sem emissão).
- `node --check connectors/qr/features.mjs`: aprovado.
- Análise sintática TypeScript dos três arquivos de teste com o esbuild já
  instalado: aprovada; não executa os testes nem importa Vitest. O esbuild
  avisou sobre a chave `allowImportingTsExtensions` duplicada no `tsconfig.json`
  existente; esse arquivo não pertence à tarefa e foi preservado.
- Reprodução local antes da correção: falhou com `0 !== 1` na época após
  queda antes do lote, confirmando a mesma causa do log externo.
- Execução local após a correção: **112 verificações explícitas aprovadas**,
  incluindo rollback antes/dentro/depois do lote, repetição, reuso entre
  canais, ambiguidade, troca de telefone sem mover histórico, retomada de
  20+3 contatos, orçamento insuficiente sem SQL, edição concorrente sem
  avançar checkpoint, restrição após plano, prioridade do roteador,
  retomada de protocolo, época da mensagem, integridade de FKs e limpeza
  dos guardiões. Os seis cenários de queda conferem a época persistida,
  rollback, retomada, igualdade com o payload da inbox e repetição sem avanço,
  tanto na conversa nova (1 → 2) quanto na existente (37 → 38).
- `git diff --check`: aprovado. Arquivos modificados/criados limitados à
  lista de propriedade da tarefa; migrações e arquivos de outros donos
  preservados.

Comandos locais executados (dependências já instaladas, sem rede):

```sh
node /private/tmp/f1-identidade-verificacao/build.mjs
node /private/tmp/f1-identidade-verificacao/verify.mjs
npm run check
node --check connectors/qr/features.mjs
git diff --check
```

Para a próxima verificação externa permanece a sequência da tarefa
(registrada aqui, **Vitest não executado nesta sessão**):

```sh
npm run check
npx vitest run tests/f1-identity.test.ts tests/f1-inbound.test.ts tests/d1-budget.test.ts
```

## Atomicidade e retomada

- O contato automático tem `name=''`, `source='automatic'` e nenhum ID ERP.
- O lote que confirma a inbox contém candidatos, índice, associação atual,
  marcador e vínculo de sessão. A conversa pode existir antes desse lote, com
  marcador pending; a inbox não pode existir sozinha.
- A conversa nova criada pelo ramo de `inbound` começa na época 1. Para uma
  mensagem que avança a época, inbox, mensagem e avanço para 2 confirmam juntos.
  Queda antes/dentro do lote mantém 1; queda depois mantém 2. A deduplicação
  antecede a resolução e impede outro avanço. Conversas existentes mantêm sua
  época até o lote confirmar; nenhuma atualização em massa foi feita.
- Planos sobre índice/legado lidos antes do lote usam `customer_assert`.
  Edição concorrente cancela o lote; não se reutiliza um plano envelhecido.
- `indexContact` devolve instruções para o lote do escritor. A troca do índice
  invalida os marcadores afetados. Quem modifica contatos deve usar essa porta
  no mesmo lote condicionado à versão do contato.
- O preenchimento mantém `identity.contacts.v1` e
  `identity.conversations.v1` em `customer_progress`, por área e namespace.
  Processa no máximo 20 registros por página; checkpoint e alterações são
  atômicos. O preenchimento não usa `conversations.phone` como prova.
- A manutenção é exclusivamente `/customer-tick`, POST interno no Coordinator
  da área, corpo `{ "profile": "<área>" }`. Orçamento do servidor: 40 instruções
  e 20 itens compartilhados pela fachada. Não agenda nem acrescenta trabalho ao
  alarme. Uma rodada com saldo insuficiente deixa pendência sem exceder o saldo.
- O vínculo de sessão usa `module_id='core'`, `kind='conversation'`,
  `record_id=conversationId:session`. Conflito não transfere registro antigo.
- A consulta de protocolos usa o registro próprio `kind='ticket'`,
  `record_id=ticket.id`, com área, contato, namespace e conversa conferidos.
  Sem vínculo inequívoco, só a conversa original pode consultar o protocolo.

## Pedidos à base e à integração

1. **Assinatura de `contactCommand` (f1-cadastro):** a base ainda declara cinco
   argumentos. `service.ts` já encaminha o sexto, o identificador estável de
   `perform`, por uma assinatura compatível. O dono de `contacts.ts` precisa
   recebê-lo e usá-lo no lugar de identificadores enviados pelo corpo.
2. **Desvinculação humana (f1-cadastro):** o comando antigo apenas apaga
   `conversation_contacts`. Deve gravar `customer_link_state='blocked'` no
   mesmo lote, com auditoria/versão aplicáveis. A identidade preserva blocked
   e não religa automaticamente. O arquivo de contatos não foi alterado aqui.
3. **Escritores de contatos (f1-cadastro/f1-ponte-erp):** chamar `indexContact`
   atomicamente, inclusive em restrições. Alteração direta de contatos que
   não invalide marcadores quebra a premissa do caminho de custo zero.
   Exclusão/restrição deve conservar candidato/túmulo que impeça reconstrução.
4. **Chaves dos registros (f1-historico/base):** A3/A6 fixam a chave da sessão,
   mas não enumeram `module_id`/`kind`. Adotados os valores acima; os leitores
   devem concordar com eles. Protocolos sem registro próprio não ganham acesso
   cruzado. `createTicket` fica em `service.ts`, fora dos trechos desta tarefa;
   é necessário garantir os vínculos nos chamadores autorizados do histórico.
5. **Agendamento externo:** a rota dedicada está disponível. Sua frequência e
   o chamador não foram especificados; nenhuma rodada foi somada ao alarme.
6. **Revisão após 180 dias:** confirmar o responsável, o estado persistido e
   o inventário de relações/interações usado para encaminhar contatos à
   revisão. A6 exige essa política, mas não define essa representação ou
   uma porta específica; não foi criado um estado fora do contrato.

## Fora do escopo, compatibilidade e dúvidas

Os testes novos cobrem canais, áreas, namespaces, legado, duplicados,
restrições, mudança de telefone, bloqueio explícito, edição durante preenchimento,
QR/LID, Zernio, grupo, aplicação, retorno, falhas antes/dentro/depois do lote,
repetição, protocolo e manutenção dedicada.

Há expectativas antigas incompatíveis com A6 em
`tests/conversation-by-phone.test.ts` (variantes de nono dígito autorizando busca
e retorno) e `tests/service-destinations.test.ts` (acesso cruzado só por telefone).
Esses arquivos pertencem a outros donos e foram preservados. A função legada
`phoneVariants` continua disponível para revisão; a entrada e as buscas desta
tarefa não a usam como autorização. Não se afirma falha executada desses testes:
a incompatibilidade foi identificada por leitura.


Permanecem fora desta entrega: comandos HTTP de cadastro/desvinculação e sua
auditoria, produtores de histórico de protocolos, motor/ponte ERP, promoção,
políticas de revisão dos contatos sem interação por 180 dias e agendamento
externo da manutenção. As migrações são as já entregues pela base; não foram
criadas classes de Durable Object, recursos Cloudflare ou mudanças no esquema
ERP. Não foram alterados testes de outros donos nem arquivos reservados.

Dúvidas de integração ainda abertas: qual serviço chama `/customer-tick` e
com que frequência; confirmação das chaves de sessão/protocolo pela frente
de histórico; adoção da assinatura com commandId e da invalidação atômica
pelos escritores. O próximo log externo deve confirmar os três cenários
corrigidos, os três novos e os custos da revisão final no D1. Os 35 testes
aprovados do log fornecido são evidência da revisão anterior à correção de época.
