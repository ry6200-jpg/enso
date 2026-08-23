import { beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/events/eventLog.js";
import { PRIMARY_USER_ID } from "../src/test/seed.js";
import { generateWelcomeBackMessage, getWelcomeBackEligibility, WELCOME_BACK_GAP_MS } from "../src/persona/welcomeBack.js";
import type { ChatRouter } from "../src/providers/chatRouter.js";
import type { ChatCallResult, ChatRequest } from "../src/providers/chatTypes.js";

let eventLog: EventLog;

beforeEach(() => {
  eventLog = new EventLog(":memory:");
});

function appendUserMessage(text: string): void {
  eventLog.append({ type: "message_sent", actor: "user", payload: { text, attachmentOnly: false }, userId: PRIMARY_USER_ID });
}

function appendReply(text: string): void {
  eventLog.append({ type: "reply_sent", actor: "enso", payload: { text }, userId: PRIMARY_USER_ID });
}

describe("getWelcomeBackEligibility (item 3: gap-based welcome back)", () => {
  it("is NOT eligible on a genuinely empty log — the proactive opener owns that case, not this module", () => {
    expect(getWelcomeBackEligibility(eventLog, PRIMARY_USER_ID).eligible).toBe(false);
  });

  it("is NOT eligible when the gap since the last message is under the threshold — the common quick-refresh case", () => {
    appendUserMessage("just talked to my sister");
    const justUnderThreshold = Date.now() + WELCOME_BACK_GAP_MS - 1000;
    expect(getWelcomeBackEligibility(eventLog, PRIMARY_USER_ID, justUnderThreshold).eligible).toBe(false);
  });

  it("IS eligible once the gap reaches the threshold", () => {
    appendUserMessage("just talked to my sister");
    const atThreshold = Date.now() + WELCOME_BACK_GAP_MS;
    expect(getWelcomeBackEligibility(eventLog, PRIMARY_USER_ID, atThreshold).eligible).toBe(true);
  });

  it("grounds eligibility in the LAST message regardless of role — a reply as the most recent event still starts the gap clock", () => {
    appendUserMessage("just talked to my sister");
    appendReply("That sounds like a good call.");
    const justUnderThreshold = Date.now() + WELCOME_BACK_GAP_MS - 1000;
    expect(getWelcomeBackEligibility(eventLog, PRIMARY_USER_ID, justUnderThreshold).eligible).toBe(false);
  });

  it("returns the owner's own last USER message verbatim, even when enso replied after it", () => {
    appendUserMessage("just talked to my sister, it went better than expected");
    appendReply("Glad to hear that.");
    const result = getWelcomeBackEligibility(eventLog, PRIMARY_USER_ID, Date.now() + WELCOME_BACK_GAP_MS);
    expect(result.lastUserMessageText).toBe("just talked to my sister, it went better than expected");
  });

  it("returns null lastUserMessageText when the only prior turn was the enso side (no real user words to ground a reference in)", () => {
    appendReply("hello there");
    const result = getWelcomeBackEligibility(eventLog, PRIMARY_USER_ID, Date.now() + WELCOME_BACK_GAP_MS);
    expect(result.eligible).toBe(true);
    expect(result.lastUserMessageText).toBeNull();
  });
});

function fakeChatRouter(replyText: string): ChatRouter {
  return {
    reply(_request: ChatRequest): Promise<ChatCallResult> {
      return Promise.resolve({ text: replyText, provider: "openai" } as ChatCallResult);
    }
  };
}

describe("generateWelcomeBackMessage (item 3: honesty and cost)", () => {
  it("makes exactly one chat-router call", async () => {
    let calls = 0;
    const router: ChatRouter = {
      reply(request: ChatRequest): Promise<ChatCallResult> {
        calls++;
        return Promise.resolve({ text: "Good to see you again.", provider: "openai" } as ChatCallResult);
      }
    };
    await generateWelcomeBackMessage(router, "just talked to my sister");
    expect(calls).toBe(1);
  });

  it("passes the owner's actual last message verbatim into the prompt, never a paraphrase constructed by this code", async () => {
    let seenSystem = "";
    const router: ChatRouter = {
      reply(request: ChatRequest): Promise<ChatCallResult> {
        seenSystem = request.system;
        return Promise.resolve({ text: "Welcome back.", provider: "openai" } as ChatCallResult);
      }
    };
    await generateWelcomeBackMessage(router, "just talked to my sister, it went better than expected");
    expect(seenSystem).toContain("just talked to my sister, it went better than expected");
    expect(seenSystem).toMatch(/never invent or infer/);
  });

  it("instructs a generic, simple greeting when there's no last message to ground a reference in", async () => {
    let seenSystem = "";
    const router: ChatRouter = {
      reply(request: ChatRequest): Promise<ChatCallResult> {
        seenSystem = request.system;
        return Promise.resolve({ text: "Welcome back.", provider: "openai" } as ChatCallResult);
      }
    };
    await generateWelcomeBackMessage(router, null);
    expect(seenSystem).toMatch(/nothing specific from last time/);
  });

  it("strips surrounding quotes from the model's output, same discipline as the zodiac reflections", async () => {
    const router = fakeChatRouter('"Good to see you again."');
    const text = await generateWelcomeBackMessage(router, null);
    expect(text).toBe("Good to see you again.");
  });
});
