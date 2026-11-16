# Wabotia iOS: modo aparelho, guichê e verticais

O que o app iOS ganhou desde a 0.18.0 (branch `feat/ios-aparelho`), como cada parte fala com o servidor, como testar e
como montar a demonstração. O panorama dos dois apps continua em [`../README.md`](../README.md); o contrato do
servidor está em `docs/API.md`, `docs/MODULOS.md` e nos guias de cada módulo.

## O que mudou

| Parte | Onde | Resumo |
|---|---|---|
| Modo aparelho | `Wabotia/Device/` | iPad ou iPhone vira **totem** (emite senha, cupom pelo ThermalPrinterKit), **painel de chamadas** (senha em destaque, voz pt-BR, gongo) ou **híbrido**. Pareamento RFC 8628 (`client=senhapp`, escopos `queue:read` e `queue:issue`), credencial `wab_` no Keychain; reabre direto no modo aparelho; WebSocket da fila com volta automática e leitura por consulta de reserva; revogação mostra "desconectado". Paisagem e tela cheia. |
| Aba Atendimento | `Features/Attendance/` | No lugar da antiga aba Protocolos: presença (online/offline), protocolos com ativos, atrasados e aguardando (a lista abre empilhada, já no filtro), guichê e módulos ligados na área, linhas, menus e linhas dos bots. A impressora do cupom fica em Ajustes → Impressão. Atalhos `WABOTIA_DEMO=attendance` e `tickets`. |
| Modo entregador | `Wabotia/Courier/` | Sem login: "Escanear pedido" na primeira tela e na de entrada lê o QR do pedido (câmera ou link colado), troca o código (com o nome que o entregador digita e o modelo do aparelho) por um token `wabx_` só daquela entrega em `POST /api/credentials/claim` (Keychain, `…wabotia.courier`) e abre a entrega: destino no mapa, rota no Mapas, previsão vinda do servidor, conversa com a loja e com o cliente, Iniciar rota, Entreguei, Não consegui entregar. Várias entregas ao mesmo tempo. Localização **Quando em uso**, sem segundo plano, depois do aviso de compartilhamento; pontos numa fila local (2 h, lotes de até 200, sem `Idempotency-Key`) no ritmo `app` do servidor. Revogada (401, `active: false`, entregue ou cancelada), a entrega sai do aparelho; sem nenhuma, volta à primeira tela. Contrato em `docs/ENTREGA.md` ("Contrato do app do entregador", `feat/modulo-entrega`): `…/courier`, `start`, `destination`, `positions` (resposta com `chat.last_seq`), `delivered`, `cancel` e a conversa por `…/messages?after=` (sondagem de 15 s com a conversa aberta; canal com o cliente só com a janela de 24 h, `customer_open`). Em segundo plano manda a fila e para o GPS. Rotas em `CourierRoutes`, recusas em `CourierHTTPError`. Demonstração em `Core/Demo/DemoCourier.swift`; atalho `WABOTIA_DEMO=courier` com `WABOTIA_DEMO_ACTION=two|detail|disclosure|route|chat|deliver`. |
| Ações pelo bot | `Features/Bots/BotActions.swift`, `BotActionCards.swift` | Na conversa interna com o bot (`docs/API.md`, "Ações pelo bot na conversa interna", `feat/bot-acoes`): `kind` `proposal` (cartão com o resumo, a operação do catálogo, os parâmetros, o prazo de 10 min e Confirmar/Cancelar), `result` (feito ou erro) e `approval` (pedido de cliente para a equipe: campos lidos por código, campos ocultos, "Resumo do bot (não verificado)" à parte, Aprovar com ajuste nos limites, Recusar com motivo, Assumir a conversa; o primeiro a decidir vence e o cartão mostra quem decidiu). Aviso `data.type: "approval"` abre o pedido (`ApprovalScreen`). `403 mfa_required` pede o código do autenticador e repete o toque (`SecondFactor.swift`, provisório até `feat/login-mfa`). Tipo desconhecido mostra o `text` de reserva. Demonstração: `WABOTIA_DEMO=bot-actions` e `approval`; código do autenticador 123456. |
| Segundo fator | `Features/Bots/SecondFactor.swift`, `Features/Auth/LoginView.swift` | `docs/API.md`, "Login e segundo fator" (`feat/login-mfa`): login em duas etapas (`401 mfa_required` mostra o campo e repete o pedido com `totp` ou `recovery_code`; `invalid_code`, `mfa_locked`, `outside_schedule` com texto próprio); `403 mfa_required` em qualquer rota abre "Confirme que é você" pela porta central (`MFAGate`), ou o cadastro quando a pessoa não tem fator, sem deslogar (política `all`, `next: "enroll"` logo depois do login); os cartões do bot pedem o código eles mesmos e repetem o toque (`MFAGate.handledLocally`). Ajustes → Segurança (só com o recurso `mfa` em `/capabilities`): ativar o autenticador (senha, QR ou chave, primeiro código, 10 códigos de recuperação mostrados uma vez) e gerar códigos novos. Demonstração: senha `mfa` no login, `WABOTIA_DEMO=login-mfa`, `WABOTIA_DEMO=mfa` (`WABOTIA_DEMO_ACTION=qr|codes`); código 123456. |
| Acesso por pessoa | `Core/AppAccess.swift` | Contrato em `docs/API.md`, "Acesso por pessoa": `access` de cada área de `/capabilities` (recurso `person_access`), já expandido, com áreas (`conversations`, `tickets`, `calls`, `team`…), módulos e papéis (`os:technician`, `mesas:waiter`). A barra inferior e Atendimento usam só o que vier; `["*"]` é tudo menos os papéis; `access: null` (ou servidor sem o recurso) segue `modules` como antes. `403 access_denied` em qualquer rota relê `/capabilities` (`AccessDenial`); o app relê também ao voltar ao primeiro plano. Módulos sem tela no app (caixa, garçom) aparecem em Atendimento como "No painel do Wabotia". Atalho `WABOTIA_DEMO_ACCESS=mesas,mesas:waiter`. |
| Guichê | `Features/Queue/` | Atendimento → Guichê da fila de senhas: escolher guichê, abrir/pausar/fechar, chamar a próxima, rechamar, iniciar, concluir, ausente, transferir. |
| Agenda | `Modules/Agenda/` | Dia por profissional e semana; confirmar, remarcar, ausência, cancelar; agendar pela conversa. |
| Ordem de serviço | `Modules/ServiceOrders/` | Lista por estado e busca, detalhe com histórico, orçamento, responsável (`GET /people`), entrega e comprovante impresso com o estabelecimento. |
| Reserva | `Modules/Reserva/` | Ocupação por unidade e dia, lista, detalhe com sinal e check-in, reserva por diária ou por hora. |
| Mensalidade | `Modules/Mensalidade/` | Resumo do mês, parcelas (reenviar cobrança, baixa, isenção), assinaturas e inadimplentes, com o pagador (CPF/CNPJ e telefones). |
| Pedido | `Modules/Pedido/` | Quadro da cozinha, lista, cardápio com esgotado, pausa da loja, detalhe sem agrupar montagens, pagamento na entrega, comanda pelo ThermalPrinterKit (32/42/48 colunas). |
| Passagem e Suporte pago | `Modules/Suporte/` | Faixa no topo da conversa com o resumo e os avisos do módulo que passou o cliente à equipe; vincular telefone, confirmar e liberar, cortesia. |
| Formulário e Cobrança | `Modules/Cobranca/` | "Enviar formulário" (passo web) e "Cobrar" (Pix ou link) na conversa, com o estado de cada link e cobrança atualizado por eventos. |

