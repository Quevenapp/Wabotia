import {useEffect,useRef,useState} from 'react';
import {isSaveShortcut,stepIndexForKey,type DocumentStep} from '../lib/document-steps';

const modalOpen=()=>Boolean(globalThis.document?.querySelector?.('dialog[open], [aria-modal="true"]'));
const reducedMotion=()=>Boolean(globalThis.window?.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
// Wabotia: dentro do painel quem rola é a área do ERP, não a janela. Devolve o ancestral que rola de fato (null = a janela).
const scrollerOf=(element:Element|null):HTMLElement|null=>{
 const win=globalThis.window;if(!win?.getComputedStyle)return null;
 for(let node=element?.parentElement??null;node;node=node.parentElement){
  const overflow=win.getComputedStyle(node).overflowY;
  if((overflow==='auto'||overflow==='scroll'||overflow==='overlay')&&node.scrollHeight>node.clientHeight+4)return node;
 }
 return null;
};

/**
 * Step navigation of the document editor: the sticky header measures itself (so anchors land below it), the current
 * section follows the scroll, Alt+1…9 jumps to a section and focuses its first field, and Ctrl+S submits the form.
 * Saving still goes through the form's own submit, with all of its checks.
 */
export function useDocumentSteps(steps:readonly DocumentStep[],{canSave,focusFirst}:{canSave:boolean;focusFirst:boolean}){
 const headerRef=useRef<HTMLElement>(null);
 const [active,setActive]=useState(steps[0]?.id??'');
 const [present,setPresent]=useState<string[]|null>(null);
 const visible=present?steps.filter(step=>present.includes(step.id)):steps;
 const live=useRef({steps,visible,canSave});live.current={steps,visible,canSave};
 // A section switched off in Preferências leaves an empty anchor: it is not offered as a step.
 useEffect(()=>{
  const doc=globalThis.document;if(!doc?.getElementById)return;
  const ids=live.current.steps.filter(step=>{const element=doc.getElementById(step.id);return Boolean(element&&(step.id==='document-operations'||element.childElementCount>0));}).map(step=>step.id);
  setPresent(previous=>previous&&previous.join('|')===ids.join('|')?previous:ids);
 });
 const jump=(id:string)=>{
  const element=globalThis.document?.getElementById(id);if(!element)return;
  const field=element.querySelector<HTMLElement>('input:not([type="hidden"]):not(:disabled),select:not(:disabled),textarea:not(:disabled),[contenteditable="true"]');
  field?.focus({preventScroll:true});
  element.scrollIntoView({behavior:reducedMotion()?'auto':'smooth',block:'start'});
  setActive(id);
  // Focusing a section can load its options and move the content above it: realign once the page settles.
  setTimeout(()=>{
   const win=globalThis.window;if(!element.isConnected||!win)return;
   const delta=element.getBoundingClientRect().top-(parseFloat(win.getComputedStyle(element).scrollMarginTop)||0);
   if(Math.abs(delta)>8)(scrollerOf(element)??win).scrollBy({top:delta,behavior:'auto'});
  },reducedMotion()?60:520);
 };
 useEffect(()=>{
  const header=headerRef.current,win=globalThis.window,doc=globalThis.document;
  if(!header||!win?.addEventListener||!doc?.getElementById)return;
  const section=header.parentElement;let frame=0;
  const measure=()=>section?.style.setProperty('--document-header-height',`${Math.ceil(header.getBoundingClientRect().height)}px`);
  const spy=()=>{
   // Wabotia: o cabeçalho pode não estar fixo (rola com a tela): a referência é ele ou o topo da área que rola, o que estiver mais abaixo.
   const scroller=scrollerOf(header);
   frame=0;const limit=Math.max(header.getBoundingClientRect().bottom,scroller?.getBoundingClientRect().top??0)+40,list=live.current.visible;let current=list[0]?.id??'';
   for(const step of list){const element=doc.getElementById(step.id);if(element&&element.getBoundingClientRect().top<=limit)current=step.id;}
   // Fim da rolagem marca o último passo, mas só quando há rolagem e ela andou: tela que cabe inteira fica no primeiro.
   const atEnd=scroller?scroller.scrollTop>0&&scroller.scrollTop+scroller.clientHeight>=scroller.scrollHeight-4
    :win.scrollY>0&&win.innerHeight+win.scrollY>=doc.documentElement.scrollHeight-4;
   if(atEnd){const last=[...list].reverse().find(step=>doc.getElementById(step.id));if(last)current=last.id;}
   setActive(previous=>previous===current?previous:current);
  };
  const schedule=()=>{if(!frame)frame=win.requestAnimationFrame(spy);};
  measure();schedule();
  const observer=typeof ResizeObserver==='function'?new ResizeObserver(()=>{measure();schedule();}):null;observer?.observe(header);
  // Na captura, o documento vê a rolagem da janela e a de qualquer área interna.
  doc.addEventListener('scroll',schedule,{passive:true,capture:true});win.addEventListener('resize',schedule);
  return()=>{observer?.disconnect();doc.removeEventListener('scroll',schedule,{capture:true});win.removeEventListener('resize',schedule);if(frame)win.cancelAnimationFrame(frame);};
 },[]);
 useEffect(()=>{
  const win=globalThis.window;if(!win?.addEventListener)return;
  const onKey=(event:KeyboardEvent)=>{
   if(event.defaultPrevented||modalOpen())return;
   if(isSaveShortcut(event)){event.preventDefault();if(live.current.canSave)(globalThis.document?.getElementById('document-editor-form') as HTMLFormElement|null)?.requestSubmit();return;}
   const index=stepIndexForKey(event);if(index===null)return;
   const step=live.current.visible[index];if(step){event.preventDefault();jump(step.id);}
  };
  win.addEventListener('keydown',onKey);return()=>win.removeEventListener('keydown',onKey);
 },[]);
 // A new document starts on the first field of the sequence (the customer), after the heading took the focus.
 useEffect(()=>{
  if(!focusFirst)return;
  const timer=setTimeout(()=>{const field=globalThis.document?.querySelector?.<HTMLElement>('#document-identification .document-contact-field input[type="search"]:not(:disabled)');field?.focus({preventScroll:true});},0);
  return()=>clearTimeout(timer);
 },[focusFirst]);
 return {headerRef,active,steps:visible,jump};
}

export function DocumentStepNav({steps,active,onJump,itemCount,total}:{steps:readonly DocumentStep[];active:string;onJump:(id:string)=>void;itemCount:number;total:string}){
 return <aside className="fagoo-document-outline" aria-label="Resumo do documento">
  <nav aria-label="Seções do documento"><ol>{steps.map((step,index)=><li key={step.id}><button type="button" aria-current={active===step.id?'step':undefined} title={`Alt + ${index+1}`} onClick={()=>onJump(step.id)}>
   <span className="fagoo-step-number" aria-hidden="true">{index+1}</span>{step.label}{step.id==='document-line-items'&&itemCount>0&&<span className="fagoo-step-count">{itemCount}</span>}</button></li>)}</ol></nav>
  <p className="fagoo-document-summary"><span>{itemCount} {itemCount===1?'item':'itens'}</span><strong className="fagoo-document-amount" aria-live="polite">{total}</strong></p>
 </aside>;
}
