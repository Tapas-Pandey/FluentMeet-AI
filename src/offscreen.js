// offscreen.js
import { pipeline, env } from './transformers.js';

// Configuration
env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;
env.backends.onnx.logLevel = 'fatal';

let transcriber = null;
let translator = null;
let modelInitPromise = null;
let modelReadyNotified = false;
let activeSession = null;

function sendToBackground(type, data, tabId) {
  if (typeof tabId !== 'number') return;
  chrome.runtime.sendMessage({ type, data, tabId });
}

async function initModel() {
  if (transcriber && translator) return;

  if (!modelInitPromise) {
    modelInitPromise = (async () => {
      console.log('Loading models...');
      console.log('[1/2] Loading Whisper (WASM)...');
      // Using WASM (not WebGPU) because WebGPU can hang in extension offscreen documents.
      transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
        dtype: 'fp32',
      });
      console.log('[1/2] Whisper ready!');

      console.log('[2/2] Loading Opus-MT Hindi translator...');
      translator = await pipeline('translation', 'Xenova/opus-mt-en-hi', {
        dtype: 'fp32',
      });
      console.log('[2/2] Opus-MT ready!');
      console.log('Models loaded!');
    })();
  }

  try {
    await modelInitPromise;
    if (!modelReadyNotified && activeSession) {
      sendToBackground('MODEL_LOADED', 'Models are ready!', activeSession.tabId);
      modelReadyNotified = true;
    }
  } catch (err) {
    console.error('Model loading failed:', err);
    if (activeSession) {
      sendToBackground('ERROR', 'Model failed: ' + err.message, activeSession.tabId);
    }
    throw err;
  } finally {
    if (!transcriber || !translator) {
      modelInitPromise = null;
    }
  }
}

async function stopActiveSession(reason = '') {
  if (!activeSession) return;

  const session = activeSession;
  activeSession = null;
  session.stopped = true;

  try {
    if (session.workletNode && session.workletNode.port) {
      session.workletNode.port.onmessage = null;
    }
  } catch (err) {
    console.warn('Failed to remove worklet listener:', err);
  }

  try {
    session.source && session.source.disconnect();
  } catch (err) {
    console.warn('Failed to disconnect source:', err);
  }

  try {
    session.workletNode && session.workletNode.disconnect();
  } catch (err) {
    console.warn('Failed to disconnect worklet node:', err);
  }

  try {
    session.silenceGain && session.silenceGain.disconnect();
  } catch (err) {
    console.warn('Failed to disconnect gain node:', err);
  }

  try {
    if (session.stream) {
      session.stream.getTracks().forEach((track) => track.stop());
    }
  } catch (err) {
    console.warn('Failed to stop stream tracks:', err);
  }

  try {
    if (session.audioContext && session.audioContext.state !== 'closed') {
      await session.audioContext.close();
    }
  } catch (err) {
    console.warn('Failed to close audio context:', err);
  }

  console.log(`[Session] Stopped${reason ? ': ' + reason : ''}`);
}

chrome.runtime.onMessage.addListener(async (message) => {
  if (message.target !== 'offscreen') return;

  if (message.type === 'START_TRANSLATION') {
    const { streamId, tabId } = message.data || {};

    if (!streamId || typeof tabId !== 'number') {
      return;
    }

    await startProcessing(streamId, tabId);
  }
});

