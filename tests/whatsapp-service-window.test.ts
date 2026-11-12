import { describe, expect, it } from "vitest";
import { whatsappServiceWindow } from "../web/whatsapp-service-window";

describe("WhatsApp customer service window", () => {
  const received = 1794480000000;
  it("counts from the last customer message to the exact 24-hour boundary", () => {
    expect(
      whatsappServiceWindow(received, received + 23 * 3600000),
    ).toMatchObject({
      open: true,
      countdown: "01:00:00",
      expiresAt: received + 86400000,
    });
    expect(whatsappServiceWindow(received, received + 86400000)).toMatchObject({
      open: false,
      remainingMs: 0,
      countdown: "00:00:00",
    });
  });
  it("keeps the window closed without a valid customer receipt", () => {
    for (const lastCustomer of [0, -1, NaN, received + 1])
      expect(whatsappServiceWindow(lastCustomer, received)).toMatchObject({
        open: false,
        expiresAt: null,
      });
  });
  it("does not infer a renewed window from current outgoing activity", () => {
    expect(
      whatsappServiceWindow(received, received + 2 * 86400000),
    ).toMatchObject({
      open: false,
      expiresAt: received + 86400000,
    });
  });
});
