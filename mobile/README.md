# Aplicativos Wabotia (Android e iOS)

Clientes nativos do Wabotia para a equipe de atendimento. Funcionam com **qualquer servidor** Wabotia: a pessoa informa o endereço da instalação na primeira tela, entra com e-mail e senha de atendente e passa a operar o atendimento do WhatsApp pelo celular. A documentação do servidor (login móvel, dispositivos, push, gateway) está em [`docs/MOBILE.md`](../docs/MOBILE.md). O contrato REST completo está em [`docs/API.md`](../docs/API.md) e em `/api/openapi.json` de cada servidor.

| Plataforma | Pasta | Stack | Mínimo |
|---|---|---|---|
| Android | [`android/`](android) | Kotlin 2.0, Jetpack Compose (Material 3), Retrofit/OkHttp, kotlinx.serialization, Coil, Media3, Firebase Messaging, stream-webrtc-android | Android 8.0 (API 26) |
| iOS | [`ios/`](ios) | Swift 5.10, SwiftUI, URLSession async/await, FirebaseMessaging, WebRTC (stasel), CallKit, AVFoundation | iOS 16 |

Ambos usam o mesmo desenho de telas e os mesmos textos (pt-BR). Pacote/bundle: `br.com.queven.wabotia`.

## Arquitetura comum

- **Servidor por instalação.** `SessionStore` guarda `serverUrl` (normalizado, sem barra final), o token `wabu_…` (Keychain / EncryptedSharedPreferences), o usuário, o perfil escolhido e o identificador do dispositivo (UUID por instalação). Trocar de servidor = sair da conta e informar outro endereço.
- **Autenticação.** `POST /api/auth/mobile/login` → `Authorization: Bearer wabu_…` em todas as chamadas. `401` em qualquer chamada → voltar ao login mantendo o servidor. Renovar com `POST /api/v1/auth/mobile/refresh` quando faltarem menos de 7 dias (iOS: `AppContainer.refreshTokenIfNeeded`; Android: `SessionStore.tokenExpires`).
- **Idempotência.** Toda escrita envia `Idempotency-Key`. Para "enviar mensagem", a chave é gerada quando a pessoa toca em Enviar e **mantida** enquanto o pedido não for confirmado (repetição após falha de rede reutiliza a mesma chave e o mesmo corpo). `409 idempotency_conflict` significa corpo diferente para a mesma chave: gere outra chave e avise.
- **Atualização em primeiro plano.** `GET /profiles/{p}/events?after=cursor` a cada 4 s enquanto a tela está visível (lista e conversa aberta); `cursor` persistido por perfil. Eventos relevantes: `message.received`, `message.sent`, `message.updated`, `conversation.created`, `conversation.updated`, `ticket.*`, `call.updated`. Em segundo plano, o push faz o trabalho.
- **Push.** Registro em `PUT /api/v1/devices/{deviceId}` após o login e quando o token FCM muda; `DELETE` antes de sair. `data.type` decide a tela: `message`/`queue`/`transfer` → conversa; `ticket`/`ticket_due` → protocolo; `call` → tela da ligação. Deep link `wabotia://open/{type}?profile=&conversation=&ticket=&call=`.
- **Mídia privada.** Anexos exigem `Authorization`; nunca use a URL sem o cabeçalho (Coil/ExoPlayer com OkHttp autenticado; iOS `URLRequest`/`AVURLAsset` com `AVURLAssetHTTPHeaderFieldsKey`). Upload em partes de 5 MiB (`/media/uploads` → `PUT parts/{n}` com `Idempotency-Key = "{uploadId}:{n}"` → `complete`), até 100 MiB; o canal pode impor limites menores (Meta: imagem 5 MiB, vídeo/áudio 16 MiB).
- **Permissões por conversa.** `GET /conversations/{id}` traz `capabilities` (`voice`, `sticker`, `location`, `contacts`, `reply`, `reaction`, `edit`, `delete`, `read`, `mentions`, `calls`, `groups`). Botões só aparecem quando a capacidade existe. Responder exige a conversa assumida (`owner == eu` e `state == human`).

## Telas

### Servidor e login
1. **Servidor:** campo único com prefixo `https://`, exemplos, validação por `GET /api/health` (`service == "wabotia"`) e `GET /api/auth/status` (`initialized`). Erros amigáveis (não é Wabotia, sem administrador, DNS, certificado).
2. **Login:** e-mail, senha (mostrar/ocultar), "Trocar servidor". Após entrar: pedir permissão de notificações e registrar o dispositivo.
3. **Perfil:** lista quando há mais de um (`GET /api/v1/profiles`); administradores veem todos. Um perfil só → entra direto.

