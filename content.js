if (!globalThis.__meetLocalRecorderLoaded) {
globalThis.__meetLocalRecorderLoaded = true;

let captionObserver = null;
let rootWatcher = null;
let muteObserver = null;
let leaveObserver = null;
let activeRecording = false;
let mutePollId = null;
let leavePollId = null;
let scanPollId = null;
let lastKnownMuted = null;
let meetEndSent = false;
let overlayEl = null;
let activeBlocks = new Map();
let transcriptBuffer = [];
let captionLineCount = 0;
let lastStatusKey = '';
let persistTimer = null;
let conversationMode = false;
let openTurns = new Map();
let turnByNodeId = new Map();
let stabilityTimers = new Map();
let nextTurnSeq = 1;

const STABILITY_MS = 1500;
const BARGE_IN_STABILITY_MS = 2500;
const REMOUNT_REBIND_MS = 2500;
const MIN_CUE_MS = 1000;

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === 'PING_CONTENT') {
    sendResponse({ success: true });
    return;
  }

  if (request.action === 'START_SCRAPING') {
    activeRecording = true;
    lastKnownMuted = null;
    meetEndSent = false;
    conversationMode = Boolean(request.conversationVtt);
    resetCaptionState();
    showRecordingOverlay();
    startCaptionCapture();
    initMuteMonitor();
    initLeaveMonitor();
    publishCaptionStatus('waiting', true);
    sendResponse({ success: true, conversationMode });
    return;
  }

  if (request.action === 'STOP_SCRAPING') {
    activeRecording = false;
    flushActiveBlocks();
    persistTranscript(true);
    teardown();
    hideRecordingOverlay();
    sendResponse({
      success: true,
      captionLineCount: transcriptBuffer.length,
      transcript: transcriptBuffer.slice(),
      conversationMode
    });
  }
});

function resetCaptionState() {
  activeBlocks.clear();
  clearAllStabilityTimers();
  openTurns.clear();
  turnByNodeId.clear();
  nextTurnSeq = 1;
  transcriptBuffer = [];
  captionLineCount = 0;
  lastStatusKey = '';
}

function publishCaptionStatus(state, force) {
  const key = state + ':' + captionLineCount;
  if (!force && key === lastStatusKey) {
    updateOverlayCaptionHint(state);
    return;
  }
  lastStatusKey = key;
  chrome.storage.local.set({
    captionStatus: {
      state,
      lines: captionLineCount,
      at: Date.now()
    }
  });
  updateOverlayCaptionHint(state);
}

function teardown() {
  if (captionObserver) {
    captionObserver.disconnect();
    captionObserver = null;
  }
  if (rootWatcher) {
    rootWatcher.disconnect();
    rootWatcher = null;
  }
  if (muteObserver) {
    muteObserver.disconnect();
    muteObserver = null;
  }
  if (leaveObserver) {
    leaveObserver.disconnect();
    leaveObserver = null;
  }
  if (mutePollId) {
    clearInterval(mutePollId);
    mutePollId = null;
  }
  if (leavePollId) {
    clearInterval(leavePollId);
    leavePollId = null;
  }
  if (scanPollId) {
    clearInterval(scanPollId);
    scanPollId = null;
  }
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  clearAllStabilityTimers();
  activeBlocks.clear();
  openTurns.clear();
  turnByNodeId.clear();
}

function showRecordingOverlay() {
  hideRecordingOverlay();
  overlayEl = document.createElement('div');
  overlayEl.id = 'meet-local-recorder-overlay';
  overlayEl.style.cssText = [
    'position:fixed',
    'top:16px',
    'left:50%',
    'transform:translateX(-50%)',
    'z-index:2147483646',
    'display:flex',
    'align-items:center',
    'gap:10px',
    'padding:8px 14px',
    'border-radius:999px',
    'background:rgba(32,33,36,.92)',
    'color:#fff',
    'font:600 12px/1.2 "Google Sans","Segoe UI",sans-serif',
    'box-shadow:0 4px 16px rgba(0,0,0,.35)',
    'pointer-events:none'
  ].join(';');
  overlayEl.innerHTML = '<span style="width:8px;height:8px;border-radius:50%;background:#ea4335;display:inline-block"></span><span>Recording</span><span id="mlr-cap-hint" style="font-weight:500;color:#bdc1c6"></span>';
  document.documentElement.appendChild(overlayEl);
  updateOverlayCaptionHint('waiting');
}

