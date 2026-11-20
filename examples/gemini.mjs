const prompt = 'Why does the Earth spin?';

export default async function ({page, step, checkpoint}) {
  await step('Open Gemini', () => page.goto('https://gemini.google.com/app', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  }));

  const composer = page.getByRole('textbox').filter({visible: true}).first();
  await composer.waitFor({state: 'visible', timeout: 12000});
  await checkpoint('Composer ready');

  await step('Type prompt', async () => {
    await composer.click();
    await composer.pressSequentially(prompt, {delay: 42});
  });
  await checkpoint('Prompt typed');

  await step('Send prompt', async () => {
    const send = page.getByRole('button', {name: /^(send|send message|submit)$/i}).first();
    if (await send.isVisible()) await send.click();
    else await composer.press('Enter');
  });

  await step('Observe response', async () => {
    // English UI and a normal chat response are assumed.
    const response = page.locator('model-response:visible, .model-response-text:visible').first();
    await response.waitFor({state: 'visible', timeout: 45000});
    await checkpoint('Response visible');
    const stop = page.getByRole('button', {name: /stop (response|generation)|^stop$/i}).first();
    await stop.waitFor({state: 'hidden', timeout: 60000});
  });
}
