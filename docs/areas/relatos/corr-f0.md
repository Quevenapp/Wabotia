Corrigi a causa da falha: o novo teste alterava `os_work_types` sem fornecer a revisão obrigatória. Acrescentei `settings_revision: await settingsRevision(env, f.profile)` em [os-foundation.test.ts:659](/Volumes/Dev/wabotia/codex/corr-f0/tests/os-foundation.test.ts:659), preservando todas as asserções.

Relato completo atualizado:

| Achado | Veredito | O que mudou | Teste |
|---|---|---|---|
| **1 — Exceção em uma extensão interrompia as seguintes** | Confirmado e corrigido | `extension-runtime.ts` trata falhas por extensão, conserva o SQL consumido, executa os próximos filhos com o saldo disponível e solicita continuação antes de propagar erro sem conteúdo sensível. | Novos testes de falha parcial e orçamento esgotado; ambos passaram na verificação externa recebida. |
| **1 — Falha do lembrete legado impedia o agregador** | Confirmado e corrigido | `hooks.ts` executa o agregador em `finally`, mantendo a falha visível ao agendador. | Novo teste de falha do gancho legado; passou na verificação externa recebida. |
| **2 — Alarme antecipado perdia a continuação de `has_more`** | Confirmado e corrigido | `api.ts` permite `wake({ modules: true })`. O Coordinator persiste `modules_pending`, conserva a pendência nos alarmes antecipados e agenda a próxima rodada respeitando `modules_tick + 60.000 ms`. | Novo teste com onze documentos, alarme antecipado e outra área. Preparação corrigida nesta rodada; execução externa ainda pendente. |
| **Afastamento contratual — isolamento entre extensões** | Confirmado e corrigido | Resolvido pelo tratamento individual das falhas e pela execução garantida do agregador. | Cobertura do achado 1. |
| **Afastamento contratual — continuação prometida** | Confirmado e corrigido | Resolvido pela pendência durável e pelo reagendamento no intervalo permitido. | Cobertura do achado 2. |
| **Falha registrada no log — ausência de `settings_revision`** | Confirmado e corrigido | O teste agora informa a revisão real da configuração; a validação do serviço permanece intacta. | Mesmo teste, com todas as expectativas preservadas. |

A revisão `rev-f0.md` não lista suspeitas não confirmadas adicionais.

Validação atual:

- `npm_config_offline=true npx --no-install tsc --noEmit`: passou.
- `git diff --check`: passou.
- Comparação estrutural confirmou os **16 testes preexistentes de fundação integralmente preservados**, com quatro novos testes.
- O log externo anterior registra **353 testes aprovados e uma falha**, corrigida acima. Também registra aprovação dos testes legados de OS/WhatsApp e do orçamento D1, com **163 instruções no alarme completo**. Não executei Vitest nesta rodada; não há confirmação dinâmica posterior à correção.

**Mudanças para outras peças:** nenhuma. As alterações estão restritas aos cinco arquivos autorizados de F0. Nenhuma migração, commit ou acesso à rede foi realizado.