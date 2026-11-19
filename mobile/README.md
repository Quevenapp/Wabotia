# Aplicativos Wabotia (Android e iOS)

Clientes nativos do Wabotia para a equipe de atendimento. Funcionam com **qualquer servidor** Wabotia: a pessoa informa o endereço da instalação na primeira tela, entra com e-mail e senha de atendente e passa a operar o atendimento do WhatsApp pelo celular. A documentação do servidor (login móvel, dispositivos, push, gateway) está em [`docs/MOBILE.md`](../docs/MOBILE.md). O contrato REST completo está em [`docs/API.md`](../docs/API.md) e em `/api/openapi.json` de cada servidor.

| Plataforma | Pasta | Stack | Mínimo |
|---|---|---|---|
| Android | [`android/`](android) | Kotlin 2.2, Jetpack Compose (Material 3), Retrofit/OkHttp, kotlinx.serialization, Coil, Media3, Firebase Messaging, ThermalPrinterKit | Android 8.0 (API 26) |
| iOS | [`ios/`](ios) | Swift 5.10, SwiftUI, URLSession async/await, FirebaseMessaging, AVFoundation, ThermalPrinterKit | iOS 15 |

Ambos usam o mesmo desenho de telas e os mesmos textos (pt-BR). Pacote/bundle: `br.com.queven.wabotia`.

**Modo aparelho, guichê e verticais (servidor com módulos).** Os dois aplicativos passaram a cobrir os módulos do servidor ([`docs/MODULOS.md`](../docs/MODULOS.md)), cada um só quando está ligado na área (`GET /profiles/{p}/capabilities`; `409 module_disabled` esconde a entrada):

- **Modo aparelho:** celular ou tablet pareado (RFC 8628, `client=senhapp`, escopos `queue:read` e `queue:issue`) vira **totem** de senhas com cupom impresso, **painel de chamadas** (senha em destaque, voz pt-BR, gongo) ou **híbrido**. Reabre direto no papel, com PIN dos ajustes e "desconectado" quando um administrador revoga o aparelho. A trava da tela é do sistema: fixação de tela ou *device owner* no Android ([`android/MODO-APARELHO.md`](android/MODO-APARELHO.md)) e Acesso Guiado ou Modo de App Único por MDM no iOS ([`ios/README-IOS.md`](ios/README-IOS.md)).
- **Guichê:** Ajustes → Atendimento → Guichê: escolher o guichê, abrir, pausar e fechar, chamar a próxima senha, rechamar, iniciar, concluir, ausente e transferir.
- **Verticais:** Agenda, Ordem de Serviço, Reserva, Mensalidade e Pedido, além da faixa de passagem e do Suporte pago na conversa e de "Enviar formulário" (passo web) e "Cobrar" (Pix ou link). Horário de Brasília e valores em centavos, seja qual for o fuso do aparelho.
- **Impressão:** cupom do totem, comanda do Pedido e comprovante da OS saem pelo **ThermalPrinterKit**, biblioteca privada usada por caminho local (ver Compilar). Uma impressora para o app inteiro, escolhida em Ajustes → Impressora do cupom.

O detalhe de cada parte, a demonstração e os atalhos de teste estão em [`ios/README-IOS.md`](ios/README-IOS.md) (o Android segue as mesmas regras e telas) e em [`android/MODO-APARELHO.md`](android/MODO-APARELHO.md) para a trava do aparelho no Android.

**Versão 0.14.0 (central de atendimento).** Os aplicativos acompanham o contrato do servidor 0.14 descrito em [`docs/CENTRAL-ATENDIMENTO.md`](../docs/CENTRAL-ATENDIMENTO.md): **seis estados de protocolo** (Recebido, Em análise, Aguardando cliente, Aguardando terceiro, Resolvido, Encerrado), **categoria do protocolo** (aplicativo ou assunto, de `ticket_categories`), prévia da lista de conversas vinda de `last_message` e o destino de menu `ticket` ("Abrir protocolo"). Continuam funcionando com servidores 0.13: campos ausentes são tratados como "sem categoria" e "sem prévia do servidor", e um estado que o aplicativo ainda não conhece aparece como texto neutro.

