/** Small builders for page schemas. Every stored field starts as "stored" (kept for upcoming use); a page marks a field
 * "applied" only when Brufap already behaves according to its value. */
const stored=(extra)=>({status:'stored',...extra});
export const toggle=(key,section,label,value=false,extra={})=>stored({key,section,label,kind:'toggle',default:value,...extra});
export const choice=(key,section,label,options,value,extra={})=>stored({key,section,label,kind:'choice',options,default:value,...extra});
export const radio=(key,section,label,options,value,extra={})=>choice(key,section,label,options,value,{widget:'radio',...extra});
export const multi=(key,section,label,options,value=[],extra={})=>stored({key,section,label,kind:'multi',options,default:value,...extra});
export const integer=(key,section,label,min,max,value,extra={})=>stored({key,section,label,kind:'integer',min,max,default:value,...extra});
export const decimal=(key,section,label,{min=0,max,scale},value,extra={})=>stored({key,section,label,kind:'decimal',min,max,scale,default:value,...extra});
export const text=(key,section,label,maxLength,extra={})=>stored({key,section,label,kind:'text',maxLength,default:'',...extra});
export const email=(key,section,label,extra={})=>text(key,section,label,120,{format:'email',...extra});
export const emails=(key,section,label,extra={})=>text(key,section,label,100,{format:'email_list',maxItems:5,hint:'Separe os endereços por vírgula.',...extra});
export const area=(key,section,label,maxLength=2000,extra={})=>stored({key,section,label,kind:'textarea',maxLength,default:'',...extra});
export const users=(key,section,label,extra={})=>stored({key,section,label,kind:'users',maxItems:100,default:[],...extra});
export const documents=(key,section,label,maxItems,extra={})=>stored({key,section,label,kind:'documents',maxItems,default:[],...extra});
export const keymap=(key,section,label,options,value,extra={})=>stored({key,section,label,kind:'keymap',options,default:value,...extra});
export const info=(id,section,label,text,extra={})=>({id,info:true,section,label,text,status:'unavailable',...extra});
export const applied=(id,section,label,text,extra={})=>info(id,section,label,text,{status:'applied',...extra});
/** Variáveis dos modelos de e-mail dos documentos (src/erp/email/templates.ts). */
export const EMAIL_VARIABLES='Variáveis: {cliente}, {numero}, {valor}, {vencimento}, {link} e {empresa}.';
/** Origin's e-mail block repeated on several pages. `sends`: the document of the page already goes by e-mail (src/erp/email), so the
 * values are applied; the other pages keep them for later. */
export function emailBlock(prefix,section,{subject='Assunto padrão',copy='Email padrão de cópia',sender='Nome padrão do remetente',reply='Email padrão de resposta',message='Mensagem padrão',subjectLength=100,sends=false}={}){
 if(sends){
  const used=(what)=>({status:'applied',note:`Aplicado: ${what} no "Enviar por e-mail" do documento (editável antes de enviar).`});
  return[text(`${prefix}.email_assunto`,section,subject,subjectLength,{...used('assunto do e-mail'),hint:`Vazio: o assunto padrão. ${EMAIL_VARIABLES}`}),
   emails(`${prefix}.email_copia`,section,copy,used('endereços sugeridos em cópia')),
   text(`${prefix}.email_remetente`,section,sender,100,{...used('nome que o cliente vê como remetente'),hint:'Vazio: o nome da empresa. O endereço de envio é o da instalação (Gestão → Sistema → E-mail).'}),
   email(`${prefix}.email_resposta`,section,reply,{...used('endereço que recebe as respostas do cliente'),hint:'Vazio: o e-mail dos Dados da empresa.'}),
   area(`${prefix}.email_mensagem`,section,message,4000,{...used('texto do e-mail'),hint:`Vazio: o texto padrão. ${EMAIL_VARIABLES} O ERP guarda e envia texto simples.`})];
 }
 const note='Guardado. O ERP ainda não envia e-mails; o texto será usado quando o envio existir.';
 return[text(`${prefix}.email_assunto`,section,subject,subjectLength,{note}),emails(`${prefix}.email_copia`,section,copy,{note}),text(`${prefix}.email_remetente`,section,sender,100,{note}),
  email(`${prefix}.email_resposta`,section,reply,{note}),area(`${prefix}.email_mensagem`,section,message,4000,{note,hint:'O sistema de origem usa texto formatado; o ERP guarda o texto simples.'})];
}
/** "Próximo número" of documents: document numbering is not adjustable in Brufap yet. */
export const nextNumber=(id,section)=>info(id,section,'Próximo número','O próximo número ainda não é ajustável no ERP; ele segue a numeração atual dos documentos.');
