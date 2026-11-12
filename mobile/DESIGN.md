# Wabotia móvel — desenho da interface (versão 0.13.0)

Este documento define a interface dos aplicativos Android e iOS a partir da 0.13.0. O contrato de dados, a idempotência e as regras de cada recurso continuam em [`README.md`](README.md); aqui fica **como a tela se parece e se comporta**. As duas plataformas seguem o mesmo desenho, com os controles nativos de cada uma.

Objetivo: o atendente abre o app e reconhece um mensageiro. Lista de conversas, bolhas, ticks, anexos e gravação de voz funcionam como no WhatsApp. O que é próprio do atendimento pela API (fila, assumir, transferir, protocolo, bot, janela de 24 horas, presença da equipe) aparece sempre no mesmo lugar, com cor e ícone próprios, a no máximo dois toques.

## 1. Identidade visual

Cores (claro / escuro). Defina como tokens do tema; nenhuma tela usa cor literal.

| Token | Claro | Escuro | Uso |
|---|---|---|---|
| `brand` | `#008069` | `#00A884` | títulos de marca, botões principais, aba ativa, links |
| `brandStrong` | `#075E54` | `#005C4B` | pressionado, cabeçalhos de destaque |
| `accent` | `#25D366` | `#25D366` | contador de não lidas, ponto Online, FAB |
| `background` | `#FFFFFF` | `#111B21` | listas e telas |
| `surface` | `#F7F8FA` | `#1F2C34` | cartões, barras, campos |
| `chatWallpaper` | `#EFEAE2` | `#0B141A` | fundo da conversa |
| `bubbleOut` | `#D9FDD3` | `#005C4B` | mensagem enviada |
| `bubbleIn` | `#FFFFFF` | `#202C33` | mensagem recebida |
| `bubbleNote` | `#FFF3C4` | `#3A3320` | nota interna |
| `bubbleSystem` | `#FFFFFF` a 90% | `#182229` | chip de evento e de data |
| `textPrimary` | `#111B21` | `#E9EDEF` | |
| `textSecondary` | `#667781` | `#8696A0` | prévia, horário, legendas |
| `divider` | `#E9EDEF` | `#222D34` | |
| `tickRead` | `#53BDEB` | `#53BDEB` | ticks de lida/ouvida |
| `ok` | `#1FA855` | `#25D366` | janela folgada, Online |
| `warn` | `#F59E0B` | `#FFB02E` | janela entre 1 h e 6 h, fila |
| `danger` | `#E53935` | `#F15C6D` | janela abaixo de 1 h, atrasado, falha |
| `muted` | `#8696A0` | `#8696A0` | janela fechada, Offline |
| `bot` | `#7C4DFF` | `#A78BFA` | tudo que é bot/IA |
| `ticket` | `#0277BD` | `#4FC3F7` | tudo que é protocolo |

Tipografia do sistema (Roboto / SF). Nome na lista 16–17 semibold; prévia 14; horário 12; bolha 16; legenda de bolha 11. Cantos: bolha 12 (com "rabinho" no canto da primeira bolha de cada grupo), cartões 16, folhas 24 no topo. Alvos de toque de 48dp / 44pt no mínimo. Suporte completo a modo escuro, fonte grande do sistema, VoiceOver/TalkBack (rótulo em todo botão de ícone). Telas pequenas (iPhone 7, 375×667 pt) não podem cortar conteúdo: nada de alturas fixas que somem atrás do teclado.

Avatar: círculo com iniciais (até 2 letras) e cor de fundo derivada do id (paleta fixa de 8 cores). Grupo usa ícone de pessoas; bot usa ícone de robô sobre `bot`. O avatar leva um **selo de estado** de 16–18 no canto inferior direito, com contorno da cor do fundo:

| Estado da conversa | Selo | Texto curto |
|---|---|---|
| `waiting` | ampulheta sobre `warn` | Na fila |
| `ai` | robô sobre `bot` | Com o bot / nome do bot |
| `human` minha | pessoa sobre `brand` | Com você |
| `human` de outro | pessoa sobre `muted` | Com {nome} |
| `closed` | check sobre `muted` | Concluída |

