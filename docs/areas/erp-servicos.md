O perfil **“só serviços” exige uma pequena camada de configuração e apresentação sobre o ERP atual**. Não exige outro motor, outro papel de acesso nem outro módulo financeiro. O papel `financeiro` já oferece boa parte da separação necessária, mas ainda permite consultar documentos comerciais. O menu também não usa as permissões finas para decidir todos os destinos. (`src/erp/domains/documents/public.ts:70`; `web/erp/app/lib/origin-menu.ts:207`.)

Análise da cópia informada como commit `efc7e54`, versão `0.21.1`, em 18/11/2026. Foram feitas apenas leituras locais. Não houve alteração de arquivos, acesso à rede ou execução de testes. As propostas abaixo não são funcionalidades já implementadas.

**1. A separação atual combina acesso, configuração e disponibilidade do porte.**

| Camada | Como funciona hoje | Consequência para “só serviços” | Evidência |
|---|---|---|---|
| Módulo por área | Há um núcleo `erp` e três opcionais: `erp-fiscal`, `erp-cobranca` e `erp-pdv`. Os opcionais dependem do núcleo. | É possível desligar PDV e Fiscal. Não há chave própria para desligar produtos, compras ou estoque dentro do núcleo. | `src/modules/erp/definition.ts:15`; `src/modules/erp/definition.ts:29`; `src/modules/erp/definition.ts:88` |
| Bloqueio dos opcionais no servidor | A classificação das rotas identifica o bloco. O encaminhamento exige que o opcional esteja ligado. | Desligar um opcional afeta a API, além do menu. | `src/erp/blocks.ts:11`; `src/erp/api/local-fetch.ts:168` |
| Papel da pessoa | Existem `admin`, `consulta`, `vendas`, `financeiro`, `estoque` e `fiscal`. O acesso aceita um só papel do ERP por pessoa. | Não é preciso criar um papel profissional para cada área de atividade. | `src/modules/erp/definition.ts:50`; `src/access.ts:324` |
| Recursos do papel | `financeiro` recebe `contacts`, `receivables` e `payables`. Outros papéis recebem combinações diferentes. | Já restringe o catálogo disponível ao financeiro. Não representa sozinho todas as permissões do ERP. | `src/erp/domains/access/public.ts:82` |
| Permissões finas | O administrador passa nas permissões conhecidas. Para outros usuários, uma lista configurada exige a chave e seu pai. Sem lista, essa camada não restringe. | Serve para limitar operações dentro do papel. Não substitui a checagem do papel. | `src/erp/domains/access/public.ts:129` |
| Menu principal | Cada destino pode exigir papel ou recurso. Também passa pelo filtro de blocos e disponibilidade. | O menu principal não consulta diretamente a lista de permissões finas do usuário. | `web/erp/app/lib/origin-menu.ts:205`; `web/erp/app/lib/origin-menu.ts:221` |
| Agrupamento do menu | Os destinos já autorizados são agrupados em Resultados, Comercial, Compras, Catálogo, Estoque, Financeiro, Fiscal e Pessoas. O papel muda a ordem de destaque. | Para `financeiro`, Financeiro e Comercial vêm primeiro. Essa ordenação não elimina o Comercial. | `web/erp/app/lib/fagoo-menu.ts:4`; `web/erp/app/lib/fagoo-menu.ts:10`; `web/erp/app/lib/fagoo-menu.ts:19` |
| Entrada direta nas telas | A casca verifica o bloco e faz verificações de papel para várias telas. | Esconder um link não é suficiente para controlar a abertura por endereço. | `web/erp/app/components/RealAccess.tsx:106`; `web/erp/app/components/RealAccess.tsx:107` |
| Ações dentro das telas | O Financeiro recebe `read`, `write` e permissões finas. A tela usa essas informações para oferecer ações. O servidor também verifica permissões. | É possível permitir consulta e restringir inclusão, exclusão ou outras operações. | `src/erp/domains/finance/rpc/erp_finance_access.ts:8`; `web/erp/app/components/RealFinance.tsx:626`; `src/erp/domains/finance/internal.ts:248` |
| Preferências | Cada página tem papéis leitores. Preferências da empresa exigem administrador para gravação; preferências pessoais pertencem ao usuário. | Há infraestrutura para guardar um perfil de apresentação da empresa. | `src/erp/domains/preferences/rpc/erp_preferences_core.ts:17`; `src/erp/domains/preferences/rpc/erp_preferences_core.ts:48` |
| Preferências de apresentação existentes | Há tema pessoal, seleção de gráficos e atalhos da página inicial. | Permitem ajustes locais. Não constituem um perfil completo de atividade. | `packages/erp-domain/src/preferences/pages/sistema-interface.mjs:4`; `src/erp/domains/preferences/rpc/erp_home_settings.ts:29`; `src/erp/domains/preferences/rpc/erp_home_settings.ts:198` |
| Disponibilidade do porte | `MOTOR_PENDING` retira destinos ainda sem atendimento pelo motor. Por endereço, aparece a indicação de implantação. | Uma tela ausente pode estar pendente de porte, mesmo com módulo e papel autorizados. | `web/erp/motor.ts:1`; `web/erp/motor.ts:14`; `web/erp/blocks.ts:91` |

