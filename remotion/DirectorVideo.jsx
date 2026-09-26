import React from 'react';
import { AbsoluteFill, Html5Audio, Img, Sequence, interpolate, useCurrentFrame, Easing } from 'remotion';

// Deterministic per-shot camera move so consecutive images never drift the same way.
const MOVES = [
  { fromScale: 1.0, toScale: 1.08, fromX: 0, toX: 0, fromY: 0, toY: 0 }, // slow push in
  { fromScale: 1.08, toScale: 1.0, fromX: 0, toX: 0, fromY: 0, toY: 0 }, // slow pull out
  { fromScale: 1.07, toScale: 1.07, fromX: -2.5, toX: 2.5, fromY: 0, toY: 0 }, // drift right
  { fromScale: 1.07, toScale: 1.07, fromX: 2.5, toX: -2.5, fromY: 0, toY: 0 }, // drift left
  { fromScale: 1.02, toScale: 1.09, fromX: 0, toX: 0, fromY: 1.5, toY: -1.5 }, // push in + rise
];

const Still = ({ src, index, durationInFrames, motion, fadeIn }) => {
  const frame = useCurrentFrame();
  const m = MOVES[index % MOVES.length];
  // Very short holds (< ~0.6s) stay still: movement on a flash-cut looks like jitter.
  const animate = motion === 'kenburns' && durationInFrames > 18;
  const p = animate
    ? interpolate(frame, [0, durationInFrames], [0, 1], { extrapolateRight: 'clamp', easing: Easing.inOut(Easing.sin) })
    : 0;
  const scale = animate ? m.fromScale + (m.toScale - m.fromScale) * p : 1;
  const x = animate ? m.fromX + (m.toX - m.fromX) * p : 0;
  const y = animate ? m.fromY + (m.toY - m.fromY) * p : 0;
  const opacity = fadeIn > 0 ? interpolate(frame, [0, fadeIn], [0, 1], { extrapolateRight: 'clamp' }) : 1;
  return (
    <AbsoluteFill style={{ opacity }}>
      <Img
        src={src}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          transform: `translate(${x}%, ${y}%) scale(${scale})`,
        }}
      />
    </AbsoluteFill>
  );
};

export const DirectorVideo = ({ shots, audioSrc, motion, transition, transitionFrames }) => {
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {shots.map((s, i) => {
        // With "fade", the next image still appears exactly on its word but dissolves in over the
        // previous one, so the previous image is extended underneath for the fade length.
        const fade = transition === 'fade' && i > 0 ? Math.min(transitionFrames, Math.floor(s.durationInFrames / 2)) : 0;
        const tail = transition === 'fade' && i + 1 < shots.length ? Math.min(transitionFrames, Math.floor(shots[i + 1].durationInFrames / 2)) : 0;
        return (
          <Sequence key={i} from={s.from} durationInFrames={s.durationInFrames + tail} layout="none">
            <Still src={s.src} index={i} durationInFrames={s.durationInFrames + tail} motion={motion} fadeIn={fade} />
          </Sequence>
        );
      })}
      {audioSrc ? <Html5Audio src={audioSrc} /> : null}
    </AbsoluteFill>
  );
};