async function startProcessing(streamId, tabId) {
  await stopActiveSession('Restarting translation session.');

  const session = {
    tabId,
    stopped: false,
    stream: null,
    audioContext: null,
    source: null,
    workletNode: null,
    silenceGain: null,
    audioChunks: [],
    isProcessing: false,
    chunkCount: 0,
  };
  activeSession = session;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });

    if (activeSession !== session) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    session.stream = stream;
    stream.getTracks().forEach((track) => {
      track.addEventListener('ended', () => {
        if (activeSession === session) {
          stopActiveSession('Audio stream ended.');
        }
      });
    });

    const audioContext = new AudioContext({ sampleRate: 16000 });
    session.audioContext = audioContext;

    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }

    await audioContext.audioWorklet.addModule('audio-worklet.js');

    if (activeSession !== session) {
      return;
    }

    const source = audioContext.createMediaStreamSource(stream);
    const workletNode = new AudioWorkletNode(audioContext, 'audio-processor');
    
    // Connect worklet to a silent output to keep it continuously processing
    const silenceGain = audioContext.createGain();
    silenceGain.gain.value = 0;
    workletNode.connect(silenceGain);
    silenceGain.connect(audioContext.destination);

    // Route the original tab audio back to the user so they can still hear the meeting!
    source.connect(workletNode);
    source.connect(audioContext.destination);

    session.source = source;
    session.workletNode = workletNode;
    session.silenceGain = silenceGain;

    await initModel();

    if (activeSession !== session) {
      return;
    }

    workletNode.port.onmessage = (e) => {
      if (activeSession !== session || session.stopped || !(e.data instanceof Float32Array)) {
        return;
      }

      session.audioChunks.push(e.data);
      session.chunkCount += 1;
      console.log(`[Audio] Received chunk #${session.chunkCount}, buffer: ${session.audioChunks.length}/4`);

      if (session.audioChunks.length >= 4) {
        if (session.isProcessing) {
          // Prevent memory overload by capping buffer
          if (session.audioChunks.length > 6) {
            session.audioChunks.shift();
          }
          console.log('[Audio] Skipping - model still processing previous chunk');
          return;
        }

        const fullAudio = mergeChunks(session.audioChunks);
        
        // Retain the last chunk to provide ~1 second of overlap for the next transcription window.
        // This prevents words spoken exactly at the 4-second boundary from being cut in half.
        session.audioChunks = [session.audioChunks[session.audioChunks.length - 1]];
        
        console.log(`[Audio] Sending ${fullAudio.length} samples (~${(fullAudio.length/16000).toFixed(1)}s) to model...`);
        session.isProcessing = true;
        processAudio(fullAudio, session).finally(() => {
          if (activeSession === session) {
            session.isProcessing = false;
            console.log('[Audio] Model is free, ready for next chunk.');
          }
        });
      }
    };
  } catch (err) {
    console.error('Audio setup failed:', err);
    if (activeSession === session) {
      await stopActiveSession('Failed to start processing.');
    }
    sendToBackground('ERROR', 'Audio Error: ' + err.message, tabId);
  }
}

async function processAudio(audioData, session) {
  if (activeSession !== session || session.stopped || !transcriber || !translator) return;

  try {
    // 1. Transcribe audio to English text
    console.log('[Model] Running Whisper transcription...');
    const transcription = await transcriber(audioData);

    if (activeSession !== session || session.stopped) return;

    const englishText = (transcription && transcription.text ? transcription.text : '').trim();
    console.log('[Model] Whisper output:', JSON.stringify(englishText));
    
    if (!englishText) {
      sendToBackground('TRANSLATION_RESULT', 'Listening...', session.tabId);
      return;
    }

    // 2. Translate English text to Hindi text
    console.log('[Model] Running Opus-MT translation on:', englishText);
    const output = await translator(englishText);

    if (activeSession !== session || session.stopped) return;

    const hindiText = output && output[0] ? output[0].translation_text : '';
    console.log('[Model] Hindi output:', hindiText);

    if (hindiText && hindiText.trim()) {
      sendToBackground('TRANSLATION_RESULT', hindiText, session.tabId);
    } else {
      sendToBackground('TRANSLATION_RESULT', 'Listening...', session.tabId);
    }
  } catch (err) {
    console.error('[Model] Translation error:', err);
    sendToBackground('ERROR', 'Processing Error: ' + err.message, session.tabId);
  }
}

function mergeChunks(chunks) {
  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const result = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
