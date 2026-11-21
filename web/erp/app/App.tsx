import { lazy } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import NativeModuleBoundary from './components/NativeModuleBoundary';

const RealAccess = lazy(() => import('./components/RealAccess'));

export default function App() {
  const { pathname, search, hash } = useLocation();
  if (pathname === '/acesso') return <Navigate to={'/visao-geral' + search + hash} replace />;
  // Wabotia: a atualização da instalação é do painel (Gestão › Sistema); /atualizacao volta ao início.
  if (pathname === '/') return <Navigate to="/visao-geral" replace />;
  return ['/acesso', '/preferencias', '/cadastros-reais', '/historico-fiscal', '/documentos-empresa', '/estoque-empresa', '/financeiro-empresa', '/cobranca-empresa', '/cobranca-operacional', '/retornos-operacionais', '/notas-recebidas', '/numeracao-fiscal', '/certificado-a1', '/conexao-sefaz', '/empresa-configuracoes','/estoque-abertura','/emissor-fiscal','/relatorio-vencimentos','/painel-produtos-empresa','/conferencia-estoque-empresa','/checkin-recebimentos','/relatorios-estoque',
    '/notas-entrada','/naturezas-operacao','/inutilizacoes-nfe','/cartas-correcao',
    '/categorias-produtos','/grupos-produtos','/tags','/grupos-tags','/exportacao-produtos','/listas-precos','/campos-customizados',
    '/tipos-contatos-empresa','/vendedores-empresa','/formas-pagamento-empresa','/funcionarios-empresa','/importar-contatos','/numeracao-contatos',
    '/visao-geral','/meu-negocio','/frente-caixa-empresa','/receber-bling','/notas-bling','/notas-recebidas-compras','/expedicao','/lojas','/producao','/contador-fiscal','/reforma-tributaria'].includes(pathname) || pathname.startsWith('/preferencias/') || pathname === '/ajuda' || pathname.startsWith('/ajuda/')
    ? <NativeModuleBoundary resetKey="company-access" label="Carregando acesso…"><RealAccess /></NativeModuleBoundary>
    : <Navigate to="/acesso" replace />;
}
