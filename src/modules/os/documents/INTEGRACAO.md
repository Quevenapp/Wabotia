# Tarefa D — documentos

Nenhum arquivo central foi alterado. O descritor `documentsExtension` é a única entrada de registro. Importá-lo não registra ganchos.

## Integração já presente

`src/modules/os/extensions.ts:46` importa o descritor e a lista `osExtensions` já o inclui. `src/modules/os/definition.ts:74` declara os três eventos de documentos; sua lista `bot.deny` inclui `os.private`, `os.document.upload` e `service-orders/:id/private-documents`. Não há inclusão central pendente nesta peça.

O papel explícito `os:sensitive` pertence a M/I. O runtime de F0 registra leituras, escritas, ferramentas, binários, manutenção e turnos dos descritores, sem outro agendador. A rota GET de documentos por conversa consta na lista de credenciais limitadas em `src/index.ts`.

## Contrato e escolhas locais

- `0103_os_documents.sql` reproduz exatamente o bloco DDL do contrato. Sua FK depende do índice composto de `0100`, de M. Os testes isolados conservam seu índice equivalente apenas no banco de teste.
- As rotas normativas comuns permanecem em `service-orders/:id/documents`. Dados sensíveis usam a coleção adicional `service-orders/:id/private-documents`, com as mesmas operações de reserva, conteúdo, confirmação e arquivamento, mas sem envio. Até uma pessoa com o papel precisa usar essa rota. Operações privadas começam por `os.private.document`. A rota comum omite sensíveis e responde 404 no download deles; `/send` responde 403 `document_not_shareable`.
- O contrato não enumerava MIME permitidos. A lista explícita fica em `model.ts`: PDF, JPEG, PNG, WebP, texto simples, DOC, XLS, DOCX, XLSX e PPTX. Não há inspeção antivírus nem conversão. O download força anexo, `no-store`, `nosniff` e CSP restritiva.
- `features.documents` e a classificação da linha controlam a permissão. O DTO congelado não tem política adicional por MIME, tipo ou destinatário; nenhuma assinatura foi alterada.
- O transporte conserva a versão da reserva; `/complete` a incrementa. Concessões e confirmações técnicas usam comandos do Coordinator e CAS, sem publicar histórico de conteúdo. Reserva, confirmação de negócio e arquivamento usam `commitChild` com nomes de campos e códigos de evento.
- O recibo técnico pode ficar sem resposta após interrupção. O adaptador recupera somente a tentativa persistida para a mesma área, ator, documento e chave. Se o objeto existe mas o registro técnico falhou, verifica os bytes mesmo após vencer a concessão de cinco minutos, dentro das 24 horas da reserva. Sem objeto, renova a mesma tentativa no Coordinator; um novo recibo técnico evita reutilizar a resposta antiga de `begin`, mantendo a chave lógica do upload e o PUT condicional. O WhatsApp já está serializado e usa seu despacho direto. `/complete` relê o R2 e confirma tamanho/hash/estado no mesmo `ChildMutation`. A recuperação do recibo de negócio e da publicação usa o suporte integrado de F0/M, sem escrita D1 no Worker.
- Os objetos ficam em `os-documents/<área>/staff|sensitive/<ordem>/<documento>/<tentativa>`, nunca em `media`. PUT condicional impede sobrescrita. A manutenção aborta reservas expiradas e varre órfãos, com margem de 24 horas e cinco minutos para objetos de tentativas perdidas. Seu cursor fica em `os-document-maintenance/<área>/cursor`, no R2 existente. Documentos confirmados, mesmo arquivados, não são eliminados.
- A ferramenta `os_documentos` só lista metadados públicos pela conversa autenticada. Listagem por conversa, envio e recebimento exigem telefone verificado não vazio e igual ao telefone atual normalizado da ordem, mesmo quando a conversa ainda está vinculada ao pai. A entrada de WhatsApp exige `DOCUMENTO <número_global>` e anexo resolvido pelo adaptador da mesma mensagem. A área só com o embutido preserva o tratamento anterior de anexos e comandos, inclusive números inexistentes e de terceiros. Em áreas com tipos personalizados, esses números recebem a mesma resposta controlada, sem revelar a existência da ordem.

