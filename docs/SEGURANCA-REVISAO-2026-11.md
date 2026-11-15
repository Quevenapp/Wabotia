# Revisão de segurança de novembro de 2026: achados e correções

A revisão olhou `feat/modulos-nucleo` em `e213c8d` (15/11/2026) e encontrou 23
achados: 0 críticos, 4 altos, 8 médios e 11 baixos. Para cada um, abaixo, o
commit que o corrige e o teste permanente que reproduz o ataque e prova que
ele não funciona mais.

Correções em duas frentes, juntadas nesta branch:

- **Núcleo, Agenda, Ordem de Serviço, Reserva e Pedido** (sessão A, entrega
  21): commits `750939a` a `26c77ee`.
- **Suporte e Mensalidade** (sessão H, branch `fix/seguranca-suporte`):
  commits `6866d9f` a `09a1cb4`, juntados em `a41d81d`.

Os testes descartáveis da revisão (casos A a I) viraram testes permanentes,
com a asserção invertida: o caso agora precisa falhar.

| Caso da revisão | Achado  | Teste permanente                                                    |
| --------------- | ------- | ------------------------------------------------------------------- |
| A               | M2      | `tests/handoff-line-gate.test.ts`                                   |
| B               | A2      | `tests/suporte-seguranca.test.ts` ("B: cortesia…")                  |
| C               | A4      | `tests/suporte-seguranca.test.ts` ("C: CPF de outra pessoa…")       |
| D               | M1      | `tests/suporte-seguranca.test.ts` ("D: CNPJ de pagador em atraso…") |
| E               | M1      | `tests/suporte-seguranca.test.ts` ("E: CPF de pagador em dia…")     |
| F               | A2 + M1 | `tests/suporte-seguranca.test.ts` ("F: CPF alheio…")                |
| G               | A1      | `tests/mcp-path-safety.test.ts`                                     |
| H               | A3      | `tests/payment-hook-durable.test.ts`                                |
| I               | M1      | `tests/suporte-seguranca.test.ts` ("I: sessão de quem digitou…")    |

## Alta

| Achado                                                         | Correção                                                                                                                                                                                                                                                                                                                          | Commits                                                        | Testes                                             |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------- |
| **A1** Ferramentas MCP montavam o caminho com argumentos crus  | Cada argumento que cai no caminho (inclusive `profile`) precisa ser um identificador e entra codificado. O caminho final tem de ser o modelo da ferramenta preenchido, e o dispatch recusa caminho normalizado, com `?` ou `#`. `profile` fora das áreas da chave é recusado. As ferramentas de bot só recebem `conversation_id`. | `750939a` (e `5497155`, que tirou `phone`/`q` das ferramentas) | `mcp-path-safety`, `mcp`                           |
| **A2** Liberação "até o protocolo fechar" nunca terminava      | A liberação fica presa ao protocolo (aberto na hora, se não houver) e à sessão da conversa. Tem prazo máximo absoluto; assinatura e equipe reconsultam no portão; o estorno da mensalidade encerra.                                                                                                                               | `6866d9f`                                                      | `suporte-seguranca`                                |
| **A3** `onPaymentUpdated` entregue no máximo uma vez           | Fila durável de ganchos pendentes gravada no mesmo UPDATE condicionado (migração 0028), repetida pelo alarme e pelo reenvio do webhook. Na Mensalidade e no Suporte, a repetição refaz os passos com chave, sem virar pagamento em dobro.                                                                                         | `c29841a`, `9344ca5`                                           | `payment-hook-durable`, `mensalidade-revisao-base` |
| **A4** CPF/CNPJ alheio + plano vinculava o telefone ao pagador | Documento digitado nunca vincula nem reaproveita pagador. O contrato fica pendente (migração 0052), e pagador e assinatura só nascem no pagamento.                                                                                                                                                                                | `c95d3fd`                                                      | `suporte-seguranca`, `mensalidade-pagador`         |