### Conversas (aba 1)
- Filtros em chips: **Fila** (`state=waiting`), **Minhas** (`state=human` filtrado por `owner == eu`), **IA** (`state=ai`), **Concluídas** (`state=closed`), **Todas**. Busca (`q`) por telefone/nome. Paginação por `next_cursor` (base64 opaco). Pull-to-refresh.
- Linha: avatar com inicial, nome (`contact_name` → `title` → `phone` → `external_id`), último horário (`updated`), chip de estado (Com a IA / Na fila / Com atendente / Concluído), ícone de grupo quando `chat_type == group`, etiquetas.
- Ligações tocando (`GET /calls?limit=30` com `status == ringing` e `actor` vazio ou igual a mim) aparecem como faixa no topo com Atender/Recusar.

### Conversa
- Cabeçalho: nome, telefone, estado e responsável (`GET /presence` para nomes). Menu: **Assumir** (`claim`), **Transferir** (`transfer` com `target` escolhido em `GET /presence`, mostrando presença), **Devolver à IA** (`resume`), **Concluir** (`resolve`), **Etiquetas** (`tags`), **Abrir protocolo**, **Consultar bot** (abre Bot com o contexto da conversa), **Ligar** (se `capabilities.calls`), **Salvar contato**. Grupo: seletor de `bot_policy` (`PUT /groups/{id}/policy`).
- Lista de mensagens (mais antigas em cima, rolagem até o fim ao abrir): bolhas cliente à esquerda, enviadas à direita, notas internas destacadas; autor nos grupos (`content.participant_name`); citação (`content.reply_to` / `reply_text`); reações (`content.reactions`); "Mensagem apagada" (`content.deleted`); "Editada"; recibo (`delivery_status`: Na fila / Enviada / Entregue / Lida / Ouvida / Falhou / Sem confirmação); localização (`content.location` → abrir no mapa); contatos (`content.contacts`). Anexos pela lista `media` do detalhe: imagem (miniatura → visualizador com zoom e compartilhar), vídeo (player), áudio/voz (player com progresso), documento (nome, tamanho, baixar/abrir/compartilhar). Entregas pendentes (`deliveries` não `sent`/`cancelled`) aparecem como linha de status.
- Ações por mensagem (toque longo), conforme `capabilities`: Responder (citação), Reagir (👍 ❤️ 😊 🙏 e remover), Editar (só enviadas, sem anexos, < 15 min), Apagar (confirmação), Marcar como lida (recebidas), Copiar texto.
- Composer (só quando assumida; senão mostra "Assuma a conversa para responder"): texto multilinha; **Anexar** (galeria foto/vídeo, câmera, arquivo); **Gravar áudio** (segurar ou tocar para iniciar/parar, até 2 min, prévia, descartar; Android `MediaRecorder` OGG/Opus em API 29+ e AAC/M4A como `audio` abaixo disso; iOS grava Opus em CAF via `AVAudioRecorder` e remuxa para OGG com `OggOpusMuxer`, caindo para M4A/AAC como `audio` se falhar); **Localização** (posição atual do aparelho com permissão, revisão antes de enviar, ou coordenadas manuais); **Contato** (picker do sistema ou nome/telefone manual); **Nota interna** (`note`). Tipo do conteúdo: automático pelo arquivo ou "Enviar como documento". Progresso de upload por arquivo. Pedido pendente guardado (mesma `Idempotency-Key`) com "Tentar novamente"/"Abandonar pedido".
- Falha de envio mantém o rascunho. `422 unsupported_capability` explica que o canal não oferece o recurso.

### Protocolos (aba 2)
- Filtros: **Abertos** (`status=open`), **Em andamento** (`status=in_progress`), **Atrasados** (`overdue=1`), **Concluídos** (`status=closed`), **Todos**. Linha: número `WA-…`, título, estado, prazo (`response_due_at`) com cores: vermelho atrasado, laranja vence em menos de 1 h, cinza sem prazo; "Respondido" quando `first_response_at`.
- Detalhe (`GET /tickets/{id}`): dados, conversa (abrir), responsável (nome via `GET /presence`), linha do tempo de `updates`. Ações (`PATCH /tickets/{id}`): **Registrar andamento** (`text`, vai ao cliente como "Protocolo WA-…: texto"), **Estado** (`open`/`in_progress`/`closed`), **Responsável** (`owner` da lista de presença), **Prazo** (`response_due_at`, só antes da primeira resposta; `null` remove). Erros do servidor exibidos (ex.: "Somente o responsável pode alterar o protocolo").
- **Abrir protocolo** a partir da conversa: título obrigatório (até 300), `POST /tickets`.

