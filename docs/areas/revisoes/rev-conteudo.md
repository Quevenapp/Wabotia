1. **Grave — nomes de alunos são coletados em campo sem proteção de sensibilidade.**

   **Arquivos:** `src/area-templates/models/escolas.ts:22`, `src/area-templates/models/escolas.ts:323` e `src/area-templates/models/professores.ts:21`.

   **Defeito:** os modelos destinam `item` ao nome do aluno, inclusive menor, embora esse campo permaneça nas respostas comuns e na projeção para IA.

   **Cenário:** um responsável preenche “Ana Silva” na matrícula, solicitação escolar ou acompanhamento de aulas → o nome fica em `item`, fora da proteção dos extras sensíveis. Uma leitura comum do registro o devolve sem exigir `os:sensitive`; a projeção para bot também o preserva (`src/modules/os/privacy.ts:116`). Não é necessário acessar outra família para ocorrer a exposição indevida.

   O levantamento exige proteção do nome equivalente à do cadastro pedagógico (`docs/areas/ensino.md:69`). Os textos “dados de menores **além do nome**” em `escolas.ts:675` e `professores.ts:436` reforçam a classificação errada. O teste em `tests/area-template-ensino.test.ts:180` exige justamente o rótulo problemático.

   **Correção sugerida:** usar uma referência administrativa sem identificação pessoal em `item`; transferir o nome para campo opcional, sensível e interno, coletado pelo canal protegido. Remover a exceção “além do nome” e corrigir o teste. A futura extensão Ensino não corrige, por si só, dados armazenados nesse campo fixo.

2. **Grave — bloco e unidade residencial foram reclassificados como informação pública.**

   **Arquivo:** `src/area-templates/models/condominios.ts:9`.

   **Defeito:** o campo compartilhado pelos quatro tipos pede bloco e número com `required: true`, `client_visible: true` e `sensitive: false`.

   **Cenário:** um morador abre uma ocorrência indicando “Bloco A, 101” → sua localização residencial fica nos extras comuns, disponíveis sem a autorização de leitura sensível e preservados na projeção para IA. O levantamento marca expressamente esse campo como sensível nos quatro tipos (`docs/areas/condominio.md:74`, `:141`, `:218` e `:285`).

   `tests/area-template-condominio.test.ts:187` consolida o erro ao exigir `sensitive: false`. O relato informa a mudança; portanto, trata-se de uma adaptação declarada, mas inadequada, e não de omissão silenciosa.

   **Correção sugerida:** tornar a unidade opcional, sensível e interna; coletá-la e conferi-la pelo atendimento protegido. Se for indispensável exigir unidade já na abertura, aguardar o fluxo específico da extensão. Atualizar saudação, passos manuais e teste para não solicitar essa informação como dado comum.

3. **Grave — o Pós-obra coleta identificação residencial em dois campos públicos.**

   **Arquivos:** `src/area-templates/models/construtoras.ts:517` e `src/area-templates/models/construtoras.ts:538`.

   **Defeito:** “Empreendimento e unidade” ocupa o campo fixo `item`, e “Unidade ou local afetado” também é obrigatório e não sensível.

   **Cenário:** o comprador informa “Residencial Primavera, bloco B, apartamento 302” → a identificação de sua residência permanece tanto no campo fixo quanto no extra público. Proteger apenas o endereço completo da Obra não protege esses dados do chamado de Pós-obra.

   **Correção sugerida:** substituir o rótulo de `item` por referência administrativa sem endereço; tornar a identificação da unidade um extra opcional, sensível e interno. Orientar a coleta protegida e impedir que os textos de abertura incentivem sua duplicação nos campos comuns.

