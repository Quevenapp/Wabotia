import { ERP_MANAGEMENT_ITEMS, ERP_MENU_GROUPS } from '../../../../src/modules/erp/panel-menu.ts';
import type {ResolvedGroup} from './origin-menu';

export type WorkspaceModule={name:string;icon:string;columns:{title:string;items:{label:string;to:string}[]}[]};
const MODULES=Object.values(ERP_MENU_GROUPS).map(group=>[group.groupLabel,group.icon] as const);
const destinationGroups=new Map(ERP_MANAGEMENT_ITEMS.map(item=>[item.target.to,item.groupLabel]));
/** The modules each profile uses all day come first; the others keep the standard order. */
const ROLE_FOCUS:Record<string,readonly string[]>={
 vendas:['Comercial','Catálogo','Pessoas','Resultados'],
 financeiro:['Financeiro','Comercial'],
 estoque:['Estoque','Compras','Catálogo'],
 fiscal:['Fiscal','Comercial','Compras'],
};
/** The module a profile works in when no other is selected. */
export function focusModule(role?:string){return role?ROLE_FOCUS[role]?.[0]:undefined;}
/** Recompose only already-authorized destinations. This layer grants no new access. */
export function workspaceMenu(groups:readonly ResolvedGroup[],role?:string):WorkspaceModule[]{
 const buckets=new Map<string,{label:string;to:string}[]>(MODULES.map(([name])=>[name,[]]));
 for(const group of groups){
  const entries=[...group.columns.flatMap(column=>column.items),...(group.footer?[group.footer]:[])];
  for(const entry of entries){
   if(!entry.to)continue;
   const target=destinationGroups.get(entry.to);
   if(!target)continue;
   const items=buckets.get(target)!;
   if(!items.some(item=>item.to===entry.to))items.push({label:entry.label,to:entry.to});
  }
 }
 const focus=role?ROLE_FOCUS[role]??[]:[];
 const ordered=[...MODULES].sort((a,b)=>{const x=focus.indexOf(a[0]),y=focus.indexOf(b[0]);return (x<0?focus.length:x)-(y<0?focus.length:y);});
 return ordered.flatMap(([name,icon])=>buckets.get(name)!.length?[{name,icon,columns:[{title:'',items:buckets.get(name)!}]}]:[]);
}