### Bots (aba 3)
- Lista de bots habilitados (`GET /bots`, `enabled == 1`) e histórico recente de execuções (`GET /bot-runs`, mais recentes primeiro, estado colorido).
- Chat com o bot: campo de entrada (até 60.000 caracteres) → `POST /api/v1/bot-runs {profile_id, bot_id, input}` (202) → consulta `GET /api/v1/bot-runs/{id}` a cada 2 s até `completed`/`failed`/`cancelled`/`unknown`. Mostra `result` como texto, `attachments` (IDs de mídia, abrir/baixar como na conversa) e `error`. Botão **Cancelar** (`POST /profiles/{p}/bot-runs/{id}/cancel`) enquanto roda. Quando aberto a partir de uma conversa, pré-preenche o contexto ("Cliente {telefone} perguntou: …") e oferece **Copiar resposta** para colar no composer.
- Devolver a conversa ao bot do perfil é a ação **Devolver à IA** da conversa (`resume`).

### Ligações (aba 4)
- Histórico (`GET /calls`): data, Recebida/Realizada, estado em português (Recebendo ligação, Chamando, Conectando áudio, Preparando áudio, Em ligação, Encerrada, Não atendida, Recusada, Falhou, Sem confirmação), duração. Ligações tocando no topo.
- Tela da ligação (`CallScreen`/`CallView`): 
  - **Receber:** `POST /calls/{id}/claim` (devolve `session` com a oferta SDP) → criar `RTCPeerConnection` só áudio → `setRemoteDescription(offer)` → `createAnswer` → aguardar ICE completo (até 12 s) → `pre_accept` e `accept` com a **mesma** `session`. Recusar = `claim` + `reject`.
  - **Ligar:** só com conversa assumida e `capabilities.calls`; **Verificar permissão** (`GET /conversations/{id}/call-permission`), **Pedir permissão** (`POST /calls/permission`), **Ligar** = criar oferta → ICE completo → `POST /calls {conversation_id, session}` → consultar `GET /calls/{id}?session=1` a cada 2,5 s e aplicar a `answer` quando chegar.
  - Durante a chamada: `POST /calls/{id}/keepalive` a cada 20 s; silenciar; viva-voz; cronômetro; **Encerrar** (`terminate`). Estado `unknown` → botão "Confirmar encerramento" (`reconcile` após confirmar no WhatsApp). Sair da tela encerra a chamada.
  - Android: `CallService` em primeiro plano (phoneCall|microphone) e `AudioManager` em modo comunicação; iOS: `CXProvider`/`CXCallController` para a chamada do sistema e `AVAudioSession` `.playAndRecord` `.voiceChat`. Vídeo nunca é oferecido.

### Mais (aba 5)
- **Disponibilidade:** interruptor Presente/Ausente (`PUT /presence {present}`), lista da equipe com presença.
- **Perfil:** trocar de perfil (quando há mais de um). **Notificações:** ligar/desligar (atualiza `enabled` do dispositivo), "Enviar teste" (`POST /devices/{id}/test`), permissão do sistema. **Dispositivo:** nome, versão, estado do registro de push. **Servidor:** endereço, versão (`GET /api/health`), abrir painel no navegador. **Sair:** `DELETE /devices/{id}` → `POST /logout` → limpar sessão (mantém o servidor).

## Textos e comportamento

- Idioma pt-BR, tom direto, sem jargão. Datas no fuso do aparelho em formato curto; "Hoje 14:32", "Ontem", "08/11".
- Erros da API (`error.message`) são exibidos como vêm; falhas de rede têm mensagens próprias. Nunca repetir automaticamente uma escrita sem a mesma `Idempotency-Key`.
- Nenhum segredo em logs. O token nunca aparece na interface.

## Compilar

Veja [`docs/MOBILE.md`](../docs/MOBILE.md#4-compilar-os-aplicativos). Resumo: Android `cd android && ./gradlew assembleDebug` (JDK 17, SDK 35; `google-services.json` opcional); iOS `cd ios && xcodegen generate && xcodebuild -scheme Wabotia -destination "generic/platform=iOS" build` (Xcode 16+, `GoogleService-Info.plist` opcional).
