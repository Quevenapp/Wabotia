# Limites do Cloudflare: consultas ao D1 e CPU

O Wabotia roda em Workers com D1 e um Durable Object por área (Coordinator).

**O plano pago do Workers (Workers Paid) é exigido** para rodar o Wabotia,
desde a versão seguinte à 0.20.0 (decisão de 16/11/2026). O plano gratuito
não é suportado: o alarme de cada área e a conclusão do carrinho passam de 50
consultas ao D1 por invocação, e a invocação que passa do limite para no meio,
com parte já gravada (veja "Riscos" abaixo). O instalador pelo navegador pede
que o administrador confirme o plano antes de criar qualquer recurso.

Os limites que importam aqui:

| Limite                        | Plano gratuito | Plano pago    |
| ----------------------------- | -------------- | ------------- |
| Consultas ao D1 por invocação | 50             | 1000          |
| Tempo de CPU por invocação    | 10 ms          | 30 s (padrão) |

Cada uma destas é uma invocação separada, com a própria conta:

- uma requisição ao Worker (webhook do canal, do Mercado Pago, API, página do
  passo web);
- cada chamada do Worker ao Coordinator (`/command`, `/inbound`, `/web-step`,
  `/payment-webhook`, ...);
- cada alarme do Coordinator, que faz a manutenção da área, a rodada periódica
  dos módulos, **uma** mensagem da caixa de entrada no motor, as entregas
  pendentes, os webhooks e o push.

## Como medimos

`tests/d1-budget.test.ts` liga todos os módulos numa área (Fila, Formulários,
Cobrança, Agenda, OS, Reserva, Pedido, Mensalidade, Suporte e Mesas), monta um menu com
itens de vários módulos e mede cada fluxo com `tests/d1-counter.ts`, que envolve
o `env.DB` e conta as instruções. Um `batch` conta como uma ida ao banco, mas a
tabela abaixo usa o número de **instruções** (cada uma do batch conta), a
conta conservadora. O teste tem um teto por fluxo: se uma mudança fizer um
fluxo consultar mais, ele falha e mostra a lista de instruções.

## Números (todos os módulos ligados)

| Fluxo                                                    | Invocação                | Antes | Depois |
| -------------------------------------------------------- | ------------------------ | ----- | ------ |
| Mensagem recebida: gravação (inbound)                    | Coordinator `/inbound`   | 19    | 18     |
| Mensagem recebida: motor, primeira mensagem (menu)       | alarme (parte do motor)  | 51    | 28     |
| Mensagem recebida: motor, escolha "Cardápio" no menu     | alarme (parte do motor)  | 63    | 41     |
| Mensagem recebida: motor, "quero falar com um atendente" | alarme (parte do motor)  | 56    | 35     |
| Conclusão do carrinho com Pix                            | Coordinator `/web-step`  | 94    | **57** |
| Webhook do Mercado Pago: assinatura                      | Worker                   | 2     | 2      |
| Webhook do Mercado Pago: consulta, estado, Pedido        | Coordinator              | 29    | 28²    |
| Rodada periódica dos módulos (sem nada vencido)          | alarme (parte da rodada) | 26    | 22     |
| Fila: emitir senha (com recibo e auditoria)              | Coordinator `/command`   | 15    | 17³    |
| Fila: chamar a próxima (com recibo e auditoria)          | Coordinator `/command`   | 17    | 17     |
| Alarme inteiro: uma mensagem e duas entregas canceladas  | alarme                   | 71¹   | **67** |
| Mesas: lançar itens (vira pedido do Pedido)              | Coordinator `/command`   | —     | 25     |
| Mesas: mapa das mesas                                    | Worker (leitura)         | —     | 7      |
| Mesas: fechar a conta com o pagamento                    | Coordinator `/command`   | —     | 20     |
| Entrega: lote de posições (1 escrita, sem recibo)        | Worker (telemetria)      | —     | 4⁴     |
| Entrega: rodada com uma entrega a caminho, nada vencido  | alarme (parte da rodada) | —     | 4      |

¹ Medido já com o cache nos fluxos, antes do escopo no alarme inteiro.

² 25 com o cache; mais 3 da entrega durável do gancho do módulo (fila de
pendentes gravada na mudança de estado, lida e esvaziada ao concluir).

³ Mais 2 desde o cupom configurável: a configuração da área (QR ligado) e o
endereço público, para o texto do QR do `wa.me`.

