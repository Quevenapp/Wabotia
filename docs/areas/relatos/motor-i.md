Corrigi as duas causas das três falhas e atualizei o **[relato completo da entrega I](/Volumes/Dev/wabotia/codex/motor-i/docs/areas/I-ENTREGA.md)**.

- **Meus prazos:** a fixture misturava uma OS embutida com um tipo personalizado. Agora cria um pai coerente, preservando integralmente as asserções do teste. Etapas inconsistentes retornam erro controlado.
- **Documentos:** o envio usava `FixedLengthStream` dentro do bloqueio do Coordinator. Agora valida até 10 MiB e grava os bytes diretamente no R2, preservando autorização, integridade e idempotência.

A entrega acumulada inclui registro dos quatro filhos e dos **17 modelos**, rotas administrativas, integração web, conciliação de permissões e campos privados, recuperação de operações, atualização dos quatro testes desatualizados e testes completos de junção/orçamento.

**Passaram localmente:** TypeScript, build, cenários integrados com novas regressões, codificação, conflitos e `git diff --check`. D1 permaneceu dentro dos tetos: **45/200** instruções adicionais dos filhos e **163/800** no alarme completo. A tabela por operação está no relato.

O log externo anterior teve **352 aprovações e 3 falhas**. A confirmação após estas correções ainda depende da nova execução externa; o ensaio local não reproduz o runtime Cloudflare.

Sem commit, rede ou Vitest. Testes legados, fixture congelada, `src/erp/` e produção móvel permanecem intactos.