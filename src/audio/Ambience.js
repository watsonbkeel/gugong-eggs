/**
 * 环境音效：全部用 Web Audio API 程序化合成（无外部音频文件、无版权问题）。
 *
 * - start()：在用户手势后调用（点击锁定鼠标 / 首次触摸），可重复调用
 * - update({ dt, speed, footstep, inTunnel, sprint })：每帧调用；footstep 为 true 表示本帧落脚
 * - setMuted(bool) / isMuted()
 * - dispose()
 *
 * 信号流：
 *   风声 ─┐
 *   鸟鸣 ─┼─ envBus ──┬─────────────── dry ─┐
 *   风铃 ─┘           └─ sendEnv ─┐         ├─ master ─ destination
 *   脚步 ─── stepBus ─┬───────────│── dry ──┘
 *                     └─ sendStep ┴─ convolver（门洞混响）─ wet ─ master
 */

const MASTER_GAIN = 0.6;
const NOISE_SECONDS = 4;

const rand = (min, max) => min + Math.random() * (max - min);

export class Ambience {
  constructor() {
    this.muted = false;
    this.started = false;
    this.ctx = null;
    this.timers = new Set();
    this.tunnelMix = 0;
    this.tunnelTarget = 0;
    this.stepIndex = 0;
    this._onVisibility = this.onVisibilityChange.bind(this);
  }

