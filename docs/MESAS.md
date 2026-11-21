# Mesas

Conta da mesa pelo celular do garçom, sobre o cardápio e o quadro da cozinha
do [Pedido](PEDIDO.md). Módulo `mesas`, desligado por padrão; só liga com o
Pedido ligado (desligar o Pedido desliga as Mesas). Contrato da API em
[API.md](API.md), seção "Mesas".

## Ligar e cadastrar

1. **Gestão → Módulos**: ligue o Pedido e depois as Mesas.
2. Cadastre o cardápio no Pedido (Gestão → Cardápio e loja). As mesas usam os
   mesmos itens, adicionais e esgotados.
3. **Gestão → Mesas → Mesas e comandas** (administrador): cadastre várias de
   uma vez ("Mesa", de 1 a 20, ambiente "Salão") ou comandas individuais
   ("Comanda", de 1 a 50, ambiente "Bar"). Ali também fica a taxa de serviço
   (padrão 10%; 0 desliga).

## Quem opera as mesas

- **Garçom**: o administrador dá o papel **Garçom** (`mesas:waiter`) em
  Gestão → Pessoas e acessos, na edição da pessoa ("Papéis nos módulos").
  Quem tem o papel abre, lança, transfere, junta, pede a conta, registra
  pagamentos e fecha.
- **Administrador**: opera as mesas mesmo sem o papel (cobre o salão quando
  falta gente), mas só aparece na lista de garçons se receber o papel.
- **Atendente sem o papel**: vê o mapa e as contas, mas não muda nada
  (`403 role_required`). O atendente do WhatsApp não vira garçom sozinho.
- **Aplicações** (PDV, totem) operam com `conversations:write`; não têm papel.
- **Cozinha**: o quadro do Pedido não exige o papel: quem atende o Pedido muda
  o estado dos pedidos da mesa e cancela um item (o pedido dele).
- **Trocar o garçom da mesa**: "me" assume (garçom ou administrador); passar
  a outra pessoa é do administrador (ou da aplicação), e só para quem tem o
  papel. `GET /mesas` traz `waiters` (quem tem o papel) e `can_operate` (se
  quem lê pode operar), para o app esconder os botões.

## No salão

- **Mapa**: cada mesa aparece livre, ocupada ou fechando (pediu a conta), com
  o total, há quanto tempo está aberta e quantos pedidos estão na cozinha ou
  prontos para servir.
- **Abrir**: toque na mesa livre, informe as pessoas (opcional).
- **Lançar itens**: escolha os itens, o ponto, os adicionais e a observação
  ("sem cebola"), como no carrinho. Cada envio vira um pedido numerado no
  **quadro da cozinha** do Pedido, já em "Recebido", com o nome da mesa. A
  cozinha segue Recebido → Em preparo → Pronto para servir → Servido; a
  comanda da cozinha sai com "MESA 5".
- **Cancelar um item já enviado**: cancele o pedido dele no quadro (ou no
  detalhe da conta) e lance de novo o que valer.
- **Transferir**: a conta inteira vai para uma mesa livre.
- **Juntar mesas**: a outra mesa vem para esta (pedidos, pagamentos e
  pessoas); ela fica livre.
- **Pedir a conta**: a mesa fica "fechando". Pedir mais alguma coisa reabre.
- **Conta**: parcial a qualquer momento, com a divisão por pessoa (os
  centavos que sobram vão para as primeiras, a soma bate) e o texto pronto
  para a impressora térmica (32, 42 ou 48 colunas). "Não é documento fiscal".
- **Taxa de serviço**: entra nas contas novas conforme a configuração; o
  garçom tira ou põe em cada conta.
- **Pagamento parcial**: uma pessoa paga a parte dela (dinheiro com troco,
  cartão, Pix da loja ou outro). Lançou errado: "Desfazer", com o motivo.
- **Fechar**: registra o que falta e fecha. Só fecha pago; a mesa fica livre
  e os pedidos da cozinha ficam pagos no Pedido.
- **Cancelar conta**: só a aberta por engano, sem pedidos nem pagamentos.

Os pagamentos da mesa são registros da equipe: nada é cobrado online (a
Cobrança precisa de uma conversa do WhatsApp para enviar o Pix).

## Para os apps

O garçom usa o app nativo. As telas são o mapa (`GET /mesas`), a conta
(`GET /mesas/tabs/{id}`), o lançamento (`GET /pedido/menu` +
`POST /mesas/tabs/{id}/orders`), a conta para imprimir
(`GET /mesas/tabs/{id}/bill?split=N&columns=32`) e as ações da conta. Reler o
mapa ao receber `mesas.*` ou `pedido.status_changed` com `tab_id` em
`GET /events`. Toda escrita leva `Idempotency-Key`: o mesmo toque repetido não
lança o pedido duas vezes. A demonstração do painel (`/app?demo=1`, Gestão →
Mesas) tem mesas livres, ocupadas e uma fechando, para a demonstração dos
apps.

## Proposta: cliente pede pela mesa (não implementado)

Um QR por mesa, impresso no display, que abre o cardápio com a mesa já
escolhida, sem app e sem login:

1. O QR leva a `https://wa.me/<número>?text=Mesa%205%20·%20<código>`. O
   cliente manda a mensagem; o Vinki reconhece o código da mesa e responde
   com o botão "Fazer pedido" (o mesmo carrinho do Pedido), já marcado
   "Mesa 5", sem retirada/entrega nem forma de pagamento.
2. O pedido só entra na conta se a mesa estiver aberta. Para que alguém fora
   da mesa (ou com uma foto antiga do QR) não lance na conta dos outros, o
   código muda a cada conta aberta (o garçom mostra o QR da conta no app ou
   imprime no início) e o pedido do cliente chega à cozinha como
   "Aguardando o garçom": o garçom confirma com um toque.
3. A conta continua com o garçom; o cliente pode pedir a conta pelo mesmo
   WhatsApp ("Pedir a conta" põe a mesa em "fechando").

Custo estimado: um código por conta (coluna nova), um estado novo no quadro e
o item de menu da mesa. Fica para depois do uso real do salão.

## Limites

- Até 300 mesas e comandas por área; 100 por cadastro em faixa.
- Até 100 linhas por envio para a cozinha, como no pedido de balcão.
- Divisão de 2 a `split_max` pessoas (padrão 20, até 50).
- Consultas ao D1 (docs/LIMITES.md): lançar itens 25, mapa 7, fechar 20.
- Sem divisão por item (cada um paga o que consumiu): use o pagamento parcial
  com o valor da pessoa. Sem desconto nem couvert por enquanto.
