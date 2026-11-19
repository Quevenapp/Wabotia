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

**Parte comercial da fase 3.** O trabalho continua no atendimento e sua parte
comercial usa um documento protegido do ERP. Aprovação isolada não lança;
a primeira execução exige orçamento vigente aprovado ou preço fixo autorizado.
Pronta pode voltar à execução com motivo, sem nova postagem. Entrega registra
entrega/garantia e não confirma pagamento. Cancelamento não inventa estorno.

Os dados comerciais ficam congelados após efeito ou durante envio incerto.
Antes disso, o vínculo explícito de peça é gravado com a revisão e a saída
comercial no mesmo lote. Material sem vínculo não baixa estoque. Parte desligada
não impede o trabalho local nem autoriza lançamento retroativo ao religar.
“Tentar novamente” conserva a identidade do pedido; correção de corpo precisa
fechar o comando anterior. Uma falha no ERP permanece pendência, sem mudar o
estado operacional silenciosamente.

O aceite integrado ainda depende da verificação externa. Consulte
[FASE-3-INTEGRACOES.md](FASE-3-INTEGRACOES.md) para a ordem de liberação,
permissões, configuração, recuperação e campos ainda não exportados ao ERP.

**Contagem por estado.** `GET /profiles/{perfil}/service-orders` traz, além
de `data` e `next_cursor`, o mapa `counts`: número de ordens da área em cada
estado, para os chips de filtro e os totais das telas.

```json
"counts": { "received": 3, "analyzing": 1, "quoted": 2, "in_progress": 4, "ready": 1, "delivered": 12 }
```

- As chaves são os códigos de estado, iguais ao campo `status` das ordens:
  `received`, `analyzing`, `quoted`, `approved`, `declined`, `in_progress`,
  `ready`, `delivered`, `cancelled` (em inglês, minúsculas, com `_`).
- **Só aparecem os estados com ao menos uma ordem**; chave ausente vale 0.
  Os valores são inteiros.
- A contagem é da área inteira: **não** segue os filtros da consulta
  (`status`, `open`, `q`, `phone`, `conversation_id`) nem a paginação. Para
  "abertas", some tudo menos `delivered` e `cancelled`.
- Rótulos em português para exibir: Recebida, Em análise, Orçamento enviado,
  Aprovada, Recusada, Em execução, Pronta, Entregue, Cancelada.

## Tipo embutido no motor de trabalhos

O contrato do [motor de trabalhos](TRABALHOS.md), em integração, mantém esta
Ordem de Serviço como tipo virtual `service_order`. Não é necessário migrar
configurações: `service_orders`, formulários, termos, nove estados, orçamento,
garantia, lembretes e histórico das operações antigas conservam seu significado.
Ausência de `type_id` na abertura ou no menu continua selecionando esse tipo.

Os campos novos são adicionais: `type_id`, `type_revision`, `type_number`,
`type_label`, `type_plural_label`, `display_number`, `stage`, `stage_label`,
`labels`, `extra`, `fields`, `version`, `next_stages` e `stage_approval`.
`status_label` continua sendo o rótulo do estado de base. Uma linha antiga usa
`status` como etapa efetiva, `number` como número do tipo e campos extras vazios.

`number` continua global, inteiro positivo até 2.147.483.647. Após abrir tipos
diferentes, o número global e a sequência do tipo podem divergir; mensagens e
comandos antigos continuam usando o global. `next_cursor` continua texto ou
nulo. `counts` também não segue os novos filtros `type_id` e `stage`; para
contagens por tipo/etapa, solicite `facets=1`.

Aplicativos antigos mantêm o fluxo completo do embutido. Para tipos novos,
conservam leitura e ações antigas não ambíguas; recursos próprios exigem versão
atualizada. `next_statuses` contém somente estados de base. Uma ação ambígua em
`/status` retorna `409 stage_required`; a interface nova usa `next_stages`.
A decisão de orçamento continua recebendo `approve`/`decline` e devolvendo
`approved`/`declined`.

O detalhe antigo mantém `history=legacy` por padrão. Interfaces novas podem
pedir `history=none` e consultar `/history`, paginado e com eventos dos filhos.
O cadastro do embutido não deve ser copiado para `os_work_types`.
