| Achado | Veredito | O que mudou | Teste |
|---|---|---|---|
| Nome de aluno exposto | Confirmado e corrigido | `escolas.ts` e `professores.ts`: referência administrativa pública; nome em campo opcional, sensível e interno; instruções corrigidas. | `area-template-ensino.test.ts` e novo `area-template-privacy.test.ts`. |
| Unidade residencial pública | Confirmado e corrigido | `condominios.ts`: unidade privada nos quatro tipos; saudação e orientações de coleta protegida. | `area-template-condominio.test.ts` e privacidade. |
| Identificação residencial no Pós-obra | Confirmado e corrigido | `construtoras.ts`: referência sem endereço, unidade privada e formulário sugerido corrigido. | `area-template-obras.test.ts` e privacidade. |
| Garantia na devolução sem reparo | Confirmado e corrigido | `oficina-mecanica.ts` e `assistencia-tecnica.ts`: encerramento separado com base `cancelled`, orientação de registro da destinação e garantia preservada após reparo. | `area-template-servicos.test.ts`: quatro fluxos de reparo. |
| Lavanderia aceita zero peças | Confirmado e corrigido | `assistencia-tecnica.ts`: mínimo alterado para 1. | `area-template-servicos.test.ts`: rejeição de zero e aceitação de uma peça nas duas variantes. |

Os afastamentos de sigilo foram corrigidos nos três primeiros itens. Garantia e quantidade eram problemas de configuração dos modelos. A revisão não lista suspeitas não confirmadas adicionais.

Verificações aprovadas: `npx tsc --noEmit`, TypeScript dos cinco arquivos de teste, `node scripts/check-os-integration.mjs` (17 modelos, integração e limites D1), guardas de codificação/conflitos e `git diff --check`. Os 11 arquivos alterados estão em UTF-8 sem BOM e LF.

**Outras peças:** nenhuma mudança necessária. Sem migração ou alteração do embutido e dos testes antigos. Vitest permanece para execução externa; registros e snapshots já existentes não foram modificados. Sem dúvidas bloqueantes.