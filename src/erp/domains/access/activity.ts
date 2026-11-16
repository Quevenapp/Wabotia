// Atividade (erp_activity): a linha do tempo de alterações de todos os
// domínios. Portado de erp_activity.entries e das funções de rótulo
// (operation, kind_module, kind_label, finance_*, cnab_*). Só leitura: cada
// ramo lê a auditoria de um domínio. LIKE vira GLOB (o LIKE do SQLite ignora
// caixa); a busca por texto é em TS (lower do SQLite é só ASCII).

/** GLOB de um padrão LIKE do Postgres (\_ literal, % qualquer coisa). */
const g = (pattern: string) => `'${pattern.replace(/\\_/g, "_").replace(/%/g, "*")}'`;
const like = (col: string, pattern: string) => `${col} GLOB ${g(pattern)}`;

/** erp_activity.operation(p_action) */
export const OPERATION = (a: string) => `(CASE
  WHEN ${a} IN ('purchase_receive','commission_payment','commission_entry','session_move') THEN 'lancamento'
  WHEN ${a} IN ('commission_manual','session_open','grouped_billing_generate') THEN 'criacao'
  WHEN ${a} IN ('session_close','session_reopen','title_returned') THEN 'atualizacao_situacao'
  WHEN ${like(a, "%undelete%")} OR ${like(a, "%restore%")} THEN 'atualizacao'
  WHEN ${like(a, "%reverse%")} OR ${like(a, "%reversal%")} OR ${like(a, "%unreconcile%")} THEN 'estorno'
  WHEN ${like(a, "%delete%")} OR ${like(a, "%archive%")} OR ${like(a, "%\\_remove")} OR ${a} IN ('abort','title_cancel','disable') THEN 'exclusao'
  WHEN ${like(a, "%transfer%")} THEN 'transferencia'
  WHEN ${a} IN ('transition','set_active','activate','inactivate') OR ${like(a, "%\\_set\\_active")} OR ${like(a, "convert\\_to%")} THEN 'atualizacao_situacao'
  WHEN ${a} IN ('line_create_entry','balance_adjust') THEN 'lancamento'
  WHEN ${like(a, "create%")} OR ${like(a, "%\\_create%")} OR ${like(a, "%import%")} OR ${a} IN ('finalize','opening','clone','recurrence_generate','occurrence','configure') THEN 'criacao'
  WHEN ${like(a, "%post%")} OR ${like(a, "%settle%")} OR ${like(a, "%reservation%")} THEN 'lancamento'
  WHEN ${like(a, "%send%")} OR ${like(a, "%authoriz%")} OR ${like(a, "%export%")} THEN 'envio'
  ELSE 'atualizacao' END)`;

const KIND_MODULE = (k: string) =>
  `(CASE ${k} WHEN 'sales_proposals' THEN 'propostas' WHEN 'sales_orders' THEN 'pedidos_venda' WHEN 'purchase_orders' THEN 'pedidos_compra' WHEN 'service_orders' THEN 'ordens_servico' ELSE 'documentos' END)`;
const KIND_LABEL = (k: string) =>
  `(CASE ${k} WHEN 'sales_proposals' THEN 'Proposta comercial' WHEN 'sales_orders' THEN 'Pedido de venda' WHEN 'purchase_orders' THEN 'Pedido de compra' WHEN 'service_orders' THEN 'Ordem de serviço' ELSE 'Documento' END)`;

