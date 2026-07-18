// Camera-move preset catalog — client-safe module (no llm/operator imports,
// so the picker UI can bundle it). The motion-prompt builder re-exports from
// here; keep the two in one place.
//
// The Higgsfield lesson: named camera moves the operator PICKS beat prompt
// roulette. Each preset maps to one allowlisted move; when a scene carries
// one, GPT must lead the motion prompt with that exact directive and only
// writes the subject/environmental motion around it.

export type CameraMove = {
  id: string;
  /** Short picker label. */
  name: string;
  /** The exact camera directive the motion prompt must lead with. */
  directive: string;
  /** One-line hint shown in the picker. */
  hint: string;
};

export const CAMERA_MOVES: CameraMove[] = [
  { id: "dolly-in", name: "Dolly in", directive: "slow dolly in", hint: "Glide toward the subject" },
  { id: "dolly-out", name: "Dolly out", directive: "slow dolly out", hint: "Pull back to reveal the room" },
  { id: "orbit-left", name: "Orbit left", directive: "slow orbit left, a gentle arc around the subject", hint: "Hero move for exteriors + objects" },
  { id: "orbit-right", name: "Orbit right", directive: "slow orbit right, a gentle arc around the subject", hint: "Hero move for exteriors + objects" },
  { id: "push-through", name: "Push through", directive: "slow push-in through the opening, revealing the space beyond", hint: "The doorway reveal — for thresholds" },
  { id: "rack-focus", name: "Rack focus", directive: "gentle rack focus from the foreground detail to the room beyond", hint: "Needs layered depth" },
  { id: "pan-left", name: "Pan left", directive: "gentle pan left", hint: "Lead the eye across the space" },
  { id: "pan-right", name: "Pan right", directive: "gentle pan right", hint: "Lead the eye across the space" },
  { id: "tilt-up", name: "Tilt up", directive: "slow tilt up", hint: "Reveal height — ceilings, facades" },
  { id: "tilt-down", name: "Tilt down", directive: "slow tilt down", hint: "Settle from height to ground" },
  { id: "static", name: "Static", directive: "locked-off static camera", hint: "Only the environment moves" },
  { id: "handheld", name: "Handheld", directive: "subtle handheld drift, almost imperceptible", hint: "A breath of documentary life" },
];

const CAMERA_MOVES_BY_ID = new Map(CAMERA_MOVES.map((m) => [m.id, m]));

export function getCameraMove(id: string | null | undefined): CameraMove | null {
  if (!id) return null;
  return CAMERA_MOVES_BY_ID.get(id) ?? null;
}
