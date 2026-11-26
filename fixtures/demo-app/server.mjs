// A small fake startup app ("Tasklane") for exercising the explorer offline.
// It has a login, real features worth filming, clutter to hide, and dangerous
// buttons that the explorer's guard must refuse. State lives in memory per server.
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';

export const DEMO_USER = 'demo@tasklane.test';
export const DEMO_PASSWORD = 'tasklane-demo';

const page = String.raw`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Tasklane</title>
<style>
  :root {
    --brand: #6d4aff; --brand-ink: #2a1a6e; --accent: #ffb547; --bg: #f7f6fb;
    --card: #ffffff; --ink: #1d1b29; --muted: #6b6880; --line: #e6e3f0; --danger: #d6345a;
    --radius: 14px; font-family: "Inter", system-ui, sans-serif;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); }
  button { font: inherit; border: 0; border-radius: 10px; padding: 10px 16px; cursor: pointer; }
  .primary { background: var(--brand); color: #fff; box-shadow: 0 6px 18px #6d4aff40; }
  .primary:hover { background: #5a37f0; transform: translateY(-1px); }
  .ghost { background: transparent; color: var(--muted); }
  .ghost:hover { background: #ece9f7; color: var(--ink); }
  .danger { background: #fde8ee; color: var(--danger); }
  input, textarea, select { font: inherit; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; width: 100%; }
  .shell { display: grid; grid-template-columns: 232px 1fr; min-height: 100vh; }
  nav { background: var(--card); border-right: 1px solid var(--line); padding: 20px 14px; display: flex; flex-direction: column; gap: 4px; }
  nav .logo { font-weight: 800; font-size: 20px; color: var(--brand-ink); padding: 6px 10px 18px; display: flex; gap: 8px; align-items: center; }
  nav .logo i { width: 22px; height: 22px; border-radius: 7px; background: linear-gradient(135deg, var(--brand), var(--accent)); display: inline-block; }
  nav a { color: var(--muted); text-decoration: none; padding: 9px 12px; border-radius: 9px; }
  nav a.active, nav a:hover { background: #efebff; color: var(--brand-ink); }
  main { padding: 28px 36px; }
  header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 22px; }
  h1 { margin: 0; font-size: 26px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); padding: 18px; }
  .project { cursor: pointer; transition: box-shadow .2s, transform .2s; }
  .project:hover { box-shadow: 0 10px 30px #2a1a6e1a; transform: translateY(-2px); }
  .bar { height: 6px; background: var(--line); border-radius: 3px; margin-top: 12px; overflow: hidden; }
  .bar span { display: block; height: 100%; background: linear-gradient(90deg, var(--brand), var(--accent)); }
  .board { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
  .task { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; margin-top: 8px; display: flex; gap: 8px; align-items: center; }
  .task.done span { text-decoration: line-through; color: var(--muted); }
  dialog { border: 0; border-radius: 18px; padding: 24px; width: 420px; box-shadow: 0 30px 80px #1d1b2955; }
  dialog::backdrop { background: #1d1b2966; }
  .row { display: flex; gap: 10px; margin-top: 14px; justify-content: flex-end; }
  .cookie { position: fixed; bottom: 16px; left: 50%; translate: -50% 0; background: var(--ink); color: #fff; padding: 12px 16px; border-radius: 12px; display: flex; gap: 12px; align-items: center; }
  .tip { position: absolute; background: var(--brand-ink); color: #fff; padding: 10px 12px; border-radius: 10px; font-size: 14px; max-width: 220px; }
  .ai { background: linear-gradient(135deg, #f3efff, #fff6e6); border: 1px solid #e3dbff; }
  .chart { display: flex; align-items: flex-end; gap: 10px; height: 160px; margin-top: 14px; }
  .chart div { flex: 1; background: linear-gradient(180deg, var(--brand), #b9a8ff); border-radius: 6px 6px 0 0; }
  .login { max-width: 380px; margin: 14vh auto; }
  label { display: block; font-size: 14px; color: var(--muted); margin: 12px 0 6px; }
</style>
<body>
<div id="app"></div>
<script>
const state = JSON.parse(sessionStorage.getItem('tasklane') || 'null') || {
  projects: [
    {id: 1, name: 'Website relaunch', color: '#6d4aff', tasks: [
      {id: 1, title: 'Write hero copy', col: 'todo'}, {id: 2, title: 'Pick illustrations', col: 'doing'},
      {id: 3, title: 'Set up analytics', col: 'done'}]},
    {id: 2, name: 'Mobile onboarding', color: '#ffb547', tasks: [
      {id: 4, title: 'Map first-run flow', col: 'todo'}]},
  ],
  cookies: false, tip: false,
};
const save = () => sessionStorage.setItem('tasklane', JSON.stringify(state));
const app = document.getElementById('app');
const h = (s) => s.replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const progress = (p) => p.tasks.length ? Math.round(100 * p.tasks.filter((t) => t.col === 'done').length / p.tasks.length) : 0;

function shell(active, body) {
  const link = (href, label) => '<a href="#/' + href + '" class="' + (active === href ? 'active' : '') + '">' + label + '</a>';
  return '<div class="shell"><nav aria-label="Main"><div class="logo"><i></i>Tasklane</div>' +
    link('projects', 'Projects') + link('insights', 'Insights') + link('settings', 'Settings') +
    '</nav><main>' + body + '</main></div>' +
    (state.cookies ? '' : '<div class="cookie" role="dialog" aria-label="Cookie notice">We use cookies to improve Tasklane. <button class="primary" id="cookie-ok">Accept</button></div>');
}

function projects() {
  app.innerHTML = shell('projects', '<header><h1>Projects</h1><button class="primary" id="new-project">New project</button></header>' +
    '<div class="grid">' + state.projects.map((p) =>
      '<div class="card project" role="link" tabindex="0" aria-label="Open ' + h(p.name) + '" data-id="' + p.id + '">' +
      '<strong>' + h(p.name) + '</strong><div style="color:var(--muted);margin-top:6px">' + p.tasks.length + ' tasks · ' + progress(p) + '% done</div>' +
      '<div class="bar"><span style="width:' + progress(p) + '%"></span></div></div>').join('') + '</div>' +
    '<dialog id="project-dialog" aria-label="New project"><h2 style="margin-top:0">New project</h2>' +
    '<label for="project-name">Project name</label><input id="project-name" placeholder="e.g. Q3 launch">' +
    '<label for="project-template">Template</label><select id="project-template"><option>Blank</option><option>Product launch</option><option>Bug triage</option></select>' +
    '<div class="row"><button class="ghost" id="cancel-project">Cancel</button><button class="primary" id="create-project">Create project</button></div></dialog>');
  document.querySelectorAll('.project').forEach((el) => el.onclick = () => location.hash = '#/project/' + el.dataset.id);
  const dialog = document.getElementById('project-dialog');
  document.getElementById('new-project').onclick = () => dialog.showModal();
  document.getElementById('cancel-project').onclick = () => dialog.close();
  document.getElementById('create-project').onclick = () => {
    const name = document.getElementById('project-name').value.trim() || 'Untitled project';
    const template = document.getElementById('project-template').value;
    const tasks = template === 'Product launch'
      ? ['Draft launch post', 'Record demo video', 'Email beta users'].map((title, i) => ({id: Date.now() + i, title, col: 'todo'}))
      : [];
    state.projects.push({id: Date.now(), name, color: '#6d4aff', tasks});
    save(); dialog.close(); projects();
  };
  document.querySelector('.tip')?.remove();
  if (!state.tip) {
    const tip = document.createElement('div');
    tip.className = 'tip'; tip.setAttribute('role', 'tooltip');
    tip.style.cssText = 'top:76px;right:40px';
    tip.innerHTML = 'Tip: start a project from a template! <button class="ghost" style="color:#fff" id="tip-close" aria-label="Dismiss tip">✕</button>';
    document.body.append(tip);
    document.getElementById('tip-close').onclick = () => { state.tip = true; save(); tip.remove(); };
  }
}

function project(id) {
  const p = state.projects.find((x) => x.id === id);
  if (!p) return (location.hash = '#/projects');
  const col = (key, title) => '<div class="card"><strong>' + title + '</strong>' +
    p.tasks.filter((t) => t.col === key).map((t) =>
      '<div class="task ' + (key === 'done' ? 'done' : '') + '"><input type="checkbox" style="width:auto" aria-label="Complete ' + h(t.title) + '" data-task="' + t.id + '"' + (key === 'done' ? ' checked' : '') + '><span>' + h(t.title) + '</span></div>').join('') + '</div>';
  app.innerHTML = shell('projects', '<header><h1>' + h(p.name) + '</h1><div style="display:flex;gap:8px">' +
    '<button class="ghost" id="ai-plan">✨ Plan with AI</button><button class="primary" id="add-task">Add task</button></div></header>' +
    '<div id="ai-box"></div><div class="board">' + col('todo', 'To do') + col('doing', 'In progress') + col('done', 'Done') + '</div>');
  document.querySelectorAll('[data-task]').forEach((box) => box.onchange = () => {
    const t = p.tasks.find((x) => x.id === Number(box.dataset.task));
    t.col = box.checked ? 'done' : 'todo'; save(); project(id);
  });
  document.getElementById('add-task').onclick = () => {
    const title = prompt('Task title');
    if (title) { p.tasks.push({id: Date.now(), title, col: 'todo'}); save(); project(id); }
  };
  document.getElementById('ai-plan').onclick = () => {
    const box = document.getElementById('ai-box');
    box.innerHTML = '<div class="card ai" style="margin-bottom:16px" aria-live="polite"><strong>✨ Suggested next steps</strong><ol id="ai-list"></ol><button class="primary" id="ai-accept">Add all to board</button></div>';
    const steps = ['Break "' + (p.tasks[0]?.title || 'kickoff') + '" into two smaller tasks', 'Assign an owner to each column', 'Set a review date for Friday'];
    steps.forEach((s, i) => setTimeout(() => { document.getElementById('ai-list')?.insertAdjacentHTML('beforeend', '<li>' + h(s) + '</li>'); }, 350 * (i + 1)));
    document.getElementById('ai-accept').onclick = () => { steps.forEach((title, i) => p.tasks.push({id: Date.now() + i, title, col: 'todo'})); save(); project(id); };
  };
}

function insights() {
  const values = [32, 48, 41, 66, 58, 79, 92];
  app.innerHTML = shell('insights', '<header><h1>Insights</h1><select aria-label="Time range" id="range" style="width:auto"><option>Last 7 days</option><option>Last 30 days</option></select></header>' +
    '<div class="grid"><div class="card"><div style="color:var(--muted)">Tasks completed</div><div style="font-size:34px;font-weight:800">' + values.reduce((a, b) => a + b) + '</div></div>' +
    '<div class="card"><div style="color:var(--muted)">On-time rate</div><div style="font-size:34px;font-weight:800">94%</div></div></div>' +
    '<div class="card" style="margin-top:16px"><strong>Weekly velocity</strong><div class="chart" role="img" aria-label="Velocity chart">' + values.map((v) => '<div style="height:' + v + '%"></div>').join('') + '</div></div>');
  document.getElementById('range').onchange = () => document.querySelectorAll('.chart div').forEach((bar) => bar.style.height = (20 + Math.random() * 80) + '%');
}

function settings() {
  app.innerHTML = shell('settings', '<header><h1>Settings</h1></header>' +
    '<div class="card"><strong>Invite teammates</strong><label for="invite-email">Email</label><input id="invite-email" type="email" placeholder="name@company.com">' +
    '<div class="row"><button class="primary" id="send-invite">Send invite</button></div></div>' +
    '<div class="card" style="margin-top:16px"><strong>Plan</strong><p style="color:var(--muted)">You are on the Free plan.</p><button class="primary" id="upgrade">Upgrade to Pro</button></div>' +
    '<div class="card" style="margin-top:16px"><strong>Danger zone</strong><p style="color:var(--muted)">Permanently remove all projects.</p><button class="danger" id="delete-workspace">Delete workspace</button> <button class="ghost" id="logout">Log out</button></div>');
  // These must never be clicked by the explorer; the server counts any attempt that slips through.
  for (const id of ['send-invite', 'upgrade', 'delete-workspace', 'logout']) {
    document.getElementById(id).onclick = () => fetch('/api/danger/' + id, {method: 'POST'}).then(() => {
      if (id === 'delete-workspace') { state.projects = []; save(); }
      if (id === 'logout') { document.cookie = 'tl_session=; Max-Age=0; path=/'; location.href = '/login'; }
    });
  }
}

function route() {
  const [, view, id] = location.hash.split('/');
  if (view === 'project') project(Number(id));
  else if (view === 'insights') insights();
  else if (view === 'settings') settings();
  else projects();
  document.getElementById('cookie-ok')?.addEventListener('click', () => { state.cookies = true; save(); route(); });
}
addEventListener('hashchange', route);
route();
</script>
</body>
</html>`;

