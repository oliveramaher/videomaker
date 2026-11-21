export const viewport = {width: 1440, height: 900};

const prompt = 'Why does the Earth spin?';

export default async function ({page, step, checkpoint, director}) {
  const {cursor, camera, wait} = director;
  await step('Open Gemini', () => page.goto('https://gemini.google.com/app', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  }));
  const composer = page.getByRole('textbox', {name: /enter a prompt for gemini/i}).first();
  await composer.waitFor({state: 'visible', timeout: 20000});
  await page.evaluate(() => document.fonts.ready.then(() => {}));
  // Let Gemini populate its genuine suggestion cards before directing the take.
  await page.locator('.suggestion-container .card-button').first()
    .waitFor({state: 'visible', timeout: 5000})
    .catch((error) => { if (error.name !== 'TimeoutError') throw error; });
  for (const label of ['About Gemini', 'Subscriptions', 'For Business']) {
    await director.hideElement(`[aria-label="${label}" i], [aria-label="${label} link" i]`);
  }
  await director.hideElement('signed-out-task-toggle-tooltip');
  await director.hideElement('sign-in-nudge gem-banner[variant="overlay"]');

  await director.waitForReady([composer, page.locator('.gemini-sidenav-text').first()]);
  await checkpoint('Ready');

  const openingPointer = {x: 1128, y: 690};
  await director.start(openingPointer);

  await step('Focus prompt', () => cursor.click(composer, {
    from: openingPointer, startAtMs: 740,
    position: {x: 0.055, y: 0.5}, speedPxPerSecond: 560, bend: 0.3,
  }));
  const zoom = 1.57;
  const anchor = {x: 0.48, y: 0.52};
  await camera.focus(composer, {zoom, anchor, durationMs: 820});

  await step('Type prompt', () => director.type(prompt, {
    seed: 378,
    startAtMs: 2650,
    wordsPerMinute: 155,
    follow: {target: composer, zoom, anchor, amount: 0.44},
  }));
  await checkpoint('Prompt typed');
  await wait(380);

  const send = page.getByRole('button', {name: 'Send message', exact: true}).first();
  await send.waitFor({state: 'visible'});
  await step('Send prompt', async () => {
    await camera.focus(send, {
      zoom: 1.43,
      anchor: {x: 0.81, y: 0.58},
      durationMs: 640,
    });
    await cursor.click(send, {durationMs: 820, bend: -0.18});
    director.mark('Submitted');
    camera.wide(880);
  });

  const stop = page.getByRole('button', {name: 'Stop response', exact: true}).first();
  const text = page.locator('.model-response-text:visible').filter({hasText: /\S/}).first();
  await step('Watch Gemini respond', async () => {
    const loading = await stop.waitFor({state: 'visible', timeout: 5000}).then(() => true, () => false);
    if (loading) {
      director.mark('Generating');
      await checkpoint('Generating');
    }
    await cursor.move({x: 1352, y: 780}, {durationMs: 680, bend: 0.12});
    await cursor.hide();

    await text.waitFor({state: 'visible', timeout: 45000});
    director.mark('Response begins');
    await checkpoint('Response begins');
    await stop.waitFor({state: 'hidden', timeout: 60000});
  });
  director.mark('Response complete');
  await wait(1300);
  director.end();
}
