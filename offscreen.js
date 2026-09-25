let recorder = null;
let chunks = [];
let baseStream = null;
let micStream = null;
let audioCtx = null;
let keepAliveSource = null;
let micTrack = null;
let meetMuted = false;
let recordedStream = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target && message.target !== 'offscreen') {
    return;
  }

  if (message.type === 'start-recording' || message.action === 'INIT_RECORDER') {
    startRecording(message.data || message.streamId)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
    return true;
  }

  if (message.type === 'stop-recording' || message.action === 'FINALIZE_AUDIO') {
    stopRecording(message.filename)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
    return true;
  }

  if (message.action === 'UPDATE_MUTE_STATE') {
    meetMuted = Boolean(message.isMuted);
    if (micTrack) {
      micTrack.enabled = !meetMuted;
    }
    sendResponse({ ok: true });
    return;
  }

  if (message.action === 'PING') {
    sendResponse({ ok: true });
  }
});

async function micAlreadyGranted() {
  try {
    if (!navigator.permissions || !navigator.permissions.query) {
      return false;
    }
    const result = await navigator.permissions.query({ name: 'microphone' });
    return result.state === 'granted';
  } catch (_) {
    return false;
  }
}

function buildRecordStream(tabStream, optionalMic) {
  const tabAudioTracks = tabStream.getAudioTracks();
  const tabVideoTracks = tabStream.getVideoTracks();
  if (!tabAudioTracks.length) {
    throw new Error('Tab capture returned no audio track');
  }
  tabAudioTracks.forEach((track) => {
    track.enabled = true;
  });

  if (!optionalMic || !optionalMic.getAudioTracks().length) {
    return new MediaStream([...tabVideoTracks, ...tabAudioTracks]);
  }

  const dest = audioCtx.createMediaStreamDestination();
  const tabAudioClone = tabAudioTracks[0].clone();
  audioCtx.createMediaStreamSource(new MediaStream([tabAudioClone])).connect(dest);
  micTrack = optionalMic.getAudioTracks()[0];
  micTrack.enabled = !meetMuted;
  audioCtx.createMediaStreamSource(new MediaStream([micTrack])).connect(dest);
  return new MediaStream([...tabVideoTracks, ...dest.stream.getAudioTracks()]);
}

async function startRecording(streamId) {
  if (recorder && recorder.state === 'recording') {
    throw new Error('Already recording');
  }

  chunks = [];
  meetMuted = false;
  micTrack = null;

  baseStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    },
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
        maxWidth: 1280,
        maxHeight: 720,
        maxFrameRate: 15
      }
    }
  });

  audioCtx = new AudioContext();
  if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
  }
  keepAliveSource = audioCtx.createMediaStreamSource(baseStream);
  keepAliveSource.connect(audioCtx.destination);

  let hasMic = false;
  if (await micAlreadyGranted()) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      hasMic = micStream.getAudioTracks().length > 0;
    } catch (_) {
      micStream = null;
      hasMic = false;
    }
  }

  recordedStream = buildRecordStream(baseStream, micStream);
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
    ? 'video/webm;codecs=vp8,opus'
    : 'video/webm';

  recorder = new MediaRecorder(recordedStream, { mimeType, audioBitsPerSecond: 128000 });
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      chunks.push(event.data);
    }
  };

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('MediaRecorder failed to start')), 4000);
    recorder.onstart = () => {
      clearTimeout(timeout);
      resolve();
    };
    recorder.onerror = (event) => {
      clearTimeout(timeout);
      reject(event.error || new Error('MediaRecorder error'));
    };
    try {
      recorder.start(1000);
    } catch (err) {
      clearTimeout(timeout);
      reject(err);
    }
  });

  chrome.runtime.sendMessage({
    action: 'PUSH_MIC_LEVEL',
    level: 0,
    hasMic,
    muted: meetMuted
  }).catch(() => {});

  window.location.hash = 'recording';
  return { hasMic, mimeType };
}

function stopTracks() {
  if (recordedStream) {
    recordedStream.getTracks().forEach((t) => {
      try { t.stop(); } catch (_) {}
    });
    recordedStream = null;
  }
  if (baseStream) {
    baseStream.getTracks().forEach((t) => {
      try { t.stop(); } catch (_) {}
    });
    baseStream = null;
  }
  if (micStream) {
    micStream.getTracks().forEach((t) => {
      try { t.stop(); } catch (_) {}
    });
    micStream = null;
  }
  micTrack = null;
  keepAliveSource = null;
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
}

function stopRecording(filename) {
  return new Promise((resolve, reject) => {
    const active = recorder;
    if (!active || active.state === 'inactive') {
      stopTracks();
      window.location.hash = '';
      resolve({ ok: false, error: 'Recorder was not active', byteLength: 0 });
      return;
    }

    const mimeType = active.mimeType || 'video/webm';
    active.onstop = () => {
      try {
        const blob = new Blob(chunks, { type: mimeType });
        chunks = [];
        recorder = null;
        stopTracks();
        window.location.hash = '';
        if (!blob.size) {
          resolve({ ok: false, error: 'Recording produced 0 bytes', byteLength: 0 });
          return;
        }
        resolve({
          ok: true,
          blobUrl: URL.createObjectURL(blob),
          byteLength: blob.size,
          mimeType,
          extension: 'webm',
          filename: filename || `Meet-Recording-${Date.now()}.webm`
        });
      } catch (err) {
        reject(err);
      }
    };

    try {
      if (active.state === 'recording') {
        active.requestData();
      }
      setTimeout(() => {
        try {
          active.stop();
        } catch (err) {
          reject(err);
        }
      }, 250);
    } catch (err) {
      reject(err);
    }
  });
}

chrome.runtime.sendMessage({ action: 'OFFSCREEN_READY' }).catch(() => {});
