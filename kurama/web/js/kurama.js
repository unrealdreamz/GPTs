// Kurama's character controller: blends the Blender clips (base loops + one-shot gestures)
// and layers procedural motion on top — lip-sync jaw, blinks, eye/head tracking,
// emotion-driven lids/ears and a chakra flare.
import * as THREE from 'three';

const X = new THREE.Vector3(1, 0, 0);   // armature axes (three model space: Y up, fox faces +Z)
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

const LOOPS = ['Idle', 'Talk', 'Angry', 'Sleep'];
const GESTURES = {
  laugh: 'Laugh', roar: 'Roar', nod: 'Nod', headshake: 'HeadShake', lean_in: 'LeanIn',
  look_away: 'LookAway', tail_lash: 'TailLash', grin: 'Grin', sigh: 'Sigh', wake: 'Wake',
};

// how each emotion shapes the face (glare narrows the lids, ears back = hostile)
const EMOTION = {
  neutral:    { glare: 0.35, ears: 0.1, chakra: 0.35, jaw: 1.0 },
  amused:     { glare: 0.6, ears: 0.0, chakra: 0.4, jaw: 1.1 },
  smug:       { glare: 0.9, ears: 0.05, chakra: 0.4, jaw: 0.9 },
  annoyed:    { glare: 0.8, ears: 0.45, chakra: 0.55, jaw: 0.9 },
  angry:      { glare: 1.1, ears: 0.85, chakra: 0.85, jaw: 1.25 },
  furious:    { glare: 1.2, ears: 1.0, chakra: 1.0, jaw: 1.45 },
  sad:        { glare: 0.2, ears: -0.2, chakra: 0.2, jaw: 0.8, droop: 0.6 },
  caring:     { glare: 0.15, ears: -0.1, chakra: 0.3, jaw: 0.85 },
  surprised:  { glare: -0.4, ears: -0.35, chakra: 0.5, jaw: 1.2 },
  thoughtful: { glare: 0.5, ears: 0.1, chakra: 0.3, jaw: 0.8 },
  sleepy:     { glare: 0.2, ears: 0.2, chakra: 0.15, jaw: 0.7, drowsy: 0.55, droop: 0.4 },
};

const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

export class Kurama {
  constructor(stage) {
    this.stage = stage;
    this.root = stage.fox;
    this.mixer = new THREE.AnimationMixer(this.root);
    this.clips = Object.fromEntries(stage.foxGltf.animations.map((c) => [c.name, c]));
    this.bones = {};
    this.root.traverse((o) => { if (o.isBone) this.bones[o.name] = o; });

    // rest orientation of every bone in armature (model) space + bind local pose
    this.root.updateMatrixWorld(true);
    const rootInv = this.root.getWorldQuaternion(new THREE.Quaternion()).invert();
    for (const b of Object.values(this.bones)) {
      b.userData.restArm = rootInv.clone().multiply(b.getWorldQuaternion(new THREE.Quaternion()));
      b.userData.restArmInv = b.userData.restArm.clone().invert();
      b.userData.bindLocal = b.quaternion.clone();
    }
    this.procBones = ['jaw', 'lid_L', 'lid_R', 'eye_L', 'eye_R', 'ear_L', 'ear_R', 'head', 'neck']
      .map((n) => this.bones[n]).filter(Boolean);

    // base loops always run; their weights are blended by hand
    this.loops = {};
    for (const name of LOOPS) {
      if (!this.clips[name]) continue;
      const a = this.mixer.clipAction(this.clips[name]);
      a.setEffectiveWeight(0);
      a.play();
      this.loops[name] = { action: a, weight: 0, target: 0 };
    }
    this.base = 'Sleep';
    this.loops.Sleep.weight = this.loops.Sleep.target = 1;
    this.loops.Sleep.action.setEffectiveWeight(1);

    this.gesture = null;          // { action, t, dur }
    this.emotion = 'neutral';
    this.face = { glare: 0.35, ears: 0.1, chakra: 0.35, jaw: 1, drowsy: 0, droop: 0 };
    this.mouth = 0;               // smoothed jaw opening 0..1
    this.mouthTarget = 0;
    this.blink = 0;               // 0 open .. 1 closed
    this.nextBlink = 2 + Math.random() * 3;
    this.blinkT = -1;
    this.lookYaw = 0; this.lookPitch = 0;
    this.saccade = new THREE.Vector2();
    this.nextSaccade = 1;
    this.earTwitch = 0;
    this.nextTwitch = 3;
    this.talkBob = 0;
    this.time = 0;
    this.asleep = true;
    this.chakra = 0.3;
    this.shake = 0;               // camera-shake request (roar), read by main
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._m = new THREE.Matrix4();
  }

