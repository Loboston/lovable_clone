/**
 * Builder UI script – runs in the browser. Served at GET /builder-app.js
 * Kept in a .ts file so we export it as a string; the browser receives plain JS.
 */
export const builderScript = `
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
            <span id="projectStatus" class="text-sm text-slate-400">\${proj.status || 'draft'}</span>
            \${proj.deployed_url ? \`<a id="openAppLink" href="\${proj.deployed_url}" target="_blank" class="text-sm text-blue-400">Open app</a>\` : ''}
          </div>
        </header>
        <div class="flex flex-1 overflow-hidden">
          <div class="w-1/2 flex flex-col border-r border-slate-700">
            <ul id="chatMessages" class="flex-1 overflow-auto p-4 space-y-3"></ul>
            <div class="p-2 border-t border-slate-700">
              <textarea id="chatInput" rows="2" class="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 resize-none" placeholder="Describe your app..."></textarea>
              <button id="sendBtn" class="mt-2 px-4 py-2 rounded bg-slate-600 hover:bg-slate-700 text-sm">Send</button>
            </div>
          </div>
          <div class="w-1/2 flex flex-col bg-slate-950">
            <iframe id="previewFrame" class="flex-1 w-full border-0" src="about:blank" title="Preview"></iframe>
            <p class="p-2 text-slate-500 text-sm">Preview (after deploy)</p>
          </div>
        </div>
      </div>
    \`;
    document.getElementById('backBtn').onclick = () => { currentProjectId = null; render(); };

    async function triggerBuild(ul) {
      const statusEl = document.getElementById('projectStatus');
      if (statusEl) statusEl.textContent = 'building...';
      const buildingLi = document.createElement('li');
      buildingLi.className = 'text-left text-slate-400 italic';
      buildingLi.textContent = 'Starting build...';
      ul.appendChild(buildingLi);
      ul.scrollTop = ul.scrollHeight;

      try {
        const r = await api(\`/api/projects/\${currentProjectId}/build\`, { method: 'POST' });
        const data = await r.json();
        if (!r.ok) {
          buildingLi.remove();
          if (statusEl) statusEl.textContent = 'error';
          const errLi = document.createElement('li');
          errLi.className = 'text-left text-red-400';
          errLi.textContent = 'Build failed: ' + (data.error || 'Unknown error');
          ul.appendChild(errLi);
          ul.scrollTop = ul.scrollHeight;
          return;
        }

        buildingLi.textContent = 'Build started — watching progress...';
        let lastCreatedAt = '';

        while (true) {
          await new Promise(res => setTimeout(res, 2000));
          try {
            const url = \`/api/projects/\${currentProjectId}/events\` + (lastCreatedAt ? \`?since=\${encodeURIComponent(lastCreatedAt)}\` : '');
            const evRes = await api(url);
            const evData = await evRes.json();

            for (const ev of (evData.events || [])) {
              const li = document.createElement('li');
              li.className = 'text-left text-slate-300 text-sm italic';
              li.textContent = ev.message;
              ul.appendChild(li);
              lastCreatedAt = ev.created_at;
            }
            ul.scrollTop = ul.scrollHeight;

            if (evData.status === 'deployed') {
              buildingLi.remove();
              const projRes = await api(\`/api/projects/\${currentProjectId}\`);
              const projData = await projRes.json();
              const deployedUrl = projData.project?.deployed_url;
              if (deployedUrl) {
                const p = projects.find(x => x.id === currentProjectId);
                if (p) { p.status = 'deployed'; p.deployed_url = deployedUrl; }
                if (statusEl) statusEl.textContent = 'deployed';
                const header = document.querySelector('header .flex.items-center.gap-4');
                if (header && !document.getElementById('openAppLink')) {
                  const link = document.createElement('a');
                  link.id = 'openAppLink';
                  link.href = deployedUrl;
                  link.target = '_blank';
                  link.className = 'text-sm text-blue-400';
                  link.textContent = 'Open app';
                  header.appendChild(link);
                }
                const doneLi = document.createElement('li');
                doneLi.className = 'text-left';
                doneLi.innerHTML = \`App deployed! <a href="\${deployedUrl}" target="_blank" class="text-blue-400 underline">Open it here</a>\`;
                ul.appendChild(doneLi);
                const frame = document.getElementById('previewFrame');
                if (frame) frame.src = deployedUrl;
              }
              break;
            }

            if (evData.status === 'error') {
              buildingLi.remove();
              if (statusEl) statusEl.textContent = 'error';
              const errLi = document.createElement('li');
              errLi.className = 'text-left text-red-400';
              errLi.textContent = 'Build failed. See messages above for details.';
              ul.appendChild(errLi);
              break;
            }
          } catch (_) {
            // network hiccup during poll — just retry next cycle
          }
        }
      } catch (err) {
        buildingLi.remove();
        if (statusEl) statusEl.textContent = 'error';
        const errLi = document.createElement('li');
        errLi.className = 'text-left text-red-400';
        errLi.textContent = 'Build failed: ' + err.message;
        ul.appendChild(errLi);
      }
      ul.scrollTop = ul.scrollHeight;
    }
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
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendBtn.click(); }
    });
    sendBtn.onclick = async () => {
      const text = chatInput.value.trim();
      if (!text) return;
      const ul = document.getElementById('chatMessages');
      const userLi = document.createElement('li');
      userLi.className = 'text-right';
      userLi.textContent = text;
      ul.appendChild(userLi);
      chatInput.value = '';
      sendBtn.disabled = true;
      ul.scrollTop = ul.scrollHeight;
      try {
        const res = await api('/api/chat', { method: 'POST', body: { project_id: currentProjectId, message: text } });
        const data = await res.json();
        if (!res.ok) return;
        const assistantLi = document.createElement('li');
        assistantLi.className = 'text-left';
        assistantLi.textContent = data.message;
        ul.appendChild(assistantLi);
        ul.scrollTop = ul.scrollHeight;
        if (data.build) {
          await triggerBuild(ul);
        }
      } finally {
        sendBtn.disabled = false;
      }
    };
    return;
  }
}

render();
`;
