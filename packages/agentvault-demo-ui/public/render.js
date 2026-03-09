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
  label.textContent = 'Bounded Output';
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
  var seenSystemCards = {};

  function scrollVaultIntoView() {
    if (!container) return;
    var scrollHost = container.closest ? container.closest('.sim-panel__vault-scroll') : null;
    scrollToBottom(scrollHost || container.parentElement);
  }

  function init(el) {
    container = el;
    stepCount = 0;
    agentState = {};
    pendingCalls = [];
    seenSystemCards = {};
  }

  function reset() {
    stepCount = 0;
    agentState = {};
    pendingCalls = [];
    seenSystemCards = {};
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
      scrollVaultIntoView();
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
          if (prev.identified) {
            agentState[agent] = prev;
            break;
          }
          var idData = result.data || result;
          var card = addCard(label + ' ready');
          if (idData.agent_id) addLine(card, 'agent_id', idData.agent_id);
          if (idData.known_agents) {
            var peers = idData.known_agents;
            if (Array.isArray(peers)) {
              addLine(card, 'peers', peers.map(function (p) { return p.agent_id || p; }).join(', '));
            }
          }
          addStatus(card, true, 'Ready');
          agentState[agent] = Object.assign({}, prev, { identified: true });
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
            var receiptV2 = outputWrap.receipt_v2 || null;
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

            // Receipt card — prefer v2 if available, fall back to v1
            var rcBody = card.querySelector('.vault-card__body');
            if (rcBody && (receiptV2 || receipt)) {
              var rcSection = document.createElement('div');
              rcSection.className = 'receipt-card';

              if (receiptV2) {
                // ── v2 receipt: commitments/claims split ──
                // Detect failure receipts by status claim
                var receiptStatus = (receiptV2.claims || {}).status || '';
                var isFailureReceipt = receiptStatus === 'rejected' || receiptStatus === 'error' || receiptStatus === 'aborted';
                if (isFailureReceipt) {
                  rcSection.classList.add('receipt-card--failure');
                }

                var rcLabel = document.createElement('div');
                rcLabel.className = 'receipt-card__label';
                rcLabel.textContent = isFailureReceipt
                  ? 'FAILURE RECEIPT (v2) \u2014 ' + receiptStatus.toUpperCase()
                  : 'CRYPTOGRAPHIC RECEIPT (v2)';
                rcSection.appendChild(rcLabel);

                // Assurance level — mandatory context
                var assurance = receiptV2.assurance_level || 'UNKNOWN';
                var assuranceEl = document.createElement('div');
                assuranceEl.className = 'receipt-card__assurance';
                var assuranceDescriptions = {
                  SELF_ASSERTED: 'relay asserts its own honesty, no hardware attestation',
                  OPERATOR_AUDITED: 'relay operator publishes verifiable audit trail',
                  PROVIDER_ATTESTED: 'model provider supplied signed inference metadata',
                  TEE_ATTESTED: 'hardware TEE attestation binds receipt to enclave measurement',
                };
                assuranceEl.textContent = assurance + ' \u2014 ' + (assuranceDescriptions[assurance] || 'unknown assurance level');
                rcSection.appendChild(assuranceEl);

                // Operator info
                var operator = receiptV2.operator;
                if (operator) {
                  var opLine = document.createElement('div');
                  opLine.className = 'receipt-card__line';
                  var opKey = document.createElement('span');
                  opKey.className = 'receipt-card__key';
                  opKey.textContent = 'operator';
                  var opVal = document.createElement('span');
                  opVal.className = 'receipt-card__value';
                  opVal.textContent = (operator.operator_id || 'unknown') + (operator.operator_key_fingerprint ? ' (' + truncate(operator.operator_key_fingerprint, 12) + ')' : '');
                  opLine.appendChild(opKey);
                  opLine.appendChild(opVal);
                  rcSection.appendChild(opLine);
                }

                // Session ID
                var sessionLine = document.createElement('div');
                sessionLine.className = 'receipt-card__line';
                var sKey = document.createElement('span');
                sKey.className = 'receipt-card__key';
                sKey.textContent = 'session_id';
                var sVal = document.createElement('span');
                sVal.className = 'receipt-card__value';
                sVal.textContent = truncate(receiptV2.session_id || '', 24);
                sessionLine.appendChild(sKey);
                sessionLine.appendChild(sVal);
                rcSection.appendChild(sessionLine);

                // ── Commitments section (cryptographically verifiable) ──
                var commitments = receiptV2.commitments || {};
                var commSection = document.createElement('div');
                commSection.className = 'receipt-card__section receipt-card__section--commitments';
                var commLabel = document.createElement('div');
                commLabel.className = 'receipt-card__section-label';
                commLabel.textContent = '\u2713 Cryptographically verifiable commitments';
                commSection.appendChild(commLabel);
                var commFields = [
                  ['contract hash', commitments.contract_hash],
                  ['schema hash', commitments.output_schema_hash || commitments.schema_hash],
                  ['output hash', commitments.output_hash],
                  ['template hash', commitments.prompt_template_hash],
                ];
                var inputComm = commitments.input_commitments;
                if (inputComm && typeof inputComm === 'object') {
                  var inputKeys = Object.keys(inputComm);
                  for (var ik = 0; ik < inputKeys.length; ik++) {
                    var ic = inputComm[inputKeys[ik]];
                    var icDisplay = (ic && typeof ic === 'object') ? (ic.input_hash || ic.hash || JSON.stringify(ic)) : ic;
                    commFields.push(['input: ' + inputKeys[ik], icDisplay]);
                  }
                }
                for (var ci = 0; ci < commFields.length; ci++) {
                  if (!commFields[ci][1]) continue;
                  var cLine = document.createElement('div');
                  cLine.className = 'receipt-card__line';
                  var cKey = document.createElement('span');
                  cKey.className = 'receipt-card__key';
                  cKey.textContent = commFields[ci][0];
                  var cVal = document.createElement('span');
                  cVal.className = 'receipt-card__value';
                  cVal.textContent = truncate(String(commFields[ci][1]), 16);
                  cLine.appendChild(cKey);
                  cLine.appendChild(cVal);
                  commSection.appendChild(cLine);
                }
                rcSection.appendChild(commSection);

                // ── Claims section (relay-asserted, not independently verifiable) ──
                var claims = receiptV2.claims || {};
                var claimsSection = document.createElement('div');
                claimsSection.className = 'receipt-card__section receipt-card__section--claims';
                var claimsLabel = document.createElement('div');
                claimsLabel.className = 'receipt-card__section-label';
                claimsLabel.textContent = '\u24D8 Relay-asserted claims (not independently verifiable)';
                claimsSection.appendChild(claimsLabel);
                var modelAsserted = claims.model_identity_asserted || claims.model_identity;
                if (modelAsserted) {
                  var mLine = document.createElement('div');
                  mLine.className = 'receipt-card__line';
                  var mKey = document.createElement('span');
                  mKey.className = 'receipt-card__key';
                  mKey.textContent = 'model';
                  var mVal = document.createElement('span');
                  mVal.className = 'receipt-card__value';
                  if (typeof modelAsserted === 'object') {
                    mVal.textContent = (modelAsserted.provider || '') + ' / ' + (modelAsserted.model_id || '');
                  } else {
                    mVal.textContent = String(modelAsserted);
                  }
                  mLine.appendChild(mKey);
                  mLine.appendChild(mVal);
                  claimsSection.appendChild(mLine);
                }
                if (claims.budget_enforcement_mode) {
                  var bLine = document.createElement('div');
                  bLine.className = 'receipt-card__line';
                  var bKey = document.createElement('span');
                  bKey.className = 'receipt-card__key';
                  bKey.textContent = 'enforcement';
                  var bVal = document.createElement('span');
                  bVal.className = 'receipt-card__value';
                  bVal.textContent = String(claims.budget_enforcement_mode);
                  bLine.appendChild(bKey);
                  bLine.appendChild(bVal);
                  claimsSection.appendChild(bLine);
                }
                var tokenUsage = claims.token_usage;
                if (tokenUsage && typeof tokenUsage === 'object') {
                  var tLine = document.createElement('div');
                  tLine.className = 'receipt-card__line';
                  var tKey = document.createElement('span');
                  tKey.className = 'receipt-card__key';
                  tKey.textContent = 'tokens';
                  var tVal = document.createElement('span');
                  tVal.className = 'receipt-card__value';
                  tVal.textContent = (tokenUsage.prompt_tokens || '?') + ' in / ' + (tokenUsage.completion_tokens || '?') + ' out';
                  tLine.appendChild(tKey);
                  tLine.appendChild(tVal);
                  claimsSection.appendChild(tLine);
                }
                // Status and signal class (#189)
                if (claims.status) {
                  var stLine = document.createElement('div');
                  stLine.className = 'receipt-card__line';
                  var stKey = document.createElement('span');
                  stKey.className = 'receipt-card__key';
                  stKey.textContent = 'status';
                  var stVal = document.createElement('span');
                  stVal.className = 'receipt-card__value' + (isFailureReceipt ? ' receipt-card__value--failure' : '');
                  stVal.textContent = claims.status + (claims.signal_class ? ' (' + claims.signal_class + ')' : '');
                  stLine.appendChild(stKey);
                  stLine.appendChild(stVal);
                  claimsSection.appendChild(stLine);
                }
                // Execution lane (#190)
                if (claims.execution_lane) {
                  var elLine = document.createElement('div');
                  elLine.className = 'receipt-card__line';
                  var elKey = document.createElement('span');
                  elKey.className = 'receipt-card__key';
                  elKey.textContent = 'execution lane';
                  var elVal = document.createElement('span');
                  elVal.className = 'receipt-card__value';
                  elVal.textContent = String(claims.execution_lane);
                  elLine.appendChild(elKey);
                  elLine.appendChild(elVal);
                  claimsSection.appendChild(elLine);
                }
                // Channel capacity (#188)
                if (claims.channel_capacity_bits_upper_bound !== undefined) {
                  var ccLine = document.createElement('div');
                  ccLine.className = 'receipt-card__line';
                  var ccKey = document.createElement('span');
                  ccKey.className = 'receipt-card__key';
                  ccKey.textContent = 'channel capacity';
                  var ccVal = document.createElement('span');
                  ccVal.className = 'receipt-card__value';
                  var ccText = claims.channel_capacity_bits_upper_bound + ' bits';
                  if (claims.entropy_budget_bits !== undefined) {
                    ccText += ' / ' + claims.entropy_budget_bits + ' budget';
                  }
                  ccVal.textContent = ccText;
                  ccLine.appendChild(ccKey);
                  ccLine.appendChild(ccVal);
                  claimsSection.appendChild(ccLine);
                }
                if (claims.budget_usage && typeof claims.budget_usage === 'object') {
                  var buLine = document.createElement('div');
                  buLine.className = 'receipt-card__line';
                  var buKey = document.createElement('span');
                  buKey.className = 'receipt-card__key';
                  buKey.textContent = 'budget usage';
                  var buVal = document.createElement('span');
                  buVal.className = 'receipt-card__value';
                  buVal.textContent = claims.budget_usage.bits_used_before + ' \u2192 ' + claims.budget_usage.bits_used_after + ' / ' + claims.budget_usage.budget_limit + ' bits';
                  buLine.appendChild(buKey);
                  buLine.appendChild(buVal);
                  claimsSection.appendChild(buLine);
                }
                rcSection.appendChild(claimsSection);

                // Verify button — sends the full v2 receipt (signature is an object)
                var verifyReceipt = receiptV2;
                var verifyBtn = document.createElement('button');
                verifyBtn.className = 'receipt-card__verify-btn';
                verifyBtn.textContent = 'Verify Signature';
                var verifyStatus = document.createElement('span');
                verifyStatus.className = 'receipt-card__verify-status';

                verifyBtn.addEventListener('click', (function (vReceipt, vBtn, vStatus) {
                  return function () {
                    vBtn.disabled = true;
                    vBtn.textContent = 'Verifying\u2026';
                    fetch('/api/verify-receipt', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ receipt: vReceipt }),
                    })
                      .then(function (r) { return r.json(); })
                      .then(function (res) {
                        vBtn.textContent = 'Verify Signature';
                        vBtn.disabled = false;
                        if (res.verified) {
                          vStatus.className = 'receipt-card__verify-status verified';
                          vStatus.textContent = '\u2713 Signature valid (v' + (res.schema_version || '2') + ')';
                        } else {
                          vStatus.className = 'receipt-card__verify-status failed';
                          vStatus.textContent = '\u2717 ' + ((res.errors && res.errors[0]) || res.error || 'Verification failed');
                        }
                      })
                      .catch(function () {
                        vBtn.textContent = 'Verify Signature';
                        vBtn.disabled = false;
                        vStatus.className = 'receipt-card__verify-status failed';
                        vStatus.textContent = '\u2717 Request failed';
                      });
                  };
                })(verifyReceipt, verifyBtn, verifyStatus));

                var verifyRow = document.createElement('div');
                verifyRow.className = 'receipt-card__verify-row';
                verifyRow.appendChild(verifyBtn);
                verifyRow.appendChild(verifyStatus);
                rcSection.appendChild(verifyRow);

              } else if (receipt) {
                // ── v1 receipt: flat fields (backward compat) ──
                var rcLabel = document.createElement('div');
                rcLabel.className = 'receipt-card__label';
                rcLabel.textContent = 'CRYPTOGRAPHIC RECEIPT (v1)';
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

                // Verify button — v1 sends the full receipt (signature field will be stripped server-side)
                if (receiptSignature) {
                  var verifyBtn = document.createElement('button');
                  verifyBtn.className = 'receipt-card__verify-btn';
                  verifyBtn.textContent = 'Verify Signature';
                  var verifyStatus = document.createElement('span');
                  verifyStatus.className = 'receipt-card__verify-status';

                  verifyBtn.addEventListener('click', (function (vReceipt, vBtn, vStatus) {
                    return function () {
                      vBtn.disabled = true;
                      vBtn.textContent = 'Verifying\u2026';
                      fetch('/api/verify-receipt', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ receipt: vReceipt }),
                      })
                        .then(function (r) { return r.json(); })
                        .then(function (res) {
                          vBtn.textContent = 'Verify Signature';
                          vBtn.disabled = false;
                          if (res.verified) {
                            vStatus.className = 'receipt-card__verify-status verified';
                            vStatus.textContent = '\u2713 Signature valid (v1)';
                          } else {
                            vStatus.className = 'receipt-card__verify-status failed';
                            vStatus.textContent = '\u2717 ' + ((res.errors && res.errors[0]) || res.error || 'Verification failed');
                          }
                        })
                        .catch(function () {
                          vBtn.textContent = 'Verify Signature';
                          vBtn.disabled = false;
                          vStatus.className = 'receipt-card__verify-status failed';
                          vStatus.textContent = '\u2717 Request failed';
                        });
                    };
                  })(receipt, verifyBtn, verifyStatus));

                  var verifyRow = document.createElement('div');
                  verifyRow.className = 'receipt-card__verify-row';
                  verifyRow.appendChild(verifyBtn);
                  verifyRow.appendChild(verifyStatus);
                  rcSection.appendChild(verifyRow);
                }
              }

              rcBody.appendChild(rcSection);
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
            var card = addCard(label + ' opened session');
            addStatus(card, true, 'Initiating');
            agentState[agent] = Object.assign({}, prev, { initiated: true });
            break;
          }

          // RESPOND mode first call — responding to invite
          if (call.args.mode === 'RESPOND' && !prev.responding) {
            var card = addCard(label + ' joined invite flow');
            addStatus(card, true, 'Listening');
            agentState[agent] = Object.assign({}, prev, { responding: true });
            break;
          }

          // Session created (POLL_RELAY phase, first time)
          if (phase === 'POLL_RELAY' && !prev.sessionCreated) {
            var card = addCard('Relay session opened');
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
        var who = agentLabel(event.agent);
        if (event.payload.status === 'completed') {
          var card = addCard(who + ' finished');
          addStatus(card, true, 'Agent done');
        } else if (event.payload.status === 'failed') {
          var failCard = addCard(who + ' failed', 'vault-card--error vault-card--expanded');
          addLine(failCard, 'detail', String(event.payload.detail || 'Session failed'));
        }
        break;
      }

      case 'error': {
        var errMsg = event.payload.error || 'Unknown error';
        var card = addCard('Error', 'vault-card--error vault-card--expanded');
        addLine(card, 'detail', errMsg);
        break;
      }

      // system events — contract_enforcement and relay_policy create cards
      // The contract drives the session: it specifies purpose, schema, and
      // which enforcement policy (by hash) the relay must apply.
      case 'system': {
        // 1. Contract — specifies what the session must enforce
        if (event.agent === 'contract_enforcement') {
          var c = event.payload;
          var contractKey = 'contract:' + JSON.stringify([
            c.contract_hash || '',
            c.purpose_code || '',
            c.output_schema_id || '',
            c.model_profile_hash || '',
            c.model_profile_id || ''
          ]);
          if (seenSystemCards[contractKey]) break;
          seenSystemCards[contractKey] = true;
          var card = addCard('Contract Parameters', 'vault-card--contract vault-card--expanded');
          addLine(card, 'version', 'v2');
          addLine(card, 'purpose', String(c.purpose_code || 'unknown'));
          if (c.output_schema_id) addLine(card, 'output schema', String(c.output_schema_id));
          if (c.enforcement_policy_hash) addLine(card, 'required policy', truncate(String(c.enforcement_policy_hash), 16));
          if (c.output_schema_hash) addLine(card, 'schema hash', truncate(String(c.output_schema_hash), 16));
          if (c.entropy_enforcement) addLine(card, 'entropy mode', String(c.entropy_enforcement));
          if (c.entropy_budget_bits !== undefined && c.entropy_budget_bits !== null) {
            addLine(card, 'entropy budget', String(c.entropy_budget_bits) + ' bits');
          }
          if (c.max_completion_tokens) addLine(card, 'max tokens', String(c.max_completion_tokens));
          if (c.model_profile_id) addLine(card, 'model profile', String(c.model_profile_id));
          var modelConstraints = c.model_constraints;
          if (modelConstraints) {
            if (modelConstraints.allowed_providers) addLine(card, 'allowed providers', modelConstraints.allowed_providers.join(', '));
            if (modelConstraints.allowed_models) addLine(card, 'allowed models', modelConstraints.allowed_models.join(', '));
          }
          if (c.session_ttl_secs) addLine(card, 'session TTL', c.session_ttl_secs + 's');
          if (c.invite_ttl_secs) addLine(card, 'invite TTL', c.invite_ttl_secs + 's');
          addStatus(card, true, 'Contract bound');
        }

        // Relay unreachable — session cannot proceed
        if (event.agent === 'relay_unreachable') {
          var u = event.payload;
          var card = addCard('Relay Unreachable', 'vault-card--error vault-card--expanded');
          addLine(card, 'relay URL', String(u.relay_url || 'unknown'));
          addLine(card, 'detail', String(u.detail || 'Connection failed'));
          addStatus(card, false, 'Session cannot start — check relay is running');
        }

        // 2. Relay — confirms it admits the requested policy and shows
        //    its identity (signing key, model, admitted capabilities)
        if (event.agent === 'relay_policy') {
          var p = event.payload;
          var policyKey = 'policy:' + JSON.stringify([
            p.policy_id || '',
            p.policy_hash || '',
            p.verifying_key_hex || '',
            p.model_id || ''
          ]);
          if (seenSystemCards[policyKey]) break;
          seenSystemCards[policyKey] = true;
          var card = addCard('Relay Identity & Policy', 'vault-card--policy vault-card--expanded');
          addLine(card, 'signing key', truncate(String(p.verifying_key_hex || ''), 20));
          addLine(card, 'model', String(p.model_id || 'unknown'));
          addLine(card, 'admitted policy', truncate(String(p.policy_id || 'unknown'), 40));
          addLine(card, 'policy hash', truncate(String(p.policy_hash || ''), 16));
          var allowlist = p.model_profile_allowlist;
          if (Array.isArray(allowlist) && allowlist.length > 0) {
            addLine(card, 'admitted profiles', allowlist.join(', '));
          }
          var providerAllowlist = p.provider_allowlist;
          if (Array.isArray(providerAllowlist) && providerAllowlist.length > 0) {
            addLine(card, 'admitted providers', providerAllowlist.join(', '));
          }

          // Human-readable rule descriptions
          var RULE_DESCRIPTIONS = {
            no_digits: 'blocks decimal digits (Unicode Nd) in output strings',
            no_currency_symbols: 'blocks currency symbols (Unicode Sc) in output strings',
          };
          var rules = p.enforcement_rules;
          if (Array.isArray(rules)) {
            for (var ri = 0; ri < rules.length; ri++) {
              var ruleObj = rules[ri];
              var ruleId = typeof ruleObj === 'string' ? ruleObj : (ruleObj.rule_id || '');
              var ruleClass = typeof ruleObj === 'object' ? (ruleObj.classification || '') : '';
              var ruleDesc = RULE_DESCRIPTIONS[ruleId] || ruleId;
              var ruleDisplay = ruleId + ' \u2014 ' + ruleDesc;
              if (ruleClass) ruleDisplay += ' [' + ruleClass + ']';
              addLine(card, 'rule', ruleDisplay);
            }
          }

          // Entropy constraints
          var entropy = p.entropy_constraints;
          if (entropy) {
            addLine(card, 'entropy budget', (entropy.budget_bits || '?') + ' bits (' + (entropy.classification || 'ADVISORY') + ')');
          }

          addStatus(card, true, 'Policy admitted \u2014 relay ready');
        }
        break;
      }
    }
  }

  function renderError(title, detail) {
    if (!container) return;
    stepCount++;
    var card = document.createElement('div');
    card.className = 'vault-card vault-card--error';
    var header = document.createElement('div');
    header.className = 'vault-card__header';
    var step = document.createElement('span');
    step.className = 'vault-card__step vault-card__step--error';
    step.textContent = '!';
    var titleEl = document.createElement('span');
    titleEl.className = 'vault-card__title';
    titleEl.textContent = title;
    header.appendChild(step);
    header.appendChild(titleEl);
    card.appendChild(header);
    addStatus(card, false, detail);
    container.appendChild(card);
    scrollVaultIntoView();
  }

  return {
    init: init,
    reset: reset,
    routeEvent: routeEvent,
    renderError: renderError,
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

// ── Canary check result card (vault column) ─────────────────────

function createCanaryResultCard(result, scenario) {
  var card = document.createElement('div');
  card.className = 'vault-card vault-card--expanded'
    + (result.passed ? ' vault-card--success' : ' vault-card--error');

  var header = document.createElement('div');
  header.className = 'vault-card__header';

  var tag = document.createElement('span');
  tag.className = 'vault-card__step-tag';
  tag.textContent = '\u2690';
  header.appendChild(tag);

  var titleEl = document.createElement('span');
  titleEl.className = 'vault-card__title';
  titleEl.textContent = result.passed
    ? 'Canary Check \u2014 PASS'
    : 'Canary Check \u2014 FAIL';
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

  // Scenario label
  var scenarioLine = document.createElement('div');
  scenarioLine.className = 'vault-line';
  var slKey = document.createElement('span');
  slKey.className = 'vault-line__key';
  slKey.textContent = 'scenario';
  var slVal = document.createElement('span');
  slVal.className = 'vault-line__value';
  slVal.textContent = scenario.label;
  scenarioLine.appendChild(slKey);
  scenarioLine.appendChild(slVal);
  body.appendChild(scenarioLine);

  // Summary counts
  var totalCanaries = scenario.canaries.length;
  var totalInverse = scenario.inverseCanaries.length;
  var summaryLine = document.createElement('div');
  summaryLine.className = 'vault-line';
  var sumKey = document.createElement('span');
  sumKey.className = 'vault-line__key';
  sumKey.textContent = 'checked';
  var sumVal = document.createElement('span');
  sumVal.className = 'vault-line__value';
  sumVal.textContent = totalCanaries + ' canaries, ' + totalInverse + ' required disclosures';
  summaryLine.appendChild(sumKey);
  summaryLine.appendChild(sumVal);
  body.appendChild(summaryLine);

  // Leaked canaries (HARD FAIL)
  for (var i = 0; i < result.leaked.length; i++) {
    var line = document.createElement('div');
    line.className = 'vault-line';
    var keyEl = document.createElement('span');
    keyEl.className = 'vault-line__key canary-fail';
    keyEl.textContent = 'LEAKED';
    var valEl = document.createElement('span');
    valEl.className = 'vault-line__value';
    valEl.textContent = result.leaked[i];
    line.appendChild(keyEl);
    line.appendChild(valEl);
    body.appendChild(line);
  }

  // Missing inverse canaries (SOFT FAIL)
  for (var j = 0; j < result.absent.length; j++) {
    var line = document.createElement('div');
    line.className = 'vault-line';
    var keyEl = document.createElement('span');
    keyEl.className = 'vault-line__key canary-missing';
    keyEl.textContent = 'MISSING';
    var valEl = document.createElement('span');
    valEl.className = 'vault-line__value';
    valEl.textContent = result.absent[j];
    line.appendChild(keyEl);
    line.appendChild(valEl);
    body.appendChild(line);
  }

  card.appendChild(body);

  // Status indicator
  var status = document.createElement('div');
  if (result.passed) {
    status.className = 'vault-card__status vault-card__status--ok';
    status.textContent = '\u2713 All canaries respected';
  } else if (result.leaked.length > 0) {
    status.className = 'vault-card__status vault-card__status--error';
    status.textContent = '\u2717 HARD FAIL \u2014 private data leaked';
  } else {
    status.className = 'vault-card__status vault-card__status--error';
    status.textContent = '\u2717 SOFT FAIL \u2014 required disclosures missing';
  }
  card.appendChild(status);

  return card;
}
