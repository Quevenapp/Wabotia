# Ordem de Serviço

Para assistência técnica, oficina, lavanderia, costura e serviços parecidos:
o cliente deixa um item, a equipe analisa, envia o orçamento pelo WhatsApp, o
cliente aprova ou recusa, e é avisado quando o serviço fica pronto. Não tem
relação com os **protocolos** do atendimento: são registros separados.

## Ligar

**Gestão → Módulos → Ordem de Serviço** (administrador). Vem desligado. Com
ele ligado, entre pelo botão **ERP**. O módulo oferece **Ordens de serviço**
(toda a equipe) e **Configurar** (só administradores). O nome da lista pode
vir do vocabulário da área, sem se repetir no título do grupo lateral.

A lista reúne a clássica e os modelos personalizados ativos. **Modelo → Todos
os modelos** é o padrão; escolha um para filtrar e consultar suas etapas.
Também há busca, situação, responsável e prazo de/até. **Meus prazos** fica
no topo. Os detalhes existentes são preservados: diálogo da clássica e página
do personalizado. Os endereços antigos, inclusive `/app/gestao/...`, continuam
abrindo a página ou pré-selecionando o modelo correspondente.

## Abrir uma ordem

Cada área de atendimento tem a sua numeração (1, 2, 3…).

- **No balcão**: Ordens de serviço → **Nova ordem**; com vários modelos ativos,
  escolha primeiro o modelo. Na clássica, informe telefone, item,
  problema, observações internas, responsável e prazo previsto.
- **Na conversa**: a ação *Abrir ordem de serviço* liga a ordem à conversa e
  avisa o cliente. Hoje ela existe na API (`service_order`); o botão na tela
  da conversa ainda não foi feito.
- **Pelo cliente**: em ERP → Configurar → **WhatsApp**, use **Adicionar ao menu**
  em *Abrir ordem de serviço*. O cliente escolhe a opção, recebe um link,
  informa o item e o problema, aceita os termos e recebe o número no WhatsApp.

## Modelos para cada segmento

Em **Configurar → Modelos**, cada modelo define campos, etapas e mensagens
de um tipo de serviço. **Criar modelo** permite começar do zero ou escolher
um exemplo dos modelos de área, sem aplicar a área inteira. Campos e etapas
recebem IDs a partir do rótulo; a edição desses identificadores fica em
**Avançado**. Na tela usamos “modelo”; os nomes internos e as APIs permanecem.

Os exemplos de oficina cadastram o **Veículo** uma vez (placa opcional e
pública de até 10 caracteres, marca e modelo, ano, cor e tipo de combustível) e
registram em cada ordem quilometragem, nível de combustível na entrada, última
manutenção informada pelo cliente, peças previstas, avarias e serviço executado.
Quem já aplicou um desses modelos recebe o aviso **O modelo padrão mudou:
revisar e aplicar**, com prévia do que passa ao objeto e do que fica na ordem.
Ordens existentes não mudam. A placa antiga sensível não muda de classificação
nem é copiada para o cadastro do veículo: a placa pública é informada de novo.

## Objeto do serviço

Em **Configurar → Modelos**, o campo **Objeto do serviço** liga o modelo a um
tipo de objeto (veículo, equipamento, imóvel, animal, evento), cadastrado ali
mesmo. O editor mostra numa lista só os campos “Do objeto” e os “Desta ordem”,
e permite exigir um campo a partir de uma etapa ou ao sair dela, além de marcar
até quatro colunas e filtros da lista.

- **Nova ordem**: escolha o contato; aparecem os objetos ativos dele daquele
  tipo e a opção **Cadastrar outro** no mesmo diálogo. Os dados do objeto ficam
  separados dos desta ordem. Trocar o contato pede confirmação.
- **Detalhe**: o bloco “Veículo na abertura” (ou o rótulo do tipo) mostra a
  cópia gravada naquela ordem, só para leitura, com o link **Ver cadastro atual
  e histórico**. Uma etapa com campos pendentes abre o preenchimento antes de
  tentar de novo.
- **Tela do objeto**: dono, campos, arquivamento, revisão adotada, **Nova ordem
  para este objeto**, histórico de ordens com os campos de cada visita e
  **Último atendimento** (última ordem entregue).
- **Ficha do contato**: a coleção **Objetos do cliente** abre a tela do objeto.
- **WhatsApp**: o link de abertura pergunta “Qual veículo?” com os objetos do
  próprio cliente e **Informar outro**. Cada cliente só vê os próprios objetos.
- **Ordens antigas**: nada é convertido sozinho. Numa ordem personalizada sem
  objeto, a ação de vínculo cria ou associa um objeto do mesmo cliente, sem
  copiar quilometragem nem campos privados; a cópia aparece como “Vinculado
  posteriormente”.

Editar o cadastro do veículo não muda as visitas anteriores: uma visita com
60.000 km continua com 60.000 km e com a cor capturada naquela abertura. Quem
não usa objeto não vê diferença. Regras, rotas, limites e custos estão em
[TRABALHOS.md](TRABALHOS.md#objeto-do-serviço).

Modelos de mesmo nome mostram a origem, e a prévia de aplicação de área avisa
quando já existe um equivalente. Para detalhes, consulte [TRABALHOS.md](TRABALHOS.md).

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
- Mensagens automáticas (ERP → Configurar → WhatsApp):
  ordem aberta, orçamento aprovado ou recusado, serviço iniciado, pronta para
  retirada, entregue (com a garantia) e cancelada. Em branco, não envia.
  Marcadores: `{numero}`, `{item}`, `{estado}`, `{total}`, `{validade}`,
  `{garantia}`, `{pronto}`, `{previsao}`. Nos modelos personalizados com
  objeto, `{objeto}` traz a identificação pública da cópia da ordem.
- Fora da janela de 24 horas da linha oficial, os avisos saem pelo modelo de
  notificação de Regras de atendimento.
- **Lembrete de retirada**: uma mensagem quando a ordem está pronta há mais
  dias que o configurado (padrão 3; 0 desliga).
- **Ordem parada**: sem mudança há mais dias que o configurado (padrão 7), o
  evento `os.stale` vai para as integrações.
- **Garantia**: contada da entrega (padrão 90 dias; 0 para sem garantia).

Esses três prazos da clássica ficam em **Configurar → Prazos e garantia**.
Na mesma aba há atalhos para os Recursos dos modelos personalizados.

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