Há uma limitação relevante nesta base: **o cadastro de contatos está marcado como pendente no painel real**, assim como sua importação. Contas a receber, contas a pagar e caixas e bancos constam como disponíveis. Portanto, a presença de regras de acesso para contatos não prova que o fluxo completo de cadastro já esteja liberado nesta versão. (`web/erp/motor.ts:18`; `web/erp/motor.ts:25`; `web/erp/motor.ts:51`.)

**2. A configuração atual resolve parte da limpeza, mas não entrega o perfil completo.**

| Objetivo | Só configuração? | Resultado e limite |
|---|---|---|
| Retirar a frente de caixa | Sim: desligar `erp-pdv`. | O bloco tem classificação própria no painel e na API. O caixa financeiro permanece no núcleo. (`web/erp/blocks.ts:39`; `src/erp/blocks.ts:21`; `web/erp/app/lib/origin-menu.ts:77`.) |
| Retirar o Fiscal | Sim: desligar `erp-fiscal`. | Retira os destinos desse bloco e bloqueia suas rotas. Isso não remove contas a pagar ou receber. (`web/erp/blocks.ts:17`; `src/erp/blocks.ts:28`.) |
| Retirar remessas e retornos bancários | Sim: desligar `erp-cobranca`. | A baixa manual de títulos continua prevista no financeiro. (`src/modules/erp/definition.ts:96`; `web/erp/blocks.ts:32`.) |
| Retirar produtos e estoque do acesso cotidiano de uma pessoa | Parcialmente: usar `erp:financeiro`. | Esse papel não recebe o recurso `products` nem consta entre os leitores da tela de estoque. Não vale para um administrador, que mantém acesso amplo. (`src/erp/domains/access/public.ts:82`; `web/erp/app/components/RealAccess.tsx:107`.) |
| Retirar compras, propostas, pedidos e a OS comercial | Não por completo. | O papel financeiro pode ler os quatro tipos de documento. O menu oferece compras, vendas, propostas e OS para esse papel. (`src/erp/domains/documents/public.ts:67`; `web/erp/app/lib/origin-menu.ts:46`; `web/erp/app/lib/origin-menu.ts:63`.) |
| Restringir ações financeiras | Sim, dentro das operações que verificam permissões. | Há permissões para contas, caixa e outras operações. Isso não garante que todos os links do menu desapareçam. (`src/erp/domains/finance/internal.ts:282`; `src/erp/domains/finance/rpc/erp_finance_access.ts:14`; `web/erp/app/lib/origin-menu.ts:207`.) |
| Limpar gráficos e atalhos pessoais | Parcialmente. | Existem configurações por usuário. Elas não alteram toda a navegação da empresa. (`src/erp/domains/preferences/rpc/erp_home_settings.ts:34`; `src/erp/domains/preferences/rpc/erp_home_settings.ts:216`.) |
| Aplicar a mesma experiência enxuta ao administrador | Exige código. | O administrador passa pelas permissões finas. É necessária uma escolha de apresentação independente do papel. (`src/erp/domains/access/public.ts:133`.) |
| Trocar o vocabulário e retirar ações comerciais dentro de telas mantidas | Exige código. | Há rótulos e controles próprios nos componentes, como “Cliente ou Fornecedor” e os botões financeiros. Um filtro no menu não altera esses componentes. (`web/erp/app/components/ContactEditor.tsx:157`; `web/erp/app/components/RealFinance.tsx:626`.) |