4. **Média — a devolução sem reparo inicia garantia de 90 dias.**

   **Arquivos:** `src/area-templates/models/oficina-mecanica.ts:51`, `src/area-templates/models/oficina-mecanica.ts:66` e `src/area-templates/models/assistencia-tecnica.ts:283`, `:564` e `:845`.

   **Defeito:** os fluxos de eletrônicos, eletrodomésticos e veículos usam a mesma conclusão com garantia para serviços executados e devoluções após orçamento recusado.

   **Cenário:** orçamento recusado → `pronto`, sem reparo → `entregue` → o motor grava `warranty_until` com mais 90 dias, pois calcula a garantia em toda entrada em `delivered` (`src/modules/os/stages.ts:43`), independentemente de execução.

   A limitação está declarada no modelo e no relato da Oficina, mas continua presente na configuração entregue.

   **Correção sugerida:** separar a devolução sem reparo em caminho de encerramento com base `cancelled`, rótulo adequado e registro da destinação do bem. Reservar a conclusão que inicia garantia ao serviço efetivamente executado. Se essa separação não representar o negócio, desativar a garantia automática até existir regra adequada.

5. **Média — a lavanderia incluída em Assistência técnica aceita lote com zero peças.**

   **Arquivo:** `src/area-templates/models/assistencia-tecnica.ts:903`.

   **Defeito:** `quantidade` é obrigatória, mas seu mínimo é zero.

   **Cenário:** o cliente escolhe lavagem e informa quantidade `0`, preenchendo os demais campos → a abertura é válida; o validador aceita inteiros iguais ao mínimo (`src/modules/os/validation.ts:194`). O registro pode seguir para execução e entrega sem nenhuma peça.

   Isso contraria `docs/areas/servicos.md:251` e diverge do modelo equivalente, que usa mínimo 1 em `src/area-templates/models/lavanderia-costura.ts:18`. O relato de Assistência técnica não aponta essa alteração. A coleção de `tests/area-template-servicos.test.ts:9` não inclui esse modelo.

   **Correção sugerida:** alterar o mínimo para 1 e incluir a variante de Assistência técnica na verificação de conteúdo, com rejeição explícita de quantidade zero.

**Partes sem achados**

- **Jurídico: nada encontrado.** Lidos integralmente Advogados, Escritório de advocacia e o teste jurídico, confrontados com o levantamento e o relato. As diferenças entre profissional individual e escritório estão justificadas; as instruções não autorizam orientação jurídica ou promessa de resultado.
- **Engenheiros e Arquitetos: nada encontrado.** Lidos os dois modelos completos, suas diferenças e o teste de Obras. As diferenças de serviços e configuração correspondem ao levantamento.
- **Saúde: nada encontrado.** Lidos Clínica médica, Clínica veterinária e o teste de Saúde. Não há campos clínicos de queixa detalhada, diagnóstico, prescrição ou resultado de exame; as instruções vedam aconselhamento clínico e explicitam os limites administrativos.
- **Serviços, Lavanderia e costura, Gráfica, Despachante e Imobiliária: nada encontrado no conteúdo desses modelos.** Lidos os arquivos completos e o teste de Serviços. As limitações de versões de documentos, conferências e configuração manual estão declaradas.
- **Estrutura dos fluxos, mensagens e menus: nada encontrado nos demais critérios solicitados.** Na leitura dos modelos, não identifiquei etapas ativas sem saída, destinos inexistentes, ausência de conclusão ou cancelamento, marcadores inexistentes, erros relevantes de português ou itens de menu sem ação possível. Considerei também as transições próprias do orçamento.
- Os seis testes foram lidos, **não executados**. Além dos casos apontados, não confirmei omissão importante dos levantamentos que estivesse sem aviso nos relatos ou passos manuais.

**Prontidão por modelo**

“Pronto” considera o escopo administrativo declarado e a realização dos passos manuais previstos.

