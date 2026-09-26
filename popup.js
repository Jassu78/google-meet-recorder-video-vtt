const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const statusDiv = document.getElementById('status');
const micPanel = document.getElementById('micPanel');
const micBadge = document.getElementById('micBadge');
const micIcon = document.getElementById('micIcon');
const meterFill = document.getElementById('meterFill');
const meterHint = document.getElementById('meterHint');
const recBanner = document.getElementById('recBanner');
const captionStatus = document.getElementById('captionStatus');
const conversationVtt = document.getElementById('conversationVtt');
const conversationRow = document.getElementById('conversationRow');

let animationFrameId = null;
let displayedLevel = 0;

function setConversationEnabled(enabled) {
  if (conversationRow) {
    conversationRow.classList.toggle('disabled', !enabled);
  }
  if (conversationVtt) {
    conversationVtt.disabled = !enabled;
  }
}

if (conversationVtt) {
  conversationVtt.addEventListener('change', () => {
    chrome.storage.local.set({ conversationVtt: Boolean(conversationVtt.checked) });
  });
}

function refreshFromStorage() {
  chrome.storage.local.get(['isRecording', 'captionStatus', 'conversationVtt'], (result) => {
    if (conversationVtt) {
      conversationVtt.checked = Boolean(result.conversationVtt);
    }
    if (result.isRecording) {
      toggleUI(true);
      startMeterLoop();
    } else {
      setConversationEnabled(true);
    }
    renderCaptionStatus(result.captionStatus);
  });
}

refreshFromStorage();

chrome.storage.onChanged.addListener((changes) => {
  if (changes.isRecording) {
    if (changes.isRecording.newValue) {
      toggleUI(true);
      startMeterLoop();
    } else if (changes.isRecording.oldValue) {
      stopMeterLoop();
      toggleUI(false);
      chrome.storage.local.get(['lastSave'], (result) => {
        if (result.lastSave && result.lastSave.audioDownloaded) {
          statusDiv.innerText = 'Status: Saved locally';
        } else {
          statusDiv.innerText = 'Status: Stopped';
        }
      });
    }
  }
  if (changes.captionStatus || changes.captionLivePreview) {
    renderCaptionStatus(changes.captionStatus ? changes.captionStatus.newValue : null);
  }
});

startBtn.addEventListener('click', () => {
  statusDiv.classList.remove('error');
  statusDiv.innerText = 'Status: Starting…';
  startBtn.disabled = true;

  chrome.runtime.sendMessage({ action: 'START_RECORDING' }, (response) => {
    if (chrome.runtime.lastError) {
      toggleUI(false);
      statusDiv.classList.add('error');
      statusDiv.innerText = chrome.runtime.lastError.message;
      return;
    }
    if (response && response.success) {
      toggleUI(true);
      startMeterLoop();
      return;
    }
    toggleUI(false);
    statusDiv.classList.add('error');
    statusDiv.innerText = response && response.error ? response.error : 'Failed to start';
  });
});

stopBtn.addEventListener('click', () => {
  statusDiv.classList.remove('error');
  statusDiv.innerText = 'Status: Saving…';
  chrome.runtime.sendMessage({ action: 'STOP_RECORDING' }, (response) => {
    stopMeterLoop();
    toggleUI(false);
    if (chrome.runtime.lastError) {
      statusDiv.classList.add('error');
      statusDiv.innerText = chrome.runtime.lastError.message;
      return;
    }
    if (response && response.success) {
      statusDiv.innerText = 'Status: Saved locally';
    } else {
      statusDiv.classList.add('error');
      statusDiv.innerText = response && response.error ? response.error : 'Failed to stop';
    }
  });
});

function renderCaptionStatus(info) {
  if (!captionStatus) {
    return;
  }
  chrome.storage.local.get(['isRecording', 'captionLivePreview', 'captionStatus'], (result) => {
    if (!result.isRecording) {
      captionStatus.classList.remove('visible', 'live', 'waiting');
      captionStatus.innerText = '';
      return;
    }
    const status = info || result.captionStatus;
    const preview = result.captionLivePreview;
    captionStatus.classList.add('visible');
    captionStatus.classList.remove('live', 'waiting');
    if (preview && preview.text) {
      captionStatus.classList.add('live');
      captionStatus.innerText = 'Meet CC · ' + preview.text;
      return;
    }
    if (status && status.state === 'live') {
      captionStatus.classList.add('live');
      captionStatus.innerText = 'Meet CC active · ' + (status.lines || 0) + ' line(s) saved';
      return;
    }
    captionStatus.classList.add('waiting');
    captionStatus.innerText = 'Meet CC · waiting (turn captions on in Meet)';
  });
}

function toggleUI(recording) {
  startBtn.disabled = recording;
  stopBtn.disabled = !recording;
  statusDiv.classList.remove('error');
  statusDiv.innerText = recording ? 'Status: Recording…' : 'Status: Idle';
  micPanel.classList.toggle('visible', recording);
  recBanner.classList.toggle('visible', recording);
  setConversationEnabled(!recording);
  if (recording) {
    renderCaptionStatus({ state: 'waiting', lines: 0 });
  } else {
    displayedLevel = 0;
    meterFill.style.width = '0%';
    meterFill.classList.add('silent');
    meterFill.classList.remove('muted');
    micBadge.className = 'mic-badge';
    micBadge.innerText = 'Idle';
    micIcon.className = 'mic-icon';
    meterHint.innerText = 'Mute in Meet only drops your mic mix. Others stay in the recording.';
    captionStatus.classList.remove('visible', 'live', 'waiting');
    captionStatus.innerText = '';
  }
}

function updateMeterUI(state) {
  const level = Math.max(0, Math.min(1, Number(state.level) || 0));
  displayedLevel = displayedLevel * 0.65 + level * 0.35;
  const pct = Math.round(displayedLevel * 100);
  meterFill.style.width = pct + '%';
  meterFill.classList.toggle('muted', Boolean(state.muted));
  meterFill.classList.toggle('silent', !state.muted && pct < 3);
  micIcon.classList.remove('active', 'muted');
  micBadge.className = 'mic-badge';

  if (!state.hasMic) {
    micBadge.classList.add('missing');
    micBadge.innerText = 'Tab only';
    meterHint.innerText = 'Recording Meet tab. Your mic is not mixed unless Chrome already allowed it.';
    return;
  }
  if (state.muted) {
    micBadge.classList.add('muted');
    micBadge.innerText = 'Mic muted';
    micIcon.classList.add('muted');
    meterHint.innerText = 'Meet mic off — your voice is not mixed; other people still record.';
    return;
  }
  if (pct >= 3) {
    micBadge.classList.add('live');
    micBadge.innerText = 'Live';
    micIcon.classList.add('active');
    meterHint.innerText = 'Mic is receiving input';
  } else {
    micBadge.innerText = 'Silent';
    meterHint.innerText = 'Speak to confirm mic input';
  }
}

function startMeterLoop() {
  cancelAnimationFrame(animationFrameId);
  function tick() {
    animationFrameId = requestAnimationFrame(tick);
    chrome.runtime.sendMessage({ action: 'GET_MIC_STATE' }, (response) => {
      if (chrome.runtime.lastError || !response || !response.data) {
        return;
      }
      updateMeterUI(response.data);
    });
  }
  tick();
}

function stopMeterLoop() {
  cancelAnimationFrame(animationFrameId);
  animationFrameId = null;
}
