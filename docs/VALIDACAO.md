# Validação e limites da versão 0.3.0

Atualizado em 05/11/2026. A implementação é uma versão inicial de código aberto. **Ainda não foi homologada ponta a ponta com contas reais de WhatsApp, Telegram e perfis Hermes nesta implantação.** Credenciais, perfis e destinatários de teste precisam ser escolhidos pelo proprietário.

## O que foi verificado

| Área | Evidência | Resultado |
|---|---|---|
| Runtime | Vitest com `@cloudflare/vitest-plugin`, D1/R2/DO em workerd | 50 testes passam; provedores externos simulados |
| API remota | `scripts/smoke.mjs` contra Worker de staging | 20 verificações HTTP, dados fictícios; sem canal conectado |
| Credenciais | Testes de hash, criptografia, expiração e revogação | Chaves inválidas recusadas; credenciais não ficam no frontend |
| Autorizações | Testes de perfis, bots e namespaces de aplicações | Aplicações não escolhem identidade nem acessam conversas externas umas das outras |
| Consistência | Idempotência/conflito, inbox/outbox, limites, época da conversa e recibos | Repetições deduplicadas; tomada humana invalida resposta antiga |
| Bots | API assíncrona simulada, cancelamento, confirmação perdida e recuperação | Sem execução automática adicional após resultado ambíguo |
| Arquivos de bots | Download único, R2 recuperável e isolamento de ator | Não repete download ambíguo nem libera arquivo para outra aplicação |
| Conhecimento | Texto, importação e pesquisa FTS em testes | Base consultável; importação depende de conteúdo e acesso da fonte |
| Webhooks | HMAC, retry e permissões testados com HTTP simulado | Eventos mantêm IDs estáveis; destinatário precisa deduplicar |
| Clientes de exemplo | JavaScript, Python e cURL contra staging | Criam conversa, assumem, respondem e abrem protocolo; bot real não executado |
| Backup e restauração | D1 e R2 remotos em destino novo/vazio | Contagens, FTS e mídia por SHA-256 conferidos; banco preenchido recusado |
| Transporte Hermes | 3 testes Python | Diário e recibos; sem gateway/canal real conectado |
| Interface | Chrome desktop e viewport 390 × 844 | Landing, painel, formulários e navegação móvel revisados |
| Repositório | Quevenapp/Wabotia público, MIT | Actions desativado antes do primeiro push; sem workflows |

Resultados remotos sanitizados: [API](reference/live-validation.json), [exemplos](reference/examples-validation.json) e [restauração](reference/restore-validation.json). Os arquivos não contêm chaves nem dados de clientes.

O site e o guia estão publicados em https://wabotia.queven.app. Desde 0.3, novas instalações usam o instalador independente e a API Cloudflare; o fluxo de cópia GitHub permanece somente como legado.

## Matriz para homologar seus canais

Use staging, perfis e destinatários autorizados. Registre versão do Hermes, versão do conector, data e resultado. Uma linha só está concluída depois de executar o teste no serviço real.

| Cenário | Ainda requer teste real |
|---|---|
| Hermes nativo e Docker | Descoberta, cada chave de perfil, run/stop, reconexão, áudio, imagem e exportação de artefato |
| Tunnel + Access | Service Auth nos dois hostnames, renovação do serviço, reinício do host, recusa sem credenciais |
| Meta direto | Webhook/assinatura, mensagem e anexo, janela 24h, consentimento/template UTILITY |
| QR direto | Pareamento Baileys, entrada/saída, anexo, reinício mantendo sessão, confirmação perdida |
| Meta/QR pelo Hermes | Extensão exclusiva compatível, spool/replay, isolamento de perfil, ausência de dupla resposta |
| Telegram direto | Bot dedicado, grupo privado/tópicos, vínculo de IDs, presença, comandos, notas e anexos |
| Tomada humana | Assumir durante inferência; nenhuma resposta obsoleta; transferência com mensagens pendentes |
| Indisponibilidade | Desligar Hermes/túnel/QR e restaurar; painel continua acessível; pendências conferidas |
| Integração externa | Entrega HMAC a endpoint do integrador, duplicata após timeout, retry manual e limites na carga prevista |
| Troca de modo do número | Pausa, reconciliação, ativação do novo consumidor, retomada sem duplicidade |

## Limites que precisam ser considerados