### Modo aparelho: travar na tela, PIN e recuperação

- **O PIN não impede sair do app.** O gesto de Início é do sistema; só o **Acesso Guiado** o bloqueia. Para um
  totem ou painel, ligue em Ajustes → Acessibilidade → Acesso Guiado (com código) e, na tela do papel, clique três
  vezes no botão lateral (ou no de Início) → Iniciar. Os ajustes do aparelho mostram o cartão **Travar na tela**:
  verde quando o Acesso Guiado está ligado, ou o passo a passo quando não está (`Device/GuidedAccess.swift`).
- **iPad gerenciado por MDM:** com o app em `autonomousSingleAppModePermittedAppIDs` num aparelho supervisionado, a
  tela do papel chama `UIAccessibility.requestGuidedAccessSession(enabled: true)` e trava sem diálogo (Modo de
  App Único); desfazer o pareamento ou sair do modo aparelho destrava. Nos outros aparelhos o pedido volta `false`
  sem mostrar nada.
- Ao escolher o primeiro papel, o app pede um **PIN dos ajustes** de 4 ou 6 números. Ele guarda a engrenagem
  (ajustes, impressora, desfazer pareamento); o resumo com sal, os erros e a trava ficam no Keychain do aparelho
  (`…wabotia.device`, só neste aparelho, fora do backup).
