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
let lastMessageAt = '';
let lastEventAt = '';
let projectsCollapsed = false;

// ── Shell ─────────────────────────────────────────────────────────────────────
// Created once after login. renderSidebar/renderMain swap content independently.

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
      const action = e.submitter?.value === 'register' ? 'register' : 'login';
      const errEl = document.getElementById('authError');
      try {
        const r = await api('/api/auth/' + action, { method: 'POST', body: { email: form.email.value, password: form.password.value } });
        const data = await r.json();
        if (!r.ok) { errEl.textContent = data.error || 'Failed'; errEl.classList.remove('hidden'); return; }
        setToken(data.token);
        render();
      } catch (err) { errEl.textContent = err.message; errEl.classList.remove('hidden'); }
    });
    return;
  }

  if (!document.getElementById('appShell')) {
    root.innerHTML = \`
      <div id="appShell" class="flex h-screen overflow-hidden">
        <aside id="sidebar" class="w-[32rem] border-r border-slate-700 flex flex-col shrink-0 overflow-hidden"></aside>
        <div id="mainContent" class="flex-1 overflow-hidden flex flex-col"></div>
      </div>
    \`;

    // Load projects then render
    (async () => {
      const r = await api('/api/projects');
      const data = await r.json();
      if (r.ok) projects = data.projects || [];
      renderSidebar();
    })();
  }

  renderSidebar();
  renderMain();
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

function renderSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  if (currentProjectId) {
    const proj = projects.find(p => p.id === currentProjectId) || { name: 'Project', status: '', deployed_url: '' };

    sidebar.innerHTML = \`
      <div class="flex flex-col h-full">
        <div class="shrink-0 border-b border-slate-700">
          <button id="backToDashboardBtn" class="w-full flex items-center gap-2 px-4 py-3 hover:bg-slate-800 text-left">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-slate-400"><polyline points="15 18 9 12 15 6"></polyline></svg>
            <span class="font-semibold text-sm truncate">\${proj.name}</span>
          </button>
        </div>
        <ul id="chatMessages" class="flex-1 overflow-auto p-3 space-y-3 text-sm"></ul>
        <div class="shrink-0 p-2 border-t border-slate-700">
          <textarea id="chatInput" rows="3" class="w-full px-3 py-2 rounded bg-slate-800 border border-slate-600 resize-none text-sm focus:outline-none focus:border-slate-400" placeholder="Ask for changes..."></textarea>
          <button id="sendBtn" class="mt-1 w-full px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-700 text-sm font-medium">Send</button>
        </div>
      </div>
    \`;

    document.getElementById('backToDashboardBtn').onclick = () => {
      currentProjectId = null;
      lastMessageAt = '';
      lastEventAt = '';
      renderSidebar();
      renderMain();
    };

    // Load chat history
    (async () => {
      const r = await api(\`/api/chat/\${currentProjectId}/history\`);
      const data = await r.json();
      const ul = document.getElementById('chatMessages');
      if (!ul) return;
      (data.messages || []).forEach(m => {
        const li = document.createElement('li');
        li.className = m.role === 'user' ? 'flex justify-end' : 'flex justify-start';
        const histBubble = document.createElement('div');
        histBubble.className = m.role === 'user'
          ? 'bg-blue-600 text-white px-3 py-2 rounded-2xl rounded-tr-sm max-w-[85%] text-sm'
          : 'bg-slate-700 text-slate-100 px-3 py-2 rounded-2xl rounded-tl-sm max-w-[85%] text-sm';
        histBubble.textContent = m.content?.slice(0, 300) + (m.content?.length > 300 ? '...' : '');
        li.appendChild(histBubble);
        ul.appendChild(li);
        if (m.created_at) lastMessageAt = m.created_at;
      });
      ul.scrollTop = ul.scrollHeight;
    })();

    // Send button logic
    const sendBtn = document.getElementById('sendBtn');
    const chatInput = document.getElementById('chatInput');
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendBtn.click(); }
    });

    sendBtn.onclick = async () => {
      const text = chatInput.value.trim();
      if (!text) return;
      const ul = document.getElementById('chatMessages');
      if (!ul) return;
      const capturedProjectId = currentProjectId;

      const userLi = document.createElement('li');
      userLi.className = 'flex justify-end';
      const userBubble = document.createElement('div');
      userBubble.className = 'bg-blue-600 text-white px-3 py-2 rounded-2xl rounded-tr-sm max-w-[85%] text-sm';
      userBubble.textContent = text;
      userLi.appendChild(userBubble);
      ul.appendChild(userLi);
      chatInput.value = '';
      sendBtn.disabled = true;
      ul.scrollTop = ul.scrollHeight;

      const thinkingLi = document.createElement('li');
      thinkingLi.className = 'text-left text-slate-500 italic';
      thinkingLi.textContent = 'Thinking.';
      ul.appendChild(thinkingLi);
      ul.scrollTop = ul.scrollHeight;
      let dotCount = 1;
      const ellipsisInterval = setInterval(() => {
        dotCount = (dotCount % 3) + 1;
        thinkingLi.textContent = 'Thinking' + '.'.repeat(dotCount);
      }, 500);
      let thinkingRemoved = false;
      function removeThinking() {
        if (!thinkingRemoved) {
          clearInterval(ellipsisInterval);
          thinkingLi.remove();
          thinkingRemoved = true;
        }
      }

      try {
        const res = await api('/api/chat', { method: 'POST', body: { project_id: capturedProjectId, message: text } });
        const data = await res.json();
        if (!res.ok) {
          removeThinking();
          const errLi = document.createElement('li');
          errLi.className = 'text-left text-red-400';
          errLi.textContent = data.error || 'Something went wrong';
          ul.appendChild(errLi);
          return;
        }

        const progressEls = [];
        const abortCtrl = new AbortController();
        let lastEvAt = lastEventAt;
        let progressBox = null;
        let progressList = null;
        let lastProgressItem = null;

        const handleMsg = async (msg) => {
          if (currentProjectId !== capturedProjectId) { abortCtrl.abort(); return; }

          if (msg.type === 'event') {
            removeThinking();

            if (!progressBox) {
              progressBox = document.createElement('li');
              progressBox.className = 'flex justify-start w-full';
              progressBox.innerHTML = \`<div class="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 w-full max-w-[85%]"><ul class="progress-steps space-y-1 text-xs"></ul></div>\`;
              ul.appendChild(progressBox);
              progressList = progressBox.querySelector('.progress-steps');
              progressEls.push(progressBox);
            }

            if (lastProgressItem) {
              lastProgressItem.innerHTML = \`<span class="text-slate-500 mr-1.5">✓</span><span class="text-slate-500">\${lastProgressItem.dataset.msg}</span>\`;
            }

            lastProgressItem = document.createElement('li');
            lastProgressItem.className = 'flex items-start';
            lastProgressItem.dataset.msg = msg.message;
            lastProgressItem.innerHTML = \`<span class="text-emerald-400 mr-1.5 shrink-0">→</span><span class="text-slate-200">\${msg.message}</span>\`;
            progressList.appendChild(lastProgressItem);

            lastEvAt = msg.created_at;
            lastEventAt = msg.created_at;
            ul.scrollTop = ul.scrollHeight;
          }

          if (msg.type === 'heartbeat' && msg.lastAt) {
            lastEvAt = msg.lastAt;
          }

          if (msg.type === 'status') {
            abortCtrl.abort();
            if (lastProgressItem) {
              lastProgressItem.innerHTML = \`<span class="text-slate-500 mr-1.5">✓</span><span class="text-slate-500">\${lastProgressItem.dataset.msg}</span>\`;
            }
            progressEls.forEach(el => el.remove());

            if (msg.status === 'deployed') {
              const deployedUrl = msg.deployed_url;
              if (deployedUrl) {
                const p = projects.find(x => x.id === capturedProjectId);
                if (p) { p.status = 'deployed'; p.deployed_url = deployedUrl; }
                const statusBar = document.getElementById('statusBar');
                if (statusBar) {
                  statusBar.innerHTML = \`<a id="openAppLink" href="\${deployedUrl}" target="_blank" class="flex items-center gap-2 px-4 py-1.5 rounded-full bg-emerald-700 hover:bg-emerald-600 text-xs font-semibold text-emerald-100 transition-colors"><span class="inline-block w-2 h-2 rounded-full bg-emerald-300"></span>Deployed — Open app ↗</a>\`;
                }
                const frame = document.getElementById('previewFrame');
                if (frame) frame.src = deployedUrl;
              }
            } else if (msg.status === 'error') {
              const errLi = document.createElement('li');
              errLi.className = 'text-left text-red-400';
              errLi.textContent = 'Build failed. Check messages above.';
              ul.appendChild(errLi);
            }

            removeThinking();

            // Fetch assistant message(s) saved after build
            try {
              const msgData = await (await api(\`/api/chat/\${capturedProjectId}/history?since=\${encodeURIComponent(lastMessageAt)}\`)).json();
              for (const m of (msgData.messages || [])) {
                if (m.role === 'assistant') {
                  const li = document.createElement('li');
                  li.className = 'flex justify-start';
                  const bubble = document.createElement('div');
                  bubble.className = 'bg-slate-700 text-slate-100 px-3 py-2 rounded-2xl rounded-tl-sm max-w-[85%] text-sm';
                  bubble.textContent = m.content?.slice(0, 500) + (m.content?.length > 500 ? '...' : '');
                  li.appendChild(bubble);
                  ul.appendChild(li);
                  lastMessageAt = m.created_at;
                }
              }
            } catch (_) {}
            ul.scrollTop = ul.scrollHeight;
          }
        };

        // Stream build events, reconnect if stream closes before terminal status
        while (!abortCtrl.signal.aborted) {
          try {
            const streamRes = await fetch(
              \`/api/projects/\${capturedProjectId}/stream?since=\${encodeURIComponent(lastEvAt)}\`,
              { headers: { Authorization: 'Bearer ' + getToken() }, signal: abortCtrl.signal }
            );
            if (!streamRes.ok || !streamRes.body) break;

            const reader = streamRes.body.getReader();
            const dec = new TextDecoder();
            let buf = '';
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += dec.decode(value, { stream: true });
              const lines = buf.split('\\n');
              buf = lines.pop();
              for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                try { await handleMsg(JSON.parse(line.slice(6))); } catch (_) {}
              }
            }
          } catch (e) {
            if (abortCtrl.signal.aborted) break;
            await new Promise(r => setTimeout(r, 1500)); // pause before reconnect
          }
        }
      } catch (err) {
        const errLi = document.createElement('li');
        errLi.className = 'text-left text-red-400';
        errLi.textContent = 'Error: ' + err.message;
        ul.appendChild(errLi);
      } finally {
        removeThinking();
        sendBtn.disabled = false;
        ul.scrollTop = ul.scrollHeight;
      }
    };

  } else {
    // Home sidebar — project list
    sidebar.innerHTML = \`
      <div class="flex flex-col h-full">
        <div class="p-4 border-b border-slate-700 flex justify-between items-center shrink-0">
          <h1 class="text-lg font-bold">App Builder</h1>
          <button id="logoutBtn" class="text-sm text-slate-400 hover:text-white">Logout</button>
        </div>
        <button id="projectsToggleBtn" class="shrink-0 flex items-center justify-between w-full px-4 py-2.5 text-xs font-semibold uppercase tracking-widest text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors">
          <span>Projects</span>
          <svg id="projectsChevron" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="transition-transform \${projectsCollapsed ? '-rotate-90' : ''}"><polyline points="6 9 12 15 18 9"></polyline></svg>
        </button>
        <ul id="projectList" class="flex-1 overflow-auto space-y-1 px-3 pr-0 text-sm \${projectsCollapsed ? 'hidden' : ''}"></ul>
      </div>
    \`;

    document.getElementById('logoutBtn').onclick = () => {
      setToken(null); currentProjectId = null; projects = [];
      document.getElementById('root').innerHTML = '';
      render();
    };

    document.getElementById('projectsToggleBtn').onclick = () => {
      projectsCollapsed = !projectsCollapsed;
      const list = document.getElementById('projectList');
      const chevron = document.getElementById('projectsChevron');
      if (list) list.classList.toggle('hidden', projectsCollapsed);
      if (chevron) chevron.classList.toggle('-rotate-90', projectsCollapsed);
    };

    renderProjectList();
  }
}

// ── Project list (home sidebar) ───────────────────────────────────────────────

function renderProjectList() {
  const list = document.getElementById('projectList');
  if (!list) return;

  list.innerHTML = projects.map(p => \`
    <li class="relative group">
      <button class="projectBtn w-full text-left px-2 py-1.5 pr-8 rounded truncate \${p.id === currentProjectId ? 'bg-slate-700 text-white' : 'hover:bg-slate-800'}" data-id="\${p.id}">\${p.name}</button>
      <button class="deleteBtn absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded text-slate-600 hover:text-red-400 hover:bg-slate-700 opacity-0 group-hover:opacity-100 transition-opacity" data-id="\${p.id}" title="Delete project">
        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6l-1 14H6L5 6"></path>
          <path d="M10 11v6"></path>
          <path d="M14 11v6"></path>
          <path d="M9 6V4h6v2"></path>
        </svg>
      </button>
    </li>
  \`).join('');

  list.querySelectorAll('.projectBtn').forEach(btn => {
    btn.onclick = () => {
      if (currentProjectId === btn.dataset.id) return;
      currentProjectId = btn.dataset.id;
      lastMessageAt = '';
      lastEventAt = '';
      renderSidebar();
      renderMain();
    };
  });

  list.querySelectorAll('.deleteBtn').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const li = btn.closest('li');
      const projectBtn = li.querySelector('.projectBtn');
      projectBtn.style.display = 'none';
      btn.style.display = 'none';
      const confirmEl = document.createElement('div');
      confirmEl.className = 'flex items-center gap-1 px-2 py-1 w-full';
      confirmEl.innerHTML = \`
        <span class="text-xs text-slate-400 truncate flex-1">Delete?</span>
        <button class="confirmYes px-2 py-0.5 rounded bg-red-600 hover:bg-red-700 text-xs text-white">Delete</button>
        <button class="confirmNo px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 text-xs text-white">Cancel</button>
      \`;
      li.appendChild(confirmEl);
      confirmEl.querySelector('.confirmNo').onclick = (e) => {
        e.stopPropagation();
        confirmEl.remove();
        projectBtn.style.display = '';
        btn.style.display = '';
      };
      confirmEl.querySelector('.confirmYes').onclick = async (e) => {
        e.stopPropagation();
        confirmEl.innerHTML = '<span class="text-xs text-slate-400 px-2">Deleting...</span>';
        const r = await api(\`/api/projects/\${id}\`, { method: 'DELETE' });
        if (r.ok) {
          projects = projects.filter(p => p.id !== id);
          if (currentProjectId === id) { currentProjectId = null; renderMain(); }
          li.remove();
        } else {
          confirmEl.remove();
          projectBtn.style.display = '';
          btn.style.display = '';
        }
      };
    };
  });
}

// ── Main content ──────────────────────────────────────────────────────────────

function renderMain() {
  const main = document.getElementById('mainContent');
  if (!main) return;

  if (!currentProjectId) {
    main.innerHTML = \`
      <div class="flex-1 flex items-center justify-center h-full">
        <div class="w-full max-w-2xl px-6 space-y-5">
          <h2 class="text-3xl font-bold text-center tracking-tight">What do you want to build?</h2>
          <div class="bg-slate-800 border border-slate-700 rounded-2xl shadow-lg focus-within:border-slate-500 transition-colors">
            <textarea id="homePrompt" rows="3" class="w-full bg-transparent px-5 pt-4 pb-2 resize-none text-sm focus:outline-none placeholder-slate-500" placeholder="Describe your app idea..."></textarea>
            <div class="flex justify-end px-4 pb-3">
              <button id="homeBuildBtn" class="px-5 py-2 rounded-full bg-emerald-600 hover:bg-emerald-700 text-sm font-semibold transition-colors">Build</button>
            </div>
          </div>
          <p class="text-xs text-slate-500 text-center">Press Enter or click Build</p>
        </div>
      </div>
    \`;

    const homePrompt = document.getElementById('homePrompt');
    const homeBuildBtn = document.getElementById('homeBuildBtn');

    async function startBuild() {
      const text = homePrompt.value.trim();
      if (!text) return;
      homeBuildBtn.disabled = true;
      homeBuildBtn.textContent = 'Creating...';
      const r = await api('/api/projects', { method: 'POST', body: { description: text } });
      const data = await r.json();
      if (!r.ok) { homeBuildBtn.disabled = false; homeBuildBtn.textContent = 'Build'; return; }
      projects.unshift(data.project);
      currentProjectId = data.project.id;
      lastMessageAt = '';
      lastEventAt = '';
      renderSidebar();
      renderMain();
      // Auto-send the prompt (sendBtn and chatInput are now in the sidebar)
      const sendBtn = document.getElementById('sendBtn');
      const chatInput = document.getElementById('chatInput');
      if (chatInput && sendBtn) { chatInput.value = text; sendBtn.click(); }
    }

    homeBuildBtn.onclick = startBuild;
    homePrompt.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); startBuild(); }
    });
    homePrompt.focus();
    return;
  }

  // Project view — full-width preview with status bar + deploy dropdown
  const proj = projects.find(p => p.id === currentProjectId) || { name: 'Project', status: '', deployed_url: '' };
  const isDeployed = proj.status === 'deployed' && !!proj.deployed_url;
  main.innerHTML = \`
    <div class="flex flex-col h-full">
      <div id="statusBar" class="shrink-0 px-4 py-2 border-b border-slate-700 flex items-center justify-center gap-3 text-sm">
        \${isDeployed ? \`
          <a id="openAppLink" href="\${proj.deployed_url}" target="_blank" class="flex items-center gap-2 px-4 py-1.5 rounded-full bg-emerald-700 hover:bg-emerald-600 text-xs font-semibold text-emerald-100 transition-colors">
            <span class="inline-block w-2 h-2 rounded-full bg-emerald-300"></span>Deployed — Open app ↗
          </a>
        \` : \`
          <div class="relative">
            <button id="deployMenuBtn" class="flex items-center gap-2 px-4 py-1.5 rounded-full bg-slate-700 hover:bg-slate-600 text-xs font-semibold text-slate-300 transition-colors">
              <span id="deployBtnDot" class="inline-block w-2 h-2 rounded-full bg-slate-500"></span>
              <span id="deployBtnLabel">Not Deployed</span> <span class="opacity-60">▾</span>
            </button>
            <div id="deployMenu" class="hidden absolute left-1/2 -translate-x-1/2 mt-1 bg-slate-800 border border-slate-700 rounded-lg shadow-xl z-20 overflow-hidden text-xs min-w-[8rem]">
              <button id="deployYes" class="w-full text-left px-4 py-2.5 hover:bg-slate-700 text-emerald-400 font-medium">Deploy now</button>
              <button id="deployNo" class="w-full text-left px-4 py-2.5 hover:bg-slate-700 text-slate-400">Cancel</button>
            </div>
          </div>
        \`}
      </div>
      <iframe id="previewFrame" class="flex-1 w-full border-0" src="\${proj.deployed_url || 'about:blank'}" title="Preview"></iframe>
    </div>
  \`;

  if (!isDeployed) {
    const deployMenuBtn = document.getElementById('deployMenuBtn');
    const deployMenu = document.getElementById('deployMenu');

    deployMenuBtn.onclick = (e) => {
      e.stopPropagation();
      deployMenu.classList.toggle('hidden');
    };
    document.addEventListener('click', () => deployMenu.classList.add('hidden'), { once: true });

    document.getElementById('deployNo').onclick = () => deployMenu.classList.add('hidden');

    document.getElementById('deployYes').onclick = async () => {
      deployMenu.classList.add('hidden');
      const projId = currentProjectId;
      deployMenuBtn.disabled = true;
      const dot = document.getElementById('deployBtnDot');
      const label = document.getElementById('deployBtnLabel');
      if (dot) dot.className = 'inline-block w-2 h-2 rounded-full bg-yellow-400 animate-pulse';
      if (label) label.textContent = 'Building...';

      try {
        await api(\`/api/projects/\${projId}/build\`, { method: 'POST' });
        for (let i = 0; i < 90; i++) {
          await new Promise(r => setTimeout(r, 2000));
          if (currentProjectId !== projId) break;
          const d = await (await api(\`/api/projects/\${projId}\`)).json();
          const s = d.project?.status;
          if (s === 'deployed' || s === 'error') {
            if (s === 'deployed' && d.project?.deployed_url) {
              const p = projects.find(x => x.id === projId);
              if (p) { p.status = 'deployed'; p.deployed_url = d.project.deployed_url; }
              // Swap button to green deployed pill
              const statusBar = document.getElementById('statusBar');
              if (statusBar) {
                statusBar.innerHTML = \`<a id="openAppLink" href="\${d.project.deployed_url}" target="_blank" class="flex items-center gap-2 px-4 py-1.5 rounded-full bg-emerald-700 hover:bg-emerald-600 text-xs font-semibold text-emerald-100 transition-colors"><span class="inline-block w-2 h-2 rounded-full bg-emerald-300"></span>Deployed — Open app ↗</a>\`;
              }
              const frame = document.getElementById('previewFrame');
              if (frame) frame.src = d.project.deployed_url;
            } else {
              deployMenuBtn.disabled = false;
              if (dot) dot.className = 'inline-block w-2 h-2 rounded-full bg-red-400';
              if (label) label.textContent = 'Not Deployed';
            }
            break;
          }
        }
      } catch {
        deployMenuBtn.disabled = false;
        if (dot) dot.className = 'inline-block w-2 h-2 rounded-full bg-slate-500';
        if (label) label.textContent = 'Not Deployed';
      }
    };
  }
}

render();
`;
