import { it, expect } from "vitest";
import { animateAllScenes } from "@/lib/projects";
import { getOperator, withOperator } from "@/lib/operators";

it.runIf(process.env.RESCUE === "1")("finishes the stranded animate", { timeout: 15 * 60 * 1000 }, async () => {
  const op = getOperator("britok30@gmail.com");
  if (!op) throw new Error("operator missing");
  await withOperator(op, async () => {
    const out = await animateAllScenes("NU0zts1EmdTW");
    console.log("animate:", JSON.stringify(out));
    expect(out.failed).toBe(0);
  });
});