const FINANCE_LABEL = (a: string) => `(CASE
  WHEN ${a} IN ('account_save','account_create','account_update') THEN 'Conta financeira' WHEN ${a}='account_delete' THEN 'Conta financeira excluída'
  WHEN ${a}='account_set_active' THEN 'Situação da conta financeira' WHEN ${a}='account_set_default' THEN 'Conta financeira padrão'
  WHEN ${a} IN ('category_save','category_create','category_update','category_move') THEN 'Categoria financeira' WHEN ${a}='category_delete' THEN 'Categoria financeira excluída'
  WHEN ${a}='category_set_active' THEN 'Situação da categoria financeira' WHEN ${a}='category_set_default' THEN 'Categoria financeira padrão'
  WHEN ${a}='category_import' THEN 'Importação de categorias financeiras'
  WHEN ${a} IN ('title_create','title_create_group') THEN 'Contas incluídas' WHEN ${a} IN ('title_update','title_edit') THEN 'Conta alterada'
  WHEN ${a}='title_cancel' THEN 'Conta cancelada' WHEN ${a}='title_delete' THEN 'Conta excluída'
  WHEN ${a}='settle' THEN 'Baixa de conta' WHEN ${a}='settle_batch' THEN 'Baixa de contas em lote' WHEN ${a}='reverse' THEN 'Estorno de baixa'
  WHEN ${like(a, "bordero%")} THEN 'Borderô'
  WHEN ${a}='opening' THEN 'Saldo inicial de conta financeira'
  WHEN ${a}='document_post' THEN 'Contas lançadas pelo documento' WHEN ${a}='document_reverse' THEN 'Contas estornadas do documento'
  WHEN ${a}='invoice_post' THEN 'Contas lançadas pela nota fiscal' WHEN ${a}='invoice_reverse' THEN 'Contas estornadas da nota fiscal'
  WHEN ${a}='title_returned' THEN 'Contas devolvidas (situação Devolvido)'
  WHEN ${a}='entry_save' THEN 'Lançamento de caixa' WHEN ${a}='entry_delete' THEN 'Lançamento de caixa excluído' WHEN ${a}='entry_restore' THEN 'Lançamento de caixa restaurado'
  WHEN ${a}='balance_adjust' THEN 'Ajuste de saldo'
  WHEN ${a}='statement_import' THEN 'Extrato bancário importado' WHEN ${a}='statement_delete' THEN 'Extrato bancário excluído'
  WHEN ${a}='line_settle_titles' THEN 'Baixa pela conciliação bancária' WHEN ${like(a, "line\\_%")} THEN 'Conciliação bancária'
  WHEN ${a} IN ('internal_transfer','transfer_create') THEN 'Transferência entre contas' WHEN ${a}='transfer_delete' THEN 'Transferência entre contas excluída'
  WHEN ${like(a, "recurrence\\_%")} THEN 'Conta recorrente'
  WHEN ${a}='records_import' THEN 'Importação de registros financeiros' WHEN ${a}='origin_import_batch' THEN 'Importação do financeiro do Origin'
  WHEN ${a}='commission_payment' THEN 'Pagamento de comissões' WHEN ${a}='commission_entry' THEN 'Crédito ou débito no extrato de comissões'
  WHEN ${a}='commission_manual' THEN 'Comissão manual' WHEN ${a}='commission_delete' THEN 'Comissão excluída'
  WHEN ${a}='session_open' THEN 'Caixa aberto' WHEN ${a}='session_save' THEN 'Caixa alterado' WHEN ${a}='session_close' THEN 'Caixa fechado'
  WHEN ${a}='session_reopen' THEN 'Caixa reaberto' WHEN ${a}='session_move' THEN 'Sangria ou suprimento de caixa'
  WHEN ${a}='session_move_delete' THEN 'Sangria ou suprimento de caixa excluído' WHEN ${a}='session_delete' THEN 'Caixa excluído'
  WHEN ${a}='grouped_billing_generate' THEN 'Faturamento agrupado: contas geradas' WHEN ${a}='grouped_billing_delete' THEN 'Faturamento agrupado excluído'
  ELSE 'Operação financeira' END)`;
const FINANCE_MODULE = (a: string) => `(CASE
  WHEN ${a} IN ('settle','settle_batch','reverse','line_settle_titles') OR ${like(a, "bordero%")} THEN 'pagamento_recebimento'
  WHEN ${like(a, "commission\\_%")} THEN 'comissao'
  WHEN ${like(a, "entry\\_%")} OR ${like(a, "statement\\_%")} OR ${like(a, "line\\_%")} OR ${like(a, "%transfer%")} OR ${a}='balance_adjust' OR ${like(a, "session\\_%")} THEN 'caixa'
  ELSE 'financas' END)`;

const CNAB_LABEL = (a: string) => `(CASE WHEN ${a}='profile_save' THEN 'Configuração da cobrança bancária'
  WHEN ${a} IN ('approve','operational_approve','operational_approve_v2') THEN 'Configuração da cobrança bancária aprovada'
  WHEN ${a} IN ('human_review','operational_bind') THEN 'Conferência de ocorrência do retorno'
  WHEN ${a} IN ('reserve','operational_reserve','operational_reserve_v2') THEN 'Remessa de cobrança reservada'
  WHEN ${a} IN ('finalize','operational_finalize','operational_finalize_v2') THEN 'Arquivo de remessa gerado'
  WHEN ${a}='remittance_exclude' THEN 'Remessa excluída'
  WHEN ${a} IN ('return_commit','operational_return') THEN 'Arquivo de retorno importado'
  WHEN ${a}='return_exclude' THEN 'Retorno excluído'
  WHEN ${like(a, "%settle")} THEN 'Baixa pelo retorno de cobrança'
  ELSE 'Cobrança bancária' END)`;
const CNAB_MODULE = (a: string) => `(CASE WHEN ${like(a, "%settle")} THEN 'pagamento_recebimento' ELSE 'cobranca' END)`;
const CNAB_OPERATION = (a: string) => `(CASE WHEN ${like(a, "%exclude")} THEN 'exclusao' WHEN ${a} IN ('reserve','operational_reserve','operational_reserve_v2') THEN 'criacao'
  WHEN ${a} IN ('finalize','operational_finalize','operational_finalize_v2') THEN 'envio'
  WHEN ${a} IN ('return_commit','operational_return') OR ${like(a, "%settle")} THEN 'lancamento' ELSE 'atualizacao' END)`;

