import ErpEffectMaintenance from './ErpEffectMaintenance';
import { originHistoryAvailable, isOriginIntegrationRoute } from '../lib/integration-capabilities';
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { erpPorts } from '../../ports';
import type { ErpHostView } from '../../host-runtime';
import { portedPermissionState } from '../../../management/ported-policy';
import { blockOf, currentErpModules, ERP_BLOCK_LABELS, hiddenInWabotia, targetEnabled } from '../../blocks';
import { partOffMessage } from '../../modules';
import { MOTOR_READY, pendingInMotor } from '../../motor';
import { createAccessController, decimalMoney, RESOURCE_LABELS, ROLE_LABELS, type AccessController, type AccessState, type Entity, type ListQuery, type Summary } from '../lib/real-access';
import './real-access.css';
import { ProductTaxonomy, ProductExport, PriceLists, CustomFields } from './native-modules';
import { ReceiveBling, CompanyPreferences, Catalog, RealDocuments, RealStock, RealFinance, FinanceBorderos, FinanceScreens, RealCnab, RealCnabOperational, RealCnabOperationalReturns, RealReceivedDfe, RealFiscalNumbering, CertificateA1, SefazConnection, CompanySettings, RealStockOpening, RealHome, RealFiscalDrafts, DueDateReport, StockWarehouses, StockCount, StockDashboards, ReceiptCheckin, StockReports, ReportCharts } from './native-modules';
import { contactModuleRoute } from '../lib/contact-routes';
import { financeScreen, type FinanceScreen } from '../lib/finance-screens';
import { RealFiscalInvoices, RealOperationNatures, FiscalEventList, RealPdv, BlingInvoices } from './native-modules';
import NativeModuleBoundary from './NativeModuleBoundary';
import HelpCenter from './HelpCenter';
import { isHelpPath } from '../lib/help-content';
import CompanyNavigation from './CompanyNavigation';
import { isPreferencesPath, preferencesResetKey } from '../lib/preferences-route';
import type { CatalogEntity } from '../lib/catalog-model';
import type { DocumentKind } from '../lib/real-documents-model';
import { useUnsavedChangesGuard } from '../hooks/useUnsavedChanges';

// Wabotia: o segundo fator é confirmado na sessão do Wabotia (Confirme que é você); o cadastro fica em Minha conta.
import { IdentityChallenge } from '../../IdentityChallenge';
import EmissorSettings from '../../EmissorSettings';
import NotasRecebidas from '../../NotasRecebidas';
import Contador from '../../Contador';
import Sped from '../../Sped';
import ReformaTributaria from '../../ReformaTributaria';
import OrdensProducao from '../../OrdensProducao';
import Expedicao from '../../Expedicao';
import Lojas, { StoreSwitcher } from '../../Lojas';
import Conciliacao from '../../Conciliacao';

/** Wabotia: login, "esqueci minha senha" e a ativação por convite são do núcleo (web/site/Login.tsx). Aqui só se avisa que a
 * sessão terminou; a casca volta para a entrada do painel. */
function Login({ state }: { controller: AccessController; state: AccessState }) {
  return <section className="real-login-panel" aria-labelledby="login-title">
    <h1 id="login-title">Sessão encerrada</h1>
    <p role={state.message ? 'alert' : undefined}>{state.message || 'Sua sessão no painel terminou.'} Entre novamente no Wabotia para continuar.</p>
    <a className="primary-button" href="/app">Entrar no Wabotia</a>
  </section>;
}