- A revisão Hermes examinada possui APIs nativas recentes de execução durável. Compatibilidade com outras revisões não é presumida; a descoberta recusa a ausência da capacidade exigida. O backend administrativo com login interativo/OAuth pode exigir outra configuração de integração.
- O conector pelo Hermes usa uma extensão do gateway e APIs internas do adaptador. Telegram e WhatsApp direto não precisam desse plugin. A extensão precisa ser revalidada a cada atualização Hermes.
- A API nativa de artefatos faz download de uso único. Caminhos locais e arquivos não exportados não são anexos. Sem confirmação de download, é necessária nova exportação; não há repetição automática.
- Envios de canais não participam da transação D1. Se o provedor recebeu a mensagem e a confirmação se perdeu, o estado pode ser `unknown`: confira e reconcilie. Deduplicação local não equivale a exatamente uma entrega no provedor.
- PDFs digitalizados sem camada de texto não têm OCR. Importação de vídeos usa apenas legendas públicas/autorizadas. Há limite de 20 MB por arquivo e importações têm limites do runtime Workers.
- Os spools e as sessões QR/Hermes estão no host externo. Monitore disco e preserve-os no backup; esta versão não faz expurgo automático desses diários.
- Não houve teste de carga representativo nem homologação de todos os fornecedores/modelos. Não há garantia de paridade automática com toda personalização privada do WABABOTAI original. As regras migradas cobrem os módulos descritos e os testes deste repositório.
- Histórico antigo não é importado. A cópia de backup deve ser feita com entradas pausadas para consistência entre banco e mídias.

## Reproduzir as verificações

```sh
npm ci
npm run check
npm test
node --test tests/installer.test.mjs tests/updater-build.test.mjs
npm run build
python3 -m pip install httpx
python3 tests/hermes_transport_test.py
```

Os scripts remotos `smoke.mjs` e `validate-examples.mjs` são exclusivos para staging e criam dados sintéticos. `validate-restore.mjs` cria e remove recursos descartáveis novos; use somente a configuração staging e um backup controlado. Os exemplos de execução de bot são opcionais e exigem `WABOTIA_BOT` autorizado.

## Manutenção 0.2.0

17 testes adicionais em workerd verificam autorização, CSRF, idempotência, criptografia, conflitos DNS/Access, ordem da proteção antes do DNS, rotas restritas, interrupções sem repetição e atualização fixada por commit. Dois testes Node verificam preservação da implantação e rejeição de bindings/migrações incompatíveis. As APIs de criação Cloudflare e hooks foram simuladas; isso não equivale à homologação de um novo túnel real pelo assistente.

A interface de diagnóstico foi verificada no Chrome nos estados de espera, sucesso, vazio, falha e timeout, incluindo o atalho à Equipe Bot. O assistente de deploy foi exercitado com dados fictícios.

A atualização 0.2.0 foi publicada em uma instalação existente pelo Cloudflare Builds, com o commit aaea567 confirmado em /api/health e os recursos preservados. O painel autenticado confirmou a conexão e a descoberta de perfis no Hermes real; o bot autorizado permaneceu selecionado e o atendimento pausado. Isso valida o caminho de atualização inicial e o diagnóstico, sem substituir a homologação dos canais ou a criação automática de novos recursos Cloudflare.

0.2.1 ajusta o autocomplete dos campos de credenciais da manutenção para evitar que o gerenciador do navegador os confunda com o login do painel.

0.2.2 corrige o modo de redirecionamento da consulta ao GitHub para o valor suportado por Workers. O teste passou a validar as opções de Request no próprio workerd e reproduziu a falha antes da correção. Um teste adicional recusa redirecionamentos sem guardar uma versão. O script também aceita recuperação manual por SHA completo, com as mesmas verificações de origem oficial e preservação dos recursos; três testes Node passam. 0.2.3 documenta essa recuperação no site e no PDF.


## Instalação direta 0.3.0

O instalador independente foi executado em Linux contra a Cloudflare real, em uma instalação isolada. Criou Worker, D1 e R2, aplicou quatro migrações, publicou três secrets e confirmou o commit no endpoint de saúde. A pasta não contém repositório Git. O teste Node do instalador recusa bancos e buckets preexistentes, incluindo bancos encontrados em páginas posteriores. Windows e macOS têm instruções, mas ainda não foram homologados nesses sistemas.

Cinco testes adicionais em workerd cobrem o pacote oficial, preservação de bindings, identidade da instalação, autorização administrativa, início deduplicado, confirmação pelo código ativo, timeout sem nova publicação, integridade/caminhos, incompatibilidade de Durable Objects e rollback de migração. O tag de migração é lido nos metadados do serviço, porque o endpoint de settings não o retorna.

Os pacotes oficiais usam HTTPS e SHA-256; não têm assinatura assimétrica. Um commit só aparece como atualização depois de publicado no catálogo oficial. O fluxo anterior de Builds continua disponível para instalações que já têm hook configurado.
