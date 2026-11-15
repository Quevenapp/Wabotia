# Ordem de Serviço

Para assistência técnica, oficina, lavanderia, costura e serviços parecidos:
o cliente deixa um item, a equipe analisa, envia o orçamento pelo WhatsApp, o
cliente aprova ou recusa, e é avisado quando o serviço fica pronto. Não tem
relação com os **protocolos** do atendimento: são registros separados.

## Ligar

**Gestão → Módulos → Ordem de Serviço** (administrador). Vem desligado. Com
ele ligado aparecem, em Gestão, **Ordens de serviço** (toda a equipe) e
**Ordem de serviço** (configurações, só administradores).

## Abrir uma ordem

Cada área de atendimento tem a sua numeração (1, 2, 3…).

- **No balcão**: Ordens de serviço → **Nova ordem**, com telefone, item,
  problema, observações internas, responsável e prazo previsto.
- **Na conversa**: a ação *Abrir ordem de serviço* liga a ordem à conversa e
  avisa o cliente. Hoje ela existe na API (`service_order`); o botão na tela
  da conversa ainda não foi feito.
- **Pelo cliente**: em Gestão → Ordem de serviço, use **Adicionar ao menu**
  em *Abrir ordem de serviço*. O cliente escolhe a opção, recebe um link,
  informa o item e o problema, aceita os termos e recebe o número no WhatsApp.

## Estados

Recebida → Em análise → Orçamento enviado → Aprovada ou Recusada → Em
execução → Pronta → Entregue. Uma ordem pode ser **Cancelada** antes de
entregue. Também dá para ir direto de Recebida ou Em análise para Em execução
(serviço sem orçamento), devolver uma Recusada como Pronta (o cliente retira
sem conserto) e voltar uma Pronta para Em execução (retrabalho). Cada mudança
fica no histórico com quem fez e quando.

## Orçamento

No detalhe da ordem: **Montar orçamento** (itens, quantidade, valor, validade
e uma observação) e **Enviar orçamento**. O cliente recebe os itens, o total
e a validade e responde **Aprovar** ou **Recusar**; a ordem muda sozinha e
guarda quem respondeu e quando. Se o cliente responder por telefone ou no
balcão, use *Cliente aprovou* ou *Cliente recusou*.

- Orçamento **vencido** não pode ser aprovado: envie de novo.
- Mudar um orçamento já enviado volta a ordem para *Em análise* até o novo
  envio; respostas ao orçamento anterior deixam de valer.
- Na linha oficial o orçamento chega como lista com **Aprovar** e **Recusar**;
  na linha QR, com "1. Aprovar / 2. Recusar". O cliente também pode escrever
  `APROVAR 12` ou `RECUSAR 12` (número da ordem). Com um menu aberto depois
  do orçamento, "1" e "2" são opções do menu.

## Acompanhamento e avisos

- Item de menu **Acompanhar ordem de serviço**: o cliente vê as ordens abertas
  do telefone dele e o estado de cada uma.
- Mensagens automáticas (Gestão → Ordem de serviço → Mensagens ao cliente):
  ordem aberta, orçamento aprovado ou recusado, serviço iniciado, pronta para
  retirada, entregue (com a garantia) e cancelada. Em branco, não envia.
  Marcadores: `{numero}`, `{item}`, `{estado}`, `{total}`, `{validade}`,
  `{garantia}`, `{pronto}`, `{previsao}`.
- Fora da janela de 24 horas da linha oficial, os avisos saem pelo modelo de
  notificação de Regras de atendimento.
- **Lembrete de retirada**: uma mensagem quando a ordem está pronta há mais
  dias que o configurado (padrão 3; 0 desliga).
- **Ordem parada**: sem mudança há mais dias que o configurado (padrão 7), o
  evento `os.stale` vai para as integrações.
- **Garantia**: contada da entrega (padrão 90 dias; 0 para sem garantia).

## Integrações e aplicativos

Rotas, formatos e eventos em [API.md](API.md#ordem-de-serviço-módulo-os) e no
OpenAPI (`/api/openapi.json`, tag Módulos).
