// AgentVault Demo UI — Shared rendering utilities
// Pure functions that create DOM elements. No side effects.

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('en-US', {
    hour12: false,
    fractionalSecondDigits: 1,
  });
}

function truncate(str, max) {
  if (!max) max = 200;
  return str.length <= max ? str : str.slice(0, max) + '\u2026';
}

function scrollToBottom(el) {
  el.scrollTop = el.scrollHeight;
}

// ── Chat bubbles (conversation panels) ──────────────────────────

/**
 * Create a chat bubble for an agent's LLM text.
 * Returns a .chat-message element.
 */
function createChatBubble(event) {
  if (event.type !== 'llm_text') return null;

  var wrap = document.createElement('div');
  wrap.className = 'chat-message chat-message--agent';

  var name = document.createElement('span');
  name.className = 'chat-message__name';
  name.textContent = event.agent === 'alice' ? 'AliceBot' : 'BobBot';

  var bubble = document.createElement('div');
  bubble.className = 'chat-bubble chat-bubble--agent';
  bubble.textContent = event.payload.text;

  wrap.appendChild(name);
  wrap.appendChild(bubble);
  return wrap;
}

/**
 * Create the initial prompt display as a user chat bubble.
 */
function createPromptBubble(promptText, agentName) {
  var wrap = document.createElement('div');
  wrap.className = 'chat-message chat-message--prompt';

  var name = document.createElement('span');
  name.className = 'chat-message__name';
  name.textContent = agentName;

  var bubble = document.createElement('div');
  bubble.className = 'chat-bubble chat-bubble--prompt';
  bubble.textContent = promptText;

  wrap.appendChild(name);
  wrap.appendChild(bubble);
  return wrap;
}

// ── Protocol log entries (debug view) ───────────────────────────

/**
 * Create a protocol log entry (tool calls, results, system events).
 * Returns a DOM element for the collapsible log panel.
 */
function createLogEntry(event) {
  var entry = document.createElement('div');
  entry.className = 'log-entry ' + event.type;

  var ts = document.createElement('span');
  ts.className = 'ts';
  ts.textContent = formatTime(event.ts);

  var tag = document.createElement('span');
  tag.className = 'tag ' + (event.agent || 'system');
  tag.textContent = event.agent || 'sys';

  var body = document.createElement('span');
  body.className = 'body';

  switch (event.type) {
    case 'tool_call':
      body.textContent = '\u25B8 ' + event.payload.tool + '(' + truncate(JSON.stringify(event.payload.args)) + ')';
      break;
    case 'tool_result':
      body.textContent = '\u25C2 ' + event.payload.tool + ' \u2192 ' + truncate(JSON.stringify(event.payload.result));
      break;
    case 'agent_status':
      body.textContent = '[' + event.payload.status + '] ' + (event.payload.detail || '');
      break;
    case 'system':
      body.textContent = event.payload.message;
      break;
    case 'error':
      body.textContent = 'ERROR: ' + event.payload.error;
      break;
    default:
      body.textContent = JSON.stringify(event.payload);
  }

  entry.appendChild(ts);
  entry.appendChild(tag);
  entry.appendChild(body);
  return entry;
}

// ── Vault Card Manager (centre panel) ───────────────────────────

