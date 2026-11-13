# Wabotia web — desenho da interface (versão 0.14.0)

O painel web passa a ter a mesma cara e os mesmos recursos de atendimento dos aplicativos. A referência visual e de comportamento é [`mobile/DESIGN.md`](../mobile/DESIGN.md): cores, avatar com selo, relógio da janela de 24 horas, ticks, rodapé por estado, folha de transferência, presença. Este documento diz **como isso se organiza em uma tela de computador** e o que a web tem a mais. Regras de dados e de cada recurso continuam em `docs/API.md`, `docs/ATENDIMENTO-EQUIPE.md`, `docs/MENUS-PROTOCOLOS.md` e `docs/CENTRAL-ATENDIMENTO.md`.

Princípio: quem atende abre a web e reconhece o WhatsApp Web. Quem administra encontra tudo o que já existia, com a mesma linguagem visual. Nenhuma função atual do painel pode sumir.

## 1. Identidade

- Use exatamente os tokens da seção 1 do desenho móvel (claro e escuro) como variáveis CSS em `:root` e `[data-theme="dark"]`. Nenhuma tela usa cor literal fora do arquivo de tokens.
- Tema: Sistema / Claro / Escuro, guardado em `localStorage`, aplicado antes da primeira pintura (sem piscar).
- Tipografia do sistema (`system-ui`, Segoe UI, Roboto). Corpo 14–15 px no painel, 15–16 px nas bolhas. Cantos: bolha 12, cartão 16, diálogo 20.
- Mesmos componentes: avatar com iniciais e cor derivada do id; selo de estado; ponto de presença; anel da janela; pílulas; chips com contador; cartões; esqueletos de carregamento; estados vazios com ícone, título e uma linha.
- Ícones `lucide-react` (já usados). Foco visível em todo controle; tudo operável por teclado; `aria-label` em botões só de ícone; contraste AA nos dois temas; respeitar `prefers-reduced-motion`.

## 2. Estrutura da tela

```
┌────┬──────────────┬───────────────────────────────┬───────────┐
│    │              │  cabeçalho da conversa        │           │
│ t  │  lista       ├───────────────────────────────┤  dados    │
│ r  │  (conversas, │  faixa da janela de 24h       │  (painel  │
│ i  │  protocolos, ├───────────────────────────────┤  lateral, │
│ l  │  equipe…)    │  mensagens                    │  abre e   │
│ h  │              │                               │  fecha)   │
│ o  │              ├───────────────────────────────┤           │
│    │              │  rodapé: composer ou Assumir  │           │
└────┴──────────────┴───────────────────────────────┴───────────┘
```

- **Trilho** à esquerda (72 px, ícone + rótulo curto): Conversas, Protocolos, Equipe, Ligações, Contatos e **Gestão**. Embaixo: tema, ajuda e o avatar do usuário (menu com perfil de atendimento, presença, sair). Contadores iguais aos das abas do app.
- **Gestão** abre a navegação de administração em uma coluna própria, com os grupos atuais (Início, Automação, WhatsApp e canais, Avaliações e relatórios, Integrações, Sistema, Pessoas e acessos, Configuração guiada) e a mesma regra de quem pode ver o quê (`workspace-navigation.ts`). As páginas de gestão ocupam a área à direita em largura confortável (até ~1100 px), com cabeçalho de página, cartões e tabelas no novo estilo. O modo guiado/avançado continua existindo.
- **Barra do topo da lista**: título da área, nome do perfil (troca de perfil), **pílula de presença** e busca.
- Larguras: lista 360–400 px; painel de dados 340 px; o meio ocupa o resto. Abaixo de 1100 px o painel de dados vira sobreposto. Abaixo de 760 px a web se comporta como o app: uma coluna por vez, com barra de abas embaixo (Conversas, Protocolos, Equipe, Ligações, Mais).
- Cada conversa, protocolo e página tem endereço próprio (rota ou hash) para abrir em nova aba, voltar com o navegador e compartilhar o link com um colega.

## 3. Conversas

Lista igual à do app (seção 4 do desenho móvel): chips com contador (Todas, Fila, Minhas, Bots, Concluídas), linha com avatar e selo, nome, horário, prévia com tick, etiquetas, responsável, **anel da janela** e contador de não lidas. A prévia vem de `last_message` da API; não lidas ficam em `localStorage` por perfil, alimentadas pelos eventos.

A mais na web:
- Passar o mouse mostra ações rápidas na linha (Assumir, Transferir, Concluir). Clique direito abre o mesmo menu.
- A conversa selecionada fica destacada; setas ↑/↓ percorrem a lista; `Ctrl+K` ou `/` foca a busca; `Esc` limpa.
- Sem conversa selecionada, o meio mostra um estado vazio com a marca e os atalhos de teclado.
- Ligação tocando: cartão fixo no topo da lista com Atender/Recusar (quando o navegador e a linha permitirem áudio; senão, só aviso).

## 4. Conversa

Tudo da seção 5 do desenho móvel: cabeçalho com avatar, nome e estado; ações Ligar, **Transferir**, menu ⋮; **faixa da janela de 24h** com progresso; bolhas com rabinho, ticks, chips de data e de evento, nota interna amarela, etiqueta de bot, citação, reações, mídia; rodapé conforme o estado (**Assumir conversa**, Reabrir e assumir, composer).

