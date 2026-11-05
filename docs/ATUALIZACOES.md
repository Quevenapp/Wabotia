# Atualizar Wabotia pelo painel

Acesse a **sua instalação**, como `https://meu-wabotia.minhaconta.workers.dev/app`. Em **Sistema e atualizações**, clique **Verificar atualização**. A consulta ao repositório oficial é armazenada por cinco minutos. Depois da configuração inicial, **Atualizar Wabotia** solicita a publicação. Espere **Atualização publicada e verificada** e reabra o painel pelo botão.

O atualizador usa Cloudflare Builds e um Deploy Hook. GitHub Actions continua desativado. O commit oficial é fixado antes do pedido e conferido no código em execução. A aceitação do pedido de build ainda não significa que a atualização foi publicada.

## Configuração inicial

1. Faça [backup](OPERACAO.md#backup). Guarde a MASTER_KEY original.
2. Na Cloudflare, abra **Workers & Pages → seu Worker → Settings → Builds**. Confirme o repositório da instalação e branch `main`. Se publicou apenas por Wrangler, vincule primeiro o repositório com a configuração da **sua instalação**.
3. Confirme que `wabotia-build.mjs` existe na raiz desse repositório. Para cópia antiga, veja a próxima seção.
4. Configure **Build command** como `node wabotia-build.mjs` e **Deploy command** como `npm run deploy`.
5. Em **Variables and secrets de Builds**, adicione `WABOTIA_UPDATE_ORIGIN`: a origem HTTPS do seu Worker, sem `/app`, caminhos ou query string. Não confunda com as variáveis de runtime do Worker.
6. Em **Deploy Hooks**, crie um hook para `main`, copie sua URL e guarde-a como uma senha. Não publique no GitHub nem em screenshots.
7. No Wabotia, abra **Sistema e atualizações → Configurar atualização pelo painel**. Cole a URL no campo protegido, marque a confirmação dos passos e salve.

## Primeira atualização de uma cópia antiga

Se seu painel não possui “Sistema e atualizações”, prepare a primeira atualização pelo dashboard:

1. No [repositório oficial](https://github.com/Quevenapp/Wabotia), escolha um commit revisado/testado de `main` que já contém o atualizador. Copie o **SHA completo de 40 caracteres**. Não use o texto `main` no lugar do SHA.
2. Abra o arquivo `wabotia-build.mjs` **nesse commit**, baixe o arquivo e adicione-o à raiz do repositório da sua instalação. Não substitua `wrangler.jsonc`, não altere recursos e não gere novos secrets. Se o push disparar o build antigo, ele ainda publicará a versão antiga.
3. Configure os dois comandos e `WABOTIA_UPDATE_ORIGIN` conforme a seção anterior.
4. Adicione temporariamente em **Builds** a variável `WABOTIA_BOOTSTRAP_COMMIT` com o SHA completo escolhido. Ela só é usada quando a instalação antiga ainda não oferece um plano de atualização JSON válido.
5. Inicie um build pelo dashboard e acompanhe seu log. Ele busca o código oficial, preserva a configuração da instalação, verifica tipos, prepara o site, aplica migrações D1 aditivas e publica o Worker.
6. Abra `/api/health`: `version` e `commit` devem indicar a versão escolhida. Reabra `/app`, confirme “Sistema e atualizações” e confira seus perfis, conexões e arquivos.
7. Remova `WABOTIA_BOOTSTRAP_COMMIT` de Builds. Crie o hook e salve sua URL no painel. As próximas atualizações usam o botão.

O script copia código para o checkout temporário do build; ele não sincroniza nem grava alterações no seu repositório GitHub. Sua configuração, domínios, variáveis e bindings continuam sendo os da instalação. Novos bindings ou mudanças incompatíveis em Durable Objects exigem atualização manual e interrompem o build. Customizações próprias de código precisam de revisão manual.

## Quando falha

- **Sem confirmação:** confira Deployments/Builds. Não dispare outro build por impulso; o anterior pode estar rodando.
- **Build falhou:** abra o log, corrija o erro e confirme que não há execução nem fila. No painel, marque a declaração e clique **Liberar nova tentativa**. Para pedidos ainda sem confirmação, essa ação é liberada após 15 minutos.
- **Erro de migração:** mantenha o Worker e os dados existentes. Não apague DB nem MEDIA. Corrija a migração/configuração e execute novamente pelo procedimento indicado no log.
- **Ainda aparece a tela antiga:** aguarde a confirmação do commit e clique **Reabrir painel atualizado**. Recarregar o navegador sozinho não publica código.

Não há rollback automático de dados. Para mudanças sensíveis, valide primeiro uma instalação de staging separada e guarde backup.

## Recuperar uma versão com erro ao consultar atualizações

Este procedimento serve quando **Verificar atualização** falha na versão instalada. Ele publica um commit oficial escolhido por você, preservando os recursos da instalação. Não é necessário nas atualizações normais.

1. Faça backup e confirme na Cloudflare que não há build em execução ou na fila.
2. Abra o repositório oficial, entre em **Commits** e escolha a correção revisada. Copie o SHA completo de 40 caracteres desse commit.
3. Baixe `wabotia-build.mjs` desse commit. No repositório GitHub da sua instalação, use **Add file → Upload files** para substituir somente esse arquivo e confirme o commit. Não altere `wrangler.jsonc` ou os secrets. Se um build automático começar, aguarde terminar antes de continuar.
4. Na Cloudflare, abra **seu Worker → Configurações / Settings → Compilações / Builds**. Preserve `WABOTIA_UPDATE_ORIGIN` com a origem da sua instalação. Temporariamente, use como **Build command** `node wabotia-build.mjs --commit SHA_COMPLETO`, substituindo `SHA_COMPLETO` pelo código copiado. Mantenha **Deploy command** `npm run deploy` e salve.
5. Em **Implantações / Deployments**, abra a última compilação do repositório e use **Retry build / Repetir compilação**. Aguarde a conclusão. O script aceita somente um SHA completo e verifica que pertence à branch `main` oficial.
6. Abra o endereço da sua instalação seguido de `/api/health`. Confira `version` e `commit`, reabra `/app` e confira suas conexões.
7. Volte às configurações de Builds, retire `--commit` e o código, deixando apenas `node wabotia-build.mjs`, e salve. **Se não retirar, os próximos builds continuarão presos à versão escolhida.**
8. No painel, use **Verificar atualização**. Com o hook configurado, as próximas versões voltam a usar **Atualizar Wabotia**.
