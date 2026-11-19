export interface FullCustomerHostInput {
  profileId: string;
  contactId: string;
  erpContactId: string;
  onSaved(): void;
  onClose(): void;
}

export interface FullCustomerHost {
  mount(
    element: HTMLElement, input: FullCustomerHostInput,
  ): Promise<{ dispose(): void }>;
}

let loader: (() => Promise<FullCustomerHost>) | null = null;
let loaded: Promise<FullCustomerHost> | null = null;

export function installFullCustomerHost(next: (() => Promise<FullCustomerHost>) | null): void {
  if (loader && next && loader !== next)
    throw new Error("Hospedeiro da ficha completa já registrado.");
  if (loader !== next) loaded = null;
  loader = next;
}

export async function loadFullCustomerHost(): Promise<FullCustomerHost> {
  if (!loader)
    throw Object.assign(new Error("Ficha completa indisponível."), {
      code: "dependency_unavailable", status: 503,
    });
  if (!loaded) {
    const current = loaded = Promise.resolve().then(loader);
    current.catch(() => { if (loaded === current) loaded = null; });
  }
  return loaded;
}
