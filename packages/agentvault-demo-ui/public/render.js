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

/**
 * Create a protocol log entry (tool calls, results, system events).
 * Returns a DOM element.
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

/**
 * Create a conversation message for an agent panel.
 * Only handles llm_text events. Returns DOM element or null.
 */
function createConvMessage(event) {
  if (event.type !== 'llm_text') return null;

  var msg = document.createElement('div');
  msg.className = 'conv-msg';
  msg.textContent = event.payload.text;
  return msg;
}

/**
 * Create the initial prompt display shown at top of agent panel.
 */
function createPromptBlock(promptText) {
  var block = document.createElement('div');
  block.className = 'conv-prompt';

  var label = document.createElement('span');
  label.className = 'conv-label';
  label.textContent = 'Instructions';

  block.appendChild(label);
  block.appendChild(document.createTextNode(promptText));
  return block;
}
