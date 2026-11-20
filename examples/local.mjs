const html = `<!doctype html>
<meta charset="utf-8">
<title>UI capture sample</title>
<link rel="stylesheet" href="/embedded.css">
<style>
  :root { --ink: #231d3b; }
  body { margin: 0; background: #f8f7ff; color: var(--ink); font: 20px system-ui; }
  main { margin: 12vh auto; max-width: 560px; padding: 36px; background: #fff; border-radius: 24px; }
  form { display: flex; gap: 12px; }
  input, button { padding: 12px; border: 1px solid #c0baca; border-radius: 8px; font: inherit; }
  input { flex: 1; min-width: 0; }
  button { background: #5740c2; color: white; }
  output { display: block; margin-top: 24px; }
  output.reveal { animation: reveal 900ms ease both; }
  @keyframes reveal { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: none; } }
</style>
<main>
  <h1>Find a project</h1>
  <form>
    <input aria-label="Project search" placeholder="Search projects">
    <button>Search</button>
  </form>
  <output aria-live="polite"></output>
  <capture-label></capture-label>
  <iframe title="Source" src="https://source.test/" width="220" height="45"></iframe>
  <iframe title="Notes" srcdoc="<p>Sample notes</p>" width="220" height="45"></iframe>
</main>
<script>
  document.querySelector('capture-label').attachShadow({mode: 'closed'}).innerHTML =
    '<small>Project workspace</small>';
  document.querySelector('form').addEventListener('submit', (event) => {
    event.preventDefault();
    const output = document.querySelector('output');
    output.className = 'reveal';
    output.textContent = '1 result · Design systems';
  });
</script>`;

export default async function ({page, step, checkpoint, director}) {
  await page.route('https://capture.test/', (route) =>
    route.fulfill({contentType: 'text/html; charset=utf-8', body: html}));
  await page.route('https://capture.test/embedded.css', (route) =>
    route.fulfill({contentType: 'text/css', body: 'iframe { display: block; border: 0; margin-top: 16px; }'}));
  await page.route('https://source.test/', (route) =>
    route.fulfill({contentType: 'text/html', body: '<p>Project directory</p>'}));
  await step('Open sample', () => page.goto('https://capture.test/'));
  const search = page.getByRole('textbox', {name: 'Project search'});
  await search.waitFor();
  await director.start();
  await director.wait(450);
  await step('Focus search', () => director.cursor.click(search));
  await director.camera.focus(search, {zoom: 1.4});
  await director.wait(550);
  await step('Type search', () => director.type('Design systems'));
  await checkpoint('Search entered');
  await step('Submit search', () =>
    director.cursor.click(page.getByRole('button', {name: 'Search'})));
  await checkpoint('Result animating');
  director.camera.wide();
  await director.wait(1300);
  director.end();
}
