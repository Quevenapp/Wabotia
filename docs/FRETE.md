# Frete e transportadoras (Expedição)

Cotação de frete, etiqueta oficial e rastreio dos pedidos de venda, dentro da
**Expedição** do ERP (parte `erp-expedicao`, que depende de Vendas e Estoque).
Dois provedores, cada um um adaptador com a mesma interface (cotar,
contratar e gerar a etiqueta, cancelar e rastrear):

| Provedor | Para quem | Ambiente de teste |
|---|---|---|
| **Correios** | Quem tem contrato próprio com os Correios (cartão de postagem) | Homologação: `apihom.correios.com.br` |
| **Melhor Envio** | Agregador: Correios, Jadlog, Loggi e outras pela mesma conta, pago com o saldo da carteira | Sandbox: `sandbox.melhorenvio.com.br` |

Cada provedor nasce **desligado** e em **modo de teste**. Nada é chamado
enquanto o administrador não liga.

## Onde fica cada coisa

| O quê | Onde |
|---|---|
| Interface comum e erros | `src/erp/frete/provider.ts` |
| Adaptadores | `src/erp/frete/correios.ts`, `src/erp/frete/melhorenvio.ts` (registro em `providers.ts`) |
| Situação do rastreio, aviso ao cliente | `src/erp/frete/tracking.ts`, `notify.ts` |
| Serviço (cotar, escolher, contratar, etiqueta, cancelar, rastrear) | `src/erp/frete/service.ts` |
| Rotas e operações (tela, API e bots) | `src/erp/frete/routes.ts`, `contract.ts`; entram pela rota da Expedição em `/api/v1/profiles/<área>/erp-expedicao/frete/…` |
| Rodada do alarme | `src/erp/frete/schedule.ts` (rodada periódica dos módulos no Coordinator da área, a cada 1 a 5 minutos) |
| O que vai para o pedido | `src/erp/domains/shipping/freight.ts` (motor: `erp_shipping_freight_context` e `erp_shipping_freight_apply`) |
| Configuração, cotações, envios e eventos | D1, migração `0255_erp_frete.sql` |
| Credenciais | Cofre do núcleo (tabela `secrets`, cifrada com a `MASTER_KEY`), id `erp-frete:<provedor>:<área>` |
| Etiqueta em PDF | R2 da instalação (`MEDIA`), `erp-frete/<área>/<envio>.pdf` |
| Tela | `web/erp/Frete.tsx` (no pedido da Expedição e na aba **Frete e transportadoras**), porta `web/erp/frete-api.ts` |

Nenhuma tabela nova no esquema do ERP (a versão continua a mesma); nenhuma
classe nova de Durable Object; nenhuma dependência nova.

## Como funciona

1. **Cotar** (no pedido, depois de montar os volumes): CEP de origem da
   empresa (ou o CEP de origem dos ajustes), CEP de entrega do pedido (ou do
   cadastro do cliente) e os volumes da Expedição com peso e medidas. Cada
   provedor ligado devolve os serviços com preço e prazo; quem falhar aparece
   com o motivo, sem esconder os outros. A cotação vale 24 horas.
2. **Escolher** um serviço: o valor do frete e o prazo vão para o pedido pelo
   salvamento do próprio pedido (com todas as regras dele). Se o pedido não
   aceita (está "sem frete", já aprovado/atendido/cancelado, ou tem parcelas
   que somariam errado), o serviço e o valor ficam guardados na expedição e a
   tela diz o motivo e o que fazer.
3. **Contratar o envio**: um envio vivo por pedido. O provedor gera a
   etiqueta oficial (baixada em PDF e guardada no R2) e o código de rastreio
   vai para o pedido (etiqueta própria, romaneio e tela já o mostram).
   - **Resposta incerta** (rede caiu, tempo esgotado, erro 5xx do provedor):
     o envio fica "Confirmando com o provedor". Na próxima tentativa o Wabotia
     **consulta o provedor primeiro** pela referência que mandou junto
     (observação da pré-postagem nos Correios; etiqueta interna do carrinho no
     Melhor Envio). Achou: usa esse envio. O provedor confirma que não existe:
     contrata de novo. Não deu para confirmar: recusa e pede para tentar mais
     tarde. Nunca repete às cegas.
   - No Melhor Envio o pagamento e a geração da etiqueta seguem a situação
     lida do envio (pendente → paga; paga sem etiqueta → gera): consultar de
     novo nunca paga duas vezes.
4. **Cancelar**, quando o provedor permite (em geral antes da postagem). O
   código de rastreio sai do pedido. Cancelamento sem resposta também consulta
   antes de pedir de novo.
5. **Rastreio**: quando o pedido é marcado como **expedido** na Expedição, o
   envio entra na rodada do alarme. Consulta a cada 3 horas (falhas seguidas
   esperam até 12 horas), até 5 envios por rodada e por área; para quando
   chega a entregue, devolvido ou cancelado, ou depois de 90 dias. A linha do
   tempo aparece no pedido; **Atualizar rastreio** consulta na hora.
6. **Aviso ao cliente pelo WhatsApp** (ajuste da área, **desligado** por
   padrão): a cada mudança de situação, uma mensagem para o celular do
   cadastro do cliente, pela linha de WhatsApp da área, com a regra da janela
   de 24 horas (fora dela, pelo modelo de aviso da área). Um aviso por evento.