Pessoas e bots da equipe usam o mesmo avatar com **ponto de presença** (verde `ok` Online, cinza `muted` Offline).

## 2. Componente central: relógio da janela de 24 horas

A API do WhatsApp só aceita mensagem livre até 24 horas depois da última mensagem do cliente. O app mostra esse prazo o tempo todo.

- Cálculo: `expira = conversation.last_customer + 24 h` (milissegundos Unix). `restante = expira − agora`. Vale para conversa direta (`chat_type != "group"`) em linha oficial do WhatsApp (`connections[].kind` em `meta` ou `zernio`, lido de `GET /profiles/{p}/status`; se o tipo da linha não for conhecido, mostre o relógio). Grupos e linhas sem janela não mostram nada. `last_customer == 0` ou `restante <= 0` é janela fechada.
- Cor: `ok` acima de 6 h, `warn` de 1 h a 6 h, `danger` abaixo de 1 h, `muted` fechada.
- **Anel**: círculo de progresso que esvazia no sentido horário conforme o prazo corre (cheio = 24 h), com ícone de relógio no centro; fechado vira cadeado.
- Texto: `23h 14min`, `5h 02min`, `42 min`, `menos de 1 min`, `Janela fechada`. Forma compacta para a lista: `23h`, `5h`, `42m`, cadeado.
- Atualiza sozinho a cada 30 s (um único relógio por tela, não um timer por linha) e na hora quando chega mensagem do cliente (o anel volta a encher com animação).

Onde aparece:

1. **Lista de conversas**: anel de 22 com o texto compacto embaixo do horário, na coluna da direita de cada linha.
2. **Conversa**: faixa fixa logo abaixo da barra superior, altura 36: anel 20 + "Janela de 24h · 21h 14min restantes" e, à direita, "até 14:32" (ou "até amanhã 09:10"). Uma linha fina de progresso na base da faixa, na cor do estado. Abaixo de 1 h o fundo da faixa fica `danger` a 12% e o texto vira "Janela fecha em 42 min". Fechada: cadeado + "Janela fechada · só volta quando o cliente escrever". Toque na faixa abre uma folha curta explicando a regra em três linhas.
3. **Dados da conversa**: anel grande (96) com o tempo no centro e a hora da última mensagem do cliente.
4. **Composer com janela fechada**: aviso acima do campo, "Fora da janela de 24h. A mensagem fica na fila até o cliente escrever." O envio continua permitido (o servidor guarda e entrega quando a janela reabrir); nota interna, protocolo e transferência seguem normais.

## 3. Navegação

Barra inferior com cinco abas, ícone + rótulo, contador em bolinha `accent`:

| Aba | Ícone | Contador |
|---|---|---|
| **Conversas** | balão | não lidas (soma local) |
| **Protocolos** | etiqueta/recibo | atrasados (em `danger`) ou abertos |
| **Equipe** | pessoas | conversas internas não lidas |
| **Ligações** | telefone | ligações tocando |
| **Ajustes** | engrenagem | — |

Android: `NavigationBar` Material 3 com indicador em pílula. iOS: `TabView`. No iPad/tablet a lista e o detalhe ficam lado a lado quando houver largura (≥ 840dp / regular), sem obrigação nesta versão.

Fluxo inicial sem mudança de regra: Servidor → Login → Perfil. Essas três telas ganham o mesmo estilo: marca no topo (o símbolo do ícone do app, não o desenho de servidor), um cartão com o campo, botão principal `brand` em largura total, textos de ajuda curtos.

## 4. Conversas (aba 1)

**Barra superior.** Título "Wabotia" em `brand` com o nome do perfil como subtítulo pequeno (toque troca de perfil quando houver mais de um). À direita: **pílula de presença** e lupa.

- Pílula de presença: `● Online` (fundo `ok` a 15%, texto `ok`) ou `○ Offline` (cinza). Toque abre uma folha com dois botões grandes, "Ficar online" e "Ficar offline", uma linha explicando o efeito ("Offline: novos atendimentos não são encaminhados a você") e quantas pessoas da equipe estão online. Confirma com `PUT /presence {present}` e mostra retorno ("Você está online"). O estado vem de `GET /presence` (entrada com `actor == eu`) e é relido ao voltar ao primeiro plano.

