// Reusable ad effects. Each one is driven by props (times in composition frames, positions
// in composition pixels) so a storyboard can place it on real cues from a capture.
// See effects.catalog.json for what each effect is for and its recommended settings.
import {AbsoluteFill, Img, interpolate, random, spring, useCurrentFrame, useVideoConfig} from 'remotion';

const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'};
const hexToRgb = (hex) => {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value.slice(0, 6);
  const number = parseInt(full, 16);
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
};
export const alpha = (hex, a) => {
  if (!hex?.startsWith('#')) return hex;
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
};
const pop = (frame, fps, at, config = {damping: 14, stiffness: 160, mass: 0.9}) =>
  spring({frame: frame - at, fps, config});

/** Layered, tinted shadow: contact + mid + ambient. Reads as real depth rather than a gray smudge. */
export function depthShadow(tint = '#1d1b29', depth = 1) {
  return [
    `0 ${1 * depth}px ${2 * depth}px ${alpha(tint, 0.08)}`,
    `0 ${8 * depth}px ${18 * depth}px ${alpha(tint, 0.10)}`,
    `0 ${28 * depth}px ${60 * depth}px ${alpha(tint, 0.18)}`,
    `0 ${60 * depth}px ${120 * depth}px ${alpha(tint, 0.16)}`,
  ].join(', ');
}

/** Soft animated gradient field in brand colors, with a gentle vignette. */
export function BrandBackdrop({brand, intensity = 1}) {
  const frame = useCurrentFrame();
  const drift = (seed, range) => Math.sin(frame / 70 + seed) * range;
  const blobs = [
    {color: brand.primary, x: 18 + drift(0, 8), y: 12 + drift(1, 5), size: 70, a: 0.30},
    {color: brand.accent, x: 88 + drift(2, 6), y: 34 + drift(3, 6), size: 55, a: 0.24},
    {color: brand.primary, x: 72 + drift(4, 7), y: 92 + drift(5, 5), size: 75, a: 0.22},
    {color: brand.accent, x: 8 + drift(6, 6), y: 78 + drift(7, 5), size: 45, a: 0.14},
  ];
  return (
    <AbsoluteFill style={{
      backgroundColor: brand.background,
      backgroundImage: blobs.map(({color, x, y, size, a}) =>
        `radial-gradient(circle at ${x}% ${y}%, ${alpha(color, a * intensity)} 0%, transparent ${size}%)`).join(', '),
    }}>
      <AbsoluteFill style={{background: `radial-gradient(ellipse at 50% 45%, transparent 55%, ${alpha(brand.deep, 0.10)} 100%)`}} />
    </AbsoluteFill>
  );
}

/** Very light film grain so flat gradients don't band and the frame feels filmed. */
export function Grain({opacity = 0.05}) {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{opacity, mixBlendMode: 'multiply', pointerEvents: 'none'}}>
      <svg width="100%" height="100%">
        <filter id="vm-grain">
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed={frame % 12} stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter="url(#vm-grain)" />
      </svg>
    </AbsoluteFill>
  );
}

/**
 * Show one region of a captured frame. `box` is in CSS pixels of the capture viewport;
 * `scale` maps CSS pixels to composition pixels. Works with 2x frames for sharp close-ups.
 */
export function Crop({src, box, viewport, scale, radius = 0, style}) {
  return (
    <div style={{width: box.width * scale, height: box.height * scale, overflow: 'hidden', borderRadius: radius,
      position: 'relative', ...style}}>
      <Img src={src} style={{position: 'absolute', width: viewport.width * scale, height: viewport.height * scale,
        left: -box.x * scale, top: -box.y * scale, maxWidth: 'none'}} />
    </div>
  );
}

/**
 * The product UI as a floating card: rounded corners, layered tinted shadow, and an entrance
 * that tilts up out of perspective. Children render inside (the captured screen).
 */
export function FloatingCard({x, y, width, height, enterAt = 0, exitAt, radius = 28, brand, children, style}) {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const enter = pop(frame, fps, enterAt, {damping: 18, stiffness: 90, mass: 1});
  const exit = exitAt === undefined ? 0 : pop(frame, fps, exitAt, {damping: 20, stiffness: 110});
  const tilt = (1 - enter) * 16 + exit * -10;
  return (
    <div style={{position: 'absolute', left: x, top: y, width, height, perspective: 2200, ...style}}>
      <div style={{
        width: '100%', height: '100%', borderRadius: radius, overflow: 'hidden', position: 'relative',
        background: brand.surface, boxShadow: depthShadow(brand.deep, 1.1),
        outline: `1px solid ${alpha(brand.deep, 0.08)}`,
        transform: `translateY(${(1 - enter) * 420 + exit * -260}px) rotateX(${tilt}deg) scale(${0.9 + 0.1 * enter - exit * 0.08})`,
        opacity: Math.min(1, enter * 1.4) * (1 - exit),
        transformOrigin: '50% 100%',
      }}>
        {children}
      </div>
    </div>
  );
}