Uma configuração inicial possível é `erp` ligado, `erp-pdv` desligado, `erp-fiscal` desligado e `erp-cobranca` conforme a necessidade bancária. Os operadores financeiros recebem `erp:financeiro`. Essa composição reduz a interface, mas ainda deixa documentos comerciais acessíveis. (`src/modules/erp/definition.ts:88`; `src/modules/erp/definition.ts:104`; `src/erp/domains/documents/public.ts:76`.)

**3. A proposta é um perfil de apresentação da área, separado dos papéis.**

Recomendo uma preferência da empresa com dois valores: **Completo** e **Só serviços**. O padrão continua Completo. O modelo de área sugere Só serviços na prévia de aplicação.

A preferência deve aproveitar o mecanismo existente de configuração da empresa. A página Empresa → Geral já tem escopo `company`, e o servidor já reserva a gravação desse escopo ao administrador. (`packages/erp-domain/src/preferences/pages/empresa-geral.mjs:8`; `src/erp/domains/preferences/rpc/erp_preferences_core.ts:58`.)

| Tela ou grupo | Proposta para Só serviços | Ações oferecidas |
|---|---|---|
| Início | Manter uma visão financeira. | Vencimentos, saldos e atalhos para contas e clientes. Retirar indicadores comerciais sem uso. |
| Clientes e contatos | Manter. | Consultar, cadastrar e editar conforme o acesso. Manter identificação, endereço e dados de cobrança. |
| Fornecedores de despesas | Manter dentro de Contatos. | Cadastrar quem recebe pagamentos, sem abrir o fluxo de compras e estoque. |
| Contas a receber | Manter. | Incluir, parcelar, editar, registrar recebimento, cancelar e estornar conforme permissão. |
| Contas a pagar | Manter. | Incluir despesas, parcelar, registrar pagamento e acompanhar vencimentos. |
| Caixas e bancos | Manter. | Consultar extratos, lançar movimentos e transferir valores conforme permissão. |
| Controle de caixa financeiro | Manter quando utilizado. | Abertura, acompanhamento e fechamento dentro das funções financeiras disponíveis. |
| Categorias, contas financeiras e formas de pagamento | Manter. | Configurar o financeiro conforme o papel. |
| Relatórios e conciliação financeira | Manter os necessários. | Consulta e operações conforme permissão e disponibilidade do porte. |
| Cobrança bancária | Opcional. | Somente quando `erp-cobranca` estiver ligado. |
| Trabalhos do módulo `os` | Manter na navegação do módulo de atendimento. | Abrir o trabalho de origem e solicitar geração de conta. Não duplicar seu cadastro no ERP. |
| Produtos, categorias de produtos, listas de preços e depósitos | Retirar da navegação cotidiana. | Não oferecer inclusão ou manutenção por atalhos desse perfil. |
| Estoque, compras, recebimentos e inventário | Retirar. | Não oferecer ações desses fluxos. |
| Pedidos de venda, propostas e OS comercial do ERP | Retirar. | Não usá-los como passagem obrigatória para cobrar um trabalho. |
| PDV | Desligado na composição sugerida. | Nenhuma ação de venda de balcão. |
| Comissões e faturamento agrupado comercial | Ocultar inicialmente. | Reavaliar somente se houver demanda concreta. |
| NF-e e NFC-e | Ocultar na composição inicial. | NFS-e só entra quando houver fluxo completo. |
| Administração | Manter para quem já tem acesso. | Empresa, acessos, segurança, configuração financeira e alteração do próprio perfil. |

