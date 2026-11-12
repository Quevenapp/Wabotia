# WhatsApp pela Zernio

O Wabotia importa telefones WhatsApp já cadastrados na Zernio, que intermedeia o envio e o recebimento das mensagens. O cadastro e a autorização do telefone são gerenciados fora do Wabotia, no painel Zernio. QR e WhatsApp pelo Hermes continuam disponíveis.

## Importar telefones da Zernio

1. Abra [API Keys da Zernio](https://zernio.com/dashboard/api-keys), clique em **Create API key** e copie a chave imediatamente: ela é exibida uma vez. Consulte as [instruções oficiais](https://docs.zernio.com/quickstart#create-an-api-key).
2. No [painel Zernio](https://zernio.com), abra **Connections** para conferir os telefones já cadastrados. O **Account ID** identifica o telefone; o ID empresarial da Meta identifica a conta WhatsApp Business. O Wabotia encontra o ID da integração usando a API key, sem precisar copiá-lo do painel Zernio.
3. Crie uma senha aleatória longa para o **Segredo de assinatura do webhook Zernio** e guarde-a. A Zernio não gera esse segredo: use o mesmo valor nos dois sistemas. [Documentação de webhooks](https://docs.zernio.com/webhooks).
4. Abra **Canais → Integração Zernio → Nova integração**. Informe nome, fuso, API key e segredo do webhook. Pode deixar **ID da integração na Zernio** vazio. Salve e clique em **Encontrar ID na Zernio**. Escolha pelo nome, confira o ID encontrado e clique em **Usar esta integração**. Isso usa a chave já salva e não cria cadastros na Zernio. Se tiver informado um Account ID por engano, o Wabotia consegue reconhecer a integração à qual aquele telefone pertence. A correção só é permitida antes de vincular telefones ou grupos, preservando as credenciais e a URL do webhook.
5. Confira se o telefone desejado já está disponível na Zernio. Se estiver ausente, gerencie o cadastro diretamente no painel Zernio antes de refazer a busca no Wabotia.
6. Abra **Telefones → Buscar telefones na Zernio**. Cada telefone tem seu próprio **ID do telefone na Zernio**, identificado pelo campo **Account ID** no provedor.
7. Selecione o telefone, confira o consumo inicial, defina o limite local de serviço e adicione. Esse limite não garante gratuidade na Zernio. A linha começa pausada.

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

## Regras e limites

- A janela de atendimento de 24 horas continua vinculada ao telefone que recebeu a última mensagem do cliente. Fora dela, use template aprovado e consentimento apropriado.
- Templates que iniciam uma conversa aceitam variáveis de texto, cabeçalhos de mídia compatíveis, botões de URL e de copiar código (COPY_CODE). A API de abertura da Zernio não oferece payload personalizado para botões QUICK_REPLY: esse envio é recusado antes de abrir a conversa. Use um template sem esse payload; em conversas já existentes, os componentes do template seguem pelo endpoint de resposta.
- Contadores e limites locais não substituem as faturas. A Zernio e a Meta podem cobrar serviços diferentes; confira as [tarifas atuais](https://docs.zernio.com/platforms/whatsapp/pricing).
- Os tipos de mensagem e operações disponíveis são apresentados conforme as capacidades da conexão.
- Grupos empresariais exigem telefone elegível sem coexistência com o aplicativo. Confira a Zernio antes de habilitar o recurso e sincronize os grupos em **Grupos WhatsApp** antes de receber mensagens deles, para que sejam identificados corretamente.
- O áudio de chamadas pelo navegador do Wabotia não está disponível na integração Zernio. Históricos anteriores são mantidos; as [opções de chamada da Zernio](https://docs.zernio.com/platforms/whatsapp/calling) possuem configuração própria.

Referências: [WhatsApp Zernio](https://docs.zernio.com/platforms/whatsapp), [telefones cadastrados](https://docs.zernio.com/accounts/list-accounts), [inbox](https://docs.zernio.com/platforms/whatsapp/inbox), [grupos](https://docs.zernio.com/platforms/whatsapp/groups).
