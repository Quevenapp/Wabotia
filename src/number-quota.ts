import { one, exec } from "./db";
import { Env, now, json, requireValue } from "./types";
import { billingPeriod } from "./number-usage";
export { billingPeriod, numberUsage } from "./number-usage";

export async function vinkiFreeOnly(env: Env, actor: string) {
  return (
    actor.startsWith("app:") &&
    !!(await one(
      env,
      "SELECT id FROM pairing_requests WHERE app_id=? AND client='vinki' AND status='consumed' LIMIT 1",
      actor.slice(4),
    ))
  );
}

// Compatibility name for the existing enqueue path. Monthly counts never
// admit, reserve or reject a message. free_only only prohibits templates.
export async function queueWithNumberQuota(
  env: Env,
  values: any[],
  category: string,
) {
  const freeOnly =
    json(values[7]).free_only === true || (await vinkiFreeOnly(env, values[6]));
  requireValue(
    !freeOnly || category !== "template",
    "Este pedido permite somente mensagens de atendimento dentro da janela de 24 horas, sem templates.",
  );
  if (freeOnly) {
    values = [...values];
    values[7] = JSON.stringify({ ...json(values[7]), free_only: true });
  }
  const number =
    values[3] &&
    (await one(
      env,
      "SELECT a.timezone FROM meta_numbers n JOIN meta_accounts a ON a.id=n.account_id WHERE n.connection_id=?",
      values[3],
    ));
  await exec(
    env,
    "INSERT OR IGNORE INTO outbox(id,profile_id,conversation_id,connection_id,epoch,kind,actor,payload,dedupe,created,updated,quota_month,quota_category) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ...values,
    number ? billingPeriod(now(), number.timezone) : null,
    number ? category : null,
  );
}

export async function observeMetaUsage(env: Env, conn: any, data: any) {
  if (
    !["meta", "zernio"].includes(conn.kind) ||
    !["sent", "delivered", "read", "failed"].includes(data.status)
  )
    return;
  const n = await one(
    env,
    "SELECT a.timezone FROM meta_numbers n JOIN meta_accounts a ON a.id=n.account_id WHERE connection_id=?",
    conn.id,
  );
  if (!n) return;
  const stamp = Number(data.timestamp);
  if (!Number.isFinite(stamp) || stamp <= 0 || stamp > now() + 300000) return;
  const delivered = ["delivered", "read"].includes(data.status);
  const pricingCategory =
    data.pricing?.category === "marketing_lite"
      ? "marketing"
      : data.pricing?.category === "authentication-international"
        ? "authentication_international"
        : data.pricing?.category;
  const category = [
    "service",
    "utility",
    "marketing",
    "authentication",
    "authentication_international",
  ].includes(pricingCategory)
    ? pricingCategory
    : "unknown";
  const billable =
    typeof data.pricing?.billable === "boolean"
      ? Number(data.pricing.billable)
      : null;
  await exec(
    env,
    `INSERT INTO meta_message_usage(connection_id,external_id,status,category,billable,pricing_type,delivered_at,period,updated) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(connection_id,external_id) DO UPDATE SET
    status=CASE WHEN meta_message_usage.delivered_at IS NOT NULL THEN meta_message_usage.status WHEN excluded.delivered_at IS NOT NULL OR excluded.updated>=meta_message_usage.updated THEN excluded.status ELSE meta_message_usage.status END,
    category=CASE WHEN excluded.category!='unknown' THEN excluded.category ELSE meta_message_usage.category END,
    billable=coalesce(excluded.billable,meta_message_usage.billable),pricing_type=coalesce(excluded.pricing_type,meta_message_usage.pricing_type),
    period=CASE WHEN excluded.delivered_at IS NOT NULL AND (meta_message_usage.delivered_at IS NULL OR excluded.delivered_at<meta_message_usage.delivered_at) THEN excluded.period ELSE meta_message_usage.period END,
    delivered_at=CASE WHEN meta_message_usage.delivered_at IS NULL THEN excluded.delivered_at WHEN excluded.delivered_at IS NULL THEN meta_message_usage.delivered_at ELSE min(meta_message_usage.delivered_at,excluded.delivered_at) END,
    updated=max(meta_message_usage.updated,excluded.updated)`,
    conn.id,
    data.message_id,
    data.status,
    category,
    billable,
    typeof data.pricing?.type === "string"
      ? data.pricing.type.slice(0, 100)
      : null,
    delivered ? stamp : null,
    delivered ? billingPeriod(stamp, n.timezone) : null,
    stamp,
  );
}
