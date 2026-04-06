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
const lastEventAtMap = new Map();
let projectsCollapsed = false;
let userName = localStorage.getItem('userName') || '';
let showPreviewByDefault = localStorage.getItem('showPreview') !== 'false';
let darkMode = localStorage.getItem('darkMode') !== 'false';
let activeStreamAbort = null;
let queuedMessage = null;

// ── Build stream ──────────────────────────────────────────────────────────────
// Shared SSE stream handler used by sendBtn and auto-reconnect.

async function streamBuildEvents(projectId) {
  if (activeStreamAbort) activeStreamAbort.abort();
  const abortCtrl = new AbortController();
  activeStreamAbort = abortCtrl;

  let lastEvAt = lastEventAtMap.get(projectId) || '';
  let progressBox = null, progressList = null, lastProgressItem = null;

  const removeThinking = () => {
    const el = document.getElementById('thinkingIndicator');
    if (el) el.remove();
  };

  const handleMsg = async (msg) => {
    if (currentProjectId !== projectId) { abortCtrl.abort(); return; }
    const ul = document.getElementById('chatMessages');
    if (!ul) return;

    if (msg.type === 'event') {
      removeThinking();
      if (!progressBox) {
        progressBox = document.createElement('li');
        progressBox.className = 'flex justify-start w-full';
        progressBox.innerHTML = \`<div class="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 w-full max-w-[85%]"><ul class="progress-steps space-y-1 text-xs"></ul></div>\`;
        ul.appendChild(progressBox);
        progressList = progressBox.querySelector('.progress-steps');
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
      lastEventAtMap.set(projectId, msg.created_at);
      ul.scrollTop = ul.scrollHeight;
    }

    if (msg.type === 'heartbeat' && msg.lastAt) lastEvAt = msg.lastAt;

    if (msg.type === 'status') {
      abortCtrl.abort();
      removeThinking();
      if (lastProgressItem) {
        lastProgressItem.innerHTML = \`<span class="text-slate-500 mr-1.5">✓</span><span class="text-slate-500">\${lastProgressItem.dataset.msg}</span>\`;
      }
      if (progressBox) progressBox.remove();

      if (msg.status === 'deployed' && msg.deployed_url) {
        const p = projects.find(x => x.id === projectId);
        if (p) { p.status = 'deployed'; p.deployed_url = msg.deployed_url; }
        const statusBar = document.getElementById('statusBar');
        if (statusBar) statusBar.innerHTML = \`<a id="openAppLink" href="\${msg.deployed_url}" target="_blank" class="flex items-center gap-2 px-4 py-1.5 rounded-full bg-emerald-700 hover:bg-emerald-600 text-xs font-semibold text-emerald-100 transition-colors"><span class="inline-block w-2 h-2 rounded-full bg-emerald-300"></span>Deployed — Open app ↗</a>\`;
        const frame = document.getElementById('previewFrame');
        if (frame) frame.src = msg.deployed_url;
      } else if (msg.status === 'error') {
        const ul = document.getElementById('chatMessages');
        if (ul) { const e = document.createElement('li'); e.className = 'text-left text-red-400'; e.textContent = 'Build failed. Check messages above.'; ul.appendChild(e); }
      }

      // Fetch new assistant messages
      try {
        const msgData = await (await api(\`/api/chat/\${projectId}/history?since=\${encodeURIComponent(lastMessageAt)}\`)).json();
        const ul = document.getElementById('chatMessages');
        for (const m of (msgData.messages || [])) {
          if (m.role === 'assistant' && ul) {
            const li = document.createElement('li'); li.className = 'flex justify-start';
            const bubble = document.createElement('div');
            bubble.className = 'bg-slate-700 text-slate-100 px-3 py-2 rounded-2xl rounded-tl-sm max-w-[85%] text-sm';
            bubble.textContent = m.content?.slice(0, 500) + (m.content?.length > 500 ? '...' : '');
            li.appendChild(bubble); ul.appendChild(li);
            lastMessageAt = m.created_at;
          }
        }
        if (ul) ul.scrollTop = ul.scrollHeight;
      } catch (_) {}

      const sendBtn = document.getElementById('sendBtn');
      if (sendBtn) sendBtn.disabled = false;

      // Fire queued message if one is waiting
      if (queuedMessage && currentProjectId === projectId) {
        const queued = queuedMessage;
        queuedMessage = null;
        document.getElementById('queuedBubble')?.remove();
        const chatInput = document.getElementById('chatInput');
        if (chatInput && sendBtn) { chatInput.value = queued; sendBtn.click(); }
      }
    }
  };

  while (!abortCtrl.signal.aborted) {
    try {
      const streamRes = await fetch(
        \`/api/projects/\${projectId}/stream?since=\${encodeURIComponent(lastEvAt)}\`,
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
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  const sendBtn = document.getElementById('sendBtn');
  if (sendBtn) sendBtn.disabled = false;
}

function showThinkingIndicator() {
  const ul = document.getElementById('chatMessages');
  if (!ul || document.getElementById('thinkingIndicator')) return;
  const li = document.createElement('li');
  li.id = 'thinkingIndicator';
  li.className = 'text-left text-slate-500 italic';
  li.textContent = 'Thinking.';
  ul.appendChild(li);
  ul.scrollTop = ul.scrollHeight;
  let dotCount = 1;
  const interval = setInterval(() => {
    if (!li.isConnected) { clearInterval(interval); return; }
    dotCount = (dotCount % 3) + 1;
    li.textContent = 'Thinking' + '.'.repeat(dotCount);
  }, 500);
}

// ── Shell ─────────────────────────────────────────────────────────────────────
// Created once after login. renderSidebar/renderMain swap content independently.

function render() {
  const root = document.getElementById('root');
  const token = getToken();

  if (!token) {
    root.innerHTML = \`
      <style>
        @keyframes drift {
          0%   { transform: translateY(100vh) translateX(0);    opacity: 0; }
          10%  { opacity: 1; }
          90%  { opacity: 1; }
          100% { transform: translateY(-100px) translateX(40px); opacity: 0; }
        }
        .particle { position: absolute; width: 2px; height: 2px; border-radius: 50%; background: rgba(255,255,255,0.6); animation: drift linear infinite; pointer-events: none; }
        #authSlider { display: flex; width: 200%; transition: transform 0.45s cubic-bezier(0.4, 0, 0.2, 1); }
        #authSlider.show-register { transform: translateX(-50%); }
        .auth-panel { width: 50%; display: flex; align-items: center; justify-content: center; padding: 1.5rem; }
      </style>
      <div class="relative min-h-screen bg-slate-950 flex items-center justify-center overflow-hidden">
        <div id="particles" class="absolute inset-0 z-0"></div>
        <div class="relative z-10 w-full max-w-sm overflow-hidden">
          <div id="authSlider">

            <!-- Login panel -->
            <div class="auth-panel">
              <div class="w-full space-y-6">
                <div class="text-center space-y-1">
                  <h1 class="text-4xl font-bold tracking-tight text-white">Welcome to</h1>
                  <h2 class="text-4xl font-bold tracking-tight text-emerald-400">App Builder</h2>
                  <p class="text-slate-400 text-sm pt-1">Describe an idea. Ship an app.</p>
                </div>
                <form id="loginForm" class="space-y-3">
                  <input type="email" id="loginEmail" placeholder="Email" class="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-sm focus:outline-none focus:border-slate-500 text-white placeholder-slate-500" />
                  <input type="password" id="loginPassword" placeholder="Password" class="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-sm focus:outline-none focus:border-slate-500 text-white placeholder-slate-500" />
                  <button type="submit" class="w-full py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-semibold transition-colors">Log in</button>
                </form>
                <p id="loginError" class="text-red-400 text-xs hidden"></p>
                <div class="flex items-center gap-3">
                  <div class="flex-1 h-px bg-slate-700"></div>
                  <span class="text-slate-500 text-xs">or</span>
                  <div class="flex-1 h-px bg-slate-700"></div>
                </div>
                <button id="openRegisterBtn" class="w-full py-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-sm font-semibold transition-colors text-slate-200">Create an account</button>
              </div>
            </div>

            <!-- Register panel -->
            <div class="auth-panel">
              <div class="w-full space-y-6">
                <div class="text-center space-y-1">
                  <h2 class="text-3xl font-bold tracking-tight text-white">Create account</h2>
                  <p class="text-slate-400 text-sm">Get started for free</p>
                </div>
                <form id="registerForm" class="space-y-3">
                  <input type="email" id="regEmail" placeholder="Email" class="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-sm focus:outline-none focus:border-slate-500 text-white placeholder-slate-500" />
                  <input type="password" id="regPassword" placeholder="Password (min. 8 characters)" class="w-full px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-sm focus:outline-none focus:border-slate-500 text-white placeholder-slate-500" />
                  <button type="submit" class="w-full py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-semibold transition-colors">Create account</button>
                </form>
                <p id="registerError" class="text-red-400 text-xs hidden"></p>
                <button id="backToLoginBtn" class="w-full text-slate-400 hover:text-white text-sm transition-colors">← Back to log in</button>
              </div>
            </div>

          </div>
        </div>
      </div>
    \`;

    // Particles
    const container = document.getElementById('particles');
    for (let i = 0; i < 18; i++) {
      const p = document.createElement('div');
      p.className = 'particle';
      p.style.left = Math.random() * 100 + '%';
      p.style.animationDuration = (6 + Math.random() * 8) + 's';
      p.style.animationDelay = (Math.random() * 8) + 's';
      container.appendChild(p);
    }

    const slider = document.getElementById('authSlider');

    // Slide to register
    document.getElementById('openRegisterBtn').onclick = () => {
      slider.classList.add('show-register');
      setTimeout(() => document.getElementById('regEmail').focus(), 450);
    };

    // Slide back to login
    document.getElementById('backToLoginBtn').onclick = () => {
      slider.classList.remove('show-register');
    };

    // Login
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.getElementById('loginError');
      errEl.classList.add('hidden');
      try {
        const r = await api('/api/auth/login', { method: 'POST', body: { email: document.getElementById('loginEmail').value, password: document.getElementById('loginPassword').value } });
        const data = await r.json();
        if (!r.ok) { errEl.textContent = data.error || 'Login failed'; errEl.classList.remove('hidden'); return; }
        setToken(data.token);
        render();
      } catch (err) { errEl.textContent = err.message; errEl.classList.remove('hidden'); }
    });

    // Register
    document.getElementById('registerForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.getElementById('registerError');
      errEl.classList.add('hidden');
      try {
        const r = await api('/api/auth/register', { method: 'POST', body: { email: document.getElementById('regEmail').value, password: document.getElementById('regPassword').value } });
        const data = await r.json();
        if (!r.ok) { errEl.textContent = data.error || 'Registration failed'; errEl.classList.remove('hidden'); return; }
        setToken(data.token);
        render();
      } catch (err) { errEl.textContent = err.message; errEl.classList.remove('hidden'); }
    });

    return;
  }

  if (!document.getElementById('appShell')) {
    root.innerHTML = \`
      <div id="appShell" class="flex h-screen overflow-hidden relative \${darkMode ? '' : 'light-mode'}">
        <!-- Mini sidebar -->
        <div id="miniSidebar" class="w-12 border-r border-slate-700 bg-slate-900 flex flex-col items-center py-3 shrink-0 z-10">
          <div class="mt-auto flex flex-col items-center gap-1 pb-2">
            <button id="gearBtn" title="Menu" class="text-slate-400 hover:text-white p-2 rounded-lg hover:bg-slate-700 transition-colors">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
            </button>
            <div id="gearMenu" class="hidden absolute bottom-12 left-2 w-44 bg-slate-800 border border-slate-700 rounded-lg shadow-xl z-20 overflow-hidden text-sm">
              <button id="profileMenuBtn" class="w-full text-left px-4 py-2.5 hover:bg-slate-700 text-slate-200">Profile</button>
              <button id="settingsMenuBtn" class="w-full text-left px-4 py-2.5 hover:bg-slate-700 text-slate-200">Settings</button>
              <div class="border-t border-slate-700"></div>
              <button id="logoutBtn" class="w-full text-left px-4 py-2.5 hover:bg-slate-700 text-red-400">Log out</button>
            </div>
          </div>
        </div>
        <!-- Resizable project sidebar -->
        <aside id="sidebar" class="border-r border-slate-700 flex flex-col shrink-0 overflow-hidden" style="width:320px;min-width:180px;max-width:600px;"></aside>
        <div id="sidebarResizer" class="w-1 cursor-col-resize bg-transparent hover:bg-slate-600 transition-colors shrink-0 z-10"></div>
        <div id="mainContent" class="flex-1 overflow-hidden flex flex-col"></div>
        <!-- Modal backdrop -->
        <div id="modalBackdrop" class="hidden fixed inset-0 bg-black/50 z-40 flex items-center justify-center"></div>
      </div>
    \`;

    // Gear menu
    document.getElementById('gearBtn').onclick = (e) => {
      e.stopPropagation();
      document.getElementById('gearMenu').classList.toggle('hidden');
    };
    document.addEventListener('click', () => document.getElementById('gearMenu')?.classList.add('hidden'), { once: true });
    document.getElementById('profileMenuBtn').onclick = () => {
      document.getElementById('gearMenu').classList.add('hidden');
      openProfileModal();
    };
    document.getElementById('settingsMenuBtn').onclick = () => {
      document.getElementById('gearMenu').classList.add('hidden');
      openSettingsModal();
    };
    document.getElementById('logoutBtn').onclick = () => {
      setToken(null); currentProjectId = null; projects = [];
      document.getElementById('root').innerHTML = '';
      render();
    };

    // Resizable sidebar
    const resizer = document.getElementById('sidebarResizer');
    const sidebar = document.getElementById('sidebar');
    let isResizing = false;
    resizer.addEventListener('mousedown', (e) => {
      isResizing = true;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      const miniW = document.getElementById('miniSidebar').offsetWidth;
      const newW = Math.min(600, Math.max(180, e.clientX - miniW));
      sidebar.style.width = newW + 'px';
      localStorage.setItem('sidebarWidth', newW);
    });
    document.addEventListener('mouseup', () => {
      isResizing = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
    const savedW = localStorage.getItem('sidebarWidth');
    if (savedW) sidebar.style.width = savedW + 'px';

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

      // If a build is already running, queue the message instead
      const proj = projects.find(p => p.id === capturedProjectId);
      if (proj?.status === 'building' || proj?.status === 'thinking') {
        queuedMessage = text;
        chatInput.value = '';
        document.getElementById('queuedBubble')?.remove();
        const qLi = document.createElement('li');
        qLi.id = 'queuedBubble';
        qLi.className = 'flex justify-end';
        qLi.innerHTML = \`<div class="bg-slate-700 text-slate-400 px-3 py-2 rounded-2xl rounded-tr-sm max-w-[85%] text-sm border border-slate-600"><span class="text-xs text-slate-500 block mb-0.5">Queued</span>\${text}</div>\`;
        ul.appendChild(qLi);
        ul.scrollTop = ul.scrollHeight;
        return;
      }

      // Optimistic user bubble
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

      showThinkingIndicator();

      try {
        const res = await api('/api/chat', { method: 'POST', body: { project_id: capturedProjectId, message: text } });
        const data = await res.json();
        if (!res.ok) {
          document.getElementById('thinkingIndicator')?.remove();
          const errLi = document.createElement('li');
          errLi.className = 'text-left text-red-400';
          errLi.textContent = data.error || 'Something went wrong';
          ul.appendChild(errLi);
          sendBtn.disabled = false;
          return;
        }
        if (proj) proj.status = 'thinking';
        await streamBuildEvents(capturedProjectId);
      } catch (err) {
        document.getElementById('thinkingIndicator')?.remove();
        const errLi = document.createElement('li');
        errLi.className = 'text-left text-red-400';
        errLi.textContent = 'Error: ' + err.message;
        ul.appendChild(errLi);
        sendBtn.disabled = false;
        ul.scrollTop = ul.scrollHeight;
      }
    };

  } else {
    // Home sidebar — project list
    sidebar.innerHTML = \`
      <div class="flex flex-col h-full">
        <div class="px-4 py-3 border-b border-slate-700 shrink-0">
          <h1 class="text-lg font-bold">App Builder</h1>
        </div>
        <button id="projectsToggleBtn" class="shrink-0 flex items-center justify-between w-full px-4 py-2.5 text-xs font-semibold uppercase tracking-widest text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors">
          <span>Projects</span>
          <svg id="projectsChevron" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="transition-transform \${projectsCollapsed ? '-rotate-90' : ''}"><polyline points="6 9 12 15 18 9"></polyline></svg>
        </button>
        <div id="projectSearchWrap" class="px-3 pb-2 shrink-0 \${projectsCollapsed ? 'hidden' : ''}">
          <div class="relative">
            <input id="projectSearch" type="text" placeholder="Search projects..." class="w-full pl-3 pr-7 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-sm focus:outline-none focus:border-slate-500 placeholder-slate-500" />
            <button id="projectSearchClear" class="hidden absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 text-xs">✕</button>
          </div>
        </div>
        <ul id="projectList" class="flex-1 overflow-auto space-y-1 px-3 pr-0 text-sm \${projectsCollapsed ? 'hidden' : ''}"></ul>
      </div>
    \`;

    document.getElementById('projectsToggleBtn').onclick = () => {
      projectsCollapsed = !projectsCollapsed;
      const list = document.getElementById('projectList');
      const chevron = document.getElementById('projectsChevron');
      const searchWrap = document.getElementById('projectSearchWrap');
      if (list) list.classList.toggle('hidden', projectsCollapsed);
      if (chevron) chevron.classList.toggle('-rotate-90', projectsCollapsed);
      if (searchWrap) searchWrap.classList.toggle('hidden', projectsCollapsed);
    };

    document.getElementById('projectSearch').oninput = (e) => {
      const q = e.target.value.toLowerCase();
      document.getElementById('projectSearchClear').classList.toggle('hidden', !q);
      document.querySelectorAll('#projectList li').forEach(li => {
        const name = li.querySelector('.projectBtn')?.textContent?.toLowerCase() || '';
        li.style.display = name.includes(q) ? '' : 'none';
      });
    };

    document.getElementById('projectSearchClear').onclick = () => {
      document.getElementById('projectSearch').value = '';
      document.getElementById('projectSearchClear').classList.add('hidden');
      document.querySelectorAll('#projectList li').forEach(li => li.style.display = '');
    };

    renderProjectList();
  }
}

// ── Modals (Profile + Settings) ───────────────────────────────────────────────

function getEmailFromToken() {
  try {
    const token = getToken();
    if (!token) return '';
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.email || '';
  } catch { return ''; }
}

function openModal(contentHtml, onReady) {
  const backdrop = document.getElementById('modalBackdrop');
  backdrop.innerHTML = \`
    <div id="modalCard" class="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-md mx-4 max-h-[85vh] flex flex-col animate-modal-in">
      \${contentHtml}
    </div>
  \`;
  backdrop.classList.remove('hidden');
  backdrop.onclick = (e) => { if (e.target === backdrop) closeModal(); };
  if (onReady) onReady();
}

function closeModal() {
  const backdrop = document.getElementById('modalBackdrop');
  if (backdrop) backdrop.classList.add('hidden');
}

async function openProfileModal() {
  const email = getEmailFromToken();
  // Fetch account info (created_at)
  let createdAt = '';
  try {
    const r = await api('/api/auth/me');
    const d = await r.json();
    if (d.user?.created_at) createdAt = new Date(d.user.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  } catch {}

  openModal(\`
    <div class="flex items-center justify-between px-6 py-4 border-b border-slate-700 shrink-0">
      <h2 class="font-semibold text-base">Profile</h2>
      <button id="closeModalBtn" class="text-slate-400 hover:text-white p-1 rounded hover:bg-slate-700 transition-colors">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>
    </div>
    <div class="flex-1 overflow-auto p-6 space-y-6">
      <div class="space-y-3">
        <h3 class="text-xs font-semibold uppercase tracking-widest text-slate-400">Account</h3>
        <div>
          <label class="block text-xs text-slate-400 mb-1">Email</label>
          <div class="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm text-slate-300">\${email}</div>
        </div>
        \${createdAt ? \`<div><label class="block text-xs text-slate-400 mb-1">Member since</label><div class="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm text-slate-300">\${createdAt}</div></div>\` : ''}
        <div>
          <label class="block text-xs text-slate-400 mb-1">Display name</label>
          <input id="profileNameInput" type="text" value="\${userName}" placeholder="e.g. Ariel" maxlength="40"
            class="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm focus:outline-none focus:border-slate-500" />
          <p id="nameSavedMsg" class="text-xs text-emerald-400 mt-1 hidden">Saved</p>
        </div>
      </div>
      <div class="space-y-3">
        <h3 class="text-xs font-semibold uppercase tracking-widest text-slate-400">Change password</h3>
        <input id="currentPw" type="password" placeholder="Current password"
          class="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm focus:outline-none focus:border-slate-500" />
        <input id="newPw" type="password" placeholder="New password (min. 8 characters)"
          class="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm focus:outline-none focus:border-slate-500" />
        <button id="changePwBtn" class="w-full px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-sm font-medium transition-colors">Update password</button>
        <p id="pwMsg" class="text-xs hidden"></p>
      </div>
      <div class="space-y-3 pt-2 border-t border-slate-700">
        <h3 class="text-xs font-semibold uppercase tracking-widest text-red-400">Danger zone</h3>
        <button id="deleteAccountBtn" class="w-full px-4 py-2 rounded-lg bg-red-900/40 hover:bg-red-900/70 border border-red-800 text-sm font-medium text-red-400 transition-colors">Delete account</button>
        <p id="deleteAccountMsg" class="text-xs hidden"></p>
      </div>
    </div>
  \`, () => {
    document.getElementById('closeModalBtn').onclick = closeModal;

    document.getElementById('profileNameInput').onblur = (e) => {
      userName = e.target.value.trim();
      localStorage.setItem('userName', userName);
      const heading = document.getElementById('welcomeHeading');
      if (heading) heading.textContent = userName ? \`What do you want to build, \${userName}?\` : 'What do you want to build?';
      const msg = document.getElementById('nameSavedMsg');
      if (msg) { msg.classList.remove('hidden'); setTimeout(() => msg.classList.add('hidden'), 2000); }
    };

    document.getElementById('changePwBtn').onclick = async () => {
      const btn = document.getElementById('changePwBtn');
      const msg = document.getElementById('pwMsg');
      btn.disabled = true; btn.textContent = 'Updating...'; msg.className = 'text-xs hidden';
      try {
        const r = await api('/api/auth/change-password', { method: 'POST', body: { currentPassword: document.getElementById('currentPw').value, newPassword: document.getElementById('newPw').value } });
        const data = await r.json();
        if (r.ok) { msg.textContent = 'Password updated.'; msg.className = 'text-xs text-emerald-400'; document.getElementById('currentPw').value = ''; document.getElementById('newPw').value = ''; }
        else { msg.textContent = data.error || 'Failed.'; msg.className = 'text-xs text-red-400'; }
      } catch { msg.textContent = 'Something went wrong.'; msg.className = 'text-xs text-red-400'; }
      finally { btn.disabled = false; btn.textContent = 'Update password'; }
    };

    document.getElementById('deleteAccountBtn').onclick = async () => {
      const msg = document.getElementById('deleteAccountMsg');
      const btn = document.getElementById('deleteAccountBtn');
      if (btn.dataset.confirm !== 'yes') {
        btn.textContent = 'Tap again to confirm deletion';
        btn.dataset.confirm = 'yes';
        return;
      }
      btn.disabled = true; btn.textContent = 'Deleting...';
      try {
        const r = await api('/api/auth/account', { method: 'DELETE' });
        if (r.ok) { setToken(null); document.getElementById('root').innerHTML = ''; render(); }
        else { const d = await r.json(); msg.textContent = d.error || 'Failed.'; msg.className = 'text-xs text-red-400'; btn.disabled = false; btn.textContent = 'Delete account'; }
      } catch { msg.textContent = 'Something went wrong.'; msg.className = 'text-xs text-red-400'; btn.disabled = false; btn.textContent = 'Delete account'; }
    };
  });
}

function openSettingsModal() {
  openModal(\`
    <div class="flex items-center justify-between px-6 py-4 border-b border-slate-700 shrink-0">
      <h2 class="font-semibold text-base">Settings</h2>
      <button id="closeModalBtn" class="text-slate-400 hover:text-white p-1 rounded hover:bg-slate-700 transition-colors">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>
    </div>
    <div class="flex-1 overflow-auto p-6 space-y-6">
      <div class="space-y-4">
        <h3 class="text-xs font-semibold uppercase tracking-widest text-slate-400">Appearance</h3>
        <div class="flex items-center justify-between">
          <div>
            <div class="text-sm font-medium">Dark mode</div>
            <div class="text-xs text-slate-400 mt-0.5">Light mode coming soon</div>
          </div>
          <button id="darkModeToggle" class="relative w-11 h-6 rounded-full transition-colors \${darkMode ? 'bg-emerald-600' : 'bg-slate-600'}">
            <span class="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform \${darkMode ? 'translate-x-5' : ''}"></span>
          </button>
        </div>
      </div>
      <div class="space-y-4 border-t border-slate-700 pt-4">
        <h3 class="text-xs font-semibold uppercase tracking-widest text-slate-400">Builder</h3>
        <div class="flex items-center justify-between">
          <div>
            <div class="text-sm font-medium">Show preview by default</div>
            <div class="text-xs text-slate-400 mt-0.5">Auto-load preview iframe when opening a project</div>
          </div>
          <button id="previewToggle" class="relative w-11 h-6 rounded-full transition-colors \${showPreviewByDefault ? 'bg-emerald-600' : 'bg-slate-600'}">
            <span class="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform \${showPreviewByDefault ? 'translate-x-5' : ''}"></span>
          </button>
        </div>
      </div>
      <div class="space-y-4 border-t border-slate-700 pt-4">
        <h3 class="text-xs font-semibold uppercase tracking-widest text-slate-400">Export</h3>
        <div class="text-xs text-slate-400">Download the generated source files for a project.</div>
        \${projects.length === 0 ? '<p class="text-xs text-slate-500">No projects yet.</p>' : \`
          <select id="exportSelect" class="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm text-slate-200 focus:outline-none focus:border-slate-500">
            <option value="">Select a project...</option>
            \${projects.map(p => \`<option value="\${p.id}" data-name="\${p.name}">\${p.name}</option>\`).join('')}
          </select>
          <button id="exportBtn" class="w-full px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-sm font-medium transition-colors">Export files</button>
          <p id="exportMsg" class="text-xs hidden"></p>
        \`}
      </div>
    </div>
  \`, () => {
    document.getElementById('closeModalBtn').onclick = closeModal;

    document.getElementById('darkModeToggle').onclick = () => {
      darkMode = !darkMode;
      localStorage.setItem('darkMode', darkMode);
      const shell = document.getElementById('appShell');
      if (shell) shell.classList.toggle('light-mode', !darkMode);
      const btn = document.getElementById('darkModeToggle');
      btn.className = \`relative w-11 h-6 rounded-full transition-colors \${darkMode ? 'bg-emerald-600' : 'bg-slate-600'}\`;
      btn.querySelector('span').className = \`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform \${darkMode ? 'translate-x-5' : ''}\`;
    };

    document.getElementById('previewToggle').onclick = () => {
      showPreviewByDefault = !showPreviewByDefault;
      localStorage.setItem('showPreview', showPreviewByDefault);
      const btn = document.getElementById('previewToggle');
      btn.className = \`relative w-11 h-6 rounded-full transition-colors \${showPreviewByDefault ? 'bg-emerald-600' : 'bg-slate-600'}\`;
      btn.querySelector('span').className = \`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform \${showPreviewByDefault ? 'translate-x-5' : ''}\`;
    };

    const exportBtn = document.getElementById('exportBtn');
    if (exportBtn) {
      exportBtn.onclick = async () => {
        const select = document.getElementById('exportSelect');
        const projectId = select.value;
        const projectName = select.options[select.selectedIndex]?.dataset.name || 'project';
        const msg = document.getElementById('exportMsg');
        if (!projectId) { msg.textContent = 'Please select a project.'; msg.className = 'text-xs text-red-400'; return; }
        exportBtn.disabled = true; exportBtn.textContent = 'Exporting...'; msg.className = 'text-xs hidden';
        try {
          const files = ['worker.js', 'index.html', 'migration.sql'];
          let downloaded = 0;
          for (const file of files) {
            const r = await fetch(\`/api/projects/\${projectId}/file/\${file}\`, { headers: { Authorization: 'Bearer ' + getToken() } });
            if (!r.ok) continue;
            const text = await r.text();
            const blob = new Blob([text], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = \`\${projectName.replace(/[^a-zA-Z0-9]+/g, '-')}-\${file}\`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 5000);
            downloaded++;
            await new Promise(res => setTimeout(res, 300));
          }
          msg.textContent = \`\${downloaded} file\${downloaded !== 1 ? 's' : ''} downloaded.\`;
          msg.className = 'text-xs text-emerald-400';
        } catch { msg.textContent = 'Export failed.'; msg.className = 'text-xs text-red-400'; }
        finally { exportBtn.disabled = false; exportBtn.textContent = 'Export files'; }
      };
    }
  });
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
          <h2 id="welcomeHeading" class="text-3xl font-bold text-center tracking-tight">\${userName ? \`What do you want to build, \${userName}?\` : 'What do you want to build?'}</h2>
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
