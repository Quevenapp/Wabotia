# Entrega: acompanhamento em tempo real

O entregador inicia a rota no app do Wabotia e o celular manda a posição para
o servidor de tempos em tempos. O cliente recebe no WhatsApp o link
**Acompanhar** (página com o mapa, sem instalar nada), a previsão de chegada
ou a localização a cada X minutos, e os avisos de saída, "chegando" e
entregue. Serve para os pedidos do módulo **Pedido** com entrega e para
entregas avulsas; o desenho já prevê visitas técnicas da Ordem de Serviço
(veja "Outras origens").

Contrato das rotas em [API.md](API.md#entrega-módulo-entrega).

## Ligar

1. **Gestão → Módulos → Entrega**: ligue (vem desligado).
2. Configure a chave `entrega` (`PUT /profiles/{p}/settings`):
   - `couriers`: as pessoas da equipe que fazem entregas (ids). Só elas podem
     ser atribuídas, sair, mandar posição e concluir pelo app.
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
   - `retention_hours` (padrão 24): quando a posição é apagada.
   - `map`: `tiles_url` (blocos do mapa: endereço HTTPS com `{z}`, `{x}` e
     `{y}`) e `attribution` (o crédito que o provedor exige). Vazio usa o
     OpenStreetMap público; veja "Mapa da página" abaixo.
   - `texts`: `started`, `eta`, `location`, `arriving`, `delivered`,
     `cancelled`, com `{rotulo}`, `{entregador}`, `{minutos}`, `{horario}`,
     `{distancia}` e `{hora_posicao}`.
3. Opcional: item de menu **Onde está minha entrega** (`entrega_onde`).

## Fluxo

```
pedido com entrega ──► entrega criada ──► atribuída ──► saiu (rota) ──► entregue
   (Pedido)           (pending)          (assigned)    (en_route)      (delivered)
                                                         │  posições em lote
                                                         ▼
                                         cliente: link, previsão/localização,
                                         "chegando", "entregue"
```

1. **Criar e atribuir.** A equipe cria a entrega do pedido (`source: pedido`,
   `ref_id`) e escolhe o entregador, ou o entregador vê os pedidos com entrega
   em `GET /entrega/available` e assume (`courier_id: "me"`). Um pedido tem no
   máximo uma entrega aberta.
2. **Sair.** O entregador toca em **Iniciar rota** no app
   (`POST …/start`). O app geocodifica o endereço do pedido no próprio aparelho
   e manda o destino junto. No Pedido, o pedido vai para "Saiu para entrega" e
   o próprio Pedido avisa o cliente, como sempre; a Entrega manda o botão
   **Acompanhar**. Sem destino, o cliente recebe o botão "Enviar localização"
   do WhatsApp (opcional para ele).
3. **Na rua.** O app lê o GPS e manda os pontos em lote (abaixo). O servidor
   guarda só a última posição e um rastro curto, calcula a previsão e decide
   as mensagens.
4. **Chegar.** Dentro do raio, o cliente recebe "Ana está chegando com Pedido
   nº 12" uma vez, e as atualizações periódicas param.
5. **Entregar.** O entregador toca em **Entregue** (`POST …/delivered`); no
   Pedido, o pedido vai para "Entregue" (e o Pedido avisa). Daí em diante a
   posição não é mais aceita e o app desliga o GPS.

Cancelar (`POST …/cancel`, com motivo) encerra a rota; o pedido do Pedido não
muda (a equipe decide no quadro). Rota esquecida aberta por 8 horas é
encerrada sozinha, sem avisar o cliente.

## API do app do entregador

- **Frequência.** O servidor manda o ritmo em `app` (em `GET /entrega`,
  `GET /entrega/mine`, na resposta de `start` e de cada lote): ler o GPS a
  cada `sample_seconds` (15 s) e enviar o lote a cada `upload_seconds`
  (60 s), ou `near_upload_seconds` (30 s) quando a resposta indicar que está
  perto do destino. Siga sempre o último valor recebido.
- **Lote.** `POST /entrega/deliveries/{id}/positions` com até 200 pontos
  `{t, lat, lng, accuracy, speed}` (t em ms Unix do aparelho) e `battery`.
  Sem `Idempotency-Key`: o servidor ignora o que já tem (pontos com `t` menor
  ou igual à última posição) e os pontos ruins (precisão pior que 300 m,
  anteriores à saída, mais de 2 minutos no futuro, 0,0). Repetir o lote é
  seguro; apague da fila local os pontos até `last_at` da resposta.
- **Sem sinal.** Guarde os pontos numa fila local (até 2 horas, descartando
  os mais velhos) e mande em ordem, os mais antigos primeiro, em lotes de até
  200, quando a rede voltar. O servidor usa só os novos: a posição mostrada ao
  cliente é a mais recente. Depois de `stale_minutes` sem posição, a equipe
  recebe uma nota na conversa e o evento `entrega.signal_lost`; a página do
  cliente diz "Sem sinal do entregador desde 19:20" e as atualizações
  periódicas pulam a vez (nunca vai posição velha ao cliente).
- **Bateria.** Use o provedor combinado do sistema com prioridade "equilíbrio
  entre precisão e bateria" longe do destino e alta precisão só dentro de
  2 × o raio (o servidor encurta o envio nesse trecho). Distância mínima
  entre leituras de 20 a 30 m evita pontos parados no semáforo. Envie o nível
  da bateria; abaixo de 15 %, dobre os intervalos por conta própria (o
  servidor aceita qualquer ritmo).
- **Fim.** `active: false` na resposta (entregue, cancelada, rota com mais
  de 8 h): pare o serviço de localização, apague a fila e volte à lista.
  Ao abrir o app, `GET /entrega/mine` diz se há rota em andamento para
  retomar.
- Erros: `403 not_your_delivery` (outra pessoa), `409 module_disabled`
  (esconda a tela), `401` (entre de novo; guarde a fila).

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
  No Pedido, saída e entrega são as do próprio Pedido; a Entrega não repete.
- **Janela de 24 h fechada** (cliente não escreveu há mais de 24 h, comum em
  encomenda para outro dia): com `outside_window: milestones`, só os avisos,
  pelo modelo de notificação da área, e só com o consentimento da finalidade
  `order` (o carrinho do Pedido já registra). O link e a localização não saem
  fora da janela (a Meta não permite mensagem livre). `none`: nada.
- **Onde está minha entrega** no menu: a situação de cada entrega aberta e um
  link novo.

## Privacidade (LGPD)

Dados tratados: a posição do entregador (dado pessoal do trabalhador), o
endereço e, se ele enviar, a localização do cliente.

- **Finalidade e base legal.** Posição do entregador: execução do contrato de
  trabalho ou prestação de serviço e legítimo interesse da empresa em
  informar o cliente (art. 7º, V e IX). O app mostra o aviso antes de pedir a
  permissão (abaixo). Endereço e localização do cliente: execução do pedido
  (art. 7º, V). Cabe ao estabelecimento, controlador, registrar isso no seu
  aviso de privacidade e informar o entregador por escrito.
- **Só durante a entrega ativa.** O servidor só aceita posição com a rota em
  `en_route`, do entregador da entrega, depois da saída. Fora disso responde
  `active: false` e o app desliga o GPS. Rota esquecida fecha em 8 horas.
- **Mínimo necessário.** Guarda só a última posição e até 12 pontos dos
  últimos 15 minutos (para a velocidade), nunca o trajeto inteiro.
- **Retenção curta.** `retention_hours` (padrão 24 h) depois de entregue ou
  cancelada, a rodada apaga posição, rastro, bateria e as coordenadas do
  destino, e fecha o link. Fica o registro (quem entregou e quando), como o
  histórico do pedido.
- **O cliente vê só a própria entrega.** A página mostra apenas a entrega
  ligada ao link e à conversa dele, com o primeiro nome do entregador; a
  posição some do mapa quando a entrega termina. Eventos e webhooks não levam
  posição nem endereço.
- **Equipe e integrações.** Pessoas da equipe veem a posição (acompanhar a
  entrega é o trabalho delas). Aplicações só com `contacts:read`.
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

Os apps (Android em `mobile/android/`, iOS em `mobile/ios/`) mostram a tela
só com `{"id":"entrega"}` em `GET /api/v1/capabilities` e `courier: true` em
`GET /entrega`.

**Telas:** lista "Minhas entregas" (`/entrega/mine`) e "Disponíveis"
(`/entrega/available`, com assumir); detalhe com cliente, endereço, itens,
pagamento e troco, botão abrir no mapa do sistema, **Iniciar rota**,
**Entregue** e **Não consegui entregar** (cancelar com motivo); durante a rota,
uma faixa fixa "Compartilhando localização com o cliente — Pedido nº 12" e a
previsão vinda da resposta do lote.

**Aviso ao entregador (antes de pedir a permissão, em tela própria):**
"Durante a entrega, o Wabotia compartilha a sua localização com o
estabelecimento e com o cliente deste pedido, para mostrar a previsão de
chegada. O compartilhamento começa quando você toca em Iniciar rota e para
quando a entrega é concluída ou cancelada. A posição é apagada em até 24
horas." Botões "Continuar" e "Agora não".

**Android**

- Permissões: `ACCESS_FINE_LOCATION` e `ACCESS_COARSE_LOCATION`;
  `FOREGROUND_SERVICE` e `FOREGROUND_SERVICE_LOCATION` (Android 14+);
  `POST_NOTIFICATIONS` (Android 13+) para a notificação do serviço.
- Serviço em primeiro plano `foregroundServiceType="location"`, iniciado com
  o app visível ao tocar em Iniciar rota, com notificação fixa ("Entrega em
  andamento — Pedido nº 12", ação "Concluir"). Assim a localização continua
  com a tela apagada **sem** `ACCESS_BACKGROUND_LOCATION`: a permissão "durante
  o uso do app" basta enquanto o serviço iniciado em primeiro plano roda.
  Não peça `ACCESS_BACKGROUND_LOCATION`.
- `FusedLocationProviderClient` com `Priority.PRIORITY_BALANCED_POWER_ACCURACY`
  longe e `PRIORITY_HIGH_ACCURACY` perto, intervalo `sample_seconds`,
  `setMinUpdateDistanceMeters(25)`; envio com WorkManager ou no próprio
  serviço; fila em Room.
- Geocodificação do endereço: `android.location.Geocoder` (pode faltar em
  aparelhos sem serviços do Google: aí o entregador marca no mapa ou o
  cliente envia a localização).

**iOS**

- `Info.plist`: `NSLocationWhenInUseUsageDescription` (com o texto do aviso);
  `UIBackgroundModes` com `location`.
- Autorização **Quando em uso** (`requestWhenInUseAuthorization`) e, ao
  iniciar a rota com o app aberto, `allowsBackgroundLocationUpdates = true` e
  `showsBackgroundLocationIndicator = true` (indicador azul na barra), ou
  `CLBackgroundActivitySession` com `CLLocationUpdate.liveUpdates()` no
  iOS 17+. Não peça "Sempre".
- `desiredAccuracy` `kCLLocationAccuracyHundredMeters` longe e
  `kCLLocationAccuracyBest` perto; `distanceFilter` 25 m;
  `pausesLocationUpdatesAutomatically = false` só durante a rota.
- Geocodificação: `CLGeocoder` (limitada por frequência; geocodifique uma vez
  por entrega).

## Regras das lojas para localização em segundo plano (riscos)

- **Google Play.** O app declara no Play Console os tipos de serviço em
  primeiro plano (Android 14+): `location`, com descrição do uso e vídeo
  mostrando o fluxo (iniciar rota, notificação, concluir). Como o desenho usa
  serviço em primeiro plano iniciado pelo usuário e não pede
  `ACCESS_BACKGROUND_LOCATION`, não precisa do formulário de localização em
  segundo plano nem da revisão mais rígida dela. A Política de Dados do
  Usuário exige a divulgação em destaque dentro do app antes da permissão
  (o aviso acima) e a declaração em Segurança dos dados: "Localização
  precisa", coletada, compartilhada com o estabelecimento, finalidade
  "Funcionalidade do app", não opcional para entregadores. Risco: revisão
  pedir o vídeo de novo a cada versão que mude o fluxo.
- **App Store.** Diretriz 2.5.4: o modo em segundo plano `location` só é
  aceito para uso que o usuário entende (navegação, entrega); a nota da
  revisão deve explicar que só o entregador, só durante a entrega iniciada
  por ele, e trazer uma conta de teste com entregador e pedido de
  demonstração. Diretriz 5.1.1: o texto de `NSLocationWhenInUseUsageDescription`
  precisa dizer com quem a posição é compartilhada; rótulo de privacidade com
  "Localização precisa" ligada à identidade. Risco: o iOS 0.17.0 já foi
  recusado em 14/11 pela 2.1 (demonstração); sem um modo de demonstração da
  entrega, a revisão não consegue testar e pode recusar de novo.
- **Ambas.** O cliente final nunca instala nada (página e WhatsApp); só o app
  da equipe pede localização, e só para quem é entregador.
