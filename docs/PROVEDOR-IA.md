# Bot por provedor de IA, sem Hermes

Uma conexão **Provedor de IA** liga o Vinki direto à API da Anthropic, da OpenAI, da DeepSeek ou de outro serviço compatível com a OpenAI. Não há VPS, Docker, Hermes nem plugin: basta a instalação do Vinki na Cloudflare e uma chave de API. O Hermes continua disponível e as conexões Hermes existentes não mudam.

## O que faz e o que não faz

O bot de provedor de IA atende o cliente no WhatsApp e conversa com a equipe.
- **No atendimento ao cliente:**
  - A cada mensagem, o Vinki envia ao modelo as instruções da área, as 12 últimas mensagens, as fontes do Conhecimento, os menus e as categorias de protocolo, na ordem que favorece o cache de prompt (abaixo).
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
| Conversa com a equipe (Equipe › Bots) | sim | sim, consultando o Vinki e propondo ações em nome de quem pede |
| Especialista | sim, com as ferramentas do Hermes | sim, só consultando os dados do cliente da conversa |
| Item de menu do tipo bot | executa a opção com ferramentas | assume a conversa a partir da opção |
| Ferramentas | as do Hermes e de outros sistemas | as dos módulos do Vinki: na conversa do cliente, as declaradas para o cliente; na equipe, o catálogo de operações com o acesso da pessoa |
| Arquivos gerados pelo bot | sim | não |
| Áudio | transcrito pelo Hermes | aviso pedindo texto, ou equipe |
| Imagens | conforme o modelo | Anthropic e OpenAI sim; DeepSeek não; compatível conforme a opção |

Quem precisa que o bot consulte sistemas de fora do Vinki (o banco, outro ERP) continua usando o Hermes como especialista. Um Atendente de provedor de IA pode consultar especialistas do Hermes ou de outro provedor de IA.

## O bot para a equipe

Cada bot também conversa com as pessoas da equipe. Em **Equipe › Bots**, toque no bot para abrir a conversa interna.
- **Ligar:** o bot nasce desligado, para não começar a responder sem alguém decidir. Um administrador liga pelo botão **Ligar** ali mesmo, ou em Gestão › Atendente e especialistas. Quem não é administrador vê o bot como "Desligado".
- **O que ele faz:** consulta o Vinki e propõe ações **em nome de quem pede, com o acesso dessa pessoa**. Ele busca a operação, lê e prepara um cartão com **Confirmar** e **Cancelar**. Nada muda antes de a pessoa tocar em Confirmar; operação financeira pede o segundo fator. Os dados pessoais vão mascarados ao modelo, salvo o administrador liberar em Sistema › Bot e dados pessoais.
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
3. Escolha o provedor e cole a chave. Na **Outra API compatível com OpenAI** (OpenRouter, Groq e semelhantes), informe também a URL da API, à qual o Vinki acrescenta `/chat/completions`, e se o modelo entende imagens.
4. Escolha o modelo. **Buscar modelos da conta** pergunta ao provedor, com a chave digitada (ou, na edição, a já cadastrada), quais modelos a conta tem, e passa a sugeri-los no campo. A chave usada na busca não é guardada.
   - **Anthropic**: Claude Opus 5.5 (padrão, mais capaz), Claude Sonnet 5.5 ou Claude Haiku 5.5 (mais barato). A busca mostra só os que a conta enxerga.
   - **OpenAI**: a lista deixa de fora modelos de imagem, voz e embeddings. Ainda é possível digitar qualquer nome.
   - **DeepSeek** e APIs compatíveis: a lista vem como o provedor publica; sem lista, digite o nome (na DeepSeek, por exemplo, `deepseek-flash` ou `deepseek-v4-pro`).