  // ---- state -----------------------------------------------------------------

  setBase(name) {
    if (!this.loops[name]) return;
    this.base = name;
    for (const [n, l] of Object.entries(this.loops)) l.target = n === name ? 1 : 0;
  }

  setEmotion(emotion) {
    this.emotion = EMOTION[emotion] ? emotion : 'neutral';
  }

  /** Play a one-shot gesture clip; returns its duration in seconds (0 if unknown). */
  playGesture(gesture) {
    const clipName = GESTURES[gesture];
    const clip = clipName && this.clips[clipName];
    if (!clip) return 0;
    if (this.gesture) this.gesture.action.stop();
    const action = this.mixer.clipAction(clip);
    action.reset();
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.setEffectiveWeight(0);
    action.play();
    this.gesture = { action, t: 0, dur: clip.duration, name: clipName };
    if (clipName === 'Roar') this.shake = 1;
    return clip.duration;
  }

  sleep() {
    if (this.asleep) return;
    this.asleep = true;
    this.setBase('Sleep');
  }

  /** Wake up (opens one eye first). Resolves when he's awake. */
  wake() {
    if (!this.asleep) return Promise.resolve();
    this.asleep = false;
    // jump the base straight to Idle underneath the Wake clip so the blend is seamless
    for (const [n, l] of Object.entries(this.loops)) {
      l.target = n === 'Idle' ? 1 : 0;
    }
    this.base = 'Idle';
    const d = this.playGesture('wake');
    return new Promise((r) => setTimeout(r, Math.max(0, d * 1000 - 300)));
  }

  /** Lip-sync input: jaw opening target 0..1 (already shaped by the voice module). */
  setMouth(v) { this.mouthTarget = Math.max(0, Math.min(1.2, v)); }

  // ---- per frame -------------------------------------------------------------

  update(dt, camera) {
    this.time += dt;
    const t = this.time;

    // 1) blend weights for loops + gesture
    let gw = 0;
    if (this.gesture) {
      const g = this.gesture;
      g.t += dt;
      const fadeIn = Math.min(1, g.t / 0.25);
      const fadeOut = Math.min(1, Math.max(0, (g.dur - g.t) / 0.4));
      gw = Math.min(fadeIn, fadeOut);
      g.action.setEffectiveWeight(gw);
      if (g.t >= g.dur) {
        g.action.stop();
        this.gesture = null;
        gw = 0;
      }
    }
    for (const l of Object.values(this.loops)) {
      l.weight = damp(l.weight, l.target, 3.2, dt);
      l.action.setEffectiveWeight(l.weight * (1 - 0.92 * gw) + 1e-4);
    }

    // 2) reset procedurally driven bones to bind pose, then sample clips
    for (const b of this.procBones) b.quaternion.copy(b.userData.bindLocal);
    this.mixer.update(dt);

    // 3) emotion-driven face parameters (smoothed)
    const e = EMOTION[this.emotion] || EMOTION.neutral;
    for (const k of ['glare', 'ears', 'chakra', 'jaw']) this.face[k] = damp(this.face[k], e[k], 2.5, dt);
    this.face.drowsy = damp(this.face.drowsy, e.drowsy || 0, 2, dt);
    this.face.droop = damp(this.face.droop, e.droop || 0, 2, dt);

    // 4) blinking (not while asleep: the Sleep clip keeps the lids shut)
    this.nextBlink -= dt;
    if (this.nextBlink <= 0 && this.blinkT < 0 && !this.asleep) {
      this.blinkT = 0;
      this.nextBlink = 2.2 + Math.random() * 4.5;
      if (Math.random() < 0.15) this.nextBlink = 0.25; // occasional double blink
    }
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const bt = this.blinkT / 0.16;
      this.blink = bt < 1 ? Math.sin(Math.min(1, bt) * Math.PI) : 0;
      if (bt >= 1) { this.blinkT = -1; this.blink = 0; }
    }

    // 5) lip-sync jaw (critically damped toward the target)
    const rate = this.mouthTarget > this.mouth ? 28 : 16;
    this.mouth = damp(this.mouth, this.mouthTarget, rate, dt);
    const speaking = this.mouthTarget > 0.02 || this.mouth > 0.02;
    this.talkBob = damp(this.talkBob, this.mouthTarget, 6, dt);

    this.root.updateMatrixWorld(true);