- Cinco erros travam por 30 s, e cada nova trava dobra a espera, até 15 min. Fechar e abrir o app não zera.
- Os ajustes destravados voltam sozinhos à tela do papel depois de 2 min sem toque ou quando o app vai para
  segundo plano.
- **Esqueci o PIN:** um administrador revoga o aparelho no Wabotia (Integrações). Com a credencial revogada, a
  engrenagem abre sem PIN para **Desfazer pareamento**, e o aparelho pareia de novo. Apagar e instalar o app também
  zera tudo, porque a primeira abertura de uma instalação nova apaga o Keychain que o iOS deixou.
- **Som do painel:** gongo e voz saem na sessão `.playback`, no volume de mídia, mesmo com o silencioso ligado. O
  iOS não deixa o app mudar esse volume sozinho, então os ajustes (papel com painel) mostram o controle do sistema
  (`MPVolumeView`, o mesmo dos botões laterais) e o **Volume do painel** do app (10% a 100%, por aparelho, aplicado
  ao gongo e à voz). Abaixo de 30% de volume efetivo aparece o aviso de som baixo nos ajustes e "som baixo" no topo
  do painel (`PanelVolume`, `SystemVolume`). "Testar som" toca o gongo e uma senha.

### Regras comuns às verticais

- **Só com o módulo ligado.** `ModuleFeature` lê `GET /api/v1/profiles/{p}/capabilities` (ou `/capabilities?profile_id=`)
  e guarda os módulos por área; cada entrada em Ajustes e no menu ⋯ da conversa confere o id (`queue`, `agenda`, `os`,
  `reserva`, `mensalidade`, `pedido`, `suporte`, `forms`, `payments`). Um `409 module_disabled` esconde a entrada na hora.
- **Rotas da área.** `ProfileAPI` monta `/api/v1/profiles/{p}/…` com o token da pessoa; erros chegam como
  `QueueError` com status, código e mensagem do servidor.
- **Uma `Idempotency-Key` por intenção** (`IntentKeys`): a mesma intenção repete com a mesma chave só depois de falha
  repetível (rede, 5xx); sucesso ou recusa definitiva liberam a chave.
- **Eventos.** `ModuleEvents` escuta `GET /events` (o `Workspace` consulta a cada 4 s) e recarrega a tela quando chega
  `agenda.*`, `os.*`, `reserva.*`, `mensalidade.*` ou `pedido.*`; a conversa recarrega com `web_step.*`, `form.*` e
  `payment.*` dela.
- **Horário de Brasília** (`BrasiliaTime`) e dinheiro em centavos (`Money`), qualquer que seja o fuso do aparelho.
- **Impressora.** Uma configuração do ThermalPrinterKit para o app inteiro (`WabotiaPrinting`), escolhida em
  Ajustes → Impressão → Impressora do cupom; resultado incerto pede confirmação antes da segunda via. No modo aparelho, a linha
  aparece na engrenagem em todos os papéis, mas só o Totem e o Painel híbrido imprimem; no Painel de chamadas ela diz isso.
- **Cupom da senha.** Segue `QueueOverview.coupon` (docs/FILA-SENHAS.md, "Cupom da senha"): cabeçalho do
  estabelecimento só quando vier (documento como o servidor manda, já com o CPF mascarado), posição se ligada, rodapé se vier, QR sempre que a
  senha trouxer `whatsapp_link`. Servidor sem `coupon`: o cupom de antes, com `GET /establishment`. O motivo de o QR não
  sair (`whatsapp_qr_notice`) aparece nos ajustes do totem, nunca no papel. Um QR que não cabe na largura do papel é
  deixado de fora e a senha sai mesmo assim.
- **Texto no papel** (`Device/PaperText.swift`): cupom da senha, comprovante da OS e comanda passam por `PaperText.clean`
  antes de quebrar em linhas. Ficam ASCII, os acentos do português, ç, ª e º; aspas curvas, travessão, reticências e
  ponto médio viram ASCII; emoji e o que não tem equivalente saem. O kit trocaria esses por "?" (o ponto médio da
  posição saiu assim num cupom real em 16/11; no papel o separador agora é " - ").