**Interface 0.13.0.** A aparência e o comportamento das telas estão em [`DESIGN.md`](DESIGN.md): visual de mensageiro no estilo do WhatsApp, relógio da janela de 24 horas (lista, conversa e dados do contato), pílula de presença Online/Offline, rodapé "Assumir conversa" conforme o estado e a folha única **Encaminhar atendimento** (Pessoas, Bots, Setores, Menu, Protocolo). As abas passaram a ser **Conversas, Protocolos, Equipe, Ligações e Ajustes**; os bots ficam em Equipe → Bots e o que era "Mais" está em Ajustes. As seções abaixo continuam valendo para regras, dados e chamadas de cada recurso.

**Modo de demonstração (todos os builds).** Na tela Servidor, **Conhecer o app (demonstração)** (ou digitar `demo` como servidor) entra numa instalação fictícia em memória (`demo.wabotia.localhost`), respondida na camada de rede do próprio app: sem servidor, sem senha e sem conta. É para quem baixou o app sem ter um servidor Wabotia e para a revisão das lojas (a diretriz 2.1 da Apple aceita um modo de demonstração completo no lugar de uma conta de teste). Regras:

- **Nada sai do aparelho.** Toda chamada para esse endereço é respondida em memória (Android: interceptor em todo cliente OkHttp, inclusive Coil e Media3; iOS: `DemoURLProtocol` na URLSession). No iOS os players de áudio e vídeo tocam uma cópia local do anexo, porque o AVPlayer não passa pela URLSession. `.localhost` nunca é um endereço da internet.
- **Sem push.** O aparelho nunca é registrado (`PUT /devices` não é chamado nem o token FCM é pedido pela demonstração) e o app não pede permissão de notificações. Um aviso de outro servidor que chegue durante a demonstração não abre nada nela (o Android nem o mostra).
- **Sempre identificada.** Uma faixa fixa no topo de todas as telas depois da entrada diz "Demonstração · Dados fictícios · nada é enviado" e tem **Sair**, que pede confirmação e volta à tela Servidor. Em Ajustes, Notificações e Servidor viram explicações e "Sair da conta" vira **Sair da demonstração**. O endereço da demonstração nunca fica guardado como servidor.
- **Dados fictícios, do zero.** Os dados recomeçam a cada entrada e a cada abertura do app (prévias, não lidas e cursor de eventos também). Empresa "Empresa Exemplo", pessoas inventadas, telefones com o DDD 20 (que não existe no Brasil) começando por 9 0, e-mails e links em `.example`, endereços inventados; nenhum nome de pessoa, empresa ou produto real. Os testes (`DemoModeTest`, `DemoModeTests`) conferem isso.
- **Fluxos cobertos.** Fila, Assumir conversa, respostas (o cliente responde sozinho alguns segundos depois), anexos, notas, transferência (pessoas, bots, setores, menu, protocolo), protocolos nos seis estados com categorias (`ticket_categories` no status) e `last_message` nas conversas, Equipe (pessoas, bots, setores, conversas internas), Ligações e Ajustes.

Atalhos só do build de depuração, para conferir telas por print: Android `adb shell am start -n br.com.queven.wabotia.debug/br.com.queven.wabotia.MainActivity --es demo <tela>`; iOS variável de ambiente `WABOTIA_DEMO=<tela>` (`conversations`, `chat`, `chat-queue`, `transfer`, `info`, `tickets`, `ticket`, `team`, `calls`, `settings`). No Android `--es arg` escolhe o protocolo (`overdue`, `soon`, `answered`, `third`, `resolved`, `closed`) ou o filtro da lista (`all`, `waiting`, `resolved`…), e no iOS há `ticket-waiting`, `ticket-third`, `ticket-resolved`, `ticket-closed`, `ticket-overdue`, `ticket-category` e `tickets-all`. No release esses atalhos não existem (o extra `demo` do Intent é ignorado).

