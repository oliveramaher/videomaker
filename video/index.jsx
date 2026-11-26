import {Composition, registerRoot, staticFile} from 'remotion';
import {Ad, AD, adTiming} from './Ad';
import {ProductDemo} from './ProductDemo';

const loadJson = async (path, abortSignal) => {
  const response = await fetch(staticFile(path), {signal: abortSignal});
  return response.ok ? response.json() : null;
};

const loadTake = async ({props, abortSignal}) => {
  const plan = await loadJson(`${props.take}/timeline.json`, abortSignal);
  if (!plan) throw new Error(`Could not load take "${props.take}". Run npm run prepare-demo first.`);
  return {
    props: {...props, plan},
    durationInFrames: plan.timeline.length,
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
  };
};

const loadAd = async ({props, abortSignal}) => {
  const plan = await loadJson(`${props.take}/timeline.json`, abortSignal);
  if (!plan) throw new Error(`Could not load take "${props.take}". Run npm run prepare-demo first.`);
  const brand = {...props.brand, ...await loadJson(`${props.take}/brand.json`, abortSignal), ...props.brandOverride};
  return {
    props: {...props, plan, brand},
    durationInFrames: adTiming(plan).durationInFrames,
  };
};

registerRoot(() => (
  <>
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
    <Composition
      id="Ad"
      component={Ad}
      durationInFrames={300}
      fps={AD.fps}
      width={AD.width}
      height={AD.height}
      calculateMetadata={loadAd}
      defaultProps={{
        // make-ad passes these through --props; the defaults let Studio open a take by name.
        take: 'tasklane',
        plan: null,
        brand: {primary: '#526eea', accent: '#ff9f5a', ink: '#161922', deep: '#161922', background: '#f6f7fa', surface: '#ffffff'},
        brandOverride: {},
        storyboard: {appName: 'App', headline: 'See it *in action*', tagline: 'Try it *today*', cta: 'Get started', shots: []},
      }}
    />
  </>
));
