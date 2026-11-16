# Entrega: acompanhamento em tempo real

O entregador **não precisa de login**: baixa o app Wabotia, toca em
**Escanear pedido** e lê o QR da entrega, que a loja mostra no painel ao
despachar e imprime na via do pedido. Com o app aberto, o celular manda a
posição para o servidor. O cliente recebe no WhatsApp o link **Acompanhar**
(página com o mapa, sem instalar nada), a previsão de chegada ou a
localização a cada X minutos, e os avisos de saída, "chegando" e entregue. O
entregador conversa com a loja e com o cliente pelo app, sem ver o número do
cliente. Ao concluir, o acesso é revogado.

Entregador fixo da loja, com login, também funciona: a pessoa recebe o papel
**Entregador** (`entrega:courier`) em Gestão → Pessoas.

Serve para os pedidos do módulo **Pedido** com entrega e para entregas
avulsas; o desenho já prevê visitas técnicas da Ordem de Serviço (veja
"Outras origens"). Contrato das rotas em
[API.md](API.md#entrega-módulo-entrega).

## Ligar

1. **Gestão → Módulos → Entrega**: ligue (vem desligado).
2. Opcional: dê o papel **Entregador** às pessoas fixas da equipe (Gestão →
   Pessoas e acessos, `entrega:courier` no acesso da pessoa). Entregadores
   avulsos não precisam de nada: usam o QR.
3. Configure a chave `entrega` (`PUT /profiles/{p}/settings`):
   - `qr`: `claim_minutes` (validade do QR até ser lido, 5 a 120, padrão
     20) e `credential_hours` (validade do acesso depois de lido, 1 a 6,
     padrão 3; ele termina antes, quando a entrega acaba). Prazos curtos
     porque o QR sai impresso e pode ser fotografado.
   - `confirm_code`: `enabled` (padrão **desligado**, decisão do usuário
     pendente) e `attempts` (3 a 10, padrão 5): código de 4 dígitos que o
     cliente recebe com o aviso de saída e informa ao entregador (veja
     "Código de confirmação").
   - `speed_kmh` (padrão 25) e `road_factor` (1,3): velocidade média e quanto
     as ruas somam à linha reta, para a previsão.
   - `updates`: `mode` `eta` (previsão em texto), `location` (mensagem de
     localização do WhatsApp), `eta_and_location` ou `off`; `every_minutes`
     (5 a 60, padrão 10) e `max` (0 a 20, padrão 6) por entrega.
   - `tracking_link` (padrão sim) e `link_hours` (validade do link, 1 a 24 h,
     padrão 4).
   - `arriving_radius_m` (padrão 500): raio do aviso "chegando".
   - `notices`: liga ou desliga os avisos de saída, chegada e entrega.
   - `outside_window`: `milestones` (padrão) ou `none` — veja "Janela de 24 h".
   - `ask_location` (padrão sim): sem destino no mapa, pede ao cliente que
     envie a localização.
   - `app`: `sample_seconds` (15), `upload_seconds` (60),
     `near_upload_seconds` (30), `stale_minutes` (5).
   - `retention_hours` (padrão 24): quando a posição e a conversa são
     apagadas.
   - `map`: `tiles_url` (blocos do mapa: endereço HTTPS com `{z}`, `{x}` e
     `{y}`) e `attribution` (o crédito que o provedor exige). Vazio usa o
     OpenStreetMap público; veja "Mapa da página" abaixo.
   - `texts`: `started`, `eta`, `location`, `arriving`, `delivered`,
     `cancelled`, com `{rotulo}`, `{entregador}`, `{minutos}`, `{horario}`,
     `{distancia}` e `{hora_posicao}`.
4. Opcional: item de menu **Onde está minha entrega** (`entrega_onde`).

## Fluxo

```
pedido com entrega ──► entrega ──► QR lido ──► saiu (rota) ──► entregue
   (Pedido)           (pending)   (assigned)   (en_route)      (delivered)
                         │                        │ posições com o app aberto
                         ▼                        ▼ conversa loja/cliente
                   QR no painel             cliente: link, previsão,
                   e na via impressa        "chegando", "entregue"
```

1. **Despachar.** A equipe cria a entrega do pedido (`source: pedido`,
   `ref_id`) e gera o QR (`POST …/qr`). O painel mostra o QR e a via
   impressa leva o QR (veja "Via impressa"). Um pedido tem no máximo uma
   entrega aberta. Com entregador fixo, a equipe atribui a pessoa
   (`courier_id`) ou ele assume em `GET /entrega/available`.
2. **Ler o QR.** No app, na primeira tela, fora do login: **Escanear
   pedido**. Na primeira leitura o app pede o nome (guardado só no aparelho
   e enviado a cada leitura). O servidor troca o QR por um acesso só àquela
   entrega; quem leu vira o entregador dela. A loja vê no detalhe da entrega
   (`access`) quem leu, de que aparelho e quando.
3. **Sair.** O entregador toca em **Iniciar rota** (`POST …/start`). O app
   geocodifica o endereço do pedido no próprio aparelho e manda o destino
   junto. No Pedido, o pedido vai para "Saiu para entrega" e o cliente recebe
   **uma mensagem só**: o aviso configurado no Pedido com o botão
   **Acompanhar** (gancho `onStatusNotice` do Pedido). Fora da janela de 24 h,
   o Pedido manda o aviso dele pelo modelo, sem o link. Se a cozinha já tinha
   marcado "Saiu para entrega" antes, o aviso do Pedido já saiu e a Entrega
   manda só o link ao sair. Sem destino, o cliente recebe o botão "Enviar
   localização" do WhatsApp (opcional para ele).
4. **Na rua.** Com o app aberto, ele lê o GPS e manda os pontos em lote. O
   servidor guarda só a última posição e um rastro curto, calcula a previsão
   e decide as mensagens. Com o app fechado, a posição para e o cliente vê
   "Última posição há X min".
5. **Chegar.** Dentro do raio, o cliente recebe "Ana está chegando com Pedido
   nº 12" uma vez, e as atualizações periódicas param.
6. **Entregar.** O entregador toca em **Entregue** (`POST …/delivered`); no
   Pedido, o pedido vai para "Entregue" (e o Pedido avisa). O acesso do QR é
   revogado: a próxima chamada do app recebe `401` e ele volta à primeira
   tela.

Cancelar (`POST …/cancel`, com motivo; a equipe ou o entregador em "Não
consegui entregar") encerra a rota e revoga o acesso; o pedido do Pedido não
muda (a equipe decide no quadro). Rota esquecida aberta por 8 horas é
encerrada sozinha, sem avisar o cliente.

**Pela cozinha.** Quando o pedido é marcado "Entregue" ou "Cancelado" no
quadro (ou pelo pagamento, ou pela rodada do Pedido), a entrega aberta dele
acompanha (gancho `onOrderStatusChanged`): fica entregue ou cancelada, o
acesso do QR é revogado e, cancelada, o link de acompanhamento fecha. O
cliente recebe só o aviso do Pedido. O quadro e o detalhe do pedido mostram o
entregador, a situação e a previsão (`delivery`, gancho
`provideDeliveryInfo`), sem posição nem endereço.

### Via impressa

`POST …/qr` devolve `slip`: `title` ("ENTREGA · Pedido nº 12"), `qr` (o
conteúdo do QR) e `lines` (nome do estabelecimento, "abra o app Wabotia e
toque em Escanear pedido", validade do QR). A comanda do Pedido já traz
endereço, itens, pagamento e troco; a via acrescenta o QR e essas linhas. O
QR de uma via reimpressa só vale se for o último gerado.

### QR fotografado por terceiro

- **A primeira leitura vence** e a loja vê quem leu (nome, aparelho, hora)
  no detalhe da entrega e no evento `entrega.qr_claimed`. Se não reconhecer,
  gera outro QR: o anterior e o acesso de quem leu são revogados na hora.
- **A loja sabe na hora:** a leitura vira nota na conversa do pedido ("QR da
  entrega lido por Carlos Souza, Moto G, às 19:20. Não é o entregador? Gere
  outro QR…") e o evento `entrega.qr_claimed` (tempo real e webhooks).
- O QR vale `qr.claim_minutes` (padrão 20 min, no máximo 120) e uma leitura
  só; o acesso, `qr.credential_hours` (padrão 3 h, no máximo 6). A câmera
  comum do celular abre uma página que só orienta (não gasta o QR).
- Até 10 leituras por IP a cada 10 minutos (o IP fica guardado só em HMAC).
- O acesso só alcança aquela entrega, nas rotas do app do entregador
  (negado por padrão no núcleo): o destino, o resumo do pedido, a posição, a
  conversa, sair, concluir e "não consegui entregar". Nunca o telefone do
  cliente, outras entregas, listas, conversas, cadastros ou o MCP.
- No Pedido, a Entrega age como `module:entrega` (ator de módulo), que só
  marca "Saiu para entrega" e "Entregue": nunca cancela nem mexe em
  pagamento.
- Com o **código de confirmação** ligado, o QR fotografado não fecha o
  pedido como entregue: falta o código que só o cliente tem.
- Confirmação pela loja antes de liberar o acesso fica como opção futura
  (decisão em aberto).

### Código de confirmação (desligado por padrão)

Com `confirm_code.enabled`:

- Na saída nasce um código de 4 dígitos. Ele vai ao cliente **junto do aviso
  "saiu para entrega"** (na mesma mensagem do botão Acompanhar) ou, quando o
  Pedido mandou o aviso dele (fora da janela de 24 h, cozinha marcou a saída
  antes), numa mensagem logo depois, pelas regras dos avisos.
- "Entregue" do entregador exige `code`. Errado: `409 code_invalid` (com as
  tentativas que restam); sem código: `409 code_required`; depois de
  `confirm_code.attempts` erros: `423 code_locked`, e só a loja conclui.
- A loja (equipe no painel) conclui sem o código; o histórico registra
  "Concluída pela loja sem o código de entrega".
- O código nunca vai ao entregador nem aos eventos; some com a posição em
  `retention_hours`.

## Contrato do app do entregador

Todas as chamadas, exceto a troca do QR, vão a
`<servidor>/api/v1/profiles/<profile>/entrega/…` com
`Authorization: Bearer <token>`. O servidor e a área vêm do QR e da troca:
o entregador **não digita o endereço do servidor** (várias lojas, vários
servidores: cada QR leva o seu).

**0. O QR.** Contém o endereço completo:
`https://<endereço público da instalação>/api/public/c/<código>`, com o
código de 32 caracteres do alfabeto `[2-9A-HJ-NP-Za-km-np-z]`. O servidor é
tudo antes de `/api/public/c/` (sempre `https://`). O caminho fica debaixo de
`/api/` porque só ele chega ao Worker antes dos arquivos do painel
(`run_worker_first` do `wrangler.jsonc`). Num caso típico
(`https://wabotia.queven.app/api/public/c/` + 32) são 72 bytes: QR versão 5
(37×37 módulos) com correção M, legível na térmica de 58 mm. Sem endereço
público https definido, a loja não consegue gerar o QR
(`409 origin_unknown`, com o motivo no painel).

QR antigo (`https://<servidor>/c/<código>`, das primeiras vias impressas): a
troca ainda aceita, mas a leitura pública por esse caminho não chega ao
Worker. Aceite os dois caminhos ao validar o QR e, para o antigo, faça a
leitura pública em `https://<servidor>/api/public/c/<código>`.

**Leitura pública antes da troca.** Para mostrar "Entrega da loja X, servidor
Y — continuar?" sem gastar o código:

```
GET https://<servidor>/api/public/c/<código>
Accept: application/json
→ 200 {"valid": true, "store": "Lanchonete da Ana", "server": "https://<servidor>", "expires_at": ms}
→ 200 {"valid": false, "server": "https://<servidor>"}
```

`valid: false` é a mesma resposta para código inexistente, vencido, já lido
ou revogado (sem oráculo); nunca traz cliente, itens nem endereço. Limite de
30 leituras por IP a cada 10 minutos (`429`). Sem `Accept: application/json`
(câmera comum do celular), a mesma URL abre uma página com o nome da loja e
"Abra o Wabotia e toque em Escanear pedido", com o link da Google Play (e o
da App Store, se a instalação definir `IOS_APP_URL`). Nenhuma das duas troca
o código.

**1. Trocar o QR.**

```
POST https://<servidor>/api/credentials/claim
{"code": "<o conteúdo do QR ou só o código>", "name": "Carlos Souza", "device": "Moto G (Android 14)"}
→ 200 {"token": "wabx_…", "expires_at": ms, "profile": "<área>", "module": "entrega",
       "subject": "<id da entrega>", "credential_id": "…",
       "data": {"delivery": {…}, "app": {…}}}
```

Erros: `404 claim_not_found` (QR inválido), `410 claim_used` (já lido ou
substituído), `410 claim_expired`, `410 delivery_closed`, `429` (muitas
leituras deste IP), `400` sem nome. Guarde o token no armazenamento seguro do
aparelho (Keystore, Keychain), um por entrega.

**2. A entrega.** `GET …/entrega/deliveries/{id}/courier` → destino
(`destination`), `address_text`, primeiro nome do cliente, `label`,
situação, `eta`, `order` (itens, total, pagamento, troco, observação do
cliente), `chat {last_seq, customer_open}` e `app`. Sem telefone, conversa
ou notas internas.

**3. Iniciar e concluir.** `POST …/start` `{"destination": {"lat", "lng"}}`,
`POST …/destination` `{"lat", "lng"}` (corrigir o pino), `POST …/delivered`
`{"note", "code"}`, `POST …/cancel` `{"reason"}`. Todas com `Idempotency-Key`.
Com `confirm.required` (em `/courier`), peça ao cliente o código de 4 dígitos
e mande em `code`; `409 code_invalid` traz as tentativas que restam no texto
(e em `confirm.attempts_left` ao reler `/courier`); `423 code_locked`: só a
loja conclui, mostre "Fale com a loja".

**4. Posições, só com o app aberto.** `POST …/deliveries/{id}/positions`
(sem `Idempotency-Key`) com até 200 pontos `{t, lat, lng, accuracy, speed}`
(t em ms Unix do aparelho) e `battery`.

- Ritmo: o servidor manda em `app` (na troca, em `/courier`, no `start` e
  em cada lote): ler o GPS a cada `sample_seconds` (15 s) e enviar a cada
  `upload_seconds` (60 s), ou `near_upload_seconds` (30 s) perto do destino.
  Siga sempre o último valor recebido.
- Só enquanto o app está visível. Ao ir para segundo plano, envie o que
  estiver na fila e pare o GPS; ao voltar, retome. O cliente vê "Última
  posição há X min" e a equipe recebe a nota "sem posição (app fechado ou sem
  sinal)" depois de `stale_minutes`.
- O servidor ignora o que já tem (t menor ou igual à última posição) e pontos
  ruins (precisão pior que 300 m, anteriores à saída, mais de 2 min no
  futuro, 0,0): repetir o lote é seguro; apague da fila os pontos até
  `last_at` da resposta.
- Sem rede: fila local (até 2 h), enviada em ordem, os mais antigos primeiro.
- Resposta: `{active, status, accepted, ignored, last_at, eta, arriving, app,
  chat: {last_seq}}`. `active: false`: a entrega terminou; pare o GPS.
- Bateria: "equilíbrio entre precisão e bateria" longe e alta precisão perto;
  distância mínima entre leituras de 20 a 30 m.
- Limite: 60 lotes por minuto por token (`429`).

**5. Conversa.**

- Enviar: `POST …/deliveries/{id}/messages` `{"channel": "store"|"customer",
  "text": "…"}` (até 1000 caracteres, `Idempotency-Key`).
  - `store`: com a loja. Interna; a equipe vê no detalhe e como nota na
    conversa do cliente no painel.
  - `customer`: com o cliente. Sai pelo WhatsApp da loja, na conversa dele,
    como "Carlos - Entregador: …". Só com a janela de 24 h aberta (o cliente
    escreveu para a loja nas últimas 24 h); senão `409 window_closed` e o app
    sugere falar com a loja. `chat.customer_open` diz antes se dá.
- Receber: `GET …/deliveries/{id}/messages?after=<seq>` → `{data: [{seq,
  channel, sender: courier|store|customer, author_name, text, created}],
  last_seq, customer_open, open}`. Sondagem: a cada 15 s com a tela da
  conversa aberta; fora dela, compare `chat.last_seq` da resposta das
  posições com o último lido e busque quando mudar. Sem WebSocket nesta
  versão.
- A resposta do cliente no WhatsApp chega ao app enquanto a entrega estiver
  aberta. Se ele responde até 30 min depois de uma mensagem do entregador, a
  resposta é só da conversa da entrega; fora disso, segue também para o
  atendimento de sempre (menu, bot ou equipe). O entregador nunca vê o
  número do cliente.
- Ao concluir ou cancelar, a conversa fecha (o acesso é revogado). Ela é
  apagada com a posição, em `retention_hours`.

**6. Revogação.** Qualquer `401` (`invalid_token`: entrega concluída ou
cancelada, QR substituído, prazo vencido) encerra aquela entrega no app:
apague o token e a fila e volte à primeira tela (ou à lista, se houver outras
entregas). `403 credential_scope` é chamada fora da entrega do QR ou fora
das rotas do app do entregador (erro do app): com o token só valem
`GET …/courier`, `GET`/`POST …/messages`, `POST …/start`, `…/destination`,
`…/delivered`, `…/cancel` e `…/positions` da entrega dele.

**Várias entregas.** Um entregador pode ler vários QRs: um token por entrega.
O app junta as entregas na lista, manda as posições de cada uma com o token
dela (pode mandar o mesmo ponto para as que estão a caminho) e mostra uma
conversa por entrega.

**Entregador fixo (com login).** Mesmo contrato, com a sessão da pessoa
(`wabu_…`) no lugar do token do QR; a lista vem de `GET /entrega/mine` e os
pedidos disponíveis de `GET /entrega/available` (assumir com
`POST …/assign {"courier_id": "me"}`). Sem o papel: `403 role_required`.

## Previsão de chegada

Sem custo e sem rede: distância em linha reta (haversine) × `road_factor`,
na velocidade média. A velocidade medida pelo rastro dos últimos minutos
entra quando há dados, limitada entre metade e o dobro da configurada (parado
no semáforo não vira "nunca"; avenida livre não vira "já chegou").

A previsão por ruas fica atrás de uma interface (`RouteProvider` em
`src/modules/entrega/geo.ts`, campo `route_provider`). Hoje só existe
`straight_line`. **Nenhum provedor pago foi integrado.** Opções, para decidir:

| Provedor | Custo | Observação |
|---|---|---|
| OSRM próprio (OpenStreetMap) | Servidor próprio | Sem chave; precisa hospedar fora do Cloudflare |
| OpenRouteService | Cota gratuita com chave | Endereço do cliente vai a terceiro |
| Google Routes, Mapbox | Pago por consulta | Idem; exige contrato e chave |

Qualquer um deles envia a posição do entregador e o destino do cliente a
terceiros: entra no aviso de privacidade e na base legal (veja abaixo).

**Destino.** O pedido do Pedido traz o endereço em texto, sem coordenadas. O
destino vem, nesta ordem: do aparelho (Geocoder do Android ou CLGeocoder do
iOS, gratuitos e no próprio celular), corrigido pelo entregador
(`POST …/destination`) ou da localização que o cliente enviar no WhatsApp.
Sem destino não há previsão: o modo `eta` manda a localização no lugar.

## Mensagens ao cliente sem inundar

- **Link Acompanhar** ao sair (botão com URL na linha oficial, link no texto
  na linha QR). Página leve, sem script e sem chave paga: mapa com blocos do
  OpenStreetMap, marcadores do entregador e do destino, previsão e hora da
  posição; recarrega a cada 30 s. O link é de uso desta entrega, vence em
  `link_hours`, fecha quando a posição é apagada e é trocado se o cliente
  pedir de novo (o anterior é cancelado). O código do link fica só como hash
  e a página não envia Referer (os blocos do mapa recebem só a origem).
- **Mapa da página.** Por padrão, os blocos vêm do servidor público do
  OpenStreetMap (`tile.openstreetmap.org`), cuja política de uso aceita só uso
  leve e pode bloquear quem passar disso. Várias instalações do Wabotia, com
  páginas que recarregam a cada 30 s, podem passar. Para produção com volume,
  configure `map.tiles_url` com um servidor próprio ou um provedor contratado
  (a escolha e o custo são decisão do responsável pela instalação) e o crédito
  em `map.attribution`.
- **Atualização periódica** (previsão, localização ou as duas) a cada
  `every_minutes`, no máximo `max` por entrega, **só com a janela de 24 h
  aberta**, só com posição recente e nunca depois de "chegando". A rodada que
  não pode mandar pula a vez em vez de acumular.
- **Avisos** de saída, chegada e entrega: uma vez cada (chave por entrega).
  No Pedido, saída e entrega são as do próprio Pedido (a saída já com o
  botão Acompanhar); a Entrega não repete.
- **Janela de 24 h fechada** (cliente não escreveu há mais de 24 h, comum em
  encomenda para outro dia): com `outside_window: milestones`, só os avisos,
  pelo modelo de notificação da área, e só com o consentimento da finalidade
  `order` (o carrinho do Pedido já registra). O link e a localização não saem
  fora da janela (a Meta não permite mensagem livre). `none`: nada.
- **Onde está minha entrega** no menu: a situação de cada entrega aberta e um
  link novo.

## Privacidade (LGPD)

Dados tratados: a posição do entregador (dado pessoal do trabalhador ou do
prestador), o nome que ele digita, o endereço e, se ele enviar, a localização
do cliente, e a conversa da entrega.

- **Finalidade e base legal.** Posição e nome do entregador: execução do
  contrato ou da prestação de serviço e legítimo interesse da loja em
  informar o cliente (art. 7º, V e IX). O app mostra o aviso antes de pedir a
  permissão (abaixo). Endereço, localização e conversa do cliente: execução
  do pedido (art. 7º, V). Cabe ao estabelecimento, controlador, registrar
  isso no seu aviso de privacidade e informar o entregador por escrito.
- **Só durante a entrega ativa e com o app aberto.** O servidor só aceita
  posição com a rota em `en_route`, do entregador da entrega, depois da
  saída; o app só lê o GPS visível. Fora disso responde `active: false`.
  Rota esquecida fecha em 8 horas.
- **Acesso mínimo e curto.** O QR vale uma leitura; o acesso alcança só a
  entrega dele e é revogado ao concluir ou cancelar (no máximo
  `qr.credential_hours`, padrão 3 h). Só os hashes do QR e do token ficam
  guardados, e o IP de quem leu em HMAC com a chave do servidor. O nome fica
  no aparelho e na entrega (para o cliente e a equipe).
- **Mínimo necessário.** Guarda só a última posição e até 12 pontos dos
  últimos 15 minutos (para a velocidade), nunca o trajeto inteiro. O
  entregador vê o primeiro nome do cliente, o endereço e o pedido; nunca o
  telefone.
- **Retenção curta.** `retention_hours` (padrão 24 h) depois de entregue ou
  cancelada, a rodada apaga posição, rastro, bateria, as coordenadas do
  destino e a conversa da entrega, e fecha o link. Fica o registro (quem
  entregou e quando), como o histórico do pedido; as mensagens que foram ao
  cliente pelo WhatsApp ficam na conversa dele, como qualquer mensagem da loja.
- **O cliente vê só a própria entrega.** A página mostra apenas a entrega
  ligada ao link e à conversa dele, com o primeiro nome do entregador; a
  posição some do mapa quando a entrega termina. Eventos e webhooks não levam
  posição, endereço nem o texto da conversa.
- **Equipe e integrações.** Pessoas da equipe veem a posição e a conversa
  (acompanhar a entrega é o trabalho delas). Aplicações só com
  `contacts:read`.
- **Provedores externos.** Os blocos do mapa vêm do OpenStreetMap (recebem o
  IP do cliente e a região do mapa, não o link nem o nome). Um provedor de
  rotas ou de geocodificação no servidor enviaria endereço e posição a
  terceiro: decisão do responsável, com contrato e aviso de privacidade.

## Limites do Cloudflare

Posição frequente não passa pela fila de comandos: o lote usa a rota de
telemetria (`onTelemetry`, `docs/MODULOS.md`), fora do Coordinator e sem o
recibo de idempotência (que custaria 4 instruções e 2 escritas a mais por
lote). Medido em `tests/entrega.test.ts` como em [LIMITES.md](LIMITES.md):

| Fluxo | Instruções no D1 | Escritas |
|---|---|---|
| Lote de posições (módulo: estado, entrega, área, gravação) | 4 | 1 |
| Mesma chamada pela HTTP (mais a sessão do app, o estado do módulo e o limite por credencial; estimado pela leitura do código) | ~7 | 2 (o lote e o contador do limite; mais 1 por hora: `last_used` da sessão) |
| Rodada periódica com uma entrega a caminho, nada vencido | 4 | 0 |

O núcleo limita a telemetria a 60 chamadas por minuto por credencial, área e
rota (`429 rate_limited`) e recusa conectores; o app manda 1 a 2 por minuto.

Com o padrão (lote a cada 60 s), cada entregador em rota faz cerca de 120
escritas por hora (o lote e o contador do limite), não duas por ponto (seriam
480). Dez entregadores rodando 8 horas: ~9.600 escritas por dia, abaixo das
100 mil diárias do plano gratuito. O Coordinator só é acordado quando há aviso a mandar
(chegada, atualização vencida, sinal que voltou).

Avaliado e não usado: guardar a posição no armazenamento do Durable Object
`Coordinator`. Pouparia a escrita no D1, mas cada lote viraria uma chamada ao
Coordinator (fila serializada da área, junto com as mensagens) e a página do
cliente, a rodada e a API teriam de ler a posição de lá; a escrita
condicionada por lote no D1 fica mais simples e cabe com folga.

## Outras origens (Ordem de Serviço, visita técnica)

`source` diz de onde vem a entrega; hoje `pedido` e `manual` (avulsa, com
`conversation_id`, rótulo e endereço). Uma visita da Ordem de Serviço entra
como outra origem: o que muda é só ler o registro de origem pela API pública
do módulo (`ctx.read`) e, ao concluir, mudar o estado dele (`ctx.run`), como
faz o Pedido. Até lá, use `manual` com a conversa do cliente.


## O que as telas nativas precisam

Os apps (Android em `mobile/android/`, iOS em `mobile/ios/`).

**Primeira tela, fora do login** (como o pareamento dos painéis):
**Escanear pedido** (câmera; também aceita colar o endereço do QR). Na
primeira leitura, pede o nome ("Como o cliente vai te chamar?"), guardado só
no aparelho. Depois da troca, a lista "Minhas entregas" junta as entregas de
todos os tokens; o botão **Escanear outro pedido** fica no topo. Entregador
fixo entra com login e vê a mesma lista (`/entrega/mine`) e "Disponíveis".

**Detalhe da entrega:** rótulo, primeiro nome do cliente, endereço, itens,
total, pagamento e troco, observação; botão abrir no mapa do sistema;
**Iniciar rota**, **Entregue** e **Não consegui entregar** (cancelar com
motivo); **Conversar com a loja** e **Conversar com o cliente** (este
desabilitado com `customer_open: false`, com "O cliente precisa ter escrito
para a loja nas últimas 24 horas"). Durante a rota, a faixa fixa
"Compartilhando localização com o cliente enquanto o app está aberto —
Pedido nº 12" e a previsão da resposta do lote.

**Aviso ao entregador (antes de pedir a permissão, em tela própria):**
"Enquanto este app estiver aberto durante a entrega, o Wabotia compartilha a
sua localização com a loja e com o cliente deste pedido, para mostrar a
previsão de chegada. O compartilhamento começa quando você toca em Iniciar
rota e para quando você fecha o app ou a entrega termina. A posição é
apagada em até 24 horas." Botões "Continuar" e "Agora não".

**Android**

- Permissões: `ACCESS_FINE_LOCATION` e `ACCESS_COARSE_LOCATION` (pedidas em
  uso, "Durante o uso do app"), `CAMERA` para o QR. **Sem**
  `ACCESS_BACKGROUND_LOCATION`, sem serviço em primeiro plano de localização
  (`FOREGROUND_SERVICE_LOCATION`) e sem notificação fixa.
- `FusedLocationProviderClient` ligado em `onStart`/`onResume` da tela da
  entrega e desligado em `onStop` (o app em segundo plano não lê), com
  `Priority.PRIORITY_BALANCED_POWER_ACCURACY` longe e `PRIORITY_HIGH_ACCURACY`
  perto, intervalo `sample_seconds`, `setMinUpdateDistanceMeters(25)`;
  envio no ciclo de vida da tela (e um envio final em `onStop`); fila em Room.
- Geocodificação do endereço: `android.location.Geocoder` (pode faltar em
  aparelhos sem serviços do Google: aí o entregador marca no mapa ou o
  cliente envia a localização).
- Token em `EncryptedSharedPreferences`/Keystore.

**iOS**

- `Info.plist`: `NSLocationWhenInUseUsageDescription` (com o texto do aviso)
  e `NSCameraUsageDescription` ("Para ler o QR da entrega"). **Sem**
  `UIBackgroundModes` `location`, sem `allowsBackgroundLocationUpdates` e sem
  "Sempre".
- `CLLocationManager` com `requestWhenInUseAuthorization`, ligado quando a
  tela da entrega aparece e desligado em `sceneDidEnterBackground` (com um
  envio final), `desiredAccuracy` `kCLLocationAccuracyHundredMeters` longe e
  `kCLLocationAccuracyBest` perto, `distanceFilter` 25 m.
- Geocodificação: `CLGeocoder` (limitada por frequência; geocodifique uma vez
  por entrega). Token no Keychain.

## Regras das lojas (localização só em uso)

- **Google Play.** Localização só com o app em uso: não entra no formulário
  de localização em segundo plano nem na declaração de serviço em primeiro
  plano do tipo `location`. Exige a divulgação em destaque antes da
  permissão (o aviso acima) e a Segurança dos dados: "Localização precisa",
  coletada, compartilhada com o estabelecimento, finalidade "Funcionalidade
  do app", opcional (só quem entrega). A câmera entra na declaração de
  permissões comum.
- **App Store.** Sem modo de segundo plano, a diretriz 2.5.4 não se aplica.
  Diretriz 5.1.1: o texto de `NSLocationWhenInUseUsageDescription` diz com
  quem a posição é compartilhada; rótulo de privacidade com "Localização
  precisa" e "Nome". A revisão precisa testar sem uma loja real: deixe um QR
  de demonstração (entrega de mentira da demo) na nota da revisão. Risco: o
  iOS 0.17.0 já foi recusado em 14/11 pela 2.1 (demonstração).
- **Ambas.** O cliente final nunca instala nada (página e WhatsApp); só o app
  do entregador pede localização, e só durante a entrega, com o app aberto.
- **Limite do desenho.** Com o app fechado ou a tela apagada, a posição para;
  a página do cliente mostra "Última posição há X min". É a troca por uma
  revisão mais simples nas lojas.
