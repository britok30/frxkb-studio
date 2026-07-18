import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the OpenAI SDK: `new OpenAI({ apiKey })` returns a stub whose
// responses.create we control per test.
const createMock = vi.hoisted(() => vi.fn());
// Must be a `function` (not an arrow) so `new OpenAI(...)` can construct it.
const OpenAIMock = vi.hoisted(() =>
  vi.fn(function () {
    return { responses: { create: createMock } };
  })
);
vi.mock("openai", () => ({ default: OpenAIMock }));

import { generateText, generateJSON, LLM_MODEL, __resetLLMForTests } from "./llm";
import { withOperator, type Operator } from "./operators";

const britok: Operator = {
  email: "britok30@gmail.com",
  falKey: "fal",
  openaiKey: "ok-britok",
  apps: [{ name: "ArchitectGPT", url: "https://x", handle: "architectgpt" }],
  worldTypes: ["interior", "exterior"],
  propertyTypes: ["residential", "commercial"],
  socials: { instagram: "architectgpt", website: "https://www.architectgpt.io" },
};

beforeEach(() => {
  createMock.mockReset();
  OpenAIMock.mockClear();
  __resetLLMForTests();
});

function textResponse(text: string) {
  return { output_text: text, output: [] };
}
function toolResponse(obj: unknown, name = "submit") {
  return {
    output_text: "",
    output: [
      { type: "function_call", name, call_id: "c1", arguments: JSON.stringify(obj) },
    ],
  };
}

describe("generateText", () => {
  it("returns output_text and targets the configured LLM via the Responses API", async () => {
    createMock.mockResolvedValue(textResponse("hello world"));
    const out = await withOperator(britok, () =>
      generateText({ system: "sys", user: "usr" })
    );
    expect(out).toBe("hello world");
    const args = createMock.mock.calls[0][0];
    expect(args.model).toBe(LLM_MODEL);
    expect(args.instructions).toBe("sys");
    expect(args.input).toBe("usr");
    expect(args.reasoning).toEqual({ effort: "low" });
  });

  it("throws when the model returns no text", async () => {
    createMock.mockResolvedValue(textResponse(""));
    await expect(
      withOperator(britok, () => generateText({ system: "s", user: "u" }))
    ).rejects.toThrow(/No text response/);
  });

  it("throws when called outside an operator scope", async () => {
    await expect(generateText({ system: "s", user: "u" })).rejects.toThrow(
      /No operator in current context/
    );
  });
});

describe("generateJSON", () => {
  it("forces the named function call and returns the parsed arguments", async () => {
    createMock.mockResolvedValue(toolResponse({ a: 1, b: "x" }, "submit_thing"));
    const out = await withOperator(britok, () =>
      generateJSON<{ a: number; b: string }>({
        system: "s",
        user: "u",
        schema: { type: "object" },
        toolName: "submit_thing",
      })
    );
    expect(out).toEqual({ a: 1, b: "x" });
    const args = createMock.mock.calls[0][0];
    expect(args.tools[0]).toMatchObject({ type: "function", name: "submit_thing" });
    expect(args.tool_choice).toEqual({ type: "function", name: "submit_thing" });
    expect(args.instructions).toBe("s");
  });

  it("sends images as input_image content parts ahead of the text", async () => {
    createMock.mockResolvedValue(toolResponse({ ok: true }));
    await withOperator(britok, () =>
      generateJSON({ system: "s", user: "u", schema: {}, images: ["https://img/a.jpg"] })
    );
    const content = createMock.mock.calls[0][0].input[0].content;
    expect(content[0]).toEqual({
      type: "input_image",
      image_url: "https://img/a.jpg",
      detail: "auto",
    });
    expect(content[1]).toEqual({ type: "input_text", text: "u" });
  });

  it("sends a single input_text part when no images are passed", async () => {
    createMock.mockResolvedValue(toolResponse({ ok: true }));
    await withOperator(britok, () =>
      generateJSON({ system: "s", user: "u", schema: {} })
    );
    const content = createMock.mock.calls[0][0].input[0].content;
    expect(content).toEqual([{ type: "input_text", text: "u" }]);
  });

  it("throws when the model returns no function call", async () => {
    createMock.mockResolvedValue({ output_text: "nope", output: [{ type: "message" }] });
    await expect(
      withOperator(britok, () => generateJSON({ system: "s", user: "u", schema: {} }))
    ).rejects.toThrow(/structured output/);
  });
});

describe("per-operator client", () => {
  it("constructs the OpenAI client with the operator's key", async () => {
    createMock.mockResolvedValue(textResponse("x"));
    await withOperator(britok, () => generateText({ system: "s", user: "u" }));
    expect(OpenAIMock).toHaveBeenCalledWith({ apiKey: "ok-britok" });
  });
});
