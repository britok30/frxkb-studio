"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";

// ── Palettes ──────────────────────────────────────────────────────────────────
// Each preset is a complete color world: vertical sky gradient (top → mid →
// horizon), cloud highlight + shadow, optional sun. Tuned to feel photographic
// rather than illustrative. Numbers are tweaked by eye against the shader.

type Palette = {
  skyTop: string;
  skyMid: string;
  skyHorizon: string;
  cloudHighlight: string;
  cloudShadow: string;
  sunColor: string;
  sunPos: [number, number]; // 0..1 in screen space
  sunRadius: number;        // 0..1 in screen space
  hasSun: boolean;
  cloudCoverage: number;    // 0..1 — higher = more cloud
  cloudSpeed: number;       // arbitrary
  /** Vertical stretch of the cloud noise — higher = long horizontal stratus
   *  streaks (sunset), lower = puffier billows (twilight). */
  cloudStreak: number;
};

const SUNSET: Palette = {
  skyTop: "#160a26",       // deep aubergine, a touch deeper for contrast
  skyMid: "#c8496b",       // hot pink
  skyHorizon: "#ffb076",   // warm peach
  cloudHighlight: "#ffe3c4", // cream
  cloudShadow: "#4e2542",  // plum
  sunColor: "#ffd9a2",
  // Low and off-center — golden-hour composition, not a bullseye.
  sunPos: [0.63, 0.24],
  sunRadius: 0.052,
  hasSun: true,
  cloudCoverage: 0.82,
  cloudSpeed: 0.06,
  cloudStreak: 2.6,
};

const TWILIGHT: Palette = {
  skyTop: "#0c1530",       // deep night blue
  skyMid: "#3b3f72",       // moody indigo
  skyHorizon: "#a8a0bd",   // dusty mauve
  cloudHighlight: "#dde0ed", // pale lavender
  cloudShadow: "#181f3a",  // dark navy
  sunColor: "#ffffff",
  sunPos: [0.5, 0.5],
  sunRadius: 0,
  hasSun: false,
  cloudCoverage: 0.9,
  cloudSpeed: 0.04,
  cloudStreak: 1.0, // multiplier of the base 1.8 — keeps twilight exactly as it was
};

const PRESETS: Record<"sunset" | "twilight", Palette> = {
  sunset: SUNSET,
  twilight: TWILIGHT,
};

// ── Shaders ───────────────────────────────────────────────────────────────────

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    // Render the plane in NDC directly — bypass camera transforms so it always
    // covers the full viewport regardless of aspect.
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;

  varying vec2 vUv;

  uniform float uTime;
  uniform float uAspect;

  uniform vec3 uSkyTop;
  uniform vec3 uSkyMid;
  uniform vec3 uSkyHorizon;
  uniform vec3 uCloudHighlight;
  uniform vec3 uCloudShadow;
  uniform vec3 uSunColor;
  uniform vec2 uSunPos;
  uniform float uSunRadius;
  uniform float uHasSun;
  uniform float uCoverage;
  uniform float uCloudSpeed;
  uniform float uCloudStreak;

  // ── Hash + noise + FBM ─────────────────────────────────────────────────────
  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  // 5-octave FBM (was 6) — visually indistinguishable but ~17% cheaper.
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    mat2 r = mat2(0.8, -0.6, 0.6, 0.8); // gentle rotation per octave
    for (int i = 0; i < 5; i++) {
      v += a * valueNoise(p);
      p = r * p * 2.0;
      a *= 0.5;
    }
    return v;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  vec3 threeStopGradient(float y) {
    // 0 = horizon (bottom), 1 = top of sky.
    vec3 a = mix(uSkyHorizon, uSkyMid, smoothstep(0.0, 0.45, y));
    vec3 b = mix(uSkyMid, uSkyTop, smoothstep(0.45, 1.0, y));
    return mix(a, b, smoothstep(0.4, 0.55, y));
  }

  void main() {
    vec2 uv = vUv;

    // 1) Base sky gradient.
    vec3 col = threeStopGradient(uv.y);

    // 2) Sun — layered like a photograph: hot core, tight bloom, wide warm
    //    scatter, and an atmospherically FLATTENED glow near the horizon
    //    (light smears sideways through thick air at low sun angles).
    vec2 sunUv = vec2((uv.x - uSunPos.x) * uAspect, uv.y - uSunPos.y);
    float dSun = length(sunUv);
    if (uHasSun > 0.5) {
      float core  = smoothstep(uSunRadius, uSunRadius * 0.5, dSun);
      float bloom = exp(-dSun * 16.0) * 0.8;
      float scatter = exp(-dSun * 4.2) * 0.2;
      // Horizontal smear: stronger where |dy| is small — the low-sun squash.
      float smear = exp(-abs(sunUv.y) * 9.0) * exp(-abs(sunUv.x) * 2.2) * 0.26;
      col += uSunColor * (core + bloom);
      col += uSunColor * scatter * vec3(1.0, 0.82, 0.72);   // scatter warms to pink
      col += uSunColor * smear * smoothstep(0.5, 0.0, uv.y); // hug the horizon
    }

    // 3) Clouds — FBM stretched horizontally by uCloudStreak so sunset skies
    //    read as long stratus bands, not cauliflower. Time drifts them.
    vec2 cloudUv = vec2(
      uv.x * 2.6 * uAspect + uTime * uCloudSpeed,
      uv.y * (1.8 * uCloudStreak)
    );
    float cloud = fbm(cloudUv);
    float lo = mix(0.65, 0.30, uCoverage); // coverage 0 → strict, 1 → permissive
    float hi = mix(0.85, 0.55, uCoverage);
    cloud = smoothstep(lo, hi, cloud);

    // Concentrate clouds in the lower-mid sky band — but a softer, wider band.
    float cloudBand = smoothstep(0.02, 0.20, uv.y) * smoothstep(0.95, 0.45, uv.y);

    // Cloud color: highlight at the bottom (lit by horizon/sun), shadow at top.
    vec3 cloudCol = mix(uCloudShadow, uCloudHighlight, smoothstep(0.10, 0.55, uv.y));

    if (uHasSun > 0.5) {
      // Ambient warmth falls off with distance from the sun.
      float sunInfluence = exp(-distance(uv, uSunPos) * 2.4) * 0.5;
      cloudCol += uSunColor * sunInfluence;

      // RIM LIGHT — the silver lining. Sample the cloud field a step toward
      // the sun: where density drops in that direction, this edge faces the
      // light, so it catches a hot rim. This is what sells "backlit clouds".
      vec2 toSun = normalize(vec2(uSunPos.x - uv.x, uSunPos.y - uv.y) + 1e-5);
      float cloudTowardSun = fbm(cloudUv + toSun * 0.14);
      cloudTowardSun = smoothstep(lo, hi, cloudTowardSun);
      float rim = clamp(cloud - cloudTowardSun, 0.0, 1.0);
      float rimFalloff = exp(-distance(uv, uSunPos) * 2.0);
      cloudCol += uSunColor * rim * rimFalloff * 1.6;
    }

    col = mix(col, cloudCol, cloud * cloudBand);

    // 4) Atmospheric haze near the horizon — softens the cloud-base contrast.
    float haze = exp(-uv.y * 6.0) * 0.20;
    col = mix(col, uSkyHorizon, haze);

    // 5) Soft vignette anchored slightly above center.
    float vig = smoothstep(1.55, 0.45, distance(uv, vec2(0.5, 0.45)));
    col *= 0.82 + vig * 0.18;

    // 6) Filmic finish: gentle shoulder so the sun bloom rolls off instead of
    //    clipping, plus a whisper of saturation lift.
    col = col / (1.0 + max(col - 1.0, 0.0) * 0.6);
    float luma = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(luma), col, 1.06);

    // 7) Subtle film grain — keeps the gradient from looking like cheap CSS.
    float g = (hash(uv * 1500.0 + uTime) - 0.5) * 0.022;
    col += g;

    gl_FragColor = vec4(col, 1.0);
  }
