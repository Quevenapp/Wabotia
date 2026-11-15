# Wabotia iOS: modo aparelho, guichê e verticais

O que o app iOS ganhou desde a 0.18.0 (branch `feat/ios-aparelho`), como cada parte fala com o servidor, como testar e
como montar a demonstração. O panorama dos dois apps continua em [`../README.md`](../README.md); o contrato do
servidor está em `docs/API.md`, `docs/MODULOS.md` e nos guias de cada módulo.

## O que mudou

| Parte | Onde | Resumo |
|---|---|---|
| Modo aparelho | `Wabotia/Device/` | iPad ou iPhone vira **totem** (emite senha, cupom pelo ThermalPrinterKit), **painel de chamadas** (senha em destaque, voz pt-BR, gongo) ou **híbrido**. Pareamento RFC 8628 (`client=senhapp`, escopos `queue:read` e `queue:issue`), credencial `wab_` no Keychain; reabre direto no modo aparelho; WebSocket da fila com volta automática e leitura por consulta de reserva; revogação mostra "desconectado". Paisagem e tela cheia. |
| Guichê | `Features/Queue/` | Ajustes → Atendimento → Guichê: escolher guichê, abrir/pausar/fechar, chamar a próxima, rechamar, iniciar, concluir, ausente, transferir. |
| Agenda | `Modules/Agenda/` | Dia por profissional e semana; confirmar, remarcar, ausência, cancelar; agendar pela conversa. |
| Ordem de serviço | `Modules/ServiceOrders/` | Lista por estado e busca, detalhe com histórico, orçamento, responsável (`GET /people`), entrega e comprovante impresso com o estabelecimento. |
| Reserva | `Modules/Reserva/` | Ocupação por unidade e dia, lista, detalhe com sinal e check-in, reserva por diária ou por hora. |
| Mensalidade | `Modules/Mensalidade/` | Resumo do mês, parcelas (reenviar cobrança, baixa, isenção), assinaturas e inadimplentes, com o pagador (CPF/CNPJ e telefones). |
| Pedido | `Modules/Pedido/` | Quadro da cozinha, lista, cardápio com esgotado, pausa da loja, detalhe sem agrupar montagens, pagamento na entrega, comanda pelo ThermalPrinterKit (32/42/48 colunas). |
| Passagem e Suporte pago | `Modules/Suporte/` | Faixa no topo da conversa com o resumo e os avisos do módulo que passou o cliente à equipe; vincular telefone, confirmar e liberar, cortesia. |
| Formulário e Cobrança | `Modules/Cobranca/` | "Enviar formulário" (passo web) e "Cobrar" (Pix ou link) na conversa, com o estado de cada link e cobrança atualizado por eventos. |

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
  Ajustes → Impressora do cupom; resultado incerto pede confirmação antes da segunda via.
- **Tudo nativo**, iOS 15 ou superior, iPhone e iPad (`TARGETED_DEVICE_FAMILY` 1,2; retrato no iPhone, exceto o modo
  aparelho).

## Compilar e testar

O projeto é gerado pelo XcodeGen (`project.yml`). Do Dell, `build-on-mac.ps1` copia o app e o ThermalPrinterKit para o
Mac por `ssh mac` e compila em `~/wabotia-ios/build`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File mobile\ios\build-on-mac.ps1 -Destination simulator -Test
powershell -NoProfile -ExecutionPolicy Bypass -File mobile\ios\build-on-mac.ps1 -Destination device
```

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
  `WABOTIA_DEVICE_ACTION` (`issue`, `settings`, `printer`, `unpair`, `drop`): pareia o modo aparelho (o código sai no
  console; quem administra o servidor aprova), escolhe o papel e faz uma ação; `drop` corta o WebSocket duas vezes para
  ver a volta automática.
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