- **Tudo nativo**, iOS 15 ou superior, iPhone e iPad (`TARGETED_DEVICE_FAMILY` 1,2; retrato no iPhone, exceto o modo
  aparelho).

## Compilar e testar

O projeto é gerado pelo XcodeGen (`project.yml`). Do Dell, `build-on-mac.ps1` copia o app e o ThermalPrinterKit para o
Mac por `ssh mac` e compila em `~/wabotia-ios/build`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File mobile\ios\build-on-mac.ps1 -Destination simulator -Test
powershell -NoProfile -ExecutionPolicy Bypass -File mobile\ios\build-on-mac.ps1 -Destination device
```

O app só fala com servidores `https`: o Info.plist não tem exceção do ATS, e no build de loja um `http://` digitado
vira `https://` (`SessionStore.allowsCleartext`). `http://` para um servidor local de desenvolvimento só vale no
build de depuração, onde o ATS deixar. A impressora Wi-Fi usa socket direto, que não passa pelo ATS.

`-Test` roda o alvo `WabotiaTests` no simulador "Vinki v4 iPad" (cerca de 195 testes: clientes por stub de URL,
regras das telas, demonstração, modo aparelho). `-Destination device` assina com a conta do Xcode do Mac.

## Demonstração

A primeira tela tem **Conhecer o app (demonstração)** e **Ver o modo painel ou totem (demonstração)**. Tudo responde em
memória (`DemoURLProtocol` → `DemoServer`) e nada sai do aparelho. Dados fictícios: DDD 20, e-mails e links `.example`.

| Arquivo | Conteúdo |
|---|---|
| `Core/Demo/DemoServer.swift` | Conversas, protocolos, equipe, ligações, formulários e cobranças por conversa |
| `Core/Demo/DemoQueue.swift` | Fila de senhas, pareamento do aparelho e capacidades |
| `Core/Demo/DemoModules.swift` | Estabelecimento e pessoas, Agenda (barbearia), Ordem de serviço (assistência técnica) |
| `Core/Demo/DemoModulesExtra.swift` | Reserva (pousada) e Mensalidade (escola de idiomas, com pagadores) |
| `Core/Demo/DemoPedidoSuporte.swift` | Pedido (Lanchonete da Ana) e Suporte pago (conversa com passagem) |

Na demonstração as coisas acontecem sozinhas: um cliente marca horário em 40 s, outro aprova um orçamento em 1 min, a
atendente fictícia chama uma senha a cada 20 s no painel, o formulário enviado é aberto em 8 s e respondido em 20 s, e
o Mercado Pago fictício confirma a cobrança em 15 s.

## Atalhos de depuração

Só no build de depuração (`#if DEBUG`); o release não os tem. Passe como variável de ambiente do processo
(simulador: `SIMCTL_CHILD_…`; aparelho: `DEVICECTL_CHILD_…` no `devicectl` ou `-e` no `idevicedebug`).

### Demonstração

- `WABOTIA_DEMO=<tela>` abre a demonstração já na tela, numa sessão isolada (não toca na sessão real nem no Keychain):
  `conversations`, `chat`, `chat-queue`, `chat-bot`, `chat-other`, `chat-closed`, `chat-group`, `chat-window`, `chat-40`,
  `info`, `info-group`, `tickets`, `ticket`, `ticket-*`, `ticket-new`, `team`, `team-*`, `internal`, `bot`, `calls`,
  `settings`, `lines`, `menus`, `counter`, `agenda`, `appointment`, `booking`, `os`, `os-detail`, `os-new`, `reserva`,
  `reserva-booking`, `booking-new`, `mensalidade`, `installment`, `subscription`, `pedido`, `pedido-order`,
  `pedido-delivery`, `pedido-choosing`, `charge`, `forms`, `items`, `handoff`, `handoff-info`, `device`, `device-totem`,
  `device-panel`, `device-hybrid`, além das telas de entrada (`server`, `typed`, `login`) e de folhas da conversa
  (`transfer*`, `actions`, `window`, `tags`, `reply`, `claim`, `send`, `transferred`).
- `WABOTIA_DEMO_ACTION=<ação>` faz uma ação ao abrir: `call` (guichê), `issue`, `choose`, `settings`, `printer`, `pin`,
  `unpair` (aparelho), `week` (agenda), `quote` (ordem), `list` (reservas e pedidos), `menu` (cardápio),
  `subscriptions` e `delinquents` (mensalidade).
