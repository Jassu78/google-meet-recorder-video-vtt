let recorder = null;
let baseStream = null;
let micStream = null;
let audioCtx = null;
let keepAliveSource = null;
let micTrack = null;
let meetMuted = false;
let recordedStream = null;

let storageMode = 'memory';
let memoryChunks = [];
let opfsDir = null;
let opfsFileHandle = null;
let opfsWritable = null;
let opfsFileName = null;
let writeChain = Promise.resolve();
let bytesWritten = 0;
let writeFailed = false;

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

async function resetStorageState() {
  writeChain = Promise.resolve();
  memoryChunks = [];
  bytesWritten = 0;
  writeFailed = false;
  storageMode = 'memory';
  opfsFileName = null;

  if (opfsWritable) {
    try {
      await opfsWritable.abort();
    } catch (_) {
      try {
        await opfsWritable.close();
      } catch (_) {}
    }
  }
  opfsWritable = null;
  opfsFileHandle = null;
}

async function cleanupOpfsFile(fileName) {
  if (!fileName || !opfsDir) {
    return;
  }
  try {
    await opfsDir.removeEntry(fileName);
  } catch (_) {}
}

async function clearStaleOpfsRecordings() {
  if (!navigator.storage || !navigator.storage.getDirectory) {
    return;
  }
  try {
    const root = await navigator.storage.getDirectory();
    let dir;
    try {
      dir = await root.getDirectoryHandle('recordings');
    } catch (_) {
      return;
    }
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'file' && name.endsWith('.webm')) {
        try {
          await dir.removeEntry(name);
        } catch (_) {}
      }
    }
  } catch (_) {}
}

async function openOpfsWriter() {
  if (!navigator.storage || !navigator.storage.getDirectory) {
    return false;
  }
  try {
    if (navigator.storage.persist) {
      try {
        await navigator.storage.persist();
      } catch (_) {}
    }
    const root = await navigator.storage.getDirectory();
    opfsDir = await root.getDirectoryHandle('recordings', { create: true });
    opfsFileName = `recording-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.webm`;
    opfsFileHandle = await opfsDir.getFileHandle(opfsFileName, { create: true });
    opfsWritable = await opfsFileHandle.createWritable({ keepExistingData: false });
    storageMode = 'opfs';
    return true;
  } catch (_) {
    opfsWritable = null;
    opfsFileHandle = null;
    opfsFileName = null;
    storageMode = 'memory';
    return false;
  }
}

async function salvageOpfsIntoMemory() {
  if (!opfsFileHandle) {
    return;
  }
  try {
    if (opfsWritable) {
      try {
        await opfsWritable.close();
      } catch (_) {
        try {
          await opfsWritable.abort();
        } catch (_) {}
      }
      opfsWritable = null;
    }
    const partial = await opfsFileHandle.getFile();
    if (partial && partial.size > 0) {
      memoryChunks.unshift(partial);
    }
  } catch (_) {}
}

function enqueueChunk(blob) {
  if (!blob || !blob.size) {
    return;
  }

  if (storageMode !== 'opfs' || writeFailed || !opfsWritable) {
    memoryChunks.push(blob);
    bytesWritten += blob.size;
    return;
  }

  writeChain = writeChain.then(async () => {
    if (writeFailed || !opfsWritable) {
      memoryChunks.push(blob);
      bytesWritten += blob.size;
      return;
    }
    try {
      await opfsWritable.write(blob);
      bytesWritten += blob.size;
    } catch (_) {
      writeFailed = true;
      await salvageOpfsIntoMemory();
      memoryChunks.push(blob);
      bytesWritten += blob.size;
      storageMode = 'memory';
    }
  });
}

async function flushWrites() {
  await writeChain;
}

async function finalizeRecordingBlob(mimeType) {
  await flushWrites();

  const savedName = opfsFileName;

  if (storageMode === 'opfs' && opfsWritable) {
    try {
      await opfsWritable.close();
    } catch (_) {
      try {
        await opfsWritable.abort();
      } catch (_) {}
    }
    opfsWritable = null;
  }

  let blob;
  if (storageMode === 'opfs' && opfsFileHandle && !writeFailed) {
    const file = await opfsFileHandle.getFile();
    if (memoryChunks.length) {
      const buffer = await file.arrayBuffer();
      blob = new Blob([buffer, ...memoryChunks], { type: mimeType });
    } else {
      const buffer = await file.arrayBuffer();
      blob = new Blob([buffer], { type: mimeType });
    }
  } else {
    blob = new Blob(memoryChunks, { type: mimeType });
  }

  memoryChunks = [];
  await cleanupOpfsFile(savedName);
  opfsFileHandle = null;
  opfsFileName = null;

  return blob;
}

async function startRecording(streamId) {
  if (recorder && recorder.state === 'recording') {
    throw new Error('Already recording');
  }

  await resetStorageState();
  await clearStaleOpfsRecordings();
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

  const opfsReady = await openOpfsWriter();
  if (!opfsReady) {
    storageMode = 'memory';
    memoryChunks = [];
  }

  recorder = new MediaRecorder(recordedStream, { mimeType, audioBitsPerSecond: 128000 });
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      enqueueChunk(event.data);
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
  return { hasMic, mimeType, storageMode };
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
    const modeAtStop = storageMode;

    active.onstop = () => {
      finalizeRecordingBlob(mimeType)
        .then((blob) => {
          recorder = null;
          stopTracks();
          window.location.hash = '';

          if (!blob || !blob.size) {
            resolve({ ok: false, error: 'Recording produced 0 bytes', byteLength: 0 });
            return;
          }

          resolve({
            ok: true,
            blobUrl: URL.createObjectURL(blob),
            byteLength: blob.size,
            mimeType,
            extension: 'webm',
            filename: filename || `Meet-Recording-${Date.now()}.webm`,
            storageMode: writeFailed ? 'memory-fallback' : modeAtStop
          });
        })
        .catch((err) => {
          recorder = null;
          stopTracks();
          window.location.hash = '';
          reject(err);
        });
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
