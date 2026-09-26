let currentMicState = { level: 0, hasMic: false, muted: false };
let stopping = false;
let creatingOffscreen = null;

async function setRecordingUi(isRecording) {
  try {
    await chrome.action.setBadgeText({ text: isRecording ? 'REC' : '' });
    await chrome.action.setBadgeBackgroundColor({ color: isRecording ? '#d93025' : '#000000' });
    await chrome.action.setTitle({
      title: isRecording
        ? 'Google Meet Recorder (Video + .vtt) — Recording'
        : 'Google Meet Recorder (Video + .vtt)'
    });
  } catch (_) {}
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'START_RECORDING') {
    startRecordingSequence()
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((err) => sendResponse({
        success: false,
        error: String(err && err.message ? err.message : err)
      }));
    return true;
  }

  if (message.action === 'STOP_RECORDING') {
    stopRecordingSequence('manual')
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((err) => sendResponse({
        success: false,
        error: String(err && err.message ? err.message : err)
      }));
    return true;
  }

  if (message.action === 'MEET_ENDED') {
    stopRecordingSequence('meet-ended')
      .then(() => sendResponse({ success: true }))
      .catch(() => sendResponse({ success: false }));
    return true;
  }

  if (message.action === 'UPDATE_MUTE_STATE') {
    currentMicState = { ...currentMicState, muted: Boolean(message.isMuted) };
    chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'UPDATE_MUTE_STATE',
      isMuted: Boolean(message.isMuted)
    }).catch(() => {});
    sendResponse({ success: true });
    return;
  }

  if (message.action === 'PUSH_MIC_LEVEL') {
    currentMicState = {
      level: Number(message.level) || 0,
      hasMic: Boolean(message.hasMic),
      muted: Boolean(message.muted)
    };
    sendResponse({ success: true });
    return;
  }

  if (message.action === 'GET_MIC_STATE') {
    sendResponse({ data: currentMicState });
    return;
  }

  if (message.action === 'OFFSCREEN_READY') {
    sendResponse({ success: true });
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const data = await chrome.storage.local.get(['isRecording', 'targetTabId']);
  if (data.isRecording && data.targetTabId === tabId) {
    stopRecordingSequence('tab-closed').catch(() => {});
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) {
    return;
  }
  const data = await chrome.storage.local.get(['isRecording', 'targetTabId']);
  if (!data.isRecording || data.targetTabId !== tabId) {
    return;
  }
  if (!changeInfo.url.includes('meet.google.com')) {
    stopRecordingSequence('left-meet').catch(() => {});
  }
});

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    return;
  }
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'Recording from chrome.tabCapture API'
    }).finally(() => {
      creatingOffscreen = null;
    });
  }
  await creatingOffscreen;
  await new Promise((resolve) => setTimeout(resolve, 100));
}

function sendToOffscreen(payload) {
  return chrome.runtime.sendMessage({ target: 'offscreen', ...payload });
}

async function ensureContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js']
  });
}

function waitForDownload(downloadId) {
  return new Promise((resolve, reject) => {
    if (downloadId === undefined || downloadId === null) {
      reject(new Error('Missing download id'));
      return;
    }

    const onChanged = (delta) => {
      if (delta.id !== downloadId) {
        return;
      }
      if (!delta.state) {
        return;
      }
      if (delta.state.current === 'complete') {
        chrome.downloads.onChanged.removeListener(onChanged);
        resolve(true);
      } else if (delta.state.current === 'interrupted') {
        chrome.downloads.onChanged.removeListener(onChanged);
        reject(new Error('Download interrupted'));
      }
    };

    chrome.downloads.onChanged.addListener(onChanged);
    setTimeout(() => {
      chrome.downloads.onChanged.removeListener(onChanged);
      chrome.downloads.search({ id: downloadId }, (results) => {
        const item = results && results[0];
        if (item && item.state === 'complete') {
          resolve(true);
          return;
        }
        if (item && item.state === 'in_progress') {
          reject(new Error('Download still in progress; kept offscreen open too briefly'));
          return;
        }
        reject(new Error('Download did not complete'));
      });
    }, 60000);
  });
}

async function downloadUrl(url, filename) {
  const downloadId = await new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, saveAs: false }, (id) => {
      if (chrome.runtime.lastError || id === undefined) {
        reject(new Error(chrome.runtime.lastError ? chrome.runtime.lastError.message : 'Download failed'));
        return;
      }
      resolve(id);
    });
  });
  await waitForDownload(downloadId);
  return true;
}

function pad(num, size = 2) {
  let s = String(Math.floor(Math.abs(num)));
  while (s.length < size) {
    s = '0' + s;
  }
  return s;
}