- `WABOTIA_DEMO_ANCHOR=<id>` rola até um ponto (ex.: `handoff`, `items`); `WABOTIA_DEMO_DARK=1` força o tema escuro.

### Servidor de verdade (teste em aparelho sem tocar na tela)

- `WABOTIA_DEVICE_SERVER`, `WABOTIA_DEVICE_NAME`, `WABOTIA_DEVICE_ROLE` (`totem`, `panel`, `hybrid`) e
  `WABOTIA_DEVICE_ACTION` (`issue`, `settings`, `sound`, `printer`, `unpair`, `drop`): pareia o modo aparelho (o código
  sai no console; quem administra o servidor aprova), escolhe o papel e faz uma ação; `sound` abre os ajustes e toca o
  "Testar som"; `drop` corta o WebSocket duas vezes para ver a volta automática. `WABOTIA_DEVICE_PRINT=off` emite
  sem mandar nada à impressora (o cupom sai no console), para testar a emissão sem imprimir.
- `WABOTIA_LOGIN_SERVER`, `WABOTIA_LOGIN_EMAIL` e `WABOTIA_LOGIN_PASSWORD`: entra numa **conta de teste** pelo mesmo
  login da tela Entrar, sem o pedido de permissão de notificações. A senha nunca vai ao console. Use só com conta de
  teste autorizada e nunca grave a senha em script, log ou commit.
- `WABOTIA_OPEN=<tela>` abre uma tela na sessão real: `counter`, `agenda`, `os`, `reserva`, `mensalidade`, `pedido`,
  `settings`, `os:<id>`, `appointment:<id>`, `pedido:<id>`, `subscription:<id>`, `installment:<id>`,
  `conversation:<id>`, `conversation-info:<id>`.
- `WABOTIA_COUNTER=<guichê>:<passos>` (`open`, `paused`, `closed`, `call`, `recall`, `start`, `finish`, `no-show`),
  `WABOTIA_PEDIDO=<passos>` (quadro: `mode:…`, `pause:<mensagem>`, `resume`, `off:<item>`, `on:<item>`; pedido:
  `status:<estado>`, `paid`, `method:cash|card`, `print`), `WABOTIA_ACTION=charge` (parcela) e
  `WABOTIA_CONVERSA=<passos>` (`claim`, `forms`, `form:<id>`, `charge:<pix|link>:<centavos>:<descrição>`,
  `sheet:charge|forms`, `close`, `resolve`; também com `WABOTIA_DEMO=chat`). Cada passo registra no console
  (`[Wabotia] …`) o aviso que a tela mostrou.

## Testes em aparelho

Feitos em 15/11/2026 no iPad A16 (iPadOS 26) e no iPhone X (iOS 16) contra a instalação de teste
`wabotia-staging-verticais`: pareamento, totem, painel e híbrido com chamadas reais, reconexão, revogação, guichê com o
painel, Agenda e OS atualizando por eventos, Pedido (pedido novo no quadro sem recarregar, recusa de pular estado,
pago na entrega, pausa, esgotado, comanda sem impressora), Mensalidade com o pagador, Suporte ligado sem quebrar nada,
e "Cobrar" com a Cobrança não configurada. Relatórios e capturas ficam nas notas da sessão J.

## Capturas para a loja

Com a demonstração, sem enviar nada: o script do Mac abre cada tela por `WABOTIA_DEMO` nos simuladores "Printher
Capturas iPhone" (iPhone 16 Pro Max, 1320 × 2868), "Printher Capturas iPhone Medio" (iPhone 16 Pro, 1206 × 2622) e
"Vinki v4 iPad" (iPad Air 13", 2048 × 2732), com a barra de status em 9:41 (`simctl status_bar override`) e PNG sem
transparência. As de 15/11/2026 estão em `D:\Code\Env\wabotia\iOS-loja\verticais\` com um README. A App Store exige a
tela média do iPhone e o iPad 13"; a tela grande do iPhone é opcional.

## Revisão da App Store

O texto das notas para o revisor (português e inglês) está em [`REVIEW-NOTES.md`](REVIEW-NOTES.md). Bluetooth e rede
local só são pedidos ao procurar a impressora térmica.
