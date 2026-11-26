// Vertical short-form ad assembled from a filmed shoot plan (src/shoot.mjs) and a storyboard.
// Story: logo + hook headline → each shot on a floating card with its caption → one sparkle on
// the signature click → lift the payoff toward the viewer → end card with tagline and CTA.
// Everything is placed on cues from the take: shot markers, clicks, target and payoff anchors.
import {useMemo} from 'react';
import {AbsoluteFill, Easing, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {
  alpha, BrandBackdrop, Crop, CTAButton, depthShadow, FloatingCard, GlowPulse, Grain, KineticCaption, Lift, LogoPop,
  SparkleBurst,
} from './effects';
import {pointerAt, VirtualPointer} from './ProductDemo';

export const AD = {width: 1080, height: 1920, fps: 30, intro: 66, outro: 96};
const CARD = {width: 984, height: 680, x: 48, y: 600, radius: 30};
const LEAD_IN_MS = 150;
const ease = Easing.inOut(Easing.cubic);
const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'};
const mix = (a, b, t) => a + (b - a) * t;

/** Read shots, segments and anchors from a prepared take. Shared with calculateMetadata. */
export function parseTake(plan) {
  const markers = new Map();
  for (const cue of plan.cues) if (cue.kind === 'marker' && !markers.has(cue.label)) markers.set(cue.label, cue.atMs);
  const anchorCues = plan.cues.filter(({kind}) => kind === 'anchor');
  const anchor = (label) => anchorCues.findLast((cue) => cue.label === label);
  const clicks = plan.cues.filter(({kind, action}) => kind === 'pointer' && action === 'down');
  const shots = [];
  for (let i = 0; markers.has(`shot:${i}:start`); i++) {
    const start = markers.get(`shot:${i}:start`);
    const end = markers.get(`shot:${i}:end`) ?? plan.cues.findLast(({kind}) => kind === 'end')?.atMs;
    const targets = anchorCues.filter(({label}) => label.startsWith(`shot:${i}:target:`));
    shots.push({
      index: i, start, end, payoff: markers.get(`shot:${i}:payoff`) ?? end,
      targets,
      payoffAnchor: anchor(`shot:${i}:payoff`),
      clicks: clicks.filter(({atMs}) => atMs >= start && atMs <= end)
        .map((click) => ({...click, target: targets.findLast(({atMs}) => atMs <= click.atMs)})),
      segment: {from: Math.max(0, start - LEAD_IN_MS), to: end},
    });
  }
  let cursor = 0;
  for (const shot of shots) {
    shot.segment.bodyFrom = cursor;
    cursor += shot.segment.to - shot.segment.from;
  }
  return {shots, logo: anchor('logo'), bodyMs: cursor};
}

export function adTiming(plan) {
  const {bodyMs} = parseTake(plan);
  const bodyFrames = Math.round(bodyMs / 1000 * AD.fps);
  const outroStart = AD.intro + bodyFrames;
  return {bodyFrames, outroStart, durationInFrames: outroStart + AD.outro};
}

const union = (boxes) => {
  const real = boxes.filter(Boolean);
  if (!real.length) return null;
  const x = Math.min(...real.map((b) => b.x));
  const y = Math.min(...real.map((b) => b.y));
  return {x, y, width: Math.max(...real.map((b) => b.x + b.width)) - x, height: Math.max(...real.map((b) => b.y + b.height)) - y};
};
const centerOf = (box) => ({x: box.x + box.width / 2, y: box.y + box.height / 2});
const contentOf = (anchor) => anchor?.contentBox ?? anchor?.box;

function NameBadge({name, x, y, scale, brand}) {
  const size = 34 * scale;
  return (
    <div style={{position: 'absolute', left: x, top: y, transform: 'translate(-50%, -50%)', padding: `${size * 0.45}px ${size * 0.8}px`,
      borderRadius: size, background: '#fff', boxShadow: depthShadow(brand.deep, 0.9), fontWeight: 800, fontSize: size,
      fontFamily: '"Inter", "SF Pro Display", -apple-system, system-ui, sans-serif', color: brand.ink, whiteSpace: 'nowrap'}}>
      {name}
    </div>
  );
}

export function Ad({take, plan, brand, storyboard, cursorScale = 1.35}) {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const {shots, logo} = useMemo(() => parseTake(plan), [plan]);
  const timing = useMemo(() => adTiming(plan), [plan]);
  const viewport = {width: plan.width, height: plan.height};
  const kMin = Math.max(CARD.width / viewport.width, CARD.height / viewport.height);
  const boards = storyboard?.shots ?? [];

  // Ad frame <-> take time, skipping the gaps between shots.
  const shotAtFrame = (f) => {
    const bodyMs = (f - AD.intro) / fps * 1000;
    return shots.findLast((shot) => shot.segment.bodyFrom <= bodyMs) ?? shots[0];
  };
  const toMs = (f) => {
    const shot = shotAtFrame(f);
    const bodyMs = Math.max(0, (f - AD.intro) / fps * 1000);
    return Math.min(shot.segment.to, shot.segment.from + bodyMs - shot.segment.bodyFrom);
  };
  const toFrame = (shot, ms) => AD.intro + Math.round((shot.segment.bodyFrom + ms - shot.segment.from) / 1000 * fps);
  const sourceAt = (ms) => plan.timeline[Math.min(plan.timeline.length - 1, Math.max(0, Math.round(ms / (1000 / plan.fps))))];
  const srcAt = (ms) => staticFile(`${take}/${sourceAt(ms).file}`);

  // Camera keyframes per shot: establish the area of interest, push in on each click
  // (closest on the signature shot), then frame the payoff.
  const cameras = useMemo(() => shots.map((shot) => {
    const board = boards[shot.index] ?? {};
    const signature = board.emphasis === 'signature';
    const fit = (box, pad, max) => box ? Math.min(max, Math.max(kMin,
      Math.min(CARD.width / (box.width + pad), CARD.height / (box.height + pad)))) : kMin;
    const roi = union([...shot.targets.map(({box}) => box), contentOf(shot.payoffAnchor)]) ?? {x: 0, y: 0, ...viewport};
    const wide = {k: fit(roi, 160, 1.15), ...centerOf(roi)};
    const keys = [{ms: shot.segment.from, ...wide}];
    for (const click of shot.clicks) {
      if (!click.target) continue;
      const focus = {k: signature ? 1.75 : 1.4, ...centerOf(click.target.box)};
      keys.push({ms: click.atMs - 850, ...wide}, {ms: click.atMs - 220, ...focus}, {ms: click.atMs + 380, ...focus});
    }
    const payoffBox = contentOf(shot.payoffAnchor);
    const payoffView = payoffBox && !board.lift ? {k: fit(payoffBox, 140, 1.6), ...centerOf(payoffBox)} : wide;
    keys.push({ms: shot.payoff + 200, ...payoffView}, {ms: shot.end, ...payoffView});
    return keys.sort((a, b) => a.ms - b.ms);
  }), [shots, boards, kMin, viewport.width, viewport.height]);

  const cameraAt = (shot, ms) => {
    const keys = cameras[shot.index];
    const i = Math.max(0, keys.findLastIndex((key) => key.ms <= ms));
    const a = keys[i];
    const b = keys[i + 1] ?? a;
    const t = b.ms === a.ms ? 0 : ease(Math.min(1, Math.max(0, (ms - a.ms) / (b.ms - a.ms))));
    const scale = Math.max(kMin, mix(a.k, b.k, t));
    const cx = mix(a.x, b.x, t);
    const cy = mix(a.y, b.y, t);
    return {
      scale,
      ox: Math.min(0, Math.max(CARD.width - viewport.width * scale, CARD.width / 2 - cx * scale)),
      oy: Math.min(0, Math.max(CARD.height - viewport.height * scale, CARD.height / 2 - cy * scale)),
    };
  };
  const toComp = (rect, cam) => ({
    x: CARD.x + cam.ox + rect.x * cam.scale, y: CARD.y + cam.oy + rect.y * cam.scale,
    width: rect.width * cam.scale, height: rect.height * cam.scale,
  });

  const shot = shotAtFrame(frame);
  const ms = toMs(frame);
  const cam = cameraAt(shot, ms);
  const inBody = frame >= AD.intro - 12 && frame < timing.outroStart + 10;

  // A short blur dip hides the cut between shots.
  const cutFrames = shots.slice(1).map((s) => toFrame(s, s.segment.from));
  const cutBlur = Math.max(0, ...cutFrames.map((cut) => interpolate(Math.abs(frame - cut), [0, 6], [7, 0], clamp)));

  const track = useMemo(() => plan.cues.filter(({kind}) => kind === 'pointer'), [plan]);
  const pointer = frame >= AD.intro ? pointerAt(track, ms) : null;
  const lastClick = shot.clicks.findLast((click) => click.atMs <= ms);

  // Logo: hero in the intro, watermark during the product, hero again on the end card.
  const toSmall = spring({frame: frame - (AD.intro - 16), fps, config: {damping: 18, stiffness: 120}});
  const toEnd = spring({frame: frame - (timing.outroStart + 2), fps, config: {damping: 16, stiffness: 110}});
  const logoPose = {x: 540, y: mix(mix(700, 180, toSmall), 700, toEnd), scale: mix(mix(2.3, 1.15, toSmall), 2.5, toEnd)};
  const firstMs = shots[0]?.segment.from ?? 0;

  return (
    <AbsoluteFill style={{overflow: 'hidden'}}>
      <BrandBackdrop brand={brand} />
      <KineticCaption text={storyboard.headline} at={14} out={AD.intro - 14} y={880} size={92} brand={brand} />

      {inBody ? (
        <FloatingCard x={CARD.x} y={CARD.y} width={CARD.width} height={CARD.height} radius={CARD.radius}
          enterAt={AD.intro - 12} exitAt={timing.outroStart - 6} brand={brand}>
          <div style={{position: 'absolute', left: cam.ox, top: cam.oy, width: viewport.width, height: viewport.height,
            transform: `scale(${cam.scale})`, transformOrigin: '0 0', filter: cutBlur ? `blur(${cutBlur}px)` : undefined}}>
            <Crop src={srcAt(ms)} box={{x: 0, y: 0, ...viewport}} viewport={viewport} scale={1} />
            <VirtualPointer point={pointer} click={lastClick} pose={{x: 0, y: 0, zoom: 1}} atMs={ms}
              scale={cursorScale / cam.scale} accent={brand.primary} />
          </div>
          {shots.map((s) => {
            if (!boards[s.index]?.lift || !s.payoffAnchor) return null;
            const at = toFrame(s, s.payoff) + 2;
            const back = toFrame(s, s.end) - 12;
            const dim = interpolate(frame, [at, at + 10, back, back + 12], [0, 1, 1, 0], clamp);
            return dim ? <AbsoluteFill key={s.index} style={{background: alpha(brand.deep, 0.22 * dim)}} /> : null;
          })}
        </FloatingCard>
      ) : null}

      {shots.map((s) => {
        const text = boards[s.index]?.caption;
        if (!text) return null;
        const at = Math.max(AD.intro, toFrame(s, s.segment.from) + 2);
        const out = Math.min(timing.outroStart - 8, toFrame(s, s.segment.to) - 6);
        return <KineticCaption key={s.index} text={text} at={at} out={out} y={330} size={78} brand={brand} />;
      })}

      {shots.map((s) => {
        const board = boards[s.index] ?? {};
        const effects = [];
        // Signature: the click that produced the payoff gets a glow and the ad's one sparkle.
        const key = board.emphasis === 'signature' ? s.clicks.findLast((click) => click.atMs <= s.payoff) : null;
        if (key) {
          const keyCam = cameraAt(s, key.atMs);
          const point = toComp({x: key.x, y: key.y, width: 0, height: 0}, keyCam);
          const f = toFrame(s, key.atMs);
          if (key.target) effects.push(<GlowPulse key="g" rect={toComp(key.target.box, keyCam)} at={f - 8} color={brand.primary} />);
          effects.push(<SparkleBurst key="s" x={point.x} y={point.y} at={f} colors={[brand.primary, brand.accent, '#ffffff']}
            count={9} radius={150} size={28} seed={`shot-${s.index}`} />);
        }
        const payoffBox = contentOf(s.payoffAnchor);
        if (payoffBox && board.lift) {
          const at = toFrame(s, s.payoff) + 2;
          const back = toFrame(s, s.end) - 12;
          // Up to 2x (the capture density) for sharpness; cap height; overlap the card's bottom edge for depth.
          const width = Math.min(980, payoffBox.width * 2, 640 * payoffBox.width / payoffBox.height);
          effects.push(
            <Lift key="l" src={srcAt(toMs(Math.min(frame, back)))} box={payoffBox} viewport={viewport}
              from={toComp(payoffBox, cameraAt(s, s.payoff))} to={{x: (AD.width - width) / 2, y: CARD.y + CARD.height - 140, width}}
              at={at} returnAt={back} shimmerAt={at + 16} brand={brand} radius={20} />,
          );
        } else if (payoffBox) {
          effects.push(<GlowPulse key="p" rect={toComp(payoffBox, cameraAt(s, s.payoff + 400))} at={toFrame(s, s.payoff) + 6}
            color={brand.accent} radius={16} duration={36} />);
        }
        return <AbsoluteFill key={s.index} style={{pointerEvents: 'none'}}>{effects}</AbsoluteFill>;
      })}

      <KineticCaption text={storyboard.tagline} at={timing.outroStart + 14} y={880} size={96} brand={brand} />
      <CTAButton text={storyboard.cta} at={timing.outroStart + 34} x={540} y={1150} brand={brand} />

      {logo ? (
        <LogoPop src={srcAt(firstMs)} box={logo.box} viewport={viewport} at={4}
          x={logoPose.x} y={logoPose.y} scale={logoPose.scale} brand={brand} padding={10 + 10 * logoPose.scale} />
      ) : (
        <div style={{opacity: Math.min(1, frame / 8), transform: `scale(${logoPose.scale / 2})`, transformOrigin: `${logoPose.x}px ${logoPose.y}px`}}>
          <NameBadge name={storyboard.appName} x={logoPose.x} y={logoPose.y} scale={2} brand={brand} />
        </div>
      )}
      <Grain opacity={0.045} />
    </AbsoluteFill>
  );
}