## Média

| Achado                                                           | Correção                                                                                                                                                                                                                                                                                             | Commits                                    | Testes                                                                   |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------ |
| **M1** Suporte identificava o pagador só pelo documento digitado | Estado "aguardando confirmação" fora da fila, sem detalhe de cobrança para telefone não vinculado (migração 0057). `installmentPaid` só para a conversa da cobrança ou telefone autorizado. Limite de documentos e tentativas por telefone e dia.                                                    | `c95d3fd`                                  | `suporte-seguranca`                                                      |
| **M2** Linha "atendimento por pessoa" pulava o Suporte pago      | Com módulo de gancho ligado, a linha passa pelo menu, pelos fluxos e pelo portão com a origem `"line"`.                                                                                                                                                                                              | `4da1573`                                  | `handoff-line-gate`                                                      |
| **M3** Operações financeiras com `conversations:write`           | Permissão nova `billing:write`, nunca concedida a Vinki/Fagoo, exigida em `manager()` da Mensalidade e nas ações do Suporte para aplicações.                                                                                                                                                         | `6f70890`, `9344ca5`                       | `module-sensitive-base`, `mensalidade-revisao-base`, `suporte-seguranca` |
| **M4** Atendente mudava valor, desconto e plano                  | Valor, desconto e plano só por gerente.                                                                                                                                                                                                                                                              | `d580d8a`                                  | `mensalidade-permissoes`                                                 |
| **M5** Qualquer atendente ou integração vinculava telefone       | `/phones`, troca de documento e telefone novo em documento existente só por gerente; `mayAct` no `link-phone` do Suporte.                                                                                                                                                                            | `d580d8a`                                  | `mensalidade-permissoes`, `suporte-seguranca`                            |
| **M6** Leituras dos módulos com dados pessoais e notas           | `ctx.mayRead`/`ctx.redact`/`filteredHandlers`: dados pessoais exigem `contacts:read` e notas exigem `notes:read` em Agenda, OS, Reserva, Pedido, Mensalidade e Suporte. Documento mascarado para atendente na lista da Mensalidade.                                                                  | `6f70890`, `0a7e742`, `486310a`, `9344ca5` | `module-sensitive-data`, `mensalidade-revisao-base`, `suporte-seguranca` |
| **M7** `c.phone \|\| c.external_id` como identidade              | `ctx.verifiedPhone(c)` (nulo em conversa de integração) em todos os módulos.                                                                                                                                                                                                                         | `6f70890`, `0a7e742`, `9344ca5`            | `module-sensitive-data`, `mensalidade-revisao-base`, `suporte-seguranca` |
| **M8** Estorno, chargeback e pagamento duplicado sem tratamento  | `payment.duplicate` no núcleo (migração 0029). Estorno antes do primeiro aviso não confirma nem manda comprovante. Reserva e Pedido cancelam o que não começou; o resto vira pendência para a equipe. O Suporte faz uma cobrança por compra, cancela a aberta e registra pendências (migração 0058). | `af09127`, `1508c60`                       | `payment-refund-duplicate`, `pedido-api`, `suporte-compra`               |

## Baixa

