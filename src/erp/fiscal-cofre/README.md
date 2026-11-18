# Relatórios e exportação pelo cofre (Fiscal, F6b)

Rotas para as telas **Relatórios fiscais** e **Exportação para o contador** do
painel (sessão M). Elas leem o cofre NFapi 0.11.0 pelo provedor do emissor
(`src/erp/emissor`, sessão B). Dona: sessão G.

- **Origem dos números:** o cofre, que é a fonte do que foi autorizado. Nada é
  guardado no ERP.
- **Escreva na tela:** "estes números vêm do cofre (o que foi autorizado); não
  some com os relatórios gerenciais do ERP".

## Quem pode

- Pessoa com papel `erp:fiscal`, ou administrador; os módulos `erp` e
  `erp-fiscal` precisam estar ligados.
- Passa pelo portão do ERP: fora do horário, `403 ERP_ACCESS_OUTSIDE_SCHEDULE`;
  sem o segundo fator quando a política pede, `403 ERP_MFA_REQUIRED`.
- Outros papéis: `403 erp_fiscal_role_required`. Sem papel: `403
  erp_role_required`.
- Pelo bot da conversa interna: `403 erp_fiscal_bot_not_allowed`, até existir a
  liberação por ação do plano dos bots.

## Rotas

Todas ficam em `/api/v1/profiles/{área}/erp-fiscal-cofre` e respondem com
`Cache-Control: private, no-store`. O erro fiscal tem o mesmo corpo do
`/erp-emissor`: `{ error: { code, message, provider_code, field, messages,
emission, retryable, min_version, retry_at } }`.

| Rota | O quê |
|---|---|
| `GET /relatorio?ambiente=producao\|homologacao&de=AAAA-MM-DD&ate=AAAA-MM-DD` | `FiscalReport` (`src/erp/emissor/provider.ts`). `ambiente` padrão: producao. Período até 366 dias. |
| `GET /exportacoes` | `{ exports: FiscalExport[] }`: as exportações das últimas 24 h. |
| `POST /exportacoes` `{ambiente, de, ate, incluir?, nova?}` | `{ export: FiscalExport, reused }`. 201 quando cria; 200 quando reaproveita. |
| `GET /exportacoes/{provider_ref}` | `FiscalExport` com links novos. Cada consulta leva o preparo adiante. |

### Relatório

- **Enquanto `complete` for false** (`pending_reads` > 0):
  - mostre "calculando, N notas ainda sendo lidas";
  - marque impostos, CFOP e natureza como parciais;
  - repita o mesmo GET depois de `retry_after_ms` (1500), só com a tela aberta e visível. Ninguém repete por você.
- **Os `warnings` aparecem na tela:**
  - `pending_reads`;
  - `nfse_ibs_cbs_not_read`: IBS e CBS da NFS-e vêm zerados.
- **Avisos fixos:**
  - só nota autorizada entra nos totais; cancelada e recusada aparecem só em `by_status`;
  - recebidas: impostos só das `with_xml`, e "como terceiro" fica fora.
- **Formato:** os valores vêm em reais (`number`). Formate na tela, sem somar com números do ERP.

### Exportação

- **`incluir`:** qualquer combinação de `nfse`, `nfe`, `nfce`, `events`, `void_ranges` e `received`. Padrão: tudo. Vazio ou valor desconhecido: 400 `fiscal_invalid_request`, sem chegar ao cofre.
- **Clique duplo:** o mesmo ambiente, período e `incluir` de uma exportação ainda válida devolve essa mesma exportação (`reused: true`), com links novos. Para gerar outra (por exemplo, porque saiu nota nova), mande `nova: true`.
- **Andamento:** com `status: "preparing"`, consulte `GET /exportacoes/{provider_ref}` depois de `retry_after_ms`, sem laço apertado, até `ready`.
- **Pronta:** um botão por item de `parts[]` (ZIP de até 400 arquivos; a planilha vai dentro da primeira parte) e um para `spreadsheet`.
  - Os botões **abrem a url em aba nova direto no navegador**. O arquivo sai do cofre, não do Wabotia.
  - Não guarde as urls (localStorage, log, analytics): valem como senha até `links_valid_until`, cerca de 30 min.
- **Link vencido** (perto de `links_valid_until`, ou 403 `link_invalido` no cofre): chame `GET /exportacoes/{provider_ref}` antes de abrir.
- **Depois de 24 horas:** 404 `fiscal_export_not_found`; ofereça criar outra.
- **Avisos fixos:**
  - nota rejeitada não tem XML e aparece só na planilha;
  - os eventos acompanham a nota, seja qual for a data deles;
  - XML de entrada importado à mão no ERP não entra no pacote (pendência: exportação do ERP pelo R2, ou mandar esses XML ao cofre).

## Erros comuns

- `409 fiscal_provider_not_configured`: a área não tem emissor.
- `409 vault_outdated` (`min_version: "0.11.0"`): o cofre precisa de atualização.
- `409 fiscal_key_homologation_only`: a chave só opera em homologação.
- `502 fiscal_provider_error`: o cofre devolveu um link fora da origem dele; ele não é repassado.

## Auditoria

A tabela `audit` do núcleo recebe as operações abaixo. O registro guarda o id
do cofre, o ambiente, o período e o `incluir`, **nunca a url**.

- `erp_fiscal.vault_report`: só quando o relatório volta completo.
- `erp_fiscal.vault_export_create`.
- `erp_fiscal.vault_export_links`: links entregues de uma exportação pronta.