/** Cofre: certificado, assinatura, transmissão e numeração não são feitos no ERP. */
const FISCAL_GATEWAY_PATHS = ['/certificado-a1', '/conexao-sefaz', '/emissor-fiscal', '/numeracao-fiscal', '/preferencias/certificado/configuracoes', '/preferencias/notas-fiscais/nfe/numeracao', '/preferencias/notas-fiscais/nfce/numeracao'];
/** Wabotia: rota de um bloco do ERP desligado nesta área (Fiscal, Cobrança, PDV, Origin; web/erp/blocks.ts). */
function BlockOff({ target }: { target: string }) {
  // Wabotia: tela sem motor ainda (web/erp/motor.ts): em implantação, com os atalhos do que já funciona.
  if (pendingInMotor(target)) return <section className="real-state-panel" aria-labelledby="erp-pending-title"><h1 id="erp-pending-title">Em implantação</h1><p>Esta parte do ERP ainda está sendo instalada no Wabotia e aparece aqui assim que ficar pronta. Nada foi perdido: os dados continuam no mesmo lugar.</p><p>Já funcionam:</p><ul>{MOTOR_READY.filter(item => targetEnabled(item.to)).map(item => <li key={item.to}><Link to={item.to}>{item.label}</Link></li>)}</ul></section>;
  if (hiddenInWabotia(target)) return <section className="real-state-panel"><h1>Página indisponível</h1><p>Esta página não faz parte do ERP no Wabotia. As atualizações e as conexões ficam no painel, em Gestão.</p><Link to="/acesso">Voltar ao início</Link></section>;
  const ports = erpPorts(), label = ERP_BLOCK_LABELS[blockOf(target) ?? "erp"];
  // Wabotia: diz qual módulo falta e de quem ele depende (nomes de src/erp/parts.ts).
  const detail = partOffMessage(target, currentErpModules());
  return <section className="real-state-panel"><h1>Recurso desligado</h1><p>{detail ? `${detail}${ports?.admin ? '' : ' Peça ao administrador.'}` : `${label} está desligado nesta área de atendimento. ${ports?.admin ? 'Ligue-o em Gestão › Módulos para usar esta tela.' : 'Peça ao administrador para ligá-lo em Gestão › Módulos.'}`}</p>
    {ports?.admin && ports.openModules && <button type="button" className="primary-button" onClick={ports.openModules}>Abrir Módulos</button>} <Link to="/acesso">Voltar ao início</Link></section>;
}

function FiscalGatewayCut() {
  return <section className="real-state-panel"><h1>Emissão e numeração no cofre</h1><p>A NF-e integral de um pedido de venda é preparada e acompanhada no ERP. O cofre NFapi guarda o certificado, numera, assina, transmite e fornece DANFE e XML.</p><p>Cadastre certificado e senha diretamente no cofre. Numeração local, emissão avulsa, parcial, agrupada, NFC-e e notas de OS estão fechadas nesta etapa.</p><p><Link to="/historico-fiscal?modelo=55">Preparação e acompanhamento de NF-e</Link></p><p><Link to="/certificado-a1">Configurar emissor, ambiente e políticas</Link></p><Link to="/acesso">Voltar ao início</Link></section>;
}

/** Preserve a same-actor pending command through a temporary role reduction.
 * The actor key and the outer session gate still unmount on logout or replacement.
 */
function FiscalDraftAccess({controller,state,initialModel}:{controller:AccessController;state:AccessState;initialModel?:'55'|'65'}) {
  const allowed=state.phase==='ready'&&['admin','fiscal'].includes(state.membership?.role??'');
  const [opened,setOpened]=useState(allowed);
  useEffect(()=>{if(allowed)setOpened(true);},[allowed]);
  return <>
    {!allowed&&<section className="real-state-panel"><h1>Preparação fiscal não liberada</h1><p>Seu perfil atual não permite acessar os rascunhos fiscais. Uma confirmação pendente permanece preservada para consulta quando seu acesso for restabelecido.</p></section>}
    {opened&&<div hidden={!allowed} inert={!allowed} aria-hidden={!allowed}><RealFiscalDrafts key={initialModel} controller={controller} initialModel={initialModel}/></div>}
  </>;
}

/** Produtos (202610200119-120): telas de taxonomia por endereço; cada uma lê as próprias permissões de produtos. */
const PRODUCT_TAXONOMY_PATHS: Record<string, 'categories' | 'product_groups' | 'tags' | 'tag_groups'> = { '/categorias-produtos': 'categories', '/grupos-produtos': 'product_groups', '/tags': 'tags', '/grupos-tags': 'tag_groups' };

