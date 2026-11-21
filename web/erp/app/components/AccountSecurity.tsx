import { useEffect, useRef, useState } from 'react';
import { AccessError, type AccessController } from '../lib/real-access';
import { parseSecurityPolicy, parseSecurityPolicyAnswer } from '../../../../packages/erp-domain/src/access-security.mjs';
import { erpPorts } from '../../ports';
import { IdentityChallenge } from '../../IdentityChallenge';

const ROLE_LABELS: Record<string, string> = { admin: 'Administrador', consulta: 'Consulta', vendas: 'Vendas', financeiro: 'Financeiro', estoque: 'Estoque', fiscal: 'Fiscal' };

type Policy = ReturnType<typeof parseSecurityPolicy>;
const policyError = (error: unknown) => error instanceof AccessError ? (error.code === 'ERP_MFA_REQUIRED' ? 'Confirme que é você (abaixo) antes de mudar a exigência.'
  : error.status === 409 ? 'A política mudou desde a consulta. Recarregue e tente novamente.' : error.status === 403 ? 'Somente administradores alteram a exigência do segundo fator.'
  : error.status === 503 ? 'A exigência foi registrada, mas a confirmação nas pessoas ficou pendente. Clique em salvar de novo para concluir.' : 'Não foi possível concluir. Tente novamente.') : 'Não foi possível concluir. Tente novamente.';

/**
 * Minha conta › Segurança. Vinki (decisão de 16/11): a senha e o aplicativo autenticador de cada pessoa ficam em "Minha conta" do
 * Vinki; aqui fica a exigência do segundo fator no ERP (/v1/seguranca/politica), que só o administrador muda, numa sessão
 * confirmada com o código ("Confirme que é você", web/erp/IdentityChallenge.tsx).
 */
export default function AccountSecurity({ controller }: { controller: Pick<AccessController, 'security' | 'getSnapshot'> }) {
  const admin = controller.getSnapshot().membership?.role === 'admin';
  const ports = erpPorts();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [policy, setPolicy] = useState<Policy | null>(null), [policyReload, setPolicyReload] = useState(0), [policyMessage, setPolicyMessage] = useState('');
  const [policyBusy, setPolicyBusy] = useState(false); const command = useRef<{ id: string; expected: number; on: boolean } | null>(null);
  useEffect(() => {
    if (!admin) return; const request = new AbortController();
    void controller.security('/v1/seguranca/politica', { signal: request.signal }).then(raw => { if (!request.signal.aborted) setPolicy(parseSecurityPolicy(raw)); })
      .catch(failure => { if (!request.signal.aborted && !(failure instanceof DOMException)) setPolicyMessage(policyError(failure)); });
    return () => request.abort();
  }, [admin, controller, policyReload]);
  const togglePolicy = async () => {
    if (!policy || policyBusy) return;
    const attempt = command.current ?? { id: crypto.randomUUID(), expected: policy.policy.version, on: !policy.policy.mfa_required };
    command.current = attempt; setPolicyBusy(true); setPolicyMessage('');
    const body = { command_id: attempt.id, expected_version: attempt.expected, mfa_required: attempt.on };
    try {
      parseSecurityPolicyAnswer(await controller.security('/v1/seguranca/politica', { method: 'POST', body }), body);
      command.current = null; if (mounted.current) { setPolicyMessage(attempt.on ? 'Exigência ligada. Quem está na lista confirma o código no próximo acesso ao ERP.' : 'Exigência desligada.'); setPolicyReload(value => value + 1); }
    } catch (failure) {
      // Only an unconfirmed answer keeps the same command for the next click; a refusal starts over.
      if (!(failure instanceof AccessError && failure.status === 503)) command.current = null;
      if (mounted.current) setPolicyMessage(policyError(failure));
    } finally { if (mounted.current) setPolicyBusy(false); }
  };
  return <div className="account-security">
    <header className="real-heading"><div><h1>Segurança da conta</h1><p>Senha, aplicativo autenticador e a exigência do segundo fator no ERP.</p></div></header>
    <section className="real-editor company-settings-section" aria-labelledby="account-core-title">
      <h2 id="account-core-title">Senha e aplicativo autenticador</h2>
      <p>A senha e o aplicativo autenticador são da sua conta no Vinki e valem para o painel inteiro. Troque a senha e cadastre ou remova o aplicativo em <strong>Minha conta</strong>, no menu com o seu nome no painel.</p>
      {ports?.openAccount && <div className="real-editor-actions"><button type="button" className="secondary-button" onClick={ports.openAccount}>Abrir Minha conta</button></div>}
    </section>
    {admin && <section className="real-editor company-settings-section" aria-labelledby="mfa-policy-title">
      <h2 id="mfa-policy-title">Exigir segundo fator no ERP</h2>
      <p className="real-help">Com a exigência ligada, administradores, o papel Financeiro e quem pode baixar, cancelar ou transferir valores, gerar remessas, ler retornos ou emitir boletos só usam o ERP numa sessão confirmada com o código do aplicativo. Para ligar ou desligar, confirme antes que é você.</p>
      {policyMessage && <p className="real-notice" role="status">{policyMessage}</p>}
      {!policy ? <p role="status">Consultando…</p> : <>
        <p>Situação: <strong>{policy.policy.mfa_required ? 'exigido' : 'não exigido'}</strong>{policy.policy.updated_at ? ` · alterado em ${new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(policy.policy.updated_at))}` : ''}.</p>
        <table className="data-table"><caption className="real-help">Pessoas que precisam do segundo fator</caption><thead><tr><th scope="col">Pessoa</th><th scope="col">Papel no ERP</th><th scope="col">Aplicativo cadastrado</th></tr></thead>
          <tbody>{policy.policy.members.map(member => <tr key={member.user_id}><td>{member.name}</td><td>{ROLE_LABELS[member.role] ?? member.role}</td><td>{member.factor ? 'Sim' : 'Ainda não'}</td></tr>)}</tbody></table>
        {!policy.policy.mfa_required && policy.policy.members.some(member => !member.factor) && <p className="real-help">Quem ainda não cadastrou o aplicativo precisa cadastrá-lo em Minha conta antes do próximo acesso ao ERP.</p>}
        {policy.self.aal2 ? <div className="real-editor-actions"><button type="button" className="primary-button" disabled={policyBusy} onClick={() => void togglePolicy()}>
          {policyBusy ? 'Salvando…' : policy.policy.mfa_required ? 'Desligar exigência' : 'Ligar exigência'}</button></div>
          : policy.self.factor ? <IdentityChallenge intro="Confirme que é você com o código do aplicativo autenticador para mudar a exigência." onConfirmed={() => { setPolicyMessage(''); setPolicyReload(value => value + 1); }} />
          : <p className="real-help">Para mudar a exigência, cadastre antes o seu aplicativo autenticador em Minha conta.</p>}
      </>}
    </section>}
  </div>;
}
