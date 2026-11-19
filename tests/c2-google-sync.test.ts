/** Fixtures do formato do plano; a conferir com a conta real.
 * Reconciliação e persistência reais, com somente o transporte externo simulado. */
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { json, uid } from "../src/types";
import type { ChannelReview, ExtensionConnection } from "../src/channel-c2-contracts";
import { googleReviewsDriver, googleReviewsExtension, googleReviewsMaintenance } from "../src/c2/google-reviews";
import { assertNoChannelEffects, c2Fixture, installTestExtension, quietCoordinator, type C2Fixture } from "./c2-fixtures";

// O relógio simulado precisa ficar à frente do runtime do DO: um horário fixo
// no passado faria o alarme real disparar enquanto o teste prepara o cenário.
const START = Date.now() + 3_600_000;
const profiles = new Set<string>();
type PageReply = { reviews: unknown[]; nextCursor?: string | null };
type RemoteReply = PageReply | Error | (() => PageReply);
let clock: number;
let replies: RemoteReply[];
let calls: URL[];
let unexpected: string[];

beforeEach(() => {
  clock = START;
  replies = [];
  calls = [];
  unexpected = [];
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== "https://zernio.com" || url.pathname !== "/api/v1/inbox/reviews" || (init?.method ?? "GET") !== "GET") {
      unexpected.push("Chamada externa fora da leitura de avaliações.");
      throw new Error("Rede inesperada na fixture Google.");
    }
    calls.push(url);
    const reply = replies.shift();
    if (!reply) {
      unexpected.push("Leitura de avaliações sem resposta simulada.");
      throw new Error("Rede inesperada na fixture Google.");
    }
    if (reply instanceof Error) throw reply;
    return Response.json(typeof reply === "function" ? reply() : reply);
  });
});
afterEach(async () => {
  for (const profile of profiles) await quietCoordinator(profile);
  profiles.clear();
  vi.restoreAllMocks();
  expect(unexpected).toEqual([]);
});

async function setup(channel: Parameters<typeof c2Fixture>[0] = "googlebusiness") {
  const f = await c2Fixture(channel);
  profiles.add(f.profile);
  await exec(env, "UPDATE connections SET created=? WHERE id=?", START - 10_000, f.line);
  await installTestExtension(f, googleReviewsExtension);
  return f;
}
async function connection(f: C2Fixture) {
  return (await one<ExtensionConnection>(env, "SELECT * FROM connections WHERE id=? AND profile_id=?", f.line, f.profile))!;
}
async function activate(f: C2Fixture) {
  const conn = await connection(f);
  const result = await googleReviewsDriver.configure({ env, actor: f.admin, profileId: f.profile, connection: conn,
    input: { config: { reviews_enabled: true } }, commandId: uid(), now: clock });
  expect(result.status).toBe("active");
  // O kernel persiste este resultado após chamar o driver.
  await exec(env, "UPDATE connections SET config=?,status=? WHERE id=? AND profile_id=?",
    JSON.stringify({ ...json(conn.config), ...result.configuration }), result.status, f.line, f.profile);
  await quietCoordinator(f.profile);
}
interface SyncState {
  activation_at: number;
  cursor: string | null;
  next_at: number;
  last_complete_at: number | null;
  last_error_code: string | null;
}
async function syncState(f: C2Fixture) {
  return (await one<SyncState>(env, "SELECT * FROM channel_sync_state WHERE profile_id=? AND connection_id=? AND kind='google.reviews'",
    f.profile, f.line))!;
}
const run = (f: C2Fixture) => googleReviewsMaintenance.run({ env, profileId: f.profile, now: clock });
async function nextRound(f: C2Fixture) {
  clock = Math.max(clock + 1, (await syncState(f)).next_at + 1);
  return run(f);
}
function remote(id: string, overrides: Record<string, unknown> = {}) {
  return { id, rating: 4, text: "Atendimento com atenção.", authorName: "Pessoa sintética",
    publishedAt: START + 1, updatedAt: START + 1, ...overrides };
}
async function seedKnown(f: C2Fixture, remoteId: string, publishedAt = START - 20_000) {
  const id = uid();
  await exec(env, `INSERT INTO reviews(id,profile_id,connection_id,account_id,remote_id,rating,text,
    author_name,published_at,provider_updated_at,last_event_key,created,updated)
    VALUES(?,?,?,?,?,4,'Texto conhecido','Pessoa sintética',?,?,'fixture',?,?)`,
    id, f.profile, f.line, f.account, remoteId, publishedAt, START - 1000, START - 1000, START - 1000);
  return id;
}
async function noAttendance(f: C2Fixture) {
  for (const table of ["contacts", "conversations", "messages", "inbox", "outbox", "bot_runs"])
    expect(await all(env, `SELECT id FROM ${table} WHERE profile_id=?`, f.profile), table).toEqual([]);
}

