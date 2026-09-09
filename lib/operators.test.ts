import { describe, it, expect, beforeEach } from "vitest";
import {
  appsForFormat,
  currentOperator,
  getOperator,
  pickAppLink,
  withOperator,
  type Operator,
} from "./operators";

beforeEach(() => {
  delete process.env.FAL_KEY_BRITOK30;
  delete process.env.OPENAI_KEY_BRITOK30;
  delete process.env.FAL_KEY_FREMYROSSO1;
  delete process.env.OPENAI_KEY_FREMYROSSO1;
  delete process.env.APP_LINK_ARCHITECTGPT;
  delete process.env.APP_LINK_CASAGPT;
  delete process.env.APP_LINK_INTERIORGPT;
});

describe("getOperator", () => {
  it("returns null for unrecognized emails", () => {
    process.env.FAL_KEY_BRITOK30 = "fk";
    process.env.OPENAI_KEY_BRITOK30 = "ak";
    expect(getOperator("attacker@gmail.com")).toBeNull();
    expect(getOperator(null)).toBeNull();
    expect(getOperator(undefined)).toBeNull();
    expect(getOperator("")).toBeNull();
  });

  it("returns null when britok30's keys are missing", () => {
    expect(getOperator("britok30@gmail.com")).toBeNull();

    process.env.FAL_KEY_BRITOK30 = "fk";
    expect(getOperator("britok30@gmail.com")).toBeNull(); // still missing openai

    delete process.env.FAL_KEY_BRITOK30;
    process.env.OPENAI_KEY_BRITOK30 = "ak";
    expect(getOperator("britok30@gmail.com")).toBeNull(); // still missing fal
  });

  it("returns britok30 with ArchitectGPT (+ the staging-only AI Virtual Stage) + interior+exterior lanes", () => {
    process.env.FAL_KEY_BRITOK30 = "fk-britok";
    process.env.OPENAI_KEY_BRITOK30 = "ak-britok";
    process.env.APP_LINK_ARCHITECTGPT = "https://architectgpt.example/";

    const op = getOperator("britok30@gmail.com");

    expect(op).toMatchObject({
      email: "britok30@gmail.com",
      falKey: "fk-britok",
      openaiKey: "ak-britok",
    });
    expect(op?.apps.map((a) => a.name)).toEqual(["ArchitectGPT", "AI Virtual Stage"]);
    expect(op?.apps[0].url).toBe("https://architectgpt.example/");
    // The staging platform is scoped to the staging format only.
    expect(op?.apps[1]).toMatchObject({ url: "https://www.aivirtualstage.io", formats: ["staging"] });
    expect(appsForFormat(op!, "reel").map((a) => a.name)).toEqual(["ArchitectGPT"]);
    expect(op?.worldTypes).toEqual(["interior", "exterior"]);
    expect(op?.propertyTypes).toEqual(["residential", "commercial"]);
  });

  it("returns fremyrosso1 with InteriorGPT + interior-only lane", () => {
    process.env.FAL_KEY_FREMYROSSO1 = "fk-fremy";
    process.env.OPENAI_KEY_FREMYROSSO1 = "ak-fremy";
    process.env.APP_LINK_INTERIORGPT = "https://interiorgpt.example/";

    const op = getOperator("fremyrosso1@gmail.com");

    expect(op).toMatchObject({
      email: "fremyrosso1@gmail.com",
      falKey: "fk-fremy",
      openaiKey: "ak-fremy",
    });
    expect(op?.apps.map((a) => a.name)).toEqual(["InteriorGPT"]);
    // InteriorGPT is interior-only by design — exterior content would be
    // off-brand for the app — but covers both residential and commercial.
    expect(op?.worldTypes).toEqual(["interior"]);
    expect(op?.propertyTypes).toEqual(["residential", "commercial"]);
  });

  it("is case-insensitive on the email", () => {
    process.env.FAL_KEY_BRITOK30 = "fk";
    process.env.OPENAI_KEY_BRITOK30 = "ak";

    expect(getOperator("BritoK30@Gmail.com")?.email).toBe("britok30@gmail.com");
    expect(getOperator("FREMYROSSO1@GMAIL.COM")).toBeNull(); // missing keys still
  });

  it("doesn't share keys across operators (no env-var leak)", () => {
    process.env.FAL_KEY_BRITOK30 = "britok-only";
    process.env.OPENAI_KEY_BRITOK30 = "britok-only";
    expect(getOperator("fremyrosso1@gmail.com")).toBeNull();
  });
});