/** Notas fiscais no padrão Origin: saída, NFC-e, entrada, naturezas e consultas de eventos (202610200111-114). */
const FISCAL_INVOICE_PATHS = ['/historico-fiscal', '/notas-entrada', '/naturezas-operacao', '/inutilizacoes-nfe', '/cartas-correcao'];
const fiscalInvoiceRoute = (pathname: string) => FISCAL_INVOICE_PATHS.includes(pathname);
function FiscalInvoiceRoutes({ controller, pathname, model, role }: { controller: AccessController; pathname: string; model: '' | '55' | '65'; role: string }) {
  const reader = ['admin', 'consulta', 'fiscal'].includes(role), writer = ['admin', 'fiscal'].includes(role);
  if (pathname === '/inutilizacoes-nfe' || pathname === '/cartas-correcao') return writer ? <FiscalEventList key={pathname} controller={controller} kind={pathname === '/cartas-correcao' ? 'correction' : 'inutilization'} />
    : <section className="real-state-panel"><h1>Consulta não liberada</h1><p>Somente administrador e fiscal consultam os eventos fiscais do ERP.</p></section>;
  if (!reader) return <section className="real-state-panel"><h1>Notas fiscais não liberadas</h1><p>Seu perfil não possui acesso às notas fiscais.</p></section>;
  if (pathname === '/naturezas-operacao') return <RealOperationNatures controller={controller} />;
  const screen = pathname === '/notas-entrada' ? 'entrada' : model === '65' ? 'nfce' : 'nfe';
  // /historico-fiscal keeps the menu and home-shortcut address of "Notas fiscais de saída" and NFC-e; the backup archive is a tab there.
  return <RealFiscalInvoices key={screen} controller={controller} screen={screen} backup={undefined /* Wabotia: o arquivo histórico (backups e XMLs do Origin, /v1/history e /v1/backup-import) saiu com o Origin (item 17). */} />;
}

const AccessDenied = () => <section className="real-state-panel" role="status"><h1>Você não tem acesso a esta página</h1></section>;

/** Uma verificação temporária não substitui o editor autorizado por outra árvore. */
export function HostedContent({host,state,target,children}:{host?:ErpHostView|null;state:AccessState;target:string;children:ReactNode}) {
  const guard = useUnsavedChangesGuard();
  const retained = useRef<{target:string;children:ReactNode;guarded:boolean}|null>(null);
  const fine = portedPermissionState(target, state.permissions);
  const allowed = !host || !host.suspended && host.runtime.allowed(target, state);
  const waiting = !!host && (host.suspended || fine === 'loading' || fine === 'unavailable');
  if (allowed && !host?.suspended) retained.current = {target,children,guarded:guard.store.shouldBlock()};
  const held = !allowed && waiting && retained.current?.target === target;
  if (held && guard.store.shouldBlock()) retained.current!.guarded = true;
  if (!allowed && !waiting) retained.current = null;
  const heldGuard = held && retained.current?.guarded;
  useEffect(() => {
    if (!heldGuard) return;
    return host?.holdGuard?.(() => retained.current?.target === target && !!retained.current.guarded);
  }, [heldGuard, host?.holdGuard, target]);
  if (!host) return children;
  const Activity = host.Activity ?? 'div';
  return <>
    {!allowed && (waiting ? <section className="real-state-panel" role="status"><h1>{fine === 'unavailable' ? 'Não foi possível verificar o acesso' : 'Verificando acesso…'}</h1>
      <p>{state.permissions?.message || 'Aguarde a confirmação das suas permissões.'}</p><button type="button" onClick={() => host.runtime.controller.retry()}>Tentar novamente</button></section> : <AccessDenied />)}
    <Activity mode={allowed ? 'visible' : 'hidden'}>{allowed ? children : held ? retained.current!.children : null}</Activity>
  </>;
}