No iOS 15 (incluindo iPhone 7), uma camada de compatibilidade oferece navegação, campos multilinha, seletor de fotos/vídeos e compartilhamento com os controles disponíveis no sistema. Os mesmos recursos de atendimento permanecem disponíveis; iOS 16 ou superior usa a navegação moderna.

## Arquitetura comum

- **Servidor por instalação.** `SessionStore` guarda `serverUrl` (normalizado, sem barra final), o token `wabu_…` (Keychain / EncryptedSharedPreferences), o usuário, o perfil escolhido e o identificador do dispositivo (UUID por instalação). Trocar de servidor = sair da conta e informar outro endereço.
- **Autenticação.** `POST /api/auth/mobile/login` → `Authorization: Bearer wabu_…` em todas as chamadas. `401` em qualquer chamada → voltar ao login mantendo o servidor. Renovar com `POST /api/v1/auth/mobile/refresh` quando faltarem menos de 7 dias (iOS: `AppContainer.refreshTokenIfNeeded`; Android: `SessionStore.tokenExpires`).
- **Idempotência.** Toda escrita envia `Idempotency-Key`. Para "enviar mensagem", a chave é gerada quando a pessoa toca em Enviar e **mantida** enquanto o pedido não for confirmado (repetição após falha de rede reutiliza a mesma chave e o mesmo corpo). `409 idempotency_conflict` significa corpo diferente para a mesma chave: gere outra chave e avise.
- **Atualização em primeiro plano.** `GET /profiles/{p}/events?after=cursor` a cada 4 s enquanto a tela está visível (lista e conversa aberta); `cursor` persistido por perfil. Eventos relevantes: `message.received`, `message.sent`, `message.updated`, `conversation.created`, `conversation.updated`, `ticket.*`, `call.updated`. Em segundo plano, o push faz o trabalho.
- **Push.** Registro em `PUT /api/v1/devices/{deviceId}` após o login e quando o token FCM muda; `DELETE` antes de sair. `data.type` decide a tela: `message`/`queue`/`transfer` → conversa; `ticket`/`ticket_due` → protocolo; `call` → conversa (não há tela de ligação desde a 0.17.0). Deep link `wabotia://open/{type}?profile=&conversation=&ticket=&call=`.
- **Mídia privada.** Anexos exigem `Authorization`; nunca use a URL sem o cabeçalho (Coil/ExoPlayer com OkHttp autenticado; iOS `URLRequest`/`AVURLAsset` com `AVURLAssetHTTPHeaderFieldsKey`). Upload em partes de 5 MiB (`/media/uploads` → `PUT parts/{n}` com `Idempotency-Key = "{uploadId}:{n}"` → `complete`), até 100 MiB; o canal pode impor limites menores (Meta: imagem 5 MiB, vídeo/áudio 16 MiB).
- **Permissões por conversa.** `GET /conversations/{id}` traz `capabilities` (`voice`, `sticker`, `location`, `contacts`, `reply`, `reaction`, `edit`, `delete`, `read`, `mentions`, `calls`, `groups`). Botões só aparecem quando a capacidade existe. Responder exige a conversa assumida (`owner == eu` e `state == human`).

## Telas

### Servidor e login
1. **Servidor:** campo único com prefixo `https://`, exemplos, validação por `GET /api/health` (`service == "wabotia"`) e `GET /api/auth/status` (`initialized`). Erros amigáveis (não é Wabotia, sem administrador, DNS, certificado). Abaixo, **Conhecer o app (demonstração)** abre o modo de demonstração (ver acima).
2. **Login:** e-mail, senha (mostrar/ocultar), "Trocar servidor". Após entrar: pedir permissão de notificações e registrar o dispositivo.
3. **Perfil:** lista quando há mais de um (`GET /api/v1/profiles`); administradores veem todos. Um perfil só → entra direto.

