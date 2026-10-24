import * as THREE from 'three'

/** Flowing light-trail for route tubes. vDist = uOffset + uv.x * uLength (metres along the route). */
export function makeFlowMaterial(color: THREE.Color, opts: { offset: number; length: number; total: number }) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false, // x-ray: the route stays visible through walls and machines
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    uniforms: {
      uTime: { value: 0 },
      uOffset: { value: opts.offset },
      uLength: { value: opts.length },
      uTotal: { value: opts.total },
      uColor: { value: color.clone() },
      uReveal: { value: 0 },
      uHead: { value: 0 },
    },
    vertexShader: /* glsl */ `
      uniform float uOffset; uniform float uLength;
      varying float vDist; varying vec3 vN; varying vec3 vView;
      void main() {
        vDist = uOffset + uv.x * uLength;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform float uTotal; uniform vec3 uColor; uniform float uReveal; uniform float uHead;
      varying float vDist; varying vec3 vN; varying vec3 vView;
      void main() {
        if (vDist > uReveal) discard;
        float rim = pow(clamp(1.0 - abs(dot(normalize(vN), vView)), 0.0, 1.0), 1.5);
        float dash = fract((vDist - uTime * 6.0) / 3.0);
        float d = smoothstep(0.0, 0.15, dash) * (1.0 - smoothstep(0.45, 0.6, dash));
        float head = exp(-abs(vDist - uHead) * 0.5);
        vec3 col = uColor * (0.55 + 1.9 * d + 0.6 * rim) + vec3(1.0) * head * 3.0;
        float a = clamp(0.35 + 0.65 * d + rim * 0.4 + head, 0.0, 1.0);
        if (any(isnan(col)) || isnan(a)) discard; // NaN would smear across the whole frame via bloom
        gl_FragColor = vec4(col, a);
      }`,
  })
}

/** Expanding concentric rings on a plane (use with a PlaneGeometry rotated flat). */
export function makePulseMaterial(color: THREE.Color) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    side: THREE.DoubleSide,
    uniforms: { uTime: { value: 0 }, uColor: { value: color.clone() }, uStrength: { value: 1 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uColor; uniform float uStrength; varying vec2 vUv;
      void main() {
        float r = length(vUv - 0.5) * 2.0;
        if (r > 1.0) discard;
        float a = 0.0;
        for (int i = 0; i < 3; i++) {
          float p = fract(uTime * 0.6 + float(i) / 3.0);
          float ring = smoothstep(0.06, 0.0, abs(r - p)) * (1.0 - p);
          a += ring;
        }
        a += smoothstep(0.22, 0.0, r) * 0.6;
        a += smoothstep(0.03, 0.0, abs(r - 0.98)) * 0.25;
        gl_FragColor = vec4(uColor * 2.5, a * uStrength);
      }`,
  })
}

/** Vertical light beam: open cylinder fading upwards (use CylinderGeometry with openEnded). */
export function makeBeamMaterial(color: THREE.Color) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    side: THREE.DoubleSide,
    uniforms: { uTime: { value: 0 }, uColor: { value: color.clone() }, uStrength: { value: 1 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv; varying vec3 vN; varying vec3 vView;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal); vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uColor; uniform float uStrength; varying vec2 vUv; varying vec3 vN; varying vec3 vView;
      void main() {
        float edge = clamp(1.0 - abs(dot(normalize(vN), vView)), 0.0, 1.0);
        float fade = pow(clamp(1.0 - vUv.y, 0.0, 1.0), 1.6);
        float flicker = 0.85 + 0.15 * sin(uTime * 6.0 + vUv.y * 20.0);
        float a = fade * (0.25 + edge * 0.9) * flicker * uStrength;
        gl_FragColor = vec4(uColor * 2.2, a);
      }`,
  })
}

/** Vertical gradient sky dome. */
export function makeSkyMaterial(top: string, bottom: string) {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { uTop: { value: new THREE.Color(top) }, uBottom: { value: new THREE.Color(bottom) } },
    vertexShader: /* glsl */ `
      varying vec3 vPos;
      void main() { vPos = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uTop; uniform vec3 uBottom; varying vec3 vPos;
      void main() {
        float h = smoothstep(-0.2, 0.7, vPos.y);
        gl_FragColor = vec4(mix(uBottom, uTop, h), 1.0);
      }`,
  })
}
