import test from'node:test';import assert from'node:assert/strict';
import{mountComponent,AccessError}from'./helpers/component-recovery-harness.mjs';
import{createStockOpeningFixture}from'../app/qa/stock-opening-fixture.ts';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
// Modal touches document focus; the harness has no DOM.
let previous;test.before(()=>{previous=globalThis.document;globalThis.document={activeElement:null,addEventListener(){},removeEventListener(){}};});test.after(()=>{globalThis.document=previous;});
const mount=f=>mountComponent('RealStockOpening.tsx',{controller:f.controller},{expandChildren:true});
const visible=n=>Array.isArray(n)?n.map(visible).join(''):n&&typeof n==='object'?n.props.hidden?'':visible(n.props.children):n===null||n===undefined||typeof n==='boolean'?'':String(n);
const posts=(f,suffix)=>f.calls.filter(c=>c.method==='POST'&&c.path.endsWith(suffix));
const commandReads=(f,base='/v1/saldo-abertura-estoque/comandos/')=>f.calls.filter(c=>c.path.startsWith(base));
const pageReads=f=>f.calls.filter(c=>c.method==='GET'&&/\/v1\/saldo-abertura-estoque\/\d+\?/.test(c.path));
const hasButton=(v,label)=>v.nodes().some(n=>n.type==='button'&&visible(n)===label);
const openBatch=async v=>{await v.click('Adotar próximo lote');};
const confirmBatch=async v=>{await openBatch(v);await v.change('opening-confirm',true);await v.click('Adotar lote');};

// Wabotia: a adoção do saldo vindo do Origin saiu (PLANO-FAGOO.md, item 17); a tela mantém só a política de estoque negativo.
test('100 policy switch needs the explicit confirmation text and a reason; the change is verified by GET',async()=>{const f=createStockOpeningFixture(),v=await mount(f);try{
 assert.match(v.text(),/Não permitido/);await v.change('policy-switch',true);assert.match(v.text(),/Reservas continuam exigindo saldo disponível/);
 assert.equal(v.button('Confirmar alteração da política').disabled,true);await v.change('policy-reason','Venda sem saldo durante a virada');assert.equal(v.button('Confirmar alteração da política').disabled,true);
 await v.change('policy-confirm',true);await v.click('Confirmar alteração da política');
 assert.equal(posts(f,'/v1/politica-estoque').length,1);assert.deepEqual({...posts(f,'/v1/politica-estoque')[0].body,command_id:'x'},{command_id:'x',expected_version:0,allow_negative:true,reason:'Venda sem saldo durante a virada',confirmed:true});
 assert.equal(commandReads(f,'/v1/politica-estoque/comandos/').length,1);assert.match(v.text(),/Estoque negativo permitido a partir de agora/);assert.equal(f.policy.allow_negative,true);
}finally{v.unmount();}});

test('100 lost policy answer is recovered by GET only',async()=>{const f=createStockOpeningFixture({lostAck:true}),v=await mount(f);try{
 await v.change('policy-switch',true);await v.change('policy-confirm',true);await v.change('policy-reason','Venda sem saldo durante a virada');await v.click('Confirmar alteração da política');
 assert.match(v.text(),/Não foi possível confirmar a alteração da política/);await v.click('Conferir resultado da política');
 assert.equal(posts(f,'/v1/politica-estoque').length,1);assert.match(v.text(),/Estoque negativo permitido a partir de agora/);
}finally{v.unmount();}});