### Conversas (aba 1)
- Filtros em chips: **Fila** (`state=waiting`), **Minhas** (`state=human` filtrado por `owner == eu`), **IA** (`state=ai`), **Concluídas** (`state=closed`), **Todas**. Busca (`q`) por telefone/nome. Paginação por `next_cursor` (base64 opaco). Pull-to-refresh.
- Linha: avatar com inicial, nome (`contact_name` → `title` → `phone` → `external_id`), último horário (`updated`), chip de estado (Com a IA / Na fila / Com atendente / Concluído), ícone de grupo quando `chat_type == group`, etiquetas.
- Prévia da última mensagem: servidores 0.14+ mandam `last_message` em cada linha (`text`, `direction`, `created`, `delivery_status`, `attachments` como quantidade, `kind`) e o app usa esse campo: texto, tick de entrega quando a mensagem saiu de nós, rótulo do anexo pelo `kind` (Foto, Vídeo, Áudio, Documento, Localização, Contato, Figurinha, Mensagem interativa) e cadeado para nota interna. O cache local continua como reserva para servidores antigos (campo ausente) e só passa na frente quando é mais novo que `last_message.created` (evento recebido antes da recarga da lista). As não lidas continuam locais. Com `last_message` presente, o preenchimento em segundo plano por detalhe não é feito para aquela conversa.

### Conversa
- Cabeçalho: nome, telefone, estado e responsável (`GET /presence` para nomes). Menu: **Assumir** (`claim`), **Transferir** (`transfer` com `target` escolhido em `GET /team`, mostrando pessoas e bots com presença), **Devolver à IA** (`resume`), **Concluir** (`resolve`), **Etiquetas** (`tags`), **Abrir protocolo**, **Consultar bot** (abre Bot com o contexto da conversa), **Ligar** (se `capabilities.calls`), **Salvar contato**. Grupo: seletor de `bot_policy` (`PUT /groups/{id}/policy`).
- Lista de mensagens (mais antigas em cima, rolagem até o fim ao abrir): bolhas cliente à esquerda, enviadas à direita, notas internas destacadas; autor nos grupos (`content.participant_name`); citação (`content.reply_to` / `reply_text`); reações (`content.reactions`); "Mensagem apagada" (`content.deleted`); "Editada"; recibo (`delivery_status`: Na fila / Enviada / Entregue / Lida / Ouvida / Falhou / Sem confirmação); localização (`content.location` → abrir no mapa); contatos (`content.contacts`). Anexos pela lista `media` do detalhe: imagem (miniatura → visualizador com zoom e compartilhar), vídeo (player), áudio/voz (player com progresso), documento (nome, tamanho, baixar/abrir/compartilhar). Entregas pendentes (`deliveries` não `sent`/`cancelled`) aparecem como linha de status.
- Ações por mensagem (toque longo), conforme `capabilities`: Responder (citação), Reagir (👍 ❤️ 😊 🙏 e remover), Editar (só enviadas, sem anexos, < 15 min), Apagar (confirmação), Marcar como lida (recebidas), Copiar texto.
- Composer (só quando assumida; senão mostra "Assuma a conversa para responder"): texto multilinha; **Anexar** (galeria foto/vídeo, câmera, arquivo); **Gravar áudio** (segurar ou tocar para iniciar/parar, até 2 min, prévia, descartar; Android `MediaRecorder` OGG/Opus em API 29+ e AAC/M4A como `audio` abaixo disso; iOS grava Opus em CAF via `AVAudioRecorder` e remuxa para OGG com `OggOpusMuxer`, caindo para M4A/AAC como `audio` se falhar); **Localização** (posição atual do aparelho com permissão, revisão antes de enviar, ou coordenadas manuais); **Contato** (picker do sistema ou nome/telefone manual); **Nota interna** (`note`). Tipo do conteúdo: automático pelo arquivo ou "Enviar como documento". Progresso de upload por arquivo. Pedido pendente guardado (mesma `Idempotency-Key`) com "Tentar novamente"/"Abandonar pedido".
- Falha de envio mantém o rascunho. `422 unsupported_capability` explica que o canal não oferece o recurso.

