import { useState } from 'react';
import { Icon } from './Icon';
import { cnpjLookupBase, lookupCnpj, searchableCnpj, type CnpjData } from '../lib/cnpj-lookup';
import './help-center.css';

/** "Buscar na Receita" ao lado de um campo de CNPJ (pedido do dono, 21/11): consulta pelo servidor as bases públicas da Receita
 * (rota erp-cnpj) e entrega os dados para o formulário preencher; nada é gravado até a pessoa salvar. Só no painel da área. */
export default function CnpjLookupButton({ cnpj, disabled, onFound, id }: { cnpj: string | null | undefined; disabled?: boolean; onFound: (data: CnpjData) => void; id: string }) {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  if (cnpjLookupBase() === null) return null;
  const lookup = async () => {
    if (busy) return;
    if (!searchableCnpj(cnpj ?? '')) { setMessage('Digite o CNPJ completo (14 números) para buscar na Receita.'); return; }
    setBusy(true); setMessage('');
    try {
      const data = await lookupCnpj(cnpj ?? '');
      onFound(data);
      const situacao = data.ativa === false && data.situacao ? ` Atenção: situação na Receita "${data.situacao}".` : '';
      setMessage(`Dados da Receita${data.razao_social ? ` de ${data.razao_social}` : ''} preenchidos. Confira antes de salvar.${situacao}`);
    }
    catch (e) { setMessage(e instanceof Error ? e.message : 'A busca na Receita falhou.'); }
    finally { setBusy(false); }
  };
  return <div className="platform-cep-lookup"><button type="button" id={id} className="secondary-button" disabled={disabled || busy} onClick={() => void lookup()} title="Buscar os dados do CNPJ na Receita" aria-label="Buscar na Receita">
    <Icon name="magnifying-glass" size={13} />{busy ? 'Buscando…' : 'Buscar na Receita'}</button>{message && <p className="platform-cep-message" role="status">{message}</p>}</div>;
}
