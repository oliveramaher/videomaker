import {setTimeout as wait} from 'node:timers/promises';

/** Capture live state that is not always represented by serialized HTML. */
function readFrameState() {
  const address = (element) => {
    const path = [];
    while (element) {
      const parent = element.parentNode;
      if (!parent) break;
      path.unshift([...parent.children].indexOf(element));
      if (parent instanceof ShadowRoot) {
        path.unshift('shadow');
        element = parent.host;
      } else {
        element = parent instanceof Element ? parent : null;
      }
    }
    return path;
  };

  const scroll = [];
  const forms = [];
  const roots = [document];
  for (const root of roots) {
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) roots.push(element.shadowRoot);
      if (element.scrollTop || element.scrollLeft) {
        scroll.push({path: address(element), x: element.scrollLeft, y: element.scrollTop});
      }
      if (element.matches('input, textarea, select')) {
        forms.push({
          path: address(element),
          value: element.value,
          checked: element.checked,
          indeterminate: element.indeterminate,
          selectedIndices: element.options
            ? Array.from(element.options).flatMap((option, index) => option.selected ? [index] : [])
            : undefined,
        });
      }
    }
  }

  const animations = document.getAnimations().map((animation) => {
    const effect = animation.effect;
    return {
      id: animation.id,
      type: animation.constructor.name,
      name: animation.animationName ?? animation.transitionProperty,
      currentTime: animation.currentTime,
      startTime: animation.startTime,
      playbackRate: animation.playbackRate,
      playState: animation.playState,
      target: effect?.target instanceof Element ? address(effect.target) : null,
      pseudoElement: effect?.pseudoElement,
      timing: effect?.getTiming(),
      computedTiming: effect?.getComputedTiming(),
      keyframes: effect?.getKeyframes?.(),
    };
  });

  const adoptedStylesheets = roots.flatMap((root) =>
    root.adoptedStyleSheets.map((sheet) => ({
      shadowHost: root instanceof ShadowRoot ? address(root.host) : null,
      rules: Array.from(sheet.cssRules, (rule) => rule.cssText),
    })),
  );

  let activeElement = document.activeElement;
  while (activeElement?.shadowRoot?.activeElement) {
    activeElement = activeElement.shadowRoot.activeElement;
  }
  const rootStyle = getComputedStyle(document.documentElement);
  const rootCustomProperties = Object.fromEntries(
    Array.from(rootStyle)
      .filter((property) => property.startsWith('--'))
      .map((property) => [property, rootStyle.getPropertyValue(property)]),
  );
  return {
    url: location.href,
    title: document.title,
    viewport: {width: innerWidth, height: innerHeight, devicePixelRatio},
    windowScroll: {x: scrollX, y: scrollY},
    focus: activeElement ? address(activeElement) : null,
    selection: document.getSelection()?.toString(),
    scroll,
    forms,
    animations,
    adoptedStylesheets,
    rootCustomProperties,
  };
}

/** One Chromium target can contain multiple same-process documents. */
export async function observeTarget(session, onAnimation) {
  const sheets = new Map();
  session.on('CSS.styleSheetAdded', ({header}) => sheets.set(header.styleSheetId, header));
  session.on('CSS.styleSheetRemoved', ({styleSheetId}) => sheets.delete(styleSheetId));
  for (const kind of ['animationStarted', 'animationCanceled']) {
    session.on(`Animation.${kind}`, (data) => onAnimation(kind, data));
  }
  await session.send('DOM.enable');
  await Promise.all([session.send('CSS.enable'), session.send('Animation.enable')]);
  return {session, sheets};
}

async function captureArchive(session) {
  const read = async () => (await session.send('Page.captureSnapshot', {format: 'mhtml'})).data;
  try {
    return await read();
  } catch (error) {
    if (!error.message.includes('Failed to generate MHTML')) throw error;
    // Chromium can decline a snapshot while the frame tree is changing.
    await wait(150);
    return read();
  }
}

