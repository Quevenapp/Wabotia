/** Importações de Dados (Preferências › Importações de Dados, migration 228): the reusable spreadsheet import framework.
 * One contract for the browser (cell reading, column mapping and validation preview) and the Worker (strict batch capture):
 * - a template per kind lists the Origin columns (label, API key, grammar); a cell is normalized to one canonical text, and the
 *   Worker accepts only canonical values, so the server never guesses a format;
 * - the browser sends validation (dry_run) and import batches of at most IMPORT_BATCH_ITEMS items; each import batch carries a
 *   command_id and the job_id of the file, so "Conferir resultado" resends the same command and a row of the job is never
 *   imported twice;
 * - the database runs each item through the module's own RPC (the same rules as its screen) and answers one result per item.
 * Another lane adopts the framework by adding a template here, its row handler in erp_preferences.import_item (SQL) and the
 * hub entry. Synthetic examples only in tests. */
import{validCnpj}from'./preferences/core.mjs';
export const IMPORT_BASE='/v1/importacoes';
export const IMPORT_BODY_BYTES=262144;
export const IMPORT_MAX_BYTES=262144;
export const IMPORT_BATCH_ITEMS=50;
export const IMPORT_BATCH_LINES=500;
export const IMPORT_FILE_ROWS=10000;
export const IMPORT_FILE_BYTES=20*1024*1024;
// 265: composições, campos customizados and fornecedores de produtos (Origin "Importações: composições · Campos Customizados ·
// fornecedores de produto"; the Lista de Preços import lives in Cadastros › Listas de preços, ⋮ Importar).
// 300: Lotes (Origin "Importações: … Lista de Preços · Lotes"), through erp_stock_lot_import of the stock lane (277).
// Wabotia (versão 28 do esquema do ERP): dados fiscais dos produtos, naturezas de operação com as regras fiscais e saldos iniciais
// das contas financeiras.
export const IMPORT_KINDS=Object.freeze(['products','contacts','purchase_orders','stock_movements','receivables','payables','sales_orders','nfe','compositions','custom_fields','product_suppliers','lots',
 'product_taxes','natures','opening_balances']);
/** Address of each import screen and API path (/preferencias/importacoes/<slug>, /v1/importacoes/<slug>/lote). */
export const IMPORT_SLUGS=Object.freeze({products:'produtos',contacts:'contatos',purchase_orders:'pedidos-compra',stock_movements:'movimentacoes-estoque',
 receivables:'contas-receber',payables:'contas-pagar',sales_orders:'vendas',nfe:'notas-fiscais',compositions:'composicoes',custom_fields:'campos-customizados',product_suppliers:'fornecedores-produtos',lots:'lotes',
 product_taxes:'fiscal-produtos',natures:'naturezas-operacao',opening_balances:'saldos-iniciais'});