function ConnectedArea({ host }: { host?: ErpHostView | null }) {
  const location = useLocation();
  const navigate = useNavigate();
  const guard = useUnsavedChangesGuard();
  // Wabotia: sessão, MFA e API vêm das portas da casca (web/erp/ports.ts); sem gateway A1 nem Storage do Supabase.
  const ports = host?.runtime.ports ?? erpPorts()!;
  const [controller] = useState(() => host?.runtime.controller ?? ports.controller ?? createAccessController(ports.auth, ports.apiUrl, ports.fetch, {}));
  useEffect(() => {
    if (!host && !ports.controller) return controller.start();
  }, [controller, ports.controller, host]);
  const embedded = host?.embedded ?? ports.embedded;
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const params = new URLSearchParams(location.search);
  const selected = <T extends string>(name: string, values: readonly T[], fallback: T): T => values.includes(params.get(name) as T) ? params.get(name) as T : fallback;
  const catalogEntity = selected<CatalogEntity>('cadastro', ['contacts', 'products', 'warehouses'], 'contacts');
  const documentKind = selected<DocumentKind>('tipo', ['sales_proposals', 'sales_orders', 'purchase_orders', 'service_orders'], 'sales_proposals');
  const financeTab = selected('area', ['receivable', 'payable', 'accounts', 'categories'] as const, 'receivable');
  const fiscalModel = selected('modelo', ['', '55', '65'] as const, '');
  const navigationActor=state.membership?.user_id;
  const originHistory=originHistoryAvailable(state.membership);
  const prepareWarehouses=originHistory?()=>guard.confirmLeave(()=>{const current=controller.getSnapshot();if(current.phase==='ready'&&current.membership?.role==='admin'&&originHistoryAvailable(current.membership))navigate('/preparacao-virada/depositos');}):undefined;
  const draftModel = selected('modelo', ['', '55', '65'] as const, '') || undefined;
  // Vendas › Frente de caixa: tela cheia, sem o menu do topo (o hambúrguer da própria tela abre o menu plano).
  const pdv = location.pathname === '/frente-caixa-empresa' && state.phase === 'ready' && targetEnabled(location.pathname);
  const Main = host?.body ? 'div' : 'main';
  const hosted = (children: ReactNode) => host ? <HostedContent host={host} state={state}
    target={host.body ? '/cadastros-reais?cadastro=contacts' : location.pathname+location.search}>{children}</HostedContent> : children;
  return <div className="real-shell" style={embedded ? { minHeight: 0 } : undefined}>{!host?.body && <a className="skip-link" href="#real-main">Ir para o conteúdo</a>}{!host?.body && (!pdv || embedded) && <CompanyNavigation host={host} embedded={embedded} chromeTarget={host?.chromeTarget} state={state} controller={controller} onLogout={() => guard.confirmLeave(() => void controller.logout())} />}
    <Main id={host?.body ? undefined : "real-main"} className={pdv ? 'real-main real-main-pdv' : 'real-main'}>
      {state.phase==='ready'&&!host?.body&&<StoreSwitcher key={`${state.membership!.user_id}:${state.membership!.role}`}/>}
      {state.phase==='ready'&&state.permissionMessage&&<p className="real-notice" role="status">{state.permissionMessage} <button type="button" className="text-button" onClick={()=>controller.retry()}>Verificar permissões</button></p>}
      {state.phase==='ready'&&state.permissions?.message&&portedPermissionState(location.pathname+location.search,state.permissions)==='allowed'&&<p className="real-notice" role="status">{state.permissions.message} <button type="button" className="text-button" onClick={()=>controller.retry()}>Verificar permissões</button></p>}
      {state.phase === 'loading' || state.phase === 'checking' ? <div className="real-state-panel" role="status"><h1>{state.phase === 'loading' ? 'Recuperando sessão…' : 'Verificando permissões…'}</h1><p>Aguarde a confirmação do acesso.</p></div> : state.phase === 'signed_out' ? <Login controller={controller} state={state} /> : state.phase === 'mfa' ? <section className="real-state-panel" aria-labelledby="mfa-title"><h1 id="mfa-title">Confirme que é você</h1><IdentityChallenge onConfirmed={() => controller.retry()} intro="O ERP desta área exige o segundo fator para o seu papel. Digite o código do aplicativo autenticador para continuar." /><p className="real-help">Ainda não cadastrou o aplicativo? Cadastre em Minha conta, no menu com o seu nome no painel. Perdeu o celular? Use um código de recuperação ou peça ao administrador para redefinir o seu segundo fator em Gestão › Pessoas e acessos.</p><button type="button" className="text-button" onClick={() => void controller.logout()}>Sair</button></section> : state.phase === 'pending' ? state.message ? <section className="real-state-panel" aria-labelledby="pending-title"><h1 id="pending-title">Acesso fora do horário permitido</h1><p role="alert">{state.message}</p><button className="primary-button" onClick={() => controller.retry()}>Verificar liberação</button></section> : <section className="real-state-panel" aria-labelledby="pending-title"><h1 id="pending-title">Acesso aguardando liberação</h1><p>Você entrou no Wabotia, mas ainda não tem um papel no ERP desta área. O administrador dá o papel em Gestão › Pessoas e acessos.</p><button className="primary-button" onClick={() => controller.retry()}>Verificar liberação</button></section> : state.phase === 'error' ? <section className="real-state-panel"><h1>Consulta indisponível</h1><p role="alert">{state.message}</p><button className="primary-button" onClick={() => controller.retry()}>Tentar novamente</button></section> : <NativeModuleBoundary resetKey={preferencesResetKey(location.pathname)}>{hosted(host?.body ? host.runtime.allowed('/cadastros-reais?cadastro=contacts', state) ? host.body(controller, state) : <AccessDenied /> : !targetEnabled(location.pathname+location.search)?<BlockOff target={location.pathname+location.search}/>:location.pathname==='/receber-bling'?<ReceiveBling key={`${state.membership!.user_id}:${state.membership!.role}`} controller={controller} administrator={state.membership!.role === 'admin'}/>:location.pathname==='/notas-bling'?<BlingInvoices key={`${state.membership!.user_id}:${state.membership!.role}`} controller={controller} administrator={state.membership!.role === 'admin'}/>:location.pathname==='/manutencao-efeitos'?<ErpEffectMaintenance controller={controller}/>:location.pathname==='/certificado-a1'?<EmissorSettings/>:location.pathname==='/expedicao'?<Expedicao/>:location.pathname==='/lojas'?<Lojas key={`${state.membership!.user_id}:${state.membership!.role}`}/>:location.pathname==='/conciliacao-bancaria'?<Conciliacao screen="bank"/>:location.pathname==='/conciliacao-cartoes'?<Conciliacao screen="card"/>:location.pathname==='/producao'?['admin','consulta','vendas','estoque','fiscal'].includes(state.membership!.role)?<OrdensProducao/>:<section className="real-state-panel"><h1>Ordens de produção não liberadas</h1><p>Seu papel no ERP não consulta o estoque. A produção é de quem tem o papel Estoque ou Administrador (ou Consulta, Vendas e Fiscal, só para ver). Peça ao administrador em Gestão › Pessoas e acessos.</p></section>:location.pathname==='/contador-fiscal'?<Contador key={`${state.membership!.user_id}:${state.membership!.role}`} role={state.membership!.role}/>:location.pathname==='/sped-fiscal'?<Sped key={`${state.membership!.user_id}:${state.membership!.role}`} role={state.membership!.role}/>:location.pathname==='/reforma-tributaria'?['admin','consulta','fiscal'].includes(state.membership!.role)?<ReformaTributaria key={state.membership!.user_id}/>:<section className="real-state-panel"><h1>Reforma tributária não liberada</h1><p>Seu papel no ERP não alcança a parte fiscal. A reforma tributária é de quem tem o papel Fiscal ou Administrador (ou Consulta, só para ver). Peça ao administrador em Gestão › Pessoas e acessos.</p></section>:location.pathname==='/notas-recebidas-compras'?['admin','consulta','estoque','financeiro','fiscal'].includes(state.membership!.role)?<NotasRecebidas/>:<section className="real-state-panel"><h1>Notas recebidas não liberadas</h1><p>Seu papel no ERP não alcança as notas recebidas. Peça ao administrador um papel de estoque, financeiro, fiscal ou consulta.</p></section>:FISCAL_GATEWAY_PATHS.includes(location.pathname)?<FiscalGatewayCut/>:!originHistory&&isOriginIntegrationRoute(location.pathname)?<section className="real-state-panel"><h1>Recurso indisponível</h1><p>Esta integração não está habilitada nesta instalação.</p><Link to="/acesso">Voltar ao início</Link></section>:pdv ? ['admin','vendas','consulta','financeiro'].includes(state.membership!.role) ? <RealPdv key={state.membership!.user_id} controller={controller} /> : <section className="real-state-panel"><h1>Frente de caixa não liberada</h1><p>Seu perfil não possui acesso à frente de caixa.</p></section> : isPreferencesPath(location.pathname) ? <CompanyPreferences key={state.membership!.user_id} controller={controller} state={state} /> : location.pathname === '/numeracao-fiscal' ? ['admin','fiscal'].includes(state.membership!.role) ? <RealFiscalNumbering controller={controller} canManage={state.membership!.role === 'admin'} /> : <section className="real-state-panel"><h1>Numeração fiscal não liberada</h1><p>Seu perfil não possui acesso à numeração fiscal.</p></section> : location.pathname === '/notas-recebidas' ? ['admin','fiscal','consulta'].includes(state.membership!.role) ? <RealReceivedDfe controller={controller} canConfigure={state.membership!.role === 'admin'} /> : <section className="real-state-panel"><h1>NF-e recebidas não liberadas</h1><p>Seu perfil não possui acesso aos documentos fiscais recebidos.</p></section> : location.pathname === '/conexao-sefaz' ? ['admin','fiscal'].includes(state.membership!.role) ? <SefazConnection controller={controller} /> : <section className="real-state-panel"><h1>Conexão fiscal não liberada</h1><p>Seu perfil não possui acesso à verificação fiscal.</p></section> : location.pathname === '/certificado-a1' ? ['admin','fiscal'].includes(state.membership!.role) ? <CertificateA1 controller={controller} canManage={state.membership!.role === 'admin'} /> : <section className="real-state-panel"><h1>Certificado não liberado</h1><p>Seu perfil não possui acesso à configuração fiscal.</p></section> : location.pathname === '/retornos-operacionais' ? ['admin','financeiro','consulta'].includes(state.membership!.role) ? <RealCnabOperationalReturns controller={controller} onBack={() => navigate('/cobranca-operacional')} /> : <section className="real-state-panel"><h1>Retornos não liberados</h1><p>Seu perfil não possui acesso aos retornos bancários.</p></section> : location.pathname === '/cobranca-operacional' ? <RealCnabOperational controller={controller} onBack={() => navigate('/cobranca-empresa')} /> : location.pathname === '/relatorio-vencimentos' ? ['admin','financeiro','consulta'].includes(state.membership!.role) ? <DueDateReport controller={controller} onOpenTitles={({from,to,kind}) => navigate(`/financeiro-empresa?${new URLSearchParams({area:kind,from,to})}`)} /> : <section className="real-state-panel"><h1>Relatório não liberado</h1><p>Seu perfil não possui acesso aos vencimentos financeiros.</p></section> : location.pathname === '/emissor-fiscal' ? <FiscalDraftAccess key={state.membership!.user_id} controller={controller} state={state} initialModel={draftModel} /> : location.pathname === '/relatorios-graficos' ? <ReportCharts key={`${state.membership!.user_id}:${state.membership!.role}`} /> : ['/acesso', '/visao-geral'].includes(location.pathname) ? <RealHome controller={controller} />
 : isHelpPath(location.pathname) ? <HelpCenter originIntegration={originHistory} /> : location.pathname === '/estoque-abertura' ? <RealStockOpening key={state.membership!.user_id} controller={controller} /> : location.pathname === '/empresa-configuracoes' ? <CompanySettings controller={controller} /> : location.pathname === '/cobranca-empresa' ? ['admin','financeiro','consulta'].includes(state.membership!.role) ? <RealCnab controller={controller} /> : <section className="real-state-panel"><h1>Cobrança não liberada</h1><p>Seu perfil não possui acesso à cobrança bancária.</p></section> : location.pathname === '/documentos-empresa' ? <RealDocuments key={documentKind} controller={controller} initialKind={documentKind} /> : location.pathname === '/cadastros-reais' && catalogEntity === 'warehouses' ? ['admin','consulta','estoque'].includes(state.membership!.role) ? <StockWarehouses key={state.membership!.user_id} controller={controller} onPrepareWarehouses={prepareWarehouses} /> : <section className="real-state-panel"><h1>Depósitos não liberados</h1><p>Seu perfil não possui acesso aos depósitos.</p></section> : location.pathname === '/conferencia-estoque-empresa' ? <StockCount key={state.membership!.user_id} controller={controller} /> : location.pathname === '/relatorios-estoque' ? <StockReports key={state.membership!.user_id} controller={controller} /> : location.pathname === '/checkin-recebimentos' ? ['admin','estoque','fiscal'].includes(state.membership!.role) ? <ReceiptCheckin key={state.membership!.user_id} controller={controller} /> : <section className="real-state-panel"><h1>Check-in não liberado</h1><p>Seu perfil não possui acesso ao check-in de recebimentos.</p></section> : location.pathname === '/painel-produtos-empresa' ? ['admin','consulta','vendas','fiscal','estoque'].includes(state.membership!.role) ? <StockDashboards key={state.membership!.user_id} controller={controller} /> : <section className="real-state-panel"><h1>Dashboards de produtos não liberados</h1><p>Seu perfil não possui acesso aos dashboards de estoque.</p></section> : location.pathname === '/estoque-empresa' ? ['admin','consulta','vendas','fiscal','estoque'].includes(state.membership!.role) ? <RealStock controller={controller} onPrepareWarehouses={prepareWarehouses} /> : <section className="real-state-panel"><h1>Estoque não liberado</h1><p>Seu perfil não possui acesso ao controle de estoque.</p></section> : location.pathname === '/financeiro-empresa' ? ['admin','financeiro','consulta'].includes(state.membership!.role) ? params.get('area') === 'borderos' ? <FinanceBorderos key={`borderos:${state.membership!.user_id}`} controller={controller} /> : financeScreen(params.get('area')) ? <FinanceScreens key={`${params.get('area')}:${state.membership!.user_id}`} controller={controller} area={params.get('area') as FinanceScreen} /> : <RealFinance key={financeTab} controller={controller} initialTab={financeTab} /> : <section className="real-state-panel"><h1>Financeiro não liberado</h1><p>Seu perfil não possui acesso ao financeiro.</p></section> : Object.hasOwn(PRODUCT_TAXONOMY_PATHS, location.pathname) ? <ProductTaxonomy key={`${state.membership!.user_id}:${state.membership!.role}:${location.pathname}`} controller={controller} kind={PRODUCT_TAXONOMY_PATHS[location.pathname]} /> : location.pathname === '/exportacao-produtos' ? <ProductExport key={`${state.membership!.user_id}:${state.membership!.role}`} controller={controller} /> : location.pathname === '/listas-precos' ? <PriceLists key={`${state.membership!.user_id}:${state.membership!.role}`} controller={controller} /> : location.pathname === '/campos-customizados' ? <CustomFields key={`${state.membership!.user_id}:${state.membership!.role}`} controller={controller} /> : location.pathname === '/cadastros-reais' ? <Catalog key={catalogEntity} controller={controller} initialEntity={catalogEntity} onPrepareWarehouses={prepareWarehouses} /> : contactModuleRoute(location.pathname) ? <Catalog key={`${location.pathname}:${state.membership!.user_id}`} controller={controller} module={location.pathname} role={state.membership!.role} /> : fiscalInvoiceRoute(location.pathname) ? <FiscalInvoiceRoutes key={state.membership!.user_id} controller={controller} pathname={location.pathname} model={fiscalModel} role={state.membership!.role} /> : <section className="real-state-panel"><h1>Página indisponível</h1><p>Esta página não existe nesta instalação.</p><Link to="/acesso">Voltar ao início</Link></section>)}</NativeModuleBoundary>}
    </Main></div>;
}

export default function RealAccess({ host }: { host?: ErpHostView | null } = {}) {
  if (!host && !erpPorts()) return <main id="main-content" className="real-main"><section className="real-state-panel"><h1>Acesso da empresa em preparação</h1><p>A configuração de autenticação e consulta ainda não foi disponibilizada neste ambiente.</p><p>Solicite ao administrador a conclusão da instalação.</p></section></main>;
  const Host = !host && erpPorts()?.accessHost;
  return Host ? <Host>{view => <ConnectedArea host={view} />}</Host> : <ConnectedArea host={host} />;
}