## Bots

Assunto **Frete e rastreio** nas concessões do bot:

| Operação | Tipo |
|---|---|
| Ver o frete e o rastreio de um pedido (`erp.expedicao.frete.pedido`) | Leitura |
| Cotar o frete de um pedido (`erp.expedicao.frete.cotar`) | Leitura (não grava nada no pedido) |
| Contratar o envio e gerar a etiqueta oficial (`erp.expedicao.frete.contratar`) | Sensível: o bot propõe e a pessoa confirma |
| Cancelar o envio contratado (`erp.expedicao.frete.cancelar`) | Sensível: o bot propõe e a pessoa confirma |

Escolher o serviço, baixar a etiqueta, atualizar o rastreio à mão e
configurar os provedores são só da tela.

## Quem pode o quê

- Ver o frete e cotar: os papéis do ERP que veem a expedição.
- Escolher, contratar e cancelar: Administrador, Vendas e Estoque.
- Configurar provedores e ajustes: só o **Administrador** do ERP.
- Parte Expedição (ou Vendas, ou Estoque) desligada: a rota responde
  `409 module_disabled` dizendo o que ligar, e a aba some com a Expedição.

## O que é preciso para ligar os Correios

1. Contrato com os Correios e acesso ao **Meu Correios** (CNPJ do contrato).
2. No Meu Correios › **Gestão de acesso a API's**: gerar o **código de
   acesso à API** e liberar as APIs **Token**, **Preço**, **Prazo**,
   **Pré-postagem** (com rótulo) e **Rastro** para o cartão de postagem.
3. Em Expedição › **Frete e transportadoras** › Correios, preencher:
   usuário do Meu Correios, código de acesso à API, **cartão de postagem**;
   opcionais: número do contrato, DR, e os **códigos dos serviços** do
   contrato (padrão `03220` SEDEX e `03298` PAC; confira os do seu contrato).
4. Deixar **Modo de teste** marcado, **Gravar** e **Testar conexão**.
   Para a homologação os Correios liberam o acesso a `apihom.correios.com.br`
   à parte; peça no atendimento do contrato.
5. Ligar, cotar e contratar um pedido de teste; conferir a etiqueta.
6. Desmarcar **Modo de teste** (passa a `api.correios.com.br`), testar de
   novo e ligar.

Limites conhecidos: nos Correios cada volume é um objeto; o envio contratado
pelo Wabotia leva **um volume** (pedido com mais volumes: recusa dizendo para
montar em um volume ou contratar pelo Melhor Envio). A consulta de uma
pré-postagem incerta sem número procura nas 150 mais recentes do cartão.

## O que é preciso para ligar o Melhor Envio

1. Conta no Melhor Envio (e outra no **sandbox**, `sandbox.melhorenvio.com.br`,
   para testar; o sandbox tem saldo fictício).
2. Em **Configurações › Tokens**, gerar um token com as permissões de
   carrinho, compra, geração, impressão, cancelamento, rastreio e leitura de
   pedidos e de usuário (`cart-read`, `cart-write`, `orders-read`,
   `shipping-calculate`, `shipping-cancel`, `shipping-checkout`,
   `shipping-generate`, `shipping-print`, `shipping-tracking`, `users-read`).
3. Em Expedição › **Frete e transportadoras** › Melhor Envio, preencher o
   **token** e o **e-mail técnico** (o Melhor Envio pede um contato da
   integração); opcional: os números dos serviços (vazio: todos da conta).
4. Com **Modo de teste** marcado: Gravar, Testar conexão, ligar, cotar e
   contratar um pedido de teste.
5. Gerar o token da conta de produção, trocar no campo, desmarcar **Modo de
   teste**, testar e ligar. **Contratar paga com o saldo da carteira.**

## Pontos a conferir na homologação real

Os testes do repositório falam só com provedores simulados (sem rede). Antes
de ligar em produção, confira no ambiente de teste de cada provedor:

- Correios: o nome dos campos de preço e prazo (`pcFinal`, `prazoEntrega`), o
  formato da lista de pré-postagens (`itens`, `observacao`) e o tempo do rótulo
  assíncrono (a tela pede para baixar de novo enquanto não fica pronto).
- Melhor Envio: a situação depois do pagamento (`released`) e da geração
  (`generated_at`), a busca por etiqueta interna (`/me/orders/search`) e o PDF
  da impressão (`mode: private`).
- Declaração de conteúdo: sem NF-e autorizada, o valor de cada item é o valor
  declarado (o pedido sem o frete) dividido pelas unidades.

## Testes

- `tests/erp/frete/provedores.test.mjs`: adaptadores contra provedores simulados (cotação, contratação, incerteza, consulta, etiqueta, cancelamento, rastreio, credencial fora das mensagens) e o contrato das rotas.
- `tests/erp/frete/motor.test.mjs`: leitura do pedido e gravação do frete, prazo e rastreio no motor.
- `tests/erp/frete/painel.test.mjs`: a tela do frete com a porta simulada.
- `tests/erp/frete/rotas.test.ts` (Worker): cofre, interruptores, parte desligada, administrador, bot e a rodada do rastreio.
