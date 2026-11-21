import { Navigate, useNavigate } from 'react-router-dom';
import type { AccessController } from '../lib/real-access';
import type { FinanceScreen } from '../lib/finance-screens';
import FinanceAccountsRegistry from './FinanceAccountsRegistry';
import FinanceCategoryTree from './FinanceCategoryTree';
import FinanceStatement from './FinanceStatement';
import FinanceContactLedger from './FinanceContactLedger';
import FinanceRecurring from './FinanceRecurring';
import FinanceImport from './FinanceImport';
import FinanceCommissions from './FinanceCommissions';
import FinanceCommissionReport from './FinanceCommissionReport';
import FinanceCashControl from './FinanceCashControl';
import FinanceGroupedBilling from './FinanceGroupedBilling';
import FinanceReports from './FinanceReports';
import FinanceRemittances from './FinanceRemittances';
import FinanceReturns from './FinanceReturns';
import FinanceDre from './FinanceDre';
import FinanceTeamPayments from './FinanceTeamPayments';
import FinanceTransfers from './FinanceTransfers';

/** Financeiro › Transferências entre contas: o mesmo formulário que só abria por dentro de Caixas e bancos. */
function Transfers({ controller }: { controller: AccessController }) {
  const navigate = useNavigate();
  return <FinanceTransfers controller={controller} onBack={() => navigate('/financeiro-empresa?area=accounts')} />;
}

/** Financeiro screens of the Origin parity (Contas Financeiras, Categorias, Caixas e bancos, Ficha financeira, …), one per ?area=. */
export default function FinanceScreens({ controller, area }: { controller: AccessController; area: FinanceScreen }) {
  if (area === 'contas-financeiras') return <FinanceAccountsRegistry controller={controller} />;
  if (area === 'accounts') return <FinanceStatement controller={controller} />;
  if (area === 'ficha') return <FinanceContactLedger controller={controller} />;
  // Vinki: uma só tela de conciliação por OFX, a de Financeiro › Conciliação bancária (src/erp/conciliacao).
  if (area === 'conciliacao') return <Navigate to="/conciliacao-bancaria" replace />;
  if (area === 'transferencias') return <Transfers controller={controller} />;
  if (area === 'recorrentes') return <FinanceRecurring controller={controller} />;
  if (area === 'importacao') return <FinanceImport controller={controller} />;
  if (area === 'comissoes') return <FinanceCommissions controller={controller} />;
  if (area === 'comissoes-relatorio') return <FinanceCommissionReport controller={controller} />;
  if (area === 'controle-caixa') return <FinanceCashControl controller={controller} />;
  if (area === 'faturamento-agrupado') return <FinanceGroupedBilling controller={controller} />;
  if (area === 'relatorios') return <FinanceReports controller={controller} />;
  if (area === 'remessas') return <FinanceRemittances controller={controller} />;
  if (area === 'retornos') return <FinanceReturns controller={controller} />;
  if (area === 'dre') return <FinanceDre />;
  if (area === 'equipe') return <FinanceTeamPayments />;
  return <FinanceCategoryTree controller={controller} />;
}