### Protocolos (aba 2)
- **Estados** (`tickets.status`, servidor 0.14): `open` Recebido, `in_progress` Em análise, `waiting_customer` Aguardando cliente, `waiting_third` Aguardando terceiro, `resolved` Resolvido, `closed` Encerrado. **Ativo** = não é `resolved` nem `closed`; atraso, contadores, contador da aba e edição do prazo usam essa regra. Um estado desconhecido aparece como texto neutro (o próprio valor, legível) e conta como ativo. Em um servidor 0.13 só existem `open`, `in_progress` e `closed`, exibidos como Recebido, Em análise e Encerrado.
- Filtros: **Ativos** (`active=1`, o padrão), **Recebidos** (`status=open`), **Em análise** (`status=in_progress`), **Aguardando** (`waiting_customer` + `waiting_third`), **Atrasados** (`overdue=1`), **Resolvidos** (`resolved` + `closed`), **Todos**. O servidor aceita um `status` por consulta: filtros com dois estados fazem uma consulta por estado e juntam o resultado (sem paginação), tratando `400` de um estado desconhecido como lista vazia (servidor 0.13). O app também aplica o filtro no que recebe, porque um servidor 0.13 ignora `active=1`. Contadores dos chips e da aba vêm de uma consulta `active=1`, contada no app (atrasado = ativo, sem `first_response_at` e com `response_due_at` vencido).
- **Categoria** (aplicativo ou assunto): `ticket_categories` em `settings` de `GET /profiles/{p}/status` (`{id, name, enabled}`). O nome aparece no cartão e no detalhe; categoria removida da configuração mostra o `id` gravado. Quando o perfil tem categorias, a lista ganha uma segunda linha de chips (`category=<id>`), a tela **Abrir protocolo** e a aba Protocolo da folha de transferência oferecem a escolha (`category` em `POST /tickets`, omitido quando "Sem categoria") e o detalhe permite trocar (`PATCH /tickets/{id}` com `category`, `null` limpa). Só categorias habilitadas são oferecidas.
- Linha: número `WA-…`, título, estado, categoria, prazo (`response_due_at`) com cores: vermelho atrasado, laranja vence em menos de 1 h, cinza sem prazo; "Respondido" quando `first_response_at`; protocolo não ativo mostra o próprio estado no lugar do prazo.
- Detalhe (`GET /tickets/{id}`): dados, categoria, conversa (abrir), responsável (nome via `GET /presence`), linha do tempo de `updates`. Ações (`PATCH /tickets/{id}`): **Registrar andamento** (`text`, vai ao cliente como "Protocolo WA-…: texto"), **Estado** (qualquer um dos seis; Resolvido e Encerrado pedem confirmação), **Categoria** (`category`), **Responsável** (`owner` da lista de presença), **Prazo** (`response_due_at`, só antes da primeira resposta e com o protocolo ativo; `null` remove). Erros do servidor exibidos (ex.: "Somente o responsável pode alterar o protocolo").
- **Abrir protocolo** a partir da conversa: título obrigatório (até 300) e categoria opcional, `POST /tickets`.

### Bots (aba 3)
- Lista de bots habilitados (`GET /bots`, `enabled == 1`) e histórico recente de execuções (`GET /bot-runs`, mais recentes primeiro, estado colorido).
- Chat com o bot: campo de entrada (até 60.000 caracteres) → `POST /api/v1/bot-runs {profile_id, bot_id, input}` (202) → consulta `GET /api/v1/bot-runs/{id}` a cada 2 s até `completed`/`failed`/`cancelled`/`unknown`. Mostra `result` como texto, `attachments` (IDs de mídia, abrir/baixar como na conversa) e `error`. Botão **Cancelar** (`POST /profiles/{p}/bot-runs/{id}/cancel`) enquanto roda. Quando aberto a partir de uma conversa, pré-preenche o contexto ("Cliente {telefone} perguntou: …") e oferece **Copiar resposta** para colar no composer.
- Devolver a conversa ao bot do perfil é a ação **Devolver à IA** da conversa (`resume`).

