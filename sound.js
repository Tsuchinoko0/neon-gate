/* NEON GATE sound.js
 * Web Audio API だけで鳴らすBGMと効果音（音声ファイル不要・外部ライブラリなし）
 *
 * 使い方：
 *   NGSound.init()            … 最初のクリック／タップの中で1回呼ぶ（ブラウザの決まりで、操作の前は音を鳴らせない）
 *   NGSound.start()           … BGMを鳴らす（雨音つき）
 *   NGSound.stop()            … BGMを止める（フェードアウト）
 *   NGSound.setBrightness(b)  … 0（圏外）〜1（ゲート前）。明るいほどBGMの音が開き、楽器が増える
 *   NGSound.se('credit')      … 効果音を鳴らす。名前は NGSound.SE_NAMES を参照
 *   NGSound.setVolume('bgm' | 'se', 0〜1)
 *   NGSound.setMuted(true / false)
 *   NGSound.setCyber(c)       … 0（生身）〜1（完全サイボーグ）。効果音が機械的な音に変わっていく
 *   NGSound.setLayer('pad', true / false)  … シンセの持続音のオン・オフ
 *   NGSound.setMood('out' | 'lower' | 'corp' | 'sky' | 'top')  … BGMの雰囲気。'lower'＝沈殿街（工場の機械音とハンマーのリズム）、'corp'＝企業区（静かで澄んだ電子音）、'sky'＝天穹区（張りつめた戦いの曲）、'top'＝中央区（白く冷たい和音）
 *   NGSound.analyser()        … 波形表示用の AnalyserNode（init 前は null）
 */
