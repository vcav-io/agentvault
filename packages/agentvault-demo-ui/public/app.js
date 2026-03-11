// AgentVault Demo UI — Live Protocol View

(function () {
  var $ = function (id) { return document.getElementById(id); };

  // ── Active scenario (from scenarios.js) ──────────────────────
  var activeScenario = null;

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
    // Provider/model selectors
    coordinationModelSelect: $('coordination-model-select'),
    splitModelToggle: $('split-model-toggle'),
    agentProviderWrap: $('agent-provider-wrap'),
    agentModelWrap: $('agent-model-wrap'),
    providerSelect: $('provider-select'),
    modelSelect: $('model-select'),
    // Canary toggle
    canaryToggleWrap: $('canary-toggle-wrap'),
    canaryCheckToggle: $('canary-check-toggle'),
  };

  // Track messages we rendered client-side to avoid SSE duplicates.
  // Keyed by a monotonically incrementing integer ID (not content) so identical
  // message text from the same agent cannot cause collisions.
  var localMessageIds = {};
  var nextLocalMsgId = 1;
  var MAX_LOCAL_MESSAGE_IDS = 100; // size cap to prevent unbounded growth on missed echoes

  var eventSource = null;
  var totalEvents = 0;
  var reconnectNotice = null;
  var terminalAgents = {};

  // ── Init vault card manager ────────────────────────────────
  VaultCardManager.init(els.vaultEvents);

  // When the vault produces an output signal, show result cards in chat panels
  // and run canary checks if the scenario defines them.
  var resultCardRendered = false;

  function runCanaryCheck(scenario, output) {
    var haystack = Object.keys(output).map(function (k) {
      var v = output[k];
      return typeof v === 'string' ? v : JSON.stringify(v);
    }).join('\n').toLowerCase();

    var leaked = scenario.canaries.filter(function (c) {
      return haystack.indexOf(c.toLowerCase()) !== -1;
    });
    // inverseCanaries: those NOT found are failures
    var absent = scenario.inverseCanaries.filter(function (c) {
      return haystack.indexOf(c.toLowerCase()) === -1;
    });

    return {
      passed: leaked.length === 0 && absent.length === 0,
      leaked: leaked,
      absent: absent,
    };
  }

  function makeOutputCallback(scenario, canaryEnabled) {
    return function (agent, output, receipt) {
      if (resultCardRendered) return;
      resultCardRendered = true;

      var card1 = createResultCard(output, receipt);
      var card2 = createResultCard(output, receipt);
      els.aliceLog.appendChild(card1);
      scrollToBottom(els.aliceLog);
      els.bobLog.appendChild(card2);
      scrollToBottom(els.bobLog);

      if (canaryEnabled && scenario && (scenario.canaries.length || scenario.inverseCanaries.length)) {
        var result = runCanaryCheck(scenario, output);
        var canaryCard = createCanaryResultCard(result, scenario);
        els.vaultEvents.appendChild(canaryCard);
        scrollToBottom(els.vaultEvents.parentElement);
      }
    };
  }

  // ── Log panel toggle ───────────────────────────────────────
  if (els.logBar) {
    els.logBar.addEventListener('click', function () {
      els.logPanel.classList.toggle('collapsed');
    });
  }

  // ── Template handling (driven by scenarios.js) ─────────────
  function applyTemplate(id) {
    var sc = SCENARIOS.find(function (s) { return s.id === id; });
    if (!sc) return;
    activeScenario = sc;
    els.alicePrompt.value = sc.alice;
    els.bobPrompt.value = sc.bob;
    // Show canary toggle only for scenarios that define canaries
    var hasCanaries = sc.canaries.length > 0 || sc.inverseCanaries.length > 0;
    els.canaryToggleWrap.style.visibility = hasCanaries ? 'visible' : 'hidden';
    if (!hasCanaries) els.canaryCheckToggle.checked = false;
  }

  function buildTemplateSelect() {
    var groups = {};
    var groupOrder = [];
    SCENARIOS.forEach(function (sc) {
      if (!groups[sc.group]) {
        groups[sc.group] = [];
        groupOrder.push(sc.group);
      }
      groups[sc.group].push(sc);
    });
    groupOrder.forEach(function (gname) {
      var optgroup = document.createElement('optgroup');
      optgroup.label = gname;
      groups[gname].forEach(function (sc) {
        var opt = document.createElement('option');
        opt.value = sc.id;
        opt.textContent = sc.label;
        optgroup.appendChild(opt);
      });
      els.templateSelect.appendChild(optgroup);
    });
  }

  buildTemplateSelect();

  els.templateSelect.addEventListener('change', function () {
    applyTemplate(this.value);
  });

  // Load default template
  applyTemplate(SCENARIOS[0].id);

  // ── Provider/model config ──────────────────────────────────
  var providerConfig = [];

  function clearSelect(sel) {
    while (sel.firstChild) sel.removeChild(sel.firstChild);
  }

  /** Populate the coordination model dropdown with all models across providers. */
  function populateCoordinationModelSelect(defaultProvider) {
    clearSelect(els.coordinationModelSelect);
    providerConfig.forEach(function (prov) {
      prov.models.forEach(function (m) {
        var opt = document.createElement('option');
        opt.value = JSON.stringify({ provider: prov.name, model: m.id, profileId: m.profileId });
        opt.textContent = m.id + ' (' + prov.name + ', ' + m.tier + ')';
        if (prov.name === defaultProvider && m.default) opt.selected = true;
        els.coordinationModelSelect.appendChild(opt);
      });
    });
  }

  function populateModelSelect(providerName) {
    clearSelect(els.modelSelect);
    var prov = providerConfig.find(function (p) { return p.name === providerName; });
    if (!prov) return;
    prov.models.forEach(function (m) {
      var opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.id + (m.tier ? ' (' + m.tier + ')' : '');
      if (m.default) opt.selected = true;
      els.modelSelect.appendChild(opt);
    });
  }

  /** Get the selected coordination model value. */
  function getCoordinationModel() {
    try { return JSON.parse(els.coordinationModelSelect.value); } catch { return null; }
  }

  // Split model toggle
  els.splitModelToggle.addEventListener('change', function () {
    var show = this.checked;
    els.agentProviderWrap.style.display = show ? '' : 'none';
    els.agentModelWrap.style.display = show ? '' : 'none';
  });

  els.providerSelect.addEventListener('change', function () {
    populateModelSelect(this.value);
  });

  fetch('/api/config')
    .then(function (r) { return r.json(); })
    .then(function (cfg) {
      providerConfig = cfg.providers || [];
      // Coordination model (unified dropdown)
      populateCoordinationModelSelect(cfg.defaultProvider);
      // Agent provider/model (split mode)
      clearSelect(els.providerSelect);
      providerConfig.forEach(function (p) {
        var opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = p.name.charAt(0).toUpperCase() + p.name.slice(1);
        if (p.name === cfg.defaultProvider) opt.selected = true;
        els.providerSelect.appendChild(opt);
      });
      if (providerConfig.length > 0) {
        populateModelSelect(cfg.defaultProvider || providerConfig[0].name);
      }
    })
    .catch(function () {
      clearSelect(els.coordinationModelSelect);
      var opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Unavailable';
      els.coordinationModelSelect.appendChild(opt);
    });

  // ── Phase management ───────────────────────────────────────
  function setChatInputsEnabled(enabled) {
    els.aliceInput.disabled = !enabled;
    els.aliceSend.disabled = !enabled;
    els.bobInput.disabled = !enabled;
    els.bobSend.disabled = !enabled;
  }

  function showSetup() {
    clearReconnectNotice();
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
    clearReconnectNotice();
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
    clearReconnectNotice();
    els.stopBtn.style.display = 'none';
    els.newRunBtn.style.display = '';
    els.resetBtn.style.display = '';
    els.statusText.textContent = 'Completed';
    els.statusChip.className = 'status-chip completed';
    setChatInputsEnabled(false);
  }

  function showFailed() {
    clearReconnectNotice();
    els.stopBtn.style.display = 'none';
    els.newRunBtn.style.display = '';
    els.resetBtn.style.display = '';
    els.statusText.textContent = 'Failed';
    els.statusChip.className = 'status-chip error';
    setChatInputsEnabled(false);
  }

  function clearReconnectNotice() {
    if (reconnectNotice && reconnectNotice.parentNode) {
      reconnectNotice.parentNode.removeChild(reconnectNotice);
    }
    reconnectNotice = null;
  }

  // ── Agent dot/turns updates ────────────────────────────────
  function updateAgentDot(dotEl, turnsEl, status, turns) {
    dotEl.className = 'sim-panel__agent-dot ' + status;
    if (turns > 0) turnsEl.textContent = 'Turn ' + turns;
  }

  // ── Completion tracking ────────────────────────────────────
  var completedAgents = {};

  function checkCompletion(event) {
    if (event.type === 'agent_status' && event.agent) {
      if (event.payload.status === 'completed') {
        completedAgents[event.agent] = true;
        terminalAgents[event.agent] = 'completed';
      } else if (event.payload.status === 'failed') {
        terminalAgents[event.agent] = 'failed';
      } else {
        return;
      }

      if (terminalAgents.alice && terminalAgents.bob) {
        if (terminalAgents.alice === 'failed' || terminalAgents.bob === 'failed') {
          showFailed();
          return;
        }
        showCompleted();
      }
    }
  }

  // ── Event routing ──────────────────────────────────────────
  function handleEvent(event) {
    if (event.type === 'user_message') {
      // Mid-run user message — render as prompt bubble (skip if already rendered locally)
      // Look up by unique ID echoed back from the server, then fall through to render
      var echoId = event.payload.localId;
      if (echoId !== undefined && localMessageIds[echoId]) {
        delete localMessageIds[echoId];
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
    terminalAgents = {};
    resultCardRendered = false;
    localMessageIds = {};
    nextLocalMsgId = 1;
    els.eventCount.textContent = '0 events';
    var runScenario = activeScenario;
    VaultCardManager.init(els.vaultEvents);
    var runCanaryEnabled = els.canaryCheckToggle.checked;
    VaultCardManager.setOutputSignalCallback(makeOutputCallback(runScenario, runCanaryEnabled));

    // Dismiss any open signal overlay
    els.signalOverlay.classList.remove('signal-overlay--visible');

    // Show prompts as first messages in conversation panels
    els.aliceLog.appendChild(createPromptBubble(alicePrompt, 'Alice'));
    els.bobLog.appendChild(createPromptBubble(bobPrompt, 'Bob'));

    try {
      var coord = getCoordinationModel();
      var isSplit = els.splitModelToggle.checked;
      var startBody = {
        alicePrompt: alicePrompt,
        bobPrompt: bobPrompt,
      };
      if (runScenario && Array.isArray(runScenario.acceptablePurposes) && runScenario.acceptablePurposes.length) {
        startBody.acceptablePurposes = runScenario.acceptablePurposes.slice();
      }
      if (isSplit) {
        // Split mode: coordination model drives relay, agent model drives agent LLM
        startBody.agentProvider = els.providerSelect.value || undefined;
        startBody.agentModel = els.modelSelect.value || undefined;
        if (coord && coord.profileId) startBody.relayProfileId = coord.profileId;
      } else {
        // Unified mode: coordination model drives both
        if (coord) {
          startBody.agentProvider = coord.provider;
          startBody.agentModel = coord.model;
          if (coord.profileId) startBody.relayProfileId = coord.profileId;
        }
      }
      var res = await fetch('/api/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(startBody),
      });
      var data = await res.json();
      if (data.error) {
        els.statusText.textContent = 'Error';
        els.statusChip.className = 'status-chip error';
        VaultCardManager.renderError('Start failed', data.error);
        els.stopBtn.style.display = 'none';
        els.newRunBtn.style.display = '';
        els.startBtn.disabled = false;
      }
    } catch (err) {
      els.statusText.textContent = 'Error';
      els.statusChip.className = 'status-chip error';
      VaultCardManager.renderError('Start failed', 'Could not reach demo server');
      els.stopBtn.style.display = 'none';
      els.newRunBtn.style.display = '';
      els.startBtn.disabled = false;
    }
  });

  // ── Stop button ────────────────────────────────────────────
  els.stopBtn.addEventListener('click', async function () {
    els.stopBtn.disabled = true;
    try {
      await fetch('/api/stop', { method: 'POST' });
    } catch (err) {
      console.error('Stop error:', err);
    }
    els.stopBtn.disabled = false;
    els.stopBtn.style.display = 'none';
    els.statusText.textContent = 'Stopped';
    els.statusChip.className = 'status-chip error';
    els.newRunBtn.style.display = '';
    setChatInputsEnabled(false);
    clearReconnectNotice();
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

    // Assign a unique local ID for deduplication — avoids collision on identical text
    var localId = nextLocalMsgId++;
    if (Object.keys(localMessageIds).length >= MAX_LOCAL_MESSAGE_IDS) {
      // Size cap: clear stale entries that never received an echo
      localMessageIds = {};
    }
    localMessageIds[localId] = true;

    // Render prompt bubble immediately
    logEl.appendChild(createPromptBubble(text, 'You'));
    scrollToBottom(logEl);

    // Send to server — pass the local ID so the server can echo it back
    inputEl.disabled = true;
    fetch('/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: agent, message: text, localId: localId }),
    })
      .then(function (res) {
        if (!res.ok) {
          return res.json().then(function (data) {
            console.error('Send message rejected:', data.error || res.statusText);
            // Remove the optimistic dedup entry since delivery failed
            delete localMessageIds[localId];
          }).catch(function () {
            console.error('Send message rejected:', res.status, res.statusText);
            delete localMessageIds[localId];
          });
        }
      })
      .catch(function (err) { console.error('Send message error:', err); delete localMessageIds[localId]; })
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

  // If server has a running session (e.g. browser refresh), switch to protocol view
  fetch('/api/status').then(function (res) { return res.json(); }).then(function (data) {
    var aliceDone = data.alice && (data.alice.status === 'completed' || data.alice.status === 'failed');
    var bobDone = data.bob && (data.bob.status === 'completed' || data.bob.status === 'failed');
    if (aliceDone && bobDone) {
      if (data.alice.status === 'failed' || data.bob.status === 'failed') {
        showFailed();
      } else {
        showCompleted();
      }
      return;
    }
    if (data.started) {
      showProtocol();
      VaultCardManager.setOutputSignalCallback(makeOutputCallback(activeScenario, false));
      reconnectNotice = document.createElement('div');
      reconnectNotice.className = 'reconnect-notice';
      reconnectNotice.textContent = 'Reconnected to running session — new events will appear below.';
      els.vaultEvents.appendChild(reconnectNotice);
    }
  }).catch(function () { /* ignore */ });
})();