function updateOverlayCaptionHint(state) {
  const hint = document.getElementById('mlr-cap-hint');
  if (!hint) {
    return;
  }
  if (state === 'live') {
    hint.textContent = captionLineCount > 0
      ? `· captions saved ${captionLineCount}`
      : '· captions live';
  } else if (state === 'waiting') {
    hint.textContent = '· waiting for Meet captions';
  } else {
    hint.textContent = '';
  }
}

function hideRecordingOverlay() {
  if (overlayEl && overlayEl.parentNode) {
    overlayEl.parentNode.removeChild(overlayEl);
  }
  overlayEl = null;
}

function findCaptionRoot() {
  const regions = document.querySelectorAll('div[role="region"][aria-label]');
  for (const region of regions) {
    const label = (region.getAttribute('aria-label') || '').toLowerCase();
    if (
      label.includes('caption') ||
      label.includes('subtitle') ||
      label.includes('legenda') ||
      label.includes('untertitel') ||
      label.includes('字幕')
    ) {
      return region;
    }
  }
  return (
    document.querySelector('.a4b5H') ||
    document.querySelector('[data-is-persistent-captions]') ||
    null
  );
}

function extractBlocks(root) {
  if (!root) {
    return [];
  }
  const preferred = root.querySelectorAll('div.nMcdL, div.nZW3Fe, div.TBZ21b');
  if (preferred.length) {
    return Array.from(preferred);
  }

  const blocks = [];
  root.querySelectorAll('div').forEach((node) => {
    if (readBlock(node).text) {
      blocks.push(node);
    }
  });
  return blocks;
}

function readBlock(block) {
  const nameEl =
    block.querySelector('.NWpY1d') ||
    block.querySelector('.KcIKyf') ||
    block.querySelector('.KxvlWc') ||
    block.querySelector('[class*="NWpY"]');
  const textEl =
    block.querySelector('.ygicle') ||
    block.querySelector('.VbkSUe') ||
    block.querySelector('.ZS735c') ||
    block.querySelector('[class*="ygicle"]');

  const author = nameEl ? nameEl.textContent.trim() : '';
  const text = textEl ? textEl.textContent.trim() : '';
  return { author, text };
}

function blockKey(block) {
  if (!block.dataset.mlrCapKey) {
    block.dataset.mlrCapKey = Math.random().toString(36).slice(2);
  }
  return block.dataset.mlrCapKey;
}

function isNoise(author, text) {
  const value = `${author} ${text}`.toLowerCase();
  if (!text || text.length < 2) {
    return true;
  }
  return (
    value.includes('your camera is off') ||
    value.includes('your microphone is on') ||
    value.includes('your microphone is off') ||
    value.includes('live captions are on') ||
    value.includes('live captions are off') ||
    value.includes('captions are on') ||
    value.includes('turn on captions') ||
    value.includes('you left the meeting')
  );
}

function normalizeCaptionText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function isContinuation(previousText, nextText) {
  const prev = normalizeCaptionText(previousText).toLowerCase();
  const next = normalizeCaptionText(nextText).toLowerCase();
  if (!prev || !next) {
    return false;
  }
  if (next === prev) {
    return true;
  }
  if (next.startsWith(prev)) {
    return true;
  }
  if (prev.startsWith(next) && next.length >= Math.max(8, Math.floor(prev.length * 0.6))) {
    return true;
  }
  const prevTail = prev.slice(-40);
  if (prevTail.length >= 12 && next.includes(prevTail)) {
    return true;
  }
  return false;
}

function isSoftRevision(previousText, nextText) {
  if (isContinuation(previousText, nextText) || isContinuation(nextText, previousText)) {
    return true;
  }
  const prev = normalizeCaptionText(previousText).toLowerCase();
  const next = normalizeCaptionText(nextText).toLowerCase();
  if (!prev || !next) {
    return false;
  }
  let shared = 0;
  const limit = Math.min(prev.length, next.length);
  while (shared < limit && prev[shared] === next[shared]) {
    shared += 1;
  }
  if (shared >= Math.max(16, Math.floor(Math.min(prev.length, next.length) * 0.45))) {
    return true;
  }
  const prevWords = prev.split(/\s+/).filter(Boolean);
  const nextWords = next.split(/\s+/).filter(Boolean);
  if (prevWords.length >= 3 && nextWords.length >= 3) {
    const nextSet = new Set(nextWords);
    let hits = 0;
    for (const word of prevWords) {
      if (nextSet.has(word)) {
        hits += 1;
      }
    }
    if (hits / Math.max(prevWords.length, nextWords.length) >= 0.6) {
      return true;
    }
  }
  return false;
}

