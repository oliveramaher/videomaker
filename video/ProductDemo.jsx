import {useMemo} from 'react';
import {AbsoluteFill, Img, staticFile, useCurrentFrame} from 'remotion';

const clamp = (value, max) => Math.min(Math.max(value, 0), max);
const mix = (from, to, progress) => from + (to - from) * progress;
const ease = (t) => t * t * (3 - 2 * t);
const wide = {x: 0, y: 0, zoom: 1};

function cameraAt(move, atMs) {
  if (!move) return wide;
  const progress = move.durationMs ? ease(clamp((atMs - move.atMs) / move.durationMs, 1)) : 1;
  return {
    x: mix(move.from.x, move.to.x, progress),
    y: mix(move.from.y, move.to.y, progress),
    zoom: mix(move.from.zoom, move.to.zoom, progress),
  };
}

function buildCamera({cues, width, height}, strength) {
  const moves = [];
  for (const cue of cues) {
    if (cue.kind !== 'camera') continue;
    const zoom = Math.max(1, 1 + (cue.zoom - 1) * strength);
    const to = cue.point ? {
      zoom,
      x: clamp(cue.point.x * zoom - width * cue.anchor.x, width * (zoom - 1)),
      y: clamp(cue.point.y * zoom - height * cue.anchor.y, height * (zoom - 1)),
    } : wide;
    moves.push({...cue, from: cameraAt(moves.at(-1), cue.atMs), to});
  }
  return moves;
}

function pointerAt(track, atMs) {
  const index = track.findLastIndex((cue) => cue.atMs <= atMs);
  const current = track[index];
  if (!current || current.action === 'hide') return null;
  const next = track[index + 1];
  const gap = next ? next.atMs - current.atMs : 0;
  if (current.action === 'move' && next?.action === 'move' && gap > 0 && gap < 100) {
    const progress = (atMs - current.atMs) / gap;
    return {x: mix(current.x, next.x, progress), y: mix(current.y, next.y, progress), action: 'move'};
  }
  return current;
}

function VirtualPointer({point, click, pose, atMs, scale, accent}) {
  const clickAge = click ? atMs - click.atMs : Infinity;
  const progress = clamp(clickAge / 360, 1);
  const size = 24 * scale;
  const arrow = 'polygon(0 0, 100% 65%, 61% 68%, 78% 95%, 60% 100%, 43% 73%, 14% 100%)';
  return (
    <>
      {clickAge < 360 ? (
        <div style={{
          position: 'absolute',
          left: click.x * pose.zoom - pose.x,
          top: click.y * pose.zoom - pose.y,
          width: 32 * scale,
          height: 32 * scale,
          borderRadius: '50%',
          border: `2px solid ${accent}`,
          scale: mix(0.43, 1.45, ease(progress)),
          translate: '-50% -50%',
          opacity: (1 - progress) ** 1.6,
        }} />
      ) : null}
      {point ? (
        <div data-virtual-pointer style={{
          position: 'absolute',
          left: point.x * pose.zoom - pose.x - 2 * scale,
          top: point.y * pose.zoom - pose.y - 2 * scale,
          width: size,
          height: size * 1.24,
          scale: point.action === 'down' ? 0.9 : 1,
          transformOrigin: 'top left',
          filter: 'drop-shadow(1px 2px 2px #161d38a6)',
        }}>
          <div style={{position: 'absolute', inset: 0, background: '#fff', clipPath: arrow}} />
          <div style={{position: 'absolute', inset: `${2 * scale}px`, background: '#161922', clipPath: arrow}} />
        </div>
      ) : null}
    </>
  );
}

export function ProductDemo({take, plan, cursorScale, cameraStrength, clickColor}) {
  const frame = useCurrentFrame();
  const moves = useMemo(() => plan ? buildCamera(plan, cameraStrength) : [], [plan, cameraStrength]);
  const track = useMemo(() => plan?.cues.filter(({kind}) => kind === 'pointer') ?? [], [plan]);
  const clicks = useMemo(() => track.filter(({action}) => action === 'down'), [track]);
  const browserHover = useMemo(() => plan?.cues.filter(({kind}) => kind === 'browser-hover') ?? [], [plan]);
  const source = plan?.timeline[Math.min(frame, plan.timeline.length - 1)];
  if (!source) return <AbsoluteFill style={{backgroundColor: '#f6f7fa'}} />;

  const {atMs, pixelsAtMs = atMs} = source;
  const hoverInPixels = browserHover.findLast((cue) => cue.atMs <= pixelsAtMs);
  const hoverNow = browserHover.findLast((cue) => cue.atMs <= atMs);
  // Give Chromium one brief opportunity to repaint an exited hover.
  const pointerTime = hoverInPixels?.target && hoverNow && hoverInPixels !== hoverNow
    && atMs - hoverNow.atMs <= 120 ? pixelsAtMs : atMs;
  const pose = cameraAt(moves.findLast((move) => move.atMs <= atMs), atMs);
  return (
    <AbsoluteFill style={{overflow: 'hidden', backgroundColor: '#f6f7fa'}}>
      <Img
        key={source.file}
        src={staticFile(`${take}/${source.file}`)}
        style={{
          position: 'absolute',
          width: '100%',
          height: '100%',
          transformOrigin: '0 0',
          transform: `translate(${-pose.x}px, ${-pose.y}px) scale(${pose.zoom})`,
        }}
      />
      <VirtualPointer
        point={pointerAt(track, pointerTime)}
        click={clicks.findLast((click) => click.atMs <= atMs)}
        pose={pose}
        atMs={atMs}
        scale={cursorScale}
        accent={clickColor}
      />
    </AbsoluteFill>
  );
}
