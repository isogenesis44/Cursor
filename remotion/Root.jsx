import React from 'react';
import { Composition } from 'remotion';
import { DirectorVideo } from './DirectorVideo.jsx';

// Props are supplied at render time by server/render/render.js.
const defaultProps = { fps: 30, width: 1920, height: 1080, durationInFrames: 30, shots: [], audioSrc: null, motion: 'kenburns', transition: 'cut', transitionFrames: 4 };

export const Root = () => (
  <Composition
    id="DirectorVideo"
    component={DirectorVideo}
    defaultProps={defaultProps}
    fps={30}
    width={1920}
    height={1080}
    durationInFrames={30}
    calculateMetadata={({ props }) => ({
      fps: props.fps,
      width: props.width,
      height: props.height,
      durationInFrames: Math.max(1, props.durationInFrames),
    })}
  />
);