⁴ Só o módulo (`tests/entrega.test.ts`); a requisição soma a sessão do app, o
estado do módulo e o contador do limite por credencial (mais uma escrita). Um lote a cada minuto por entregador em rota, não uma
escrita por ponto; detalhes em [ENTREGA.md](ENTREGA.md#limites-do-cloudflare).

Os comandos da fila custam 4 instruções a mais pelo `/command` (consulta e
gravação do recibo de idempotência, auditoria e fechamento do recibo).

## O que foi corrigido

- **Leituras de configuração repetidas.** O motor e os ganchos dos módulos
  reliam, a cada mensagem, o estado dos módulos (`profile_modules`, até 8 vezes),
  as configurações da área (até 6 vezes), a conexão (`connections`, até 6
  vezes), o número da Meta, as assinaturas de webhook (uma vez por evento) e,
  no Pedido, o cardápio inteiro duas vezes (validação e conclusão do carrinho).
  `src/db.ts` ganhou um cache por invocação: `withReadCache(env)` abre o
  escopo (um env derivado que passa adiante) e `cachedOne`/`cachedAll` lembram o
  resultado. Qualquer escrita no mesmo escopo que cite uma das tabelas lembradas
  esvazia o escopo inteiro. O escopo abre em `processInbox`, `inbound`,
  `perform`, `completeWebStep`, `refreshFromProvider`, `runModuleSchedules` e no
  alarme inteiro do Coordinator (as entregas reliam a área a cada linha).
- **Fila de saída.** Cada mensagem enfileirada fazia `INSERT OR IGNORE` e depois
  `SELECT` pela chave dedupe. Agora o `SELECT` só acontece quando a chave já
  existia (repetição).

- **Idas ao D1 antes da rota.** Toda requisição autenticada fazia 2 a 4
  consultas em série antes do trabalho da rota:
  - a sessão, depois a política do segundo fator, depois o estado dos módulos duas vezes (no `requireModule` e na rota);
  - ou, com chave de aplicação, a chave, o contador por minuto e o estado dos módulos duas vezes;
  - mais 2 na primeira vez de uma sessão antiga.

  Com o Worker na borda do Brasil e o D1 no leste dos EUA, cada consulta é uma viagem de ida e volta de 150 a 470 ms. Agora é **uma ida só** (`db.batch`):
  - **pessoa** (cookie ou `wabu_`): a sessão, já com a política do segundo fator numa subconsulta;
  - **chave de aplicação**: a chave e o +1 do contador por minuto (`INSERT … SELECT … RETURNING`, que só conta para chave válida);
  - **rota de área** (`/api/v1/profiles/:area/…`): também o estado dos módulos, que entra no cache de leituras da requisição.
    - Leitura (GET) mantém o cache até o fim e a rota reaproveita o estado.
    - Escrita usa o cache só na conferência do módulo, porque a rota pode passar pelo Coordinator, que grava fora deste env.

  A sessão antiga ganha o id público numa instrução só (`UPDATE … RETURNING`). Sessão e permissão **não** ficam em cache entre requisições: a revogação vale na próxima chamada.

  Fica uma ida a mais só na primeira requisição de pessoa em cada isolado: ela grava o endereço público (`rememberOrigin`), e isso só pode acontecer depois de a sessão valer. Tetos em `tests/d1-budget.test.ts` ("idas ao D1 antes da rota") e casos em `tests/d1-request.test.ts`.
- **Nova tentativa em erro transitório** (`src/db.ts`). A Cloudflare manda repetir estes erros ("Retry the operation", em `d1/observability/debug-d1`):
  - `Network connection lost`;
  - os de objeto reiniciado;
  - `Replica disconnected from primary`;
  - `Cannot resolve D1 DB due to transient issue`.

  O D1 já repete sozinho até duas vezes uma consulta só de leitura (SELECT/WITH), do lado dele. Para cobrir também a ida e volta entre o Worker e o banco, `one`, `all` e `batch` repetem **uma vez**, com registro em log (`{"component":"d1","retry":…}`).
  - Só leitura: SELECT ou WITH sem palavra de escrita, e lote só de leituras.
  - Escrita nunca é repetida, porque pode ter sido gravada antes do erro.
  - A exceção é o lote antes da rota da chave de aplicação: contar a mesma requisição duas vezes no limite por minuto não faz mal.

  Casos em `tests/d1-retry.test.ts`.

Cuidados do cache: só vale dentro de uma invocação; as consultas lembradas leem
somente as tabelas da lista em `src/db.ts` (perfis, módulos, conexões, números e
contas da Meta, contas de pagamento, `instance_settings`, assinaturas de
webhook, aplicações, cardápio do Pedido e mídia); as escritas diretas em
`env.DB` fora de `src/db.ts` (auditoria, mídia, Suporte, migrações) não tocam
essas tabelas. Uma mudança feita por outra requisição durante a invocação só
aparece na próxima, como já acontecia com o valor lido no começo do fluxo.

## Fluxos que passam de 50

### Conclusão do carrinho com Pix: 57

Uma conclusão faz, na mesma invocação: confere e fecha o passo web, grava a
mensagem do cliente, cria o pedido (contador, pedido e histórico), registra o
consentimento da finalidade, envia a confirmação, abre a cobrança Pix (conta,
pagamento, chamada ao Mercado Pago, atualização com o código), envia o link e o
código copia e cola separados, liga o pagamento ao pedido e registra o
histórico. São perto de 20 escritas e as leituras que cada uma precisa (o pedido
é relido depois de cada mudança de estado, a conversa três vezes). Não há mais
leitura repetida de configuração. Para caber em 50 seria preciso dividir a
conclusão em duas invocações (pedido agora, cobrança no alarme seguinte), o que
muda o motor; fica registrado aqui.

### Alarme do Coordinator: 67 com pouco trabalho, sem teto fixo

O alarme é a invocação mais pesada porque junta tudo:

- manutenção fixa: cerca de 10 instruções (envios interrompidos, uploads,
  fechamento do dia da fila, passos web e pagamentos vencidos);
- rodada dos módulos: 22 instruções sem nada vencido, uma vez por minuto;
- motor: 28 a 41 instruções por mensagem (uma por alarme);
- bot runs (até 5), entregas (até 10), webhooks (até 10), documento (1) e push.

Só a manutenção, a rodada e uma mensagem já passam de 50. Cada entrega bem
sucedida custa, pela leitura do código, perto de 8 a 12 instruções (conversa,
conexão, conferência do número, reserva do envio, conversa de novo, envio e
conclusão). Isso é estimativa: no teste as entregas são canceladas pela época
antiga da conversa, o caminho barato. Com 10 entregas, o alarme chega a mais de 100.

## Riscos

- **Plano gratuito com os verticais.** Os fluxos isolados do atendimento cabem
  em 50, mas o alarme cheio e a conclusão do carrinho não. No gratuito, as
  consultas além do limite dão erro e a invocação para no meio, com parte já
  gravada (não há transação entre as etapas). No alarme, o Coordinator registra
  o erro e volta no próximo, e as chaves de origem evitam duplicar, mas o
  trabalho atrasa e se repete parado no mesmo ponto. Na conclusão do carrinho,
  o cliente pode ficar com o pedido criado e sem a cobrança. Por isso o plano
  pago passou a ser exigido.
- **Crescimento com os dados.** A rodada dos módulos lê listas com `LIMIT`
  (lembretes da Agenda, avisos da Mensalidade, chegada e saída da Reserva,
  pedidos parados) e cada item vencido gera mensagens e escritas. Num dia com
  muitos lembretes vencendo juntos, a rodada sozinha passa de 50. A manutenção
  também anda por linhas (até 50 passos web e 20 pagamentos vencidos por
  alarme).
- **Webhooks de aplicações.** Cada evento com assinaturas ativas acrescenta um
  `batch` de entregas; a leitura das assinaturas agora é lembrada.
- **CPU de 10 ms.** Não medimos CPU: o ambiente de testes não mede. A espera
  pelo D1 e pelo Mercado Pago não conta como CPU; o que pesa é a página do passo
  web e do cardápio com muitos itens, o JSON grande das configurações e do
  OpenAPI (`/api/openapi.json`), o `tools/list` do MCP e as assinaturas e
  cifras (HMAC, AES-GCM), que são do WebCrypto. No gratuito, cardápios grandes
  são o primeiro candidato a passar.

## Localização: o ERP e o D1 ficam nos EUA

Medido pela sessão K na instalação de teste em 16/11/2026, com o cliente no Brasil.
- A chamada ao objeto `erp:` saiu pelo colo **IAD** (Virgínia), mesmo com `locationHint: "sam"`.
- Uma chamada trivial ao objeto, vinda de um Worker em ATL, levou 45 ms; vinda de um Worker em GRU, 156–475 ms.
- No cliente, pela rede do Dell, a costura da erp-api deu p50 573 ms e p95 659 ms. O trabalho no objeto foi de 5 a 14 ms.

A ida e volta Brasil ↔ leste dos EUA (~120–150 ms) é o piso de toda chamada do ERP.

**Por quê (documentação da Cloudflare):**
- Durable Objects ainda não nascem na América do Sul. O hint "sam" é aceito, mas o objeto nasce no leste da América do Norte.
- O hint só vale no primeiro `get()`, e o objeto não muda de lugar depois de criado ([Data location](https://developers.cloudflare.com/durable-objects/reference/data-location/)).
- O **D1** também não roda na América do Sul: não há hint `sam`.
- O primário do D1 nasce perto de onde o banco foi criado ([D1 data location](https://developers.cloudflare.com/d1/configuration/data-location/)). Criado do Brasil, o mais provável é o leste da América do Norte, a mesma região do objeto `erp:` e dos Coordinators das áreas.
- Confirme na conta com `npx wrangler d1 info wabotia` (campo de região; leitura de produção, que fica com o usuário).

**Consequência:** o ERP não piora a latência em relação ao que o atendimento já tem.
- Cada consulta do Worker ao D1 já atravessa até lá.
- A chamada do ERP atravessa uma vez por pedido da erp-api, e as consultas dela rodam dentro do objeto, no SQLite local, sem nova viagem.

O que reduz o custo:
- uma chamada ao objeto por pedido da erp-api (já é assim);
- o painel juntar leituras;
- no futuro, réplicas de leitura do D1 e Durable Objects na América do Sul, se a Cloudflare abrir a região.

## Posicionamento do Worker (Smart Placement)

**O problema.** O Worker roda na borda mais perto de quem chama: GRU ou GIG para o usuário no Brasil. O D1 e os Durable Objects ficam no leste dos EUA.
- Uma requisição do ERP faz três idas Brasil ↔ EUA em série: a sessão no D1, o estado dos módulos no D1 e o objeto `erp:`. Medido em `tests/erp-do-hops.test.ts`; detalhes no `docs/ERP-FASE0.md`.
- O atendimento faz várias consultas ao D1 por requisição (seção "Números" acima), cada uma com a mesma ida.
- Com o Worker perto do D1 e dos objetos, a requisição paga **uma** ida longa (navegador → Worker), e as consultas ficam em poucos milissegundos.

**Como se liga** ([Placement](https://developers.cloudflare.com/workers/configuration/placement/)):
- **Automático:** `"placement": { "mode": "smart" }` no wrangler.
  - Mede a duração das requisições em cada local e encaminha só quando um candidato é "significativamente mais rápido".
  - Só considera locais onde o Worker **já rodou**, e precisa de tráfego vindo de vários locais.
  - A análise pode levar até 15 minutos depois da implantação. 1% das requisições fica sem encaminhamento, como base de comparação.
  - Estados da análise: `SUCCESS`, `INSUFFICIENT_INVOCATIONS` e `UNSUPPORTED_APPLICATION` (ficou mais lento e voltou atrás).
- **Explícito:** `"placement": { "region": "aws:us-east-1" }`, que exclui o `mode`. Põe o Worker perto de uma região de nuvem, sem depender de tráfego.
  - Serve para recurso de endereço único. O D1 e os objetos do Wabotia estão num lugar só, o leste da América do Norte.
  - Para instalação pequena, com pouco tráfego e quase todo do Brasil, é o candidato mais seguro: o modo automático pode ficar em `INSUFFICIENT_INVOCATIONS`.
- **Como conferir:** o cabeçalho `cf-placement` (`remote-IAD`: encaminhado; `local-GRU`: sem encaminhar) e o estado em `GET /accounts/:conta/workers/services/:worker`.

**O que não muda ou pode piorar:**
- **Arquivos estáticos do painel:** não mudam. O `wrangler.jsonc` só põe o Worker na frente de `/api/*`, `/webhooks/*` e `/internal/*` (`run_worker_first`); o resto sai da borda mais próxima. Só o `/instalar` lê pela ligação `ASSETS` (`src/web-install.ts`), e esse sairia do local escolhido: é raro e não pesa.
- **Durable Objects:** não mudam de lugar. A documentação diz que já têm posicionamento automático; o ganho vem do Worker ficar perto deles.
- **WebSocket** (painel ao vivo, aparelhos): a documentação não trata. Hoje a conexão vai da borda ao objeto nos EUA; com o Worker encaminhado, passa pela borda, pelo Worker perto do objeto e pelo objeto. A distância é a mesma. É ponto de conferência no ensaio.
- **Chamadas de saída** (Zernio, Meta, Mercado Pago, Hermes): passam a sair dos EUA. As APIs da Meta e da Zernio também estão lá, então tende a melhorar. Nenhuma depende do país de origem da chamada.
- **Webhooks de entrada** (Meta, Zernio, Mercado Pago): já chegam de servidores nos EUA, e o Worker os atende onde chegam. Com o modo automático, não deveria haver ida a mais; o prazo de resposta não muda. Conferir no ensaio.
- **Métodos RPC e Worker sem fetch:** não são afetados. O Wabotia só usa o fetch.

**Instalador e atualizador** (núcleo, `src/release.ts` no `feat/pacote-v2`; nada editado aqui):
- `workerUploadV2` já copia `placement` dos ajustes instalados para os metadados do upload (lista `observability`, `limits`, `logpush`, `placement`…). Uma vez ligado (painel da Cloudflare, ou uma chamada à API), o posicionamento **sobrevive às atualizações**.
- Para vir ligado de fábrica:
  - o manifesto do pacote ganharia um `placement` (como `compatibility_date`);
  - o `workerUploadV2` usaria `settings.placement ?? m.placement`, preservando a escolha da instalação;
  - o instalador do navegador (`/instalar`) mandaria o mesmo campo no primeiro upload;
  - o `wrangler.jsonc` do repositório teria o mesmo valor, para o deploy manual.

**Ensaio proposto (instalação de teste, com a K; não implantar sem combinar com a orquestração):**
1. **Base, sem posicionamento.** A partir do Dell, no Brasil, 30 chamadas de cada:
   - `GET …/erp/v1/me`;
   - `GET …/erp/v1/plataforma/referencias/cnae?q=4744`;
   - uma escrita com `command_id` (lançamento de estoque);
   - duas rotas do atendimento que leem o D1, por exemplo a lista de conversas e a de contatos.

   Anote o p50 e o p95 no cliente, o `Server-Timing` (idas e duração no objeto), o `cf-placement` e o `cf-ray` (colo).
2. **Modo automático:** deploy com `"placement": { "mode": "smart" }`.
   - Gere tráfego por 15 a 20 minutos, também de fora do Brasil se der (os webhooks de teste ajudam).
   - Confira o estado em `GET /accounts/:conta/workers/services/<worker>` até `SUCCESS`, e repita o passo 1.
   - Se ficar em `INSUFFICIENT_INVOCATIONS`, registre e siga para o passo 3.
3. **Dica explícita:** deploy com `"placement": { "region": "aws:us-east-1" }`. Repita o passo 1; o `cf-placement` deve vir `remote-…` perto de IAD.
4. **Conferências nos passos 2 e 3:**
   - um aparelho ou o painel com WebSocket conectado por 5 minutos, recebendo uma mensagem;
   - um webhook de teste da Zernio ou da Meta, com o tempo de resposta;
   - o tempo de um arquivo estático, que não deve mudar;
   - o `/instalar`.
5. **Fim:** volte ao deploy sem `placement`, ou deixe o vencedor, conforme a orquestração decidir.

**Expectativa, a confirmar no ensaio:**
- Sem posicionamento: 3 × ~150 ms de ida e volta + ~150 ms do navegador ≈ 0,6 s, o que bate com os 0,57 s medidos.
- Com o Worker em IAD: ~150 ms do navegador + 3 × poucos ms ≈ 0,2 s por chamada da API do ERP. O atendimento ganha na mesma proporção das consultas ao D1 que faz por requisição.

## Se for preciso caber no gratuito

Não está planejado (o plano pago é exigido). Fica registrado: sem reescrever o
motor, as saídas seriam de agenda, não de consulta:

1. alarmes separados para a rodada dos módulos, para o motor e para as entregas,
   cada um com a própria conta;
2. limites menores por alarme (entregas, webhooks e bot runs) numa área no
   plano gratuito;
3. conclusão do carrinho em duas etapas (pedido na página, cobrança no alarme);
4. `RETURNING` nas escritas do Pedido e da Cobrança no lugar de reler a linha.