| Achado                                                                        | Correção                                                                                                                                                                | Commits                         | Testes                                                                 |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------- |
| **B1** Portão do Suporte: grupos, erro libera, chave pelo relógio             | Núcleo: `row_id` no pedido e `{failClosed: true}`. Suporte: declara fail-closed, usa `row_id` na chave, e grupos seguram com aviso único.                               | `84c7df1`, `9f4cd5b`, `9344ca5` | `handoff-gate-failclosed`, `suporte-seguranca`                         |
| **B2** Webhook do Mercado Pago: `data.id` fora do manifesto e `ts` sem janela | `data.id` só o da consulta assinada, janela de 15 min, limite por IP.                                                                                                   | `2fe2582`                       | `payment-webhook-hardening`                                            |
| **B3** Foto do passo web e Flow de módulo desligado                           | Foto só com o passo aberto e o módulo ligado; Flow confere o módulo.                                                                                                    | `efd0991`                       | `pedido-whatsapp`, `structured-inbound`                                |
| **B4** Sockets não fechavam com permissão retirada ou credencial vencida      | Permissão retirada fecha os sockets da aplicação; a validade da credencial fica no socket e o alarme fecha os vencidos.                                                 | `08f34a8`                       | `socket-revocation`                                                    |
| **B5** Middleware de módulo respondia antes de conferir a área                | `canProfile` antes de `requireModule`; `%` malformado vira 404.                                                                                                         | `795ff38`                       | `module-route-guard`                                                   |
| **B6** `payment.cancel` cancelava cobranças de módulos                        | Cobrança de módulo só por administrador, dono da conversa ou `billing:write`.                                                                                           | `6651b26`                       | `payment-cancel-module`                                                |
| **B7** Mudanças de estado ignoravam `meta.changes`                            | Agenda (cancelar, confirmar, ausência, bloqueio na reserva) e Reserva (confirmação) conferem a linha mudada.                                                            | `e136da4`                       | `module-races`                                                         |
| **B8** Atribuição em massa                                                    | Reserva: lista branca em reservar e alterar (sem `at`). Mensalidade: lista branca na criação de assinatura (sem `sourceKey`).                                           | `8b3b2dc`, `154a211`            | `reserva-mass-assignment`, `mensalidade-permissoes`                    |
| **B9** Ação `service_order` e consentimento declarado pela equipe             | OS exige dono, administrador ou bot em atendimento. Pedido (`whatsapp_notices`) e Mensalidade (`billing_consent`) só por administrador, com evidência obrigatória.      | `8dc23a5`, `154a211`            | `os-orders`, `pedido-whatsapp`, `mensalidade-cobranca`                 |
| **B10** LIKE sem escape e listas IN sem limite                                | Pedido em lotes e com teto de produtos; `limit` inteiro em Reserva, OS e Pedido. Suporte e Mensalidade com LIKE `ESCAPE`, IN sem repetição e com teto, `limit` inteiro. | `b8428cd`, `09a1cb4`            | `module-query-limits`, `suporte-seguranca`, `mensalidade-revisao-base` |
| **B11** `createPayment` devolvia a cobrança da chave em qualquer estado       | Reaproveita só a aberta e válida, ou a paga; vencida ou cancelada vira cobrança nova com chave derivada.                                                                | `703fede`                       | `payments`                                                             |

## Observações da revisão

| Observação                                        | Situação                                                                                                                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Endereço público seguia a última origem vista     | Corrigido: fixo depois do primeiro valor, trocado pelo administrador (`26c77ee`, campo no painel em `9c5003a`). Teste `public-origin`.                         |
| Dados pessoais em eventos, notas e webhooks       | Sem mudança: coerente com o desenho atual. Fica como proposta marcar campo "sensível".                                                                         |
| Preços congelados no link do carrinho             | Sem mudança (o servidor recalcula pelo catálogo do link; o validador confere disponibilidade).                                                                 |
| Escopos dos módulos declarados vazios             | Em parte: `billing:write` e as regras de `contacts:read`/`notes:read` estão documentados em `docs/MODULOS.md`; as declarações `scopes` ainda não listam todas. |
| `GET payments/account/check` com efeito colateral | Sem mudança.                                                                                                                                                   |

## Limitações conhecidas

- **Agenda:** a reserva reconfere os bloqueios na mesma instrução, mas não o
  horário de trabalho; a consulta de disponibilidade continua conferindo.
- **Suporte:** a rotina periódica saiu (passava do teto de consultas do
  alarme). O portão grava o fim da liberação e a lista do painel mostra o
  estado efetivo.
- **Plano gratuito do Cloudflare:** a conclusão do carrinho e o alarme cheio
  passam de 50 consultas por invocação (`docs/LIMITES.md`).