Esses detalhes completam pontos não especificados no contrato (nome da coleção privada, MIME, cursor de limpeza e recuperação do recibo F0). Não há alteração de assinatura, tabela extra, nova classe de Durable Object ou recurso Cloudflare.

## Verificação e limites

Os testes próprios são `tests/os-documents.test.ts`, `tests/os-document-privacy.test.ts` e `tests/os-document-recovery.test.ts`. Os dois primeiros usam a fixture comum intacta, autorização real do embutido e substituições locais explícitas para o tipo personalizado e `commitChild`. O SQL da filha executa no D1 da fixture. O terceiro usa HTTP, Coordinator e `commitChild` reais: cobre recibos técnicos antigos, concessão vencida e interrupção da publicação após confirmação no D1, nas coleções comum e privada. Uma trigger temporária do teste provoca a falha de publicação e é removida em `finally`; não há migração de produção.

Nesta rodada, `npm_config_offline=true npx --no-install tsc --noEmit` passou usando a instalação local. Os três arquivos de teste também passaram por checagem TypeScript estrita adicional, com configuração temporária removida ao final. `git diff --check` passou. O ensaio existente `node scripts/check-os-integration.mjs` passou, incluindo os 17 modelos, fluxo integrado, recuperação, regressões de prazos/anexos e orçamento D1 (filhos: 45; alarme: 163). Ele não executa os novos testes desta revisão nem substitui o runtime Cloudflare.

O log externo recebido (`.codex-verificacao.log`) registra 355 testes aprovados e uma falha, em 26 arquivos: a fixture do novo cenário de telefone corrigido copiava `r2_key` do documento sensível ao criar um público, violando `UNIQUE(profile_id,r2_key)` antes das asserções de autorização. A correção dá ao documento público tentativa, chave, bytes e SHA-256 próprios. Todas as expectativas de segurança foram mantidas. Um ensaio Node/SQLite executou os trechos reais de montagem e inserção dessa fixture com o DDL de `0103`, conferiu os dois objetos e o hash e reproduziu a falha ao reutilizar a chave antiga.

Os quatro testes HTTP/Coordinator de recuperação passaram no log externo. As mensagens `document_publication_interrupted` são falhas intencionais da trigger desses testes, que verificam a retomada sem duplicar histórico/evento; não são a causa da reprovação.

Não houve execução de Vitest, Wrangler, rede ou commit nesta tarefa. A suíte após a correção da fixture ainda precisa ser executada externamente:

```sh
npx vitest run tests/os-documents.test.ts tests/os-document-privacy.test.ts tests/os-document-recovery.test.ts
```

A lista de MIME é a decisão de produto ainda a confirmar; outros formatos podem ser acrescentados nesta filha quando definidos.

## Relato completo da correção