  start() {
    if (this.disposed) return;
    const AudioCtx = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AudioCtx) return;
    if (!this.ctx) {
      try {
        this.ctx = new AudioCtx();
      } catch (err) {
        console.warn('无法创建 AudioContext', err);
        return;
      }
      this.buildGraph();
      document.addEventListener('visibilitychange', this._onVisibility);
      this.started = true;
      this.scheduleBird(rand(2, 5));
      this.scheduleChime(rand(8, 20));
    }
    if (this.ctx.state === 'suspended' && !document.hidden) {
      this.ctx.resume().catch(() => {});
    }
  }

  // ---------------------------------------------------------------- 搭建节点图

  buildGraph() {
    const ctx = this.ctx;
    const now = ctx.currentTime;

    this.master = ctx.createGain();
    this.master.gain.setValueAtTime(0, now);
    this.master.gain.linearRampToValueAtTime(this.muted ? 0 : MASTER_GAIN, now + 1.5);
    this.master.connect(ctx.destination);

    // 门洞混响：程序生成约 1.2 秒的衰减噪声冲激响应
    this.convolver = ctx.createConvolver();
    this.convolver.buffer = this.createImpulse(1.2, 3);
    this.reverbWet = ctx.createGain();
    this.reverbWet.gain.value = 1;
    this.convolver.connect(this.reverbWet).connect(this.master);

    this.envBus = ctx.createGain();
    this.envBus.connect(this.master);
    this.envSend = ctx.createGain();
    this.envSend.gain.value = 0;
    this.envBus.connect(this.envSend).connect(this.convolver);

    this.stepBus = ctx.createGain();
    this.stepBus.connect(this.master);
    this.stepSend = ctx.createGain();
    this.stepSend.gain.value = 0;
    this.stepBus.connect(this.stepSend).connect(this.convolver);

    this.noiseBuffer = this.createNoiseBuffer('white', 1);
    this.buildWind();
  }

  createNoiseBuffer(color, seconds) {
    const ctx = this.ctx;
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      if (color === 'white') {
        for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
        continue;
      }
      // 粉红噪声（Paul Kellet 近似）与布朗噪声混合，低频更厚、听感像风
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, brown = 0;
      for (let i = 0; i < length; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.96900 * b2 + w * 0.1538520;
        b3 = 0.86650 * b3 + w * 0.3104856;
        b4 = 0.55000 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.0168980;
        const pink = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
        brown = (brown + 0.02 * w) / 1.02;
        data[i] = pink * 0.6 + brown * 3.5 * 0.4;
      }
      // 首尾交叉淡化，循环播放无爆音
      const fade = Math.floor(ctx.sampleRate * 0.05);
      for (let i = 0; i < fade; i++) {
        const t = i / fade;
        data[i] = data[i] * t + data[length - fade + i] * (1 - t);
      }
    }
    return buffer;
  }

  createImpulse(seconds, decay) {
    const ctx = this.ctx;
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      }
    }
    return buffer;
  }

  buildWind() {
    const ctx = this.ctx;
    const source = ctx.createBufferSource();
    source.buffer = this.createNoiseBuffer('wind', NOISE_SECONDS);
    source.loop = true;

    const bandpass = ctx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.value = 500;
    bandpass.Q.value = 0.6;

    // 门洞内风声变闷：平滑降低此低通截止频率
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 2200;

    const gain = ctx.createGain();
    gain.gain.value = 0.35;

    const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;

    // LFO：缓慢调制滤波频率（阵风音色）与音量（阵风强弱），两路不同频率避免机械感
    const lfoFreq = ctx.createOscillator();
    lfoFreq.frequency.value = 0.07;
    const lfoFreqDepth = ctx.createGain();
    lfoFreqDepth.gain.value = 280;
    lfoFreq.connect(lfoFreqDepth).connect(bandpass.frequency);

    const lfoGain = ctx.createOscillator();
    lfoGain.frequency.value = 0.11;
    const lfoGainDepth = ctx.createGain();
    lfoGainDepth.gain.value = 0.15;
    lfoGain.connect(lfoGainDepth).connect(gain.gain);

    const lfoPan = ctx.createOscillator();
    lfoPan.frequency.value = 0.045;
    const lfoPanDepth = ctx.createGain();
    lfoPanDepth.gain.value = 0.35;

    source.connect(bandpass).connect(lowpass).connect(gain);
    if (panner) {
      lfoPan.connect(lfoPanDepth).connect(panner.pan);
      gain.connect(panner).connect(this.envBus);
    } else {
      gain.connect(this.envBus);
    }

    const t = ctx.currentTime;
    source.start(t);
    lfoFreq.start(t);
    lfoGain.start(t);
    lfoPan.start(t);

    this.wind = {
      lowpass,
      nodes: [source, bandpass, lowpass, gain, panner, lfoFreq, lfoFreqDepth, lfoGain, lfoGainDepth, lfoPan, lfoPanDepth].filter(Boolean),
      sources: [source, lfoFreq, lfoGain, lfoPan],
    };
  }

  // ---------------------------------------------------------------- 定时调度

  setTimer(fn, seconds) {
    const id = setTimeout(() => {
      this.timers.delete(id);
      if (!this.ctx || this.ctx.state === 'closed') return;
      fn();
    }, seconds * 1000);
    this.timers.add(id);
  }

  scheduleBird(delay) {
    this.setTimer(() => {
      if (this.ctx.state === 'running' && !this.muted) this.playBird();
      this.scheduleBird(rand(4, 12));
    }, delay);
  }

  scheduleChime(delay) {
    this.setTimer(() => {
      if (this.ctx.state === 'running' && !this.muted) this.playChime();
      this.scheduleChime(rand(15, 40));
    }, delay);
  }

  /** 短生命周期节点：结束时统一断开 */
  autoDisconnect(source, nodes) {
    source.onended = () => {
      for (const node of nodes) {
        try { node.disconnect(); } catch { /* 已断开 */ }
      }
    };
  }

  createPanner(pan) {
    const ctx = this.ctx;
    if (ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = pan;
      return panner;
    }
    return ctx.createGain();
  }

  // ---------------------------------------------------------------- 鸟鸣

  playBird() {
    const ctx = this.ctx;
    const magpie = Math.random() < 0.4;
    const panner = this.createPanner(rand(-0.85, 0.85));
    const out = ctx.createGain();
    out.gain.value = magpie ? 0.05 : 0.04;
    out.connect(panner).connect(this.envBus);

    const syllables = Math.floor(rand(2, 6));
    let t = ctx.currentTime + 0.05;
    let lastSource = null;
    const nodes = [out, panner];

    for (let i = 0; i < syllables; i++) {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      // 颤音：快速调制频率
      const vibrato = ctx.createOscillator();
      const vibratoDepth = ctx.createGain();
      let duration;

      if (magpie) {
        // 喜鹊：较低、沙哑的"喳喳"，锯齿波 + 带通更粗糙
        osc.type = 'sawtooth';
        duration = rand(0.08, 0.13);
        const f = rand(2000, 2600);
        osc.frequency.setValueAtTime(f, t);
        osc.frequency.linearRampToValueAtTime(f * 0.82, t + duration);
        vibrato.frequency.value = rand(60, 90);
        vibratoDepth.gain.value = 180;
      } else {
        // 麻雀：清亮的高音"啾"，快速上滑或下滑
        osc.type = 'sine';
        duration = rand(0.05, 0.11);
        const f0 = rand(3000, 5000);
        const f1 = Math.random() < 0.5 ? f0 * rand(0.55, 0.75) : Math.min(f0 * rand(1.1, 1.3), 5000);
        osc.frequency.setValueAtTime(f0, t);
        osc.frequency.exponentialRampToValueAtTime(f1, t + duration);
        vibrato.frequency.value = rand(25, 45);
        vibratoDepth.gain.value = rand(60, 140);
      }

      vibrato.connect(vibratoDepth).connect(osc.frequency);
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(1, t + 0.008);
      env.gain.exponentialRampToValueAtTime(0.0001, t + duration);

      let tail = env;
      if (magpie) {
        const band = ctx.createBiquadFilter();
        band.type = 'bandpass';
        band.frequency.value = 2400;
        band.Q.value = 3;
        env.connect(band);
        tail = band;
        nodes.push(band);
      }
      osc.connect(env);
      tail.connect(out);

      osc.start(t);
      vibrato.start(t);
      osc.stop(t + duration + 0.02);
      vibrato.stop(t + duration + 0.02);
      nodes.push(osc, env, vibrato, vibratoDepth);
      lastSource = osc;
      t += duration + (magpie ? rand(0.06, 0.12) : rand(0.04, 0.14));
    }
    if (lastSource) this.autoDisconnect(lastSource, nodes);
  }

  // ---------------------------------------------------------------- 檐角风铃

  playChime() {
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.02;
    const base = rand(1100, 1500);
    // 金属铃的非谐波泛音比
    const ratios = [1, 2.32, 4.25, 6.63, 9.38];
    const panner = this.createPanner(rand(-0.6, 0.6));
    const out = ctx.createGain();
    out.gain.value = 0.025;
    out.connect(panner).connect(this.envBus);
    const nodes = [out, panner];
    let longest = null;
    let longestDecay = 0;

    ratios.forEach((ratio, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = base * ratio * rand(0.995, 1.005);
      const env = ctx.createGain();
      const decay = 2.6 / (1 + i * 0.7);
      const level = 1 / (1 + i * 0.9);
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(level, t + 0.004);
      env.gain.exponentialRampToValueAtTime(0.0001, t + decay);
      osc.connect(env).connect(out);
      osc.start(t);
      osc.stop(t + decay + 0.05);
      nodes.push(osc, env);
      if (decay > longestDecay) { longestDecay = decay; longest = osc; }
    });
    this.autoDisconnect(longest, nodes);
  }

  // ---------------------------------------------------------------- 脚步声

  playFootstep(sprint) {
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.005;
    const pitch = rand(0.92, 1.08);
    const left = this.stepIndex++ % 2 === 0;
    const loud = sprint ? 1.5 : 1;

    const panner = this.createPanner(left ? -0.12 : 0.12);
    const out = ctx.createGain();
    out.gain.value = 0.22 * loud;
    out.connect(panner).connect(this.stepBus);

    // 鞋底擦过石板：短噪声爆发经带通
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    noise.playbackRate.value = pitch;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 1400 * pitch;
    band.Q.value = 1.1;
    const noiseEnv = ctx.createGain();
    noiseEnv.gain.setValueAtTime(0.0001, t);
    noiseEnv.gain.exponentialRampToValueAtTime(0.7, t + 0.004);
    noiseEnv.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    noise.connect(band).connect(noiseEnv).connect(out);
    const offset = Math.random() * Math.max(0, this.noiseBuffer.duration - 0.2);
    noise.start(t, offset, 0.15);

    // 脚跟落地：低频 thump
    const thump = ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(120 * pitch, t);
    thump.frequency.exponentialRampToValueAtTime(55 * pitch, t + 0.08);
    const thumpEnv = ctx.createGain();
    thumpEnv.gain.setValueAtTime(0.0001, t);
    thumpEnv.gain.exponentialRampToValueAtTime(0.9, t + 0.006);
    thumpEnv.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    thump.connect(thumpEnv).connect(out);
    thump.start(t);
    thump.stop(t + 0.15);

    this.autoDisconnect(thump, [noise, band, noiseEnv, thump, thumpEnv, out, panner]);
  }

  // ---------------------------------------------------------------- 每帧更新

  update({ dt = 0, speed = 0, footstep = false, inTunnel = false, sprint = false } = {}) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;

    // 门洞混响：进出门洞时各排一次平滑过渡（时间常数 0.35 秒），不在每帧写参数
    const target = inTunnel ? 1 : 0;
    if (this.tunnelTarget !== target) {
      this.tunnelTarget = target;
      const now = ctx.currentTime;
      for (const [param, value] of [
        [this.stepSend.gain, target * 0.9],
        [this.envSend.gain, target * 0.5],
        [this.wind.lowpass.frequency, 2200 - target * 1650],
      ]) {
        param.cancelScheduledValues(now);
        param.setValueAtTime(param.value, now);
        param.setTargetAtTime(value, now, 0.35);
      }
    }
    // 记录平滑后的混响比例（与音频参数同一时间常数），便于调试
    this.tunnelMix += (target - this.tunnelMix) * (1 - Math.exp(-dt / 0.35));
    if (Math.abs(target - this.tunnelMix) < 0.002) this.tunnelMix = target;

    if (footstep && !this.muted && speed > 0.3) this.playFootstep(sprint);
  }

  setMuted(muted) {
    this.muted = !!muted;
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'closed') return;
    const now = ctx.currentTime;
    const gain = this.master.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(this.muted ? 0 : MASTER_GAIN, now + 0.4);
    if (!this.muted && ctx.state === 'suspended' && !document.hidden) {
      ctx.resume().catch(() => {});
    }
  }

  isMuted() {
    return this.muted;
  }

  onVisibilityChange() {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'closed') return;
    if (document.hidden) {
      ctx.suspend().catch(() => {});
    } else if (!this.muted) {
      ctx.resume().catch(() => {});
    }
  }

  dispose() {
    this.disposed = true;
    this.started = false;
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
    document.removeEventListener('visibilitychange', this._onVisibility);
    if (this.wind) {
      for (const source of this.wind.sources) {
        try { source.stop(); } catch { /* 已停止 */ }
      }
      for (const node of this.wind.nodes) node.disconnect();
      this.wind = null;
    }
    for (const node of [this.envBus, this.envSend, this.stepBus, this.stepSend, this.convolver, this.reverbWet, this.master]) {
      node?.disconnect();
    }
    if (this.ctx && this.ctx.state !== 'closed') this.ctx.close().catch(() => {});
    this.noiseBuffer = null;
  }
}