A tabela é a proposta de produto. A base já tem destinos para contas, caixa, categorias e relatórios; a composição final depende das limitações de porte mencionadas acima. (`web/erp/app/lib/origin-menu.ts:35`; `web/erp/app/lib/origin-menu.ts:77`; `web/erp/motor.ts:14`.)

A implementação mais simples usa **uma regra central de apresentação**. Essa regra classifica destinos por função e considera também os parâmetros da URL. `/documentos-empresa?tipo=purchase_orders`, por exemplo, não pode ser tratado como se fosse qualquer documento. O menu atual já diferencia destinos dessa forma. (`web/erp/app/lib/origin-menu.ts:63`; `web/erp/blocks.ts:45`.)

A mesma regra deve alimentar menu, busca de destinos, preferências, atalhos, início e abertura direta das telas. Os componentes de financeiro e contatos continuam os mesmos. Apenas os controles e trechos sem utilidade para serviços deixam de ser apresentados.

Esse perfil **não deve conceder nem revogar permissões**. O acesso continua sujeito ao papel, às permissões e aos módulos. Um administrador poderá voltar ao perfil Completo para acessar funções ocultas. Se o objetivo for proibir também chamadas diretas à API comercial, será necessário um bloqueio funcional no servidor. Isso é uma decisão adicional, não uma consequência de esconder telas.

| Arquivo ou conjunto | Mudança proposta |
|---|---|
| `packages/erp-domain/src/preferences/pages/empresa-geral.mjs` | Declarar a preferência de perfil, com padrão Completo. A página existente começa em `:8`. |
| `src/erp/schema/migrate.ts` e `src/erp/schema/ddl.ts` | Versionar a inclusão da definição no banco do ERP. O mecanismo de atualização existente está em `src/erp/schema/migrate.ts:64`. A origem exata da semeadura a atualizar fica **a conferir**. |
| Novo arquivo de política de apresentação em `web/erp/app/lib/` | Concentrar a classificação de destinos e as funções de visibilidade. Nome final **a conferir**. |
| `web/erp/app/lib/origin-menu.ts` | Aplicar o perfil aos destinos e às preferências, preservando as verificações existentes em `:207` e `:237`. |
| `web/erp/app/lib/fagoo-menu.ts` | Ajustar destaque e agrupamento para a composição financeira, sem criar outro menu completo. O agrupador atual começa em `:19`. |
| `web/erp/app/components/CompanyNavigation.tsx` | Fornecer o perfil aos dois resolvedores. Hoje eles são chamados em `:31` e `:32`. |
| `web/erp/app/components/RealAccess.tsx` | Aplicar o mesmo filtro à abertura direta. O despacho atual está em `:106` e `:107`. |
| `web/erp/app/components/RealHome.tsx` | Filtrar atalhos e conteúdo comercial. Os atalhos derivados do menu são montados em `:60`. |
| `web/erp/app/components/RealFinance.tsx` e `ContactEditor.tsx` | Ajustar ações, links internos e vocabulário nas telas mantidas. Pontos existentes: `RealFinance.tsx:626` e `ContactEditor.tsx:157`. |
| `src/service-templates.ts` e futuro aplicador de modelos de área | Acrescentar a escolha na prévia e na aplicação. O precedente atual grava configuração comum, conforme `src/service-templates.ts:14`. A aplicação da preferência no banco do ERP precisa de uma chamada própria; esse encaixe fica **a conferir**. |

O banco do ERP tem uma particularidade importante: ele usa o SQLite da instância `erp:<área>` da classe `Coordinator`. Sua atualização de esquema não passa pelas migrações do D1. A proposta deve preservar essa estrutura e usar apenas alterações aditivas. (`src/erp/hub.ts:29`; `src/coordinator.ts:72`; `src/erp/schema/migrate.ts:1`.)

**4. A ligação com `os` deve gerar um título financeiro, sem exigir uma OS comercial intermediária.**

