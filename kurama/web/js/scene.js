// Renderer, camera, lights and the mindscape set (cage, water, pipes, chakra motes).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OutlineEffect } from 'three/addons/effects/OutlineEffect.js';
import { Reflector } from 'three/addons/objects/Reflector.js';

export const PALETTE = {
  fog: 0x071113,
  bg: 0x040809,
  chakra: 0xff5a14,
};

/** 3-band gradient for the anime cel look. */
export function toonGradient(bands = [0.34, 0.68, 1.0]) {
  const data = new Uint8Array(bands.length * 4);
  bands.forEach((b, i) => data.set([b * 255, b * 255, b * 255, 255], i * 4));
  const tex = new THREE.DataTexture(data, bands.length, 1, THREE.RGBAFormat);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/**
 * MeshToonMaterial + fresnel rim ("chakra" edge light). The rim strength is shared
 * through `uniforms.rim` so the whole character can flare up when he's angry.
 */
export function rimToon(params, shared) {
  const m = new THREE.MeshToonMaterial(params);
  m.onBeforeCompile = (shader) => {
    shader.uniforms.rimColor = shared.rimColor;
    shader.uniforms.rimStrength = shared.rim;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 rimColor;\nuniform float rimStrength;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          vec3 vdir = normalize( vViewPosition );
          float fres = pow( 1.0 - clamp( dot( normal, vdir ), 0.0, 1.0 ), 3.2 );
          totalEmissiveRadiance += rimColor * fres * rimStrength;
        }`,
      );
  };
  m.customProgramCacheKey = () => 'rimToon';
  return m;
}

function sealTagTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 768;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, c.height);
  grad.addColorStop(0, '#f1e7cc');
  grad.addColorStop(1, '#ddcfa9');
  g.fillStyle = grad;
  g.fillRect(0, 0, c.width, c.height);
  // paper fibres
  for (let i = 0; i < 900; i++) {
    g.fillStyle = `rgba(120,90,50,${Math.random() * 0.05})`;
    g.fillRect(Math.random() * c.width, Math.random() * c.height, 1 + Math.random() * 2, 6 + Math.random() * 20);
  }
  g.strokeStyle = 'rgba(120,20,10,0.8)';
  g.lineWidth = 6;
  g.strokeRect(14, 14, c.width - 28, c.height - 28);
  g.lineWidth = 2;
  g.strokeRect(26, 26, c.width - 52, c.height - 52);
  g.fillStyle = '#a3140b';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = '900 170px "Yuji Syuku", "Noto Serif JP", "Hiragino Mincho ProN", "Yu Mincho", serif';
  g.fillText('封', c.width / 2, c.height * 0.42);
  g.font = '700 40px "Noto Serif JP", serif';
  g.fillStyle = 'rgba(30,20,20,0.85)';
  ['八', '卦', '封', '印'].forEach((ch, i) => g.fillText(ch, c.width / 2, c.height * 0.64 + i * 46));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.flipY = false;        // glTF UV convention
  return tex;
}

function waterShader() {
  return {
    name: 'MindscapeWater',
    uniforms: {
      color: { value: new THREE.Color(0x0b1a1c) },
      tDiffuse: { value: null },
      textureMatrix: { value: null },
      time: { value: 0 },
      glow: { value: 0.5 },
      ...THREE.UniformsLib.fog,
    },
    vertexShader: /* glsl */ `
      uniform mat4 textureMatrix;
      varying vec4 vUv;
      varying vec3 vWorld;
      #include <fog_pars_vertex>
      void main() {
        vUv = textureMatrix * vec4( position, 1.0 );
        vec4 wp = modelMatrix * vec4( position, 1.0 );
        vWorld = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 color;
      uniform sampler2D tDiffuse;
      uniform float time;
      uniform float glow;
      varying vec4 vUv;
      varying vec3 vWorld;
      #include <fog_pars_fragment>
      void main() {
        vec2 p = vWorld.xz;
        vec2 rip = vec2(
          sin( p.x * 1.7 + time * 0.9 ) + sin( p.y * 2.3 - time * 0.7 ) + 0.5 * sin( ( p.x + p.y ) * 4.1 + time * 1.6 ),
          cos( p.y * 1.5 + time * 0.8 ) + sin( ( p.x - p.y ) * 2.9 + time * 1.1 ) + 0.5 * cos( p.x * 5.3 - time * 1.9 )
        );
        vec4 uv = vUv;
        uv.xy += rip * 0.010 * uv.w;
        vec3 refl = texture2DProj( tDiffuse, uv ).rgb;
        // concentric ripple rings spreading from where the host stands
        float d = length( p - vec2( 0.0, 12.0 ) );
        float rings = smoothstep( 0.92, 1.0, sin( d * 3.0 - time * 1.4 ) ) * exp( -d * 0.18 ) * 0.25;
        vec3 col = mix( color, refl * 0.9, 0.62 ) + vec3( 0.25, 0.45, 0.45 ) * rings;
        // warm chakra glow pooled on the water near the cage
        float pool = exp( -length( p - vec2( 0.0, 2.5 ) ) * 0.28 );
        col += vec3( 1.0, 0.32, 0.06 ) * pool * glow * 0.10;
        gl_FragColor = vec4( col, 1.0 );
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  };
}

/** Rising chakra embers around the fox; `intensity` flares with anger. */
function chakraMotes(count = 520) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 2.2 + Math.random() * 7.5;
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = Math.random() * 10;
    pos[i * 3 + 2] = Math.sin(a) * r * 0.7 - 1.0;
    seed.set([Math.random(), Math.random(), 0.4 + Math.random() * 0.9, Math.random()], i * 4);
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('seed', new THREE.BufferAttribute(seed, 4));
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      intensity: { value: 0.4 },
      pixelRatio: { value: Math.min(devicePixelRatio, 2) },
      color: { value: new THREE.Color(PALETTE.chakra) },
    },
    vertexShader: /* glsl */ `
      attribute vec4 seed;
      uniform float time;
      uniform float intensity;
      uniform float pixelRatio;
      varying float vAlpha;
      void main() {
        float speed = seed.z * ( 0.35 + intensity * 0.9 );
        float h = mod( position.y + time * speed, 11.0 );
        vec3 p = position;
        p.y = h - 0.5;
        p.x += sin( time * 0.7 + seed.x * 30.0 + h * 0.6 ) * 0.35;
        p.z += cos( time * 0.5 + seed.y * 30.0 + h * 0.5 ) * 0.35;
        vec4 mv = modelViewMatrix * vec4( p, 1.0 );
        gl_Position = projectionMatrix * mv;
        float life = smoothstep( 0.0, 1.5, h ) * ( 1.0 - smoothstep( 7.0, 11.0, h ) );
        vAlpha = life * ( 0.25 + 0.75 * intensity ) * ( 0.5 + 0.5 * sin( time * 3.0 + seed.w * 40.0 ) );
        gl_PointSize = ( 1.5 + seed.w * 3.5 ) * ( 0.6 + intensity ) * pixelRatio * ( 22.0 / -mv.z );
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 color;
      varying float vAlpha;
      void main() {
        float d = length( gl_PointCoord - 0.5 );
        float a = smoothstep( 0.5, 0.0, d );
        gl_FragColor = vec4( color * ( 1.2 + a ), a * vAlpha );
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return pts;
}

/** Dim dust motes drifting in the corridor between the host and the cage. */
function dust(count = 260) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    pos.set([(Math.random() - 0.5) * 26, Math.random() * 12, 4 + Math.random() * 18], i * 3);
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    color: 0x9fd6d0, size: 0.05, transparent: true, opacity: 0.35, depthWrite: false,
    blending: THREE.AdditiveBlending, sizeAttenuation: true,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return pts;
}

function glowSprite(color, size) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  const mat = new THREE.SpriteMaterial({
    map: tex, color, transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.AdditiveBlending, toneMapped: false,
  });
  const s = new THREE.Sprite(mat);
  s.scale.setScalar(size);
  return s;
}

export async function createStage(canvas, onProgress = () => {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.bg);
  scene.fog = new THREE.FogExp2(PALETTE.fog, 0.03);

  const camera = new THREE.PerspectiveCamera(36, innerWidth / innerHeight, 0.1, 200);
  camera.position.set(0, 2.6, 15.5);

  const outline = new OutlineEffect(renderer, {
    defaultThickness: 0.0032,
    defaultColor: [0.03, 0.01, 0.01],
    defaultAlpha: 1,
    defaultKeepAlive: true,
  });

  // --- lights -------------------------------------------------------------
  const shared = {
    rim: { value: 0.35 },
    rimColor: { value: new THREE.Color(0xff5a1a) },
  };
  scene.add(new THREE.HemisphereLight(0x33494d, 0x050708, 0.6));
  const key = new THREE.DirectionalLight(0xffeee0, 2.3);          // key from upper-left, in front of the cage
  key.position.set(-7, 11, 13);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x6fb6c0, 0.45);        // cold bounce from the water
  fill.position.set(6, -2, 10);
  scene.add(fill);
  const back = new THREE.DirectionalLight(0xff4a12, 1.3);          // hellish back light for silhouettes
  back.position.set(-3, 8, -12);
  scene.add(back);
  const chakraLight = new THREE.PointLight(0xff5a14, 14, 22, 1.4); // chakra glow from behind/below the fox
  chakraLight.position.set(0, 1.2, -1.5);
  scene.add(chakraLight);
  const hostLight = new THREE.PointLight(0x7fc9c4, 6, 16, 1.8);    // cold light on the bars from the host side
  hostLight.position.set(3, 4, 11);
  scene.add(hostLight);

  const gradient = toonGradient();

  // --- load assets --------------------------------------------------------
  const loader = new GLTFLoader();
  const progress = { set: 0, fox: 0 };
  const report = () => onProgress((progress.set + progress.fox * 4) / 5);
  const load = (url, keyName) => new Promise((resolve, reject) => {
    loader.load(url, resolve, (e) => {
      if (e.total) { progress[keyName] = e.loaded / e.total; report(); }
    }, reject);
  });
  const [setGltf, foxGltf] = await Promise.all([
    load('assets/mindscape.glb', 'set'),
    load('assets/kurama.glb', 'fox'),
  ]);

  // --- set ------------------------------------------------------------------
  const set = setGltf.scene;
  const setParts = {};
  set.traverse((o) => { if (o.isMesh) setParts[o.name] = o; });
  const toonDark = (hex, rim = 0) => {
    const m = rimToon({ color: hex, gradientMap: gradient }, { rim: { value: rim }, rimColor: shared.rimColor });
    return m;
  };
  if (setParts.CageBars) {
    setParts.CageBars.material = toonDark(0x2e2522, 0.25);
    setParts.CageBars.material.userData.outlineParameters = { thickness: 0.0025, color: [0, 0, 0] };
  }
  if (setParts.Walls) {
    setParts.Walls.material = toonDark(0x1a2326);
    setParts.Walls.material.userData.outlineParameters = { visible: false };
  }
  if (setParts.Pipes) {
    setParts.Pipes.material = toonDark(0x31423f, 0.1);
    setParts.Pipes.material.userData.outlineParameters = { thickness: 0.002, color: [0, 0, 0] };
  }
  if (setParts.SealTag) {
    const tag = setParts.SealTag;
    tag.material = new THREE.MeshBasicMaterial({ map: sealTagTexture(), side: THREE.DoubleSide, color: 0xd9ccb0 });
    tag.material.userData.outlineParameters = { thickness: 0.0015, color: [0.1, 0.05, 0.03] };
    // fonts may arrive after first paint: redraw the kanji once they're ready
    document.fonts?.ready.then(() => { tag.material.map = sealTagTexture(); tag.material.needsUpdate = true; });
  }
  let water = null;
  if (setParts.Water) {
    const src = setParts.Water;
    src.visible = false;
    water = new Reflector(new THREE.PlaneGeometry(120, 120), {
      color: 0x0b1a1c,
      textureWidth: Math.floor(innerWidth * 0.5),
      textureHeight: Math.floor(innerHeight * 0.5),
      clipBias: 0.003,
      shader: waterShader(),
      multisample: 0,
    });
    water.material.fog = true;
    water.material.userData.outlineParameters = { visible: false };
    water.rotation.x = -Math.PI / 2;
    water.position.y = 0.0;
    scene.add(water);
  }
  scene.add(set);

  const motes = chakraMotes();
  scene.add(motes);
  const dustPts = dust();
  scene.add(dustPts);

  // --- fox materials ----------------------------------------------------------
  const fox = foxGltf.scene;
  const furMat = rimToon({ vertexColors: true, gradientMap: gradient, color: 0xffffff }, shared);
  furMat.userData.outlineParameters = { thickness: 0.0034, color: [0.04, 0.01, 0.0] };
  const teethMat = rimToon({ color: 0xf6eedc, gradientMap: gradient }, { rim: { value: 0.1 }, rimColor: shared.rimColor });
  teethMat.userData.outlineParameters = { thickness: 0.0014, color: [0.08, 0.03, 0.02] };
  const eyeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.13, 0.04), toneMapped: false });
  eyeMat.userData.outlineParameters = { visible: false };
  const pupilMat = new THREE.MeshBasicMaterial({ color: 0x050202 });
  pupilMat.userData.outlineParameters = { visible: false };
  fox.traverse((o) => {
    if (!o.isMesh) return;
    o.frustumCulled = false;       // skinned bounds are unreliable once the tails move
    const name = o.material?.name || '';
    if (name.startsWith('KuramaFur')) o.material = furMat;
    else if (name.startsWith('KuramaTeeth')) o.material = teethMat;
    else if (name.startsWith('KuramaEye')) o.material = eyeMat;
    else if (name.startsWith('KuramaPupil')) o.material = pupilMat;
  });
  scene.add(fox);

  // glowing eyes (sprites parented to the eye bones)
  const eyeGlows = [];
  fox.traverse((o) => {
    if (o.isBone && (o.name === 'eye_L' || o.name === 'eye_R')) {
      const s = glowSprite(0xff3a0c, 1.6);
      s.position.set(0, 0.12, 0);   // bone-local: slightly in front of the eye
      o.add(s);
      eyeGlows.push(s);
    }
  });

  // --- resize ---------------------------------------------------------------
  function resize() {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // keep Kurama framed on portrait screens
    camera.fov = w / h < 0.9 ? 52 : 36;
    camera.updateProjectionMatrix();
    if (water) water.getRenderTarget().setSize(Math.floor(w * 0.5), Math.floor(h * 0.5));
  }
  addEventListener('resize', resize);
  resize();

  return {
    THREE, renderer, scene, camera, outline, shared, fox, foxGltf, set, setParts,
    water, motes, dust: dustPts, chakraLight, back, key, eyeGlows, hostLight,
  };
}
