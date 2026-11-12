const duration = 24 * 60 * 60 * 1000;

export function whatsappServiceWindow(lastCustomer: number, now: number) {
  const known =
    Number.isFinite(lastCustomer) && lastCustomer > 0 && lastCustomer <= now;
  const expiresAt = known ? lastCustomer + duration : null;
  const remainingMs = expiresAt ? Math.max(0, expiresAt - now) : 0;
  const seconds = Math.ceil(remainingMs / 1000);
  const countdown = [
    Math.floor(seconds / 3600),
    Math.floor((seconds % 3600) / 60),
    seconds % 60,
  ]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
  return { open: remainingMs > 0, expiresAt, remainingMs, countdown };
}
