# Operação e recuperação

## Publicação manual e ambientes

`npm run setup -- --environment staging` cria `wabotia-staging`, D1 e R2 separados. `npm run setup` usa produção. Os arquivos `wrangler.*.local.json` têm os IDs da sua conta e não devem ser copiados entre ambientes. Não compartilhe MASTER_KEY, chaves de aplicações ou tokens de canais entre eles.

Antes de atualizar, faça backup e registre a versão Git. Execute `npm run check`, `npm test` e `npm run build`; aplique as migrações no ambiente alvo, depois execute `npx wrangler deploy --config wrangler.production.local.json`. Não remova migrações aplicadas. Cloudflare Builds, quando usado pelo botão Deploy, é um serviço da Cloudflare; não depende de GitHub Actions.

## Backup

1. Pause o atendimento e os canais no painel. Pare o QR/conector para não receber gravações durante a cópia. Mantenha os diários/spools.
2. Execute `node scripts/backup.mjs wrangler.production.local.json backup-seguro`.
3. O script exporta D1 e cada mídia privada em R2. Só ao concluir grava `manifest.json` com `complete: true`.
4. Copie a pasta para armazenamento protegido, com criptografia e retenção adequada. Guarde MASTER_KEY separadamente. Ela não é incluída automaticamente no backup.
5. Retome canais e atendimento após conferir o manifesto. Um backup com canais ativos pode ter banco e mídias de instantes diferentes.

D1 Time Travel é uma recuperação adicional conforme o plano Cloudflare; não substitui a cópia de R2 e a guarda de MASTER_KEY. Os diários e sessões de QR ficam no host do conector e precisam de backup próprio, com o processo parado.

## Restaurar sem sobrescrever produção

1. Crie um banco D1 novo/vazio e um bucket R2 privado novo. Copie a configuração do Worker para um arquivo local, alterando nome, DB e bucket para esses recursos.
2. Execute `node scripts/restore.mjs wrangler.restore.local.json backup-seguro --empty-target`.
3. O script recusa banco com tabelas existentes. Importe somente backups que você controla: o arquivo SQL será executado no banco escolhido.
4. Configure a MASTER_KEY original nos secrets do Worker restaurado. Publique a mesma versão do código e teste a leitura de dados/arquivos antes de apontar o domínio.
5. Desative a instalação antiga antes de ligar os mesmos canais na restaurada. Revogue tokens de canal que não serão mais usados.

## Falhas e diagnósticos

Execute `node scripts/diagnose.mjs https://seu-worker.workers.dev`. Use o dashboard Workers > Logs ou `npx wrangler tail --config wrangler.production.local.json` para erros sanitizados. Nunca copie cookies, tokens ou conversas de clientes em chamados públicos.

| Sintoma | Verificação |
|---|---|
| API 401 | Chave correta, não revogada e dentro da validade; sessão de usuário pode ter expirado. |
| API 403/404 | Permissão da operação, perfil/bot autorizado e aplicação dona da conversa externa. |
| API 409 | Mesma Idempotency-Key com outro corpo, outra pessoa responsável ou efeito sem confirmação. |
| API 429 | Respeite Retry-After e reduza frequência/execuções simultâneas. |
| Hermes offline | Processo/API Server ativos, túnel, Access, tokens do perfil e URL final sem redirecionamentos. |
| Bot `unknown` | Não repita a execução. Encontre o run_id no Hermes e reconcilie por `/bot-runs/{id}/reconcile`, como administrador. |
| Entrega `unknown` | Confira o canal. Marque enviada/cancelada ou autorize nova tentativa por `/deliveries/{id}/reconcile`. Nova tentativa recebe outro ID. |
| Tópico `creating:*` | Confira o grupo; vincule o ID do tópico já criado com a ação administrativa `bind_topic`. Não crie outro automaticamente. |
| Meta aguardando | Janela de 24h ou consentimento/template. Use UTILITY aprovado, idioma correto e corpo com `{{1}}` protocolo e `{{2}}` andamento. |
| QR desconectado | Host ligado, processo ativo e sessão não encerrada no celular. Não apague o diário. |
| Documento indisponível | PDF deve conter texto; vídeo precisa de legendas públicas. Importe transcrição TXT/VTT/SRT autorizada se necessário. |

Alarmes retomam inbox, execuções e entregas pendentes; o cron de cinco minutos recupera perfis sem alarme. Entradas/canais possuem IDs de deduplicação. Envios com confirmação perdida permanecem para reconciliação, pois os provedores de mensagens não oferecem uma transação única com D1.
