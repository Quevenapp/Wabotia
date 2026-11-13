// Notificações do navegador, contador no título da aba e som curto
// (web/DESIGN.md §10). Tudo opcional e só com a aba em segundo plano.
import { readStore, writeStore } from "./storage";

export type NotifyPrefs = { enabled: boolean; sound: boolean };
const KEY = "wabotia:notify";

export const notifyPrefs = (): NotifyPrefs => ({
  enabled: false,
  sound: false,
  ...readStore<Partial<NotifyPrefs>>(KEY, {}),
});
export const saveNotifyPrefs = (prefs: NotifyPrefs) => writeStore(KEY, prefs);

export const notificationsSupported = () => "Notification" in window;
export const notificationPermission = () =>
  notificationsSupported() ? Notification.permission : "denied";

/** Pede a permissão do navegador; devolve true quando concedida. */
export async function requestNotifications() {
  if (!notificationsSupported()) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  return (await Notification.requestPermission()) === "granted";
}

let audio: AudioContext | null = null;
/** Dois tons curtos gerados no navegador (sem arquivo de áudio). */
export function playChime() {
  try {
    audio ||= new AudioContext();
    const context = audio;
    const start = context.currentTime;
    [660, 880].forEach((frequency, index) => {
      const oscillator = context.createOscillator(),
        gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      const at = start + index * 0.14;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.12, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(at);
      oscillator.stop(at + 0.24);
    });
  } catch {
    /* som opcional */
  }
}

/**
 * Notifica somente com a aba em segundo plano e com a opção ligada.
 * `tag` evita repetir o mesmo aviso; `open` roda ao clicar.
 */
export function notify(
  title: string,
  body: string,
  options: { tag?: string; open?: () => void } = {},
) {
  const prefs = notifyPrefs();
  if (!document.hidden) return;
  if (prefs.sound) playChime();
  if (!prefs.enabled || notificationPermission() !== "granted") return;
  try {
    const notification = new Notification(title, {
      body,
      tag: options.tag,
      icon: "/favicon.ico",
    });
    notification.onclick = () => {
      window.focus();
      options.open?.();
      notification.close();
    };
  } catch {
    /* alguns navegadores só aceitam notificações por service worker */
  }
}

const baseTitle = "Wabotia — Atendimento conectado";
/** Título da aba com o total de não lidas. */
export function setTitleCount(count: number) {
  document.title = count > 0 ? `(${count > 99 ? "99+" : count}) Wabotia` : baseTitle;
}
