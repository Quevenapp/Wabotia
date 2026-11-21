import {storedPreferencePage} from '../../../../packages/erp-domain/src/preferences/catalog.mjs';
import { erpPorts } from '../../ports.ts';
import { requirementEnabled, responseModules } from '../../blocks.ts';
import { erpPreferenceFieldRequirement, erpPreferenceRequirement, erpEntityRequirement } from '../../../../src/erp/parts-requirements.ts';
export const preferenceFieldEnabled = (page: string, key: string) => requirementEnabled(erpPreferenceFieldRequirement(page, key));
import type {AccessState,NativeRequestOptions} from './real-access';
import {parsePreferencesPage as parseFullPage,parsePreferencesResult as parseFullResult,type PreferencesPageView,type PreferencesResult,type PreferencesSaveInput,type PreferenceChange} from '../../../../packages/erp-domain/src/preferences/dto.mjs';
import {preferenceValueValid,preferenceValueEqual,preferenceClone,storedFields,NOT_APPLIED,type PreferenceField,type PreferenceInfo,type PreferencePageSchema,type PreferenceValue,type PreferenceDocument,type PreferenceKeymapOptions} from '../../../../packages/erp-domain/src/preferences/core.mjs';
export {NOT_APPLIED};
import { requirementsEnabled } from "../../modules.ts";
export type {PreferencesPageView,PreferencesResult,PreferencesSaveInput,PreferenceField,PreferenceInfo,PreferencePageSchema,PreferenceValue,PreferenceDocument,PreferenceKeymapOptions};
export interface PreferencesController{getSnapshot:()=>AccessState;subscribe:(fn:()=>void)=>()=>void;preferences:(path:string,options?:NativeRequestOptions)=>Promise<unknown>;stockOpening?:(path:string,options?:NativeRequestOptions)=>Promise<unknown>;
 /** Controle de numeração of the NF-e/NFC-e pages (fiscal lane). */fiscalNumbering?:(path:string,options?:NativeRequestOptions)=>Promise<unknown>}

/** Os campos ocultos só são preenchidos na cópia interna do validador antigo; nunca no formulário ou no envio. */
function expandPreferencePage(raw: any, pageId: string, receipt?: any) {
 const modules=responseModules(raw),page=storedPreferencePage(pageId);
 if(!page||!requirementsEnabled(erpPreferenceRequirement(pageId),modules))throw new Error('Página indisponível.');
 const fields=storedFields(page),shown=fields.filter(f=>requirementsEnabled(erpPreferenceFieldRequirement(pageId,f.key),modules));
 if(!Array.isArray(raw.items)||raw.items.length!==shown.length||raw.items.some((item:any,i:number)=>item?.key!==shown[i]?.key))throw new Error('Campos de preferências inválidos.');
 const {unavailable_parts,...value}=structuredClone(raw);
 value.items=fields.map(field=>{if(shown.includes(field))return raw.items.find((item:any)=>item.key===field.key);
  const change=receipt?.changes?.find((c:any)=>c.key===field.key);
  return {key:field.key,value:change?change.after:field.default,version:change?change.to_version:0,updated_at:change?receipt.changed_at:null};});
 if(!shown.some(f=>f.kind==='users')&&fields.some(f=>f.kind==='users')&&raw.can_manage){if(raw.directory!==null)throw new Error('Diretório inválido.');value.directory=[];}
 if(raw.situations?.some((s:any)=>!requirementsEnabled(erpEntityRequirement(s.kind),modules)))throw new Error('Situação indisponível.');
 return {value,shown};
}
export function parsePreferencesPage(raw: unknown,pageId: string): PreferencesPageView {
 responseModules(raw);
 if(!Object.hasOwn(raw as object,'unavailable_parts'))return parseFullPage(raw,pageId);
 const source=raw as any,{value,shown}=expandPreferencePage(source,pageId),parsed=parseFullPage(value,pageId);
 return {...parsed,items:parsed.items.filter(item=>shown.some(f=>f.key===item.key)),directory:source.directory};
}
export function parsePreferencesResult(raw: unknown,options: Parameters<typeof parseFullResult>[1]): PreferencesResult {
 const source=raw as any;responseModules(source);responseModules(source.page);
 if(!Object.hasOwn(source,'unavailable_parts')&&!Object.hasOwn(source.page,'unavailable_parts'))return parseFullResult(raw,options);
 const {value}=expandPreferencePage(source.page,source.receipt?.page,source.receipt);
 const {unavailable_parts,...command}=source;
 const parsed=parseFullResult({...command,page:value},options);
 return {...parsed,page:parsePreferencesPage(source.page,source.receipt.page)};
}