/** left(x, n) do Postgres (caracteres). */
const left = (x: string, n: number) => `substr(${x},1,${n})`;
const has = (j: string, k: string) => `(json_type(${j},'$.${k}') IS NOT NULL)`;
const bool = (j: string, k: string) => `(${j}->>'$.${k}')`;
const H = "[0-9a-f]";
const UUID_GLOB = `'${H.repeat(8)}-${H.repeat(4)}-${H.repeat(4)}-${H.repeat(4)}-${H.repeat(12)}'`;
/** erp_activity.uuid_or_null: uuid em minúsculas, senão null. */
const uuidOrNull = (x: string) => `(CASE WHEN ${x} GLOB ${UUID_GLOB} THEN ${x} END)`;
const T = (schema: string, table: string) => `"${schema}__${table}"`;
const range = (col: string) => `${col}>=?1 AND ${col}<?2`;

/** erp_activity.entries(p_from, p_to): (source, entry_id, created_at, actor, module, operation, code, description). */
export const ENTRIES_SQL = [
  `SELECT 'catalog' AS source,CAST(a.id AS TEXT) AS entry_id,a.created_at AS created_at,a.actor AS actor,
    CASE a.entity WHEN 'contacts' THEN 'clientes_fornecedores' WHEN 'products' THEN 'produtos' ELSE 'depositos' END AS module,
    ${OPERATION("a.action")} AS operation,r.code AS code,${left("r.name", 200)} AS description
   FROM ${T("erp_catalog", "audit")} a JOIN ${T("erp_catalog", "record")} r ON r.id=a.record_id WHERE ${range("a.created_at")}`,
  `SELECT 'documents',CAST(a.id AS TEXT),a.created_at,a.actor,${KIND_MODULE("d.kind")},${OPERATION("a.action")},CAST(d.number AS TEXT),
    ${left(`${KIND_LABEL("d.kind")}||' nº '||d.number||coalesce(' · '||nullif(trim(a.reason,' '),''),'')`, 200)}
   FROM ${T("erp_documents", "audit")} a JOIN ${T("erp_documents", "document")} d ON d.id=a.document_id WHERE ${range("a.created_at")}`,
  `SELECT 'finance',CAST(a.id AS TEXT),a.created_at,a.actor,${FINANCE_MODULE("a.action")},${OPERATION("a.action")},NULL,${FINANCE_LABEL("a.action")}
   FROM ${T("erp_finance", "audit")} a WHERE ${range("a.created_at")}`,
  `SELECT 'stock',m.id,m.created_at,m.actor,'estoque',CASE m.kind WHEN 'transfer' THEN 'transferencia' WHEN 'reversal' THEN 'estorno' ELSE 'lancamento' END,m.reference,${left("m.reason", 200)}
   FROM ${T("erp_stock", "movement")} m WHERE ${range("m.created_at")}`,
  `SELECT 'cnab',CAST(a.id AS TEXT),a.created_at,a.actor,${CNAB_MODULE("a.action")},${CNAB_OPERATION("a.action")},CAST(r.sequence AS TEXT),${CNAB_LABEL("a.action")}
   FROM ${T("erp_cnab", "audit")} a LEFT JOIN ${T("erp_cnab", "remittance")} r ON r.id=a.record_id WHERE ${range("a.created_at")}`,
  `SELECT 'fiscal_drafts',CAST(a.id AS TEXT),a.created_at,a.actor,'notas_fiscais',${OPERATION("a.action")},NULL,
    'Rascunho de '||CASE d.model WHEN '65' THEN 'NFC-e' ELSE 'NF-e' END||' (homologação)'
   FROM ${T("erp_fiscal_drafts", "audit")} a JOIN ${T("erp_fiscal_drafts", "draft")} d ON d.id=a.draft_id WHERE ${range("a.created_at")}`,
  `SELECT 'company',CAST(a.id AS TEXT),a.created_at,a.actor,'empresa','atualizacao',NULL,
    ${left(`CASE a.action WHEN 'save_extra' THEN 'Dados complementares da empresa' WHEN 'save_partners' THEN 'Dados do sócio(s)' WHEN 'confirm_fiscal' THEN 'Regime tributário confirmado'
     WHEN 'clear_fiscal_confirmation' THEN 'Confirmação do regime tributário retirada' WHEN 'fiscal_reset_identity_changed' THEN 'Regime tributário a confirmar (CNPJ alterado)'
     ELSE 'Dados da empresa'||coalesce(' · dados bloqueados corrigidos: '||(a.after_data->>'$.motivo'),'') END`, 200)}
   FROM ${T("erp_company", "audit")} a WHERE ${range("a.created_at")}`,
  `SELECT 'attachments',CAST(a.id AS TEXT),a.created_at,a.actor,'anexos',${OPERATION("a.action")},NULL,
    ${left(`'Anexo '||t.filename||CASE a.action WHEN 'delete' THEN ' · excluído' WHEN 'abort' THEN ' · envio cancelado' ELSE '' END`, 200)}
   FROM ${T("erp_attachments", "audit")} a JOIN ${T("erp_attachments", "attachment")} t ON t.id=a.attachment_id WHERE a.action IN ('finalize','abort','delete') AND ${range("a.created_at")}`,
  `SELECT 'preferences',CAST(a.id AS TEXT),a.created_at,a.actor,'preferencias','atualizacao',a.key,'Preferência alterada'
   FROM ${T("erp_preferences", "audit")} a WHERE ${range("a.created_at")}`,
  `SELECT 'list_preferences',CAST(a.id AS TEXT),a.created_at,a.actor,'preferencias','atualizacao',a.list_id,'Listagem customizada'
   FROM ${T("erp_list_preferences", "audit")} a WHERE ${range("a.created_at")}`,
  `SELECT 'home',CAST(a.id AS TEXT),a.created_at,a.actor,'pagina_inicial','atualizacao',NULL,CASE WHEN ${has("a.after_data", "charts")} THEN 'Gráficos da página inicial' ELSE 'Atalhos favoritos' END
   FROM ${T("erp_home", "shortcut_audit")} a WHERE ${range("a.created_at")}`,
  `SELECT 'users',CAST(a.id AS TEXT),a.created_at,a.actor,'usuarios',
    CASE WHEN ${bool("a.before_data", "active")} AND NOT ${bool("a.after_data", "active")} THEN 'exclusao'
     WHEN (a.before_data->>'$.role') IS NULL AND ${bool("a.after_data", "active")} THEN 'criacao' ELSE 'atualizacao' END,
    NULL,'@users:'||CASE WHEN ${has("a.after_data", "schedule")} THEN 'Tipo, horários e permissões do usuário ' ELSE 'Usuário ' END||'|'||a.target
   FROM ${T("erp_access", "user_audit")} a WHERE ${range("a.created_at")}`,
  `SELECT 'frameworks',CAST(a.id AS TEXT),a.created_at,a.actor,'preferencias',
    CASE WHEN ${like("a.action", "%create")} THEN 'criacao' WHEN ${like("a.action", "%delete")} THEN 'exclusao' ELSE 'atualizacao' END,${left("a.target", 120)},
    CASE a.area WHEN 'situations' THEN CASE WHEN ${like("a.action", "transition%")} THEN 'Transição de situação' ELSE 'Situação personalizada' END
     WHEN 'tags' THEN CASE WHEN ${like("a.action", "tag_group%")} THEN 'Grupo de tags' ELSE 'Tag' END WHEN 'reports' THEN 'Relatório customizado' ELSE 'Etiqueta customizada' END
   FROM ${T("erp_preferences", "framework_audit")} a WHERE ${range("a.created_at")}`,
  `SELECT 'taxonomy',CAST(a.id AS TEXT),a.created_at,a.actor,
    CASE WHEN coalesce(t.tag_type,a.after_data->>'$.tag_type',a.before_data->>'$.tag_type')='contacts' THEN 'clientes_fornecedores' ELSE 'produtos' END,${OPERATION("a.action")},NULL,
    ${left(`CASE a.kind WHEN 'categories' THEN 'Categoria de produtos' WHEN 'product_groups' THEN 'Grupo de produtos' WHEN 'tag_groups' THEN 'Grupo de tags' ELSE 'Tag' END
     ||coalesce(' '||coalesce(t.name,a.after_data->>'$.name',a.before_data->>'$.name'),'')`, 200)}
   FROM ${T("erp_catalog", "taxonomy_audit")} a LEFT JOIN ${T("erp_catalog", "taxonomy")} t ON t.id=a.item_id WHERE ${range("a.created_at")}`,
  `SELECT 'pricing',CAST(a.id AS TEXT),a.created_at,a.actor,'produtos',${OPERATION("a.action")},NULL,
    ${left(`'Lista de preços'||coalesce(' '||coalesce(l.name,a.after_data->>'$.name',a.before_data->>'$.name'),'')||CASE a.action WHEN 'items' THEN ' · produtos' WHEN 'adjust' THEN ' · reajuste' ELSE '' END`, 200)}
   FROM ${T("erp_pricing", "audit")} a LEFT JOIN ${T("erp_pricing", "price_list")} l ON l.id=a.list_id WHERE ${range("a.created_at")}`,
  `SELECT 'auxiliary',CAST(a.id AS TEXT),a.created_at,a.actor,CASE a.subject WHEN 'payment_method' THEN 'financas' ELSE 'clientes_fornecedores' END,
    CASE WHEN a.subject='contacts_export' THEN 'envio' WHEN a.subject='contact_import' THEN 'criacao' WHEN a.action='next_number' THEN 'atualizacao' WHEN a.action='default' THEN 'atualizacao'
     ELSE ${OPERATION("a.action")} END,
    CASE WHEN a.subject IN ('seller','contact_comment') THEN (SELECT ${left("r.code", 120)} FROM ${T("erp_catalog", "record")} r WHERE r.id=CASE a.subject WHEN 'seller' THEN s.contact_id ELSE ${uuidOrNull("a.after_data->>'$.contact_id'")} END) END,
    ${left(`CASE a.subject
     WHEN 'contact_type' THEN 'Tipo de contato'||coalesce(' '||coalesce(a.after_data->>'$.label',a.before_data->>'$.label'),'')
     WHEN 'contact_code' THEN 'Próximo código de contato'||coalesce(': '||(a.after_data->>'$.next_number'),'')
     WHEN 'contact_comment' THEN 'Comentário no contato'||coalesce(' '||(SELECT r.name FROM ${T("erp_catalog", "record")} r WHERE r.id=${uuidOrNull("a.after_data->>'$.contact_id'")}),'')
     WHEN 'contacts_export' THEN CASE WHEN a.action='labels' THEN 'Etiquetas de contatos' ELSE 'Exportação de contatos' END||coalesce(' ('||(a.after_data->>'$.total')||')','')
     WHEN 'contact_import' THEN 'Importação de contatos'||coalesce(' ('||(a.after_data->>'$.rows')||' linhas)','')
     WHEN 'seller' THEN 'Vendedor'||coalesce(' '||(SELECT r.name FROM ${T("erp_catalog", "record")} r WHERE r.id=s.contact_id),'')
     WHEN 'payment_method' THEN 'Forma de pagamento'||coalesce(' '||coalesce(pm.description,a.after_data->>'$.description',a.before_data->>'$.description'),'')
     WHEN 'employee' THEN 'Funcionário'||coalesce(' '||e.name,'')
     ELSE 'Cadastro auxiliar de contatos' END`, 200)}
   FROM ${T("erp_catalog", "auxiliary_audit")} a
    LEFT JOIN ${T("erp_catalog", "seller")} s ON a.subject='seller' AND s.id=a.subject_id
    LEFT JOIN ${T("erp_catalog", "payment_method")} pm ON a.subject='payment_method' AND pm.id=a.subject_id
    LEFT JOIN ${T("erp_catalog", "employee")} e ON a.subject='employee' AND e.id=a.subject_id
   WHERE ${range("a.created_at")}`,
  `SELECT 'numbering',CAST(n.id AS TEXT),n.created_at,n.actor,${KIND_MODULE("n.kind")},'atualizacao',CAST(n.after_last+1 AS TEXT),
    ${left(`'Próximo número: '||${KIND_LABEL("n.kind")}||' nº '||(n.after_last+1)`, 200)}
   FROM ${T("erp_documents", "numbering_audit")} n WHERE ${range("n.created_at")}`,
  `SELECT 'fiscal_invoices',CAST(a.id AS TEXT),a.created_at,a.actor,'notas_fiscais',
    CASE WHEN a.action='cancel' THEN 'atualizacao_situacao' ELSE ${OPERATION("a.action")} END,
    CASE WHEN a.scope='invoice' THEN CAST(i.number AS TEXT) END,
    ${left(`CASE a.scope
     WHEN 'invoice' THEN coalesce(CASE i.model WHEN '65' THEN 'NFC-e' ELSE 'NF-e' END,'Nota fiscal')||coalesce(' nº '||i.number,'')||coalesce(' série '||i.series,'')
      ||CASE a.action WHEN 'link_order' THEN ' · pedido vinculado' WHEN 'unlink_order' THEN ' · pedido desvinculado' WHEN 'import' THEN ' · importada do XML' WHEN 'reconcile' THEN ' · conciliada' ELSE '' END
     WHEN 'event' THEN CASE a.action WHEN 'cancel' THEN 'Cancelamento de nota fiscal' WHEN 'correction' THEN 'Carta de correção' WHEN 'inutilization' THEN 'Inutilização de numeração' ELSE 'Evento de nota fiscal' END
     WHEN 'nature' THEN CASE WHEN a.action='confirm_review' THEN 'Revisão das naturezas de operação' ELSE 'Natureza de operação'||coalesce(' '||nullif(trim(a.reason,' '),''),'') END
     WHEN 'tax_settings' THEN 'Configurações de impostos'
     ELSE 'Notas fiscais' END`, 200)}
   FROM ${T("erp_fiscal_invoices", "audit")} a LEFT JOIN ${T("erp_fiscal_invoices", "invoice")} i ON a.scope='invoice' AND i.id=a.entity_id WHERE ${range("a.created_at")}`,
  `SELECT 'a1',CAST(a.id AS TEXT),a.created_at,a.actor,'certificado_digital',${OPERATION("a.action")},NULL,
    CASE a.action WHEN 'configure' THEN 'Certificado A1 configurado' WHEN 'rewrap' THEN 'Certificado A1 protegido novamente' WHEN 'disable' THEN 'Certificado A1 desativado' ELSE 'Certificado A1' END
   FROM ${T("erp_a1", "audit")} a WHERE a.action<>'reject' AND ${range("a.created_at")}`,
  `SELECT 'stock_count',c.id,c.created_at,c.actor,'estoque',CASE c.action WHEN 'balance' THEN 'lancamento' ELSE 'atualizacao' END,NULL,
    CASE c.action WHEN 'balance' THEN 'Balanço da conferência de estoque' WHEN 'restart' THEN 'Conferência de estoque reiniciada' ELSE 'Depósito da conferência de estoque' END
    ||coalesce(' · '||(SELECT ${left("r.name", 120)} FROM ${T("erp_catalog", "record")} r WHERE r.id=s.warehouse_id),'')
   FROM ${T("erp_stock", "count_command")} c JOIN ${T("erp_stock", "count_session")} s ON s.id=c.session_id WHERE c.action IN ('warehouse','restart','balance') AND ${range("c.created_at")}`,
  `SELECT 'warehouse_settings',w.id,w.created_at,w.actor,'depositos','atualizacao',r.code,
    ${left(`CASE w.action WHEN 'default' THEN 'Depósito padrão' ELSE 'Saldo do depósito considerado ou desconsiderado' END||coalesce(' · '||r.name,'')`, 200)}
   FROM ${T("erp_stock", "warehouse_command")} w LEFT JOIN ${T("erp_catalog", "record")} r ON r.id=w.warehouse_id WHERE ${range("w.created_at")}`,
  `SELECT 'checkin',c.id,c.created_at,c.actor,'estoque',
    CASE WHEN c.action='finish' THEN 'atualizacao_situacao'
     WHEN NOT EXISTS (SELECT 1 FROM ${T("erp_stock", "checkin_command")} p WHERE p.invoice_id=c.invoice_id AND (p.created_at,p.id)<(c.created_at,c.id)) THEN 'criacao' ELSE 'atualizacao' END,
    CAST(i.number AS TEXT),
    ${left(`'Check-in de recebimento'||coalesce(' da nota nº '||i.number,'')||CASE c.action WHEN 'finish' THEN ' · finalizado' WHEN 'restart' THEN ' · reiniciado' ELSE '' END`, 200)}
   FROM ${T("erp_stock", "checkin_command")} c LEFT JOIN ${T("erp_fiscal_invoices", "invoice")} i ON i.id=c.invoice_id WHERE ${range("c.created_at")}`,
  `SELECT 'goals',g.id,g.created_at,g.actor,'meu_negocio',
    CASE WHEN g.before_data IS NULL THEN 'criacao' WHEN ${bool("g.before_data", "active")} IS NOT ${bool("g.after_data", "active")} THEN 'atualizacao_situacao' ELSE 'atualizacao' END,
    NULL,${left(`'Meta'||coalesce(' '||(g.after_data->>'$.name'),'')`, 200)}
   FROM ${T("erp_home", "goal_audit")} g WHERE ${range("g.created_at")}`,
  `SELECT 'custom_fields',CAST(a.id AS TEXT),a.created_at,a.actor,'campos_customizados',CASE a.action WHEN 'create' THEN 'criacao' WHEN 'delete' THEN 'exclusao' ELSE 'atualizacao' END,NULL,
    ${left(`'Campo customizado'||coalesce(' '||coalesce(c.name,a.after_data->>'$.name',a.before_data->>'$.name'),'')||CASE a.action WHEN 'categories' THEN ' · categorias' ELSE '' END`, 200)}
   FROM ${T("erp_catalog", "custom_field_audit")} a LEFT JOIN ${T("erp_catalog", "custom_field")} c ON c.id=a.field_id WHERE ${range("a.created_at")}`,
  `SELECT 'contact_files',CAST(a.id AS TEXT),a.created_at,a.actor,'clientes_fornecedores',CASE a.action WHEN 'finalize' THEN 'criacao' ELSE 'exclusao' END,r.code,
    ${left(`CASE c.purpose WHEN 'photo' THEN 'Foto do contato' ELSE 'Anexo do contato' END||coalesce(' '||r.name,'')||' · '||c.filename`, 200)}
   FROM ${T("erp_attachments", "contact_file_audit")} a JOIN ${T("erp_attachments", "contact_file")} c ON c.id=a.file_id LEFT JOIN ${T("erp_catalog", "record")} r ON r.id=c.contact_id
   WHERE a.action IN ('finalize','delete') AND ${range("a.created_at")}`,
  `SELECT 'imports',j.id,j.created_at,j.actor,
    CASE j.kind WHEN 'products' THEN 'produtos' WHEN 'contacts' THEN 'clientes_fornecedores' WHEN 'purchase_orders' THEN 'pedidos_compra' WHEN 'stock_movements' THEN 'estoque'
     WHEN 'sales_orders' THEN 'pedidos_venda' WHEN 'nfe' THEN 'notas_fiscais' WHEN 'compositions' THEN 'produtos' WHEN 'product_suppliers' THEN 'produtos'
     WHEN 'custom_fields' THEN 'campos_customizados' WHEN 'lots' THEN 'estoque' ELSE 'financas' END,'criacao',NULL,
    ${left(`'Importação de planilha de '||CASE j.kind WHEN 'products' THEN 'produtos' WHEN 'contacts' THEN 'contatos' WHEN 'purchase_orders' THEN 'pedidos de compra'
     WHEN 'stock_movements' THEN 'movimentações de estoque' WHEN 'receivables' THEN 'contas a receber' WHEN 'payables' THEN 'contas a pagar' WHEN 'sales_orders' THEN 'pedidos de venda'
     WHEN 'compositions' THEN 'composições' WHEN 'custom_fields' THEN 'campos customizados' WHEN 'product_suppliers' THEN 'fornecedores de produtos'
     WHEN 'lots' THEN 'lotes' ELSE 'notas fiscais' END||' · '||j.file_name||' ('||j.total_rows||' linhas)'`, 200)}
   FROM ${T("erp_preferences", "import_job")} j WHERE ${range("j.created_at")}`,
  `SELECT 'pos',CAST(a.id AS TEXT),a.created_at,a.actor,CASE WHEN ${like("a.action", "sale%")} THEN 'frente_caixa' ELSE 'preferencias' END,
    CASE a.action WHEN 'sale_save' THEN CASE WHEN a.before_data IS NULL THEN 'criacao' ELSE 'atualizacao' END
     WHEN 'sale_finish' THEN CASE WHEN a.before_data IS NULL THEN 'criacao' ELSE 'atualizacao_situacao' END
     WHEN 'sale_cancel' THEN 'atualizacao_situacao' WHEN 'sale_transfer' THEN 'transferencia' WHEN 'sale_return' THEN 'estorno'
     WHEN 'favorite_add' THEN 'criacao' WHEN 'favorite_remove' THEN 'exclusao' ELSE 'atualizacao' END,
    CAST(d.number AS TEXT),
    ${left(`CASE a.action WHEN 'settings_save' THEN 'Configurações da frente de caixa' WHEN 'favorite_add' THEN 'Produto favorito da frente de caixa incluído'
     WHEN 'favorite_remove' THEN 'Produto favorito da frente de caixa removido'
     ELSE 'Venda'||coalesce(' nº '||d.number,'')||' na frente de caixa'||CASE a.action WHEN 'sale_finish' THEN ' · finalizada' WHEN 'sale_cancel' THEN ' · cancelada'
      WHEN 'sale_transfer' THEN ' · comanda transferida de mesa' WHEN 'sale_return' THEN ' · devolução' ELSE ' · guardada' END END`, 200)}
   FROM ${T("erp_pos", "audit")} a LEFT JOIN ${T("erp_pos", "sale")} s ON s.id=a.sale_id LEFT JOIN ${T("erp_documents", "document")} d ON d.id=s.document_id WHERE ${range("a.created_at")}`,
  `SELECT 'compositions',c.id,c.created_at,c.actor,'produtos',
    CASE WHEN c.action='save' AND NOT EXISTS (SELECT 1 FROM ${T("erp_stock", "composition_command")} p WHERE p.product_id=c.product_id AND p.action='save' AND (p.created_at,p.id)<(c.created_at,c.id)) THEN 'criacao' ELSE 'atualizacao' END,
    ${left("r.code", 120)},${left(`'Estrutura da composição'||coalesce(' '||r.name,'')||CASE c.action WHEN 'sync' THEN ' · valores atualizados pelos componentes' ELSE '' END`, 200)}
   FROM ${T("erp_stock", "composition_command")} c LEFT JOIN ${T("erp_catalog", "record")} r ON r.id=c.product_id WHERE ${range("c.created_at")}`,
  `SELECT 'product_images',CAST(a.id AS TEXT),a.created_at,a.actor,'produtos',CASE a.action WHEN 'finalize' THEN 'criacao' WHEN 'delete' THEN 'exclusao' ELSE 'atualizacao' END,
    ${left("r.code", 120)},${left(`CASE a.action WHEN 'order' THEN 'Ordem das imagens do produto' ELSE 'Imagem do produto' END||coalesce(' '||r.name,'')||coalesce(' · '||i.filename,'')`, 200)}
   FROM ${T("erp_catalog", "product_image_audit")} a LEFT JOIN ${T("erp_catalog", "product_stored_image")} i ON i.id=a.image_id LEFT JOIN ${T("erp_catalog", "record")} r ON r.id=a.product_id
   WHERE a.action IN ('finalize','delete','order') AND ${range("a.created_at")}`,
  `SELECT 'finance_files',CAST(a.id AS TEXT),a.created_at,a.actor,CASE f.owner_kind WHEN 'cash_entry' THEN 'caixa' ELSE 'financas' END,CASE a.action WHEN 'finalize' THEN 'criacao' ELSE 'exclusao' END,NULL,
    ${left(`CASE f.owner_kind WHEN 'cash_entry' THEN 'Anexo do lançamento de caixa' ELSE 'Anexo da conta' END||coalesce(' '||coalesce(t.description,e.note),'')||' · '||f.filename`, 200)}
   FROM ${T("erp_finance", "file_audit")} a JOIN ${T("erp_finance", "file")} f ON f.id=a.file_id LEFT JOIN ${T("erp_finance", "title")} t ON t.id=f.title_id LEFT JOIN ${T("erp_finance", "cash_entry")} e ON e.id=f.cash_entry_id
   WHERE a.action IN ('finalize','delete') AND ${range("a.created_at")}`,
  `SELECT 'company_logo',CAST(a.id AS TEXT),a.created_at,a.actor,'empresa',CASE a.action WHEN 'finalize' THEN 'atualizacao' ELSE 'exclusao' END,NULL,
    CASE WHEN a.action='finalize' THEN 'Logo da empresa enviado' WHEN a.command_id IS NULL THEN 'Logo anterior da empresa substituído' ELSE 'Logo da empresa removido' END
   FROM ${T("erp_company", "logo_audit")} a WHERE a.action IN ('finalize','delete') AND ${range("a.created_at")}`,
  `SELECT 'user_signatures',CAST(a.id AS TEXT),a.created_at,a.user_id,'propostas',CASE WHEN a.before_data IS NULL THEN 'criacao' ELSE 'atualizacao' END,NULL,'Assinatura das propostas do usuário'
   FROM ${T("erp_documents", "user_signature_audit")} a WHERE ${range("a.created_at")}`,
  `SELECT 'invoice_tags',CAST(a.id AS TEXT),a.created_at,a.actor,'notas_fiscais',CASE a.action WHEN 'tag_removed' THEN 'exclusao' ELSE 'atualizacao' END,
    coalesce(CAST(i.number AS TEXT),(SELECT ${left("n.payload->>'$.numero'", 20)} FROM ${T("origin_sync", "raw_record")} n WHERE a.origin='origin' AND n.entity=CASE a.model WHEN '65' THEN 'nfce' ELSE 'nfe' END AND n.source_id=a.invoice_id)),
    ${left(`CASE a.action WHEN 'tags_added' THEN 'Tags incluídas' WHEN 'tag_removed' THEN 'Tag excluída' ELSE 'Tags alteradas' END||' na '||CASE a.model WHEN '65' THEN 'NFC-e' ELSE 'NF-e' END
     ||coalesce(' nº '||coalesce(CAST(i.number AS TEXT),(SELECT ${left("n.payload->>'$.numero'", 20)} FROM ${T("origin_sync", "raw_record")} n WHERE a.origin='origin' AND n.entity=CASE a.model WHEN '65' THEN 'nfce' ELSE 'nfe' END AND n.source_id=a.invoice_id)),'')
     ||CASE a.origin WHEN 'origin' THEN ' (Origin)' ELSE '' END`, 200)}
   FROM ${T("erp_catalog", "invoice_tag_audit")} a LEFT JOIN ${T("erp_fiscal_invoices", "invoice")} i ON a.origin='brufap' AND i.id=a.invoice_id WHERE ${range("a.created_at")}`,
  `SELECT 'lots',c.id,c.created_at,c.actor,'estoque',
    CASE WHEN c.action='save' AND (${bool("c.result", "created")} OR c.result->>'$.outcome'='created') THEN 'criacao' WHEN c.action='launch' THEN 'criacao'
     WHEN c.action='status' AND (c.result->>'$.lot.active') THEN 'atualizacao_situacao' WHEN c.action='status' THEN 'exclusao' ELSE 'atualizacao' END,
    ${left("r.code", 120)},
    ${left(`CASE WHEN c.action='assign' THEN 'Lotes informados no lançamento de estoque'||coalesce(' do produto '||r.name,'')
     ELSE 'Lote '||coalesce(l.code,'')||coalesce(' do produto '||r.name,'')||CASE WHEN c.action='launch' THEN ' · criado no lançamento de estoque'
     WHEN c.action='status' AND (c.result->>'$.lot.active') THEN ' · reativado' WHEN c.action='status' THEN ' · excluído'
     WHEN c.result->>'$.scope'='stock_lot_import' THEN ' · importação de planilha' ELSE '' END END`, 200)}
   FROM ${T("erp_stock", "lot_command")} c LEFT JOIN ${T("erp_stock", "lot")} l ON l.id=c.lot_id LEFT JOIN ${T("erp_catalog", "record")} r ON r.id=c.product_id
   WHERE (c.action<>'launch' OR (c.result->>'$.lot.created')) AND coalesce(c.result->>'$.outcome','')<>'unchanged' AND ${range("c.created_at")}`,
  `SELECT 'invoice_stock',c.id,c.created_at,c.actor,'notas_fiscais',CASE c.action WHEN 'reverse' THEN 'estorno' ELSE 'lancamento' END,CAST(i.number AS TEXT),
    ${left(`CASE c.action WHEN 'reverse' THEN 'Estoque estornado da ' ELSE 'Estoque lançado pela ' END||CASE i.model WHEN '65' THEN 'NFC-e' ELSE 'NF-e' END||coalesce(' nº '||i.number,'')
     ||CASE c.action WHEN 'checkin' THEN ' · ao finalizar o check-in' ELSE '' END`, 200)}
   FROM ${T("erp_stock", "invoice_command")} c LEFT JOIN ${T("erp_fiscal_invoices", "invoice")} i ON i.id=c.invoice_id WHERE ${range("c.created_at")}`,
  `SELECT 'company_files',CAST(a.id AS TEXT),a.created_at,a.actor,'anexos',CASE a.action WHEN 'finalize' THEN 'criacao' ELSE 'exclusao' END,NULL,
    ${left(`CASE a.action WHEN 'finalize' THEN 'Arquivo da empresa incluído' ELSE 'Arquivo da empresa excluído' END||' · '||f.filename`, 200)}
   FROM ${T("erp_company", "file_audit")} a JOIN ${T("erp_company", "file")} f ON f.id=a.file_id WHERE a.action IN ('finalize','delete') AND ${range("a.created_at")}`,
].join("\nUNION ALL\n");