### Ligações (aba 4)
- Somente histórico (`GET /calls`): data, Recebida/Realizada, estado em português (Encerrada, Não atendida, Recusada, Falhou, Sem confirmação) e duração.
- Desde a 0.17.0 os aplicativos não iniciam nem atendem ligações. O servidor não oferece ligações ao vivo pela Zernio (`capabilities.calls` é sempre falso), então a tela de ligação, o WebRTC, o CallKit e o serviço em primeiro plano foram retirados, junto com as permissões que só eles usavam.

### Mais (aba 5) — atendimento e equipe na versão 0.9.0

- **Equipe e conversas internas:** diretório de pessoas e bots com estado Online/Offline, histórico privado e chat dentro do Wabotia. As mensagens internas não passam pelo WhatsApp. O histórico continua acessível quando um contato fica indisponível. Respostas de bots são acompanhadas na própria conversa.
- **Linhas de atendimento:** escolha equipe humana, bot específico ou configuração do perfil para cada linha; configure menus automáticos, sob demanda ou desligados e a participação no roteador separadamente. Administradores editam; atendentes consultam.
- **Menus e submenus (administrador):** crie ou edite opções, destino, menu pai, linhas permitidas e exibição automática/sob demanda. Submenus respeitam também o escopo de linhas do pai. A lista mostra o destino de cada opção pelo nome (Pessoa, Bot, Submenu, Aplicativo, **Abrir protocolo** para `type: "ticket"`, Link, Mensagem informativa, Consultar protocolos, Pesquisa de satisfação; um tipo desconhecido aparece como "Outro destino (tipo)"). O aplicativo monta os destinos Pessoa, Bot, Submenu, Aplicativo e Abrir protocolo (com `category_id` opcional); os demais continuam selecionados ao abrir a opção e todos os campos que a tela não edita (`url`, `content`, `question`, `department_id`, campos novos) são preservados ao salvar.
- **Linhas dos bots (administrador):** autorize todas as linhas, linhas específicas ou nenhuma (somente conversas internas).
- Na conversa WhatsApp, **Enviar menu** permite chamar o menu principal ou um submenu disponível naquela linha. **Transferir** lista pessoas e bots autorizados para a linha, com presença.
- Novos atendimentos do roteador alternam números com prioridade à franquia disponível. Conversas existentes permanecem no mesmo número após a franquia, com possível cobrança de serviço. A janela de 24 horas permanece obrigatória; pagar serviço não autoriza texto livre fora dela.

### Mais — conta e dispositivo
- **Disponibilidade:** interruptor Presente/Ausente (`PUT /presence {present}`), lista da equipe com presença.
- **Perfil:** trocar de perfil (quando há mais de um). **Notificações:** ligar/desligar (atualiza `enabled` do dispositivo), "Enviar teste" (`POST /devices/{id}/test`), permissão do sistema. **Dispositivo:** nome, versão, estado do registro de push. **Servidor:** endereço, versão (`GET /api/health`), abrir painel no navegador. **Sair:** `DELETE /devices/{id}` → `POST /logout` → limpar sessão (mantém o servidor).

## Textos e comportamento

- Idioma pt-BR, tom direto, sem jargão. Datas no fuso do aparelho em formato curto; "Hoje 14:32", "Ontem", "08/11".
- Erros da API (`error.message`) são exibidos como vêm; falhas de rede têm mensagens próprias. Nunca repetir automaticamente uma escrita sem a mesma `Idempotency-Key`.
- Nenhum segredo em logs. O token nunca aparece na interface.

## Compilar

