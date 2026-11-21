import { originIntegrationEnabled, originHistoryAvailable, isOriginIntegrationRoute } from '../lib/integration-capabilities';
import { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { ErpHostView } from '../../host-runtime';
import { targetEnabled } from '../../blocks';
import { portedPermissionAllowed } from '../../../management/ported-policy';
import { erpDestinationPlacement } from '../../../management/menu-groups.ts';
import { Link, useLocation } from 'react-router-dom';
import type { AccessState } from '../lib/real-access';
import { ROLE_LABELS } from '../lib/real-access';
import { activeGroupFor, matchesLocation, resolveMenu, resolvePreferences } from '../lib/origin-menu';
import { workspaceMenu } from '../lib/fagoo-menu';
import { useTheme } from '../hooks/useTheme';
import OriginTopBar from './OriginTopBar';
import { NotificationsPanel, useCompanyChrome, useStoredThemeAtLogin } from './CompanyChrome';
import { storageSummary, type SystemController } from '../lib/system-model';
import './company-navigation.css';

// Leva H (PRF-287, PRF-255): the help of the Brufap itself, inside the app; no external help domain.
const COMPANY_HELP_LINKS = [{ label: 'Central de ajuda do ERP', to: '/ajuda', icon: 'circle-question' },
  { label: 'Novidades no ERP', to: '/ajuda/novidades', icon: 'star' }];

// Company area navigation: the Origin top bar (same menu as the demo) plus the location trail.
// Brufap-only tools live in Preferências (gear), like Origin's own settings. With a controller that offers the Sistema port,
// the bar shows the user's name, the razão social, Armazenamento and the live notifications (migration 151).
export default function CompanyNavigation({ host, state, onLogout, controller, embedded = false, chromeTarget = null }: { host?: ErpHostView | null; embedded?: boolean; chromeTarget?: HTMLElement | null; state: AccessState; onLogout: () => void; controller?: Partial<SystemController> & { preferences?: (path: string, options?: { method?: 'GET'; signal?: AbortSignal }) => Promise<unknown> } }) {
  const location = useLocation();
  embedded = host?.embedded ?? embedded;
  chromeTarget = host?.chromeTarget ?? chromeTarget;
  const tools = useRef<HTMLDivElement>(null);
  useEffect(() => host?.bindLinks?.(tools.current), [host?.bindLinks, chromeTarget, embedded]);
  const { theme, toggle } = useTheme();
  const ready = state.phase === 'ready';
  const role = state.membership?.role;
  const resources = ready ? state.membership!.resources : [];
  const authenticated = ['checking', 'pending', 'ready', 'error'].includes(state.phase);
  const originIntegration = ready && originIntegrationEnabled(state.membership);
  const originHistory = ready && originHistoryAvailable(state.membership);
  const access = ready && role ? { role, resources, capabilities: state.membership?.capabilities } : {};
  const allows = (to: string) => ready && (host ? host.runtime.allowed(to, state) : targetEnabled(to) && portedPermissionAllowed(to, role, resources));
  const groups = useMemo(() => resolveMenu('real', access).map(group => ({ ...group, columns: group.columns.map(column => ({ ...column, items: column.items.filter(item => item.to && allows(item.to)) })).filter(column => column.items.length), footer: group.footer?.to && allows(group.footer.to) ? group.footer : undefined })).filter(group => group.columns.length), [state, host, ready, role, resources.join(','), originIntegration, originHistory]);
  const preferences = useMemo(() => resolvePreferences(access), [ready, role, originIntegration, originHistory]);
  const preferenceLinks = preferences.flatMap(category => category.entries.filter(entry => allows(entry.to)).map(entry => ({ label: entry.label, to: entry.to })));
  const preparationPage = originHistory && ready && role === 'admin' && ['/preparacao-virada/depositos', '/preparacao-virada/depositos/estoque'].includes(location.pathname);
  const stockPage = preparationPage && location.pathname.endsWith('/estoque');
  const active = activeGroupFor(groups, location.pathname, location.search);
  const current = active?.columns.flatMap(column => column.items).find(item => item.to && matchesLocation(item.to, location.pathname, location.search));
  const preference = preferences.flatMap(category => category.entries.map(entry => ({ category, entry }))).find(({ entry }) => matchesLocation(entry.to, location.pathname, location.search) || entry.to.startsWith('/preferencias/') && location.pathname.startsWith(`${entry.to}/`));
  const hubCategory = preferences.find(category => `/preferencias/${category.id}` === location.pathname);
  const chrome = useCompanyChrome(controller, state);
  useStoredThemeAtLogin(controller as Parameters<typeof useStoredThemeAtLogin>[0], state);
  const person = chrome.profile?.name ?? chrome.profile?.email ?? null;
  const user = { name: ready && role ? person ?? ROLE_LABELS[role] : authenticated ? 'Verificando acesso' : 'Visitante', company: chrome.profile?.company?.legal_name ?? 'ERP', detail: ready ? person && role ? `Perfil: ${ROLE_LABELS[role]}` : 'Área da empresa' : undefined };
  const system = ready && typeof controller?.system === 'function' ? controller as SystemController : null;
  // Wabotia: o botão de sincronizar com o Origin saiu; a capacidade originIntegration nunca vem (Origin fora, motor 91213b8).
  // The trail names the same module the sidebar shows (Comercial, Catálogo…), so both read alike.
  const moduleName = useMemo(() => current?.to ? (embedded ? erpDestinationPlacement(current.to)?.group : undefined) ?? workspaceMenu(groups, role).find(group => group.columns.some(column => column.items.some(item => item.to === current.to)))?.name ?? active?.name : active?.name, [groups, role, current?.to, active?.name, embedded]);
  const trail = ready ? location.pathname === '/acesso' ? <nav aria-label="Localização"><span aria-current="page">Visão geral</span></nav> : <nav aria-label="Localização"><Link to="/acesso">Início</Link>
      {preparationPage ?<><span aria-hidden="true">›</span><Link to="/preferencias">Preferências</Link><span aria-hidden="true">›</span><Link to="/preparacao-virada">Preparação da virada</Link><span aria-hidden="true">›</span>{stockPage ? <><Link to="/preparacao-virada/depositos">Depósitos importados</Link><span aria-hidden="true">›</span><span aria-current="page">Estoque informado na importação</span></> : <span aria-current="page">Depósitos importados</span>}</>
        : active ? <><span aria-hidden="true">›</span><span>{moduleName}</span>{current && current.label !== 'Dashboard geral' && <><span aria-hidden="true">›</span><span aria-current="page">{current.label}</span></>}</>
        : location.pathname === '/preferencias' ? <><span aria-hidden="true">›</span><span aria-current="page">Preferências</span></>
        : hubCategory ? <><span aria-hidden="true">›</span><Link to="/preferencias">Preferências</Link><span aria-hidden="true">›</span><span aria-current="page">{hubCategory.label}</span></>
        : preference ? <><span aria-hidden="true">›</span><Link to="/preferencias">Preferências</Link><span aria-hidden="true">›</span>{preference.entry.to.startsWith('/preferencias/') ? <Link to={`/preferencias/${preference.category.id}`}>{preference.category.label}</Link> : <span>{preference.category.label}</span>}<span aria-hidden="true">›</span><span aria-current="page">{preference.entry.label}</span></> : null}
    </nav> : undefined;
  const bar = <>
    <OriginTopBar embedded={embedded} allows={allows} groups={ready ? groups : []} activeGroup={active?.name} homeTo="/acesso" preferencesTo="/preferencias" user={user} theme={theme} onTheme={toggle} role={ready ? role : undefined} trail={trail}
      userTitle="Meu Perfil" companyTo={allows('/empresa-configuracoes') ? '/empresa-configuracoes' : undefined} storage={allows('/empresa-configuracoes?secao=armazenamento') && chrome.storage ? { label: `Armazenamento ${storageSummary(chrome.storage).label}`, to: '/empresa-configuracoes?secao=armazenamento' } : null}
      notificationCount={ready ? chrome.unread : null} notificationsPanel={system && chrome.actor ? close => <NotificationsPanel controller={system} actor={chrome.actor!} onUnread={chrome.setUnread} onNavigate={close} /> : undefined}
      onLogout={authenticated ? onLogout : undefined} actionsTo={allows('/preferencias/sistema/gestao-acoes') ? '/preferencias/sistema/gestao-acoes' : undefined} helpLinks={ready ? COMPANY_HELP_LINKS.filter(link => allows(link.to) && (originHistory || !isOriginIntegrationRoute(link.to))) : []} userLinks={allows('/empresa-configuracoes') ? [{ label: 'Dados da empresa', to: '/empresa-configuracoes', icon: 'building' }] : []} searchLinks={preferenceLinks} />
  </>;
  const ErpToolsScope = host?.ToolsScope;
  if (embedded) return chromeTarget && ErpToolsScope ? createPortal(<ErpToolsScope scopeRef={tools}>{bar}</ErpToolsScope>, chromeTarget) : null;
  return bar;
}
