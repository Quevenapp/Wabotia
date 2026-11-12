import { one } from "./db";
import { type Env, now } from "./types";

export function billingPeriod(timestamp: number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(timestamp);
  return `${parts.find((p) => p.type === "year")!.value}-${parts.find((p) => p.type === "month")!.value}`;
}

/** Delivered messages are observations, never a local allowance or admission cap. */
export async function numberUsage(env: Env, connection: string) {
  const number = await one(
    env,
    "SELECT n.monitored_at,a.timezone FROM meta_numbers n JOIN meta_accounts a ON a.id=n.account_id WHERE n.connection_id=?",
    connection,
  );
  if (!number) return null;
  const period = billingPeriod(now(), number.timezone);
  // One row per provider message. A read receipt also confirms delivery. Prefer
  // the validated template category to pricing: a free UTILITY template is
  // still a template, not a free-form service reply. Missing evidence stays
  // unclassified; queued, accepted, failed and ambiguous sends are not usage.
  const counts = await one(
    env,
    `WITH classified AS (
      SELECT CASE
        WHEN o.quota_category='template' OR o.kind='template' OR json_extract(o.payload,'$.template_message') IS NOT NULL THEN
          CASE WHEN lower(coalesce(json_extract(o.payload,'$.content.template_category'),json_extract(o.payload,'$.template_category'))) IN ('utility','marketing','authentication','authentication_international')
            THEN lower(coalesce(json_extract(o.payload,'$.content.template_category'),json_extract(o.payload,'$.template_category')))
            WHEN u.category IN ('utility','marketing','authentication','authentication_international') THEN u.category
            ELSE 'unknown' END
        WHEN o.quota_category='service' THEN 'service'
        ELSE u.category END category
      FROM meta_message_usage u
      LEFT JOIN outbox o ON o.id=(SELECT candidate.id FROM outbox candidate
        WHERE candidate.connection_id=u.connection_id AND candidate.external_id=u.external_id
        ORDER BY candidate.created,candidate.id LIMIT 1)
      WHERE u.connection_id=? AND u.period=? AND u.delivered_at>=?
        AND coalesce(o.kind,'') NOT IN ('team','action') AND coalesce(o.quota_category,'')!='action'
    ) SELECT count(*) delivered,
      coalesce(sum(category='service'),0) service_delivered,
      coalesce(sum(category='utility'),0) utility_delivered,
      coalesce(sum(category='marketing'),0) marketing_delivered,
      coalesce(sum(category IN ('authentication','authentication_international')),0) authentication_delivered,
      coalesce(sum(category NOT IN ('service','utility','marketing','authentication','authentication_international')),0) unclassified_delivered
    FROM classified`,
    connection,
    period,
    number.monitored_at,
  );
  return {
    period,
    timezone: number.timezone,
    delivered: Number(counts.delivered),
    service_delivered: Number(counts.service_delivered),
    utility_delivered: Number(counts.utility_delivered),
    marketing_delivered: Number(counts.marketing_delivered),
    authentication_delivered: Number(counts.authentication_delivered),
    unclassified_delivered: Number(counts.unclassified_delivered),
    monitored_at: number.monitored_at,
  };
}
