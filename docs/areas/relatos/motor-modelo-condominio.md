Criei somente:

- [condominios.ts](/Volumes/Dev/wabotia/codex/motor-modelo-condominio/src/area-templates/models/condominios.ts): constante tipada `condominiosTemplate`, com quatro tipos, unidade obrigatória, menus, mensagens e passos manuais.
- [area-template-condominio.test.ts](/Volumes/Dev/wabotia/codex/motor-modelo-condominio/tests/area-template-condominio.test.ts): verifica IDs, limites, privacidade, referências, estados válidos, alcançabilidade e caminhos de conclusão/cancelamento.

Verificação: `npx tsc --noEmit` e compilação isolada do teste passaram. Conferidos UTF-8 sem BOM, LF e whitespace. Vitest não foi executado; fica para o script externo.

Sem desvios do contrato. As adaptações do levantamento foram:

- IDs locais válidos e `{identificador}` para numeração com prefixo.
- Estados `approved` sem orçamento convertidos para `in_progress`; aprovações de etapa para visita e solução da ocorrência.
- Unidade obrigatória não sensível; demais campos sensíveis opcionais e privados. Nome do visitante transferido para campo privado.
- Acrescentados encerramentos justificados após entrada/início, preservando histórico, para permitir cancelamento.
- “Morador avisado” passou a “Disponível para retirada”, sem presumir entrega da mensagem.
- Prazos por etapa, automações, configuração dos módulos e menus não suportados ficaram como orientações manuais. Paralisação automática desligada; nenhuma permissão de bot sugerida como liberada.

Ficaram fora a extensão Condomínio, migrações e registros centrais. Vínculos, permissões específicas por tipo e validação de períodos dependem de conferência humana.

O integrador deve acrescentar em `src/area-templates/index.ts`:

```ts
import { condominiosTemplate } from "./models/condominios";
```

E incluir `condominiosTemplate,` na coleção de modelos. A única dúvida de integração é o formato dessa coleção, pois o `index.ts` ainda não existia.