`;

// ── React component ───────────────────────────────────────────────────────────

function SkyMesh({ preset }: { preset: keyof typeof PRESETS }) {
  const matRef = useRef<THREE.ShaderMaterial>(null);
  const palette = PRESETS[preset];

  const uniforms = useMemo(() => {
    return {
      uTime: { value: 0 },
      uAspect: { value: 1 },
      uSkyTop: { value: new THREE.Color(palette.skyTop) },
      uSkyMid: { value: new THREE.Color(palette.skyMid) },
      uSkyHorizon: { value: new THREE.Color(palette.skyHorizon) },
      uCloudHighlight: { value: new THREE.Color(palette.cloudHighlight) },
      uCloudShadow: { value: new THREE.Color(palette.cloudShadow) },
      uSunColor: { value: new THREE.Color(palette.sunColor) },
      uSunPos: { value: new THREE.Vector2(...palette.sunPos) },
      uSunRadius: { value: palette.sunRadius },
      uHasSun: { value: palette.hasSun ? 1 : 0 },
      uCoverage: { value: palette.cloudCoverage },
      uCloudSpeed: { value: palette.cloudSpeed },
      uCloudStreak: { value: palette.cloudStreak },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset]);

  useFrame((state) => {
    const m = matRef.current;
    if (!m) return;
    // Use performance.now() instead of state.clock.elapsedTime — R3F still
    // exposes the deprecated THREE.Clock and that surfaces as a console warning.
    m.uniforms.uTime.value = performance.now() * 0.001;
    m.uniforms.uAspect.value = state.size.width / Math.max(1, state.size.height);
  });

  return (
    <mesh frustumCulled={false}>
      <planeGeometry args={[2, 2]} />
      <shaderMaterial
        ref={matRef}
        uniforms={uniforms}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        depthTest={false}
        depthWrite={false}
      />
    </mesh>
  );
}

export type SkyPreset = keyof typeof PRESETS;

export function SkyCanvas({
  preset,
  className,
  // Cap DPR at 1.5 — at dpr=2 on a Retina display we'd be shading 4× more
  // pixels than at dpr=1. The shader (5-octave FBM per pixel) gets expensive
  // fast. 1.5 is the sweet spot: noticeably crisper than 1, half the work of 2.
  dpr = [1, 1.5],
}: {
  preset: SkyPreset;
  className?: string;
  dpr?: [number, number];
}) {
  return (
    <div className={className}>
      <Canvas
        // No camera setup needed — vertex shader writes directly to NDC.
        gl={{ antialias: true, alpha: false, powerPreference: "high-performance" }}
        dpr={dpr}
        // Pin to "always" — we never want demand-mode pausing. (Browsers will
        // still throttle WebGL when the canvas is fully offscreen; the layout
        // keeps it sticky/in-view to dodge that.)
        frameloop="always"
        flat
      >
        <SkyMesh preset={preset} />
      </Canvas>
    </div>
  );
}
