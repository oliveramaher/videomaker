// Sign in with credentials in code and save a Playwright session. The password goes
// straight from the environment into the field; it never reaches the model, the
// product map, or the action log.
import {mkdir} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {createInterface} from 'node:readline/promises';
import {chromium} from 'playwright';

async function findLoginFields(page) {
  const password = page.locator('input[type=password]:visible').first();
  await password.waitFor({timeout: 15000});
  // Prefer an explicit username/email field; otherwise the last text-like input before the password.
  const candidates = page.locator([
    'input[autocomplete=username]', 'input[type=email]', 'input[name*=email i]', 'input[name*=user i]',
    'input[id*=email i]', 'input[id*=user i]',
  ].map((selector) => `${selector}:visible`).join(', '));
  if (await candidates.count()) return {username: candidates.first(), password};
  const fallback = page.locator('input:visible:not([type=password]):not([type=hidden]):not([type=checkbox])'
    + ':not([type=radio]):not([type=submit]):not([type=button])');
  return {username: (await fallback.count()) ? fallback.last() : null, password};
}

/**
 * Log in and write a storage state file.
 * - Automatic: fills username/password from arguments, presses submit, waits for the password field to go away.
 * - Manual (`manual: true`): opens a visible browser and waits for a person to finish, for MFA or SSO.
 */
export async function login({url, username, password, storageState, manual = false, headless = true,
  successUrl, timeoutMs = 30000}) {
  if (!url || !storageState) throw new Error('login needs url and storageState.');
  const output = resolve(storageState);
  await mkdir(dirname(output), {recursive: true});
  const browser = await chromium.launch({headless: manual ? false : headless});
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url, {waitUntil: 'domcontentloaded'});

    if (manual) {
      const prompt = createInterface({input: process.stdin, output: process.stdout});
      await prompt.question('Finish signing in in the browser window, then press Enter here to save the session… ');
      prompt.close();
    } else {
      if (!username || !password) throw new Error('Set APP_USERNAME and APP_PASSWORD (or use --manual).');
      const fields = await findLoginFields(page);
      if (fields.username) await fields.username.fill(username);
      // Two-step logins show the password field only after "Next".
      if (!await fields.password.isVisible().catch(() => false)) {
        await page.getByRole('button', {name: /next|continue/i}).first().click();
      }
      await fields.password.fill(password);
      const submit = page.locator('form:has(input[type=password]) [type=submit]').first();
      if (await submit.count()) await submit.click();
      else await fields.password.press('Enter');

      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const stillOnForm = await page.locator('input[type=password]:visible').count();
        const urlOk = successUrl ? page.url().startsWith(successUrl) : true;
        if (!stillOnForm && urlOk) break;
        const error = await page.locator('[role=alert]:visible, .error:visible').first().innerText().catch(() => '');
        if (error) throw new Error(`Login was rejected: ${error.trim().slice(0, 160)}`);
        await page.waitForTimeout(250);
      }
      if (await page.locator('input[type=password]:visible').count()) {
        throw new Error('Still on the login form after submitting. The site may need MFA or a CAPTCHA: rerun with --manual.');
      }
    }
    await context.storageState({path: output});
    return {storageState: output, landedOn: page.url()};
  } finally {
    await browser.close();
  }
}
