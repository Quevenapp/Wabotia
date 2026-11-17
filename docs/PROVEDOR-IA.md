# Bot por provedor de IA, sem Hermes

Uma conexão **Provedor de IA** liga o Wabotia direto à API da Anthropic, da OpenAI, da DeepSeek ou de outro serviço compatível com a OpenAI. Não há VPS, Docker, Hermes nem plugin: basta a instalação do Wabotia na Cloudflare e uma chave de API. O Hermes continua disponível e as conexões Hermes existentes não mudam.

## O que faz e o que não faz

O bot de provedor de IA atende o cliente no WhatsApp e conversa com a equipe.
- **No atendimento ao cliente:**
  - A cada mensagem, o Wabotia envia ao modelo as instruções da área, as 12 últimas mensagens, as fontes do Conhecimento, os menus e as categorias de protocolo.
  - Recebe de volta a decisão do Atendente: responder, perguntar, mostrar menu, consultar ou abrir protocolo, ou transferir. As regras são as mesmas do Atendente no Hermes, inclusive o JEV.
  - Usa as **ferramentas da conversa** que os módulos ligados declaram, como a situação da OS ou os horários da Agenda.
  - Só alcança os dados desse cliente. O que muda algo vira um botão que o próprio cliente confirma.
- **Na equipe:** é o bot da seção abaixo.

| | Hermes | Provedor de IA |
| --- | --- | --- |
| Servidor próprio | VPS ou computador com o Hermes | nenhum |
| Instalação | plugin ou túnel | chave de API no painel |
| Custo | servidor + modelo | só o uso do modelo, cobrado pelo provedor |
| Atendente, transferência | sim | sim |
| Conversa com a equipe (Equipe › Bots) | sim | sim, consultando o Wabotia e propondo ações em nome de quem pede |
| Especialista | sim, com as ferramentas do Hermes | sim, só consultando os dados do cliente da conversa |
| Item de menu do tipo bot | executa a opção com ferramentas | assume a conversa a partir da opção |
| Ferramentas | as do Hermes e de outros sistemas | as dos módulos do Wabotia: na conversa do cliente, as declaradas para o cliente; na equipe, o catálogo de operações com o acesso da pessoa |
| Arquivos gerados pelo bot | sim | não |
| Áudio | transcrito pelo Hermes | aviso pedindo texto, ou equipe |
| Imagens | conforme o modelo | Anthropic e OpenAI sim; DeepSeek não; compatível conforme a opção |

Quem precisa que o bot consulte sistemas de fora do Wabotia (o banco, outro ERP) continua usando o Hermes como especialista. Um Atendente de provedor de IA pode consultar especialistas do Hermes ou de outro provedor de IA.

## O bot para a equipe

Cada bot também conversa com as pessoas da equipe. Em **Equipe › Bots**, toque no bot para abrir a conversa interna.
- **Ligar:** o bot nasce desligado, para não começar a responder sem alguém decidir. Um administrador liga pelo botão **Ligar** ali mesmo, ou em Gestão › Atendente e especialistas. Quem não é administrador vê o bot como "Desligado".
- **O que ele faz:** consulta o Wabotia e propõe ações **em nome de quem pede, com o acesso dessa pessoa**. Ele busca a operação, lê e prepara um cartão com **Confirmar** e **Cancelar**. Nada muda antes de a pessoa tocar em Confirmar; operação financeira pede o segundo fator. Os dados pessoais vão mascarados ao modelo, salvo o administrador liberar em Sistema › Bot e dados pessoais.
- **Ferramentas:** dependem de o provedor aceitá-las. Anthropic, OpenAI e DeepSeek aceitam. Uma API compatível que recusa ferramentas (HTTP 400) é tratada assim:
  - o bot responde sem elas;
  - **avisa a pessoa** junto da resposta;
  - a conexão fica marcada **"O provedor recusou as ferramentas"** em Atendente e especialistas, e o bot aparece como "Só conversa" na Equipe. A marca some quando o administrador salva a conexão de novo (por exemplo, trocando o modelo).