/** Kinds whose validation (dry run) answers what the line changes in `reference` (the preview of each record). */
export const IMPORT_PREVIEW_KINDS=Object.freeze(['product_taxes','natures','opening_balances']);
/** Start of the preview reference of a natureza whose "Padrão para" takes the default from another natureza: only with confirmation. */
export const IMPORT_DEFAULT_CHANGE='Troca a natureza padrão';
export const IMPORT_RESULT_STATUSES=Object.freeze(['valid','created','updated','unchanged','invalid']);
export const IMPORT_JOB_STATUSES=Object.freeze(['em_andamento','concluida']);
export class ImportContractError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
const fail=(status=400,code='ERP_INVALID_INPUT')=>{throw new ImportContractError(status,code);};
const need=(v,...e)=>{if(!v)fail(...e);};
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const exact=(v,keys,...e)=>need(plain(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)),...e);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const importUuid=v=>typeof v==='string'&&UUID.test(v);
const CONTROL=/[\u0000-\u001f\u007f]/,AREA_CONTROL=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const int=(v,min=0,max=2147483647)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const len=v=>[...v].length;
export const importKindOf=slug=>Object.entries(IMPORT_SLUGS).find(([,s])=>s===slug)?.[0]??null;
export const foldHeader=value=>String(value??'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/\s+/g,' ').trim();

// ---- Column grammar ----
// t: text (max, multiline), digits (lengths), decimal (int digits, scale, signed), integer (max), date, bool, option (values).
// Wabotia (alteração local, web/erp/ORIGEM.json): CPF/CNPJ of a contato: 11 or 14 digits as before, or the CNPJ alfanumérico (12 [0-9A-Z] + 2 digits) of the contact
// registry, upper-cased and checked with its check digits (validCnpj, erp_catalog.valid_cnpj).
const text=(max,extra={})=>({t:'text',max,...extra}),area=max=>({t:'text',max,multiline:true}),digits=(...lengths)=>({t:'digits',lengths}),
 personDocument=()=>({t:'digits',lengths:[11,14],cnpj:true}),
 alnumCnpj=v=>typeof v==='string'&&/[A-Z]/.test(v)&&validCnpj(v),
 decimal=(intDigits,scale,extra={})=>({t:'decimal',int:intDigits,scale,...extra}),integer=max=>({t:'integer',max}),DATE={t:'date'},BOOL={t:'bool'},
 option=(...values)=>({t:'option',options:values.map(([value,label,...aliases])=>({value,label,aliases}))});
// Wabotia (versão 28): code (one text matched by a pattern, `strip` drops dots, dashes and spaces, `upper` upper-cases) and list
// (values separated by comma or semicolon, each with the `item` grammar, distinct, up to `max`).
const code=(pattern,hint,extra={})=>({t:'code',pattern,hint,...extra}),list=(item,max,hint)=>({t:'list',item,max,hint});
const col=(label,key,grammar,extra={})=>Object.freeze({label,key,...grammar,...extra});
const ORIGINS=option(...['0','1','2','3','4','5','6','7','8'].map(d=>[d,d]));
const ITEM_TYPES=option(...['00','01','02','03','04','05','06','07','08','09','10','99'].map(d=>[d,d]));
const PRODUCT_COLUMNS=[
 col('Código','code',text(100),{match:true}),col('Descrição','name',text(200),{createRequired:true}),col('Unidade','unit',text(16)),col('NCM','ncm',digits(8)),col('Origem','origin',ORIGINS),
 col('Preço','price',decimal(14,10)),col('Valor IPI fixo','ipi_fixed_value',decimal(11,4)),col('Observações','notes',area(2000)),
 col('Situação','active',option(['true','Ativo','a'],['false','Inativo','i'])),col('Localização','location',text(100)),col('Estoque máximo','stock_max',decimal(12,6)),
 col('Estoque mínimo','stock_min',decimal(12,6)),col('Peso líquido (Kg)','net_weight',decimal(12,6)),col('Peso bruto (Kg)','gross_weight',decimal(12,6)),col('GTIN/EAN','gtin',digits(8,12,13,14)),
 col('GTIN/EAN tributário','gtin_tax',text(14)),col('Largura do produto','width',decimal(12,6)),col('Altura do Produto','height',decimal(12,6)),col('Profundidade do produto','depth',decimal(12,6)),
 col('Data Validade','expiry_date',DATE),col('Descrição Complementar','complementary_description',area(4000)),col('Itens p/ caixa','items_per_box',integer(999999)),
 col('Tipo Produção','production',option(['own','Própria','propria'],['third_party','Terceiros'])),col('Classe de enquadramento do IPI','ipi_framework_class',digits(3)),
 col('Tipo do item','item_type',ITEM_TYPES),col('Tributos','tax_percent',decimal(3,4)),col('Grupo de produtos','product_group',text(200)),col('Marca','brand',text(100)),col('CEST','cest',digits(7)),
 col('Volumes','volumes',integer(999999)),col('Descrição Curta','description',area(4000)),col('Cross-Docking','crossdocking_days',integer(9999)),col('Link Externo','external_link',text(120)),
 col('Condição do produto','condition',option(['unspecified','Não Especificado','nao especificado'],['new','Novo'],['used','Usado'],['refurbished','Recondicionado'])),
 col('Frete Grátis','free_shipping',BOOL),col('Número FCI','fci_number',text(36)),col('Vídeo','video_url',text(100)),
 col('Unidade de medida','dimension_unit',option(['m','Metros','metro'],['cm','Centímetros','centimetro'],['mm','Milímetros','milimetro'])),
 col('Valor base ICMS ST para retenção','icms_st_retention_base',decimal(13,2)),col('Valor ICMS ST para retenção','icms_st_retention_value',decimal(13,2)),
 col('Valor ICMS próprio do substituto','icms_own_substitute_value',decimal(13,2)),col('Categoria do produto','category',text(200)),col('Informações Adicionais','additional_info',area(2000)),
 col('Tipo','kind',option(['P','Produto'],['S','Serviço','servico'])),
];
// Columns of the Brufap/Origin product sheet that this import does not write (stock comes from stock movements, suppliers and
// images from the product form): they are reported as ignored, never guessed.
const PRODUCT_READ_ONLY=['ID','Estoque','Preço de custo','Cód no fornecedor','Fornecedor','Descrição do Produto no Fornecedor','Meses Garantia no Fornecedor','Preço de compra','Tags','URL Imagens Externas','Formato'];
const contactColumns=role=>[col('Número do pedido','number',text(30),{group:true,required:true}),col('Data','date',DATE,{required:true}),
 col(role==='supplier'?'Fornecedor':'Cliente','contact_name',text(200)),col(role==='supplier'?'CPF/CNPJ do fornecedor':'CPF/CNPJ do cliente','contact_document',personDocument()),
 col('Data prevista','expected_date',DATE),col('Frete','freight',decimal(12,2)),col('Observações','notes',area(4000)),col('Observações internas','internal_notes',area(4000)),
 col('Código do produto','item_code',text(100),{line:true}),col('Descrição do produto','item_description',text(200),{line:true}),col('Unidade','item_unit',text(16),{line:true}),
 col('Quantidade','item_quantity',decimal(9,6,{positive:true}),{line:true,required:true}),col('Valor unitário','item_unit_price',decimal(14,10),{line:true}),col('Desconto (%)','item_discount_percent',decimal(3,4),{line:true})];
// Notas fiscais em lote: one NF-e de saída (rascunho em homologação) per Número da nota, items as in the pedidos.
const invoiceColumns=()=>[col('Número da nota','number',text(30),{group:true,required:true}),col('Data de emissão','date',DATE),col('Natureza de operação','nature',text(60)),
 col('Cliente','contact_name',text(200)),col('CPF/CNPJ do cliente','contact_document',personDocument()),col('Informações complementares','notes',area(4000)),
 col('Código do produto','item_code',text(100),{line:true}),col('Descrição do produto','item_description',text(120),{line:true}),col('Unidade','item_unit',text(6),{line:true}),
 col('Quantidade','item_quantity',decimal(11,4,{positive:true}),{line:true,required:true}),col('Valor unitário','item_unit_price',decimal(11,10),{line:true})];
const financeColumns=role=>[col(role==='supplier'?'Fornecedor':'Cliente','contact_name',text(200)),col('CPF/CNPJ','contact_document',personDocument()),col('Histórico','description',text(240),{required:true}),
 col('Data de emissão','issued_on',DATE,{required:true}),col('Data de vencimento','due_on',DATE,{required:true}),col('Valor','amount',decimal(13,2,{positive:true}),{required:true}),
 col('Nº documento','source_reference',text(200)),col('Competência','competence_on',DATE),col('Categoria','category',text(200)),col('Conta financeira','account',text(200)),
 col('Forma de pagamento','payment_method',text(200))];
/** Grouped templates: the lines with the same `key` form one item (`unit` names it in the messages); every line needs `itemRequired`,
 * and one of `itemOneOf` when given; `contact` asks the contato of the document; `max` lines per item (default 250; the composições
 * follow the 100 components of the Estrutura, erp_stock_product_compose). */
const ORDER_GROUP=Object.freeze({key:'number',unit:'pedido',tooMany:'O pedido tem mais de 250 itens',itemRequired:Object.freeze(['quantity']),itemOneOf:Object.freeze(['code','description']),contact:true});
// ---- Wabotia (versão 28): fiscal dos produtos, naturezas e regras fiscais, saldos iniciais ----
// The codes are the ones of the natureza rules (erp_fiscal_invoices.nature_specs); the server checks again against the regime
// (CST or CSOSN) and the direction (IPI) of the natureza. NCM and CEST: the format (8 and 7 digits); the repository has no table of
// valid codes.
const ICMS_SITUATION=code('^(00|02|10|15|20|30|40|41|50|51|53|60|61|70|90|101|102|103|201|202|203|300|400|500|900)$','CST de 2 dígitos (Regime normal) ou CSOSN de 3 dígitos (Simples Nacional)',{strip:true});
const IPI_SITUATION=code('^(00|01|02|03|04|05|49|50|51|52|53|54|55|99)$','CST do IPI: 00 a 05 ou 49 (entrada), 50 a 55 ou 99 (saída)',{strip:true});
const PIS_SITUATION=code('^(01|02|03|04|05|06|07|08|09|49|50|51|52|53|54|55|56|60|61|62|63|64|65|66|67|70|71|72|73|74|75|98|99)$','CST de PIS/COFINS de 2 dígitos (01 a 99)',{strip:true});
const ANY_SITUATION=code('^([0-9]{2,3}|T|N)$','CST ou CSOSN do imposto (T ou N no II)',{strip:true,upper:true});
const CFOP=code('^[1-7][0-9]{3}$','CFOP de 4 dígitos (1000 a 7999)',{strip:true});
const BENEFIT=code('^[A-Z0-9]{8}([A-Z0-9]{2})?$','código de 8 ou 10 letras e números',{strip:true,upper:true});
const GTIN_TAX=code('^(SEM GTIN|[0-9]{8}|[0-9]{12,14})$','8, 12, 13 ou 14 dígitos, ou SEM GTIN',{upper:true});
const RATE=decimal(3,4);
const UF_OPTIONS=option(...['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'].map(u=>[u,u]),['EX','EX','exterior']);
/** Códigos de "Padrão para" das naturezas (DEFAULT_LABELS do fiscal-core), com a direção que cada um aceita. */
export const IMPORT_NATURE_DEFAULTS=Object.freeze({S:['1','Padrão venda'],E:['0','Padrão compra'],VF:['1','Padrão venda física'],VJ:['1','Padrão venda jurídica'],CF:['0','Padrão compra física'],
 CJ:['0','Padrão compra jurídica'],C:['1','Padrão venda cupom'],DE:['0','Padrão devolução (entrada)'],DS:['1','Padrão devolução (saída)']});
const DEFAULT_OPTIONS=option(...Object.entries(IMPORT_NATURE_DEFAULTS).map(([value,[,label]])=>[value,label,label.replace('Padrão ','')]));
const TAX_COLUMNS=[['icms','ICMS'],['ipi','IPI'],['pis','PIS'],['cofins','COFINS']];
const PRODUCT_TAX_COLUMNS=[
 col('Código','code',text(100),{match:true,help:'Código do produto no ERP. Informe o Código ou o GTIN/EAN.',example:'CAMISETA-P'}),
 col('GTIN/EAN','gtin',digits(8,12,13,14),{match:true,help:'Usado para achar o produto quando a linha não tem Código.',example:'7891234567895'}),
 col('NCM','ncm',digits(8),{help:'8 dígitos, com ou sem pontos.',example:'6109.10.00'}),
 col('CEST','cest',digits(7),{help:'7 dígitos. O produto precisa ter NCM.',example:'2806300'}),
 col('Origem','origin',ORIGINS,{help:'0 a 8 (0 = nacional).',example:'0'}),
 col('Unidade tributável','tax_unit',text(6),{help:'O ERP usa a Unidade do produto como unidade tributável: deixe vazia ou igual à Unidade do produto.',example:'UN'}),
 col('GTIN/EAN tributável','gtin_tax',GTIN_TAX,{help:'8, 12, 13 ou 14 dígitos, ou SEM GTIN.',example:'SEM GTIN'}),
 col('Natureza de operação','nature',text(60),{help:'Nome da natureza onde ficam as regras de impostos deste produto. Vazia: a natureza com o Padrão venda.',example:'Venda de mercadoria'}),
 col('ICMS: CST/CSOSN','icms_situation',ICMS_SITUATION,{help:'CST (Regime normal) ou CSOSN (Simples Nacional), conforme o regime da natureza.',example:'102'}),
 col('CFOP','icms_cfop',CFOP,{help:'CFOP do ICMS deste produto na natureza.',example:'5102'}),
 col('Alíquota ICMS (%)','icms_rate',RATE,{help:'Número com vírgula, até 4 casas.',example:'18'}),
 col('Benefício fiscal (cBenef)','benefit_code',BENEFIT,{help:'Código do benefício fiscal do ICMS (8 ou 10 letras e números).',example:'SP070001'}),
 col('IPI: CST','ipi_situation',IPI_SITUATION,{help:'50 a 55 ou 99 nas naturezas de saída; 00 a 05 ou 49 nas de entrada.',example:'53'}),
 col('Alíquota IPI (%)','ipi_rate',RATE,{example:'0'}),
 col('PIS: CST','pis_situation',PIS_SITUATION,{example:'49'}),col('Alíquota PIS (%)','pis_rate',RATE,{example:'0,65'}),
 col('COFINS: CST','cofins_situation',PIS_SITUATION,{example:'49'}),col('Alíquota COFINS (%)','cofins_rate',RATE,{example:'3'}),
];
const label=(columns,key)=>columns.find(c=>c.key===key)?.label??key;
/** Combinations a line must keep (preview and Worker): rate, CFOP and benefit only with the CST of the tax; a natureza only with a tax. */
function productTaxProblems(data){
 const out=[],l=key=>label(PRODUCT_TAX_COLUMNS,key);
 for(const[tax]of TAX_COLUMNS){const situation=data[`${tax}_situation`]!==undefined;
  for(const key of[`${tax}_rate`,...(tax==='icms'?['icms_cfop','benefit_code']:[])])if(data[key]!==undefined&&!situation)out.push(`${l(key)}: informe também ${l(`${tax}_situation`)}`);}
 if(data.nature!==undefined&&!TAX_COLUMNS.some(([tax])=>data[`${tax}_situation`]!==undefined))out.push(`${l('nature')}: informe o CST de ao menos um imposto`);
 if(!Object.keys(data).some(k=>!['code','gtin'].includes(k)))out.push('Linha sem nenhuma coluna fiscal preenchida');
 return out;
}
const NATURE_COLUMNS=[
 col('Natureza de operação','description',text(60),{group:true,required:true,help:'Nome da natureza. As linhas com o mesmo nome formam uma natureza; uma natureza com esse nome e o mesmo Tipo é atualizada.',example:'Venda de mercadoria'}),
 col('Tipo','direction',option(['0','Entrada','e'],['1','Saída','saida','s']),{required:true,help:'Entrada ou Saída.',example:'Saída'}),
 col('Regime tributário','crt',option(['1','Simples Nacional','simples'],['2','Simples Nacional - excesso de sublimite','excesso de sublimite'],['3','Regime Normal','normal'],['4','MEI','Simples Nacional - MEI']),
  {help:'Obrigatório para incluir: Simples Nacional, Simples Nacional - excesso de sublimite, Regime Normal ou MEI.',example:'Simples Nacional'}),
 col('Série','series',integer(999),{help:'Série da nota (0 a 999).',example:'1'}),
 col('Consumidor final','final_consumer',BOOL,{help:'Sim ou Não.',example:'Não'}),
 col('Padrão para','default_for',list(DEFAULT_OPTIONS,9,'códigos de Padrão para separados por vírgula'),{help:'S, VF, VJ, C, DS (saída) ou E, CF, CJ, DE (entrada), separados por vírgula. Tirar o padrão de outra natureza pede confirmação na tela.',example:'S, VJ'}),
 col('Informações complementares','additional_info',area(5000),{help:'Texto das informações complementares da nota.',example:''}),
 col('Informações ao fisco','fiscal_info',area(2000),{example:''}),
 col('Imposto','item_tax',option(['icms','ICMS'],['ipi','IPI'],['pis','PIS'],['cofins','COFINS'],['ii','II','imposto de importacao']),{line:true,help:'Uma regra por linha: ICMS, IPI, PIS, COFINS ou II. Linha sem imposto só descreve a natureza.',example:'ICMS'}),
 col('CST/CSOSN','item_situation',ANY_SITUATION,{line:true,help:'Obrigatório na regra. ICMS: CST no Regime normal, CSOSN no Simples Nacional.',example:'102'}),
 col('CFOP','item_cfop',CFOP,{line:true,help:'Só no ICMS.',example:'5102'}),
 col('Alíquota (%)','item_rate',RATE,{line:true,example:'18'}),
 col('Base de cálculo (%)','item_base_rate',RATE,{line:true,help:'Percentual da base (100 = sem redução).',example:'100'}),
 col('Benefício fiscal (cBenef)','item_benefit_code',BENEFIT,{line:true,help:'Só no ICMS.',example:''}),
 col('Destinos (UF)','item_destinations',list(UF_OPTIONS,28,'UFs separadas por vírgula (EX para exterior)'),{line:true,help:'Vazio: vale para todos os destinos.',example:'SP, RJ'}),
 col('NCMs','item_ncms',list(code('^[0-9]{2}([0-9]{2}){0,3}$','início do NCM com 2, 4, 6 ou 8 dígitos',{strip:true}),10,'inícios de NCM separados por vírgula'),{line:true,help:'Vazio: vale para todos os produtos. Até 10 inícios de NCM (2, 4, 6 ou 8 dígitos).',example:'6109'}),
];
function natureProblems(data){
 const out=[],l=key=>label(NATURE_COLUMNS,`item_${key}`);
 if(Array.isArray(data.default_for))for(const c of data.default_for)if(data.direction!==undefined&&IMPORT_NATURE_DEFAULTS[c]?.[0]!==data.direction)
  out.push(`Padrão para: ${IMPORT_NATURE_DEFAULTS[c]?.[1]??c} não vale para uma natureza de ${data.direction==='0'?'entrada':'saída'}`);
 (Array.isArray(data.items)?data.items:[]).forEach((item,i)=>{const at=`Regra ${i+1}`,keys=Object.keys(item);
  if(!keys.length)return;
  if(item.tax===undefined){out.push(`${at}: informe o ${l('tax')}`);return;}
  if(item.situation===undefined)out.push(`${at}: informe ${l('situation')}`);
  for(const key of['cfop','benefit_code'])if(item[key]!==undefined&&item.tax!=='icms')out.push(`${at}: ${l(key)} só no ICMS`);
  if(item.tax==='ii'&&item.situation!==undefined&&!['T','N'].includes(item.situation))out.push(`${at}: no II, CST/CSOSN é T (tributado) ou N (não tributado)`);
  if(item.tax!=='ii'&&item.tax!=='icms'&&item.situation!==undefined&&!/^[0-9]{2}$/.test(item.situation))out.push(`${at}: ${l('situation')} de 2 dígitos no ${item.tax.toUpperCase()}`);});
 return out;
}
const OPENING_COLUMNS=[
 col('Conta financeira','account',text(50),{required:true,help:'Nome da conta como está em Financeiro › Caixas e bancos.',example:'Banco do Brasil'}),
 col('Data','date',DATE,{required:true,help:'Dia do saldo (dd/mm/aaaa), a partir da Data de início da conta.',example:'31/12/2025'}),
 col('Saldo','balance',decimal(13,2,{signed:true}),{required:true,help:'Saldo da conta no fim desse dia, com vírgula; negativo com sinal de menos.',example:'1.500,00'}),
 col('Observação','note',text(400),{help:'Entra no histórico do lançamento.',example:'Saldo trazido do sistema antigo'}),
];
/** Templates in the order of the Origin hub (Produtos, Contatos, Suprimentos, Finanças, Vendas). `title` is the Origin entry. */
export const IMPORT_TEMPLATES=Object.freeze({
 products:Object.freeze({kind:'products',title:'Importar e atualizar produtos',noun:['produto','produtos'],file:'modelo-produtos',columns:Object.freeze(PRODUCT_COLUMNS),readOnly:Object.freeze(PRODUCT_READ_ONLY),
  rule:'Um produto por linha. Com Código de um produto já cadastrado, a linha atualiza só as colunas preenchidas; sem Código, ou com um código novo, inclui o produto (Origem vazia usa a "Origem padrão de tributação de produtos" das Configurações de produtos).'}),
 // Contatos: the columns are the contatos lane sheet (the same of "Exportar para a planilha"), read by its own row reader.
 contacts:Object.freeze({kind:'contacts',title:'Importar e atualizar contatos',noun:['contato','contatos'],file:'modelo-contatos',columns:null,readOnly:Object.freeze(['Vendedor','Categoria','Natureza de Operação Padrão']),
  rule:'Um contato por linha. Com o CPF/CNPJ de um contato já cadastrado, a linha atualiza só as colunas preenchidas; sem CPF/CNPJ, ou com um novo, inclui o contato com as regras do formulário.'}),
 purchase_orders:Object.freeze({kind:'purchase_orders',title:'Importar pedidos de compra',noun:['pedido de compra','pedidos de compra'],file:'modelo-pedidos-compra',columns:Object.freeze(contactColumns('supplier')),readOnly:Object.freeze([]),grouped:ORDER_GROUP,
  rule:'Uma linha por item. As linhas com o mesmo Número do pedido formam um pedido; Data, fornecedor e observações vêm da primeira linha do pedido. O pedido é incluído Em aberto, sem lançar estoque nem contas, e recebe o próximo número do Brufap.'}),
 stock_movements:Object.freeze({kind:'stock_movements',title:'Importar movimentações de estoque em massa',noun:['movimentação','movimentações'],file:'modelo-movimentacoes-estoque',readOnly:Object.freeze([]),
  columns:Object.freeze([col('Código do produto','code',text(100),{required:true}),col('Depósito','warehouse',text(200)),col('Tipo','movement',option(['receipt','Entrada','e'],['issue','Saída','saida','s'],['balance','Balanço','balanco','b']),{required:true}),
   col('Quantidade','quantity',decimal(9,6),{required:true}),col('Data','date',DATE),col('Observação','note',text(400))]),
  rule:'Uma movimentação por linha, no depósito informado (vazio: o depósito padrão). Entrada soma, Saída subtrai e Balanço deixa o saldo igual à quantidade. Vale a política de estoque negativo; as movimentações do arquivo ficam com a referência da importação.'}),
 receivables:Object.freeze({kind:'receivables',title:'Importar contas a receber',noun:['conta a receber','contas a receber'],file:'modelo-contas-receber',columns:Object.freeze(financeColumns('customer')),readOnly:Object.freeze([]),oneOf:Object.freeze(['contact_name','contact_document']),
  rule:'Uma conta por linha, em aberto (sem baixa). O contato é encontrado pelo CPF/CNPJ ou, sem ele, pelo nome; categoria, conta financeira e forma de pagamento pelo nome. Sem Competência, vale a Data de emissão.'}),
 payables:Object.freeze({kind:'payables',title:'Importar contas a pagar',noun:['conta a pagar','contas a pagar'],file:'modelo-contas-pagar',columns:Object.freeze(financeColumns('supplier')),readOnly:Object.freeze([]),oneOf:Object.freeze(['contact_name','contact_document']),
  rule:'Uma conta por linha, em aberto (sem baixa). O contato é encontrado pelo CPF/CNPJ ou, sem ele, pelo nome; categoria, conta financeira e forma de pagamento pelo nome. Sem Competência, vale a Data de emissão.'}),
 sales_orders:Object.freeze({kind:'sales_orders',title:'Importar vendas',noun:['pedido de venda','pedidos de venda'],file:'modelo-vendas',columns:Object.freeze(contactColumns('customer')),readOnly:Object.freeze([]),grouped:ORDER_GROUP,
  rule:'Uma linha por item. As linhas com o mesmo Número do pedido formam um pedido; Data, cliente e observações vêm da primeira linha do pedido. O pedido é incluído Em aberto, sem lançar estoque nem contas, e recebe o próximo número do Brufap.'}),
 nfe:Object.freeze({kind:'nfe',title:'Importar notas fiscais em Lote',noun:['nota fiscal','notas fiscais'],file:'modelo-notas-fiscais',columns:Object.freeze(invoiceColumns()),readOnly:Object.freeze([]),grouped:ORDER_GROUP,
  rule:'Uma linha por item. As linhas com o mesmo Número da nota formam uma NF-e de saída, incluída como rascunho em homologação (sem número nem envio à SEFAZ), com a natureza informada ou a padrão do tipo de pessoa e o cálculo automático de impostos. A emissão segue as etapas e a política do ambiente.'}),
 // 265: Composições (aba Estrutura do produto): one line per componente; Campos Customizados: one line per campo of a produto;
 // fornecedores de produto: one fornecedor of a produto per line.
 compositions:Object.freeze({kind:'compositions',title:'Importar composições',noun:['composição','composições'],file:'modelo-composicoes',readOnly:Object.freeze(['Descrição','Descrição do componente']),
  grouped:Object.freeze({key:'code',unit:'produto',max:100,tooMany:'A composição tem mais de 100 componentes (o limite da aba Estrutura)',itemRequired:Object.freeze(['code','quantity']),contact:false}),
  columns:Object.freeze([col('Código do produto','code',text(100),{group:true,required:true}),col('Tipo de estoque','stock_type',option(['physical','Físico','fisico','f'],['virtual','Virtual','v']),{required:true}),
   col('Lançar estoque','post_mode',option(['product','Produto'],['components','Componentes'],['both','Produto e componente','produto e componentes'])),
   col('Código do componente','item_code',text(100),{line:true,required:true}),col('Quantidade','item_quantity',decimal(12,6,{positive:true}),{line:true,required:true})]),
  rule:'Uma linha por componente. As linhas com o mesmo Código do produto formam a estrutura da composição, gravada como na aba Estrutura do produto: Tipo de estoque Físico ou Virtual e Lançar estoque (Produto, Componentes ou Produto e componente; no Virtual sempre Componentes). O produto passa ao formato "Com composição" e a estrutura da planilha substitui a anterior; os componentes são produtos simples já cadastrados.'}),
 custom_fields:Object.freeze({kind:'custom_fields',title:'Importar campos customizados',noun:['produto','produtos'],file:'modelo-campos-customizados',readOnly:Object.freeze(['Descrição']),
  grouped:Object.freeze({key:'code',unit:'produto',tooMany:'O produto tem mais de 250 campos na planilha',itemRequired:Object.freeze(['field','value']),contact:false}),
  columns:Object.freeze([col('Código do produto','code',text(100),{group:true,required:true}),col('Campo customizado','item_field',text(60),{line:true,required:true}),col('Valor','item_value',area(4000),{line:true,required:true})]),
  rule:'Uma linha por campo. As linhas com o mesmo Código do produto gravam os campos customizados desse produto, encontrados pelo nome (Preferências › Campos customizados); os demais campos do produto não mudam. Listas usam o texto da opção, campos de marcar Sim ou Não, datas dd/mm/aaaa e números com vírgula ou ponto.'}),
 product_suppliers:Object.freeze({kind:'product_suppliers',title:'Importar fornecedores de produto',noun:['fornecedor de produto','fornecedores de produto'],file:'modelo-fornecedores-produtos',readOnly:Object.freeze(['Descrição']),
  oneOf:Object.freeze(['supplier_name','supplier_document']),
  columns:Object.freeze([col('Código do produto','code',text(100),{required:true}),col('Fornecedor','supplier_name',text(200)),col('CPF/CNPJ do fornecedor','supplier_document',personDocument()),
   col('Código no fornecedor','supplier_code',text(60)),col('Descrição do produto no fornecedor','description',text(120)),col('Preço de compra','purchase_price',decimal(14,10)),
   col('Preço de custo','cost_price',decimal(14,10)),col('Meses de garantia no fornecedor','warranty_months',integer(999)),col('Fornecedor padrão','is_default',BOOL)]),
  rule:'Um fornecedor por linha. O produto é encontrado pelo Código e o fornecedor pelo CPF/CNPJ ou, sem ele, pelo nome. A linha inclui o fornecedor no produto (até 20) ou atualiza só as colunas preenchidas do fornecedor que o produto já tem; Fornecedor padrão Sim o torna o padrão do produto.'}),
 // 300: one lot of a produto per line (Estoque › Lotes e validades), with the rules of "+ Adicionar lote" (258).
 lots:Object.freeze({kind:'lots',title:'Importar lotes',noun:['lote','lotes'],file:'modelo-lotes',readOnly:Object.freeze(['Descrição','Saldo']),
  columns:Object.freeze([col('Código do produto','code',text(100),{required:true}),col('Lote','lot',text(60),{required:true}),col('Data de fabricação','manufactured_on',DATE),
   col('Data de validade','expires_on',DATE),col('Obs.','note',text(500))]),
  rule:'Um lote por linha. O produto é encontrado pelo Código e precisa ter Controle de lote (aba Estoque do produto). Um Lote novo é incluído no produto; um Lote que o produto já tem atualiza só as datas e a Obs. preenchidas. Valem as datas obrigatórias de Preferências › Cadastros › Controle de lotes e a fabricação até a validade. Nenhum saldo é lançado: o lote recebe estoque pelos lançamentos.'}),
 // Wabotia (versão 28): the preview (Validar) says what changes in each record; Importar writes through the screens' own rules.
 product_taxes:Object.freeze({kind:'product_taxes',title:'Importar dados fiscais dos produtos',noun:['produto','produtos'],file:'modelo-fiscal-produtos',columns:Object.freeze(PRODUCT_TAX_COLUMNS),
  readOnly:Object.freeze(['Descrição','Unidade']),oneOf:Object.freeze(['code','gtin']),oneOfText:'informe o Código ou o GTIN/EAN do produto',check:productTaxProblems,
  rule:'Um produto por linha, encontrado pelo Código ou, sem ele, pelo GTIN/EAN. A linha atualiza só as colunas preenchidas: NCM, CEST, Origem e GTIN/EAN tributável no cadastro do produto; CST/CSOSN, CFOP, alíquotas e benefício fiscal numa regra só deste produto na natureza informada (vazia: a natureza com o Padrão venda). As outras regras da natureza não mudam. A validação mostra o que muda em cada produto antes de importar.'}),
 natures:Object.freeze({kind:'natures',title:'Importar naturezas de operação e regras fiscais',noun:['natureza','naturezas'],file:'modelo-naturezas-operacao',columns:Object.freeze(NATURE_COLUMNS),readOnly:Object.freeze([]),
  grouped:Object.freeze({key:'description',unit:'natureza',max:250,tooMany:'A natureza tem mais de 250 regras',itemRequired:Object.freeze([]),contact:false}),check:natureProblems,
  extra:Object.freeze({confirm_default:BOOL}),
  rule:'Uma linha por regra fiscal. As linhas com o mesmo nome formam uma natureza: uma natureza com esse nome e o mesmo Tipo é atualizada (só as colunas preenchidas), as outras são incluídas. As regras da planilha substituem as regras gerais e por NCM dos impostos que aparecem nela; as regras por produto ou grupo e os outros impostos ficam. Padrão para tira o padrão de outra natureza só com a confirmação na tela.'}),
 opening_balances:Object.freeze({kind:'opening_balances',title:'Importar saldos iniciais das contas financeiras',noun:['saldo','saldos'],file:'modelo-saldos-iniciais',columns:Object.freeze(OPENING_COLUMNS),readOnly:Object.freeze([]),
  rule:'Um saldo por linha: a conta financeira (pelo nome), o dia e o saldo no fim desse dia. O ERP lança a diferença entre esse saldo e o saldo da conta no dia, como entrada ou saída de caixa com o histórico de saldo inicial (o mesmo lançamento do Financeiro). Importar a mesma planilha de novo não lança nada: o saldo já está igual.'}),
});
/** Planilha modelo: the instructions of the first sheet (Wabotia): title, rule and one row per column with how to fill and an example. */
export function templateInstructions(kind){
 const t=IMPORT_TEMPLATES[kind];need(t&&t.columns,400,'ERP_INVALID_INPUT');
 const kinds={text:'Texto',digits:'Número',decimal:'Número',integer:'Número inteiro',date:'Data',bool:'Sim ou Não',option:'Opção',code:'Código',list:'Lista'};
 return[[t.title],[t.rule],['A planilha com os dados é a segunda aba; esta aba não é importada.'],[],['Coluna','Obrigatória','Tipo','Como preencher','Exemplo'],
  ...t.columns.map(c=>[c.label,c.required||c.group?'Sim':'Não',kinds[c.t]??'',[c.help,c.t==='option'?`Opções: ${c.options.map(o=>o.label).join(', ')}`:c.t==='list'&&c.item.t==='option'?`Opções: ${c.item.options.map(o=>`${o.value} (${o.label})`).join(', ')}`:null].filter(Boolean).join(' '),c.example??''])];
}
/** Kinds whose lines form one item (pedidos, notas, composições and campos customizados of a produto). */
export const isGroupedKind=kind=>Boolean(IMPORT_TEMPLATES[kind]?.grouped);

// ---- Cell normalization (browser): pt-BR text as typed or exported → one canonical value, or a problem ----
// An Excel serial date; a date and time cell (the fraction is the time of day) keeps its own day, never the next one.
const excelDate=serial=>new Date(Date.UTC(1899,11,30)+Math.floor(serial)*86400000).toISOString().slice(0,10);
export const isoDay=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&v>='1900-01-01'&&v<='2100-12-31'&&Number.isFinite(Date.parse(`${v}T00:00:00Z`))&&new Date(`${v}T00:00:00Z`).toISOString().slice(0,10)===v;
const decimalRe=c=>new RegExp(`^${c.signed?'-?':''}(0|[1-9][0-9]{0,${c.int-1}})(\\.[0-9]{1,${c.scale}})?$`);
/** Canonical value of a cell for a column: {value} or {problem} (in Portuguese). An empty cell is {value:undefined}. */
export function normalizeCell(column,raw){
 const value=String(raw??'').trim();if(!value)return{value:undefined};
 switch(column.t){
  case'text':{
   if(len(value)>column.max)return{problem:`até ${column.max} caracteres`};
   if((column.multiline?AREA_CONTROL:CONTROL).test(value))return{problem:column.multiline?'sem caracteres de controle':'em uma linha, sem caracteres de controle'};
   return{value};}
  case'digits':{const d=value.replace(/[\s./-]/g,''),u=column.cnpj?d.toUpperCase():d;if(column.cnpj&&alnumCnpj(u))return{value:u};
   if(!/^\d+$/.test(d)||!column.lengths.includes(d.length))return{problem:column.cnpj&&/[A-Za-z]/.test(d)?'CNPJ alfanumérico inválido':`${column.lengths.join(' ou ')} dígitos`};return{value:d};}
  case'decimal':{
   const t=value.replace(/\s/g,'').replace(/^R\$/i,''),dot=/,/.test(t)?t.replace(/\./g,'').replace(',','.'):t,n=dot.replace(/^(-?)0+(?=\d)/,'$1').replace(/(\.\d*?)0+$/,'$1').replace(/\.$/,'');
   if(!decimalRe(column).test(n)||n==='-0')return{problem:`número com até ${column.int} dígitos inteiros e ${column.scale} casas decimais${column.signed?'':', sem sinal'}`};
   if(column.positive&&!/[1-9]/.test(n))return{problem:'maior que zero'};
   return{value:n};}
  case'integer':{if(!/^(0|[1-9]\d*)$/.test(value)||Number(value)>column.max)return{problem:`número inteiro de 0 a ${column.max}`};return{value};}
  case'date':{const br=/^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value),d=br?`${br[3]}-${br[2]}-${br[1]}`:/^\d{4}-\d{2}-\d{2}$/.test(value)?value:/^\d{4,6}(\.\d+)?$/.test(value)?excelDate(Number(value)):null;
   return d&&isoDay(d)?{value:d}:{problem:'data no formato dd/mm/aaaa'};}
  case'bool':{const f=foldHeader(value);if(['sim','s','true','1','x','verdadeiro'].includes(f))return{value:true};if(['nao','n','false','0','falso'].includes(f))return{value:false};return{problem:'Sim ou Não'};}
  case'option':{const f=foldHeader(value),head=foldHeader(value.split(' - ')[0]);
   const found=column.options.find(o=>[o.value,o.label,...o.aliases].some(x=>foldHeader(x)===f))??column.options.find(o=>[o.value,o.label,...o.aliases].some(x=>foldHeader(x)===head));
   if(!found)return{problem:`uma das opções: ${column.options.map(o=>o.label).join(', ')}`};
   return{value:column.key==='active'?found.value==='true':found.value};}
  case'code':{const v=(column.strip?value.replace(/[\s./-]/g,''):value.replace(/\s+/g,' ')),u=column.upper?v.toUpperCase():v;
   return new RegExp(column.pattern).test(u)?{value:u}:{problem:column.hint};}
  case'list':{const parts=value.split(/[,;|]/).map(v=>v.trim()).filter(Boolean),out=[];
   for(const part of parts){const r=normalizeCell(column.item,part);if(r.problem)return{problem:`${column.hint} (${part}: ${r.problem})`};out.push(r.value);}
   if(new Set(out).size!==out.length)return{problem:`${column.hint}, sem repetir`};
   if(out.length>column.max)return{problem:`até ${column.max} valores`};
   return out.length?{value:out}:{value:undefined};}
 }
 return{problem:'coluna desconhecida'};
}
/** Strict check of a canonical value (Worker): the same grammar, no conversion. */
function canonical(column,value){
 switch(column.t){
  case'text':return typeof value==='string'&&value.trim()===value&&value!==''&&len(value)<=column.max&&!(column.multiline?AREA_CONTROL:CONTROL).test(value);
  case'digits':return typeof value==='string'&&(/^\d+$/.test(value)&&column.lengths.includes(value.length)||Boolean(column.cnpj)&&alnumCnpj(value));
  case'decimal':return typeof value==='string'&&decimalRe(column).test(value)&&value!=='-0'&&(!column.positive||/[1-9]/.test(value));
  case'integer':return typeof value==='string'&&/^(0|[1-9]\d*)$/.test(value)&&Number(value)<=column.max;
  case'date':return isoDay(value);
  case'bool':return typeof value==='boolean';
  case'option':return column.key==='active'?typeof value==='boolean':column.options.some(o=>o.value===value);
  case'code':return typeof value==='string'&&new RegExp(column.pattern).test(value);
  case'list':return Array.isArray(value)&&value.length>=1&&value.length<=column.max&&new Set(value).size===value.length&&value.every(v=>canonical(column.item,v));
 }
 return false;
}

