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
    resetBtn: $('reset-btn'),
    newRunBtn: $('new-run-btn'),
    statusChip: $('status-chip'),
    statusText: $('status-text'),
    aliceLog: $('alice-log'),
    bobLog: $('bob-log'),
    eventLog: $('event-log'),
    aliceDot: $('alice-dot'),
    bobDot: $('bob-dot'),
    aliceTurns: $('alice-turns'),
    bobTurns: $('bob-turns'),
    alicePanel: $('alice-panel'),
    bobPanel: $('bob-panel'),
    channel: $('channel'),
    eventCount: $('event-count'),
  };

  var eventSource = null;
  var totalEvents = 0;

  // ── Template handling ────────────────────────────────────────
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

  // ── Phase management ─────────────────────────────────────────
  function showSetup() {
    els.setupPhase.classList.remove('hidden');
    els.protocolPhase.classList.add('hidden');
    els.newRunBtn.style.display = 'none';
    els.resetBtn.style.display = 'none';
    els.startBtn.disabled = false;
    els.statusText.textContent = 'Configure';
    els.statusChip.className = 'status-chip';
  }

  function showProtocol() {
    els.setupPhase.classList.add('hidden');
    els.protocolPhase.classList.remove('hidden');
    els.newRunBtn.style.display = 'none';
    els.resetBtn.style.display = '';
    els.channel.classList.add('active');
    els.alicePanel.classList.add('active');
    els.bobPanel.classList.add('active');
    els.statusText.textContent = 'Running';
    els.statusChip.className = 'status-chip running';
  }

  function showCompleted() {
    els.channel.classList.remove('active');
    els.alicePanel.classList.remove('active');
    els.bobPanel.classList.remove('active');
    els.newRunBtn.style.display = '';
    els.resetBtn.style.display = '';
    els.statusText.textContent = 'Completed';
    els.statusChip.className = 'status-chip completed';
  }

  // ── Agent dot/turns updates ──────────────────────────────────
  function updateAgentDot(dotEl, turnsEl, panelEl, status, turns) {
    dotEl.className = 'agent-dot ' + status;
    if (turns > 0) turnsEl.textContent = 'Turn ' + turns;
    if (status === 'running') {
      panelEl.classList.add('active');
    } else if (status === 'completed' || status === 'idle') {
      panelEl.classList.remove('active');
    }
  }

  // ── Event routing ────────────────────────────────────────────
  // Conversation (llm_text) → agent panels
  // Protocol (tool_call, tool_result, agent_status, system, error) → log

  function handleEvent(event) {
    if (event.type === 'llm_text') {
      // Route to conversation panel only
      var panel = event.agent === 'alice' ? els.aliceLog : event.agent === 'bob' ? els.bobLog : null;
      if (panel) {
        var msg = createConvMessage(event);
        if (msg) {
          panel.appendChild(msg);
          scrollToBottom(panel);
        }
      }
    } else {
      // Route to protocol log only
      totalEvents++;
      els.eventCount.textContent = totalEvents + ' event' + (totalEvents === 1 ? '' : 's');
      els.eventLog.appendChild(createLogEntry(event));
      scrollToBottom(els.eventLog);
    }

    // Update agent dots on status changes
    if (event.type === 'agent_status') {
      if (event.agent === 'alice') {
        updateAgentDot(els.aliceDot, els.aliceTurns, els.alicePanel, event.payload.status, 0);
      } else if (event.agent === 'bob') {
        updateAgentDot(els.bobDot, els.bobTurns, els.bobPanel, event.payload.status, 0);
      }
    }
  }

  // ── SSE ──────────────────────────────────────────────────────
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

  // ── Status polling ───────────────────────────────────────────
  async function pollStatus() {
    try {
      var res = await fetch('/api/status');
      var data = await res.json();

      updateAgentDot(els.aliceDot, els.aliceTurns, els.alicePanel, data.alice.status, data.alice.turnCount);
      updateAgentDot(els.bobDot, els.bobTurns, els.bobPanel, data.bob.status, data.bob.turnCount);
    } catch (e) { /* ignore */ }
  }

  // ── Start button ─────────────────────────────────────────────
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
    totalEvents = 0;
    els.eventCount.textContent = '0 events';

    // Show prompts as first messages in conversation panels
    els.aliceLog.appendChild(createPromptBlock(alicePrompt));
    els.bobLog.appendChild(createPromptBlock(bobPrompt));

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

  // ── Reset button ──────────────────────────────────────────────
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

  // ── New run button ───────────────────────────────────────────
  els.newRunBtn.addEventListener('click', async function () {
    // Reset server state before returning to setup
    try {
      await fetch('/api/reset', { method: 'POST' });
    } catch (err) {
      console.error('Reset error:', err);
    }
    showSetup();
  });

  // ── Init ─────────────────────────────────────────────────────
  connectSSE();
  setInterval(pollStatus, 3000);
  pollStatus();
})();