- **Onde está cada coisa:**
  - Gestão › Atendente e especialistas tem o "Comece aqui", com os três passos: conectar, ligar e conversar;
  - Equipe › Bots › Execuções recentes mostra o que cada bot fez.

## Especialista de provedor de IA

O Atendente pode encaminhar um pedido interno a outro bot de provedor de IA, como faz com o Hermes. Cada um pode ter o seu modelo, por exemplo um bot "Agenda" com instruções próprias.
- O especialista de IA **só consulta**: recebe as ferramentas de leitura dos módulos ligados, presas à conversa do cliente.
- Não muda nada e não fala com o cliente: devolve o resultado ao Atendente, que responde.

## Conectar

1. Crie a chave de API no site do provedor e deixe saldo ou cobrança ativos.
2. No painel: **Hermes e canais → Nova conexão → Serviço: Provedor de IA (sem servidor)**.
3. Escolha o provedor e cole a chave. Na **Outra API compatível com OpenAI** (OpenRouter, Groq e semelhantes), informe também a URL da API, à qual o Wabotia acrescenta `/chat/completions`, e se o modelo entende imagens.
4. Escolha o modelo. **Buscar modelos da conta** pergunta ao provedor, com a chave digitada (ou, na edição, a já cadastrada), quais modelos a conta tem, e passa a sugeri-los no campo. A chave usada na busca não é guardada.
   - **Anthropic**: Claude Opus 5.5 (padrão, mais capaz), Claude Sonnet 5.5 ou Claude Haiku 5.5 (mais barato). A busca mostra só os que a conta enxerga.
   - **OpenAI**: a lista deixa de fora modelos de imagem, voz e embeddings. Ainda é possível digitar qualquer nome.
   - **DeepSeek** e APIs compatíveis: a lista vem como o provedor publica; sem lista, digite o nome (na DeepSeek, por exemplo, `deepseek-flash` ou `deepseek-v4-pro`).
5. Escolha o **Esforço de raciocínio**: quanto o modelo pensa antes de responder. Mais esforço deixa a resposta mais cuidadosa, mais lenta e mais cara.
   - **Anthropic**: Baixo (padrão, recomendado para conversa), Médio, Alto, Muito alto ou Máximo.
   - **OpenAI**: Padrão do modelo (o campo não é enviado), Sem raciocínio, Mínimo, Baixo, Médio, Alto ou Muito alto. Cada modelo aceita só alguns níveis; com um nível que o modelo não aceita, o **Testar conexão** acusa o erro.
   - **APIs compatíveis**: os mesmos da OpenAI e mais Máximo, repassados como estão.
   - **DeepSeek**: Sem raciocínio (mais rápido e barato), Baixo (padrão), Alto ou Máximo; a API da DeepSeek não tem Médio nem Muito alto. Sem escolha, a DeepSeek raciocinaria em Alto: conexões salvas antes da 0.18.0 passam a Baixo ao serem editadas e salvas.
   - Prazo de cada resposta: 60 segundos até Médio, 90 em Alto e 3 minutos em Muito alto e Máximo. As respostas de uma área saem em série, então nesses níveis as outras conversas esperam mais.
6. Deixe marcada **Apenas mensagens (não receber áudio e vídeo)**, ou desmarque (veja abaixo).
7. Salve e clique **Testar conexão**. O teste confere chave, modelo e endereço e cria o bot, desabilitado, com o nome da conexão. Na OpenAI e na DeepSeek, o modelo precisa estar na lista da conta; no formato OpenAI, o teste ainda faz uma chamada curta, que também valida o esforço. Uma conexão tem um único bot; para usar dois modelos, crie duas conexões.
8. **Ativar** a conexão. Em **Atendente e especialistas**, habilite o bot e escolha **Usar como Bot Atendente**, ou defina-o como bot de uma linha.

