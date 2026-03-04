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

/**
 * Create a result card for the chat panel showing the vault output signal.
 * Visually distinct from normal chat bubbles.
 */
function createResultCard(output, receipt) {
  var wrap = document.createElement('div');
  wrap.className = 'chat-message chat-message--agent';

  var card = document.createElement('div');
  card.className = 'chat-result-card';

  var label = document.createElement('div');
  label.className = 'chat-result-card__label';
  label.textContent = 'Vault Result';
  card.appendChild(label);

  // Render output fields as readable lines
  if (output) {
    var keys = Object.keys(output);
    for (var i = 0; i < keys.length; i++) {
      var line = document.createElement('div');
      line.textContent = keys[i].replace(/_/g, ' ') + ': ' + output[keys[i]];
      card.appendChild(line);
    }
  }

  if (receipt && receipt.session_id) {
    var line = document.createElement('div');
    line.style.marginTop = '8px';
    line.style.fontSize = '11px';
    line.style.color = 'var(--color-text-dim)';
    line.textContent = 'receipt: ' + truncate(receipt.session_id, 24);
    card.appendChild(line);
  }

  wrap.appendChild(card);
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
// Shows only meaningful milestones, not every tool call/result.

var VaultCardManager = (function () {
  var stepCount = 0;
  var container = null;

  // Track state per agent to detect milestone transitions
  var agentState = {};
  // Pending tool_call context queue — each entry is { tool, agent, args }.
  // Using a queue (FIFO) instead of a single slot handles parallel tool calls
  // correctly: earlier tool_results are matched to earlier tool_calls.
  var pendingCalls = [];
  // Callback for result cards in chat panels
  var onOutputSignal = null;

  function init(el) {
    container = el;
    stepCount = 0;
    agentState = {};
    pendingCalls = [];
  }

  function reset() {
    stepCount = 0;
    agentState = {};
    pendingCalls = [];
  }

  function setOutputSignalCallback(cb) {
    onOutputSignal = cb;
  }

  /** Build a vault card element */
  function buildCard(title, extraClass) {
    stepCount++;
    var card = document.createElement('div');
    card.className = 'vault-card' + (extraClass ? ' ' + extraClass : '');

    var header = document.createElement('div');
    header.className = 'vault-card__header';

    var tag = document.createElement('span');
    tag.className = 'vault-card__step-tag';
    tag.textContent = stepCount;
    header.appendChild(tag);

    var titleEl = document.createElement('span');
    titleEl.className = 'vault-card__title';
    titleEl.textContent = title;
    header.appendChild(titleEl);

    var chevron = document.createElement('span');
    chevron.className = 'vault-card__chevron';
    chevron.textContent = '\u25B8';
    header.appendChild(chevron);

    header.addEventListener('click', function () {
      card.classList.toggle('vault-card--expanded');
    });

    card.appendChild(header);

    var body = document.createElement('div');
    body.className = 'vault-card__body';
    card.appendChild(body);

    return card;
  }

  function addCard(title, extraClass) {
    var card = buildCard(title, extraClass || '');
    if (container) {
      container.appendChild(card);
      scrollToBottom(container.parentElement);
    }
    return card;
  }

  function addLine(card, key, value) {
    var body = card.querySelector('.vault-card__body');
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

  function addStatus(card, ok, text) {
    var status = document.createElement('div');
    status.className = 'vault-card__status ' + (ok ? 'vault-card__status--ok' : 'vault-card__status--error');
    status.textContent = (ok ? '\u2713 ' : '\u2717 ') + text;
    card.appendChild(status);
    if (ok) card.classList.add('vault-card--success');
  }

  function agentLabel(agent) {
    return agent === 'alice' ? 'Alice' : agent === 'bob' ? 'Bob' : 'Agent';
  }

  /** Route a protocol event — only create cards for milestones */
  function routeEvent(event) {
    switch (event.type) {
      case 'tool_call': {
        // Enqueue the call context; dequeued FIFO when the matching result arrives
        pendingCalls.push({
          tool: event.payload.tool || '',
          agent: event.agent || '',
          args: event.payload.args || {},
        });
        break;
      }

      case 'tool_result': {
        if (!pendingCalls.length) break;
        var call = pendingCalls.shift();
        var result = event.payload.result || {};
        var agent = event.agent || call.agent;
        var label = agentLabel(agent);
        var status = result.status || '';
        var data = result.data || {};
        var phase = data.phase || '';
        var state = data.state || '';
        var userMsg = data.user_message || '';
        var prev = agentState[agent] || {};

        // get_identity — show once per agent
        if (call.tool.indexOf('get_identity') >= 0) {
          var idData = result.data || result;
          var card = addCard(label + ' identified');
          if (idData.agent_id) addLine(card, 'agent_id', idData.agent_id);
          if (idData.known_agents) {
            var peers = idData.known_agents;
            if (Array.isArray(peers)) {
              addLine(card, 'peers', peers.map(function (p) { return p.agent_id || p; }).join(', '));
            }
          }
          addStatus(card, true, 'Ready');
          break;
        }

        // relay_signal — filter to milestones
        if (call.tool.indexOf('relay_signal') >= 0) {
          // ERROR — always show
          if (status === 'ERROR' || result.error) {
            var errCard = addCard(label + ' — error', 'vault-card--error vault-card--expanded');
            var errObj = result.error || {};
            var errMsg = (typeof errObj === 'string' ? errObj : errObj.detail || errObj.code || '') || result.detail || userMsg || 'Unknown error';
            addLine(errCard, 'detail', errMsg);
            agentState[agent] = prev;
            break;
          }

          // COMPLETE — the big milestone (checked first: a COMPLETE result
          // takes priority over mode-based milestone filters, since collision
          // redirect can return COMPLETE on what the agent sent as INITIATE)
          if (status === 'COMPLETE') {
            var outputWrap = data.output || result.output || {};
            var output = outputWrap.output || null;
            var receipt = outputWrap.receipt || null;
            var receiptSignature = outputWrap.receipt_signature || null;

            // Hero result card — output signal
            var card = addCard(label + ' — session complete', 'vault-card--hero vault-card--expanded');
            if (output) {
              var outputKeys = Object.keys(output);
              for (var i = 0; i < outputKeys.length; i++) {
                addLine(card, outputKeys[i], output[outputKeys[i]]);
              }
            }
            addStatus(card, true, 'Complete');

            // Receipt card — cryptographic proof details
            if (receipt) {
              var rcBody = card.querySelector('.vault-card__body');
              if (rcBody) {
                var rcSection = document.createElement('div');
                rcSection.className = 'receipt-card';

                var rcLabel = document.createElement('div');
                rcLabel.className = 'receipt-card__label';
                rcLabel.textContent = 'CRYPTOGRAPHIC RECEIPT';
                rcSection.appendChild(rcLabel);

                var rcFields = [
                  ['session_id', truncate(receipt.session_id || '', 24)],
                ];
                if (receipt.model_identity) {
                  rcFields.push(['model', (receipt.model_identity.provider || '') + ' / ' + (receipt.model_identity.model_id || '')]);
                }
                if (receipt.contract_hash) rcFields.push(['contract hash', truncate(receipt.contract_hash, 16)]);
                if (receipt.guardian_policy_hash) rcFields.push(['policy hash', truncate(receipt.guardian_policy_hash, 16)]);
                if (receipt.prompt_template_hash) rcFields.push(['template hash', truncate(receipt.prompt_template_hash, 16)]);
                if (receipt.output_entropy_bits !== undefined) rcFields.push(['entropy bits', String(receipt.output_entropy_bits)]);

                for (var fi = 0; fi < rcFields.length; fi++) {
                  var rcLine = document.createElement('div');
                  rcLine.className = 'receipt-card__line';
                  var rcKey = document.createElement('span');
                  rcKey.className = 'receipt-card__key';
                  rcKey.textContent = rcFields[fi][0];
                  var rcVal = document.createElement('span');
                  rcVal.className = 'receipt-card__value';
                  rcVal.textContent = rcFields[fi][1];
                  rcLine.appendChild(rcKey);
                  rcLine.appendChild(rcVal);
                  rcSection.appendChild(rcLine);
                }

                // Verify button
                if (receiptSignature) {
                  var verifyBtn = document.createElement('button');
                  verifyBtn.className = 'receipt-card__verify-btn';
                  verifyBtn.textContent = 'Verify Signature';
                  var verifyStatus = document.createElement('span');
                  verifyStatus.className = 'receipt-card__verify-status';

                  verifyBtn.addEventListener('click', function () {
                    verifyBtn.disabled = true;
                    verifyBtn.textContent = 'Verifying\u2026';
                    fetch('/api/verify-receipt', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ receipt: receipt, receipt_signature: receiptSignature }),
                    })
                      .then(function (r) { return r.json(); })
                      .then(function (res) {
                        verifyBtn.textContent = 'Verify Signature';
                        verifyBtn.disabled = false;
                        if (res.verified) {
                          verifyStatus.className = 'receipt-card__verify-status verified';
                          verifyStatus.textContent = '\u2713 Signature valid';
                        } else {
                          verifyStatus.className = 'receipt-card__verify-status failed';
                          verifyStatus.textContent = '\u2717 ' + (res.error || 'Verification failed');
                        }
                      })
                      .catch(function () {
                        verifyBtn.textContent = 'Verify Signature';
                        verifyBtn.disabled = false;
                        verifyStatus.className = 'receipt-card__verify-status failed';
                        verifyStatus.textContent = '\u2717 Request failed';
                      });
                  });

                  var verifyRow = document.createElement('div');
                  verifyRow.className = 'receipt-card__verify-row';
                  verifyRow.appendChild(verifyBtn);
                  verifyRow.appendChild(verifyStatus);
                  rcSection.appendChild(verifyRow);
                }

                rcBody.appendChild(rcSection);
              }
            }

            // Notify chat panels
            if (onOutputSignal && output) {
              onOutputSignal(agent, output, receipt);
            }

            agentState[agent] = Object.assign({}, prev, { completed: true });
            break;
          }

          // INITIATE mode first call — session starting
          if (call.args.mode === 'INITIATE' && !prev.initiated) {
            var card = addCard(label + ' starting session');
            addStatus(card, true, 'Initiating');
            agentState[agent] = Object.assign({}, prev, { initiated: true });
            break;
          }

          // RESPOND mode first call — responding to invite
          if (call.args.mode === 'RESPOND' && !prev.responding) {
            var card = addCard(label + ' responding to invite');
            addStatus(card, true, 'Listening');
            agentState[agent] = Object.assign({}, prev, { responding: true });
            break;
          }

          // Session created (POLL_RELAY phase, first time)
          if (phase === 'POLL_RELAY' && !prev.sessionCreated) {
            var card = addCard('Session created');
            if (data.session_id) addLine(card, 'session', truncate(data.session_id, 16));
            addStatus(card, true, 'Waiting for counterparty');
            agentState[agent] = Object.assign({}, prev, { sessionCreated: true });
            break;
          }

          // Joined session (JOIN phase, first time)
          if (phase === 'JOIN' && !prev.joined) {
            var card = addCard(label + ' joined session');
            addStatus(card, true, userMsg || 'Joined');
            agentState[agent] = Object.assign({}, prev, { joined: true });
            break;
          }

          // Everything else (repeated PENDING/CALL_AGAIN polling) — suppress
          break;
        }

        // Unknown tool — show it
        var card = addCard(label + ' — ' + call.tool);
        addStatus(card, !result.error, status || 'OK');
        break;
      }

      case 'agent_status': {
        if (event.payload.status === 'completed') {
          var who = agentLabel(event.agent);
          var card = addCard(who + ' finished');
          addStatus(card, true, 'Agent done');
        }
        break;
      }

      case 'error': {
        var errMsg = event.payload.error || 'Unknown error';
        var card = addCard('Error', 'vault-card--error vault-card--expanded');
        addLine(card, 'detail', errMsg);
        break;
      }

      // system events — relay_policy creates enforcement card, others suppressed
      case 'system': {
        if (event.agent === 'relay_policy') {
          var p = event.payload;
          var card = addCard('Relay Enforcement Active', 'vault-card--policy vault-card--expanded');
          addLine(card, 'policy', truncate(String(p.policy_id || 'unknown'), 40));
          addLine(card, 'policy hash', truncate(String(p.policy_hash || ''), 16));
          var allowlist = p.model_profile_allowlist;
          if (Array.isArray(allowlist) && allowlist.length > 0) {
            addLine(card, 'model constraint', allowlist.join(', '));
          }
          var rules = p.enforcement_rules;
          if (Array.isArray(rules) && rules.length > 0) {
            addLine(card, 'rules', rules.join(', '));
          }
          addLine(card, 'relay model', String(p.model_id || 'unknown'));
          addLine(card, 'signing key', truncate(String(p.verifying_key_hex || ''), 20));
          addStatus(card, true, 'Enforcement policy bound');
        }
        break;
      }
    }
  }

  return {
    init: init,
    reset: reset,
    routeEvent: routeEvent,
    setOutputSignalCallback: setOutputSignalCallback,
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