    // 6) look at the host (camera): eyes fully, head/neck partially
    const camLocal = this.root.worldToLocal(this._v.copy(camera.position));
    const head = this.bones.head;
    if (head) {
      // direction to camera expressed in the head's rest-aligned frame
      const headNow = this.root.getWorldQuaternion(this._q).invert()
        .multiply(head.getWorldQuaternion(new THREE.Quaternion()));
      const delta = headNow.multiply(head.userData.restArmInv);        // current rotation relative to rest
      const headPos = this.root.worldToLocal(head.getWorldPosition(new THREE.Vector3()));
      const dir = camLocal.clone().sub(headPos).applyQuaternion(delta.invert()).normalize();
      const yaw = Math.atan2(dir.x, dir.z);
      const pitch = Math.atan2(dir.y, Math.hypot(dir.x, dir.z));
      this.nextSaccade -= dt;
      if (this.nextSaccade <= 0) {
        this.nextSaccade = 0.6 + Math.random() * 2.2;
        this.saccade.set((Math.random() - 0.5) * 0.08, (Math.random() - 0.5) * 0.05);
      }
      const away = this.gesture?.name === 'LookAway' ? 0.25 : 1;
      this.lookYaw = damp(this.lookYaw, THREE.MathUtils.clamp(yaw * away, -0.5, 0.5), 5, dt);
      this.lookPitch = damp(this.lookPitch, THREE.MathUtils.clamp(pitch * away, -0.35, 0.35), 5, dt);
      const awake = this.asleep ? 0 : 1;
      this.addArm('neck', Y, this.lookYaw * 0.18 * awake);
      this.addArm('head', Y, this.lookYaw * 0.3 * awake);
      this.addArm('head', X, (-this.lookPitch * 0.25 - this.talkBob * 0.05 * Math.sin(t * 9)) * awake);
      for (const s of ['eye_L', 'eye_R']) {
        this.addArm(s, Y, THREE.MathUtils.clamp(this.lookYaw * 0.55 + this.saccade.x, -0.3, 0.3) * awake);
        this.addArm(s, X, THREE.MathUtils.clamp(-this.lookPitch * 0.5 + this.saccade.y, -0.2, 0.2) * awake);
      }
    }

    // 7) lids: blink + emotion glare + drowsiness (degrees match the Blender clips)
    const lidDeg = this.blink * 70 + this.face.glare * 12 + this.face.drowsy * 35;
    this.addArm('lid_L', X, THREE.MathUtils.degToRad(lidDeg));
    this.addArm('lid_R', X, THREE.MathUtils.degToRad(lidDeg));

    // 8) jaw: lip-sync on top of the clip (the grin / roar clips open it too)
    const jawDeg = this.mouth * 21 * this.face.jaw + (speaking ? 1.5 : 0);
    this.addArm('jaw', X, THREE.MathUtils.degToRad(Math.min(jawDeg, 34)));

    // 9) ears: emotion + random twitches
    this.nextTwitch -= dt;
    if (this.nextTwitch <= 0) { this.nextTwitch = 2 + Math.random() * 6; this.earTwitch = 1; }
    this.earTwitch = damp(this.earTwitch, 0, 7, dt);
    const earBack = THREE.MathUtils.degToRad(-26 * this.face.ears);
    this.addArm('ear_L', X, earBack + 0.2 * this.earTwitch * Math.sin(t * 40));
    this.addArm('ear_R', X, earBack);
    if (this.face.droop) {
      this.addArm('ear_L', Z, -0.45 * this.face.droop);
      this.addArm('ear_R', Z, 0.45 * this.face.droop);
    }

    // 10) chakra flare (rim light + motes), stronger in gestures like Roar
    const g = this.gesture?.name;
    const flare = g === 'Roar' ? 1.4 : g === 'TailLash' ? 0.9 : 0;
    this.chakra = damp(this.chakra, Math.max(this.face.chakra, flare) * (this.asleep ? 0.5 : 1), 2.5, dt);
    this.shake = damp(this.shake, 0, 1.2, dt);

    return { speaking, chakra: this.chakra, blink: this.blink, asleep: this.asleep };
  }

  /** Post-multiply a rotation about an armature-space axis (same semantics as the Blender build). */
  addArm(boneName, axis, angle) {
    const b = this.bones[boneName];
    if (!b || !angle) return;
    const q = this._q.setFromAxisAngle(axis, angle);
    const d = b.userData.restArmInv.clone().multiply(q).multiply(b.userData.restArm);
    b.quaternion.multiply(d);
  }

  eyeOpenness() {
    // how visible the eyes are, used to fade the glow sprites
    const lid = this.blink * 70 + this.face.glare * 12 + this.face.drowsy * 35;
    return Math.max(0, 1 - lid / 70) * (this.asleep && !this.gesture ? 0 : 1);
  }
}
