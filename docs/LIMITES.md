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

## O que seria preciso para caber no gratuito

Não está planejado (o plano pago é exigido). Fica registrado: sem reescrever o
motor, as saídas seriam de agenda, não de consulta:

1. alarmes separados para a rodada dos módulos, para o motor e para as entregas,
   cada um com a própria conta;
2. limites menores por alarme (entregas, webhooks e bot runs) numa área no
   plano gratuito;
3. conclusão do carrinho em duas etapas (pedido na página, cobrança no alarme);
4. `RETURNING` nas escritas do Pedido e da Cobrança no lugar de reler a linha.