Os pontos encontrados não formam uma ponte pronta:

| Ponto existente | O que oferece | Limite |
|---|---|---|
| Ganchos comuns | Há ganchos de pagamento, comandos e rotas de módulos. | `registerPaymentHook` trata mudança de cobrança. Não é um lançador financeiro genérico. (`src/modules/hooks.ts:113`; `src/modules/hooks.ts:226`.) |
| Eventos de `os` | O módulo declara aprovação, entrega e mudança de estado. A aprovação publica valor e versão do orçamento. | São possíveis origens de uma solicitação. Aprovação não significa recebimento de dinheiro. (`src/modules/os/definition.ts:42`; `src/modules/os/store.ts:861`.) |
| Identidade de sistema | Existe infraestrutura para um módulo atuar como membro técnico do ERP. | Os papéis permitidos são consulta, vendas, estoque e fiscal. O próprio código deixa o lançamento financeiro de módulos para o desenho da fila de saída. (`src/modules/erp/identity.ts:31`; `src/modules/erp/identity.ts:45`.) |
| Fila entre módulos e ERP | A documentação prevê fila no D1, drenada pelo alarme da área. | Está explicitamente fora do corte descrito. Não deve ser tratada como entregue. (`docs/ERP-AGENDADOR.md:215`.) |
| Criação direta de conta | `erp_finance_title_execute` implementa `title_create`, valida contato, valores e parcelas e possui recibo de comando. | Precisa de pessoa com acesso de escrita ao financeiro. (`src/erp/domains/finance/rpc/erp_finance_title_execute.ts:44`; `src/erp/domains/finance/internal.ts:113`.) |
| Lançamento de contas de documento comercial | Existe o contrato de `erp_document_finance_post`. | Nesta base, a função exportada ainda chama `notPorted`. (`src/erp/domains/finance/stubs.generated.ts:172`.) |

| Opção | Desenho | Avaliação |
|---|---|---|
| Lançamento manual independente | A pessoa abre o Financeiro e cadastra a conta, informando a referência do trabalho. | Menor esforço, mas deixa conciliação e prevenção de duplicidade a cargo da pessoa. |
| Ação “Gerar conta a receber” no trabalho | O trabalho prepara os dados. Uma pessoa autorizada revisa e confirma no financeiro existente. | **Recomendada para a primeira entrega.** Aproveita a criação direta de títulos e mantém a decisão financeira explícita. |
| Automação por evento e fila | Uma condição configurada do trabalho cria uma solicitação persistente, processada com repetição segura. | Melhor para escala. Depende de fechar a autorização financeira restrita dos módulos e a fila ainda pendente. |
| Criar documento comercial intermediário | Espelhar o trabalho como `service_orders` do ERP e depois lançar suas contas. | Acrescenta sincronização entre dois registros e depende do lançamento de documentos ainda não portado. Não recomendo como caminho padrão. |

A primeira entrega proposta deve seguir este fluxo:

| Etapa | Comportamento proposto |
|---|---|
| 1. Solicitar | A pessoa escolhe “Gerar conta a receber” no trabalho. O ERP precisa estar ligado na mesma área. |
| 2. Identificar o pagador | Vincular um contato do ERP. O cliente financeiro pode ser o contratante, tutor ou responsável, e não necessariamente a pessoa atendida. |
| 3. Revisar | Mostrar descrição financeira, valor, parcelas, vencimentos, categoria e forma de pagamento. |
| 4. Confirmar | Revalidar o acesso da pessoa. Aplicar a política de segundo fator existente quando exigida. |
| 5. Criar | Usar o comando financeiro existente com identificador estável para repetição. |
| 6. Vincular | Guardar os identificadores dos títulos e a origem no trabalho. Oferecer navegação nos dois sentidos. |
| 7. Recuperar falhas | Manter a solicitação pendente quando houver resposta incerta. Consultar ou repetir o mesmo comando, sem criar outro lançamento. |

O comando já recebe os principais campos financeiros abaixo. O vínculo estruturado com `os` é novo.

