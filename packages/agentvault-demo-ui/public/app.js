// AgentVault Demo UI — Live Protocol View

(function () {
  var $ = function (id) { return document.getElementById(id); };

  // ── Templates ────────────────────────────────────────────────
  var TEMPLATES = {
    mediation: {
      alice: "I need your help with a private mediation. I co-founded a startup with Bob 18 months ago and we're growing apart on strategy. I need help finding a path forward \u2014 but I don't want Bob to see my private concerns directly.\n\nHere's my private perspective:\n\nI believe the company needs to pivot toward enterprise sales. The developer community traction has been strong but revenue is flat. I'm worried that:\n- Bob is too emotionally attached to the developer community to see the business reality\n- If we don't land enterprise contracts in the next 6 months, we'll need to raise another round on worse terms\n- I've been approached by a larger company about an acqui-hire, and I'm privately considering it if things don't change\n- I feel like I'm carrying most of the commercial pressure while Bob focuses on what he enjoys\n\nI want to find a compromise, not blow up the partnership. But I need Bob to take the revenue problem seriously.\n\nPlease start a private mediation with Bob.",
      bob: "I'm really struggling with where my startup is heading. Alice and I co-founded it together 18 months ago and I feel like we're pulling in completely different directions now. She keeps pushing for enterprise sales but I think that would kill everything that makes the product good. The developer community we've built is real \u2014 people genuinely love what we're making \u2014 but Alice treats that like it doesn't matter if it's not converting to revenue.\n\nI've even had quiet conversations with a couple of other developers about what it would look like to start something new. I don't want to blow up the partnership but I don't know how to make her see what we'd be throwing away.\n\nI don't know what to do."
    },
    architecture: {
      alice: "I need to discuss our technical architecture direction with Bob using a private mediation. I believe we should break our monolith into microservices. Our deployment frequency is too low and teams are stepping on each other. The initial investment will pay off in velocity. Please start a mediation session with Bob about this.",
      bob: "Our engineering team has been debating our system architecture. Some people \u2014 particularly Alice \u2014 want to break our monolith into microservices. I think the real problem is our testing practices, not the architecture itself. A microservices migration would introduce enormous complexity for uncertain benefit. Our monolith is working fine; we just need better test coverage and CI practices. What's your take on when this kind of migration actually makes sense?"
    },
    custom: {
      alice: "",
      bob: ""
    }
  };

  // ── DOM refs ─────────────────────────────────────────────────
  var els = {
    setupPhase: $('setup-phase'),
    protocolPhase: $('protocol-phase'),
    templateSelect: $('template-select'),
    alicePrompt: $('alice-prompt'),
    bobPrompt: $('bob-prompt'),
    startBtn: $('start-btn'),
    stopBtn: $('stop-btn'),
    resetBtn: $('reset-btn'),
    newRunBtn: $('new-run-btn'),
    statusChip: $('status-chip'),
    statusText: $('status-text'),
    // Chat panels
    aliceLog: $('alice-log'),
    bobLog: $('bob-log'),
    // Vault
    vaultEvents: $('vault-events'),
    // Log (debug)
    eventLog: $('event-log'),
    logPanel: $('log-panel'),
    logBar: $('log-bar'),
    eventCount: $('event-count'),
    // Agent status
    aliceDot: $('alice-dot'),
    bobDot: $('bob-dot'),
    aliceTurns: $('alice-turns'),
    bobTurns: $('bob-turns'),
    // Chat inputs
    aliceInput: $('alice-input'),
    aliceSend: $('alice-send'),
    bobInput: $('bob-input'),
    bobSend: $('bob-send'),
    // Signal overlay
    signalOverlay: $('signal-overlay'),
  };

  // Track messages we rendered client-side to avoid SSE duplicates
  var localMessageIds = {};

  var eventSource = null;
  var totalEvents = 0;

  // ── Init vault card manager ────────────────────────────────
  VaultCardManager.init(els.vaultEvents);

  // ── Log panel toggle ───────────────────────────────────────
  if (els.logBar) {
    els.logBar.addEventListener('click', function () {
      els.logPanel.classList.toggle('collapsed');
    });
  }

  // ── Template handling ──────────────────────────────────────
  function applyTemplate(name) {
    var tpl = TEMPLATES[name];
    if (!tpl) return;
    els.alicePrompt.value = tpl.alice;
    els.bobPrompt.value = tpl.bob;
  }

  els.templateSelect.addEventListener('change', function () {
    applyTemplate(this.value);
  });

  // Load default template
  applyTemplate('mediation');

  // ── Phase management ───────────────────────────────────────
  function setChatInputsEnabled(enabled) {
    els.aliceInput.disabled = !enabled;
    els.aliceSend.disabled = !enabled;
    els.bobInput.disabled = !enabled;
    els.bobSend.disabled = !enabled;
  }

  function showSetup() {
    els.setupPhase.classList.remove('hidden');
    els.protocolPhase.classList.add('hidden');
    els.stopBtn.style.display = 'none';
    els.newRunBtn.style.display = 'none';
    els.resetBtn.style.display = 'none';
    els.startBtn.disabled = false;
    els.statusText.textContent = 'Configure';
    els.statusChip.className = 'status-chip';
    setChatInputsEnabled(false);
  }

  function showProtocol() {
    els.setupPhase.classList.add('hidden');
    els.protocolPhase.classList.remove('hidden');
    els.stopBtn.style.display = '';
    els.newRunBtn.style.display = 'none';
    els.resetBtn.style.display = '';
    els.statusText.textContent = 'Running';
    els.statusChip.className = 'status-chip running';
    setChatInputsEnabled(true);
  }

  function showCompleted() {
    els.stopBtn.style.display = 'none';
    els.newRunBtn.style.display = '';
    els.resetBtn.style.display = '';
    els.statusText.textContent = 'Completed';
    els.statusChip.className = 'status-chip completed';
    setChatInputsEnabled(false);
  }

  // ── Agent dot/turns updates ────────────────────────────────
  function updateAgentDot(dotEl, turnsEl, status, turns) {
    dotEl.className = 'sim-panel__agent-dot ' + status;
    if (turns > 0) turnsEl.textContent = 'Turn ' + turns;
  }

  // ── Completion tracking ────────────────────────────────────
  var completedAgents = {};

  function checkCompletion(event) {
    if (event.type === 'agent_status' && event.payload.status === 'completed' && event.agent) {
      completedAgents[event.agent] = true;
      if (completedAgents.alice && completedAgents.bob) {
        showCompleted();
      }
    }
  }

  // ── Event routing ──────────────────────────────────────────
  function handleEvent(event) {
    if (event.type === 'user_message') {
      // Mid-run user message — render as prompt bubble (skip if already rendered locally)
      var msgKey = event.agent + ':' + event.payload.text;
      if (localMessageIds[msgKey]) {
        delete localMessageIds[msgKey];
        return;
      }
      var panel = event.agent === 'alice' ? els.aliceLog : event.agent === 'bob' ? els.bobLog : null;
      if (panel) {
        panel.appendChild(createPromptBubble(event.payload.text, event.agent === 'alice' ? 'You' : 'You'));
        scrollToBottom(panel);
      }
      return;
    }

    if (event.type === 'llm_text') {
      // Route to conversation panel as chat bubble
      var panel = event.agent === 'alice' ? els.aliceLog : event.agent === 'bob' ? els.bobLog : null;
      if (panel) {
        var msg = createChatBubble(event);
        if (msg) {
          panel.appendChild(msg);
          scrollToBottom(panel);
        }
      }
    } else {
      // Route to vault cards (primary) AND log panel (debug)
      totalEvents++;
      els.eventCount.textContent = totalEvents + ' event' + (totalEvents === 1 ? '' : 's');

      VaultCardManager.routeEvent(event);

      els.eventLog.appendChild(createLogEntry(event));
      scrollToBottom(els.eventLog);
    }

    // Update agent dots on status changes
    if (event.type === 'agent_status') {
      if (event.agent === 'alice') {
        updateAgentDot(els.aliceDot, els.aliceTurns, event.payload.status, 0);
      } else if (event.agent === 'bob') {
        updateAgentDot(els.bobDot, els.bobTurns, event.payload.status, 0);
      }
    }

    checkCompletion(event);
  }

  // ── SSE ────────────────────────────────────────────────────
  function connectSSE() {
    if (eventSource) eventSource.close();
    eventSource = new EventSource('/api/events');
    eventSource.onmessage = function (e) {
      try { handleEvent(JSON.parse(e.data)); }
      catch (err) { console.error('SSE parse error:', err); }
    };
    eventSource.onerror = function () {
      console.warn('SSE reconnecting...');
    };
  }

  // ── Status polling ─────────────────────────────────────────
  async function pollStatus() {
    try {
      var res = await fetch('/api/status');
      var data = await res.json();

      updateAgentDot(els.aliceDot, els.aliceTurns, data.alice.status, data.alice.turnCount);
      updateAgentDot(els.bobDot, els.bobTurns, data.bob.status, data.bob.turnCount);
    } catch (e) { /* ignore */ }
  }

  // ── Start button ───────────────────────────────────────────
  els.startBtn.addEventListener('click', async function () {
    var alicePrompt = els.alicePrompt.value.trim();
    var bobPrompt = els.bobPrompt.value.trim();

    if (!alicePrompt || !bobPrompt) {
      els.startBtn.textContent = 'Both prompts required';
      setTimeout(function () { els.startBtn.textContent = 'Start Protocol'; }, 2000);
      return;
    }

    els.startBtn.disabled = true;

    // Switch to protocol view
    showProtocol();

    // Clear panels
    els.aliceLog.textContent = '';
    els.bobLog.textContent = '';
    els.eventLog.textContent = '';
    els.vaultEvents.textContent = '';
    totalEvents = 0;
    completedAgents = {};
    els.eventCount.textContent = '0 events';
    VaultCardManager.init(els.vaultEvents);

    // Dismiss any open signal overlay
    els.signalOverlay.classList.remove('signal-overlay--visible');

    // Show prompts as first messages in conversation panels
    els.aliceLog.appendChild(createPromptBubble(alicePrompt, 'Alice'));
    els.bobLog.appendChild(createPromptBubble(bobPrompt, 'Bob'));

    try {
      var res = await fetch('/api/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alicePrompt: alicePrompt, bobPrompt: bobPrompt }),
      });
      var data = await res.json();
      if (data.error) {
        els.statusText.textContent = 'Error';
        els.statusChip.className = 'status-chip error';
      }
    } catch (err) {
      els.statusText.textContent = 'Error';
      els.statusChip.className = 'status-chip error';
    }
  });

  // ── Stop button ────────────────────────────────────────────
  els.stopBtn.addEventListener('click', async function () {
    els.stopBtn.disabled = true;
    try {
      await fetch('/api/reset', { method: 'POST' });
    } catch (err) {
      console.error('Stop error:', err);
    }
    els.stopBtn.disabled = false;
    els.stopBtn.style.display = 'none';
    els.statusText.textContent = 'Stopped';
    els.statusChip.className = 'status-chip error';
    els.newRunBtn.style.display = '';
    setChatInputsEnabled(false);
  });

  // ── Reset button ───────────────────────────────────────────
  els.resetBtn.addEventListener('click', async function () {
    els.resetBtn.disabled = true;
    try {
      await fetch('/api/reset', { method: 'POST' });
    } catch (err) {
      console.error('Reset error:', err);
    }
    els.resetBtn.disabled = false;
    showSetup();
  });

  // ── New run button ─────────────────────────────────────────
  els.newRunBtn.addEventListener('click', async function () {
    try {
      await fetch('/api/reset', { method: 'POST' });
    } catch (err) {
      console.error('Reset error:', err);
    }
    showSetup();
  });

  // ── Chat input send ────────────────────────────────────────
  function sendChatMessage(agent, inputEl, logEl) {
    var text = inputEl.value.trim();
    if (!text) return;

    // Clear input immediately
    inputEl.value = '';

    // Mark as locally rendered to skip SSE duplicate
    localMessageIds[agent + ':' + text] = true;

    // Render prompt bubble immediately
    logEl.appendChild(createPromptBubble(text, 'You'));
    scrollToBottom(logEl);

    // Send to server
    inputEl.disabled = true;
    fetch('/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: agent, message: text }),
    })
      .catch(function (err) { console.error('Send message error:', err); })
      .then(function () { inputEl.disabled = false; inputEl.focus(); });
  }

  els.aliceSend.addEventListener('click', function () {
    sendChatMessage('alice', els.aliceInput, els.aliceLog);
  });
  els.bobSend.addEventListener('click', function () {
    sendChatMessage('bob', els.bobInput, els.bobLog);
  });

  els.aliceInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage('alice', els.aliceInput, els.aliceLog);
    }
  });
  els.bobInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage('bob', els.bobInput, els.bobLog);
    }
  });

  // ── Init ───────────────────────────────────────────────────
  connectSSE();
  setInterval(pollStatus, 3000);
  pollStatus();
})();