describe("Google: reconciliação limitada, sem histórico e sem conversa", { timeout: 30_000 }, () => {
  it("canal não usado não agenda importação nem chama fornecedor", async () => {
    const f = await setup("whatsapp");
    expect(await googleReviewsMaintenance.recover!({ env, profileId: f.profile, now: clock }))
      .toEqual({ nextAt: null, pending: false });
    expect(await run(f)).toEqual({ nextAt: null, pending: false });
    expect(calls).toEqual([]);
    expect(await all(env, "SELECT connection_id FROM channel_sync_state WHERE profile_id=?", f.profile)).toEqual([]);
    await assertNoChannelEffects(f.profile);
  });

  it("preserva marco de ativação, rejeita histórico e atualiza avaliações já conhecidas", async () => {
    const f = await setup();
    await activate(f);
    expect((await syncState(f)).activation_at).toBe(START);
    const known = await seedKnown(f, "conhecida");
    clock += 10_000;
    await activate(f);
    expect((await syncState(f)).activation_at).toBe(START);
    replies.push({ reviews: [
      remote("historica", { publishedAt: START - 1, updatedAt: clock }),
      remote("sem-data", { publishedAt: undefined, updatedAt: clock }),
      remote("conhecida", { publishedAt: START - 20_000, updatedAt: clock, text: "Texto atualizado" }),
      remote("nova", { updatedAt: clock }),
    ], nextCursor: null });
    await run(f);
    expect(await all(env, "SELECT remote_id FROM reviews WHERE profile_id=? ORDER BY remote_id", f.profile))
      .toEqual([{ remote_id: "conhecida" }, { remote_id: "nova" }]);
    expect(await one(env, "SELECT text,version FROM reviews WHERE id=?", known))
      .toEqual({ text: "Texto atualizado", version: 2 });
    expect(calls).toHaveLength(1);
    expect(calls[0].searchParams.get("since")).toBe(new Date(START).toISOString());
    expect((await syncState(f)).last_complete_at).not.toBeNull();
    await noAttendance(f);
  });

  it("recuperação usa a primeira ativação observada, sem histórico desde a criação da conexão", async () => {
    const f = await setup();
    await googleReviewsMaintenance.recover!({ env, profileId: f.profile, now: clock });
    expect((await syncState(f)).activation_at).toBe(START);
    expect(calls).toEqual([]);
    clock += 100;
    replies.push({ reviews: [
      remote("antes-da-conexao", { publishedAt: START - 10_001, updatedAt: START - 1 }),
      remote("apos-a-conexao", { publishedAt: START - 5000, updatedAt: START + 50 }),
      remote("apos-a-ativacao"),
    ], nextCursor: null });
    await run(f);
    expect(await all(env, "SELECT remote_id FROM reviews WHERE profile_id=?", f.profile))
      .toEqual([{ remote_id: "apos-a-ativacao" }]);
    const before = await syncState(f);
    clock += 60_000;
    await googleReviewsMaintenance.recover!({ env, profileId: f.profile, now: clock });
    expect((await syncState(f)).activation_at).toBe(before.activation_at);
    await exec(env, "UPDATE connections SET status='paused' WHERE id=?", f.line);
    clock = Math.max(clock, (await syncState(f)).next_at + 1);
    expect(await run(f)).toEqual({ nextAt: null, pending: false });
    expect(calls).toHaveLength(1);
    expect(await all(env, "SELECT remote_id FROM reviews WHERE profile_id=?", f.profile))
      .toEqual([{ remote_id: "apos-a-ativacao" }]);
    await noAttendance(f);
  });

  it("limita a rodada a três páginas e retoma do cursor persistido", async () => {
    const f = await setup();
    await activate(f);
    clock += 100;
    replies.push(
      { reviews: [remote("pagina-1")], nextCursor: "cursor-1" },
      { reviews: [remote("pagina-2")], nextCursor: "cursor-2" },
      { reviews: [remote("pagina-3")], nextCursor: "cursor-3" },
    );
    const first = await run(f);
    expect(calls).toHaveLength(3);
    expect(calls.map(call => call.searchParams.get("cursor"))).toEqual([null, "cursor-1", "cursor-2"]);
    expect(calls.every(call => call.searchParams.get("limit") === "50")).toBe(true);
    expect(first.nextAt).toBeGreaterThan(clock);
    expect((await syncState(f)).cursor).toBe("cursor-3");
    expect((await syncState(f)).last_complete_at).toBeNull();
    replies.push({ reviews: [remote("pagina-4")], nextCursor: null });
    await nextRound(f);
    expect(calls).toHaveLength(4);
    expect(calls[3].searchParams.get("cursor")).toBe("cursor-3");
    expect((await syncState(f)).cursor).toBeNull();
    expect((await syncState(f)).last_complete_at).not.toBeNull();
    expect(await all(env, "SELECT id FROM reviews WHERE profile_id=?", f.profile)).toHaveLength(4);
    await noAttendance(f);
  });

  it("ausência em página parcial ou ciclo completo não exclui; timeout conserva cursor", async () => {
    const f = await setup();
    await activate(f);
    const known = await seedKnown(f, "ausente");
    clock += 100;
    replies.push({ reviews: [remote("presente")], nextCursor: "proxima" }, new Error("timeout sintético"));
    await run(f);
    expect((await syncState(f)).cursor).toBe("proxima");
    expect((await syncState(f)).last_complete_at).toBeNull();
    expect((await syncState(f)).last_error_code).not.toBeNull();
    expect(await one(env, "SELECT state,version,text FROM reviews WHERE id=?", known))
      .toEqual({ state: "active", version: 1, text: "Texto conhecido" });
    replies.push({ reviews: [], nextCursor: null });
    await nextRound(f);
    expect(calls[2].searchParams.get("cursor")).toBe("proxima");
    expect((await syncState(f)).cursor).toBeNull();
    expect(await one(env, "SELECT state,version FROM reviews WHERE id=?", known)).toEqual({ state: "active", version: 1 });
    await noAttendance(f);
  });

  it("somente estado explícito posterior exclui ou restaura avaliação conhecida", async () => {
    const f = await setup();
    await activate(f);
    const known = await seedKnown(f, "mudanca");
    clock += 100;
    replies.push({ reviews: [remote("mudanca", { state: "deleted", updatedAt: START + 10 })], nextCursor: null });
    await run(f);
    expect(await one(env, "SELECT state,version FROM reviews WHERE id=?", known)).toEqual({ state: "deleted", version: 2 });
    replies.push({ reviews: [remote("mudanca", { state: "active", updatedAt: START + 5, text: "Evento atrasado" })], nextCursor: null });
    await nextRound(f);
    expect(await one(env, "SELECT state,version FROM reviews WHERE id=?", known)).toEqual({ state: "deleted", version: 2 });
    replies.push({ reviews: [remote("mudanca", { state: "active", updatedAt: START + 20, text: "Restaurada" })], nextCursor: null });
    await nextRound(f);
    expect(await one(env, "SELECT state,version,text FROM reviews WHERE id=?", known))
      .toEqual({ state: "active", version: 3, text: "Restaurada" });
    await noAttendance(f);
  });

  it("página inválida não persiste itens nem avança cursor", async () => {
    const f = await setup();
    await activate(f);
    clock += 100;
    replies.push({ reviews: [remote("valida"), remote("invalida", { rating: 6 })], nextCursor: "nao-confirmado" });
    await run(f);
    expect((await syncState(f)).cursor).toBeNull();
    expect((await syncState(f)).last_complete_at).toBeNull();
    expect(await all(env, "SELECT id FROM reviews WHERE profile_id=?", f.profile)).toEqual([]);
    replies.push({ reviews: Array.from({ length: 51 }, (_, index) => remote(`excesso-${index}`)), nextCursor: "excesso" });
    await nextRound(f);
    expect((await syncState(f)).cursor).toBeNull();
    expect(await all(env, "SELECT id FROM reviews WHERE profile_id=?", f.profile)).toEqual([]);
    await noAttendance(f);
  });

  it("não inicia chamada que ultrapassaria o prazo da rodada", async () => {
    const f = await setup();
    await activate(f);
    clock += 100;
    const roundStart = clock;
    replies.push(() => {
      clock = roundStart + 40_000;
      return { reviews: [remote("primeira")], nextCursor: "depois-do-prazo" };
    });
    const result = await run(f);
    expect(calls).toHaveLength(1);
    expect(result.nextAt).not.toBeNull();
    expect((await syncState(f)).cursor).toBe("depois-do-prazo");
    expect((await syncState(f)).last_complete_at).toBeNull();
    expect(await all(env, "SELECT id FROM reviews WHERE profile_id=?", f.profile)).toHaveLength(1);
  });

  it("reconciliação repetida e concorrente não duplica avaliação, versão ou aviso", async () => {
    const f = await setup();
    await activate(f);
    clock += 100;
    const page = { reviews: [remote("repetida")], nextCursor: null };
    replies.push(page, page);
    await Promise.all([run(f), run(f)]);
    expect(await all(env, "SELECT remote_id,version FROM reviews WHERE profile_id=?", f.profile))
      .toEqual([{ remote_id: "repetida", version: 1 }]);
    const first: ChannelReview = (await one<ChannelReview>(env, "SELECT * FROM reviews WHERE profile_id=?", f.profile))!;
    replies.length = 0;
    replies.push(page);
    await nextRound(f);
    expect(await one(env, "SELECT id,version FROM reviews WHERE profile_id=?", f.profile)).toEqual({ id: first.id, version: 1 });
    expect(await all(env, "SELECT id FROM events WHERE profile_id=? AND kind='google.review.new'", f.profile)).toHaveLength(1);
    await noAttendance(f);
  });
});