/**
 * Lift a region of the UI out of the screen toward the camera: it travels from `from` to `to`
 * rectangles (composition px), gains a deeper shadow, and settles back at `returnAt`.
 */
export function Lift({src, box, viewport, from, to, at, returnAt, radius = 18, brand, shimmerAt, children}) {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  if (frame < at || (returnAt !== undefined && frame > returnAt + 24)) return null;
  const up = pop(frame, fps, at, {damping: 16, stiffness: 120, mass: 0.9});
  const down = returnAt === undefined ? 0 : pop(frame, fps, returnAt, {damping: 20, stiffness: 170});
  const p = Math.max(0, up - down);
  const rect = {
    x: interpolate(p, [0, 1], [from.x, to.x]), y: interpolate(p, [0, 1], [from.y, to.y]),
    width: interpolate(p, [0, 1], [from.width, to.width]),
  };
  const scale = rect.width / box.width;
  return (
    <div style={{position: 'absolute', left: rect.x, top: rect.y, borderRadius: radius,
      boxShadow: depthShadow(brand.deep, 0.3 + 1.2 * p), transform: `rotateZ(${(1 - p) * 0}deg)`}}>
      <Crop src={src} box={box} viewport={viewport} scale={scale} radius={radius} />
      {shimmerAt !== undefined ? <ShimmerSweep at={shimmerAt} radius={radius} /> : null}
      {children}
    </div>
  );
}

/** One diagonal band of light across the parent. Use once per reveal; more reads as cheap. */
export function ShimmerSweep({at, duration = 26, radius = 0, strength = 0.55}) {
  const frame = useCurrentFrame();
  const t = interpolate(frame, [at, at + duration], [-0.4, 1.4], clamp);
  if (frame < at || frame > at + duration) return null;
  return (
    <div style={{position: 'absolute', inset: 0, borderRadius: radius, overflow: 'hidden', pointerEvents: 'none'}}>
      <div style={{position: 'absolute', top: '-50%', bottom: '-50%', width: '35%', left: `${t * 100}%`,
        transform: 'rotate(18deg)', mixBlendMode: 'soft-light',
        background: `linear-gradient(90deg, transparent, rgba(255,255,255,${strength}), transparent)`}} />
    </div>
  );
}

