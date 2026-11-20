// Porta OAuth separada: não usa HTTP, nem compartilha o servidor GET.
// Material privado é gerado em memória; não há credencial literal no teste.
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { FakeClock } from "./fake-bling.mjs";

const opaque = () => randomBytes(32).toString("base64url");
export class FakeOAuth {
  #clock;
  #calls = [];
  #outcomes = [];
  #validRefresh = new Set();
  #clientId = opaque();
  #clientSecret = opaque();
  constructor({ clock = new FakeClock(), accountId = "90071992547409931", scopes = [] } = {}) {
    this.#clock = clock;
    this.accountId = accountId;
    this.scopes = [...scopes];
  }
  get calls() { return structuredClone(this.#calls); }
  get callCount() { return this.#calls.length; }
  queue(outcome) { this.#outcomes.push(outcome); return this; }
  #issue() {
    const refresh_token = opaque();
    this.#validRefresh.add(refresh_token);
    return {
      client_id: this.#clientId, client_secret: this.#clientSecret,
      access_token: opaque(), refresh_token, expires_at: this.#clock.now() + 3_600_000,
      scopes: [...this.scopes], token_type: "Bearer", expires_in: 3600, scope: this.scopes.join(" "),
    };
  }
  async #execute(operation) {
    this.#calls.push({ operation, at: this.#clock.now() });
    const outcome = this.#outcomes.shift();
    if (outcome?.advance) this.#clock.advance(outcome.advance);
    if (outcome?.error) throw Object.assign(new Error("FAKE_OAUTH_UNAVAILABLE"), { code: "FAKE_OAUTH_UNAVAILABLE" });
    return this.#issue();
  }
  exchange = async input => {
    assert.ok(input && typeof input === "object");
    if (typeof input.client_id === "string") this.#clientId = input.client_id;
    if (typeof input.client_secret === "string") this.#clientSecret = input.client_secret;
    return this.#execute("exchange");
  };
  refresh = async input => {
    const value = typeof input === "string" ? input : input?.refresh_token;
    assert.ok(this.#validRefresh.delete(value), "renovação só consome uma vez");
    return this.#execute("refresh");
  };
  identifyAccount = async () => ({ id: this.accountId, scopes: [...this.scopes] });
}
export const fakeOAuth = options => new FakeOAuth(options);
