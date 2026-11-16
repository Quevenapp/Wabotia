# Caixa (módulo `caixa`)

Frente de caixa (PDV) para o tablet do balcão: abertura com troco inicial,
venda por toque na grade de produtos com foto, leitor de código de barras,
troco, sangria, suprimento, devolução e fechamento com a conferência do
dinheiro. Usa o catálogo, o estoque e a venda do módulo
[Vendas e orçamento](VENDAS.md).

- `requires: ["vendas"]`: só liga com Vendas ligado; desligar Vendas pede
  `cascade` e desliga o Caixa junto.
- Tela no painel: **Caixa** (trilho e Gestão). A tela nativa dos apps vem
  depois (abaixo, "Para os apps nativos").
- API: [API.md](API.md), seção "Caixa"; OpenAPI, grupo "Caixa".
- Código: `src/modules/caixa/`, migração `0062`. Usa de Vendas só
  `src/modules/vendas/public.ts`.

## Conceitos

- **Caixa** (`caixa_registers`): o ponto de venda físico ("Caixa 1",
  "Balcão"). Administrador cria, renomeia e desativa.
- **Sessão** (`caixa_sessions`): do abrir ao fechar. Um caixa tem no máximo
  uma sessão aberta (índice único no banco: `409 session_open`). Numeração
  por área.
- **Movimentos de dinheiro** (`caixa_moves`): sangria (`withdrawal`, retirada
  para o cofre) e suprimento (`supply`, reforço de troco). A sangria não pode
  passar do dinheiro esperado na gaveta (`409 insufficient_cash`).
- **Vendas e devoluções** ficam em Vendas (`vendas_sales.session_id`,
  `vendas_returns.session_id`). Os totais da sessão são calculados a partir
  delas: nada é contado em dobro.

## Quem opera: o papel Caixa (`caixa:cashier`)

O módulo declara o papel `cashier` (`grants`, veja "Papéis por pessoa" em
[MODULOS.md](MODULOS.md)). O administrador o concede em **Gestão → Pessoas e
acessos** (ou `PUT /settings` com `{"module_grants": {"caixa:cashier": [...]}}`).

| Ação | Quem |
|---|---|
| Ver caixas, grade, código de barras, sessões e relatórios | qualquer pessoa da área; aplicação com `conversations:read` |
| Abrir, vender, sangria, suprimento, devolução no caixa | administrador ou pessoa com `caixa:cashier`; aplicação com `billing:write` |
| Fechar | quem abriu (com o papel) ou administrador; aplicação com `billing:write` |
| Criar, renomear e desativar caixas | administrador |

Sem o papel: `403 role_required`. O administrador **não** recebe o papel
sozinho; ele opera pelo próprio papel de administrador (o módulo confere
`actor.role`). Para aparecer como operador de caixa numa lista
(`GET /people?grant=caixa:cashier`), ele precisa receber o papel como
qualquer pessoa. Aplicações e aparelhos pareados nunca têm papel: valem os
escopos. `GET /caixa` traz `can_operate` para a tela esconder abrir e vender.
Retirar o papel vale na hora, mesmo com a sessão aberta.

## Dinheiro esperado na gaveta

```
troco inicial + suprimentos − sangrias
+ dinheiro recebido nas vendas concluídas − troco dado
− dinheiro devolvido nas devoluções desta sessão
```

Vendas canceladas não contam; vendas aguardando o Pix do Mercado Pago não
entram no dinheiro. No fechamento a pessoa informa o dinheiro contado; o
Wabotia grava o esperado, a diferença (contado − esperado: sobra ou falta) e
congela o resumo por forma de pagamento. Fecha quem abriu ou um
administrador.

Venda de uma sessão já fechada não se cancela (o fechamento já foi
conferido): registra-se uma devolução no caixa aberto, e o dinheiro sai da
gaveta dele (`POST /caixa/sessions/{aberta}/returns`).

## Formas de pagamento no caixa

As ligadas em **Regras e nota fiscal**: dinheiro (com troco), crédito e
débito na maquininha, Pix na chave da loja (a pessoa confere o recebimento) e
outra. O caixa aceita mais de uma forma na mesma venda (parte no cartão,
parte em dinheiro). O Pix e o link do Mercado Pago exigem a conversa do
cliente no WhatsApp (`conversation_id`); o caixa do painel não os oferece.

