import type { DocumentMirrorMeta } from '../../../../packages/erp-domain/src/document-mirror.mjs';
/** Commercial mirrors keep the observed values separate from the native calculation. Since the two-way sync (202610220009) a
 * document of Origin origin is converted to the native model (authority brufap): only a document still under the Origin authority
 * is read-only; the origin only says where it was created. */
// Vinki: Origin fora (motor 91213b8): o motor responde sempre origin/authority 'brufap'; a tela e o espelho Origin dos documentos
// saíram. Ficam só o tipo, o texto da trava (ramo dormente) e o formatador decimal, ainda usados fora daqui.
export interface DocumentOrigin {
  origin?: 'brufap' | 'origin'; authority?: 'brufap' | 'origin'; readonly?: boolean; mirror?: DocumentMirrorMeta | null;
}
// Vinki: dormente. A trava genérica por bloco de integração externa (Bling, componente externo) vai reaproveitar este ramo: o motor responderá 409 com outro código quando o bloco pertencer à integração (decisão de 16/11).
export const DOCUMENT_MIRROR_READ_ONLY = 'Documento importado ainda em conversão para o ERP: aguarde a próxima sincronização para editar.';
// Vinki: sempre falso desde Origin fora (motor 91213b8); fica enquanto telas de fora dos documentos ainda o chamam.
export const isDocumentMirror = (document: DocumentOrigin): document is DocumentOrigin & { origin: 'origin'; mirror: DocumentMirrorMeta } => document.authority === 'origin';
/** Decimal strings are formatted without converting them to Number or rounding them. */
export function mirrorDecimal(value: string | null | undefined, money = false): string {
  if (value === null || value === undefined || !/^-?\d+(?:\.\d+)?$/.test(value)) return 'Não informado';
  const [whole, fraction] = value.split('.');
  return `${money ? 'R$ ' : ''}${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}${fraction ? ',' + fraction : money ? ',00' : ''}`;
}
