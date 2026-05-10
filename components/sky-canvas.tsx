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
};

const SUNSET: Palette = {
  skyTop: "#1c0a2c",       // deep aubergine
  skyMid: "#c84b6e",       // hot pink
  skyHorizon: "#ffb27a",   // warm peach
  cloudHighlight: "#ffe0c2", // cream
  cloudShadow: "#5e2a4a",  // plum
  sunColor: "#ffd9a8",
  sunPos: [0.5, 0.32],
  sunRadius: 0.06,
  hasSun: true,
  cloudCoverage: 0.85,
  cloudSpeed: 0.06,
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

    // 2) Sun disc + halo (sunset only).
    if (uHasSun > 0.5) {
      // Aspect-correct distance so the sun is round, not stretched.
      vec2 sunUv = vec2((uv.x - uSunPos.x) * uAspect, uv.y - uSunPos.y);
      float d = length(sunUv);
      float core = smoothstep(uSunRadius, uSunRadius * 0.55, d);
      float halo = smoothstep(uSunRadius * 6.0, uSunRadius * 1.4, d) * 0.55;
      // The horizon lights up around the sun.
      float horizonGlow = exp(-d * 6.0) * 0.45;
      col += uSunColor * core;
      col = mix(col, uSunColor, halo * 0.4);
      col += uSunColor * horizonGlow * smoothstep(0.45, 0.0, uv.y);
    }

    // 3) Clouds — single FBM (was two blended). Cuts shader cost in half with
    // negligible visual difference because the rotated-octave FBM already gives
    // organic variety. Time-translates the noise space to drift horizontally.
    vec2 cloudUv = vec2(uv.x * 2.6 * uAspect + uTime * uCloudSpeed, uv.y * 1.8);
    float cloud = fbm(cloudUv);
    float lo = mix(0.65, 0.30, uCoverage); // coverage 0 → strict, 1 → permissive
    float hi = mix(0.85, 0.55, uCoverage);
    cloud = smoothstep(lo, hi, cloud);

    // Concentrate clouds in the lower-mid sky band — but a softer, wider band.
    float cloudBand = smoothstep(0.02, 0.20, uv.y) * smoothstep(0.95, 0.45, uv.y);

    // Cloud color: highlight at the bottom (lit by horizon/sun), shadow at top.
    vec3 cloudCol = mix(uCloudShadow, uCloudHighlight, smoothstep(0.10, 0.55, uv.y));

    // For sunset, kiss the cloud edges with a hint of sun color where the sun
    // is overhead-ish in screen space.
    if (uHasSun > 0.5) {
      float sunInfluence = exp(-distance(uv, uSunPos) * 2.5) * 0.55;
      cloudCol += uSunColor * sunInfluence;
    }

    col = mix(col, cloudCol, cloud * cloudBand);

    // 4) Atmospheric haze near the horizon — softens the cloud-base contrast.
    float haze = exp(-uv.y * 6.0) * 0.20;
    col = mix(col, uSkyHorizon, haze);

    // 5) Soft vignette anchored slightly above center.
    float vig = smoothstep(1.55, 0.45, distance(uv, vec2(0.5, 0.45)));
    col *= 0.82 + vig * 0.18;

    // 6) Subtle film grain — keeps the gradient from looking like cheap CSS.
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