var VaultCardManager = (function () {
  var stepCount = 0;
  var openCard = null;
  var container = null;

  function init(el) {
    container = el;
    stepCount = 0;
    openCard = null;
  }

  function reset() {
    stepCount = 0;
    openCard = null;
  }

  /** Map tool names to human-readable titles */
  function toolDisplayName(toolName) {
    if (!toolName) return 'Unknown';
    // Strip agentvault. prefix
    var short = toolName.replace(/^agentvault\./, '');
    return short.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  /** Build a vault card element */
  function buildCard(stepLabel, title, isError) {
    var card = document.createElement('div');
    card.className = 'vault-card' + (isError ? ' vault-card--error vault-card--expanded' : '');

    // Header
    var header = document.createElement('div');
    header.className = 'vault-card__header';

    if (stepLabel) {
      var tag = document.createElement('span');
      tag.className = 'vault-card__step-tag';
      tag.textContent = stepLabel;
      header.appendChild(tag);
    }

    var titleEl = document.createElement('span');
    titleEl.className = 'vault-card__title';
    titleEl.textContent = title;
    header.appendChild(titleEl);

    var chevron = document.createElement('span');
    chevron.className = 'vault-card__chevron';
    chevron.textContent = '\u25B8';
    header.appendChild(chevron);

    // Click to toggle expand
    header.addEventListener('click', function () {
      card.classList.toggle('vault-card--expanded');
    });

    card.appendChild(header);

    // Body (hidden by default unless error)
    var body = document.createElement('div');
    body.className = 'vault-card__body';
    card.appendChild(body);

    return card;
  }

  /** Open a new step card */
  function openStep(label, title, isError) {
    stepCount++;
    var stepLabel = label || ('Step ' + stepCount);
    openCard = buildCard(stepLabel, title, isError);
    if (container) {
      container.appendChild(openCard);
      scrollToBottom(container.parentElement);
    }
    return openCard;
  }

  /** Append a key-value line to the open card's body */
  function appendLine(key, value) {
    if (!openCard) return;
    var body = openCard.querySelector('.vault-card__body');
    if (!body) return;

    var line = document.createElement('div');
    line.className = 'vault-line';

    var keyEl = document.createElement('span');
    keyEl.className = 'vault-line__key';
    keyEl.textContent = key;

    var valEl = document.createElement('span');
    valEl.className = 'vault-line__value';
    valEl.textContent = truncate(String(value), 120);

    line.appendChild(keyEl);
    line.appendChild(valEl);
    body.appendChild(line);
  }

  /** Append a status line to the open card */
  function appendStatus(ok, text) {
    if (!openCard) return;
    var status = document.createElement('div');
    status.className = 'vault-card__status ' + (ok ? 'vault-card__status--ok' : 'vault-card__status--error');
    status.textContent = (ok ? '\u2713 ' : '\u2717 ') + text;
    openCard.appendChild(status);

    // Mark success cards
    if (ok && !openCard.classList.contains('vault-card--error')) {
      openCard.classList.add('vault-card--success');
    }
  }

  /** Close the current card */
  function closeCard() {
    openCard = null;
  }

  /** Route a protocol event to vault cards */
  function routeEvent(event) {
    switch (event.type) {
      case 'tool_call': {
        var toolName = event.payload.tool || '';
        var title = toolDisplayName(toolName);
        if (event.agent) {
          title = (event.agent === 'alice' ? 'Alice' : 'Bob') + ' \u2192 ' + title;
        }
        openStep(null, title, false);
        // Append args as key-value lines
        var args = event.payload.args || {};
        var keys = Object.keys(args);
        for (var i = 0; i < keys.length; i++) {
          var k = keys[i];
          var v = typeof args[k] === 'string' ? args[k] : JSON.stringify(args[k]);
          appendLine(k, v);
        }
        break;
      }

      case 'tool_result': {
        var result = event.payload.result;
        var isErr = result && (result.error || result.ok === false);
        var statusText = isErr
          ? (typeof result.error === 'string' ? result.error : 'Error')
          : (result && result.status ? result.status : 'OK');
        appendStatus(!isErr, statusText);

        // Check for signal payload
        if (result && (result.signal || result.output_signal)) {
          var signalData = result.signal || result.output_signal;
          triggerSignalOverlay(JSON.stringify(signalData, null, 2));
        }

        closeCard();
        break;
      }

      case 'agent_status': {
        if (event.payload.status === 'completed') {
          var who = event.agent === 'alice' ? 'Alice' : event.agent === 'bob' ? 'Bob' : 'Agent';
          openStep('Done', who + ' — session complete', false);
          appendStatus(true, 'Protocol finished');
          closeCard();
        }
        // running/idle: handled by dot update in app.js
        break;
      }

      case 'system': {
        var msg = event.payload.message || '';
        // Skip noise
        if (msg.startsWith('Recording')) break;
        openStep(null, msg, false);
        closeCard();
        break;
      }

      case 'error': {
        var errMsg = event.payload.error || 'Unknown error';
        openStep('Error', errMsg, true);
        closeCard();
        break;
      }
    }
  }

  return {
    init: init,
    reset: reset,
    routeEvent: routeEvent,
    openStep: openStep,
    appendLine: appendLine,
    appendStatus: appendStatus,
    closeCard: closeCard,
  };
})();

// ── Signal overlay ──────────────────────────────────────────────

function triggerSignalOverlay(json) {
  var overlay = document.getElementById('signal-overlay');
  if (!overlay) return;

  // Clear previous content safely
  while (overlay.firstChild) {
    overlay.removeChild(overlay.firstChild);
  }
  overlay.classList.add('signal-overlay--visible');

  // Close button
  var closeBtn = document.createElement('button');
  closeBtn.className = 'signal-overlay__close';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', function () {
    overlay.classList.remove('signal-overlay--visible');
  });
  overlay.appendChild(closeBtn);

  // Centre signal block
  var centre = document.createElement('div');
  centre.className = 'signal-block signal-block--centre';

  var label = document.createElement('div');
  label.className = 'signal-block__label';
  label.textContent = 'Output Signal';

  var jsonBlock = document.createElement('pre');
  jsonBlock.className = 'signal-block__json';
  jsonBlock.textContent = json;

  centre.appendChild(label);
  centre.appendChild(jsonBlock);
  overlay.appendChild(centre);

  // Animated left copy
  var left = document.createElement('div');
  left.className = 'signal-block signal-block--left';
  var leftJson = document.createElement('pre');
  leftJson.className = 'signal-block__json';
  leftJson.textContent = json;
  leftJson.style.fontSize = '9px';
  leftJson.style.maxWidth = '200px';
  leftJson.style.overflow = 'hidden';
  left.appendChild(leftJson);
  overlay.appendChild(left);

  // Animated right copy
  var right = document.createElement('div');
  right.className = 'signal-block signal-block--right';
  var rightJson = document.createElement('pre');
  rightJson.className = 'signal-block__json';
  rightJson.textContent = json;
  rightJson.style.fontSize = '9px';
  rightJson.style.maxWidth = '200px';
  rightJson.style.overflow = 'hidden';
  right.appendChild(rightJson);
  overlay.appendChild(right);

  // Trigger slide animations after delay
  setTimeout(function () {
    left.classList.add('signal-block--animate-left');
    right.classList.add('signal-block--animate-right');
  }, 800);
}
