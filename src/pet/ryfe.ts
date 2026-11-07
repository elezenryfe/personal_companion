/**
 * Ryfe — three small creatures, drawn entirely in code.
 *
 * The moth is the island's default: paper wings, an ink line, and antennae that
 * carry the state's light. The jelly is what the assistant tab shows: a pulsing
 * bell and four drifting arms. The tube is what the Gmail tab shows: a small
 * screen face with scanlines, an antenna light, and an LED. All three share the
 * same movement — eyes follow the cursor, the body breathes, alert bounces,
 * listening tilts, and a greeting is a quick flutter.
 *
 * Four states, each a whole mood rather than a colour swap:
 *   idle       pale lights, slow wing beats, breathing
 *   working    blue wing spots and lights, faster beats, a moving-dots badge
 *   alert      amber, eyes wide, bouncing, an exclamation badge
 *   listening  cyan, head tilted, eyes on whoever is typing
 */

import { clamp, lerp, TAU } from '../core/anim';

export type PetState = 'idle' | 'working' | 'alert' | 'listening';
export type PetForm = 'moth' | 'jelly' | 'tube';

type Rgb = [number, number, number];
type EyeShape = 'pill' | 'wide' | 'happy' | 'flat';
type Badge = 'dots' | 'bang' | null;

interface Spec {
  color: Rgb;
  tint: number;
  eye: EyeShape;
  badge: Badge;
  bounces: boolean;
  tilt: number;
}

const STATES: Record<PetState, Spec> = {
  idle: { color: [0.902, 0.914, 0.933], tint: 0, eye: 'pill', badge: null, bounces: false, tilt: 0 },
  working: { color: [0.231, 0.62, 1], tint: 0.7, eye: 'pill', badge: 'dots', bounces: false, tilt: 0 },
  alert: { color: [0.961, 0.647, 0.141], tint: 0.78, eye: 'wide', badge: 'bang', bounces: true, tilt: 0 },
  listening: { color: [0.133, 0.827, 0.933], tint: 0.72, eye: 'pill', badge: null, bounces: false, tilt: 0.15 },
};

const INK = '#111820';
const PAPER_TOP: Rgb = [0.949, 0.937, 0.902];
const PAPER_BOTTOM: Rgb = [0.831, 0.816, 0.776];
const CHALK_TOP: Rgb = [0.937, 0.953, 0.965];
const CHALK_BOTTOM: Rgb = [0.796, 0.827, 0.855];
const SLATE_TOP: Rgb = [0.29, 0.32, 0.36];
const SLATE_BOTTOM: Rgb = [0.13, 0.15, 0.17];

const now = () => performance.now() / 1000;