function speakerLabel(author) {
  const value = String(author || '').trim();
  return value || 'Unknown';
}

function clearAllStabilityTimers() {
  for (const timerId of stabilityTimers.values()) {
    clearTimeout(timerId);
  }
  stabilityTimers.clear();
}

function clearStabilityTimer(turnId) {
  const timerId = stabilityTimers.get(turnId);
  if (timerId) {
    clearTimeout(timerId);
    stabilityTimers.delete(turnId);
  }
}

function emitConversationCue(turn) {
  const cleaned = normalizeCaptionText(turn.draft);
  if (isNoise(turn.speaker, cleaned)) {
    return;
  }
  const line = `${turn.speaker}: ${cleaned}`;
  const endAt = Math.max(turn.lastUpdateMs, turn.startMs + MIN_CUE_MS);
  const last = transcriptBuffer[transcriptBuffer.length - 1];
  if (
    last &&
    last.mode === 'conversation' &&
    last.author === turn.speaker &&
    last.message === cleaned &&
    last.at === turn.startMs
  ) {
    return;
  }
  transcriptBuffer.push({
    at: turn.startMs,
    endAt,
    text: line,
    author: turn.speaker,
    message: cleaned,
    mode: 'conversation'
  });
  captionLineCount = transcriptBuffer.length;
  persistTranscript(false);
  publishCaptionStatus('live');
}

function finalizeTurn(turnId) {
  const turn = openTurns.get(turnId);
  if (!turn) {
    return;
  }
  clearStabilityTimer(turnId);
  emitConversationCue(turn);
  openTurns.delete(turnId);
  if (turn.nodeId && turnByNodeId.get(turn.nodeId) === turnId) {
    turnByNodeId.delete(turn.nodeId);
  }
  for (const [nodeId, id] of Array.from(turnByNodeId.entries())) {
    if (id === turnId) {
      turnByNodeId.delete(nodeId);
    }
  }
}

function scheduleStability(turnId) {
  clearStabilityTimer(turnId);
  if (!openTurns.has(turnId)) {
    return;
  }
  const delay = openTurns.size > 1 ? BARGE_IN_STABILITY_MS : STABILITY_MS;
  const timerId = setTimeout(() => {
    stabilityTimers.delete(turnId);
    if (activeRecording && openTurns.has(turnId)) {
      finalizeTurn(turnId);
    }
  }, delay);
  stabilityTimers.set(turnId, timerId);
}

function openConversationTurn(speaker, text, nodeId, now) {
  const turnId = 't' + nextTurnSeq++;
  const turn = {
    turnId,
    speaker,
    draft: text,
    startMs: now,
    lastUpdateMs: now,
    nodeId
  };
  openTurns.set(turnId, turn);
  if (nodeId) {
    turnByNodeId.set(nodeId, turnId);
  }
  scheduleStability(turnId);
  return turn;
}

function findRebindTurn(speaker, text, now) {
  for (const turn of openTurns.values()) {
    if (turn.speaker !== speaker) {
      continue;
    }
    if (now - turn.lastUpdateMs > REMOUNT_REBIND_MS) {
      continue;
    }
    if (isSoftRevision(turn.draft, text)) {
      return turn;
    }
  }
  return null;
}

function observeConversationBlock(nodeId, author, text) {
  const speaker = speakerLabel(author);
  const now = Date.now();
  let turnId = turnByNodeId.get(nodeId);
  let turn = turnId ? openTurns.get(turnId) : null;

  if (!turn) {
    turn = findRebindTurn(speaker, text, now);
    if (turn) {
      turnId = turn.turnId;
      turn.nodeId = nodeId;
      turnByNodeId.set(nodeId, turnId);
    }
  }

  if (!turn) {
    openConversationTurn(speaker, text, nodeId, now);
    publishLivePreview(speaker, text);
    return;
  }

  if (turn.draft === text) {
    return;
  }

  if (isSoftRevision(turn.draft, text)) {
    turn.draft = text;
    turn.lastUpdateMs = now;
    scheduleStability(turn.turnId);
    publishLivePreview(speaker, text);
    return;
  }

  finalizeTurn(turn.turnId);
  openConversationTurn(speaker, text, nodeId, now);
  publishLivePreview(speaker, text);
}

