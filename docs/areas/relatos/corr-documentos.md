Corrigi a causa da falha externa: o novo teste copiava a chave R2 do documento sensível ao criar um público, violando o índice único. Agora o público tem chave, tentativa, conteúdo e hash próprios. Todas as asserções foram preservadas.

O relato completo foi atualizado em [INTEGRACAO.md](/Volumes/Dev/wabotia/codex/corr-documentos/src/modules/os/documents/INTEGRACAO.md:42).

| Achado | Veredito | Correção ou evidência | Teste |
|---|---|---|---|
| 1. Acesso pelo telefone antigo | Confirmado e corrigido | Exige telefone verificado igual ao atual, mesmo com conversa vinculada | Bloqueia listagem, download, envio e recebimento; permite titular atual |
| 2. Comando interrompe atendimento do embutido | Confirmado e corrigido | Retorna `false` sem tipos personalizados; trata números indisponíveis sem revelar titularidade | Compatibilidade e recebimento WhatsApp; passaram no log externo |
| 3. Upload preso à concessão vencida | Confirmado e corrigido | Recupera objeto existente ou renova tentativa serializada, considerando recibos antigos | Recuperação, concorrência e preservação dos bytes; passaram no log externo |
| 4. Confirmação não recuperada pelo HTTP | Não é real no estado integrado | Coordinator já reexecuta; motor recupera histórico e publicação | Interrupção após D1 nas rotas comum e privada; passaram no log externo |
| 5. Expectativas de stubs antigos | Não é real no estado integrado | Expectativas já estavam corrigidas no HEAD | Fundação preservada e cobertura com Coordinator real |
| Falha externa: chave R2 duplicada | Confirmado e corrigido | Fixture pública independente | Reprodução SQLite confirmou falha antiga e montagem corrigida |

Os afastamentos relativos a titularidade, embutido e recuperação estão tratados acima. A coleção `private-documents` permanece documentada e coerente com a separação de dados sensíveis. Não havia suspeitas adicionais.

**Validação:** passaram TypeScript do projeto, checagem estrita dos três arquivos de teste, reprodução SQLite, ensaio de integração com 17 modelos e orçamento D1, e `git diff --check`.

O log externo anterior registrou **355 testes aprovados e uma falha**. A suíte após esta correção ainda precisa de execução externa. Não executei Vitest, rede ou commit; não enfraqueci testes nem criei migração.

**Outras peças:** nenhuma mudança pendente; os ajustes centrais necessários já estão integrados.