const login = String.raw`<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Sign in · Tasklane</title>
<style>
  body { margin: 0; background: #f7f6fb; font-family: system-ui, sans-serif; color: #1d1b29; }
  form { max-width: 360px; margin: 14vh auto; background: #fff; padding: 28px; border-radius: 16px; border: 1px solid #e6e3f0; }
  label { display: block; font-size: 14px; color: #6b6880; margin: 14px 0 6px; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #e6e3f0; border-radius: 10px; font: inherit; }
  button { margin-top: 18px; width: 100%; padding: 11px; border: 0; border-radius: 10px; background: #6d4aff; color: #fff; font: inherit; }
  .error { color: #d6345a; font-size: 14px; }
</style>
<form method="post" action="/login">
  <h1 style="margin-top:0">Sign in to Tasklane</h1>
  __ERROR__
  <label for="email">Work email</label><input id="email" name="email" type="email" autocomplete="username">
  <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password">
  <button type="submit">Sign in</button>
</form></html>`;

export function startDemoApp({port = 4317, host = '127.0.0.1'} = {}) {
  const dangerHits = [];
  const sessions = new Set();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const cookie = /(?:^|;\s*)tl_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    const authed = cookie && sessions.has(cookie);
    const send = (status, body, headers = {}) => {
      res.writeHead(status, {'content-type': 'text/html; charset=utf-8', ...headers});
      res.end(body);
    };
    if (url.pathname === '/login' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      if (form.get('email') === DEMO_USER && form.get('password') === DEMO_PASSWORD) {
        const token = crypto.randomUUID();
        sessions.add(token);
        return send(303, '', {location: '/app', 'set-cookie': `tl_session=${token}; Path=/; HttpOnly; SameSite=Lax`});
      }
      return send(401, login.replace('__ERROR__', '<p class="error">Wrong email or password.</p>'));
    }
    if (url.pathname === '/login') return send(200, login.replace('__ERROR__', ''));
    if (url.pathname.startsWith('/api/danger/') && req.method === 'POST') {
      dangerHits.push(url.pathname.slice('/api/danger/'.length));
      return send(204, '');
    }
    if (url.pathname === '/api/danger') {
      return send(200, JSON.stringify(dangerHits), {'content-type': 'application/json'});
    }
    if (url.pathname === '/' || url.pathname === '/app') {
      return authed ? send(200, page) : send(302, '', {location: '/login'});
    }
    send(404, 'Not found');
  });
  return new Promise((resolve) => server.listen(port, host, () => {
    const {port: actual} = server.address();
    resolve({server, url: `http://${host}:${actual}`, dangerHits, close: () => new Promise((r) => server.close(r))});
  }));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const {url} = await startDemoApp({port: Number(process.env.PORT ?? 4317)});
  console.log(`Tasklane demo app on ${url}  (login: ${DEMO_USER} / ${DEMO_PASSWORD})`);
}
