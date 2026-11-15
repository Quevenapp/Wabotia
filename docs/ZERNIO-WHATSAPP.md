# WhatsApp pela Zernio

O Wabotia importa telefones WhatsApp já cadastrados na Zernio, que intermedeia o envio e o recebimento das mensagens. O cadastro e a autorização do telefone são gerenciados fora do Wabotia, no painel Zernio. QR e WhatsApp pelo Hermes continuam disponíveis.

## Importar telefones da Zernio

1. Abra [API Keys da Zernio](https://zernio.com/dashboard/api-keys), clique em **Create API key** e copie a chave imediatamente: ela é exibida uma vez. Consulte as [instruções oficiais](https://docs.zernio.com/quickstart#create-an-api-key).
2. No [painel Zernio](https://zernio.com), abra **Connections** para conferir os telefones já cadastrados. O **Account ID** identifica o telefone; o ID empresarial da Meta identifica a conta WhatsApp Business. O Wabotia encontra o ID da integração usando a API key, sem precisar copiá-lo do painel Zernio.
3. Crie uma senha aleatória longa para o **Segredo de assinatura do webhook Zernio** e guarde-a. A Zernio não gera esse segredo: use o mesmo valor nos dois sistemas. [Documentação de webhooks](https://docs.zernio.com/webhooks).
4. Abra **Canais → Integração Zernio → Nova integração**. Informe nome, fuso, API key e segredo do webhook. Pode deixar **ID da integração na Zernio** vazio. Salve e clique em **Encontrar ID na Zernio**. Escolha pelo nome, confira o ID encontrado e clique em **Usar esta integração**. Isso usa a chave já salva e não cria cadastros na Zernio. Se tiver informado um Account ID por engano, o Wabotia consegue reconhecer a integração à qual aquele telefone pertence. A correção só é permitida antes de vincular telefones ou grupos, preservando as credenciais e a URL do webhook.
5. Confira se o telefone desejado já está disponível na Zernio. Se estiver ausente, gerencie o cadastro diretamente no painel Zernio antes de refazer a busca no Wabotia.
6. Abra **Telefones → Buscar telefones na Zernio**. Cada telefone tem seu próprio **ID do telefone na Zernio**, identificado pelo campo **Account ID** no provedor.
7. Selecione o telefone, dê um nome e adicione. Não é necessário informar consumo anterior ou limite local. A linha começa pausada.

## Receber mensagens e recibos

Copie a URL **Webhook único desta integração**, no domínio HTTPS da sua instalação, terminada em /webhooks/zernio-accounts/ID_DA_CONTA.

Cadastre essa URL em [Webhooks da Zernio](https://zernio.com/dashboard/webhooks), com o mesmo segredo de assinatura salvo no Wabotia. Selecione eventos de mensagem recebida, enviada, entregue, lida e falha. A assinatura é validada antes de aceitar o evento. Os eventos precisam pertencer a um telefone cadastrado nessa integração.

Ative a linha, selecione o bot ou a equipe responsável e faça um teste de recebimento, resposta e confirmação de entrega. Uma mensagem na fila ou aceita pelo provedor ainda não comprova a entrega ao cliente.

Também é possível cadastrar uma conexão individual em **Conexões → WhatsApp · Zernio**, informando telefone, ID do telefone na Zernio, ID da integração na Zernio, API key e segredo do webhook. Nesse caso a URL termina em /webhooks/zernio/ID_DA_CONEXAO.

## Migrar da conexão direta com a Meta

As linhas Meta anteriores são pausadas pela atualização. Não ocorre conversão automática de credenciais ou transferência de telefones no provedor. Resolva envios em andamento ou sem confirmação e ligações abertas, exclua a linha antiga do Wabotia e importe o telefone já cadastrado na Zernio. O histórico anterior permanece disponível, desvinculado da nova conexão.

Não mantenha dois sistemas respondendo pelo mesmo telefone. Gerencie o cadastro do telefone no [painel Zernio](https://zernio.com).

## Excluir um telefone

Use **Excluir telefone** em **Telefones** ou **Conexões** e confira a confirmação. A ação exige administrador e resolve apenas o cadastro local. O Wabotia preserva conversas, mensagens e protocolos e remove credenciais e vínculos de roteamento. Mensagens e operações de grupo ainda na fila são canceladas atomicamente. Envios e operações de grupo em andamento ou sem confirmação e ligações abertas impedem a exclusão até serem resolvidos.

Excluir no Wabotia não cancela o telefone, a conta nem serviços e cobranças da Zernio. Para desconectar ou cancelar remotamente, use o provedor.

## Excluir uma integração

Depois de remover seus telefones, selecione o cadastro em **Integração Zernio** e use **Excluir integração**. Isso também permite retirar cadastros antigos da Meta. A exclusão remove o cadastro e suas credenciais locais, preservando conversas, mensagens e protocolos. Grupos desativados sem vínculos são removidos junto; telefones ou grupos com histórico, permissões ou outros vínculos impedem a exclusão. A ação não desconecta o WhatsApp na Zernio ou na Meta.

Se a Zernio recusar **Encontrar ID na Zernio** ou **Buscar telefones**, o painel apresenta o motivo informado pelo provedor, incluindo código e campo quando disponíveis, sem exibir suas credenciais. Confira esse motivo antes de alterar a integração; um HTTP 400 sozinho não identifica qual configuração precisa ser corrigida.

## Mensagens interativas, Flows e catálogo

Nas linhas oficiais (Zernio), os módulos e o atendimento automático podem usar os recursos nativos do WhatsApp. Nas linhas QR e em grupos, o mesmo conteúdo sai como texto numerado, com os links no corpo da mensagem. Ainda não há tela no painel para montar essas mensagens: elas são usadas pelos módulos e pelo atendimento automático.

| Recurso | Linha oficial | Linha QR e grupos |
|---|---|---|
| Botão com link | Botão que abre o link | Texto com "Rótulo: link" |
| Lista (até 10 opções) | Lista nativa; o toque devolve o ID da opção | Opções numeradas; o cliente responde o número ou o título |
| Carrossel de imagens ou vídeos (2 a 10 cartões, cada um com botão de link) | Carrossel | Cartões numerados com os links |
| Pedido de localização | Botão "Enviar localização" | Instrução para enviar a localização pelo clipe |
| Produto, lista de produtos (até 30 itens) e catálogo | Cartões do catálogo da Meta | Texto da mensagem e, quando informados, texto e link alternativos (por exemplo, a loja ou o passo web) |
| Flow publicado | Botão que abre o formulário dentro do WhatsApp | Texto da mensagem e o link alternativo, quando informado |

Os limites do WhatsApp são conferidos antes do envio, em todas as linhas, para que uma mensagem aceita no QR não falhe depois numa linha oficial: cabeçalho e rodapé até 60 caracteres, texto do botão até 20, título de opção até 24, descrição até 72, texto do cartão do carrossel até 160 e botão de Flow até 30. Emojis contam como um caractere. Mensagens interativas só podem ser enviadas com a janela de 24 horas aberta; fora dela, use um template aprovado.

### O que depende de configuração na Meta

- **Produto, lista de produtos e catálogo** exigem um catálogo da Meta ligado à conta WhatsApp Business no [Commerce Manager](https://business.facebook.com/commerce/), com os produtos cadastrados pelo **ID do produto** (Content ID ou SKU) usado na mensagem. O carrossel de imagens ou vídeos não depende de catálogo.
- **Flows** precisam ser criados e publicados na conta WhatsApp Business. O Wabotia cria o rascunho, envia o JSON do Flow no formato da Meta, publica e lista os Flows pela Zernio. A publicação é definitiva: um Flow publicado não pode ser alterado; para mudar, crie uma nova versão a partir dele. Se a Meta recusar o JSON, os erros voltam com linha e coluna e a publicação é bloqueada até a correção.
- Flows com endpoint próprio (`data_exchange`) exigem endpoint HTTPS e chave pública registrada no número. O Wabotia ainda não hospeda esse endpoint: use Flows de navegação (`navigate`), que funcionam só com o JSON publicado.

### Respostas recebidas

- **Formulário (Flow) e endereço**: chegam com os campos preenchidos e o token de correlação do envio. O texto da mensagem mostra um resumo, como "Formulário enviado." seguido de cada campo.
- **Carrinho do catálogo**: chega com o catálogo, os itens (ID do produto, quantidade, preço unitário e moeda), a observação do cliente e o total, quando todos os itens têm preço na mesma moeda. O texto mostra o pedido; a Meta não envia o nome do produto, só o ID.
- **Localização enviada pelo cliente**: latitude e longitude numéricas, nome e endereço, no mesmo formato da localização enviada pelo Wabotia.
- **Pergunta sobre produto** ("Enviar mensagem à empresa" num produto) e **contato compartilhado a pedido** são identificados no conteúdo da mensagem.

Toques em botões e listas continuam funcionando como antes.

O atendimento trata o formulário e o carrinho antes do menu e do bot: a resposta de um formulário enviado pelo Wabotia (passo web entregue como Flow) é casada pelo token e conclui o formulário; um carrinho, ou um formulário sem envio correspondente, vai para o módulo que o trata ou, sem módulo, para a equipe com o resumo. O resumo nunca abre o menu. Detalhes em [MODULOS.md](MODULOS.md), seção "Passo web".

> **Teste numa linha Zernio real antes de publicar:** listas e demais interativos (exceto botões de resposta) passaram a sair só com o `interactive`, sem o texto numerado junto. Isso vale para os menus e a fila já publicados. Os testes locais conferem o pedido montado, não a exibição no WhatsApp.

### Para módulos (código)

- `sendInteractive(env, actor, conversa, spec, chave, automacao?)` em `src/line-service.ts` enfileira a mensagem com a queda automática para texto. `interactiveChoice(spec, texto, interactive_reply_id?)` devolve a opção escolhida, por toque ou por número.
- Os tipos de `spec` (`cta_url`, `list`, `media_carousel`, `location_request`, `product`, `product_list`, `catalog`, `flow`) e `flowToken(flowId, referencia)` estão em `src/whatsapp-interactive.ts`.
- Flows: `zernioListFlows`, `zernioCreateFlow`, `zernioUploadFlowJson`, `zernioPublishFlow` e `zernioSendFlow` em `src/whatsapp-flows.ts`. Para clientes sem telefone visível (identificador empresarial do WhatsApp), envie o Flow como `spec` do tipo `flow` por `sendInteractive`, que usa a conversa.
- Recebimento: `content.type` passa a ser `flow_reply`, `order` ou `location`, com `content.flow_reply`, `content.order` e `content.location` (formato em `src/whatsapp-inbound.ts`).

## Regras e limites

- A janela de atendimento termina 24 horas após a última mensagem recebida do cliente, no mesmo telefone. Cada nova mensagem do cliente renova o prazo; respostas e templates enviados não renovam. O chat mostra a última mensagem e o vencimento. Fora da janela, use template aprovado e consentimento apropriado.
- Templates que iniciam uma conversa aceitam variáveis de texto, cabeçalhos de mídia compatíveis, botões de URL e de copiar código (COPY_CODE). A API de abertura da Zernio não oferece payload personalizado para botões QUICK_REPLY: esse envio é recusado antes de abrir a conversa. Use um template sem esse payload; em conversas já existentes, os componentes do template seguem pelo endpoint de resposta.
- Não há teto local de mensagens. Em **Telefones**, os totais mensais contam somente mensagens com entrega/leitura confirmada, separando atendimento na janela, template de atendimento (UTILITY) e marketing. Autenticação e categoria não identificada aparecem quando houver uso. O mês segue o fuso da integração, desde o início do acompanhamento. Confira as [tarifas atuais](https://docs.zernio.com/platforms/whatsapp/pricing) para cobrança; os totais não estimam preço.
- Abra **Templates da Zernio** no telefone para buscar os modelos já cadastrados por nome, texto, idioma, categoria e status. Consultar não envia mensagens nem cria templates. A gestão e aprovação continuam no provedor.
- Os tipos de mensagem e operações disponíveis são apresentados conforme as capacidades da conexão.
- Grupos empresariais exigem telefone elegível sem coexistência com o aplicativo. Confira a Zernio antes de habilitar o recurso e sincronize os grupos em **Grupos WhatsApp** antes de receber mensagens deles, para que sejam identificados corretamente.
- O áudio de chamadas pelo navegador do Wabotia não está disponível na integração Zernio. Históricos anteriores são mantidos; as [opções de chamada da Zernio](https://docs.zernio.com/platforms/whatsapp/calling) possuem configuração própria.

Referências: [WhatsApp Zernio](https://docs.zernio.com/platforms/whatsapp), [telefones cadastrados](https://docs.zernio.com/accounts/list-accounts), [inbox](https://docs.zernio.com/platforms/whatsapp/inbox), [enviar mensagem](https://docs.zernio.com/messages/send-inbox-message), [Flows](https://docs.zernio.com/platforms/whatsapp/flows), [grupos](https://docs.zernio.com/platforms/whatsapp/groups).