Veja [`docs/MOBILE.md`](../docs/MOBILE.md#4-compilar-os-aplicativos). Resumo: Android `cd android && ./gradlew assembleDebug` (JDK 17, SDK 36, Kotlin 2.2; `google-services.json` opcional); iOS `cd ios && xcodegen generate && xcodebuild -scheme Wabotia -destination "generic/platform=iOS" build` (Xcode 16+, `GoogleService-Info.plist` opcional).

Os dois precisam do repositório **ThermalPrinterKit** ao lado:

- **Android:** `-PthermalPrinterKitDir=…` (ou em `gradle.properties`), a variável `THERMAL_PRINTER_KIT_DIR`, ou o primeiro `ThermalPrinterKit` encontrado subindo da pasta do app.
- **iOS:** pacote local em `../../../../ThermalPrinterKit/ios` (`project.yml`). Do Windows, `ios/build-on-mac.ps1` copia o app e a biblioteca para o Mac e compila; com `-Test`, também roda os testes.

## API de linhas e equipe

Clientes 0.9.0 requerem servidor 0.9.0 para os novos recursos. `GET /profiles/{p}/lines` e `PUT /lines/{id}` consultam e configuram atendimento; `GET /menus` e `PUT /settings {menus}` configuram menus; `PATCH /bots/{id} {line_ids}` restringe linhas (`null`: todas, `[]`: somente interno). `GET /team` consulta presença. `GET/POST /internal-chats`, `GET /internal-chats/{id}` e `POST /internal-chats/{id}/messages` mantêm conversas privadas. Todos os caminhos têm o prefixo `/api/v1`. Escritas reutilizam a mesma Idempotency-Key após resposta inconclusiva; erros definitivos liberam a edição.

## Primeira leva de canais

Android e iOS passam a ler WhatsApp, Instagram e Facebook na mesma aba **Conversas**. Em área multicanal, a lista mostra canal, conta e janela retornada pelo servidor; o filtro de canal integra a chave de paginação e descarta respostas atrasadas. Em área só WhatsApp, permanecem avatar, subtítulo, filtro e comportamento anteriores. Campo ausente é compatibilidade com servidor antigo; canal desconhecido não é convertido em WhatsApp por exclusão.

Nas DMs sociais, a janela de 24 a menos de 168 horas permite somente texto humano. Anexos, reações, menus e automação ficam bloqueados nessa extensão; a decisão final continua no servidor, inclusive para clientes antigos. Canais sem prazo não recebem relógio. Módulos permanecem exclusivos do WhatsApp mesmo quando as fichas estão juntadas.

Os dados da conversa mostram os canais da ficha e atalhos para outras conversas autorizadas, sem misturar mensagens. Essa parte é somente leitura nos aplicativos; **Juntar com outro contato** e desfazer ficam na web.

**Enviar conversa por e-mail** aparece conforme a permissão. Os aplicativos usam a mesma prévia, destinos, intervalo, confirmação do endereço e pedido do cliente definidos em [EMAIL.md](../docs/EMAIL.md). A chave de envio permanece estável durante repetição da mesma intenção; resultado indeterminado é mostrado sem reenvio automático. Notas internas nunca entram na transcrição.

Push usa o título já preparado pelo servidor: em área multicanal pode conter `Instagram · Nome`; prévia mínima continua `Wabotia`. Android não acrescenta um segundo prefixo e conserva os canais de notificação do sistema operacional.

A demonstração mantém cenários sintéticos só WhatsApp e multicanal, janelas aberta/humana/fechada, ficha compartilhada, mídia indisponível e transcrição sem configuração/permissão ou repetida. No Android, os dados multicanal pertencem à área `demo-channels`; no iOS, o modo de inspeção usa `WABOTIA_DEMO_CHANNELS=multichannel`. Nada disso é captura de conta real ou teste de entrega remota.

Verificação desta leva: o orquestrador informou Android `assembleDebug` e testes unitários aprovados nesta máquina antes do aceite. O script reprodutível `node scripts/cn-android-check.mjs`, executado na raiz, exige SDK/JDK/Gradle/ThermalPrinterKit instalados e compila em modo offline, com log em `mobile/android/.gradle/cn-check/result.log`. A preparação documental não repetiu o build.

O registro de [CANAIS-ACEITE.md](../docs/CANAIS-ACEITE.md) descreve o estado da primeira leva. A compilação iOS antes pendente foi realizada posteriormente pelo orquestrador sobre a segunda leva integrada, conforme o estado abaixo. Testes TypeScript de contratos/fontes no Windows não aprovam um build nativo. Conferência visual e acessibilidade em aparelhos também devem ser registradas. Não houve publicação em lojas ou alteração de versão de loja.

## Segunda leva de canais

Android e iOS leem comentários do Instagram/Facebook, Telegram, e-mail e TikTok na mesma aba **Conversas**, a partir das capacidades e da projeção `channel_extension` do servidor. Sem os canais novos, continuam os controles e a apresentação anteriores. Campo desconhecido é tolerado; canal desconhecido não ganha envio por exclusão. Não há tela Google, gestão de conexões ou junção de contatos nos aplicativos; essas operações ficam na web.

- **Comentários:** tipo “Comentário”, contexto da publicação e alvo. Resposta exige escolha explícita pública/privada; envio genérico não publica. Prazo e tentativa privada vêm do servidor, sem relógio de DM e sem bot público.
- **E-mail:** assunto no composer e no balão quando muda, aviso de remetente não confirmado e conteúdo em texto. A intenção idempotente inclui assunto antes do envio; CR/LF/NUL são recusados. Recebimento não prova identidade nem habilita dados de cliente. A transcrição existente continua separada.
- **TikTok:** janela de 48 horas e vagas restantes projetadas pelo servidor. A regra conservadora conta dez tentativas nas últimas 48 horas corridas; nova entrada não zera a contagem. Texto com imagem ocupa duas vagas.
- **Telegram:** sem janela; bloqueio e limites de envio são respeitados. Compartilhar telefone próprio após pedido válido pode sugerir junção humana na web, sem confirmar telefone automaticamente.

Módulos continuam exclusivos do WhatsApp. Push usa o título preparado pelo servidor e não acrescenta prefixo duplicado. A demonstração da segunda leva é optativa: `?canais=2` nas requisições da demo; no iOS também `WABOTIA_DEMO_CHANNELS_SECOND_WAVE=1`. Os cenários são sintéticos e não comprovam entrega real. No Android a área própria chama-se `demo-channels-second-wave`.

O transporte de produção do canal de e-mail ainda retorna `provider_contract_unverified`, aguardando confirmação do REST com conta real; a demonstração não remove esse bloqueio. Recebimento manual e limites estão em [CANAIS-EMAIL-RECEBIMENTO.md](../docs/CANAIS-EMAIL-RECEBIMENTO.md).

### Verificações nativas informadas pelo orquestrador

| Plataforma | Resultado já obtido antes deste aceite | O que continua pendente |
|---|---|---|
| Android | APK de depuração compilado neste Dell pela tarefa `c2-android`; 198 testes Kotlin passaram, seis ignorados. | Prova em aparelho e inspeção visual/acessibilidade da segunda leva. Build não repetido neste aceite. |
| iOS | Mac com Xcode 27.2; compilação e teste em simulador: 259 testes, zero falhas, sete pulados. | Prova em aparelho e inspeção visual/acessibilidade. Build não repetido neste Windows. |

O iOS precisou de três correções já incorporadas pelo orquestrador: literal aninhado sem inferência suficiente, acesso sobreposto a `rows` e assunto de e-mail com `\r\n` que escapava à verificação por `contains("\r")`, pois o par forma um só caractere em Swift. Não registrar iOS como “nunca compilado”; também não tratar simulador como aparelho real.

O wrapper `node scripts/c2-android-check.mjs` reutiliza a verificação offline de build e testes reais da primeira leva. Seus modos `--self-test` e `--source-check` conferem o wrapper/fontes e **não compilam Android**. O estado do fechamento integrado e as pendências externas estão em [CANAIS-SEGUNDA-LEVA-ACEITE.md](../docs/CANAIS-SEGUNDA-LEVA-ACEITE.md).