const rgba = (c: Rgb, a = 1) =>
  `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
];

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = clamp(r, 0, Math.min(w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function fillGrad(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  top: Rgb,
  bottom: Rgb,
): CanvasGradient {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  g.addColorStop(0, rgba(top));
  g.addColorStop(1, rgba(bottom));
  return g;
}

function drawEyeShape(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  shape: EyeShape,
  open: number,
) {
  switch (shape) {
    case 'wide':
      drawEyeShape(ctx, w * 1.14, h * 1.1, 'pill', open);
      break;
    case 'pill': {
      const hh = Math.max(h * open, w * 0.3);
      roundedRect(ctx, -w / 2, -hh / 2, w, hh, Math.min(w / 2, hh / 2));
      ctx.fill();
      break;
    }
    case 'happy':
      ctx.lineWidth = w * 0.42;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(0, h * 0.15, w * 0.7, Math.PI * 1.1, Math.PI * 1.9);
      ctx.stroke();
      break;
    case 'flat':
      roundedRect(ctx, -w * 0.7, -w * 0.18, w * 1.4, w * 0.36, w * 0.18);
      ctx.fill();
      break;
  }
}

function drawEyes(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  gap: number,
  w: number,
  h: number,
  shape: EyeShape,
  open: number,
  lookX: number,
  lookY: number,
  color: string,
) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  for (const sd of [-1, 1]) {
    ctx.save();
    ctx.translate(cx + sd * gap + lookX * gap * 0.45, cy - lookY * h * 0.65);
    drawEyeShape(ctx, w, h, shape, open);
    ctx.restore();
  }
  ctx.restore();
}

/** One side of the moth, mirrored by the caller. */
function mothWingPath(R: number, upper: boolean): Path2D {
  const p = new Path2D();
  if (upper) {
    p.moveTo(0.08 * R, -0.28 * R);
    p.bezierCurveTo(0.45 * R, -0.78 * R, 1.0 * R, -0.72 * R, 1.1 * R, -0.26 * R);
    p.bezierCurveTo(1.18 * R, 0.08 * R, 0.72 * R, 0.3 * R, 0.18 * R, 0.2 * R);
  } else {
    p.moveTo(0.1 * R, 0.18 * R);
    p.bezierCurveTo(0.5 * R, 0.32 * R, 0.95 * R, 0.55 * R, 0.98 * R, 0.84 * R);
    p.bezierCurveTo(0.68 * R, 0.98 * R, 0.28 * R, 0.76 * R, 0.1 * R, 0.48 * R);
  }
  p.closePath();
  return p;
}

export class PetEngine {
  private state: PetState = 'idle';
  private spec: Spec = STATES.idle;
  private form: PetForm = 'moth';

  private col: Rgb = [...STATES.idle.color] as Rgb;
  private colT: Rgb = [...STATES.idle.color] as Rgb;
  private tint = 0;
  private tintT = 0;

  private open = 1;
  private blinkStart = -10;
  private nextBlink = 1 + Math.random() * 2;

  private lookX = 0;
  private lookY = 0;
  private lookTX = 0;
  private lookTY = 0;

  private tilt = 0;
  private oy = 0;
  private sx = 1;
  private sy = 1;

  private badge: Badge = null;
  private badgeS = 1;

  private greetStart = -10;
  private phase = 0;
  private t0 = now() - Math.random() * 4;

  /** Which body to draw. The assistant tab uses the jelly, Gmail the tube. */
  setForm(form: PetForm) {
    this.form = form;
  }

  setState(next: PetState) {
    if (next === this.state) return;
    const prev = this.state;
    this.state = next;
    this.spec = STATES[next];
    this.colT = [...this.spec.color] as Rgb;
    this.tintT = this.spec.tint;
    this.badge = this.spec.badge;
    this.badgeS = 0;
    if (next === 'alert') this.oy = -0.14;
    if (prev !== 'idle' || next !== 'idle') this.blinkStart = now();
  }

  /** Cursor position relative to the canvas centre, in pixels. */
  look(dx: number, dy: number) {
    this.lookTX = Math.tanh(dx / 260);
    this.lookTY = -Math.tanh(dy / 200);
  }

  /** Flutters hello — used once, when the island first appears. */
  greet() {
    this.greetStart = now();
    this.blinkStart = -10;
  }

  private get greetK() {
    return clamp((now() - this.greetStart) / 1.7, 0, 1);
  }

  private eyeShape(): EyeShape {
    const g = this.greetK;
    return g > 0 && g < 1 ? 'happy' : this.spec.eye;
  }

  update(dt: number) {
    const t = now();
    const pace =
      this.state === 'working' ? 1.7 : this.state === 'alert' ? 2.4 : this.state === 'listening' ? 0.8 : 1;
    this.phase = t - this.t0;

    if (t > this.nextBlink) {
      this.blinkStart = t;
      this.nextBlink = t + 2.2 + Math.random() * 3.2;
      if (Math.random() < 0.22) this.nextBlink = t + 0.55;
    }
    const bp = (t - this.blinkStart) / 0.22;
    this.open =
      bp >= 0 && bp <= 1
        ? bp < 0.35
          ? lerp(1, 0.06, bp / 0.35)
          : lerp(0.06, 1, (bp - 0.35) / 0.65)
        : 1;

    const kLook = 1 - Math.pow(0.0025, dt);
    this.lookX += (this.lookTX - this.lookX) * kLook;
    this.lookY += (this.lookTY - this.lookY) * kLook;

    const g = this.greetK;
    const greetTilt = g > 0 && g < 1 ? Math.sin(g * Math.PI) * 0.08 : 0;
    const targetTilt = this.spec.tilt + greetTilt + this.lookX * 0.05;
    this.tilt += (targetTilt - this.tilt) * (1 - Math.pow(0.004, dt));

    this.col = mix(this.col, this.colT, 1 - Math.pow(0.002, dt));
    this.tint += (this.tintT - this.tint) * (1 - Math.pow(0.004, dt));

    const bounce = this.spec.bounces ? -Math.abs(Math.sin(this.phase * 5.2)) * 0.07 : 0;
    const hop = g > 0 && g < 1 ? -Math.sin(g * Math.PI) * 0.09 : 0;
    this.oy += (bounce + hop - this.oy) * (1 - Math.pow(0.0008, dt));

    const breath = Math.sin(this.phase * 1.8 * pace) * 0.03;
    this.sx = 1 - breath * 0.55;
    this.sy = 1 + breath;

    this.badgeS += (1 - this.badgeS) * (1 - Math.pow(0.002, dt));
    if (this.badgeS > 0.99) this.badgeS = 1;
  }

  /** Draws into a canvas of `w`×`h` CSS pixels, bitmap already matched to it. */
  draw(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const R = w * 0.3;
    const cx = w / 2;
    const cy = h / 2 + this.oy * R + R * 0.06;

    ctx.save();
    ctx.translate(cx, cy);
    if (this.tilt) ctx.rotate(this.tilt);
    ctx.scale(this.sx, this.sy);
    if (this.form === 'jelly') this.renderJelly(ctx, R);
    else if (this.form === 'tube') this.renderTube(ctx, R);
    else this.renderMoth(ctx, R);
    ctx.restore();

    if (this.badge) this.drawBadge(ctx, R, w / 2 - R * 0.95, cy - R * 0.95, this.badge);
  }

  private renderMoth(ctx: CanvasRenderingContext2D, R: number) {
    const t = this.phase;
    const speed = this.state === 'working' ? 2.4 : this.state === 'alert' ? 3.4 : 1.6;
    const amp = this.state === 'alert' ? 0.3 : this.state === 'listening' ? 0.08 : 0.15;
    const g = this.greetK;
    const greetFlap = g > 0 && g < 1 ? Math.sin(t * 20) * 0.18 * Math.sin(g * Math.PI) : 0;
    const flap = Math.sin(t * speed) * amp + greetFlap;

    for (const sd of [-1, 1]) {
      ctx.save();
      ctx.scale(sd, 1);
      ctx.rotate(flap);
      for (const upper of [true, false]) {
        const wing = mothWingPath(R, upper);
        ctx.fillStyle = fillGrad(ctx, -0.2 * R, -0.7 * R, 0.9 * R, 0.8 * R, PAPER_TOP, PAPER_BOTTOM);
        ctx.fill(wing);
        if (this.tint > 0.01) {
          ctx.fillStyle = rgba(this.col, 0.32 * this.tint);
          ctx.fill(wing);
        }
        ctx.strokeStyle = INK;
        ctx.lineWidth = Math.max(1, R * 0.035);
        ctx.stroke(wing);

        ctx.strokeStyle = 'rgba(17,24,32,0.3)';
        ctx.lineWidth = Math.max(1, R * 0.014);
        ctx.beginPath();
        ctx.moveTo(0.16 * R, upper ? -0.18 * R : 0.44 * R);
        ctx.lineTo(upper ? 0.92 * R : 0.8 * R, upper ? -0.36 * R : 0.72 * R);
        ctx.stroke();

        const ex = upper ? 0.74 * R : 0.62 * R;
        const ey = upper ? -0.32 * R : 0.66 * R;
        const er = (upper ? 0.13 : 0.08) * R;
        ctx.beginPath();
        ctx.arc(ex, ey, er, 0, TAU);
        ctx.fillStyle = rgba(this.col, 0.45 + 0.35 * this.tint);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(ex, ey, er * 0.38, 0, TAU);
        ctx.fillStyle = rgba(PAPER_TOP);
        ctx.fill();
      }
      ctx.restore();
    }

    ctx.beginPath();
    ctx.ellipse(0, 0.12 * R, 0.26 * R, 0.55 * R, 0, 0, TAU);
    ctx.fillStyle = fillGrad(ctx, -0.3 * R, -0.4 * R, 0.3 * R, 0.7 * R, PAPER_TOP, PAPER_BOTTOM);
    ctx.fill();
    if (this.tint > 0.01) {
      ctx.fillStyle = rgba(this.col, 0.3 * this.tint);
      ctx.fill();
    }
    ctx.strokeStyle = INK;
    ctx.lineWidth = Math.max(1, R * 0.035);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(0, -0.55 * R, 0.36 * R, 0, TAU);
    ctx.fillStyle = fillGrad(ctx, -0.3 * R, -0.85 * R, 0.3 * R, -0.25 * R, PAPER_TOP, PAPER_BOTTOM);
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = Math.max(1, R * 0.035);
    ctx.stroke();

    for (const sd of [-1, 1]) {
      const tx = sd * 0.55 * R;
      const ty = -1.32 * R;
      ctx.beginPath();
      ctx.moveTo(sd * 0.12 * R, -0.82 * R);
      ctx.quadraticCurveTo(sd * 0.36 * R, -1.16 * R, tx, ty);
      ctx.strokeStyle = 'rgba(201,210,218,0.9)';
      ctx.lineWidth = Math.max(1, R * 0.03);
      ctx.lineCap = 'round';
      ctx.stroke();

      const pulse = 0.86 + 0.14 * Math.sin(t * (this.state === 'alert' ? 9 : 2.2));
      const halo = ctx.createRadialGradient(tx, ty, 0, tx, ty, R * 0.22 * pulse);
      halo.addColorStop(0, rgba(this.col, 0.55));
      halo.addColorStop(1, rgba(this.col, 0));
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(tx, ty, R * 0.22 * pulse, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(tx, ty, R * 0.07 * pulse, 0, TAU);
      ctx.fillStyle = rgba(this.col);
      ctx.fill();
    }

    drawEyes(
      ctx,
      0,
      -0.55 * R,
      0.16 * R,
      0.16 * R,
      0.18 * R,
      this.eyeShape(),
      this.open,
      this.lookX,
      this.lookY,
      INK,
    );
  }

  private renderJelly(ctx: CanvasRenderingContext2D, R: number) {
    const t = this.phase;
    const g = this.greetK;
    const pace = this.state === 'working' ? 2.4 : this.state === 'alert' ? 3.2 : 1;
    const beat =
      Math.sin(t * pace * 1.7) * 0.028 +
      (g > 0 && g < 1 ? Math.sin(g * Math.PI) * 0.05 : 0);
    const alertSquash = this.state === 'alert' ? Math.sin(t * 6) * 0.02 : 0;

    const glow = ctx.createRadialGradient(0, -0.15 * R, R * 0.1, 0, -0.15 * R, R * 1.15);
    glow.addColorStop(0, rgba(this.col, 0.16 + 0.3 * this.tint));
    glow.addColorStop(1, rgba(this.col, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, -0.15 * R, R * 1.15, 0, TAU);
    ctx.fill();

    ctx.save();
    ctx.scale(1 + beat + alertSquash, 1 - beat * 0.8 - alertSquash);

    for (let i = 0; i < 4; i++) {
      const bx = (-0.36 + i * 0.24) * R;
      const drift = Math.sin(t * 1.5 + i * 1.1) * R;
      const splay = g > 0 && g < 1 ? Math.sin(g * Math.PI) * 0.25 * R : 0;
      const len = (0.95 + (i % 2) * 0.18) * R;
      const grad = ctx.createLinearGradient(0, 0.1 * R, 0, 0.1 * R + len);
      grad.addColorStop(0, 'rgba(17,24,32,0.55)');
      grad.addColorStop(1, rgba(this.col, 0.95));
      ctx.beginPath();
      ctx.moveTo(bx, 0.08 * R);
      ctx.bezierCurveTo(
        bx + drift * 0.1 + splay * (i - 1.5),
        0.45 * R,
        bx - drift * 0.1 - splay * (i - 1.5),
        0.82 * R,
        bx + drift * 0.06 + splay * (i - 1.5),
        0.1 * R + len,
      );
      ctx.strokeStyle = grad;
      ctx.lineWidth = Math.max(1.2, R * 0.045);
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    const bell = new Path2D();
    bell.moveTo(-0.82 * R, 0.08 * R);
    bell.bezierCurveTo(-0.9 * R, -0.5 * R, -0.5 * R, -0.92 * R, 0, -0.92 * R);
    bell.bezierCurveTo(0.5 * R, -0.92 * R, 0.9 * R, -0.5 * R, 0.82 * R, 0.08 * R);
    bell.quadraticCurveTo(0.4 * R, 0.22 * R, 0, 0.12 * R);
    bell.quadraticCurveTo(-0.4 * R, 0.22 * R, -0.82 * R, 0.08 * R);
    bell.closePath();

    ctx.fillStyle = fillGrad(ctx, -0.6 * R, -0.9 * R, 0.6 * R, 0.2 * R, CHALK_TOP, CHALK_BOTTOM);
    ctx.fill(bell);
    if (this.tint > 0.01) {
      ctx.fillStyle = rgba(this.col, 0.3 * this.tint);
      ctx.fill(bell);
    }
    ctx.strokeStyle = INK;
    ctx.lineWidth = Math.max(1, R * 0.04);
    ctx.stroke(bell);

    ctx.save();
    ctx.clip(bell);
    const hl = ctx.createRadialGradient(-0.3 * R, -0.5 * R, 0, -0.3 * R, -0.5 * R, R * 0.55);
    hl.addColorStop(0, 'rgba(255,255,255,0.5)');
    hl.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hl;
    ctx.fillRect(-R, -R, 2 * R, 2 * R);
    ctx.restore();

    drawEyes(
      ctx,
      0,
      -0.3 * R,
      0.26 * R,
      0.18 * R,
      0.2 * R,
      this.eyeShape(),
      this.open,
      this.lookX,
      this.lookY,
      INK,
    );

    ctx.restore();
  }

  private renderTube(ctx: CanvasRenderingContext2D, R: number) {
    const t = this.phase;
    const g = this.greetK;

    ctx.rotate(this.state === 'alert' ? Math.sin(t * 26) * 0.012 : 0);

    // antenna
    const tx = 0.06 * R;
    const ty = -1.34 * R;
    ctx.beginPath();
    ctx.moveTo(0, -0.8 * R);
    ctx.quadraticCurveTo(0.02 * R, -1.1 * R, tx, ty);
    ctx.strokeStyle = 'rgba(201,210,218,0.9)';
    ctx.lineWidth = Math.max(1, R * 0.032);
    ctx.lineCap = 'round';
    ctx.stroke();

    const pulse =
      0.86 + 0.14 * Math.sin(t * (this.state === 'alert' ? 9 : this.state === 'working' ? 5 : 2.2));
    const halo = ctx.createRadialGradient(tx, ty, 0, tx, ty, R * 0.22 * pulse);
    halo.addColorStop(0, rgba(this.col, 0.5));
    halo.addColorStop(1, rgba(this.col, 0));
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(tx, ty, R * 0.22 * pulse, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(tx, ty, R * 0.07 * pulse, 0, TAU);
    ctx.fillStyle = rgba(this.col);
    ctx.fill();

    // bezel
    roundedRect(ctx, -0.92 * R, -0.8 * R, 1.84 * R, 1.6 * R, 0.24 * R);
    ctx.fillStyle = fillGrad(ctx, -0.6 * R, -0.8 * R, 0.6 * R, 0.8 * R, SLATE_TOP, SLATE_BOTTOM);
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = Math.max(1, R * 0.045);
    ctx.stroke();

    // screen
    const sw = 0.74 * R;
    const sh = 0.6 * R;
    roundedRect(ctx, -sw, -sh, sw * 2, sh * 2, 0.16 * R);
    ctx.fillStyle = fillGrad(ctx, -sw, -sh, sw, sh, CHALK_TOP, CHALK_BOTTOM);
    ctx.fill();

    ctx.save();
    roundedRect(ctx, -sw, -sh, sw * 2, sh * 2, 0.16 * R);
    ctx.clip();

    if (this.tint > 0.01) {
      ctx.fillStyle = rgba(this.col, 0.34 * this.tint);
      ctx.fillRect(-sw, -sh, sw * 2, sh * 2);
    }
    if (this.state === 'alert') {
      ctx.fillStyle = `rgba(255,255,255,${0.05 + 0.05 * Math.sin(t * 18)})`;
      ctx.fillRect(-sw, -sh, sw * 2, sh * 2);
    }

    // scanlines, drifting
    const off = (t * 0.06) % (R * 0.09);
    ctx.strokeStyle = 'rgba(17,24,32,0.09)';
    ctx.lineWidth = 1;
    for (let y = -sh + off; y < sh; y += R * 0.09) {
      ctx.beginPath();
      ctx.moveTo(-sw, y);
      ctx.lineTo(sw, y);
      ctx.stroke();
    }

    // working scan bar
    if (this.state === 'working') {
      const by = -sh + ((t * 0.55) % 1) * sh * 2;
      ctx.fillStyle = rgba(this.col, 0.2);
      ctx.fillRect(-sw, by, sw * 2, R * 0.1);
    }

    if (g > 0 && g < 1) {
      ctx.strokeStyle = INK;
      ctx.lineWidth = Math.max(1, R * 0.035);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(0, 0.18 * R, 0.16 * R, 0.2, Math.PI - 0.2);
      ctx.stroke();
    }
    ctx.restore();

    drawEyes(
      ctx,
      0,
      -0.03 * R,
      0.3 * R,
      0.2 * R,
      0.27 * R,
      this.eyeShape(),
      this.open,
      this.lookX,
      this.lookY,
      INK,
    );

    // LED
    ctx.beginPath();
    ctx.arc(0.74 * R, 0.68 * R, 0.055 * R, 0, TAU);
    ctx.fillStyle = rgba(this.col, 0.9);
    ctx.fill();
  }

  private drawBadge(
    ctx: CanvasRenderingContext2D,
    R: number,
    x: number,
    y: number,
    kind: Exclude<Badge, null>,
  ) {
    const t = now();
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(this.badgeS, this.badgeS);
    const col = rgba(this.spec.color);

    if (kind === 'dots') {
      roundedRect(ctx, -R * 0.32, -R * 0.16, R * 0.64, R * 0.32, R * 0.16);
      ctx.fillStyle = col;
      ctx.fill();
      for (let i = 0; i < 3; i++) {
        const phase = (((t * 2.4 - i * 0.22) % 1) + 1) % 1;
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc((i - 1) * R * 0.16, 0, R * 0.05 * (1 + 0.4 * Math.max(0, Math.sin(phase * TAU))), 0, TAU);
        ctx.fill();
      }
    } else {
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.3, 0, TAU);
      ctx.fill();
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.22, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = `900 ${R * 0.3}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('!', 0, R * 0.015);
    }
    ctx.restore();
  }
}