A chave fica cifrada no cofre da instalação e nunca é devolvida ao painel. Para trocá-la, pause a conexão, edite e preencha **Nova chave de API**; vazio mantém a atual. Editar exige testar de novo antes de reativar. O provedor não pode ser trocado: crie outra conexão.

Para remover a conexão, pause-a e use **Excluir conexão** no cartão. O bot dela deixa de existir e a chave é apagada; conversas, mensagens e execuções anteriores continuam no histórico, e a conta no provedor não é alterada. A exclusão é recusada enquanto o bot for o Atendente, o bot de uma linha ou estiver atendendo uma conversa: troque-o antes. O mesmo vale para conexões Hermes.

## Áudio, vídeo e imagens

- **Apenas mensagens ligada (padrão):** quem manda áudio ou vídeo recebe "No momento este atendimento recebe apenas mensagens de texto. Por favor, escreva sua mensagem." A conversa continua com o bot e a equipe não é chamada. Vários áudios seguidos geram um único aviso; um novo aviso só sai depois de outra mensagem enviada.
- **Desligada:** áudio e vídeo vão para a equipe humana, como qualquer anexo que o bot não entende.
- **Imagens** (até 2 por mensagem, até 5 MB cada) vão ao modelo quando ele as entende; caso contrário, a conversa vai para a equipe.
- **Documentos** vão para a equipe, como antes.

## Falhas

- Provedor fora do ar, limite de uso ou demora (HTTP 408, 409, 429, 5xx ou mais de 60 segundos): o Wabotia tenta de novo a cada ciclo, com intervalo mínimo de 10 segundos, por até 3 minutos desde a mensagem. Depois, transfere para a equipe.
- Chave recusada, sem saldo, modelo inexistente, recusa do modelo ou resposta cortada: transfere na hora. O motivo aparece em **Execuções de bots**.
- Uma pessoa que assume a conversa durante a chamada cancela a resposta do bot.

As respostas de uma área de atendimento são processadas em série. Com muitos clientes ao mesmo tempo, a espera cresce na proporção do tempo de resposta do modelo; Claude Haiku 5.5 e modelos menores respondem mais rápido.

## Detalhes técnicos

- Conexão `kind: "ai"`; configuração `provider`, `model`, `base_url`, `vision`, `effort`, `text_only`; segredo `api_key` ([API](../src/openapi.ts)).
- Modelos da conta: `POST /api/v1/profiles/{perfil}/ai-models` (administrador, 10 por minuto), com `{provider, base_url?, api_key?, connection_id?}`; responde `{data:[ids]}`. Fica fora dos comandos idempotentes para a chave não ir aos recibos.
- Chamadas em [src/ai-provider.ts](../src/ai-provider.ts): formato OpenAI (`/chat/completions`, modo JSON na OpenAI e na DeepSeek, `reasoning_effort` quando escolhido) e SDK oficial da Anthropic (`@anthropic-ai/sdk`) com saída estruturada no formato do Atendente e `output_config.effort` (padrão `low`).
- Execução em [src/engine.ts](../src/engine.ts) (`aiRun`): a resposta chega na mesma passada, sem consulta posterior. Sem efeito colateral no provedor, uma chamada interrompida é simplesmente repetida; o envio ao cliente não duplica, porque a mensagem é identificada pela execução.
- Sem migração de banco, sem Durable Object novo, sem binding ou secret novo: chega pela atualização normal do painel.
- Ferramentas: modo equipe e modo cliente em [src/bot-actions](../src/bot-actions); o especialista recebe só as ferramentas de cliente sem escrita (`write` falso e `customer` diferente de `"propose"`). Provedor que recusa ferramentas: `tools_unsupported_at` na configuração da conexão, limpo ao salvar.
- Testes: `tests/ai-provider.test.ts`, `tests/bot-actions-ai.test.ts`.