/** Logo on a white badge that pops with a slight overshoot and a soft brand-colored halo. */
export function LogoPop({src, box, viewport, at, x, y, scale, brand, halo = true, padding = 22}) {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const p = pop(frame, fps, at, {damping: 9, stiffness: 140, mass: 0.8});
  const w = box.width * scale + padding * 2;
  const h = box.height * scale + padding * 2;
  const breathe = 1 + Math.sin((frame - at) / 18) * 0.012;
  return (
    <div style={{position: 'absolute', left: x - w / 2, top: y - h / 2, width: w, height: h,
      transform: `scale(${p * breathe})`, opacity: Math.min(1, p * 2)}}>
      {halo ? <div style={{position: 'absolute', inset: -h * 0.9, borderRadius: '50%', filter: 'blur(30px)',
        background: `radial-gradient(circle, ${alpha(brand.primary, 0.35)}, ${alpha(brand.accent, 0.12)} 45%, transparent 70%)`}} /> : null}
      <div style={{position: 'absolute', inset: 0, borderRadius: h * 0.32, background: '#fff',
        boxShadow: depthShadow(brand.deep, 0.9), display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
        <Crop src={src} box={box} viewport={viewport} scale={scale} />
      </div>
    </div>
  );
}

const STAR = 'polygon(50% 0%, 61% 39%, 100% 50%, 61% 61%, 50% 100%, 39% 61%, 0% 50%, 39% 39%)';

/** A small, quick burst of four-point stars. Keep count low (6-10); it should accent a click, not decorate. */
export function SparkleBurst({x, y, at, colors, count = 8, radius = 110, size = 18, duration = 26, seed = 'burst'}) {
  const frame = useCurrentFrame();
  const t = (frame - at) / duration;
  if (t < 0 || t > 1) return null;
  return (
    <div style={{position: 'absolute', left: x, top: y, pointerEvents: 'none'}}>
      {Array.from({length: count}, (_, i) => {
        const angle = (i / count) * Math.PI * 2 + random(`${seed}-a-${i}`) * 0.6;
        const distance = radius * (0.55 + 0.45 * random(`${seed}-d-${i}`)) * (1 - (1 - t) ** 3);
        const s = size * (0.6 + 0.6 * random(`${seed}-s-${i}`)) * Math.sin(Math.PI * Math.min(1, t * 1.2));
        return (
          <div key={i} style={{position: 'absolute', width: s, height: s,
            left: Math.cos(angle) * distance - s / 2, top: Math.sin(angle) * distance - s / 2,
            background: colors[i % colors.length], clipPath: STAR, transform: `rotate(${t * 90}deg)`,
            filter: `drop-shadow(0 0 6px ${alpha(colors[i % colors.length], 0.7)})`}} />
        );
      })}
      <div style={{position: 'absolute', width: 120, height: 120, left: -60, top: -60, borderRadius: '50%',
        background: `radial-gradient(circle, rgba(255,255,255,${0.85 * (1 - t)}), transparent 65%)`}} />
    </div>
  );
}

/** A glow ring that blooms around a rectangle (composition px) to draw the eye. */
export function GlowPulse({rect, at, color, radius = 12, duration = 30, spread = 18}) {
  const frame = useCurrentFrame();
  const t = (frame - at) / duration;
  if (t < 0 || t > 1) return null;
  const strength = Math.sin(Math.PI * t);
  return (
    <div style={{position: 'absolute', left: rect.x, top: rect.y, width: rect.width, height: rect.height,
      borderRadius: radius, pointerEvents: 'none',
      boxShadow: `0 0 0 ${2 + t * 6}px ${alpha(color, 0.55 * strength)}, 0 0 ${spread * 2}px ${spread * 0.6}px ${alpha(color, 0.45 * strength)}`}} />
  );
}

/**
 * Words rise in with a blur-to-sharp stagger, and leave upward. Wrap words in *asterisks*
 * to paint them with the brand gradient.
 */
export function KineticCaption({text, at, out, x = 540, y, width = 940, size = 76, brand, align = 'center', weight = 800}) {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  if (frame < at || (out !== undefined && frame > out + 14)) return null;
  const leave = out === undefined ? 0 : interpolate(frame, [out, out + 12], [0, 1], clamp);
  const words = text.split(/\s+/);
  return (
    <div style={{position: 'absolute', left: x - width / 2, top: y, width, textAlign: align,
      fontFamily: '"Inter", "SF Pro Display", -apple-system, system-ui, sans-serif', fontWeight: weight,
      fontSize: size, lineHeight: 1.08, letterSpacing: -size * 0.03, color: brand.ink,
      opacity: 1 - leave, transform: `translateY(${-leave * 40}px)`}}>
      {words.map((raw, i) => {
        const emphasis = /^\*.*\*[.,!?]?$/.test(raw);
        const word = raw.replace(/\*/g, '');
        const p = pop(frame, fps, at + i * 3, {damping: 15, stiffness: 150});
        return (
          <span key={i} style={{display: 'inline-block', marginRight: size * 0.24, opacity: p,
            transform: `translateY(${(1 - p) * size * 0.5}px)`, filter: `blur(${(1 - p) * 10}px)`,
            ...(emphasis ? {backgroundImage: `linear-gradient(100deg, ${brand.primary}, ${brand.accent})`,
              WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent', paddingBottom: '0.08em'} : {})}}>
            {word}
          </span>
        );
      })}
    </div>
  );
}

/** Call-to-action pill: pops in, then one light sweep across it. */
export function CTAButton({text, at, x, y, brand, size = 44}) {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const p = pop(frame, fps, at, {damping: 11, stiffness: 150});
  return (
    <div style={{position: 'absolute', left: x, top: y, transform: `translate(-50%, -50%) scale(${p})`}}>
      <div style={{position: 'relative', padding: `${size * 0.55}px ${size * 1.2}px`, borderRadius: 999,
        background: `linear-gradient(100deg, ${brand.primary}, ${alpha(brand.primary, 0.85)})`, color: '#fff',
        fontFamily: '"Inter", "SF Pro Display", -apple-system, system-ui, sans-serif', fontWeight: 700,
        fontSize: size, whiteSpace: 'nowrap', boxShadow: `${depthShadow(brand.deep, 0.8)}, 0 10px 40px ${alpha(brand.primary, 0.45)}`,
        overflow: 'hidden'}}>
        {text}
        <ShimmerSweep at={at + 14} duration={30} strength={0.7} radius={999} />
      </div>
    </div>
  );
}