| Modelo | Nota | Motivo |
|---|---|---|
| Advogados | **pronto** | Fluxos administrativos coerentes; decisões e prazos jurídicos permanecem humanos. |
| Escritório de advocacia | **pronto** | Distribuição e revisão pela equipe estão explicitadas. |
| Engenheiros | **pronto** | Conferências técnicas, documentos e medições têm limites manuais declarados. |
| Arquitetos | **pronto** | Fluxo coerente com projeto e vistoria, sem substituir aprovação técnica. |
| Construtoras | **não usar ainda** | Corrigir a exposição da identificação residencial no Pós-obra. |
| Clínica médica | **precisa de ajuste** | Preparar o canal protegido e verificar o isolamento antes de ativar IA; uso exclusivamente administrativo. |
| Clínica veterinária | **precisa de ajuste** | Mesma preparação de privacidade; revisar os tipos opcionais arquivados antes de ativá-los. |
| Escolas | **não usar ainda** | O nome do aluno escapa da proteção exigida para menores. |
| Professores | **não usar ainda** | O atendimento previsto inclui menores, mas o nome fica no campo comum. |
| Condomínios | **não usar ainda** | Unidade residencial pública nos quatro tipos. |
| Assistência técnica | **precisa de ajuste** | Corrigir garantia sem reparo e quantidade zero na variante de roupas. |
| Oficina mecânica | **precisa de ajuste** | Separar encerramento sem reparo da conclusão que inicia garantia. |
| Lavanderia e costura | **pronto** | Quantidade positiva e conferência humana de preço e data explicitadas. |
| Serviços | **pronto** | Aprovação e confirmação de escopo estão previstas, com exceções humanas. |
| Gráfica | **pronto** | Aprovações de orçamento e arte separadas; controle manual da versão está declarado. |
| Despachante | **pronto** | Documentos protegidos e ausência de promessa de prazo ou resultado oficial. |
| Imobiliária | **pronto** | Escopo limitado ao atendimento; não promete reserva, financiamento ou transferência. |

## Afastamentos do contrato

- **Uso de campos fixos para conteúdo sensível:** nome do aluno em Escolas e Professores e identificação residencial no Pós-obra contrariam a regra 11 de `docs/areas/CONTRATO-MOTOR.md:379`. A consequência é conservar esses valores nas projeções comuns.
- **Proteção de endereço residencial:** a classificação pública de unidade nos achados 2 e 3 contraria a exigência de sensibilidade desta revisão. No Condomínio, também rebaixa expressamente a classificação do levantamento. A restrição do contrato a campos sensíveis obrigatórios deve ser resolvida mudando a coleta, sem remover a proteção.
- **Distinção:** quantidade zero diverge do levantamento de Serviços; garantia sem reparo é configuração inadequada sobre um cálculo que segue o contrato do motor. Não são falhas do mecanismo de cálculo ou validação.

**Arquivos lidos inteiros:** `src/area-templates/models/advogados.ts`, `arquitetos.ts`, `assistencia-tecnica.ts`, `clinica-medica.ts`, `clinica-veterinaria.ts`, `condominios.ts`, `construtoras.ts`, `engenheiros.ts`, `escolas.ts`, `escritorio-advocacia.ts`, `exemplos.ts`, `lavanderia-costura.ts`, `oficina-mecanica.ts`, `professores.ts`, `servicos.ts` — todos no mesmo diretório; `tests/area-template-condominio.test.ts`, `tests/area-template-ensino.test.ts`, `tests/area-template-juridico.test.ts`, `tests/area-template-obras.test.ts`, `tests/area-template-saude.test.ts`, `tests/area-template-servicos.test.ts`; `docs/areas/F0-ENTREGA.md`; `docs/areas/relatos/motor-a.md`, `motor-modelo-condominio.md`, `motor-modelo-ensino.md`, `motor-modelo-juridico.md`, `motor-modelo-obras.md`, `motor-modelo-saude.md`, `motor-modelo-servicos.md` — todos no diretório de relatos; `src/modules/os/privacy.ts` e `src/modules/os/forms.ts`.