| Campo ou vínculo | Uso |
|---|---|
| `kind = receivable` | Conta a receber. |
| `contact_id` | Pagador cadastrado e ativo no ERP. Não presumir igualdade com o identificador de contato do atendimento. |
| `description` | Descrição financeira curta, sem conteúdo clínico, processual ou pedagógico sensível. |
| `total_cents` | Valor total em centavos. |
| `installments` | Parcelas com `amount_cents` e `due_on`. |
| `issued_on` e `competence_on` | Datas financeiras definidas na revisão. |
| `category_id`, `account_id`, `payment_method_id` | Classificação e destino financeiro, conforme o contrato existente. |
| `source_reference` | Referência legível ao trabalho. |
| Vínculo novo | Área, módulo, trabalho, versão ou marco cobrado, comando e títulos gerados. |

Campos e validações existentes: `src/erp/domains/finance/rpc/erp_finance_title_execute.ts:65`. O recibo compara também ator e conteúdo da requisição; a recuperação por outra pessoa precisa respeitar esse contrato. (`src/erp/domains/finance/rpc/erp_finance_title_execute.ts:54`.)

`source_reference` não deve ser usado como garantia de unicidade. No código lido, ele é validado como texto e copiado para o título. A proposta precisa de uma chave de origem única, independente do texto exibido. (`src/erp/domains/finance/rpc/erp_finance_title_execute.ts:82`; `src/erp/domains/finance/rpc/erp_finance_title_execute.ts:109`.)

O trabalho e o financeiro estão em armazenamentos distintos: `os` grava no D1, enquanto o ERP usa seu SQLite. Não há uma transação única entre os dois nesses caminhos. A recuperação proposta deve considerar “título criado, vínculo ainda não confirmado”. (`src/modules/os/store.ts:390`; `src/erp/schema/migrate.ts:73`.)

Na primeira entrega, a confirmação humana evita ampliar os poderes da identidade de sistema. Uma automação futura deve ter uma operação financeira restrita e auditável. Não deve receber genericamente o papel `financeiro`, contrariando a regra atual dos agentes. (`src/modules/erp/identity.ts:31`.)

Também proponho separar os efeitos: gerar uma conta não registra pagamento; aprovar uma etapa não gera receita automaticamente; cancelar um trabalho não apaga um recebimento. Cobrança, Mensalidade e `os` precisam compartilhar uma única regra de origem para não gerar duas contas pela mesma obrigação. Essa política permanece uma decisão de produto. A integração deve começar desligada, preservando o comportamento do tipo embutido.

**5. A NFS-e tem suporte no cliente do cofre, mas ainda não tem fluxo completo no ERP.**

| Parte | Estado conferido |
|---|---|
| Contrato fiscal | `FiscalKind` inclui `nfse`. A resposta normalizada contém `nfse_number`. (`src/erp/emissor/provider.ts:16`; `src/erp/emissor/provider.ts:80`.) |
| Contrato da NFapi | O contrato versionado descreve emissão de NFS-e pelo Sistema Nacional. Isso descreve o contrato local, não comprova disponibilidade operacional de um cofre instalado. (`src/erp/emissor/contract/openapi.json:1266`.) |
| Cliente de API | Há métodos para emitir, listar, obter XML e cancelar NFS-e. (`src/erp/emissor/nfapi.ts:202`; `src/erp/emissor/nfapi.ts:219`; `src/erp/emissor/nfapi.ts:226`.) |
| Provedor | A implementação NFapi declara suporte aos três tipos e trata o motivo de cancelamento de NFS-e. (`src/erp/emissor/nfapi-provider.ts:389`; `src/erp/emissor/nfapi-provider.ts:417`.) |
| Consulta de situação | A consulta dedicada à SEFAZ é de NF-e/NFC-e. Para NFS-e indefinida, o código trata a repetição do pedido; não há o mesmo `/consultar`. (`src/erp/emissor/nfapi-provider.ts:318`; `src/erp/emissor/nfapi-provider.ts:408`.) |
| Configuração do cofre | A conexão é guardada por área em segredo do núcleo. Há seleção do provedor configurado. (`src/erp/emissor/config.ts:1`; `src/erp/emissor/config.ts:22`; `src/erp/emissor/index.ts:16`.) |
| Rotas de configuração | As rotas `erp-emissor` estão montadas. Oferecem configuração, teste, séries e consulta SEFAZ para NF-e/NFC-e. Não oferecem nessa interface um comando de emissão de NFS-e. (`src/index.ts:1216`; `src/erp/emissor/routes.ts:72`; `src/erp/emissor/routes.ts:91`.) |
| Domínio Fiscal portado | O índice do domínio não registra RPCs; exporta um módulo vazio. O painel também marca as telas fiscais como pendentes. (`src/erp/domains/fiscal/index.ts:1`; `web/erp/motor.ts:27`.) |
| Interface herdada | Os relatórios de NFS-e estão declarados fora do escopo do Fagoo. O formulário de NF-e deixa os serviços da OS fora da nota de mercadorias. (`web/erp/app/lib/document-reports-model.ts:31`; `web/erp/app/lib/fiscal-invoice-form-model.ts:644`.) |

