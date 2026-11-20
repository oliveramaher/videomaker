import {Composition, registerRoot, staticFile} from 'remotion';
import {ProductDemo} from './ProductDemo';

const loadTake = async ({props, abortSignal}) => {
  const response = await fetch(staticFile(`${props.take}/timeline.json`), {signal: abortSignal});
  if (!response.ok) throw new Error(`Could not load take "${props.take}". Run npm run prepare-demo first.`);
  const plan = await response.json();
  return {
    props: {...props, plan},
    durationInFrames: plan.timeline.length,
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
  };
};

registerRoot(() => (
  <Composition
    id="ProductDemo"
    component={ProductDemo}
    durationInFrames={30}
    fps={30}
    width={1440}
    height={900}
    calculateMetadata={loadTake}
    defaultProps={{
      take: 'local-demo',
      plan: null,
      cursorScale: 1,
      cameraStrength: 1,
      clickColor: '#526eea',
    }}
  />
));
