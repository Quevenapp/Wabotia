// localStorage tolerante: preferências são opcionais e nunca derrubam a tela.
export function readStore<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
export function writeStore(key: string, value: unknown) {
  try {
    if (value === undefined || value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* preferência opcional */
  }
}
export function readText(key: string, fallback = "") {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
export function writeText(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* preferência opcional */
  }
}