export async function snapshot(page, context, mainTarget, write, onAnimation, archive) {
  const frames = page.frames();
  const frameStates = await Promise.all(frames.map(async (frame, index) => {
    try {
      return {
        url: frame.url(),
        parent: frames.indexOf(frame.parentFrame()),
        observedAtMs: Date.now(),
        state: await frame.evaluate(readFrameState),
      };
    } catch (error) {
      return {url: frame.url(), index, error: error.message};
    }
  }));

  const targets = [{...mainTarget, frameIndex: 0}];
  const coverage = [];
  try {
    // Playwright gives a frame its own CDP session when Chromium has put it
    // in a separate process. Same-process frames belong to their parent target.
    for (const [frameIndex, frame] of frames.entries()) {
      if (frameIndex === 0) continue;
      let session;
      try {
        session = await context.newCDPSession(frame);
        const target = await observeTarget(session, (kind, data) =>
          onAnimation(kind, {frameIndex, ...data}));
        targets.push({...target, frameIndex});
      } catch (error) {
        await session?.detach().catch(() => {});
        coverage.push({
          frameIndex,
          reason: /does not have a separate/i.test(error.message)
            ? 'Included in parent target'
            : error.message,
        });
      }
    }

    const issues = frameStates.flatMap(({error}, frameIndex) => error ? [{frameIndex, error}] : []);
    const artifacts = {};
    const save = async (file, makeData) => {
      const startedAtMs = Date.now();
      try {
        await write(file, await makeData());
        artifacts[file] = {startedAtMs, savedAtMs: Date.now()};
      } catch (error) {
        issues.push({file, error: error.message});
      }
    };

    await Promise.all([
      save('viewport.png', () => page.screenshot({animations: 'allow', caret: 'initial', timeout: 8000})),
      save('frame-state.json', () => frameStates),
      ...(archive ? [save('page.mhtml', () => captureArchive(mainTarget.session))] : []),
      ...targets.map(async ({session, sheets, frameIndex}) => {
        const folder = `targets/${frameIndex}`;
        await save(`${folder}/dom.json`, async () => {
          const evaluation = await session.send('Runtime.evaluate', {
            // DOMSnapshot accepts built-in CSS properties only. Authored
            // custom properties remain in the stylesheets and frame state.
            expression: "Array.from(getComputedStyle(document.documentElement)).filter(name => !name.startsWith('--'))",
            returnByValue: true,
          });
          const computedStyles = evaluation.result.value;
          if (!computedStyles?.length) throw new Error('Could not enumerate computed CSS properties.');
          const dom = await session.send('DOMSnapshot.captureSnapshot', {
            computedStyles,
            includePaintOrder: true,
            includeDOMRects: true,
          });
          return {computedStyles, ...dom};
        });
        await save(`${folder}/accessibility.json`, async () => {
          const {frameTree} = await session.send('Page.getFrameTree');
          const trees = [];
          const visit = async ({frame, childFrames = []}) => {
            const {nodes} = await session.send('Accessibility.getFullAXTree', {frameId: frame.id});
            trees.push({frameId: frame.id, nodes});
            for (const child of childFrames) await visit(child);
          };
          await visit(frameTree);
          return trees;
        });
        await save(`${folder}/stylesheets.json`, () => Promise.all(
          [...sheets.values()].map(async (header) => {
            try {
              return {header, ...(await session.send('CSS.getStyleSheetText', {
                styleSheetId: header.styleSheetId,
              }))};
            } catch (error) {
              issues.push({stylesheet: header.sourceURL, error: error.message});
              return {header, error: error.message};
            }
          }),
        ));
      }),
    ]);
    return {coverage, issues, artifacts, targets: targets.map(({frameIndex}) => frameIndex)};
  } finally {
    await Promise.all(targets.slice(1).map(({session}) => session.detach().catch(() => {})));
  }
}