**Filtros.** Linha rolável de chips com contador: `Todas`, `Fila 3`, `Minhas 2`, `Bots 7`, `Concluídas`. Contadores de `GET /status` (`conversations` por estado); "Minhas" é contado nas conversas carregadas. O chip `Fila` fica `warn` quando há fila. Busca abre campo no lugar do título.

**Linha da conversa** (altura ~76):

```
[avatar+selo]  Nome do contato                      14:32
               ✓✓ Prévia da última mensagem…        (anel) 21h
               [Financeiro] [VIP]  · Com você         (3)
```

- Linha 1: nome em semibold; horário à direita (em `accent` quando há não lidas).
- Linha 2: prévia em `textSecondary`, uma linha. Enviada por nós leva o tick de entrega; anexo vira ícone + tipo ("📷 Foto", "🎤 Áudio 0:12", "📄 Documento", "📍 Localização"); nota interna fica em itálico com cadeado. Sem prévia conhecida, mostra o texto do estado ("Aguardando atendente", "Em atendimento com o bot Vendas").
- Linha 3 (só se houver conteúdo): até duas etiquetas em pílulas e o responsável ("Com você", "Com Ana", "Bot Vendas", "Setor Financeiro").
- Coluna direita: horário, anel da janela, contador de não lidas em bolinha `accent`.
- Na fila há mais de 5 minutos, o horário vira "espera 12 min" em `warn`.

Prévia e não lidas não vêm da lista do servidor. O app mantém um cache local por perfil (`conversa → {texto, tipo, direção, horário, status}` e `conversa → não lidas`), alimentado por: eventos `message.received` (soma não lida quando a conversa não está aberta) e `message.sent`; o detalhe de cada conversa aberta; e um preenchimento em segundo plano das 15 primeiras conversas sem prévia (duas chamadas de detalhe por vez). Abrir a conversa zera as não lidas.

**Gestos e atalhos.**
- Toque abre a conversa. Toque longo abre a folha de ações rápidas (Assumir, Transferir, Etiquetas, Concluir, Abrir protocolo), só com o que o estado permite.
- Deslizar para a direita: **Assumir** (fundo `brand`). Deslizar para a esquerda: **Concluir** (fundo `muted`), só nas minhas. Concluir pede confirmação em diálogo.
- Puxar atualiza. Rolagem infinita por `next_cursor`.
- Ligação tocando: cartão fixo no topo com avatar pulsando, "Ligação de {nome}", botões redondos Recusar (vermelho) e Atender (verde).

**Vazio.** Ilustração simples (ícone grande em círculo `surface`), título e uma linha: "Nenhuma conversa na fila. Bom trabalho!".

## 5. Conversa

**Barra superior** (estilo WhatsApp): voltar, avatar com selo, nome e subtítulo com o estado ("Com você", "Na fila há 4 min", "Com o bot Vendas", "Com Ana · Online"). Toque no nome abre **Dados da conversa**. Ações: telefone (se `capabilities.calls`), **Transferir** (ícone de encaminhar, sempre visível) e menu ⋮ (Etiquetas, Abrir protocolo, Enviar menu, Devolver ao bot, Pesquisa de satisfação, Consultar bot, Salvar contato, Concluir).

**Faixa da janela** (seção 2) logo abaixo.

**Mensagens.** Fundo `chatWallpaper`. Bolhas com largura máxima de 80%, agrupadas por autor, rabinho na primeira do grupo, horário e ticks dentro da bolha no canto inferior direito.