A mais na web:
- **Composer**: `Enter` envia, `Shift+Enter` quebra linha; colar imagem ou arquivo anexa; arrastar arquivos para a conversa mostra área de soltar; pré-visualização dos anexos antes de enviar com progresso por arquivo; gravação de voz pelo microfone do navegador (OGG/Opus quando suportado); emoji pelo teclado do sistema e um seletor curto.
- Passar o mouse na bolha mostra o botão de reações e a seta de ações (Responder, Copiar, Editar, Apagar, Marcar como lida), conforme `capabilities`.
- Imagem abre em visualizador sobre a página (zoom, baixar, próxima/anterior); vídeo e áudio tocam no lugar; documento baixa ou abre em nova aba; localização abre no mapa.
- Painel **Dados da conversa** à direita (botão no cabeçalho ou clique no nome): telefone com copiar, linha, anel grande da janela, estado e responsável, etiquetas, **protocolos desta conversa**, mídia compartilhada, ações (Salvar contato, Consultar bot, Pesquisa de satisfação, Devolver ao bot, Concluir). Grupo: política do bot e os controles atuais de grupo.
- Botão "ir para o fim" com contador quando a pessoa rolou para cima; mensagens novas não roubam a rolagem.

## 5. Transferir

Diálogo "Encaminhar atendimento" com as cinco abas do app (Pessoas, Bots, Setores, Menu, Protocolo), busca, presença, confirmação dentro do diálogo, aviso de pessoa offline e erro do servidor sem fechar. Atalho: `Ctrl+Shift+T` com uma conversa aberta.

## 6. Protocolos

Duas colunas: lista de cartões à esquerda (número, título, pílula de estado, categoria, responsável, prazo com anel) e detalhe à direita (cabeçalho com estado em pílulas selecionáveis, categoria, responsável, prazo, "Abrir conversa", linha do tempo e campo "Registrar andamento" fixo embaixo).

- Estados e textos conforme `docs/CENTRAL-ATENDIMENTO.md` (seis estados; Recebido, Em análise, Aguardando cliente, Aguardando terceiro, Resolvido, Encerrado). Cores: Recebido `ticket`; Em análise `warn`; Aguardando cliente e Aguardando terceiro `bot`; Resolvido `ok`; Encerrado `muted`.
- Chips: Ativos, Recebidos, Em análise, Aguardando, Atrasados (em `danger`), Resolvidos, Todos. Filtro por categoria e por responsável ("Meus"). Busca por número ou telefone.
- Novo protocolo: título, categoria, conversa.

## 7. Equipe e Ligações

- **Equipe**: cartão de presença com interruptor; segmentos Conversas internas, Pessoas, Bots, Setores; chat interno em duas colunas com as mesmas bolhas; console do bot e execuções recentes acessíveis no segmento Bots. A página "Disponibilidade" atual é absorvida aqui.
- **Ligações**: histórico no estilo do app; tela de ligação em sobreposição com os controles atuais (`WhatsAppCalls.tsx`), sem mudar a sinalização.

## 8. Gestão

Mesmas páginas e regras de hoje, com o novo estilo e estes acréscimos:

- **Modelos de atendimento** (nova, em Automação): cartão de cada modelo de `GET /service-templates`, pré-visualização da árvore de menus, setores, categorias e prazo, escolha de modo (Acrescentar ao que existe / Substituir configuração) e do bot atendente; aplicar pede confirmação e mostra o resumo devolvido pela API, com atalhos para os próximos passos (adicionar pessoas aos setores, revisar textos, cadastrar conhecimento, conectar o WhatsApp).
- **Regras de atendimento**: bloco "Protocolos" com unidade do prazo (horas ou dias úteis), dias e horário de atendimento, feriados, categorias (lista editável) e a mensagem de confirmação com os marcadores e uma prévia calculada ("aberto agora, venceria em …").
- **Menus e ações**: novo destino "Abrir protocolo" (categoria e pergunta opcionais), com o mesmo editor e o arrastar atual.
- **Início**: resumo do atendimento em cartões (fila, minhas, com bot, protocolos atrasados, pessoas online) com atalhos; o assistente de configuração continua acessível.
- Tabelas com cabeçalho fixo, linhas de 44 px, ações à direita; formulários em cartões com rótulo acima do campo, ajuda curta abaixo e botão principal `brand`; diálogos com título, corpo rolável e ações no rodapé.

## 9. Entrada

Página pública, instalação, documentação da API e login no mesmo estilo: marca do app, cartão central, botão `brand` em largura total, modo escuro.

## 10. Retorno, avisos e estados

- Toda ação mostra progresso no próprio botão e termina em aviso curto (toast) ou erro legível com "Tentar de novo".
- Sem rede: faixa fina no topo; o conteúdo carregado continua visível.
- **Notificações do navegador** (opcionais, pedidas pelo usuário em Ajustes): mensagem nova em conversa minha, conversa nova na fila, protocolo atribuído ou perto do prazo; título da aba com contador de não lidas; som curto opcional. Só com a aba em segundo plano.
- Atualização por eventos (`GET /events`) com um único leitor por aba, pausado quando a aba está oculta há muito tempo e retomado ao voltar.

## 11. O que não muda

Rotas da API, permissões, idempotência, regras de menus, roteador, Zernio, instalação, atualização e pareamento. A troca é de interface: cada tela atual precisa continuar fazendo o que fazia.