/** Header → column index, folding accents and case. `mapping` (label → header text or '' for "Não importar") overrides the match. */
export function mapHeader(columns,header,mapping={}){
 const folded=header.map(foldHeader),index=new Map(),unknown=[];
 for(const c of columns){const chosen=Object.hasOwn(mapping,c.label)?mapping[c.label]:c.label;if(!chosen)continue;const at=folded.indexOf(foldHeader(chosen));if(at>=0&&![...index.values()].includes(at))index.set(c.key,at);}
 header.forEach((h,i)=>{if(String(h??'').trim()&&![...index.values()].includes(i))unknown.push(String(h).trim());});
 return{index,unknown};
}
/** Rows of a declarative template from the sheet cells (first row = header). Grouped kinds become one item per document. */
export function templateRows(kind,cells,mapping={}){
 const t=IMPORT_TEMPLATES[kind];need(t&&t.columns,400,'ERP_INVALID_INPUT');
 const[header=[],...lines]=cells,{index,unknown}=mapHeader(t.columns,header,mapping);
 const missing=t.columns.filter(c=>c.required&&!index.has(c.key)).map(c=>c.label);
 const readOnly=t.readOnly.filter(label=>header.some(h=>foldHeader(h)===foldHeader(label)));
 const parsed=lines.map((line,i)=>{const data={},problems=[];
  for(const c of t.columns){const at=index.get(c.key);if(at===undefined)continue;const r=normalizeCell(c,line[at]);if(r.problem)problems.push(`${c.label}: ${r.problem}`);else if(r.value!==undefined)data[c.key]=r.value;}
  // Pedidos: the header columns may stay empty after the first line of a document; they are checked per document below.
 for(const c of t.columns)if(c.required&&(c.line||c.group||!isGroupedKind(kind))&&index.has(c.key)&&data[c.key]===undefined&&!problems.some(p=>p.startsWith(`${c.label}:`)))problems.push(`${c.label}: obrigatório`);
  if(!problems.length&&!Object.keys(data).length)problems.push('Linha sem nenhuma coluna do modelo preenchida');
  if(!isGroupedKind(kind)&&t.oneOf&&t.oneOf.every(k=>data[k]===undefined))problems.push(`${t.columns.find(c=>c.key===t.oneOf[0]).label}: ${t.oneOfText??'informe o nome ou o CPF/CNPJ'}`);
  if(!isGroupedKind(kind)&&t.check&&!problems.length)problems.push(...t.check(data));
  return{row:i+2,data,problems};});
 if(!isGroupedKind(kind))return{items:parsed.map(p=>({row:p.row,lines:[p.row],data:p.data,problems:p.problems})),missing,unknown:unknown.filter(u=>!readOnly.includes(u)),readOnly};
 // Pedidos: consecutive or not, the lines with the same Número do pedido form one document, in the order of their first line.
 const groups=new Map();
 const g=t.grouped;
 for(const p of parsed){const key=p.data[g.key]??`#linha-${p.row}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(p);}
 const head=t.columns.filter(c=>!c.line),body=t.columns.filter(c=>c.line);
 const items=[...groups.values()].map(group=>{const first=group[0],data={},problems=group.flatMap(p=>p.problems.map(x=>`Linha ${p.row}: ${x}`));
  for(const c of head){const values=[...new Set(group.map(p=>p.data[c.key]).filter(v=>v!==undefined).map(v=>JSON.stringify(v)))];
   if(values.length>1)problems.push(`${c.label}: valores diferentes nas linhas do mesmo ${g.unit}`);else if(values.length)data[c.key]=JSON.parse(values[0]);}
  for(const c of head)if(c.required&&!c.group&&data[c.key]===undefined&&!problems.some(x=>x.startsWith(`${c.label}:`)))problems.push(`${c.label}: obrigatório na primeira linha do ${g.unit}`);
  data.items=group.map(p=>Object.fromEntries(body.filter(c=>p.data[c.key]!==undefined).map(c=>[c.key.slice(5),p.data[c.key]])));
  if(data.items.length>(g.max??250))problems.push(g.tooMany);
  if(g.contact&&!data.contact_name&&!data.contact_document)problems.push(`${head.find(c=>c.key==='contact_name').label}: informe o nome ou o CPF/CNPJ`);
  if(g.itemOneOf)data.items.forEach((item,i)=>{if(!item.code&&!item.description)problems.push(`Linha ${group[i].row}: informe o Código ou a Descrição do produto`);});
  if(t.check&&!problems.length)problems.push(...t.check(data).map(p=>p.replace(/^Regra (\d+):/,(_,n)=>`Linha ${group[Number(n)-1].row}:`)));
  return{row:first.row,lines:group.map(p=>p.row),data,problems};});
 return{items,missing,unknown:unknown.filter(u=>!readOnly.includes(u)),readOnly};
}
/** Planilha modelo: the header of a declarative template. */
export const templateHeader=kind=>IMPORT_TEMPLATES[kind].columns.map(c=>c.label);

// ---- Worker: strict capture of one batch ----
function captureData(kind,data,validateContact){
 const t=IMPORT_TEMPLATES[kind];
 if(kind==='contacts'){need(plain(data)&&Object.keys(data).length>0&&typeof validateContact==='function');return validateContact(data);}
 need(plain(data));
 const own=[...t.columns.filter(c=>!c.line),...Object.entries(t.extra??{}).map(([key,grammar])=>({key,...grammar}))],lines=t.columns.filter(c=>c.line),
  allowed=new Set([...own.map(c=>c.key),...(isGroupedKind(kind)?['items']:[])]);
 need(Object.keys(data).length>0&&Object.keys(data).every(k=>allowed.has(k)));
 for(const c of own)if(Object.hasOwn(data,c.key))need(canonical(c,data[c.key]));
 for(const c of own)if(c.required)need(Object.hasOwn(data,c.key));
 if(t.oneOf)need(t.oneOf.some(k=>Object.hasOwn(data,k)));
 if(!isGroupedKind(kind)){if(t.check)need(!t.check(data).length);return data;}
 const g=t.grouped;need(Array.isArray(data.items)&&data.items.length>=1&&data.items.length<=(g.max??250)&&(!g.contact||data.contact_name!==undefined||data.contact_document!==undefined));
 const keys=new Map(lines.map(c=>[c.key.slice(5),c]));
 for(const item of data.items){need(plain(item)&&Object.keys(item).every(k=>keys.has(k))&&g.itemRequired.every(k=>Object.hasOwn(item,k))&&(!g.itemOneOf||g.itemOneOf.some(k=>Object.hasOwn(item,k))));
  for(const[k,v]of Object.entries(item))need(canonical(keys.get(k),v));if(Object.hasOwn(item,'quantity'))need(Number(item.quantity)>0);}
 if(t.check)need(!t.check(data).length);
 return data;
}
/** POST /v1/importacoes/<tipo>/lote body: {command_id, job_id, file_name, total_rows, dry_run, items:[{row, lines, data}]}. */
export function captureImportBatch(kind,body,{validateContact}={}){
 need(IMPORT_KINDS.includes(kind),404,'ERP_NOT_FOUND');
 exact(body,['command_id','job_id','file_name','total_rows','dry_run','items']);
 need(typeof body.dry_run==='boolean'&&(body.command_id===null?body.dry_run:importUuid(body.command_id))&&(body.job_id===null?body.dry_run:importUuid(body.job_id)));
 need(typeof body.file_name==='string'&&len(body.file_name)>=1&&len(body.file_name)<=200&&!CONTROL.test(body.file_name)&&body.file_name.trim()===body.file_name&&int(body.total_rows,1,IMPORT_FILE_ROWS));
 need(Array.isArray(body.items)&&body.items.length>=1&&body.items.length<=IMPORT_BATCH_ITEMS);
 const rows=new Set(),items=[];let lineCount=0;
 for(const item of body.items){exact(item,['row','lines','data']);
  need(int(item.row,2,IMPORT_FILE_ROWS+1)&&!rows.has(item.row)&&Array.isArray(item.lines)&&item.lines.length>=1&&item.lines[0]===item.row);
  for(const l of item.lines)need(int(l,2,IMPORT_FILE_ROWS+1));need(new Set(item.lines).size===item.lines.length&&item.lines.every((l,i)=>i===0||l>item.lines[i-1]));
  need(isGroupedKind(kind)?item.lines.length===item.data?.items?.length:item.lines.length===1);
  lineCount+=item.lines.length;rows.add(item.row);items.push({row:item.row,lines:[...item.lines],data:captureData(kind,item.data,validateContact)});}
 need(lineCount<=IMPORT_BATCH_LINES);
 return Object.freeze({kind,command_id:body.command_id,job_id:body.job_id,file_name:body.file_name,total_rows:body.total_rows,dry_run:body.dry_run,items:Object.freeze(items)});
}
const REASON=/^erp_[a-z0-9_]{1,80}(:[a-z0-9_]{1,40})?$/,FIELD=/^[a-z_]{1,40}$/;
function job(v){
 exact(v,['id','kind','file_name','total_rows','rows_done','created','updated','unchanged','invalid','status','actor','created_at','updated_at','finished_at'],502,'ERP_UPSTREAM_INVALID_RESPONSE');
 const bad=()=>fail(502,'ERP_UPSTREAM_INVALID_RESPONSE');
 if(!importUuid(v.id)||!IMPORT_KINDS.includes(v.kind)||typeof v.file_name!=='string'||!v.file_name||len(v.file_name)>200||!int(v.total_rows,1,IMPORT_FILE_ROWS)||!int(v.rows_done,0,v.total_rows))bad();
 for(const k of['created','updated','unchanged','invalid'])if(!int(v[k],0,v.total_rows))bad();
 if(v.created+v.updated+v.unchanged+v.invalid!==v.rows_done||!IMPORT_JOB_STATUSES.includes(v.status)||(v.status==='concluida')!==(v.finished_at!==null))bad();
 exact(v.actor,['user_id','label'],502,'ERP_UPSTREAM_INVALID_RESPONSE');if(!importUuid(v.actor.user_id)||typeof v.actor.label!=='string'||!v.actor.label||len(v.actor.label)>200)bad();
 for(const k of['created_at','updated_at'])if(typeof v[k]!=='string'||!Number.isFinite(Date.parse(v[k])))bad();
 if(v.finished_at!==null&&(typeof v.finished_at!=='string'||!Number.isFinite(Date.parse(v.finished_at))))bad();
 return v;
}
function result(r,{dryRun,lines}){
 exact(r,['row','status','action','reason','field','record_id','reference'],502,'ERP_UPSTREAM_INVALID_RESPONSE');
 const bad=()=>fail(502,'ERP_UPSTREAM_INVALID_RESPONSE');
 if(!int(r.row,2,IMPORT_FILE_ROWS+1)||!IMPORT_RESULT_STATUSES.includes(r.status)||(dryRun!==null&&(dryRun?!['valid','invalid'].includes(r.status):r.status==='valid')))bad();
 if(r.status==='invalid'?r.action!==null&&!['create','update'].includes(r.action)||typeof r.reason!=='string'||!REASON.test(r.reason):r.reason!==null)bad();
 if(r.status==='valid'?!['create','update'].includes(r.action):r.status==='created'?r.action!=='create':['updated','unchanged'].includes(r.status)?r.action!=='update':false)bad();
 if(r.field!==null&&(typeof r.field!=='string'||!FIELD.test(r.field)||r.status!=='invalid'))bad();
 if(r.record_id!==null&&(!importUuid(r.record_id)||['valid','invalid'].includes(r.status)))bad();
 if(['created','updated'].includes(r.status)&&r.record_id===null)bad();
 if(r.reference!==null&&(typeof r.reference!=='string'||!r.reference||len(r.reference)>120||CONTROL.test(r.reference)))bad();
 if(lines&&!lines.has(r.row))bad();
 return r;
}
/** Closed answer of a batch: one result per sent item, in the sent order; the job counters after an import batch. */
export function parseImportBatchResult(raw,input){
 let v;try{v=JSON.parse(JSON.stringify(raw));}catch{return fail(502,'ERP_UPSTREAM_INVALID_RESPONSE');}
 exact(v,['scope','data_mode','kind','dry_run','replayed','job','items'],502,'ERP_UPSTREAM_INVALID_RESPONSE');
 const bad=()=>fail(502,'ERP_UPSTREAM_INVALID_RESPONSE');
 if(v.scope!=='import_batch'||v.data_mode!=='erp_native'||v.kind!==input.kind||v.dry_run!==input.dry_run||typeof v.replayed!=='boolean'||(input.dry_run&&v.replayed))bad();
 if(input.dry_run?v.job!==null:!plain(v.job)||job(v.job).id!==input.job_id||v.job.kind!==input.kind||v.job.file_name!==input.file_name||v.job.total_rows!==input.total_rows)bad();
 if(!Array.isArray(v.items)||v.items.length!==input.items.length)bad();
 v.items.forEach((r,i)=>{result(r,{dryRun:input.dry_run});if(r.row!==input.items[i].row)bad();});
 return v;
}
// ---- Consultar gestão de ações (jobs) ----
export function captureJobsQuery({situacao=null,limit=25,offset=0}={}){
 need((situacao===null||IMPORT_JOB_STATUSES.includes(situacao))&&int(limit,1,100)&&int(offset,0,100000),400,'ERP_INVALID_QUERY');
 return Object.freeze({status:situacao,limit,offset});
}
export function parseJobs(raw,query){
 let v;try{v=JSON.parse(JSON.stringify(raw));}catch{return fail(502,'ERP_UPSTREAM_INVALID_RESPONSE');}
 exact(v,['scope','data_mode','status','limit','offset','total','has_more','all_users','items'],502,'ERP_UPSTREAM_INVALID_RESPONSE');
 const bad=()=>fail(502,'ERP_UPSTREAM_INVALID_RESPONSE');
 if(v.scope!=='import_jobs'||v.data_mode!=='erp_native'||v.status!==query.status||v.limit!==query.limit||v.offset!==query.offset||!int(v.total)||typeof v.all_users!=='boolean')bad();
 if(!Array.isArray(v.items)||v.items.length>v.limit||v.has_more!==(v.offset+v.items.length<v.total))bad();
 const seen=new Set();for(const j of v.items){job(j);if(seen.has(j.id)||(query.status!==null&&j.status!==query.status))bad();seen.add(j.id);}
 return v;
}
export function captureJobQuery(id,{erros=null,limit=100,offset=0}={}){
 need(importUuid(id),404,'ERP_NOT_FOUND');need((erros===null||erros==='1')&&int(limit,1,200)&&int(offset,0,IMPORT_FILE_ROWS),400,'ERP_INVALID_QUERY');
 return Object.freeze({id,errors:erros==='1',limit,offset});
}
export function parseJob(raw,query){
 let v;try{v=JSON.parse(JSON.stringify(raw));}catch{return fail(502,'ERP_UPSTREAM_INVALID_RESPONSE');}
 exact(v,['scope','data_mode','job','errors','limit','offset','total','has_more','items'],502,'ERP_UPSTREAM_INVALID_RESPONSE');
 const bad=()=>fail(502,'ERP_UPSTREAM_INVALID_RESPONSE');
 if(v.scope!=='import_job'||v.data_mode!=='erp_native'||v.errors!==query.errors||v.limit!==query.limit||v.offset!==query.offset||!int(v.total)||job(v.job).id!==query.id)bad();
 if(!Array.isArray(v.items)||v.items.length>v.limit||v.has_more!==(v.offset+v.items.length<v.total))bad();
 let prior=0;for(const r of v.items){result(r,{dryRun:false});if(r.row<=prior||(query.errors&&r.status!=='invalid'))bad();prior=r.row;}
 return v;
}