(function (global) {
  'use strict';

  const BPM = 84, SPB = 60 / BPM, S16 = SPB / 4, LOOP = 128;
  /* Dm → B♭ → Gm → A（2小節ずつ、8小節で1周） */
  const PROG = [
    { root: 50, tones: [50, 53, 57, 60] },
    { root: 46, tones: [46, 50, 53, 57] },
    { root: 43, tones: [43, 46, 50, 53] },
    { root: 45, tones: [45, 49, 52, 55] }
  ];
  /* 沈殿街：Em → C → D → B（工場の重いリズムに合わせた、男くさい進行） */
  const PROG_LOWER = [
    { root: 40, tones: [40, 43, 47, 50] },
    { root: 36, tones: [36, 40, 43, 47] },
    { root: 38, tones: [38, 42, 45, 48] },
    { root: 35, tones: [35, 39, 42, 45] }
  ];
  /* 企業区：Cmaj7 → Am7 → Fmaj7 → G6（明るいが、温度のない進行） */
  const PROG_CORP = [
    { root: 48, tones: [60, 64, 67, 71] },
    { root: 45, tones: [57, 60, 64, 67] },
    { root: 41, tones: [57, 60, 64, 65] },
    { root: 43, tones: [59, 62, 64, 67] }
  ];
  /* 天穹区：張りつめた短調。中央区：明るすぎて冷たい長調 */
  const PROG_SKY = [
    { root: 45, tones: [57, 60, 64, 69] },
    { root: 41, tones: [57, 60, 65, 69] },
    { root: 43, tones: [55, 59, 62, 67] },
    { root: 40, tones: [56, 59, 64, 68] }
  ];
  const PROG_TOP = [
    { root: 48, tones: [60, 64, 67, 72] },
    { root: 53, tones: [60, 65, 69, 72] }
  ];
  const ARP = [0, 2, 1, 3, 2, 1, 3, 0];
  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
  const clamp01 = v => Math.max(0, Math.min(1, v));

  const st = { bgmVol: 0.6, seVol: 0.8, muted: false, bright: 0, playing: false, pad: true, cyber: 0, mood: 'out' };
  const SE_BOOST = 4; /* 効果音をBGMより前に出すための底上げ */
  let ctx = null, master, bgmIn, bgmMix, duck, seIn, seDry, seWet, crusher, ringOsc, padFilter, padLfoAmt, delayIn, reverbIn, an;
  let noiseBuf = null, timer = null, nextTime = 0, step = 0;

  function makeNoise(sec) {
    const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * sec), ctx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }
  function makeImpulse(sec, decay) {
    const len = Math.floor(ctx.sampleRate * sec), b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return b;
  }
  const g = (v, dest) => { const n = ctx.createGain(); n.gain.value = v; if (dest) n.connect(dest); return n; };
  function filt(type, freq, q, dest) {
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; if (q != null) f.Q.value = q;
    if (dest) f.connect(dest); return f;
  }

  function init(existing) {
    if (ctx) { if (ctx.state === 'suspended' && ctx.resume) ctx.resume(); return true; }
    const AC = global.AudioContext || global.webkitAudioContext;
    if (!existing && !AC) return false;
    ctx = existing || new AC();

    /* 出力：BGM（コンプレッサー）と効果音（リミッター）を別々に整えてから合流させる */
    const out = g(st.muted ? 0 : 0.9);
    an = ctx.createAnalyser(); an.fftSize = 1024;
    out.connect(an); an.connect(ctx.destination);
    master = out;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.knee.value = 12; comp.ratio.value = 4; comp.attack.value = 0.005; comp.release.value = 0.2;
    comp.connect(out);
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -4; lim.knee.value = 2; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.1;
    lim.connect(out);

    /* 空間：ディレイ（付点8分）とリバーブ。BGMと効果音で共有し、出力は master へ */
    delayIn = g(1);
    const dl = ctx.createDelay(2); dl.delayTime.value = SPB * 0.75;
    const fb = g(0.38), dlp = filt('lowpass', 2400, 0.5);
    delayIn.connect(dl); dl.connect(dlp); dlp.connect(fb); fb.connect(dl); dlp.connect(g(0.55, comp));
    reverbIn = g(1);
    const rv = ctx.createConvolver(); rv.buffer = makeImpulse(3.2, 2.4);
    reverbIn.connect(rv); rv.connect(g(0.42, comp));

    /* BGM：bgmMix（再生・停止のフェード）→ bgmIn（音量）→ 原音／ディレイ／リバーブ */
    /* duck：効果音が鳴った瞬間だけBGMを下げる */
    duck = g(1, comp);
    bgmIn = g(st.bgmVol); bgmIn.connect(duck); bgmIn.connect(g(0.5, reverbIn));
    bgmMix = g(0, bgmIn);
    /* 効果音 */
    seIn = g(st.seVol * SE_BOOST); seIn.connect(g(0.18, reverbIn));
    /* サイボーグ化：原音（dry）と、ビットを粗くしてリング変調した機械音（wet）を混ぜる */
    seDry = g(1, lim);
    seIn.connect(seDry);
    crusher = ctx.createWaveShaper();
    const ring = g(0);
    ringOsc = ctx.createOscillator(); ringOsc.type = 'sine'; ringOsc.frequency.value = 70;
    ringOsc.connect(ring.gain); ringOsc.start();
    const wetHp = filt('highpass', 500, 0.7);
    seWet = g(0, lim);
    seIn.connect(crusher); crusher.connect(ring); ring.connect(wetHp); wetHp.connect(seWet);
    const crushOnly = g(0.6); crusher.connect(crushOnly); crushOnly.connect(wetHp);

    /* パッド用のフィルター（ゆっくり揺れる） */
    padFilter = filt('lowpass', 400, 2, bgmMix);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.06;
    padLfoAmt = g(180); lfo.connect(padLfoAmt); padLfoAmt.connect(padFilter.frequency); lfo.start();

    noiseBuf = makeNoise(2.5);
    applyBright(0);
    applyCyber();
    return true;
  }

  /* ===== BGMの各パート ===== */
  function pad(chord, t, dur) {
    const env = g(0, padFilter);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.05, t + 2.2);
    env.gain.setValueAtTime(0.05, t + dur - 0.4);
    env.gain.linearRampToValueAtTime(0, t + dur + 2.4);
    chord.tones.slice(0, 3).forEach((m, i) => {
      [-7, 7].forEach(det => {
        const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mtof(m - 12); o.detune.value = det + i * 2;
        o.connect(env); o.start(t); o.stop(t + dur + 2.6);
      });
    });
    /* 低い持続音（ドローン） */
    const d = ctx.createOscillator(); d.type = 'triangle'; d.frequency.value = mtof(chord.root - 24);
    const dg = g(0, bgmMix); d.connect(dg);
    dg.gain.setValueAtTime(0, t); dg.gain.linearRampToValueAtTime(0.06, t + 1.5);
    dg.gain.setValueAtTime(0.06, t + dur - 0.3); dg.gain.linearRampToValueAtTime(0, t + dur + 1.2);
    d.start(t); d.stop(t + dur + 1.3);
  }
  function bass(m, t, b) {
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mtof(m);
    const s = ctx.createOscillator(); s.type = 'sine'; s.frequency.value = mtof(m);
    const f = filt('lowpass', 900, 6), a = g(0, bgmMix);
    o.connect(f); s.connect(a); f.connect(a);
    f.frequency.setValueAtTime(220 + 900 * b, t); f.frequency.exponentialRampToValueAtTime(90, t + 0.25);
    a.gain.setValueAtTime(0, t); a.gain.linearRampToValueAtTime(0.11, t + 0.008); a.gain.exponentialRampToValueAtTime(0.001, t + 0.42);
    o.start(t); s.start(t); o.stop(t + 0.45); s.stop(t + 0.45);
  }
  function arp(m, t, lvl, b) {
    const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = mtof(m);
    const f = filt('lowpass', 900 + 3200 * b, 3), a = g(0);
    o.connect(f); f.connect(a); a.connect(bgmMix); a.connect(delayIn);
    a.gain.setValueAtTime(0, t); a.gain.linearRampToValueAtTime(lvl, t + 0.004); a.gain.exponentialRampToValueAtTime(0.0008, t + 0.16);
    o.start(t); o.stop(t + 0.18);
  }
  function hat(t, lvl, open) {
    const n = ctx.createBufferSource(); n.buffer = noiseBuf; n.playbackRate.value = 1.5;
    const f = filt('highpass', 7500, 0.7), a = g(0, bgmMix); n.connect(f); f.connect(a);
    const len = open ? 0.18 : 0.045;
    a.gain.setValueAtTime(lvl, t); a.gain.exponentialRampToValueAtTime(0.0008, t + len);
    n.start(t, Math.random() * 2); n.stop(t + len + 0.02);
  }
  function kick(t, lvl) {
    const o = ctx.createOscillator(); o.type = 'sine';
    const a = g(0, bgmMix); o.connect(a);
    o.frequency.setValueAtTime(130, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.22);
    a.gain.setValueAtTime(lvl, t); a.gain.exponentialRampToValueAtTime(0.001, t + 0.38);
    o.start(t); o.stop(t + 0.4);
  }
  function ping(t) {
    /* 遠くで鳴る合図のような音（ディレイで残響） */
    const m = [74, 77, 81, 69][Math.floor(Math.random() * 4)];
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = mtof(m);
    const a = g(0); a.connect(bgmMix); a.connect(delayIn);
    a.gain.setValueAtTime(0, t); a.gain.linearRampToValueAtTime(0.035, t + 0.01); a.gain.exponentialRampToValueAtTime(0.0008, t + 1.2);
    o.start(t); o.stop(t + 1.25);
  }
  /* 工場の音：ハンマーで鉄を打つ音 */
  function clank(t, lvl) {
    noise(t, 0.09, lvl, 'bandpass', 2600 + Math.random() * 500, 9);
    const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = 1830;
    const o2 = ctx.createOscillator(); o2.type = 'triangle'; o2.frequency.value = 2757;
    const a = g(0, bgmMix); o.connect(a); o2.connect(a); a.connect(g(0.4, delayIn));
    a.gain.setValueAtTime(lvl * 0.5, t); a.gain.exponentialRampToValueAtTime(0.0006, t + 0.35);
    o.start(t); o2.start(t); o.stop(t + 0.37); o2.stop(t + 0.37);
  }
  /* 工場の音：蒸気が抜ける音 */
  function hiss(t) {
    const n = ctx.createBufferSource(); n.buffer = noiseBuf;
    const f = filt('highpass', 2000, 0.7), a = g(0, bgmMix); n.connect(f); f.connect(a);
    f.frequency.setValueAtTime(5000, t); f.frequency.exponentialRampToValueAtTime(900, t + 1.2);
    a.gain.setValueAtTime(0, t); a.gain.linearRampToValueAtTime(0.025, t + 0.08); a.gain.exponentialRampToValueAtTime(0.0008, t + 1.3);
    n.start(t, Math.random() * 1); n.stop(t + 1.35);
  }
  function playLower(s, t) {
    const b = st.bright, ss = s % 16, chord = PROG_LOWER[Math.floor(s / 32) % 4];
    if (s % 32 === 0 && st.pad) pad(chord, t, 32 * S16);
    /* 機械が刻むような8分のベース */
    if (ss % 2 === 0) bass(chord.root - 12 + (ss === 6 || ss === 14 ? 12 : 0), t, 0.25 + 0.3 * b);
    /* 重いキックと、2拍目・4拍目のハンマー */
    if (ss === 0 || ss === 8 || (ss === 10 && b > 0.6)) kick(t, 0.32);
    if (ss === 4 || ss === 12) clank(t, 0.05 + 0.03 * b);
    if (b > 0.55 && ss % 4 === 2) hat(t, 0.025, false);
    /* 低いアルペジオ（奥へ行くほど聞こえる） */
    const arpLvl = clamp01((b - 0.45) / 0.4) * 0.03;
    if (arpLvl > 0.002 && ss % 2 === 0) arp(chord.tones[ARP[(s / 2) % 8 | 0]], t, arpLvl, b * 0.6);
    if (s % 64 === 44) hiss(t);
  }
  /* 企業区：静かなパッド、細かい時計のような刻み、澄んだアルペジオ。キックは弱く */
  function playCorp(s, t) {
    const b = st.bright, ss = s % 16, chord = PROG_CORP[Math.floor(s / 32) % 4];
    if (s % 32 === 0 && st.pad) pad({ root: chord.root, tones: chord.tones.map(m => m - 12) }, t, 32 * S16);
    if (ss === 0 || ss === 8) bass(chord.root - 12, t, 0.25 + 0.2 * b);
    if (ss === 0) kick(t, 0.12);
    if (ss % 2 === 1) hat(t, 0.012, false);
    if (ss % 2 === 0) arp(chord.tones[ARP[(s / 2) % 8 | 0]] + 12, t, 0.02 + 0.015 * b, 0.4 + 0.4 * b);
    if (s % 64 === 36) ping(t);
  }
  /* 天穹区：速い16分のベースと、追い立てるようなハイハット（戦いの層） */
  function playSky(s, t) {
    const b = st.bright, ss = s % 16, chord = PROG_SKY[Math.floor(s / 32) % 4];
    if (s % 32 === 0 && st.pad) pad({ root: chord.root, tones: chord.tones.map(m => m - 12) }, t, 32 * S16);
    bass(chord.root - 12 + (ss % 4 === 3 ? 12 : 0), t, 0.3 + 0.25 * b);
    if (ss === 0 || ss === 6 || ss === 8 || ss === 14) kick(t, 0.3);
    if (ss === 4 || ss === 12) clank(t, 0.035);
    hat(t, ss % 2 ? 0.012 : 0.022, ss === 14);
    if (ss % 2 === 0) arp(chord.tones[ARP[(s / 2) % 8 | 0]] + 12, t, 0.022 + 0.012 * b, 0.6 + 0.3 * b);
  }
  /* 中央区：ゆっくり鳴り続ける白い和音と、遠い鐘だけ */
  function playTop(s, t) {
    const chord = PROG_TOP[Math.floor(s / 64) % 2];
    if (s % 64 === 0 && st.pad) pad(chord, t, 64 * S16);
    if (s % 32 === 0) bass(chord.root - 24, t, 0.2);
    if (s % 16 === 8) arp(chord.tones[(s / 16 | 0) % 4] + 24, t, 0.018, 0.9);
    if (s % 64 === 40) ping(t);
  }
  function playStep(s, t) {
    if (st.mood === 'lower') return playLower(s, t);
    if (st.mood === 'corp') return playCorp(s, t);
    if (st.mood === 'sky') return playSky(s, t);
    if (st.mood === 'top') return playTop(s, t);
    const b = st.bright, ss = s % 16, chord = PROG[Math.floor(s / 32) % 4];
    if (s % 32 === 0 && st.pad) pad(chord, t, 32 * S16);
    const bassHits = b > 0.5 ? [0, 3, 6, 8, 11, 14] : [0, 6, 8, 14];
    if (bassHits.includes(ss)) bass(chord.root - 12 + (ss === 14 ? 12 : 0), t, b);
    const arpLvl = clamp01((b - 0.2) / 0.5) * 0.045;
    if (arpLvl > 0.002) {
      const every = b > 0.7 ? 1 : 2;
      if (ss % every === 0) arp(chord.tones[ARP[(s / every) % 8 | 0]] + 12, t, arpLvl, b);
    }
    if (b > 0.35) {
      const hl = 0.03 + 0.05 * clamp01((b - 0.35) / 0.65);
      if (ss % 4 === 2) hat(t, hl, ss === 14 && b > 0.6);
      else if (b > 0.75 && ss % 2 === 1) hat(t, hl * 0.45, false);
    }
    if (b > 0.6 && (ss === 0 || ss === 8 || (b > 0.85 && ss === 10))) kick(t, 0.45 * clamp01((b - 0.5) / 0.5) + 0.15);
    if (s % 64 === 36 && Math.random() < 0.7) ping(t);
  }

  function sched() {
    if (!st.playing) return;
    while (nextTime < ctx.currentTime + 0.15) {
      playStep(step, nextTime);
      nextTime += S16; step = (step + 1) % LOOP;
    }
  }

  function start() {
    if (!ctx || st.playing) return;
    st.playing = true;
    const t = ctx.currentTime;
    bgmMix.gain.cancelScheduledValues(t); bgmMix.gain.setValueAtTime(bgmMix.gain.value, t); bgmMix.gain.linearRampToValueAtTime(1, t + 1.2);
    nextTime = t + 0.06; step = 0;
    sched();
    timer = setInterval(sched, 25);
  }
  function stop() {
    if (!ctx || !st.playing) return;
    st.playing = false; clearInterval(timer); timer = null;
    const t = ctx.currentTime;
    bgmMix.gain.cancelScheduledValues(t); bgmMix.gain.setValueAtTime(bgmMix.gain.value, t); bgmMix.gain.linearRampToValueAtTime(0, t + 1.0);
  }

  function applyBright(b) {
    if (!ctx) return;
    const t = ctx.currentTime;
    padFilter.frequency.setTargetAtTime(320 + 2000 * b * b, t, 0.6);
    padLfoAmt.gain.setTargetAtTime(150 + 500 * b, t, 0.6);
  }
  function setLayer(name, on) {
    on = !!on;
    if (name === 'pad') st.pad = on;
  }
  function applyCyber() {
    if (!ctx) return;
    const c = st.cyber, t = ctx.currentTime, steps = Math.round(48 - 42 * c), curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = i / 511.5 - 1; curve[i] = Math.round(x * steps) / steps; }
    crusher.curve = curve;
    ringOsc.frequency.setTargetAtTime(60 + 90 * c, t, 0.05);
    seDry.gain.setTargetAtTime(1 - 0.65 * c, t, 0.05);
    seWet.gain.setTargetAtTime(0.9 * c, t, 0.05);
  }
  function setCyber(c) { st.cyber = clamp01(+c || 0); applyCyber(); }
  function setMood(m) { st.mood = ['lower', 'corp', 'sky', 'top'].includes(m) ? m : 'out'; }
  function setBrightness(b) { st.bright = clamp01(+b || 0); applyBright(st.bright); }

  function setVolume(kind, v) {
    v = clamp01(+v);
    if (kind === 'bgm') { st.bgmVol = v; if (bgmIn) bgmIn.gain.setTargetAtTime(v, ctx.currentTime, 0.05); }
    else if (kind === 'se') { st.seVol = v; if (seIn) seIn.gain.setTargetAtTime(v * SE_BOOST, ctx.currentTime, 0.05); }
  }
  function setMuted(m) { st.muted = !!m; if (master) master.gain.setTargetAtTime(st.muted ? 0 : 0.9, ctx.currentTime, 0.05); }

  /* ===== 効果音 ===== */
  function tone(type, f0, t, dur, lvl, opt) {
    opt = opt || {};
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f0, t);
    if (opt.to) o.frequency.exponentialRampToValueAtTime(opt.to, t + (opt.slide || dur));
    if (opt.detune) o.detune.value = opt.detune;
    const a = g(0);
    let node = o;
    if (opt.lp) { const f = filt('lowpass', opt.lp, opt.q || 1); o.connect(f); node = f; }
    node.connect(a); a.connect(seIn); if (opt.echo) a.connect(g(opt.echo, delayIn));
    a.gain.setValueAtTime(0, t); a.gain.linearRampToValueAtTime(lvl, t + (opt.attack || 0.005));
    a.gain.exponentialRampToValueAtTime(0.0006, t + dur);
    o.start(t); o.stop(t + dur + 0.02);
  }
  function noise(t, dur, lvl, type, freq, q, rate) {
    const n = ctx.createBufferSource(); n.buffer = noiseBuf; if (rate) n.playbackRate.value = rate;
    const f = filt(type, freq, q), a = g(0, seIn); n.connect(f); f.connect(a);
    a.gain.setValueAtTime(lvl, t); a.gain.exponentialRampToValueAtTime(0.0006, t + dur);
    n.start(t, Math.random() * 2); n.stop(t + dur + 0.02);
  }

  const SE = {
    /* 会話の文字送り */
    text(t) {
      const c = st.cyber;
      if (c < 0.4) tone('square', 1050 + Math.random() * 160, t, 0.035, 0.035, { lp: 3000 });
      else { /* 機械側：データを読み上げるような2連の電子音 */
        const f = [1600, 2000, 2400][Math.floor(Math.random() * 3)];
        tone('square', f, t, 0.018, 0.03, { lp: 6000 }); tone('square', f * 1.5, t + 0.022, 0.018, 0.025, { lp: 6000 });
      }
    },
    /* 足音（濡れた路面） */
    step(t) {
      const c = st.cyber;
      noise(t, 0.06, 0.22 * (1 - 0.5 * c), 'lowpass', 420, 1); noise(t + 0.01, 0.05, 0.05 * (1 - c), 'bandpass', 3200, 2, 1.2);
      if (c > 0.15) { /* 金属の足音 */
        noise(t, 0.09, 0.12 * c, 'bandpass', 2600 + Math.random() * 600, 18);
        tone('triangle', 1900 + Math.random() * 300, t, 0.07, 0.025 * c);
      }
      if (c > 0.6) tone('sawtooth', 280, t + 0.01, 0.14, 0.03 * c, { to: 620, slide: 0.12, lp: 2200 }); /* 関節のモーター音 */
    },
    /* ボタン・決定 */
    ui(t) { tone('square', 660, t, 0.05, 0.05, { lp: 4000 }); tone('square', 990, t + 0.05, 0.08, 0.05, { lp: 4000 }); },
    /* 壊れたネオンのジジッ */
    neon(t) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 100;
      const o2 = ctx.createOscillator(); o2.type = 'square'; o2.frequency.value = 200.5;
      const f = filt('bandpass', 1100, 1.5), a = g(0, seIn);
      o.connect(f); o2.connect(f); f.connect(a);
      let tt = t;
      for (let i = 0; i < 7; i++) {
        const on = 0.02 + Math.random() * 0.06, off = 0.01 + Math.random() * 0.05;
        a.gain.setValueAtTime(0.07, tt); a.gain.setValueAtTime(0, tt + on); tt += on + off;
      }
      o.start(t); o2.start(t); o.stop(tt + 0.02); o2.stop(tt + 0.02);
      noise(t, tt - t, 0.02, 'highpass', 5000, 0.5);
    },
    /* ブレインスキャン開始 */
    scan(t) {
      tone('sine', 180, t, 0.9, 0.12, { to: 2200, slide: 0.85, attack: 0.05, echo: 0.3 });
      tone('triangle', 90, t, 0.9, 0.08, { to: 1100, slide: 0.85, attack: 0.05 });
      tone('sine', 1760, t + 0.9, 0.12, 0.07);
      tone('sine', 1760, t + 1.05, 0.12, 0.07);
    },
    /* ゲート：拒否 */
    deny(t) {
      tone('square', 330, t, 0.2, 0.09, { lp: 1600 });
      tone('square', 220, t + 0.22, 0.45, 0.1, { lp: 1200 });
      noise(t + 0.22, 0.4, 0.04, 'bandpass', 900, 3);
    },
    /* ゲート：許可 */
    allow(t) {
      [62, 66, 69, 74, 78].forEach((m, i) => tone('triangle', mtof(m + 12), t + i * 0.085, 0.7, 0.07, { echo: 0.4 }));
      tone('sine', mtof(50), t, 1.2, 0.08, { attack: 0.05 });
    },
    /* ミニゲーム成功 */
    success(t) {
      [72, 76, 79, 84].forEach((m, i) => tone('triangle', mtof(m), t + i * 0.06, 0.35, 0.07, { echo: 0.25 }));
      tone('square', mtof(88), t + 0.26, 0.4, 0.03, { lp: 5000, echo: 0.3 });
    },
    /* ミニゲーム失敗 */
    fail(t) {
      tone('sawtooth', 240, t, 0.55, 0.11, { to: 70, slide: 0.5, lp: 900, detune: -10 });
      tone('sawtooth', 236, t, 0.55, 0.08, { to: 68, slide: 0.5, lp: 900, detune: 12 });
      noise(t, 0.3, 0.06, 'lowpass', 300, 1);
    },
    /* 被弾・ミス */
    hit(t) {
      noise(t, 0.16, 0.18, 'bandpass', 1400, 1.5);
      tone('square', 160, t, 0.18, 0.08, { to: 55, lp: 1500 });
    },
    /* クレジット獲得 */
    credit(t) {
      tone('square', 988, t, 0.07, 0.05, { lp: 6000 });
      tone('square', 1319, t + 0.07, 0.35, 0.05, { lp: 6000, echo: 0.25 });
      tone('sine', 2637, t + 0.07, 0.25, 0.02);
    },
    /* パスコードなどのキー入力 */
    key(t) { tone('sine', 880 + Math.random() * 40, t, 0.06, 0.06); noise(t, 0.02, 0.04, 'highpass', 4000, 0.5); },
    /* 昇降機（縦坑）：低いうなりが上がって、到着のチャイム */
    lift(t) {
      tone('sawtooth', 55, t, 1.4, 0.07, { to: 110, slide: 1.2, lp: 420, attack: 0.2 });
      noise(t, 1.2, 0.03, 'lowpass', 300, 1);
      tone('sine', 1319, t + 1.3, 0.5, 0.05, { echo: 0.3 });
      tone('sine', 1047, t + 1.45, 0.6, 0.05, { echo: 0.3 });
    },
    /* 目的が更新されたとき：明るく短い2音 */
    goal(t) {
      tone('sine', mtof(79), t, 0.35, 0.05, { attack: 0.01, echo: 0.25 });
      tone('sine', mtof(84), t + 0.13, 0.5, 0.05, { attack: 0.01, echo: 0.3 });
    },
    /* 本音：やわらかい和音の上で、オルゴールのような音がゆっくり上がる（怖くならないように、低いうなりと不協和音は使わない） */
    honne(t) {
      tone('sine', mtof(60), t, 2.0, 0.025, { attack: 0.6 });
      tone('sine', mtof(64), t, 2.0, 0.02, { attack: 0.6 });
      [72, 76, 79, 84].forEach((m, i) => tone('sine', mtof(m), t + 0.15 + i * 0.24, 1.2, 0.035, { attack: 0.02, echo: 0.35 }));
    },
    /* ===== 戦い（天穹区から） ===== */
    /* パルスガン */
    shot(t) { tone('square', 1400, t, 0.09, 0.05, { to: 420, slide: 0.08, lp: 5000 }); noise(t, 0.04, 0.05, 'highpass', 3000, 0.7); },
    /* ミナ・ソウの射撃（少し低い） */
    shot2(t) { tone('square', 900, t, 0.08, 0.03, { to: 300, slide: 0.07, lp: 3000 }); },
    /* 弾切れ */
    empty(t) { tone('square', 220, t, 0.04, 0.04, { lp: 1200 }); },
    /* 敵の弾 */
    eshot(t) { tone('sawtooth', 700, t, 0.12, 0.035, { to: 200, slide: 0.1, lp: 2400 }); },
    /* 敵に当たった・弱点に当たった */
    ehit(t) { noise(t, 0.05, 0.08, 'bandpass', 2600, 3); tone('square', 520, t, 0.05, 0.03, { lp: 3000 }); },
    weak(t) { noise(t, 0.06, 0.08, 'bandpass', 3400, 3); [88, 93].forEach((m, i) => tone('square', mtof(m), t + i * 0.04, 0.08, 0.035, { lp: 6000 })); },
    /* 敵が壊れた */
    boom(t) { noise(t, 0.5, 0.2, 'lowpass', 900, 0.8); tone('sine', 120, t, 0.45, 0.14, { to: 35, slide: 0.4 }); },
    /* 跳ぶ・着地・回避 */
    jump(t) { tone('square', 300, t, 0.1, 0.035, { to: 720, slide: 0.09, lp: 2500 }); },
    land(t) { noise(t, 0.12, 0.14, 'lowpass', 400, 1); },
    dodge(t) { noise(t, 0.18, 0.08, 'bandpass', 1800, 1.5, 1.6); tone('sine', 900, t, 0.16, 0.03, { to: 400, slide: 0.15 }); },
    /* 警報（区画が封鎖された） */
    alarm(t) { for (let i = 0; i < 3; i++) { tone('square', 880, t + i * 0.24, 0.12, 0.05, { lp: 2400 }); tone('square', 660, t + i * 0.24 + 0.12, 0.12, 0.05, { lp: 2400 }); } },
    /* 攻撃の予兆（記憶バッファがあるときだけ） */
    warn(t) { tone('sine', 1760, t, 0.06, 0.03); },
    /* サイボーグの突進、番人のレーザー */
    dash(t) { noise(t, 0.3, 0.1, 'bandpass', 900, 1.2, 0.7); tone('sawtooth', 160, t, 0.3, 0.05, { to: 480, slide: 0.25, lp: 1600 }); },
    laser(t) { tone('sawtooth', 1200, t, 0.5, 0.05, { to: 300, slide: 0.45, lp: 4000 }); noise(t, 0.45, 0.05, 'highpass', 4000, 0.7); },
    /* ソウの一撃 */
    slash(t) { noise(t, 0.12, 0.12, 'highpass', 2000, 0.8, 1.4); },
    /* ミナの手当て・弾の受け渡し */
    heal(t) { [72, 76, 79].forEach((m, i) => tone('sine', mtof(m), t + i * 0.07, 0.4, 0.04, { echo: 0.25 })); },
    ammo(t) { tone('square', 660, t, 0.05, 0.04, { lp: 3000 }); noise(t + 0.06, 0.06, 0.08, 'bandpass', 2000, 2); tone('square', 990, t + 0.08, 0.06, 0.04, { lp: 3000 }); },
    /* 手配書に赤いバツを書く音（ペンでこする） */
    xmark(t) { noise(t, 0.34, 0.16, 'bandpass', 1700, 1.4, 0.9); noise(t + 0.02, 0.3, 0.06, 'highpass', 5000, 0.6); },
    /* インプラント装着 */
    implant(t) {
      tone('sawtooth', 70, t, 1.0, 0.1, { to: 140, slide: 0.9, lp: 700, attack: 0.1 });
      noise(t, 0.5, 0.05, 'bandpass', 2400, 4);
      [81, 86, 93].forEach((m, i) => tone('sine', mtof(m), t + 0.7 + i * 0.07, 0.3, 0.04, { echo: 0.3 }));
    }
  };
  const SE_NAMES = Object.keys(SE);

  /* 効果音ごとの「BGMをどこまで下げるか」と「下げておく時間（秒）」 */
  const DUCK = {
    text: [0.85, 0.05], step: [0.8, 0.05], key: [0.75, 0.06], ui: [0.6, 0.12],
    scan: [0.35, 1.1], implant: [0.35, 1.0], lift: [0.4, 1.6], honne: [0.55, 1.8], goal: [0.6, 0.5], shot: [0.85, 0.05], shot2: [0.9, 0.05], eshot: [0.9, 0.05], ehit: [0.9, 0.05], weak: [0.85, 0.08], jump: [0.9, 0.05], warn: [0.9, 0.05], xmark: [1, 0.1], allow: [0.4, 0.8], deny: [0.4, 0.6]
  };
  function se(name) {
    if (!ctx || !SE[name]) return;
    if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
    const t = ctx.currentTime;
    const [level, hold] = DUCK[name] || [0.45, 0.35];
    const now = duck.gain.value;
    duck.gain.cancelScheduledValues(t);
    duck.gain.setValueAtTime(now, t);
    duck.gain.setTargetAtTime(Math.min(now, level), t, 0.015);
    duck.gain.setTargetAtTime(1, t + hold, 0.25);
    SE[name](t + 0.01);
  }

  global.NGSound = {
    init, start, stop, se, setBrightness, setLayer, setCyber, setMood, setVolume, setMuted, SE_NAMES,
    isPlaying: () => st.playing,
    analyser: () => an,
    context: () => ctx,
    state: () => Object.assign({}, st)
  };
})(typeof window !== 'undefined' ? window : globalThis);
