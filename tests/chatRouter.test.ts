import { describe, expect, it, vi } from "vitest";
import { createChatRouter } from "../src/providers/chatRouter.js";
import { CostTracker } from "../src/providers/costTracker.js";
import { BothTiersFailedError, ClientRequestError, ProviderAvailabilityError } from "../src/providers/errors.js";
import type { ChatAdapter, ChatCallResult, ChatRequest } from "../src/providers/chatTypes.js";

const REQUEST: ChatRequest = { system: "persona", history: [], latestMessage: "hello" };

function fakeResult(provider: "openai" | "gemini", overrides: Partial<ChatCallResult> = {}): ChatCallResult {
  return {
    provider,
    model: provider === "openai" ? "gpt-5.6-sol" : "gemini-3.7-flash",
    text: "a reply",
    usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
    ...overrides
  };
}

describe("createChatRouter (EN-081/083)", () => {
  it("returns the primary's result on success without touching the fallback", async () => {
    const primary = vi.fn<ChatAdapter>(async () => fakeResult("openai"));
    const fallback = vi.fn<ChatAdapter>(async () => fakeResult("gemini"));
    const router = createChatRouter(primary, fallback);

    const result = await router.reply(REQUEST);

    expect(result.provider).toBe("openai");
    expect(primary).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("falls back to tier 2 on a 5xx/availability failure from tier 1", async () => {
    const primary = vi.fn<ChatAdapter>(async () => {
      throw new ProviderAvailabilityError("503 from primary", 503);
    });
    const fallback = vi.fn<ChatAdapter>(async () => fakeResult("gemini"));
    const router = createChatRouter(primary, fallback);

    const result = await router.reply(REQUEST);

    expect(result.provider).toBe("gemini");
    expect(primary).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("does NOT fall back on a client (4xx) error — surfaces it immediately (EN-083)", async () => {
    const primary = vi.fn<ChatAdapter>(async () => {
      throw new ClientRequestError("400 malformed request", 400);
    });
    const fallback = vi.fn<ChatAdapter>(async () => fakeResult("gemini"));
    const router = createChatRouter(primary, fallback);

    await expect(router.reply(REQUEST)).rejects.toBeInstanceOf(ClientRequestError);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("throws BothTiersFailedError, carrying both underlying errors, when both tiers fail", async () => {
    const primary = vi.fn<ChatAdapter>(async () => {
      throw new ProviderAvailabilityError("primary down", 503);
    });
    const fallback = vi.fn<ChatAdapter>(async () => {
      throw new ProviderAvailabilityError("fallback down too", 503);
    });
    const router = createChatRouter(primary, fallback);

    await expect(router.reply(REQUEST)).rejects.toBeInstanceOf(BothTiersFailedError);
  });

  it("records cost on the tracker for whichever tier actually served the reply", async () => {
    const primary = vi.fn<ChatAdapter>(async () => {
      throw new ProviderAvailabilityError("503 from primary", 503);
    });
    const fallback = vi.fn<ChatAdapter>(async () => fakeResult("gemini", { usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 } }));
    const costTracker = new CostTracker();
    const router = createChatRouter(primary, fallback, costTracker);

    await router.reply(REQUEST);

    const records = costTracker.all();
    expect(records).toHaveLength(1);
    expect(records[0]!.provider).toBe("gemini");
  });
});