- Ticks: relógio (na fila), ✓ cinza (enviada), ✓✓ cinza (entregue), ✓✓ `tickRead` (lida/ouvida), ! `danger` (falhou; toque mostra o erro e "Tentar de novo").
- Chip de data centralizado ("Hoje", "Ontem", "12 de novembro"), fixo no topo ao rolar se for simples de fazer.
- Eventos do atendimento (assumida, transferida, concluída, menu enviado, protocolo aberto) viram chip central `bubbleSystem` com ícone.
- Nota interna: bolha `bubbleNote` alinhada à direita com cadeado e "Nota interna · {autor}".
- Mensagem de bot/IA: bolha de saída com etiqueta pequena "🤖 {nome do bot}" em `bot`. Atendente humano: etiqueta com o nome quando não fui eu.
- Grupo: nome do participante colorido no topo da bolha recebida.
- Citação: bloco com barra lateral `brand` dentro da bolha; toque rola até a original.
- Reações: pílula sobreposta na base da bolha.
- Mídia: imagem/vídeo com cantos da bolha, legenda embaixo, vídeo com botão de play e duração; áudio com play, onda/barra de progresso, duração e velocidade; documento com ícone por tipo, nome, tamanho e baixar; localização com cartão de mapa; contato com avatar e "Salvar".
- Toque longo: barra de reações (👍 ❤️ 😂 😮 😢 🙏) acima e menu (Responder, Copiar, Editar, Apagar, Marcar como lida), só o que `capabilities` permitir. Deslizar a bolha para a direita = Responder.
- Botão flutuante "ir para o fim" com contador de mensagens novas quando a pessoa rolou para cima.

**Rodapé conforme o estado.**

| Situação | Rodapé |
|---|---|
| Minha (`owner == eu`, `human`) | Composer |
| Na fila | Cartão: "Na fila há 4 min" + botão grande **Assumir conversa** |
| Com bot/IA | Cartão: "O bot {nome} está atendendo" + **Assumir conversa** |
| Com outra pessoa | Cartão: "Em atendimento com {nome}" (+ **Transferir para mim** se administrador) |
| Concluída | Cartão: "Conversa concluída" + **Reabrir e assumir** |

Assumir é um toque, sem diálogo; mostra progresso no botão e troca o rodapé pelo composer com animação.

**Composer.** Campo arredondado multilinha "Mensagem"; à esquerda **+** (anexos); dentro do campo, à direita, câmera; fora, botão redondo `brand` que é **microfone** com o campo vazio e **enviar** com texto. Gravação: tocar inicia, mostra cronômetro vermelho e onda, lixeira para descartar e enviar; prévia antes de enviar continua disponível. Resposta citada e edição aparecem como faixa acima do campo com X.

Folha **+** em grade de ícones redondos coloridos: Galeria, Câmera, Documento, Áudio, Localização, Contato, **Menu**, **Protocolo**, **Nota interna**. Itens sem capacidade na linha não aparecem.

## 6. Transferir (folha "Encaminhar atendimento")

Um só lugar para tirar a conversa de mim. Folha alta com abas no topo; cada aba é uma lista com busca quando passar de 8 itens. Disponível para o dono da conversa e para administradores.

| Aba | Conteúdo | Chamada |
|---|---|---|
| **Pessoas** | `GET /team` (`kind == "user"`, menos eu). Online primeiro, ponto de presença, "Online"/"Offline". | `actions {action:"transfer", target:<id>}` |
| **Bots** | `GET /team` (`kind == "bot"`, habilitados e autorizados para a linha: `line_ids == null` ou contém `connection_id`). Ponto de presença. Primeiro item fixo: "Bot do atendimento automático" (devolve à IA do perfil). | `transfer` com `target:"bot:<id>"`; item fixo = `action:"resume"` |
| **Setores** | `settings.departments` de `GET /status` (habilitados): nome, nº de membros e quantos online. | `transfer` com `department_id` (sem `target`) |
| **Menu** | `GET /menus?connection_id=`: "Menu principal" e cada submenu (`type == "submenu"`). Envia o menu ao cliente; a conversa segue comigo até ele escolher. | `action:"menu"`, `menu_id` ou `null` |
| **Protocolo** | "Abrir protocolo" (título), "Enviar consulta de protocolos ao cliente" e a lista de protocolos desta conversa. | `POST /tickets`; `action:"protocols"` |

Cada item pede uma confirmação curta na própria folha ("Transferir para Ana?" + **Transferir**). Pessoa offline mostra aviso "Ana está offline e pode demorar a responder" sem bloquear. Depois: folha fecha, chip de evento na conversa, rodapé muda de estado. Erros do servidor aparecem na folha, sem fechá-la. Abas sem itens mostram por que estão vazias ("Nenhum setor configurado no painel").

## 7. Dados da conversa