| Achado | Veredito | O que mudou ou evidência | Teste |
|---|---|---|---|
| 1 — Documento enviado/consultado pela conversa do telefone antigo (grave) | Confirmado e corrigido | `access.ts:29` exige telefone verificado não vazio, normalizado e igual ao atual da ordem; o vínculo antigo não dispensa a conferência. Envio, listagem, download e recebimento passam por essa autorização. | `tests/os-document-privacy.test.ts:107`: telefone divergente/ausente, bloqueio antes de ler R2/abrir anexo/criar mídia/mutar, rota HTTP negada e listagem permitida ao titular atual. A fixture inválida deste cenário foi corrigida nesta rodada; sua execução Cloudflare continua pendente. |
| 2 — Comando DOCUMENTO interrompe o atendimento do embutido (grave) | Confirmado e corrigido | `delivery.ts:87` retorna `false` em áreas sem tipos personalizados, inclusive números inexistentes/de terceiros. Em áreas com tipos personalizados, números indisponíveis recebem a mesma resposta controlada, sem revelar a existência da ordem. | `tests/os-documents.test.ts:158` cobre anexos, números válidos/inexistentes/de terceiros/inválidos e ausência de anexo; `:706` cobre recebimento autorizado e respostas indistinguíveis. Aprovados no log externo. |
| 3 — Repetição presa à concessão vencida (médio) | Confirmado e corrigido | `transport.ts:76` renova a tentativa por comando serializado; o transporte recupera bytes existentes antes de exigir concessão para escrever. Sem objeto, usa novo recibo técnico, conservando a chave lógica, a tentativa e o PUT condicional. WhatsApp fornece seu despacho já serializado. | `tests/os-documents.test.ts:376`, `:435`, `:461`, `:517`; `tests/os-document-recovery.test.ts:56` e `:74` exercitam HTTP/Coordinator reais, recibos antigos e sem resposta, renovação repetida e preservação dos bytes. Aprovados no log externo. |
| 4 — Confirmação não recuperada pelo HTTP (médio) | Não é real no estado integrado atual; já resolvido por F0/M | `src/coordinator.ts:231` já permite repetir reserve/complete/archive comuns e privados com recibo incompleto. `src/modules/os/mutations.ts:37` recupera histórico e republica antes de verificar a versão. Nenhum arquivo central foi alterado. | Acrescentado `tests/os-document-recovery.test.ts:96`: trigger interrompe após D1, repetição da mesma chave recupera resposta e produz um único histórico/evento, tanto comum quanto privado. Ambos aprovados no log externo. |
| 5 — Testes ainda exigem stubs not_implemented (médio) | Não é real no estado integrado atual; expectativas já corrigidas | `tests/os-documents.test.ts:158` já exigia `type_not_found`, `version_conflict`, `feature_disabled` e `module_disabled` antes desta tarefa. Conferido também no HEAD. Nenhuma expectativa foi afrouxada. | Cenário de fundação mantido e ampliado para compatibilidade do embutido; confirmação/repetição pelo commitChild real coberta no novo arquivo de recuperação. Aprovados no log externo. |
| Falha da verificação externa — chave R2 duplicada na fixture | Confirmado e corrigido | `tests/os-document-privacy.test.ts:116` cria documento público independente, com chave gerada por `objectKey`, bytes públicos e hash correspondente; preserva o documento sensível original e todas as asserções. | Reprodução Node/SQLite com os trechos reais da fixture: montagem corrigida passa; reutilizar chave antiga falha pelo mesmo índice único. Reexecução Cloudflare pendente. |
| Afastamentos: titular, compatibilidade do embutido e recuperação | Confirmados e corrigidos; recibo de negócio já resolvido na integração | Correspondem aos achados 1–4, sem mudança de contrato, migração ou comportamento pretendido do embutido. | Mesmos cenários acima. |
| Coleção adicional private-documents | Não é real como defeito; afastamento de superfície documentado e mantido | A coleção comum omite/recusa sensíveis; a privada exige pessoa com papel explícito, coerente com a separação da seção 6 do contrato. | `tests/os-document-privacy.test.ts:170`, `:201`, `:234`, `:290`, `:336`, `:399`: rotas comuns/privadas, papéis, apps/bots/via, mídia, titular e cursores. Aprovados no log externo. |

Não há suspeitas adicionais no arquivo de revisão. As partes registradas sem achados adicionais (isolamento por área/pai, sigilo, MIME/limites/hash, limpeza e migração) permanecem sem mudança fora dos pontos descritos. Não houve migração nova nem alteração nos testes antigos de ordens/WhatsApp ou nas fixtures compartilhadas.

## Mudanças para outras peças

Nenhuma mudança pendente: a recuperação de recibos em `src/coordinator.ts`, a recuperação/publicação em `src/modules/os/mutations.ts` e o registro central de documentos já estão integrados. Esses arquivos foram apenas lidos. Todas as alterações desta tarefa ficam em `src/modules/os/documents/*` e `tests/os-document*.test.ts`.