Pix do Mercado Pago no balcão, com o QR na tela e sem WhatsApp, precisa de
uma cobrança sem conversa no núcleo (`ctx.charge` hoje exige conversa):
pedido feito à sessão A.

## Tablet no balcão (painel)

A tela do painel funciona no navegador do tablet: grade de produtos com foto
em cartões grandes, categorias em botões no topo, carrinho ao lado (paisagem)
ou embaixo (retrato), campo de código de barras sempre pronto (leitores USB e
Bluetooth "digitam" o código e o Enter), cobrança com atalhos de notas e o
comprovante para imprimir. O caixa escolhido fica lembrado no aparelho.

## Para os apps nativos (sessões C e J)

Telas a fazer (nativas, sem webview), com dados de demonstração, como as
outras verticais:

1. **Mostrar** só com `{"id":"caixa"}` em `GET /api/v1/capabilities`;
   `409 module_disabled` esconde a tela. Pessoa logada (bearer); o modo
   aparelho pareado não serve para vender (as escritas de aplicação exigem
   `billing:write`, que não é concedida a aparelhos pareados).
2. **Escolher e abrir o caixa**: `GET /caixa` → `registers` (com `session`
   aberta); `POST /caixa/registers/{id}/open {opening_cents}`. Guardar o
   caixa escolhido no aparelho. Com `can_operate: false`, mostrar só o aviso
   "Você não tem o papel Caixa" (`403 role_required` também leva a ele).
3. **Grade**: `GET /caixa/grid` uma vez ao abrir e a cada
   `vendas.product_changed`/`vendas.stock_moved` em `GET /events` (ou a cada
   minuto). Foto: `GET /api/v1/profiles/{p}/media/{photo_media_id}/content`
   com o bearer (guardar em cache por id). Cartões de pelo menos 48 pt,
   cor da categoria, "sem estoque" e "estoque baixo" sinalizados.
4. **Leitor de código de barras**: câmera (ML Kit no Android,
   AVFoundation/VisionKit no iOS) e leitor externo (teclado HID) →
   `GET /caixa/lookup?code=`; procurar primeiro no `ean`/`sku` da grade em
   memória e só depois na API.
5. **Carrinho e cobrança**: produto fracionado pede quantidade (teclado
   numérico, até 3 casas); desconto em R$ ou %; formas de `payment_methods`
   (sem `pix` e `link`); dinheiro com "valor recebido" e troco.
   `POST /caixa/sessions/{id}/sales` com uma `Idempotency-Key` gerada **uma
   vez por venda** e reaproveitada nas novas tentativas (rede ruim no balcão:
   repetir não duplica nem baixa duas vezes). Erros: `out_of_stock` (mostrar
   os itens), `discount_limit`, `payment_short`, `session_closed`.
6. **Comprovante**: `GET /vendas/sales/{id}/receipt?columns=32|48` →
   imprimir pelo ThermalPrinterKit com os dados estruturados
   (`establishment`, `sale`) ou o `text` pronto; imprimir só com o OK de quem
   opera (o padrão do app).
7. **Sangria e suprimento**: `POST /caixa/sessions/{id}/moves`.
8. **Devolução**: escolher a venda da sessão (`GET /caixa/sessions/{id}` →
   `sales`) ou pelo número (`GET /vendas/sales?q=<número>`), itens e
   quantidades → `POST /caixa/sessions/{id}/returns`.
9. **Fechar**: `GET /caixa/sessions/{id}` → `summary` (esperado na gaveta e
   por forma), pedir o dinheiro contado → `POST /caixa/sessions/{id}/close`;
   imprimir `GET /caixa/sessions/{id}/report?columns=…`.
10. **Demonstração**: um caixa aberto, 2 categorias e 6 produtos com foto
    embutida, para o revisor da loja ver a tela sem servidor.

Também úteis nos apps, fora do caixa: consulta de produto e estoque
(`GET /vendas/products?q=`, `/vendas/lookup`), entrada de mercadoria
(`POST /vendas/stock/moves` com `type: "entrada"`) e a lista de orçamentos com
Enviar e Converter.
