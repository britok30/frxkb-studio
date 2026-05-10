import type { Project } from "@/lib/db";
import { selectDedupeCandidates } from "@/lib/projects-db";

export type DuplicateMatch = {
  project: Pick<Project, "id" | "title" | "niche" | "format" | "createdAt">;
  /** Why this match was flagged. */
  reason: "exact-signature" | "keyword-overlap";
  /** 0-1. Exact signature is always 1; keyword overlap is the Jaccard score. */
  confidence: number;
};

export type DedupeResult = {
  /** True if any candidate scored >= confidence threshold. */
  hasMatches: boolean;
  /** Top matches, sorted by confidence descending. */
  matches: DuplicateMatch[];
};

const KEYWORD_OVERLAP_THRESHOLD = 0.5; // Jaccard

/** Jaccard similarity between two keyword sets. Lowercase + trim normalized. */
export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a.map(normalize));
  const setB = new Set(b.map(normalize));
  let intersection = 0;
  for (const x of setA) if (setB.has(x)) intersection++;
  const unionSize = setA.size + setB.size - intersection;
  return unionSize === 0 ? 0 : intersection / unionSize;
}

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

/** Find existing projects that look like duplicates of the proposed world. */
export async function findSimilarProjects(opts: {
  signature: string;
  keywords: string[];
  /** Exclude this project id from results — used during regenerate-style flows.
   *  Optional; omit during fresh project creation. */
  excludeProjectId?: string;
}): Promise<DedupeResult> {
  const candidates = await selectDedupeCandidates(opts.signature, opts.keywords);

  const matches: DuplicateMatch[] = [];
  for (const c of candidates) {
    if (opts.excludeProjectId && c.id === opts.excludeProjectId) continue;

    if (c.worldSignature && c.worldSignature === opts.signature) {
      matches.push({
        project: pick(c),
        reason: "exact-signature",
        confidence: 1,
      });
      continue;
    }

    if (c.worldKeywords && c.worldKeywords.length > 0) {
      const score = jaccard(opts.keywords, c.worldKeywords);
      if (score >= KEYWORD_OVERLAP_THRESHOLD) {
        matches.push({
          project: pick(c),
          reason: "keyword-overlap",
          confidence: score,
        });
      }
    }
  }

  matches.sort((a, b) => b.confidence - a.confidence);
  return {
    hasMatches: matches.length > 0,
    matches: matches.slice(0, 3),
  };
}

function pick(p: Project): DuplicateMatch["project"] {
  return {
    id: p.id,
    title: p.title,
    niche: p.niche,
    format: p.format,
    createdAt: p.createdAt,
  };
}