/** The browser keeps what the user typed; values are normalized only when the change is built. */
export type Draft=Record<string,PreferenceValue|string>;
export const fieldId=(key:string,suffix?:string)=>`pref-${key.replaceAll('.','-')}${suffix?`-${suffix}`:''}`;
export function draftOf(view:PreferencesPageView):Draft{return Object.fromEntries(view.items.map(item=>[item.key,preferenceClone(item.value)]));}

/** Canonical value of a draft entry, or undefined while the entry cannot be sent. */
export function normalizedValue(field:PreferenceField,raw:unknown):PreferenceValue|undefined{
 let value:unknown=raw;
 if(field.kind==='integer'&&typeof raw==='string')value=/^(0|[1-9][0-9]{0,8})$/.test(raw.trim())?Number(raw.trim()):raw;
 else if(field.kind==='decimal'&&typeof raw==='string'){const text=raw.trim().replace(',','.');value=/^\d+\.$/.test(text)?text.slice(0,-1):text;}
 else if(field.kind==='text'&&typeof raw==='string')value=raw.replace(/^ +| +$/g,'');
 else if(field.kind==='textarea'&&typeof raw==='string')value=raw.replace(/\r\n?/g,'\n').replace(/^[ \n]+|[ \n]+$/g,'');
 else if(field.kind==='documents'&&Array.isArray(raw))value=(raw as PreferenceDocument[]).map(row=>({document:row.document.replace(/[.\-/\s]/g,'').toUpperCase(),name:row.name.replace(/^ +| +$/g,'')}));
 else if(field.kind==='keymap'&&raw&&typeof raw==='object'&&!Array.isArray(raw))value=Object.fromEntries(Object.entries(raw as Record<string,string>).map(([k,v])=>[k,String(v).toUpperCase()]));
 return preferenceValueValid(field,value)?value as PreferenceValue:undefined;
}
export type DraftState={changes:PreferenceChange[];invalid:string[];dirty:boolean};
export function draftState(page:PreferencePageSchema,view:PreferencesPageView,draft:Draft):DraftState{
 const changes:PreferenceChange[]=[],invalid:string[]=[];
 for(const field of storedFields(page)){
  const item=view.items.find(i=>i.key===field.key),raw=draft[field.key];
  if(!item || !preferenceFieldEnabled(page.id,field.key))continue;
  if(preferenceValueEqual(raw,item.value))continue;
  const value=normalizedValue(field,raw);
  if(value===undefined){invalid.push(field.key);continue;}
  if(!preferenceValueEqual(value,item.value))changes.push({key:field.key,expected_version:item.version,value});
 }
 return {changes,invalid,dirty:changes.length>0||invalid.length>0};
}
export function visible(entry:PreferenceField|PreferenceInfo,draft:Draft){
 if(entry.info||!entry.showIf)return true;
 return preferenceValueEqual(draft[entry.showIf.key],entry.showIf.equals);
}
// Apresentação do percurso comercial; os valores e o contrato legado continuam intactos.
const commercialFiscalInfo:Record<string,string>={
 'certificado.a1_servidor':'Certificado e senha são configurados diretamente no emissor de notas (um cofre à parte). O ERP guarda somente a conexão com o emissor; não recebe o certificado nem assina notas.',
 'nfe.ambiente':'A NF-e do pedido usa o ambiente escolhido no Emissor de notas. Homologação fica separada de produção; habilitar produção exige confirmação de administrador.',
 'nfe.disponibilidade':'Teste a conexão no Emissor de notas. A consulta confere versão, emitente e ambientes permitidos.',
 'nfe.numeracao':'Série e número da NF-e pertencem ao emissor de notas. O ERP permite escolher apenas as séries que o emissor informa para o ambiente; não mantém próximo número fiscal.',
 'nfce.ambiente':'A NFC-e sai pela frente de caixa, no ambiente escolhido no Emissor de notas.',
 'nfce.disponibilidade':'Teste a conexão no Emissor de notas. A NFC-e é emitida pela frente de caixa com as partes Fiscal e Frente de caixa ligadas.',
 'nfce.numeracao':'Série e número da NFC-e pertencem ao emissor de notas. O ERP não mantém próximo número fiscal.',
 'nfce.csc':'CSC e identificador de CSC são configurados diretamente no emissor de notas. Nunca informe esses segredos nesta página.',
};
const commercialFiscalNotes:Record<string,string>={
 'nfe.lancar_estoque':'Preferência legada. No pedido com NF-e, o momento do estoque é escolhido por área no Emissor de notas. Cancelamento fiscal exige avaliação da compensação e confirmação do retorno físico.',
 'nfe.lancar_contas':'Preferência legada. No pedido com NF-e, o momento dos títulos é escolhido por área no Emissor de notas. Cancelamento não apaga recebimentos nem cancela cobranças.',
 'nfe.emitir_lote':'Emissão em lote está fora deste percurso. Prepare e revise uma NF-e por pedido salvo; a emissão usa o comando confirmado no acompanhamento.',
 'nfe.consulta_automatica':'A retomada é explícita: use Consultar / retomar no acompanhamento da mesma emissão. Esta preferência não agenda chamadas ao cofre.',
 'nfe.itens_primeira_pagina':'O DANFE é fornecido pelo emissor de notas. Esta preferência antiga não altera o PDF do emissor.',
 'nfe.itens_demais_paginas':'O DANFE é fornecido pelo emissor de notas. Esta preferência antiga não altera o PDF do emissor.',
 'nfe.danfe_simplificado_produtos':'DANFE simplificado está fora deste percurso. O DANFE da NF-e comercial é obtido no cofre.',
 'nfe.danfe_simplificado_total':'DANFE simplificado está fora deste percurso. O DANFE da NF-e comercial é obtido no cofre.',
 'vendas.gerar_nfe':'Preparação e emissão não são automáticas ao salvar. No pedido de venda salvo, use Preparar NF-e para revisar dados e emitir pelo cofre.',
 'vendas.contas_automaticas_nota':'A NF-e comercial reutiliza os títulos do pedido conforme a política da área no Emissor de notas. A emissão não cria uma segunda origem financeira e não recebe parcelas automaticamente.',
};
export const sectionEntries=(page:PreferencePageSchema,section:string)=>(page.fields.filter(entry=>entry.section===section)).map(entry=>{
 // Montagens legadas de consulta conservam sua apresentação; a porta marca o percurso comercial ativo.
 if(!erpPorts()?.commercialNfe)return entry;
 if(entry.info&&commercialFiscalInfo[entry.id])return {...entry,text:commercialFiscalInfo[entry.id],source:undefined,
  ...(entry.id==='nfce.csc'?{}:{link:{label:'Abrir emissor de notas',to:'/certificado-a1',roles:['admin','fiscal'] as const}})};
 if(!entry.info&&commercialFiscalNotes[entry.key])return {...entry,note:commercialFiscalNotes[entry.key],status:'stored' as const};
 return entry;
});
export function choiceOptions(field:PreferenceField){return(field.options??[]) as readonly(readonly[string,string])[];}
export function integerOptions(field:PreferenceField){const out:string[]=[];for(let n=field.min!;n<=field.max!;n++)out.push(String(n));return out;}
export function invalidText(field:PreferenceField){
 switch(field.kind){
  case'integer':return `Informe um número inteiro entre ${field.min} e ${field.max}.`;
  case'decimal':return `Informe um número entre ${field.min} e ${field.max}, com até ${field.scale} casas decimais.`;
  case'text':return field.format==='email'?'Informe um e-mail válido.':field.format==='email_list'?`Informe até ${field.maxItems} e-mails separados por vírgula.`
   :field.format==='digits'?`Use só números, de ${field.minLength??1} a ${field.maxLength} dígitos.`:`Use até ${field.maxLength} caracteres, sem quebras de linha.`;
  case'textarea':return `Use até ${field.maxLength} caracteres.`;
  case'keymap':return 'Cada ação precisa de uma tecla diferente (letra, vírgula ou ponto).';
  case'documents':return `Informe CPF ou CNPJ válidos, sem repetir, até ${field.maxItems} pessoas.`;
  default:return 'Confira o valor informado.';
 }
}
/** status: HTTP status of an AccessError, or null for any other failure (network, contract, timeout). */
export function readError(status:number|null){
 // 264: a page may also follow a permission of Sistema › Usuários (Espaço Meu Contador, Central de Notificações).
 if(status===403)return 'Seu perfil ou as permissões do seu usuário (Sistema › Usuários) não permitem consultar estas preferências.';
 if(status===404)return 'Esta página de preferências não está disponível.';
 return 'Não foi possível carregar as preferências. Tente novamente.';
}
export type SaveFailure={definitive:boolean;message:string};
/** Only an authoritative refusal releases the command; anything else keeps it for "Conferir resultado". */
export function saveFailure(status:number|null,ownScope:boolean):SaveFailure{
 {
  if(status===409)return {definitive:true,message:'As preferências mudaram desde a consulta. Nada foi salvo. Recarregue para conferir os valores atuais; suas alterações continuam no formulário.'};
  if(status===400)return {definitive:true,message:'Nada foi salvo. Confira os valores informados.'};
  if(status===403)return {definitive:true,message:ownScope?'Nada foi salvo. Seu acesso precisa ser confirmado.':'Nada foi salvo. Somente administradores alteram estas preferências.'};
  if(status===404)return {definitive:true,message:'Nada foi salvo. Esta página de preferências não está disponível.'};
 }
 return {definitive:false,message:'Não foi possível confirmar se as preferências foram salvas. Confira o resultado do mesmo comando antes de tentar de novo.'};
}
export const saveNotice=(result:PreferencesResult)=>`${result.receipt.changes.length===1?'1 preferência salva':`${result.receipt.changes.length} preferências salvas`}${result.replayed?' (comando já registrado)':''}.`;
export const moment=(value:string)=>new Date(value).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'short'});
export const keymapOptions=(field:PreferenceField)=>field.options as PreferenceKeymapOptions;
export function formatDocument(value:string){
 const v=value.replace(/[.\-/\s]/g,'');
 if(/^\d{11}$/.test(v))return `${v.slice(0,3)}.${v.slice(3,6)}.${v.slice(6,9)}-${v.slice(9)}`;
 if(/^[A-Z0-9]{12}\d{2}$/i.test(v))return `${v.slice(0,2)}.${v.slice(2,5)}.${v.slice(5,8)}/${v.slice(8,12)}-${v.slice(12)}`;
 return value;
}
export const ROLE_NAMES:Record<PreferencesPageView['role'],string>={admin:'Administrador',consulta:'Consulta',vendas:'Vendas',financeiro:'Financeiro',estoque:'Estoque',fiscal:'Fiscal'};
export const policyText=(allow:boolean)=>allow?'Ativado — os lançamentos podem deixar o saldo negativo.':'Desativado — os lançamentos não podem deixar o saldo negativo.';