Falta completar o documento de serviço no domínio Fiscal, seu mapeamento para `PedidoNfse`, a persistência do pedido e da versão, os resultados fiscais e o fluxo de tela. O README também registra a ausência desse mapeamento. (`src/erp/emissor/README.md:367`.)

Esse README não pode ser lido como retrato integral da montagem atual: ele ainda lista montar as rotas como pendência, embora as rotas de configuração já estejam registradas em `src/index.ts`. A emissão de ponta a ponta continua distinta dessa configuração. (`src/erp/emissor/README.md:372`; `src/index.ts:1219`.)

A validação real de NFS-e pelo Wabotia, sua representação imprimível e os detalhes operacionais exigidos por cada emitente ficam **a conferir**. Este levantamento não propõe outro emissor nem outra integração.

**6. As dúvidas que precisam ser fechadas são estas.**

| Dúvida | Recomendação inicial ou ponto a conferir |
|---|---|
| O perfil deve simplificar a interface ou proibir também a API comercial? | Começar pela apresentação. Manter a autorização atual. Se houver proibição funcional, especificar também o bloqueio no servidor. |
| O perfil vale para toda a área ou por pessoa? | Toda a área. O papel continua individual. Preferências pessoais podem ajustar atalhos, sem substituir o perfil. |
| O administrador verá a mesma interface enxuta? | Sim. Deve poder voltar explicitamente ao perfil Completo. |
| Como tratar o cadastro de clientes ainda pendente? | Confirmar a conclusão do porte antes de anunciar o perfil como utilizável de ponta a ponta. O bloqueio está em `web/erp/motor.ts:18`. |
| Quem será o pagador do trabalho? | Exigir vínculo explícito. Não inferir apenas pelo telefone ou pelo nome. |
| Qual fato gera a conta? | Inicialmente, ação humana. Depois, permitir regra explícita por tipo de trabalho: contrato, aprovação, medição, parcela ou entrega. |
| Quem é dono do lançamento quando também há Cobrança ou Mensalidade? | Definir uma origem única e uma política comum de baixa e estorno antes de automatizar. |
| Como recuperar uma emissão financeira confirmada no ERP, mas ainda sem vínculo no D1? | Projetar consulta e reconciliação pela chave de origem. O formato e a autorização dessa consulta ficam **a conferir**. |
| Como o aplicador de modelos grava preferências no banco próprio do ERP? | Usar o fluxo autorizado de configuração. O contrato entre o aplicador e o ERP fica **a conferir**. |
| A NFS-e pode entrar na primeira entrega? | Não com base apenas no cliente NFapi. Primeiro é preciso completar e validar o fluxo do domínio Fiscal e do painel. |
| Há limite de consultas ou desempenho que impeça a proposta? | **A conferir.** Não houve medição nem testes. A ponte deve evitar consultas por parcela e registrar a solicitação como uma unidade de trabalho. |