function scanCaptionsConversation() {
  const root = findCaptionRoot();
  if (!root) {
    publishCaptionStatus('waiting');
    return;
  }

  const blocks = extractBlocks(root);
  const seen = new Set();
  let livePreview = 0;

  for (const block of blocks) {
    const key = blockKey(block);
    seen.add(key);
    const { author, text } = readBlock(block);
    const cleaned = normalizeCaptionText(text);
    if (!cleaned || isNoise(author, cleaned)) {
      continue;
    }
    livePreview += 1;
    observeConversationBlock(key, author, cleaned);
  }

  for (const [nodeId, turnId] of Array.from(turnByNodeId.entries())) {
    if (!seen.has(nodeId)) {
      turnByNodeId.delete(nodeId);
      if (openTurns.has(turnId)) {
        finalizeTurn(turnId);
      }
    }
  }

  if (livePreview > 0 || captionLineCount > 0 || openTurns.size > 0) {
    publishCaptionStatus('live');
  } else {
    publishCaptionStatus('waiting');
  }
}

function flushConversationTurns() {
  const ids = Array.from(openTurns.keys());
  for (const turnId of ids) {
    finalizeTurn(turnId);
  }
  clearAllStabilityTimers();
  openTurns.clear();
  turnByNodeId.clear();
  persistTranscript(true);
}

function persistTranscript(immediate) {
  captionLineCount = transcriptBuffer.length;
  const write = () => {
    persistTimer = null;
    chrome.storage.local.set({ transcript: transcriptBuffer.slice() });
  };
  if (immediate) {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    write();
    return;
  }
  if (persistTimer) {
    return;
  }
  persistTimer = setTimeout(write, 250);
}

function commitLine(author, text) {
  const cleaned = normalizeCaptionText(text);
  if (isNoise(author, cleaned)) {
    return false;
  }
  const line = (author ? `${author}: ${cleaned}` : cleaned).trim();
  const last = transcriptBuffer[transcriptBuffer.length - 1];
  if (last && last.text === line) {
    return false;
  }
  if (last && last.author === (author || '') && isContinuation(last.message, cleaned)) {
    last.text = line;
    last.message = cleaned;
    last.at = Date.now();
    persistTranscript(false);
    publishCaptionStatus('live');
    return true;
  }
  transcriptBuffer.push({
    at: Date.now(),
    text: line,
    author: author || '',
    message: cleaned
  });
  captionLineCount = transcriptBuffer.length;
  persistTranscript(false);
  publishCaptionStatus('live');
  return true;
}

function scanCaptions() {
  if (!activeRecording) {
    return;
  }
  if (conversationMode) {
    scanCaptionsConversation();
    return;
  }

  const root = findCaptionRoot();
  if (!root) {
    publishCaptionStatus('waiting');
    return;
  }

  const blocks = extractBlocks(root);
  const seen = new Set();
  let livePreview = 0;

  for (const block of blocks) {
    const key = blockKey(block);
    seen.add(key);
    const { author, text } = readBlock(block);
    const cleaned = normalizeCaptionText(text);
    if (!cleaned || isNoise(author, cleaned)) {
      continue;
    }

    const previous = activeBlocks.get(key);
    livePreview += 1;

    if (!previous) {
      activeBlocks.set(key, { author: author || '', text: cleaned, committed: false });
      publishLivePreview(author, cleaned);
      continue;
    }

    const sameAuthor = (previous.author || '') === (author || '');
    if (sameAuthor && previous.text === cleaned) {
      continue;
    }

    if (sameAuthor && isContinuation(previous.text, cleaned)) {
      activeBlocks.set(key, { author: author || '', text: cleaned, committed: false });
      publishLivePreview(author, cleaned);
      continue;
    }

    commitLine(previous.author, previous.text);
    activeBlocks.set(key, { author: author || '', text: cleaned, committed: false });
    publishLivePreview(author, cleaned);
  }

  for (const key of Array.from(activeBlocks.keys())) {
    if (!seen.has(key)) {
      const entry = activeBlocks.get(key);
      activeBlocks.delete(key);
      commitLine(entry.author, entry.text);
    }
  }

  if (livePreview > 0 || captionLineCount > 0) {
    publishCaptionStatus('live');
  } else {
    publishCaptionStatus('waiting');
  }
}