describe("pickAppLink", () => {
  function operatorWith(apps: Operator["apps"]): Operator {
    return {
      email: "x",
      falKey: "x",
      openaiKey: "x",
      apps,
      worldTypes: ["interior", "exterior"],
      propertyTypes: ["residential", "commercial"],
      socials: { instagram: "architectgpt", website: "https://www.architectgpt.io" },
    };
  }

  it("matches britok30's interior pattern → CasaGPT", () => {
    const op = operatorWith([
      { name: "ArchitectGPT", url: "https://architect.example/", handle: "architectgpt" },
      {
        name: "CasaGPT",
        url: "https://casa.example/",
        handle: "casagpt",
        pattern: /(interior|living)/,
      },
    ]);
    expect(pickAppLink(op, "modernist living rooms")).toBe("https://casa.example/");
    expect(pickAppLink(op, "interior detailing")).toBe("https://casa.example/");
  });

  it("falls back to the first app when no pattern matches", () => {
    const op = operatorWith([
      { name: "ArchitectGPT", url: "https://architect.example/", handle: "architectgpt" },
      { name: "CasaGPT", url: "https://casa.example/", handle: "casagpt", pattern: /(interior)/ },
    ]);
    expect(pickAppLink(op, "modernist exteriors")).toBe("https://architect.example/");
    expect(pickAppLink(op, "facades")).toBe("https://architect.example/");
  });

  it("works for a single-app operator", () => {
    const op = operatorWith([
      { name: "InteriorGPT", url: "https://interior.example/", handle: "interiorgpt" },
    ]);
    expect(pickAppLink(op, "anything goes")).toBe("https://interior.example/");
    expect(pickAppLink(op, "modernist interiors")).toBe("https://interior.example/");
  });

  it("returns empty string when the matched app's url is unset", () => {
    const op = operatorWith([{ name: "ArchitectGPT", url: "", handle: "architectgpt" }]);
    expect(pickAppLink(op, "x")).toBe("");
  });
});

describe("withOperator / currentOperator", () => {
  const op: Operator = {
    email: "britok30@gmail.com",
    falKey: "fk",
    openaiKey: "ak",
    apps: [{ name: "ArchitectGPT", url: "https://x", handle: "architectgpt" }],
    worldTypes: ["interior", "exterior"],
    propertyTypes: ["residential", "commercial"],
    socials: { instagram: "architectgpt", website: "https://www.architectgpt.io" },
  };

  it("currentOperator throws when called outside a withOperator scope", () => {
    expect(() => currentOperator()).toThrow(/No operator in current context/);
  });

  it("currentOperator returns the operator inside the scope", () => {
    const inside = withOperator(op, () => currentOperator());
    expect(inside).toBe(op);
  });

  it("propagates through async chains (the whole point of AsyncLocalStorage)", async () => {
    const inside = await withOperator(op, async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
      return currentOperator();
    });
    expect(inside).toBe(op);
  });

  it("isolates concurrent scopes — each request keeps its own operator", async () => {
    const opA: Operator = { ...op, email: "a@example.com", falKey: "A" };
    const opB: Operator = { ...op, email: "b@example.com", falKey: "B" };

    const [a, b] = await Promise.all([
      withOperator(opA, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return currentOperator().falKey;
      }),
      withOperator(opB, async () => {
        await new Promise((r) => setTimeout(r, 2));
        return currentOperator().falKey;
      }),
    ]);

    expect(a).toBe("A");
    expect(b).toBe("B");
  });
});

describe("appsForFormat — format-scoped apps", () => {
  const op: Operator = {
    email: "britok30@gmail.com",
    falKey: "f",
    openaiKey: "o",
    apps: [
      { name: "ArchitectGPT", url: "https://architectgpt.io", handle: "architectgpt" },
      { name: "AI Virtual Stage", url: "https://www.aivirtualstage.io", handle: "", formats: ["staging"] },
    ],
    worldTypes: ["interior", "exterior"],
    propertyTypes: ["residential", "commercial"],
    socials: { instagram: "architectgpt", website: "https://www.architectgpt.io" },
  };

  it("staging gets ONLY the staging platform; other formats never see it", () => {
    expect(appsForFormat(op, "staging").map((a) => a.name)).toEqual(["AI Virtual Stage"]);
    expect(appsForFormat(op, "reel").map((a) => a.name)).toEqual(["ArchitectGPT"]);
    expect(appsForFormat(op, "before-after").map((a) => a.name)).toEqual(["ArchitectGPT"]);
    expect(appsForFormat(op).map((a) => a.name)).toEqual(["ArchitectGPT"]);
  });

  it("pickAppLink follows the same scoping", () => {
    expect(pickAppLink(op, "living room", "staging")).toBe("https://www.aivirtualstage.io");
    expect(pickAppLink(op, "living room", "reel")).toBe("https://architectgpt.io");
    expect(pickAppLink(op, "living room")).toBe("https://architectgpt.io");
  });
});
