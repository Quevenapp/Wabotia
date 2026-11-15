# Pedido

Para lanchonete, pizzaria, marmitaria, açaí e confeitaria por encomenda: o
cliente toca em **Cardápio** no menu do WhatsApp, recebe as imagens do
cardápio e o botão **Fazer pedido**, monta o carrinho numa página leve no
celular e volta ao WhatsApp com o número do pedido. A cozinha acompanha no
**quadro** do painel e cada mudança de estado avisa o cliente.

## Ligar e montar o cardápio

1. **Gestão → Módulos → Pedido**: ligue o módulo (vem desligado).
2. **Gestão → Cardápio e loja → Cardápio**: crie as categorias (Lanches,
   Bebidas…) e os itens com preço, descrição e foto. A foto vai para os
   arquivos da área; a página do carrinho é pública e só mostra fotos com
   endereço HTTPS (campo **Foto pública**).
3. **Adicionais**: grupos reutilizáveis com mínimo e máximo de escolhas.
   Mínimo 1 e máximo 1 vira escolha única (ponto da carne, tamanho, sabor);
   mínimo 0 deixa opcional (até 3 adicionais). Cada opção tem preço próprio.
4. **Imagens**: até 10 imagens (JPG, PNG) ou um PDF, enviadas no WhatsApp
   antes do botão Fazer pedido.
5. **Loja e mensagens**: horário, retirada e entrega, taxa, pedido mínimo,
   tempo estimado, formas de pagamento, alertas e textos. Ali também ficam os
   botões que põem **Cardápio** e **Acompanhar pedido** no menu do WhatsApp.

Item ou opção acabou? Desligue o interruptor (a cozinha pode, sem ser
administradora): o item aparece no carrinho sem quantidade.

## Regras da loja

- **Horário** em Brasília, até 3 faixas por dia; fim antes do início passa da
  meia-noite (18:00 às 02:00). Sem faixas, a loja fica sempre aberta.
- **Pausar a loja** (quadro da cozinha): "loja fechada agora", para qualquer
  pessoa da equipe. Fechada ou pausada, o Cardápio responde com o horário (ou
  a mensagem da pausa).
- **Carrinho aberto antes**: ao pausar, os links de carrinho abertos são
  cancelados; quem abrir ou enviar vê "Link indisponível" e pede um novo
  quando a loja voltar. Se a loja fechar pelo horário ou um item esgotar
  enquanto o cliente monta, a página recusa ao concluir, mostra o motivo e o
  link continua aberto para ajustar.
- **Pagamento**: Pix e cartão pelo link saem pela **Cobrança** (Gestão →
  Cobrança, Mercado Pago) e só aparecem com ela configurada; dinheiro e
  maquininha são pagos na entrega ou na retirada.
- **Preparo só depois de pago**: o pedido online espera a confirmação do
  Mercado Pago em "Aguardando pagamento"; desligado, vai direto para o
  preparo e o pagamento fica acompanhado à parte.
- **Prazo para pagar**: validade do Pix e do link e prazo para o cliente
  escolher como pagar; vencido, o pedido é cancelado e o cliente avisado.

## Como o cliente pede

1. Toca em Cardápio, recebe as imagens e o botão Fazer pedido (na linha QR,
   o link no texto). O link vale o tempo configurado e é de uso único.
2. Monta o carrinho: quantidade, adicionais, observação por item e outra
   montagem do mesmo item (um X-Burger sem cebola e outro com bacon), retirada
   ou entrega com endereço, nome e observação. Os valores são sempre
   recalculados pelo servidor.
3. Confirma e recebe no WhatsApp o resumo com o **número do pedido**.
4. Com mais de uma forma de pagamento, escolhe pelos botões (ou pelo número,
   na linha QR). Pix e link chegam como cobrança; dinheiro pergunta o troco.
5. **Acompanhar pedido** no menu mostra os pedidos em andamento.

Mensagens do cliente como "já paguei" nunca mudam o pagamento: só o webhook
do Mercado Pago confirma. Cada mudança de estado avisa o cliente; fora da
janela de 24 horas, pelo modelo de notificação de Regras de atendimento.

Pelo **catálogo do WhatsApp** (Meta): o carrinho enviado vira pedido quando
todos os produtos têm o **código no catálogo** (`retailer_id`) cadastrado no
item, com os preços deste cardápio. O cliente responde retirada ou entrega e o
endereço na conversa. Item com escolha obrigatória recebe o link do carrinho;
produto sem código vai para a equipe.

## Cozinha e balcão

**Gestão → Pedidos** (também no trilho): quadro com uma coluna por estado —
Aguardando pagamento, Novos, Em preparo, Prontos para retirada, Saíram para
entrega — com o tempo no estado e destaque em vermelho quando passa do alerta.
No pedido: itens, adicionais, observações, endereço, pagamento e histórico;
botões do próximo estado, Cancelar (com motivo ao cliente), registrar o
pagamento recebido na hora e **Comanda** para imprimir (58 ou 80 mm, com os
dados de Gestão → Estabelecimento).

Estados: aguardando pagamento → recebido → em preparo → pronto para retirada
ou saiu para entrega → entregue, além de cancelado. Um passo para trás é
permitido para corrigir engano.

Na conversa, **Pedidos** mostra os pedidos em andamento do cliente e
**Montar pedido para este cliente** envia o link do carrinho.

## Integrações e aplicativos

Rotas, formatos e eventos `pedido.*` em [API.md](API.md#pedido-módulo-pedido).
Os apps leem o quadro em `GET /profiles/{p}/pedido/board` e a comanda em
`GET /profiles/{p}/pedido/orders/{id}/ticket`. Pedido de balcão:
`POST /profiles/{p}/pedido/orders`. Bots: ferramentas MCP `pedido_cardapio`,
`pedido_consultar` e `pedido_enviar_carrinho`.

## Limites desta versão

- Nota fiscal fica fora.
- A forma de pagamento (e o troco, no dinheiro) é escolhida na página do
  carrinho; se o cliente deixar em branco, o WhatsApp pergunta depois.

## Avisos fora da janela de 24 horas

Quem pede pelo WhatsApp (carrinho ou catálogo) fica com o consentimento de
avisos do pedido registrado: os avisos de estado saem pelo modelo de
notificação mesmo depois de 24 horas (encomenda para outro dia). No balcão,
com só o telefone, marque `whatsapp_notices` quando o cliente aceitar
receber os avisos: o Wabotia abre a conversa na linha oficial.

Cancelar um pedido com o Pix ou o link ainda abertos cancela a cobrança. Se
o cliente pagar mesmo assim, o pedido fica marcado para estorno. Pagamento
estornado ou contestado no Mercado Pago: o pedido que ainda não foi para o
preparo é cancelado; em preparo, pronto ou entregue, vira pendência para a
equipe (nota interna na conversa e `needs_review` em `pedido.refunded`). Com
"pagar antes do preparo", o aviso "Pedido nº X recebido" é o comprovante e o
"Pagamento recebido" do núcleo não é enviado.
