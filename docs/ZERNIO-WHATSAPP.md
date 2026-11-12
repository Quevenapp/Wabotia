# WhatsApp pela Zernio

O Wabotia usa a Zernio como intermediária da API oficial do WhatsApp. A conexão direta com a Meta foi retirada do fluxo de configuração. QR e WhatsApp pelo Hermes continuam disponíveis.

## Conectar a integração

1. Prepare a integração na Zernio e copie o valor do campo **Profile ID**. No Wabotia, esse valor é o **ID da integração na Zernio**. Crie uma **API key** com acesso a essa integração.
2. Prepare um segredo para assinatura dos webhooks; use o mesmo valor na Zernio e no Wabotia.
3. Abra **Canais → Integração Zernio → Nova integração**. Informe nome, ID da integração na Zernio, fuso, API key e segredo do webhook. Salve.
4. Clique em **Conectar WhatsApp pela Zernio**. Conclua o fluxo de autorização da empresa e do telefone. A Zernio conduz a conexão com a Meta.
5. Ao retornar, abra a mesma integração, vá a **Telefones** e clique em **Buscar telefones na Zernio**. Cada telefone tem seu próprio **ID do telefone na Zernio**, identificado pelo campo **Account ID** no provedor.
6. Selecione o telefone, confira o consumo inicial, defina o limite local de serviço e adicione. Esse limite não garante gratuidade na Zernio. A linha começa pausada.

## Receber mensagens e recibos

Copie a URL **Webhook único desta integração**, no domínio HTTPS da sua instalação, terminada em /webhooks/zernio-accounts/ID_DA_CONTA.

Cadastre essa URL na Zernio, com o mesmo segredo de assinatura salvo no Wabotia. Selecione eventos de mensagem recebida, enviada, entregue, lida e falha. A assinatura é validada antes de aceitar o evento. Os eventos precisam pertencer a um telefone cadastrado nessa integração.

Ative a linha, selecione o bot ou a equipe responsável e faça um teste de recebimento, resposta e confirmação de entrega. Uma mensagem na fila ou aceita pelo provedor ainda não comprova a entrega ao cliente.

Também é possível cadastrar uma conexão individual em **Conexões → WhatsApp · Zernio**, informando telefone, ID do telefone na Zernio, ID da integração na Zernio, API key e segredo do webhook. Nesse caso a URL termina em /webhooks/zernio/ID_DA_CONEXAO.

## Migrar da conexão direta com a Meta

As linhas Meta anteriores são pausadas pela atualização. Não ocorre conversão automática de credenciais ou transferência de telefones no provedor. Resolva envios em andamento ou sem confirmação e ligações abertas, exclua a linha antiga do Wabotia e conecte o telefone pela Zernio. O histórico anterior permanece disponível, desvinculado da nova conexão.

Não mantenha dois sistemas respondendo pelo mesmo telefone. A preparação e a migração de um telefone já utilizado devem seguir o [fluxo oficial da Zernio](https://docs.zernio.com/platforms/whatsapp/connect).

## Excluir um telefone

Use **Excluir telefone** em **Telefones** ou **Conexões** e confira a confirmação. A ação exige administrador e resolve apenas o cadastro local. O Wabotia preserva conversas, mensagens e protocolos e remove credenciais e vínculos de roteamento. Mensagens e operações de grupo ainda na fila são canceladas atomicamente. Envios e operações de grupo em andamento ou sem confirmação e ligações abertas impedem a exclusão até serem resolvidos.

Excluir no Wabotia não cancela o telefone, a conta nem serviços e cobranças da Zernio. Para desconectar ou cancelar remotamente, use o provedor.

## Regras e limites

- A janela de atendimento de 24 horas continua vinculada ao telefone que recebeu a última mensagem do cliente. Fora dela, use template aprovado e consentimento apropriado.
- Templates que iniciam uma conversa aceitam variáveis de texto, cabeçalhos de mídia compatíveis, botões de URL e de copiar código (COPY_CODE). A API de abertura da Zernio não oferece payload personalizado para botões QUICK_REPLY: esse envio é recusado antes de abrir a conversa. Use um template sem esse payload; em conversas já existentes, os componentes do template seguem pelo endpoint de resposta.
- Contadores e limites locais não substituem as faturas. A Zernio e a Meta podem cobrar serviços diferentes; confira as [tarifas atuais](https://docs.zernio.com/platforms/whatsapp/pricing).
- Os tipos de mensagem e operações disponíveis são apresentados conforme as capacidades da conexão.
- Grupos empresariais exigem telefone elegível sem coexistência com o aplicativo. Confira a Zernio antes de habilitar o recurso e sincronize os grupos em **Grupos WhatsApp** antes de receber mensagens deles, para que sejam identificados corretamente.
- O áudio de chamadas pelo navegador do Wabotia não está disponível na integração Zernio. Históricos anteriores são mantidos; as [opções de chamada da Zernio](https://docs.zernio.com/platforms/whatsapp/calling) possuem configuração própria.

Referências: [WhatsApp Zernio](https://docs.zernio.com/platforms/whatsapp), [conexão](https://docs.zernio.com/platforms/whatsapp/connect), [inbox](https://docs.zernio.com/platforms/whatsapp/inbox), [grupos](https://docs.zernio.com/platforms/whatsapp/groups).