Tela aberta pelo nome: avatar grande, nome, telefone (copiar), linha de atendimento; **anel grande da janela**; estado e responsável; etiquetas (editar em pílulas); **Protocolos desta conversa** (cartões com número, título, estado; "Abrir protocolo"); mídia compartilhada em grade; ações (Ligar, Salvar/editar contato, Consultar bot, Pesquisa de satisfação, Devolver ao bot, Concluir em `danger`). Grupo: política do bot.

Protocolos de uma conversa: `GET /tickets?q=<telefone só dígitos>` filtrado no app por `conversation_id`.

## 8. Protocolos (aba 2)

Chips com contador: `Abertos`, `Em andamento`, `Atrasados` (em `danger`), `Concluídos`, `Todos`. Busca por número ou telefone (`q`).

Cartão: número `WA-…` em `ticket` monoespaçado, título em duas linhas, pílula de estado, avatar do responsável e **prazo** com o mesmo anel do relógio (vermelho atrasado "atrasado há 2h", laranja abaixo de 1 h, "Respondido" com check quando `first_response_at`). Toque abre o detalhe.

Detalhe: cabeçalho com número, estado (seletor em pílulas Aberto / Em andamento / Concluído), responsável, prazo; botão "Abrir conversa"; **linha do tempo** vertical dos andamentos (ponto + linha, autor, horário, interno com cadeado); campo fixo embaixo "Registrar andamento" com enviar. Todas as regras atuais permanecem (prazo só antes da primeira resposta, erros do servidor exibidos).

## 9. Equipe (aba 3)

Topo: **cartão de presença** grande: meu avatar, "Você está online/offline" e interruptor; abaixo, resumo "4 pessoas online · 2 bots ativos".

Seletor segmentado: **Conversas** (internas recentes, com prévia e não lidas) · **Pessoas** · **Bots** · **Setores**.

- Pessoas: avatar com ponto, nome, "Online"/"Offline", quantas conversas a pessoa tem em atendimento quando conhecido. Toque abre o chat interno (bolhas iguais às da conversa, sem janela nem ticks de WhatsApp).
- Bots: avatar de robô com ponto, nome, "Disponível"/"Indisponível", linhas autorizadas ("Todas as linhas", "2 linhas", "Só conversa interna"). Toque abre o chat com o bot; execuções recentes continuam acessíveis.
- Setores: nome, membros com mini-avatares sobrepostos, "2 de 5 online".

Atualiza a cada 20 s enquanto visível e ao puxar.

## 10. Ligações (aba 4) e Ajustes (aba 5)

Ligações: histórico no estilo do WhatsApp (avatar, nome, seta de entrada/saída colorida — vermelha para perdida —, data, duração, botão de ligar de volta quando permitido). Tela da ligação em tela cheia: fundo `brandStrong` em degradê, avatar grande, estado, cronômetro, botões redondos (mudo, viva-voz, encerrar vermelho). Nenhuma regra de sinalização muda.

Ajustes: cartão do usuário (avatar, nome, papel, perfil atual, presença); grupos em cartões: **Atendimento** (Linhas de atendimento, Menus e submenus, Linhas dos bots), **Notificações** (ligar/desligar, enviar teste, estado do registro), **Aparência** (Sistema / Claro / Escuro), **Servidor** (endereço, versão, abrir painel, trocar perfil), **Sair**. Tudo que existe hoje em "Mais" continua aqui.

## 11. Retorno e estados

- Toda ação dá retorno em até 100 ms (estado de carregando no próprio botão) e termina em snackbar/toast curto ou erro legível com "Tentar de novo".
- Esqueleto (linhas cinza pulsando) no primeiro carregamento de listas; nunca tela em branco.
- Sem rede: faixa fina "Sem conexão · tentando reconectar" no topo; o conteúdo em cache continua visível.
- Vibração leve em: assumir, enviar, início/fim de gravação, transferência concluída.
- Animações curtas (150–250 ms) e respeitando "reduzir movimento".

## 12. O que não muda

Camadas de sessão, rede, idempotência, upload, mídia autenticada, push, eventos, WebRTC/CallKit e as regras de cada recurso descritas no README. Nenhuma função existente pode sumir na troca de interface. Textos em pt-BR, diretos, sem jargão.
