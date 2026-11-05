# Validação e limites da versão 0.1.0

Data: 04/11/2026. A implementação é uma versão inicial de código aberto. **Ainda não foi homologada ponta a ponta com contas reais de WhatsApp, Telegram e perfis Hermes nesta implantação.** Credenciais, perfis e destinatários de teste precisam ser escolhidos pelo proprietário.

## O que foi verificado

| Área | Evidência | Resultado |
|---|---|---|
| Runtime | Vitest com `@cloudflare/vitest-plugin`, D1/R2/DO em workerd | 44 testes passam; provedores externos simulados |
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

O formulário oficial Deploy to Cloudflare reconheceu o repositório, D1, R2, os dois secrets e os comandos build/deploy. A publicação executada foi manual por Wrangler, incluindo provisionamento e migrações. Não foi criada uma segunda instalação via botão. O site e a configuração inicial estão publicados em https://wabotia.queven.app.

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
npm run build
python3 -m pip install httpx
python3 tests/hermes_transport_test.py
```

Os scripts remotos `smoke.mjs` e `validate-examples.mjs` são exclusivos para staging e criam dados sintéticos. `validate-restore.mjs` cria e remove recursos descartáveis novos; use somente a configuração staging e um backup controlado. Os exemplos de execução de bot são opcionais e exigem `WABOTIA_BOT` autorizado.

## Manutenção 0.2.0

17 testes adicionais em workerd verificam autorização, CSRF, idempotência, criptografia, conflitos DNS/Access, ordem da proteção antes do DNS, rotas restritas, interrupções sem repetição e atualização fixada por commit. Dois testes Node verificam preservação da implantação e rejeição de bindings/migrações incompatíveis. As APIs de criação Cloudflare e hooks foram simuladas; isso não equivale à homologação de um novo túnel real pelo assistente.

A interface de diagnóstico foi verificada no Chrome nos estados de espera, sucesso, vazio, falha e timeout, incluindo o atalho à Equipe Bot. O assistente de deploy foi exercitado com dados fictícios.
