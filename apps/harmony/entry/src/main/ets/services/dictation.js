import audio from '@ohos.multimedia.audio';
import access from '@ohos.abilityAccessCtrl';
import util from '@ohos.util';
import speechRecognizer from '@hms.ai.speechRecognizer';

// Recording and recognition run on the device. No audio file is created.
export function dictation(ctx, update, complete) {
  const id = util.generateRandomUUID(true);
  let engine, mic, ended = false, finishing = false, partial = '', finalText = '';
  let remainder = new Uint8Array(0), timer;
  async function releaseMic() {
    const captured = mic;
    mic = null;
    if (captured) {
      try { captured.off('readData'); } catch {}
      try { await captured.stop(); } catch {}
      try { await captured.release(); } catch {}
    }
  }
  function end(text, error) {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    releaseMic();
    if (engine) {
      try { engine.cancel(id); } catch {}
      try { engine.shutdown(); } catch {}
    }
    complete(text, error);
  }
  function finish() {
    if (ended || finishing) return;
    if (!engine || !mic) { end('',''); return; }
    finishing = true;
    clearTimeout(timer);
    releaseMic();
    update('正在转写');
    try {
      engine.finish(id);
      if (!ended) timer = setTimeout(() => end('', '语音识别超时，请重试'), 8000);
    } catch { end('', '无法完成语音识别'); }
  }
  async function start() {
    const result = await access.createAtManager().requestPermissionsFromUser(ctx, ['ohos.permission.MICROPHONE']);
    if (ended) return;
    if (result.authResults[0] !== 0) throw new Error('请在系统设置中允许 Cindy 使用麦克风');
    timer = setTimeout(() => end('', '设备未能启动离线语音识别'), 15000);
    const created = await speechRecognizer.createEngine({ language: 'zh-CN', online: 1 });
    if (ended) { created.shutdown(); return; }
    engine = created;
    engine.setListener({
      onStart: () => { if (!ended && !finishing) beginCapture().catch(() => end('', '麦克风无法录音')); },
      onEvent() {},
      onResult: (sid, result) => {
        if (sid !== id || ended) return;
        partial = result.result || '';
        if (result.isFinal) { finalText += partial; partial = ''; }
      },
      onComplete: sid => { if (sid === id) end(finalText + partial, finalText || partial ? '' : '没有识别到语音'); },
      onError: (sid, code) => { if (sid === id) end('', '语音识别不可用（' + code + '）'); }
    });
    engine.startListening({ sessionId: id, audioInfo: { audioType: 'pcm', sampleRate: 16000, soundChannel: 1, sampleBit: 16 } });
  }
  async function beginCapture() {
    const source = await audio.createAudioCapturer({ streamInfo: { samplingRate: 16000, channels: 1,
      sampleFormat: audio.AudioSampleFormat.SAMPLE_FORMAT_S16LE, encodingType: audio.AudioEncodingType.ENCODING_TYPE_RAW },
      capturerInfo: { source: audio.SourceType.SOURCE_TYPE_VOICE_RECOGNITION, capturerFlags: 0 } });
    if (ended || finishing) { await source.release(); return; }
    mic = source;
    source.on('audioInterrupt', event => { if (event.eventType === audio.InterruptType.INTERRUPT_TYPE_BEGIN) end('', '录音已中断'); });
    source.on('readData', buffer => {
      if (ended || finishing) return;
      const bytes = new Uint8Array(remainder.length + buffer.byteLength);
      bytes.set(remainder); bytes.set(new Uint8Array(buffer), remainder.length);
      let i = 0;
      try { for (; i + 640 <= bytes.length; i += 640) engine.writeAudio(id, bytes.slice(i,i+640)); }
      catch { end('', '录音已中断'); return; }
      remainder = bytes.slice(i);
    });
    await source.start();
    if (ended || finishing) return;
    update('录音中'); clearTimeout(timer); timer = setTimeout(finish, 58000);
  }
  start().catch(error => end('', typeof error?.code === 'number' ? '设备离线语音不可用（' + error.code + '）' : error.message || '设备离线语音不可用'));
  return { cancel: () => end('',''), finish };
}
