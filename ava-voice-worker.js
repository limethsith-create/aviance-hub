/* ============================================================================
   ava-voice-worker.js — Ava's natural voice (Kokoro TTS), run off the page.
   ----------------------------------------------------------------------------
   A Web Worker started by ava.js (new Worker('ava-voice-worker.js', {type:'module'})) so the page never
   freezes while the model loads or speaks. Everything runs in this browser: the only network use is the
   one-time download of the library and the open model; nothing Ava says is sent anywhere.

     Library  kokoro-js 1.2.1 (Apache-2.0), its browser bundle from jsDelivr (it brings Transformers.js 3.5.1,
              which fetches the ONNX runtime .wasm from jsDelivr too).
     Model    onnx-community/Kokoro-82M-v1.0-ONNX on Hugging Face — WebGPU: fp32 (≈ 330 MB, fast);
              otherwise WASM: q8 (≈ 92 MB). Both are kept by the browser's cache after the first time.
     Voices   af_heart (default), af_bella, af_nicole, bf_emma — ≈ 0.5 MB each, fetched on first use.

   Messages in:  {type:'load', device:'webgpu'|'wasm', url?}
                 {type:'speak', gen, i, text, voice, speed}   — one sentence; answered in the order asked
                 {type:'cancel', gen}                          — drop every queued sentence of gen or older
   Messages out: {type:'device', device} · {type:'progress', loaded, total, file} · {type:'ready', device, dtype, rtf}
                 {type:'audio', gen, i, samples(Float32Array, transferred), rate, ms}
                 {type:'error', gen?, i?, message, fatal?}
   Uses only dynamic import(), so it also loads as a classic worker and passes `node --check`.
   ========================================================================== */
const AVW_LIB = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js';
const AVW_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const avw = { tts: null, loading: null, device: null, dtype: null, queue: [], busy: false, dropUpTo: 0 };
// tests hand in their own importer (a mocked kokoro-js); the browser imports the real bundle
const avwImport = (url) => (self.avaVoiceImport ? self.avaVoiceImport(url) : import(url));
const avwPost = (m, transfer) => { try { self.postMessage(m, transfer || []); } catch (e) { /* the page went away */ } };

async function avwLoad(want, url) {
  if (avw.tts) return avw.tts;
  if (avw.loading) return avw.loading;
  avw.loading = (async () => {
    const mod = await avwImport(url || AVW_LIB);
    const files = {};
    const progress = (p) => {
      if (!p || !p.file || p.total == null) return;
      files[p.file] = { loaded: Number(p.loaded) || 0, total: Number(p.total) || 0 };
      let loaded = 0, total = 0; for (const k in files) { loaded += files[k].loaded; total += files[k].total; }
      avwPost({ type: 'progress', loaded, total, file: String(p.file) });
    };
    const tryLoad = (device, dtype) => mod.KokoroTTS.from_pretrained(AVW_MODEL, { dtype, device, progress_callback: progress });
    let tts = null;
    // a GPU the browser can actually use, or the CPU model (asking first saves a 330 MB download that can't run)
    if (want === 'webgpu') {
      let adapter = null;
      try { adapter = self.navigator && self.navigator.gpu ? await self.navigator.gpu.requestAdapter() : null; } catch (e) { adapter = null; }
      if (!adapter) want = 'wasm';
    }
    avwPost({ type: 'device', device: want });
    if (want === 'webgpu') {
      try { tts = await tryLoad('webgpu', 'fp32'); avw.device = 'webgpu'; avw.dtype = 'fp32'; }
      catch (e) { tts = null; }   // no usable GPU after all: the smaller CPU model below
    }
    if (!tts) { tts = await tryLoad('wasm', 'q8'); avw.device = 'wasm'; avw.dtype = 'q8'; }
    // a first short sentence warms it up (shaders, the voice file); a second one tells the page how fast this device
    // is (seconds to make one second of speech — above about 1.2 she would pause between sentences)
    await tts.generate('Hi.', { voice: 'af_heart', speed: 1 });
    const t0 = Date.now();
    const a = await tts.generate('Hi, I am Ava.', { voice: 'af_heart', speed: 1 });
    const secs = a && a.audio && a.sampling_rate ? a.audio.length / a.sampling_rate : 0;
    const rtf = secs > 0 ? (Date.now() - t0) / 1000 / secs : null;
    avw.tts = tts;
    avwPost({ type: 'ready', device: avw.device, dtype: avw.dtype, rtf });
    return tts;
  })();
  try { return await avw.loading; }
  catch (e) { avw.loading = null; avwPost({ type: 'error', fatal: true, message: String((e && e.message) || e || 'load failed') }); return null; }
}

async function avwPump() {
  if (avw.busy) return;
  avw.busy = true;
  try {
    while (avw.queue.length) {
      const job = avw.queue.shift();
      if (job.gen <= avw.dropUpTo) continue;
      const tts = avw.tts || (await avwLoad(avw.device || 'wasm'));
      if (!tts) { avwPost({ type: 'error', gen: job.gen, i: job.i, message: 'not loaded' }); continue; }
      if (job.gen <= avw.dropUpTo) continue;   // stopped while it was loading
      const t0 = Date.now();
      try {
        const a = await tts.generate(job.text, { voice: job.voice || 'af_heart', speed: job.speed || 1 });
        if (job.gen <= avw.dropUpTo) continue;   // stopped while it was speaking-to-be: throw it away
        const samples = a.audio instanceof Float32Array ? a.audio : new Float32Array(a.audio || []);
        avwPost({ type: 'audio', gen: job.gen, i: job.i, samples, rate: a.sampling_rate || 24000, ms: Date.now() - t0 }, [samples.buffer]);
      } catch (e) {
        avwPost({ type: 'error', gen: job.gen, i: job.i, message: String((e && e.message) || e || 'speak failed') });
      }
    }
  } finally { avw.busy = false; }
}

self.onmessage = (e) => {
  const m = (e && e.data) || {};
  if (m.type === 'load') { avwLoad(m.device === 'webgpu' ? 'webgpu' : 'wasm', m.url); return; }
  if (m.type === 'speak') { avw.queue.push(m); avwPump(); return; }
  if (m.type === 'cancel') { avw.dropUpTo = Math.max(avw.dropUpTo, Number(m.gen) || 0); avw.queue = avw.queue.filter((j) => j.gen > avw.dropUpTo); }
};
