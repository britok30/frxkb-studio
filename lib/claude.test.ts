import { describe, it, expect, vi, beforeEach } from "vitest";

const createMock = vi.hoisted(() => vi.fn());
const ctorSpy = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create: createMock };
    constructor(opts?: { apiKey?: string }) {
      ctorSpy(opts);
    }
  }
  return { default: FakeAnthropic };
});

import { generateText, generateJSON, CLAUDE_MODEL, __resetClaudeForTests } from "./claude";
import { withOperator, type Operator } from "./operators";

const britok: Operator = {
  email: "britok30@gmail.com",
  falKey: "fal",
  anthropicKey: "ak-britok",
  apps: [{ name: "ArchitectGPT", url: "https://x" }],
};

const fremy: Operator = {
  email: "fremyrosso1@gmail.com",
  falKey: "fal",
  anthropicKey: "ak-fremy",
  apps: [{ name: "InteriorGPT", url: "https://x" }],
};

beforeEach(() => {
  createMock.mockReset();
  ctorSpy.mockReset();
  __resetClaudeForTests();
});

describe("CLAUDE_MODEL", () => {
  it("is pinned to claude-opus-4-7 (latest Opus)", () => {
    expect(CLAUDE_MODEL).toBe("claude-opus-4-7");
  });
});

describe("generateText (operator-scoped)", () => {
  it("instantiates Anthropic with the current operator's key", async () => {
    createMock.mockResolvedValue({ content: [{ type: "text", text: "hello world" }] });

    await withOperator(britok, () => generateText({ system: "be brief", user: "hi" }));

    expect(ctorSpy).toHaveBeenCalledExactlyOnceWith({ apiKey: "ak-britok" });
  });

  it("uses Opus 4.7, caches the system prompt, and returns the text block", async () => {
    createMock.mockResolvedValue({ content: [{ type: "text", text: "hello world" }] });

    const out = await withOperator(britok, () =>
      generateText({ system: "be brief", user: "hi" })
    );

    expect(out).toBe("hello world");
    expect(createMock).toHaveBeenCalledTimes(1);
    const args = createMock.mock.calls[0][0];
    expect(args.model).toBe("claude-opus-4-7");
    expect(args.system).toEqual([
      { type: "text", text: "be brief", cache_control: { type: "ephemeral" } },
    ]);
    expect(args.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(args.max_tokens).toBe(2048);
  });

  it("respects a custom maxTokens", async () => {
    createMock.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    await withOperator(britok, () =>
      generateText({ system: "s", user: "u", maxTokens: 500 })
    );

    expect(createMock.mock.calls[0][0].max_tokens).toBe(500);
  });

  it("throws when no text block is returned", async () => {
    createMock.mockResolvedValue({ content: [{ type: "tool_use", input: {} }] });

    await expect(
      withOperator(britok, () => generateText({ system: "s", user: "u" }))
    ).rejects.toThrow(/No text response/);
  });
});

describe("generateJSON (operator-scoped)", () => {
  const schema = {
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
  };

  it("forces tool use, returns parsed tool input", async () => {
    createMock.mockResolvedValue({
      content: [{ type: "tool_use", name: "submit", input: { title: "A House" } }],
    });

    const out = await withOperator(britok, () =>
      generateJSON<{ title: string }>({ system: "be precise", user: "give me a title", schema })
    );

    expect(out).toEqual({ title: "A House" });
    const args = createMock.mock.calls[0][0];
    expect(args.tool_choice).toEqual({ type: "tool", name: "submit" });
    expect(args.tools).toHaveLength(1);
    expect(args.tools[0].name).toBe("submit");
    expect(args.tools[0].input_schema).toBe(schema);
    expect(args.system[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("supports a custom tool name", async () => {
    createMock.mockResolvedValue({
      content: [{ type: "tool_use", name: "submit_brief", input: { ok: true } }],
    });

    await withOperator(britok, () =>
      generateJSON<{ ok: boolean }>({
        system: "s",
        user: "u",
        schema,
        toolName: "submit_brief",
      })
    );

    const args = createMock.mock.calls[0][0];
    expect(args.tools[0].name).toBe("submit_brief");
    expect(args.tool_choice).toEqual({ type: "tool", name: "submit_brief" });
  });

  it("throws when Claude does not return a tool_use block", async () => {
    createMock.mockResolvedValue({ content: [{ type: "text", text: "I refuse" }] });

    await expect(
      withOperator(britok, () => generateJSON({ system: "s", user: "u", schema }))
    ).rejects.toThrow(/structured output/);
  });
});

describe("client cache (per-operator)", () => {
  it("constructs Anthropic exactly once per operator across many calls", async () => {
    createMock.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    await withOperator(britok, async () => {
      await generateText({ system: "s", user: "u" });
      await generateText({ system: "s", user: "u" });
      await generateText({ system: "s", user: "u" });
    });

    expect(ctorSpy).toHaveBeenCalledExactlyOnceWith({ apiKey: "ak-britok" });
    expect(createMock).toHaveBeenCalledTimes(3);
  });

  it("constructs a separate client for a different operator", async () => {
    createMock.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    await withOperator(britok, () => generateText({ system: "s", user: "u" }));
    await withOperator(fremy, () => generateText({ system: "s", user: "u" }));

    expect(ctorSpy).toHaveBeenCalledTimes(2);
    expect(ctorSpy).toHaveBeenNthCalledWith(1, { apiKey: "ak-britok" });
    expect(ctorSpy).toHaveBeenNthCalledWith(2, { apiKey: "ak-fremy" });
  });

  it("throws when called outside any operator scope", async () => {
    await expect(generateText({ system: "s", user: "u" })).rejects.toThrow(
      /No operator in current context/
    );
  });
});