function formatVttTimestamp(ms) {
  const total = Math.max(0, Math.floor(ms));
  const hours = Math.floor(total / 3600000);
  const minutes = Math.floor((total % 3600000) / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const millis = total % 1000;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`;
}

const MIN_VTT_CUE_MS = 1000;

function buildVtt(transcript, startedAt) {
  const entries = Array.isArray(transcript) ? transcript.slice() : [];
  const hasConversation = entries.some((entry) => entry && entry.mode === 'conversation');
  if (hasConversation) {
    entries.sort((a, b) => {
      const aAt = typeof a.at === 'number' ? a.at : 0;
      const bAt = typeof b.at === 'number' ? b.at : 0;
      if (aAt !== bAt) {
        return aAt - bAt;
      }
      return String(a.author || '').localeCompare(String(b.author || ''));
    });
  }

  let body = 'WEBVTT\n\n';
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const text = entry && entry.text ? String(entry.text) : String(entry);
    const at = entry && typeof entry.at === 'number' ? entry.at : startedAt;
    const startMs = Math.max(0, at - startedAt);
    let endMs;
    if (entry && typeof entry.endAt === 'number') {
      endMs = Math.max(startMs + MIN_VTT_CUE_MS, entry.endAt - startedAt);
    } else {
      const nextAt = i + 1 < entries.length && typeof entries[i + 1].at === 'number'
        ? entries[i + 1].at
        : at + 3000;
      endMs = Math.max(startMs + MIN_VTT_CUE_MS, nextAt - startedAt);
    }
    body += `${i + 1}\n${formatVttTimestamp(startMs)} --> ${formatVttTimestamp(endMs)}\n${text}\n\n`;
  }
  return body;
}

async function startRecordingSequence() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !tab.url || !tab.url.includes('meet.google.com')) {
    throw new Error('Open a Google Meet tab, then click Start');
  }

  await ensureOffscreenDocument();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });

  const recordingStartedAt = Date.now();
  await chrome.storage.local.set({
    isRecording: true,
    targetTabId: tab.id,
    transcript: [],
    recordingStartedAt,
    captionStatus: { state: 'waiting', lines: 0, at: Date.now() },
    captionLivePreview: null
  });
  await setRecordingUi(true);

  currentMicState = { level: 0, hasMic: false, muted: false };

  try {
    const startResult = await sendToOffscreen({
      type: 'start-recording',
      target: 'offscreen',
      data: streamId,
      action: 'INIT_RECORDER',
      streamId
    });

    if (!startResult || startResult.ok === false) {
      throw new Error(startResult && startResult.error ? startResult.error : 'Failed to start tab capture');
    }

    currentMicState = {
      ...currentMicState,
      hasMic: Boolean(startResult.hasMic)
    };

    await ensureContentScript(tab.id);
    const settings = await chrome.storage.local.get(['conversationVtt']);
    const conversationVtt = Boolean(settings.conversationVtt);
    const scrapeResult = await chrome.tabs.sendMessage(tab.id, {
      action: 'START_SCRAPING',
      conversationVtt
    }).catch(() => null);

    return {
      hasMic: Boolean(startResult.hasMic),
      audioTracks: startResult.audioTracks || 0,
      conversationMode: Boolean(scrapeResult && scrapeResult.conversationMode),
      conversationVtt
    };
  } catch (err) {
    await chrome.storage.local.set({
      isRecording: false,
      targetTabId: null,
      transcript: [],
      recordingStartedAt: null,
      captionStatus: null,
      captionLivePreview: null
    });
    await setRecordingUi(false);
    if (await hasOffscreenDocument()) {
      await chrome.offscreen.closeDocument().catch(() => {});
    }
    throw err;
  }
}

async function stopRecordingSequence(reason) {
  if (stopping) {
    return { skipped: true };
  }

  const flag = await chrome.storage.local.get(['isRecording']);
  if (!flag.isRecording && reason !== 'manual') {
    return { skipped: true };
  }

  stopping = true;
  let audioDownloaded = false;

  try {
    await new Promise((r) => setTimeout(r, 300));
    const data = await chrome.storage.local.get([
      'targetTabId',
      'transcript',
      'recordingStartedAt'
    ]);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `Meet-Recording-${timestamp}.webm`;

    if (data.targetTabId) {
      try {
        const stopResult = await chrome.tabs.sendMessage(data.targetTabId, { action: 'STOP_SCRAPING' });
        if (stopResult && Array.isArray(stopResult.transcript) && stopResult.transcript.length) {
          await chrome.storage.local.set({ transcript: stopResult.transcript });
        }
      } catch (_) {}
    }

    if (await hasOffscreenDocument()) {
      const result = await sendToOffscreen({
        type: 'stop-recording',
        target: 'offscreen',
        action: 'FINALIZE_AUDIO',
        filename
      });

      if (result && result.ok && result.blobUrl && result.byteLength > 0) {
        audioDownloaded = await downloadUrl(result.blobUrl, result.filename || filename);
      } else if (reason === 'manual') {
        throw new Error(result && result.error ? result.error : 'No recording was captured');
      }
    }

    const latest = await chrome.storage.local.get(['transcript', 'recordingStartedAt']);
    const transcript = latest.transcript || data.transcript || [];
    if (transcript.length > 0) {
      const vtt = buildVtt(transcript, latest.recordingStartedAt || data.recordingStartedAt || Date.now());
      const vttUrl = 'data:text/vtt;charset=utf-8,' + encodeURIComponent(vtt);
      await downloadUrl(vttUrl, `Meet-Transcript-${timestamp}.vtt`);
    }

    return { audioDownloaded, reason, bytes: audioDownloaded };
  } finally {
    await new Promise((r) => setTimeout(r, 500));
    if (await hasOffscreenDocument()) {
      await chrome.offscreen.closeDocument().catch(() => {});
    }
    currentMicState = { level: 0, hasMic: false, muted: false };
    await setRecordingUi(false);
    await chrome.storage.local.set({
      isRecording: false,
      targetTabId: null,
      transcript: [],
      recordingStartedAt: null,
      captionStatus: null,
      captionLivePreview: null,
      lastSave: {
        at: Date.now(),
        audioDownloaded: Boolean(audioDownloaded),
        reason
      }
    });
    stopping = false;
  }
}
