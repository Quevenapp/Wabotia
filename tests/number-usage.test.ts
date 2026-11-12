import { env } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { exec } from "../src/db";
import { uid } from "../src/types";
import { billingPeriod, numberUsage } from "../src/number-usage";
import { observeMetaUsage } from "../src/number-quota";

const stamp = Date.parse("2026-11-12T15:00:00Z");
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  vi.spyOn(Date, "now").mockReturnValue(stamp);
  const profile = uid(),
    account = uid(),
    connection = uid();
  await exec(
    env,
    "INSERT INTO profiles(id,name,created) VALUES(?,?,?)",
    profile,
    "Usage",
    stamp,
  );
  await exec(
    env,
    "INSERT INTO meta_accounts(id,profile_id,name,waba_id,timezone,created) VALUES(?,?,?,?,?,?)",
    account,
    profile,
    "Usage",
    uid(),
    "America/Sao_Paulo",
    stamp,
  );
  await exec(
    env,
    "INSERT INTO connections(id,profile_id,name,kind,mode,created) VALUES(?,?,?,'zernio','direct',?)",
    connection,
    profile,
    "Usage",
    stamp,
  );
  await exec(
    env,
    "INSERT INTO meta_numbers(connection_id,account_id,phone_id,service_limit,baseline_period,baseline_used,monitored_at) VALUES(?,?,?,0,'2026-11',999999,?)",
    connection,
    account,
    uid(),
    Date.parse("2026-10-01T03:00:00Z"),
  );
  return { id: connection, kind: "zernio", profile };
}
async function receipt(
  conn: any,
  id: string,
  status = "delivered",
  category?: string,
  timestamp = stamp,
) {
  await observeMetaUsage(env, conn, {
    message_id: id,
    status,
    timestamp,
    ...(category ? { pricing: { category, billable: false } } : {}),
  });
}
async function queued(
  conn: any,
  external: string,
  category: string,
  payload: any = {},
  kind = "human",
) {
  const id = uid();
  await exec(
    env,
    "INSERT INTO outbox(id,profile_id,connection_id,kind,actor,payload,status,external_id,dedupe,created,updated,quota_category) VALUES(?,?,?,?,?,?,'sent',?,?,?,?,?)",
    id,
    conn.profile,
    conn.id,
    kind,
    "user:test",
    JSON.stringify(payload),
    external,
    id,
    stamp,
    stamp,
    category,
  );
}

it("counts only confirmed deliveries, once per provider message, without legacy baseline or limits", async () => {
  const conn = await fixture();
  await queued(conn, "service", "service");
  await receipt(conn, "service");
  await receipt(conn, "service", "read");
  await receipt(conn, "service", "delivered");
  await receipt(conn, "service", "failed"); // A late failure cannot erase proof of delivery.
  await queued(conn, "accepted", "service");
  await receipt(conn, "accepted", "sent");
  await receipt(conn, "failed", "failed", "service");
  await queued(conn, "ambiguous", "service");
  await exec(
    env,
    "UPDATE outbox SET status='unknown' WHERE external_id='ambiguous' AND connection_id=?",
    conn.id,
  );
  const usage = await numberUsage(env, conn.id);
  expect(usage).toEqual({
    period: "2026-11",
    timezone: "America/Sao_Paulo",
    delivered: 1,
    service_delivered: 1,
    utility_delivered: 0,
    marketing_delivered: 0,
    authentication_delivered: 0,
    unclassified_delivered: 0,
    monitored_at: Date.parse("2026-10-01T03:00:00Z"),
  });
});

it("uses the validated template category even with absent pricing or a free service pricing receipt", async () => {
  const conn = await fixture();
  await queued(
    conn,
    "utility",
    "template",
    {
      content: { type: "template", template_category: "utility" },
      template_message: { name: "order" },
    },
    "template",
  );
  await receipt(conn, "utility", "delivered", "service");
  await queued(
    conn,
    "marketing",
    "template",
    { content: { type: "template", template_category: "marketing" } },
    "template",
  );
  await receipt(conn, "marketing", "read");
  await receipt(
    conn,
    "external-auth",
    "delivered",
    "authentication_international",
  );
  await receipt(conn, "external-unknown");
  await queued(conn, "legacy-template", "template", {}, "template");
  await receipt(conn, "legacy-template", "delivered", "service");
  await queued(conn, "action", "action", {}, "action");
  await receipt(conn, "action", "delivered", "service");
  expect(await numberUsage(env, conn.id)).toMatchObject({
    delivered: 5,
    service_delivered: 0,
    utility_delivered: 1,
    marketing_delivered: 1,
    authentication_delivered: 1,
    unclassified_delivered: 2,
  });
});

it("uses the earliest delivery confirmation in the integration timezone, including late receipts", async () => {
  const conn = await fixture();
  await receipt(
    conn,
    "boundary",
    "read",
    "service",
    Date.parse("2026-11-01T03:01:00Z"),
  );
  expect((await numberUsage(env, conn.id))?.delivered).toBe(1);
  await receipt(
    conn,
    "boundary",
    "delivered",
    "service",
    Date.parse("2026-11-01T02:59:00Z"),
  );
  await receipt(
    conn,
    "older",
    "delivered",
    "marketing",
    Date.parse("2026-09-30T22:00:00Z"),
  );
  await receipt(conn, "future", "delivered", "service", stamp + 600000);
  expect((await numberUsage(env, conn.id))?.delivered).toBe(0);
  expect(
    billingPeriod(Date.parse("2026-11-01T02:59:00Z"), "America/Sao_Paulo"),
  ).toBe("2026-10");
});

it("isolates phones and does not multiply usage when old outbox rows share a provider ID", async () => {
  const a = await fixture(),
    b = await fixture();
  await queued(a, "shared", "service");
  await queued(a, "shared", "service");
  await receipt(a, "shared");
  await receipt(b, "shared", "delivered", "marketing");
  expect(await numberUsage(env, a.id)).toMatchObject({
    delivered: 1,
    service_delivered: 1,
    marketing_delivered: 0,
  });
  expect(await numberUsage(env, b.id)).toMatchObject({
    delivered: 1,
    service_delivered: 0,
    marketing_delivered: 1,
  });
  expect(await numberUsage(env, uid())).toBeNull();
});