5. Escolha o **Esforço de raciocínio**: quanto o modelo pensa antes de responder. Mais esforço deixa a resposta mais cuidadosa, mais lenta e mais cara.
   - **Anthropic**: Baixo (padrão, recomendado para conversa), Médio, Alto, Muito alto ou Máximo.
   - **OpenAI**: Padrão do modelo (o campo não é enviado), Sem raciocínio, Mínimo, Baixo, Médio, Alto, Muito alto ou Máximo. Cada modelo aceita só alguns níveis; com um nível que o modelo não aceita, o **Testar conexão** acusa o erro. Exemplos: `gpt-6.1-terra` e `gpt-6-luna` aceitam de Sem raciocínio a Máximo; `gpt-6.1-sol`, de Baixo a Máximo.
   - **APIs compatíveis**: os mesmos da OpenAI, repassados como estão.
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
- **PDF** (nota fiscal, comprovante): veja a seção "PDF". Outros documentos vão para a equipe, como antes.

## PDF

Com a opção **O modelo entende PDF** da conexão, o PDF que o cliente manda vai ao modelo junto com a mensagem.

- **Onde:**
  - **Anthropic:** ligada de fábrica. O PDF vai como bloco `document`, antes do texto.
  - **OpenAI:** desligada de fábrica, porque só modelos com visão leem PDF. Vai como `input_file` do Responses.
  - **DeepSeek e API compatível:** sem PDF, porque não há formato documentado; o PDF vai para a equipe.
- **Teto do Vinki** (`PDF_LIMITS` em `src/ai-provider.ts`, com o motivo no comentário): **1 PDF por mensagem, até 4 MB e 10 páginas**. Cada página custa de 1.500 a 3.000 tokens de texto, mais a página como imagem. Com 10 páginas e uma área cheia, o pedido fica abaixo de 100 mil tokens, acima dos quais o Claude Haiku 5.5 cobra o pedido inteiro mais caro. As páginas são contadas pelo arquivo; quando não dá para contar (objetos comprimidos), vale só o tamanho.
- **Acima do teto, com a opção desligada ou em provedor sem PDF:** a conversa vai para a equipe ("Anexo necessita análise humana"), como qualquer anexo que o modelo não entende.
- **PDF recusado pelo provedor** (com senha, corrompido): a conversa vai para a equipe, e o motivo aparece em **Execuções de bots** ("O provedor de IA recusou o PDF enviado pelo cliente…").
- **Só na mensagem em que chega.** Nas mensagens seguintes o bot não tem mais o arquivo, só o que ele mesmo escreveu sobre ele na conversa, como já acontece com as imagens. Se o cliente perguntar de novo sobre um detalhe da nota que o bot não escreveu, ele precisa mandar o PDF outra vez. A equipe vê o arquivo na conversa, como sempre.
- **Privacidade:** o PDF tem dado pessoal. Ele é lido do armazenamento (R2) só na hora da chamada, sem cópia, e nada do conteúdo vai para os registros do Vinki.

## Cache de prompt

A cada mensagem o pedido ao modelo é montado do mais estável para o mais variável:

1. as ferramentas, em ordem fixa;
2. as instruções da área, com os menus, as ações e as categorias;
3. os acréscimos desta execução ("não use menu", "a conversa já está com a equipe");
4. a mensagem: pedido, as 12 últimas mensagens, as fontes do Conhecimento e os anexos.

O conteúdo é o mesmo de antes. Os menus, as ações e as categorias mudaram de lugar: saíram do JSON da mensagem e foram para o fim das instruções, depois do texto "Dados desta área de atendimento (menus, actions e categories):", com o mesmo JSON. O Hermes recebe tudo como antes.

- **Anthropic:**
  - O ponto de cache (`cache_control`, validade de 5 minutos) fica no fim do bloco estável (itens 1 e 2).
  - No laço de ferramentas, um segundo ponto, móvel, fica no fim da rodada, e a rodada seguinte lê dele. São no máximo 2 pontos.
  - Cada modelo tem um tamanho mínimo de prefixo para cachear: 512 tokens no Claude Haiku 5.5, segundo a documentação de prompt caching da Anthropic. Abaixo dele não há cache, sem erro. O Vinki não depende desse número: o ponto vai sempre.
- **OpenAI e DeepSeek:** cache automático por prefixo, sem parâmetro. A mesma ordem estável ajuda.
- **Validade de 1 hora:** não está ligada, porque a gravação custa mais. Só depois de medir.