function publishLivePreview(author, text) {
  const line = (author ? `${author}: ${text}` : text).trim();
  chrome.storage.local.set({
    captionLivePreview: {
      text: line,
      at: Date.now()
    }
  });
  const hint = document.getElementById('mlr-cap-hint');
  if (hint) {
    const short = line.length > 48 ? line.slice(0, 45) + '…' : line;
    hint.textContent = '· ' + short;
  }
}

function flushActiveBlocks() {
  if (conversationMode) {
    flushConversationTurns();
    return;
  }
  for (const entry of activeBlocks.values()) {
    commitLine(entry.author, entry.text);
  }
  activeBlocks.clear();
  persistTranscript(true);
}

function attachCaptionObserver(root) {
  if (captionObserver) {
    captionObserver.disconnect();
  }
  captionObserver = new MutationObserver(() => scanCaptions());
  captionObserver.observe(root, { childList: true, subtree: true, characterData: true });
  if (scanPollId) {
    clearInterval(scanPollId);
  }
  scanPollId = setInterval(scanCaptions, 700);
  scanCaptions();
  publishCaptionStatus(captionLineCount > 0 ? 'live' : 'waiting');
}

function startCaptionCapture() {
  const root = findCaptionRoot();
  if (root) {
    attachCaptionObserver(root);
    return;
  }

  if (rootWatcher) {
    rootWatcher.disconnect();
  }
  rootWatcher = new MutationObserver(() => {
    const found = findCaptionRoot();
    if (found) {
      rootWatcher.disconnect();
      rootWatcher = null;
      attachCaptionObserver(found);
    }
  });
  rootWatcher.observe(document.body, { childList: true, subtree: true });
}

function findMuteButton() {
  return document.querySelector('[data-is-muted]');
}

function readMuted(button) {
  if (!button) {
    return null;
  }
  const attr = button.getAttribute('data-is-muted');
  if (attr === 'true') {
    return true;
  }
  if (attr === 'false') {
    return false;
  }
  return null;
}

function syncMute(force) {
  const muted = readMuted(findMuteButton());
  if (muted === null) {
    return;
  }
  if (!force && muted === lastKnownMuted) {
    return;
  }
  lastKnownMuted = muted;
  chrome.runtime.sendMessage({
    action: 'UPDATE_MUTE_STATE',
    isMuted: muted
  }).catch(() => {});
}

function initMuteMonitor() {
  const button = findMuteButton();
  if (!button) {
    setTimeout(() => {
      if (activeRecording) {
        initMuteMonitor();
      }
    }, 800);
    return;
  }
  syncMute(true);
  if (muteObserver) {
    muteObserver.disconnect();
  }
  muteObserver = new MutationObserver(() => syncMute(false));
  muteObserver.observe(button, { attributes: true, attributeFilter: ['data-is-muted'] });
  if (mutePollId) {
    clearInterval(mutePollId);
  }
  mutePollId = setInterval(() => {
    if (activeRecording) {
      syncMute(false);
    }
  }, 1000);
}

function hasLeftMeeting() {
  const text = document.body ? document.body.innerText : '';
  return /you left the meeting/i.test(text) || /return to home screen/i.test(text);
}

function notifyMeetEnded() {
  if (!activeRecording || meetEndSent) {
    return;
  }
  meetEndSent = true;
  activeRecording = false;
  flushActiveBlocks();
  persistTranscript(true);
  teardown();
  hideRecordingOverlay();
  chrome.runtime.sendMessage({ action: 'MEET_ENDED' }).catch(() => {});
}

function initLeaveMonitor() {
  if (leaveObserver) {
    leaveObserver.disconnect();
  }
  leaveObserver = new MutationObserver(() => {
    if (hasLeftMeeting()) {
      notifyMeetEnded();
    }
  });
  leaveObserver.observe(document.documentElement, { childList: true, subtree: true });
  if (leavePollId) {
    clearInterval(leavePollId);
  }
  leavePollId = setInterval(() => {
    if (activeRecording && hasLeftMeeting()) {
      notifyMeetEnded();
    }
  }, 1000);
}

window.addEventListener('pagehide', () => {
  if (activeRecording) {
    notifyMeetEnded();
  }
});

}
