import { expect, it } from "vitest";
import { normalizeZernioError } from "../src/zernio-errors";

it("shows the documented validation message, code and parameter", () => {
  expect(
    normalizeZernioError(
      400,
      {
        error: "limit must be between 1 and 500",
        type: "invalid_request_error",
        code: "invalid_field_value",
        param: "limit",
      },
      [],
    ),
  ).toEqual({
    status: 400,
    code: "zernio_rejected",
    message:
      "Zernio recusou a operação (HTTP 400, código invalid_field_value, campo limit). limit must be between 1 and 500",
  });
});

it("supports legacy message fields without copying structured provider data", () => {
  const error = normalizeZernioError(
    400,
    {
      message: "Invalid redirect_url",
      details: { token: "private-details" },
      platformError: { message: "private-provider-payload" },
    },
    [],
  );
  expect(error.message).toContain("Invalid redirect_url");
  expect(error.message).not.toMatch(/private-details|private-provider-payload/);
  expect(
    normalizeZernioError(
      400,
      { error: { message: "Profile ID not found" } },
      [],
    ).message,
  ).toContain("Profile ID not found");
});

it("removes known credentials and their encoded echoes before truncating", () => {
  const key = `sk_${"a".repeat(64)}`;
  const secret = "private webhook/secret?&+";
  const message = normalizeZernioError(
    400,
    {
      error: `Invalid credentials ${key}; ${secret}; ${encodeURIComponent(secret)}; ${new URLSearchParams({ value: secret }).toString()}`,
      code: key,
      param: key,
    },
    [key, secret],
  ).message;
  expect(message).not.toContain(key);
  expect(message).not.toContain(secret);
  expect(message).not.toContain(encodeURIComponent(secret));
  expect(message).not.toContain("código");
  expect(message).not.toContain("campo");
  expect(message).toContain("[credencial omitida]");
});

it("removes credential patterns, URLs, HTML and control characters", () => {
  const message = normalizeZernioError(
    400,
    {
      error:
        '<b>Invalid</b>\r\nAuthorization: Bearer unknown-token; api_key="another-secret"; sk_abcdefghi https://user:secret@example.test/?token=private\u202e',
      code: "invalid_field_value\nforged",
      param: "redirect_url?token=private",
    },
    [],
  ).message;
  expect(message).toContain("Invalid");
  expect(message).not.toMatch(
    /unknown-token|another-secret|sk_abcdefghi|example\.test|private|<b>|[\r\n\u202e]|forged/,
  );
});

it("redacts credentials reconstructed by removing provider markup", () => {
  const key = "zrk_abcd1234567890";
  const message = normalizeZernioError(
    400,
    { error: "Invalid zrk_abcd<b>1234567890</b>" },
    [key],
  ).message;
  expect(message).not.toContain(key);
  expect(message).toContain("Invalid [credencial omitida]");
});

it("bounds details and falls back safely for missing or non-string messages", () => {
  expect(
    normalizeZernioError(400, { error: "a".repeat(10000) }, []).message.length,
  ).toBeLessThan(400);
  for (const value of [null, "HTML", {}, { error: { token: "private" } }]) {
    expect(normalizeZernioError(400, value, []).message).toBe(
      "Zernio recusou a operação (HTTP 400). Confira os campos e as permissões da integração.",
    );
  }
});

it("keeps server errors uncertain and omits provider retry instructions", () => {
  const failure = normalizeZernioError(
    503,
    { error: "Retry the send now", code: "temporarily_unavailable" },
    [],
  );
  expect(failure).toMatchObject({ status: 502, code: "zernio_unknown" });
  expect(failure.message).toContain("não confirmou");
  expect(failure.message).toContain("Consulte a entrega antes de repetir.");
  expect(failure.message).not.toMatch(/recusou|Retry the send now/);
  for (const payload of [
    { unconfirmedWrite: { type: "creative" } },
    { privateReplyOutcome: "unknown" },
  ]) {
    expect(normalizeZernioError(400, payload, []).code).toBe("zernio_unknown");
  }
});