**Uso por execução:** cada execução grava os tokens em `bot_runs.usage` como `{input, cache_read, cache_write, output}`, somados entre as rodadas de ferramentas e as tentativas de novo. **Execuções de bots** mostra os tokens: "entrada · cache lido · cache gravado · saída". Não mostra valor em dinheiro, porque o preço muda. O cache está pegando quando "cache lido" cresce nas mensagens seguintes da mesma área.

| Provedor | O que devolve | Como vira o uso |
|---|---|---|
| Anthropic | `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens` | input, cache_write, cache_read, output |
| OpenAI | `prompt_tokens` (inclui o cache), `prompt_tokens_details.cached_tokens`, `completion_tokens` | input = prompt − cached; cache_read = cached; output |
| DeepSeek | `prompt_cache_miss_tokens`, `prompt_cache_hit_tokens`, `completion_tokens` | input = miss; cache_read = hit; output |
| API compatível | `prompt_tokens`, `completion_tokens`, quando vierem | input, output |

## Falhas

- Provedor fora do ar, limite de uso ou demora (HTTP 408, 409, 429, 5xx ou mais de 60 segundos): o Vinki tenta de novo a cada ciclo, com intervalo mínimo de 10 segundos, por até 3 minutos desde a mensagem. Depois, transfere para a equipe.
- Chave recusada, sem saldo, modelo inexistente, recusa do modelo ou resposta cortada: transfere na hora. O motivo aparece em **Execuções de bots**.
- Uma pessoa que assume a conversa durante a chamada cancela a resposta do bot.

As respostas de uma área de atendimento são processadas em série. Com muitos clientes ao mesmo tempo, a espera cresce na proporção do tempo de resposta do modelo; Claude Haiku 5.5 e modelos menores respondem mais rápido.

## Detalhes técnicos

- Conexão `kind: "ai"`; configuração `provider`, `model`, `base_url`, `vision`, `pdf`, `effort`, `text_only`; segredo `api_key` ([API](../src/openapi.ts)).
- Modelos da conta: `POST /api/v1/profiles/{perfil}/ai-models` (administrador, 10 por minuto), com `{provider, base_url?, api_key?, connection_id?}`; responde `{data:[ids]}`. Fica fora dos comandos idempotentes para a chave não ir aos recibos.
- Chamadas em [src/ai-provider.ts](../src/ai-provider.ts):
  - **OpenAI pela Responses API** (`/v1/responses`). Os modelos atuais (`gpt-6.1-terra`, `gpt-6.1-sol`) só chamam ferramentas por ela, e o `gpt-6-luna` no Chat Completions só com raciocínio desligado.
    - Detalhes do pedido: `instructions` com o bloco estável primeiro, `input` com texto, `input_image` e `input_file`, `text.format` `json_object` e `reasoning.effort` quando escolhido.
    - Sem estado na OpenAI (`store:false`): no laço de ferramentas, os itens da saída (raciocínio cifrado e `function_call`) voltam no `input` seguinte com o `function_call_output`.
    - Uso lido de `input_tokens`, `input_tokens_details.cached_tokens` e `output_tokens`.
  - **DeepSeek e APIs compatíveis pelo Chat Completions** (`/chat/completions`), com modo JSON na DeepSeek e `reasoning_effort` quando escolhido.
  - **Anthropic pelo SDK oficial** (`@anthropic-ai/sdk`) com saída estruturada no formato do Atendente e `output_config.effort` (padrão `low`).
- Execução em [src/engine.ts](../src/engine.ts) (`aiRun`): a resposta chega na mesma passada, sem consulta posterior. Sem efeito colateral no provedor, uma chamada interrompida é simplesmente repetida; o envio ao cliente não duplica, porque a mensagem é identificada pela execução.
- Uma migração de banco (`0090_bot_runs_uso.sql`: coluna `bot_runs.usage`). Sem Durable Object novo, sem binding nem secret novo: chega pela atualização normal do painel.
- Ferramentas: modo equipe e modo cliente em [src/bot-actions](../src/bot-actions); o especialista recebe só as ferramentas de cliente sem escrita (`write` falso e `customer` diferente de `"propose"`). Provedor que recusa ferramentas: `tools_unsupported_at` na configuração da conexão, limpo ao salvar.
- Testes: `tests/ai-provider.test.ts`, `tests/bot-actions-ai.test.ts`.
