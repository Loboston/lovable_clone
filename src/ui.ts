import { Hono } from "hono";
import type { Env } from "./types";

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Lovable-style App Builder</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-900 text-slate-100 min-h-screen">
  <div id="root"></div>
  <script type="module">
    const API = '';
    function getToken() { return localStorage.getItem('token'); }
    function setToken(t) { if (t) localStorage.setItem('token', t); else localStorage.removeItem('token'); }

    function api(path, opts = {}) {
      const token = getToken();
      return fetch(API + path, {
        ...opts,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
          ...opts.headers,
        },
        ...(opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)
          ? { body: JSON.stringify(opts.body) }
          : opts.body ? { body: opts.body } : {}),
      });
    }

    let currentProjectId = null;
    let projects = [];

    function render() {
      const root = document.getElementById('root');
      const token = getToken();
      if (!token) {
        root.innerHTML = \`
          <div class="max-w-md mx-auto mt-20 p-6 space-y-4">
            <h1 class="text-2xl font-bold">App Builder</h1>
            <form id="authForm" class="space-y-3">
              <input type="email" id="email" placeholder="Email" class="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600" />
              <input type="password" id="password" placeholder="Password" class="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600" />
              <div class="flex gap-2">
                <button type="submit" name="action" value="login" class="px-4 py-2 rounded bg-blue-600 hover:bg-blue-700">Login</button>
                <button type="submit" name="action" value="register" class="px-4 py-2 rounded bg-slate-600 hover:bg-slate-700">Register</button>
              </div>
            </form>
            <p id="authError" class="text-red-400 text-sm hidden"></p>
          </div>
        \`;
        document.getElementById('authForm')?.addEventListener('submit', async (e) => {
          e.preventDefault();
          const form = e.target;
          const email = form.email.value;
          const password = form.password.value;
          const action = e.submitter?.value === 'register' ? 'register' : 'login';
          const errEl = document.getElementById('authError');
          try {
            const r = await api('/api/auth/' + action, { method: 'POST', body: { email, password } });
            const data = await r.json();
            if (!r.ok) { errEl.textContent = data.error || 'Failed'; errEl.classList.remove('hidden'); return; }
            setToken(data.token);
            render();
          } catch (err) { errEl.textContent = err.message; errEl.classList.remove('hidden'); }
        });
        return;
      }

      if (currentProjectId === null && !document.getElementById('projectSelect')) {
        root.innerHTML = \`
          <div class="flex flex-col h-screen">
            <header class="p-4 border-b border-slate-700 flex justify-between items-center">
              <h1 class="text-xl font-bold">App Builder</h1>
              <button id="logoutBtn" class="text-sm text-slate-400 hover:text-white">Logout</button>
            </header>
            <div class="flex flex-1 overflow-hidden">
              <aside class="w-64 border-r border-slate-700 p-4 flex flex-col">
                <button id="newProjectBtn" class="mb-4 px-3 py-2 rounded bg-emerald-600 hover:bg-emerald-700 text-sm">New project</button>
                <ul id="projectList" class="space-y-1 overflow-auto"></ul>
              </aside>
              <main class="flex-1 flex flex-col p-4">
                <p class="text-slate-400">Select a project or create one to start.</p>
              </main>
            </div>
          </div>
        \`;
        document.getElementById('logoutBtn').onclick = () => { setToken(null); currentProjectId = null; render(); };
        document.getElementById('newProjectBtn').onclick = async () => {
          const name = prompt('Project name', 'My App') || 'My App';
          const r = await api('/api/projects', { method: 'POST', body: { name } });
          const data = await r.json();
          if (r.ok) { projects.push(data.project); currentProjectId = data.project.id; render(); }
        };
        (async () => {
          const r = await api('/api/projects');
          const data = await r.json();
          if (r.ok) projects = data.projects || [];
          const list = document.getElementById('projectList');
          list.innerHTML = projects.map(p => \`<li><button class="projectBtn w-full text-left px-2 py-1 rounded hover:bg-slate-800" data-id="\${p.id}">\${p.name}</button></li>\`).join('');
          list.querySelectorAll('.projectBtn').forEach(btn => {
            btn.onclick = () => { currentProjectId = btn.dataset.id; render(); };
          });
        })();
        return;
      }

      if (currentProjectId && document.getElementById('projectSelect') === null) {
        const proj = projects.find(p => p.id === currentProjectId) || { name: 'Project', status: '', deployed_url: '' };
        root.innerHTML = \`
          <div class="flex flex-col h-screen">
            <header class="p-4 border-b border-slate-700 flex justify-between items-center">
              <div class="flex items-center gap-4">
                <button id="backBtn" class="text-slate-400 hover:text-white">← Back</button>
                <h1 class="text-xl font-bold">\${proj.name}</h1>
                <span class="text-sm text-slate-400">\${proj.status || 'draft'}</span>
                \${proj.deployed_url ? \`<a href="\${proj.deployed_url}" target="_blank" class="text-sm text-blue-400">Open app</a>\` : ''}
              </div>
              <button id="deployBtn" class="px-4 py-2 rounded bg-blue-600 hover:bg-blue-700 text-sm">Deploy</button>
            </header>
            <div class="flex flex-1 overflow-hidden">
              <div class="w-1/2 flex flex-col border-r border-slate-700">
                <div class="p-2 border-b border-slate-700">
                  <textarea id="chatInput" rows="2" class="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 resize-none" placeholder="Describe your app..."></textarea>
                  <button id="sendBtn" class="mt-2 px-4 py-2 rounded bg-slate-600 hover:bg-slate-700 text-sm">Send</button>
                </div>
                <ul id="chatMessages" class="flex-1 overflow-auto p-4 space-y-3"></ul>
              </div>
              <div class="w-1/2 flex flex-col bg-slate-950">
                <iframe id="previewFrame" class="flex-1 w-full border-0" src="about:blank" title="Preview"></iframe>
                <p class="p-2 text-slate-500 text-sm">Preview (after deploy)</p>
              </div>
            </div>
          </div>
        \`;
        document.getElementById('backBtn').onclick = () => { currentProjectId = null; render(); };
        document.getElementById('deployBtn').onclick = async () => {
          const btn = document.getElementById('deployBtn');
          btn.disabled = true;
          btn.textContent = 'Building...';
          try {
            const r = await api(\`/api/projects/\${currentProjectId}/build\`, { method: 'POST' });
            const data = await r.json();
            if (r.ok) {
              const p = projects.find(x => x.id === currentProjectId);
              if (p) { p.status = 'deployed'; p.deployed_url = data.deployed_url; }
              render();
            } else alert(data.error || 'Build failed');
          } finally { btn.disabled = false; btn.textContent = 'Deploy'; }
        };
        (async () => {
          const r = await api(\`/api/chat/\${currentProjectId}/history\`);
          const data = await r.json();
          const ul = document.getElementById('chatMessages');
          (data.messages || []).forEach(m => {
            const li = document.createElement('li');
            li.className = m.role === 'user' ? 'text-right' : 'text-left';
            li.textContent = m.content?.slice(0, 200) + (m.content?.length > 200 ? '...' : '');
            ul.appendChild(li);
          });
        })();
        const sendBtn = document.getElementById('sendBtn');
        const chatInput = document.getElementById('chatInput');
        sendBtn.onclick = async () => {
          const text = chatInput.value.trim();
          if (!text) return;
          const ul = document.getElementById('chatMessages');
          const userLi = document.createElement('li');
          userLi.className = 'text-right';
          userLi.textContent = text;
          ul.appendChild(userLi);
          chatInput.value = '';
          const res = await fetch(API + '/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
            body: JSON.stringify({ project_id: currentProjectId, message: text }),
          });
          if (!res.ok) return;
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          const assistantLi = document.createElement('li');
          assistantLi.className = 'text-left';
          ul.appendChild(assistantLi);
          let full = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            full += decoder.decode(value, { stream: true });
            assistantLi.textContent = full;
          }
          await api('/api/chat/save-assistant', { method: 'POST', body: { project_id: currentProjectId, content: full } });
        };
        return;
      }
    }

    render();
  </script>
</body>
</html>`;

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => {
  return c.html(html);
});

export default app;
