import { useState } from 'react';
import { Icon } from './Icon';
import { CEP_MESSAGES, cepDigits, cepPath, parseCep, type CepAddress, type PlatformPort } from '../lib/platform-model';
import { cepLookupBase, lookupCepAddress } from '../lib/cnpj-lookup';
import './help-center.css';

const statusOf = (e: unknown) => typeof (e as { status?: unknown })?.status === 'number' ? (e as { status: number }).status : 0;

/** Leva H (NFE-103): "Buscar CEP" (the lupa of the Origin), a convenience over the public lookup. It only fills the
 * empty fields the caller chooses to fill; when the lookup fails or the CEP does not exist, the address is typed by hand.
 * No painel da área a consulta vai pela rota erp-cep do Vinki (ViaCEP e BrasilAPI pelo servidor); fora dele, pela
 * porta da plataforma do ERP, como antes. */
export default function CepLookupButton({ controller, cep, disabled, onFound, id }: { controller?: Partial<PlatformPort>; cep: string | null | undefined; disabled?: boolean; onFound: (address: CepAddress) => void; id: string }) {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const host = cepLookupBase() !== null;
  if (!host && typeof controller?.platform !== 'function') return null;
  const digits = cepDigits(cep);
  const lookup = async () => {
    if (busy || digits.length !== 8) { setMessage('Informe os 8 dígitos do CEP.'); return; }
    setBusy(true); setMessage('');
    try {
      const address: CepAddress = host ? await lookupCepAddress(digits) : parseCep(await controller!.platform!(cepPath(digits), { method: 'GET' }), digits);
      onFound(address); setMessage(`Endereço de ${address.city}/${address.state} preenchido pelo CEP. Confira antes de salvar.`);
    }
    catch (e) { setMessage(host && e instanceof Error ? e.message : CEP_MESSAGES[statusOf(e)] ?? CEP_MESSAGES[503]!); }
    finally { setBusy(false); }
  };
  return <div className="platform-cep-lookup"><button type="button" id={id} className="secondary-button" disabled={disabled || busy} onClick={() => void lookup()} title="Buscar endereço pelo CEP" aria-label="Buscar CEP">
    <Icon name="magnifying-glass" size={13} />{busy ? 'Buscando…' : 'Buscar CEP'}</button>{message && <p className="platform-cep-message" role="status">{message}</p>}</div>;
}
