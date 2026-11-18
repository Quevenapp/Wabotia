Corrigi a causa em [common.ts](/home/bruno/wabotia/codex/ext-condominio/src/modules/condominio/common.ts:35): a checagem de escopo ocorria antes da recusa de atores não humanos, produzindo `missing_scope` onde o teste exige `forbidden`. A ordem foi corrigida, mantendo as verificações de módulo, área e papel. Nenhum teste foi alterado.

O [relato completo atualizado](/home/bruno/wabotia/codex/ext-condominio/docs/CONDOMINIO.md) consolida toda a entrega:

- Cadastro de blocos, unidades, moradores com papel e período, telefone verificado com múltiplas unidades, veículos e animais.
- Integração de ocorrências, encomendas e visitantes com OS, preenchendo a unidade validada.
- Portaria limitada às operações autorizadas; portal do morador com seleção de unidade e proteção contra acesso ao histórico de outros ocupantes.
- Comunicados por condomínio, bloco ou unidades, com aprovação, deduplicação, revalidação e envio pela fila do atendimento.
- Assembleias com convocação, pauta, presença, procuração, habilitação, voto único por unidade, apuração agregada e ata. Fração ideal e bloqueio de inadimplentes começam desligados.
- Painel, portal, três migrações (`0115`–`0117`), 17 tabelas e 28 testes funcionais: **20 arquivos novos**, sem modificar arquivos versionados.

A validação ficou assim:

| Verificação | Resultado |
|---|---|
| Log externo anterior à correção | 27/28 aprovados |
| Reprodução offline da falha | Confirmada antes da correção |
| Verificação dirigida após corrigir | 35 cenários de autorização aprovados |
| TypeScript instalado, `--noEmit` | Aprovado |
| Migrações em SQLite em memória | Aprovadas |
| Sintaxe, codificação e conflitos | Aprovados |
| Integridade dos testes | 763 arquivos idênticos por SHA-256 |

**Não executei Vitest.** Os 28 testes precisam ser repetidos externamente após a correção; a verificação dirigida usa contexto e banco instrumentados e não substitui Cloudflare.

As [linhas exatas para o integrador](/home/bruno/wabotia/codex/ext-condominio/docs/CONDOMINIO.md:81) estão documentadas para `registry.ts`, `runtime.ts`, `workspace-navigation.ts`, `routes.ts`, `AdminArea.tsx` e `main.tsx`. Os registros centrais continuam pendentes conforme a regra da tarefa; `registerCondominio()` concentra rotas, comandos, menu, credencial e agendador.

Os afastamentos do rascunho estão explicitados: identidade individual com telefone exclusivo, credencial temporária existente, procuração por referência privada, comunicado completo no portal com aviso genérico no WhatsApp e integração de criação/transição por `ctx.run`. Ficaram fora rateio e prestação de contas — com integração futura documentada —, reservas, documentos institucionais, upload de procurações, quórum automático, retenção automática e controle físico de acesso. Navegação integrada e custo do alarme completo ainda precisam ser verificados.

Não houve commit, push ou execução de Wrangler. Registro uma ocorrência: o `npx`, mesmo configurado offline, tentou consultar atualizações do npm; falhou com `EAI_AGAIN`, sem consulta externa concluída. A compilação aprovada foi executada diretamente pelo TypeScript instalado.