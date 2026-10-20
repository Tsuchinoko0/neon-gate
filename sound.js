/* NEON GATE sound.js
 * Web Audio API だけで鳴らすBGMと効果音（音声ファイル不要・外部ライブラリなし）
 *
 * 使い方：
 *   NGSound.init()            … 最初のクリック／タップの中で1回呼ぶ（ブラウザの決まりで、操作の前は音を鳴らせない）
 *   NGSound.start()           … BGMを鳴らす
 *   NGSound.stop(秒)          … BGMを止める（フェードアウト。秒を省くと1秒）
 *   NGSound.setBrightness(b)  … 0（暗い）〜1（明るい）。明るいほどBGMの音が開き、楽器が増える
 *   NGSound.se('credit')      … 効果音を鳴らす。名前は NGSound.SE_NAMES を参照
 *   NGSound.setVolume('bgm' | 'se', 0〜1)
 *   NGSound.setMuted(true / false)
 *   NGSound.setCyber(c)       … 0（生身）〜1（完全サイボーグ）。効果音が機械的な音に変わっていく（画面は変えない）
 *   NGSound.setLayer('pad', true / false)  … シンセの持続音のオン・オフ
 *   NGSound.setMood(名前)     … BGMの曲。切り替えると前の曲はフェードアウトして残らない
 *       'out'   圏外（暗いシンセ。明るさで楽器が増える）
 *       'lower' 沈殿街（工場の機械音とハンマーのリズム）
 *       'corp'  企業区（静かで澄んだ電子音）
 *       'sky'   天穹区（ガラスの和音とオルゴール。静かで美しいが、どこか不安）
 *       'fight' 戦い（天穹区の区画で戦うとき。速いベースとドラム）
 *       'boss'  戦い・番人（'fight' に重い金管のような音が加わる）
 *       'top'   中央区（パイプオルガンのような和音と、ひとりの歌声のような旋律）
 *   NGSound.analyser()        … 波形表示用の AnalyserNode（init 前は null）
 */
(function (global) {
  'use strict';

  const BPM = 84, SPB = 60 / BPM, S16 = SPB / 4, LOOP = 512;
  /* 曲ごとの速さ（圏外・沈殿街・企業区は今までどおり 84） */
  const TEMPO = { out: 84, lower: 84, corp: 84, sky: 66, fight: 138, boss: 138, top: 52 };
  const MOODS = Object.keys(TEMPO);
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
  /* 天穹区：F（リディア）→ C/E → D♭（半音ずれた不安）→ Gsus（解決しない） */
  const PROG_SKY = [
    { root: 41, tones: [57, 64, 67, 71] },
    { root: 40, tones: [55, 59, 64, 72] },
    { root: 37, tones: [56, 60, 65, 67] },
    { root: 43, tones: [55, 60, 62, 69] }
  ];
  /* オルゴールの並び（[16分の位置, 和音の何番目の音]）。毎回まったく同じ＝整いすぎた街 */
  const SKY_BELL = [[0, 0], [6, 1], [12, 2], [20, 3], [26, 2]];
  /* 戦い：Am → F → D♭（天穹区と同じ不安な和音）→ E */
  const PROG_FIGHT = [
    { root: 45, tones: [57, 60, 64, 69] },
    { root: 41, tones: [57, 60, 65, 69] },
    { root: 37, tones: [56, 61, 65, 68] },
    { root: 40, tones: [56, 59, 64, 68] }
  ];
  const FIGHT_BASS = [0, 0, 12, 0, 0, 12, 0, 0, 0, 0, 12, 0, 0, 12, 0, 7];
  const FIGHT_ARP = [0, 1, 2, 3, 2, 1, 2, 3];
  /* 戦いの後半の旋律（[位置, 音, 長さ]。和音ごとに32ステップ） */
  const FIGHT_LEAD = [
    [[0, 76, 6], [6, 74, 2], [8, 72, 4], [12, 71, 4], [16, 69, 8], [24, 72, 4], [28, 71, 4]],
    [[0, 72, 6], [6, 74, 2], [8, 76, 4], [12, 77, 4], [16, 76, 12], [28, 72, 4]],
    [[0, 77, 6], [6, 75, 2], [8, 73, 4], [12, 72, 4], [16, 68, 8], [24, 73, 8]],
    [[0, 71, 6], [6, 72, 2], [8, 71, 4], [12, 68, 4], [16, 64, 12], [28, 68, 4]]
  ];
  /* 中央区：低いドの上で C → F/C → A♭/C → G/C（ずっと同じ低音＝止まらない巨大な機械） */
  const PROG_TOP = [
    { root: 36, tones: [60, 64, 67, 72, 76] },
    { root: 36, tones: [57, 60, 65, 69, 72] },
    { root: 36, tones: [56, 60, 63, 68, 72] },
    { root: 36, tones: [55, 59, 62, 67, 74] }
  ];
  const TOP_VOICE = [
    [[0, 76, 12], [12, 74, 4], [16, 72, 14]],
    [[0, 77, 8], [8, 76, 8], [16, 72, 14]],
    [[0, 75, 12], [12, 72, 4], [16, 68, 14]],
    [[0, 74, 8], [8, 71, 8], [16, 67, 14]]
  ];
  const ARP = [0, 2, 1, 3, 2, 1, 3, 0];
  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
  const clamp01 = v => Math.max(0, Math.min(1, v));

  const st = { bgmVol: 0.6, seVol: 0.8, muted: false, bright: 0, playing: false, pad: true, cyber: 0, mood: 'out' };
  const SE_BOOST = 4; /* 効果音をBGMより前に出すための底上げ */
  const OUT_GAIN = 0.85; /* 最後の出口の大きさ（BGMと効果音が重なっても音割れしないよう、0.9 から少し下げた） */
  let ctx = null, master, bgmIn, bgmMix, duck, seIn, seDry, seWet, crusher, ringOsc, padLfoAmt, delayIn, reverbIn, an;
  let noiseBuf = null, timer = null, nextTime = 0, step = 0, bus = null, organWave = null, voiceWave = null, xCount = 0;
  const stepDur = () => 60 / TEMPO[st.mood] / 4;

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
  function wave(amps) {
    const re = new Float32Array(amps.length + 1), im = new Float32Array(amps.length + 1);
    amps.forEach((a, i) => { im[i + 1] = a; });
    return ctx.createPeriodicWave(re, im);
  }

  function init(existing) {
    if (ctx) { if (ctx.state === 'suspended' && ctx.resume) ctx.resume(); return true; }
    const AC = global.AudioContext || global.webkitAudioContext;
    if (!existing && !AC) return false;
    ctx = existing || new AC();

    /* 出力：BGM（コンプレッサー）と効果音（リミッター）を別々に整えてから合流させる */
    const out = g(st.muted ? 0 : OUT_GAIN);
    an = ctx.createAnalyser(); an.fftSize = 1024;
    out.connect(an); an.connect(ctx.destination);
    master = out;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.knee.value = 12; comp.ratio.value = 4; comp.attack.value = 0.005; comp.release.value = 0.2;
    comp.connect(out);
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -4; lim.knee.value = 2; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.1;
    lim.connect(out);

    /* 空間：効果音用のディレイ（付点8分）と、共有のリバーブ。BGMのディレイは曲ごとに持つ（makeBus） */
    delayIn = g(1);
    const dl = ctx.createDelay(2); dl.delayTime.value = SPB * 0.75;
    const fb = g(0.38), dlp = filt('lowpass', 2400, 0.5);
    delayIn.connect(dl); dl.connect(dlp); dlp.connect(fb); fb.connect(dl); dlp.connect(g(0.55, comp));
    reverbIn = g(1);
    const rv = ctx.createConvolver(); rv.buffer = makeImpulse(3.2, 2.4);
    reverbIn.connect(rv); rv.connect(g(0.42, comp));

    /* BGM：曲ごとの bus → bgmMix（再生・停止のフェード）→ bgmIn（音量）→ 原音／リバーブ */
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

    /* パッド用のフィルターを揺らすLFO（曲ごとの bus のフィルターにつなぐ） */
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.06;
    padLfoAmt = g(180); lfo.connect(padLfoAmt); lfo.start();

    noiseBuf = makeNoise(2.5);
    organWave = wave([1, 0.55, 0.3, 0.22, 0, 0.1, 0, 0.06]);
    voiceWave = wave([1, 0.32, 0.14, 0.05, 0.02]);
    bus = makeBus(0.02);
    applyBright(0);
    applyCyber();
    return true;
  }

  /* ===== 曲ごとの出口（bus）。切り替えるときは古い bus ごとフェードアウトして切り離す ===== */
  const padFreq = () => 320 + 2000 * st.bright * st.bright;
  function makeBus(fadeIn) {
    const t = ctx.currentTime, out = g(0, bgmMix);
    out.gain.setValueAtTime(0, t); out.gain.linearRampToValueAtTime(1, t + Math.max(0.02, fadeIn));
    const pf = filt('lowpass', padFreq(), 2, out); padLfoAmt.connect(pf.frequency);
    /* この曲だけのディレイ（曲の速さに合わせた付点8分）。返りは bus に戻すので、切り替えで残響ごと消える */
    const dly = g(1), d = ctx.createDelay(2); d.delayTime.value = 60 / TEMPO[st.mood] * 0.75;
    const fb = g(0.38), lp = filt('lowpass', 2400, 0.5);
    dly.connect(d); d.connect(lp); lp.connect(fb); fb.connect(d); lp.connect(g(0.9, out));
    return { out, pf, dly };
  }
  function retireBus(b, fade) {
    if (!b) return;
    const t = ctx.currentTime, p = b.out.gain;
    p.cancelScheduledValues(t); p.setValueAtTime(p.value, t); p.linearRampToValueAtTime(0, t + fade);
    b.dly.gain.setValueAtTime(0, t);
    setTimeout(() => { try { padLfoAmt.disconnect(b.pf.frequency); } catch (e) { } try { b.out.disconnect(); } catch (e) { } }, (fade + 0.4) * 1000);
  }
  function switchBus(fadeOut, fadeIn) {
    retireBus(bus, fadeOut);
    bus = makeBus(fadeIn);
    step = 0;
    if (st.playing) nextTime = ctx.currentTime + 0.05;
  }
  const B = () => bus;

  /* ===== BGMの各パート ===== */
  function pad(chord, t, dur) {
    const env = g(0, B().pf);
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
    const dg = g(0, B().out); d.connect(dg);
    dg.gain.setValueAtTime(0, t); dg.gain.linearRampToValueAtTime(0.06, t + 1.5);
    dg.gain.setValueAtTime(0.06, t + dur - 0.3); dg.gain.linearRampToValueAtTime(0, t + dur + 1.2);
    d.start(t); d.stop(t + dur + 1.3);
  }
  function bass(m, t, b) {
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mtof(m);
    const s = ctx.createOscillator(); s.type = 'sine'; s.frequency.value = mtof(m);
    const f = filt('lowpass', 900, 6), a = g(0, B().out);
    o.connect(f); s.connect(a); f.connect(a);
    f.frequency.setValueAtTime(220 + 900 * b, t); f.frequency.exponentialRampToValueAtTime(90, t + 0.25);
    a.gain.setValueAtTime(0, t); a.gain.linearRampToValueAtTime(0.11, t + 0.008); a.gain.exponentialRampToValueAtTime(0.001, t + 0.42);
    o.start(t); s.start(t); o.stop(t + 0.45); s.stop(t + 0.45);
  }
  function arp(m, t, lvl, b) {
    const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = mtof(m);
    const f = filt('lowpass', 900 + 3200 * b, 3), a = g(0);
    o.connect(f); f.connect(a); a.connect(B().out); a.connect(B().dly);
    a.gain.setValueAtTime(0, t); a.gain.linearRampToValueAtTime(lvl, t + 0.004); a.gain.exponentialRampToValueAtTime(0.0008, t + 0.16);
    o.start(t); o.stop(t + 0.18);
  }
  /* BGM用のノイズ（ハイハット・スネア・工場の音） */
  function bnz(t, dur, lvl, type, freq, q, rate) {
    const n = ctx.createBufferSource(); n.buffer = noiseBuf; if (rate) n.playbackRate.value = rate;
    const f = filt(type, freq, q), a = g(0, B().out); n.connect(f); f.connect(a);
    a.gain.setValueAtTime(lvl, t); a.gain.exponentialRampToValueAtTime(0.0006, t + dur);
    n.start(t, Math.random() * 2); n.stop(t + dur + 0.02);
  }
  function hat(t, lvl, open) { bnz(t, open ? 0.18 : 0.045, lvl, 'highpass', 7500, 0.7, 1.5); }
  function kick(t, lvl) {
    const o = ctx.createOscillator(); o.type = 'sine';
    const a = g(0, B().out); o.connect(a);
    o.frequency.setValueAtTime(130, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.22);
    a.gain.setValueAtTime(lvl, t); a.gain.exponentialRampToValueAtTime(0.001, t + 0.38);
    o.start(t); o.stop(t + 0.4);
  }
  function ping(t) {
    /* 遠くで鳴る合図のような音（ディレイで残響） */
    const m = [74, 77, 81, 69][Math.floor(Math.random() * 4)];
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = mtof(m);
    const a = g(0); a.connect(B().out); a.connect(B().dly);
    a.gain.setValueAtTime(0, t); a.gain.linearRampToValueAtTime(0.035, t + 0.01); a.gain.exponentialRampToValueAtTime(0.0008, t + 1.2);
    o.start(t); o.stop(t + 1.25);
  }
  /* 工場の音：ハンマーで鉄を打つ音（ノイズは今まで効果音の経路で鳴っていたので、同じ大きさになるよう ×5） */
  function clank(t, lvl) {
    bnz(t, 0.09, lvl * 5, 'bandpass', 2600 + Math.random() * 500, 9);
    const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = 1830;
    const o2 = ctx.createOscillator(); o2.type = 'triangle'; o2.frequency.value = 2757;
    const a = g(0, B().out); o.connect(a); o2.connect(a); a.connect(g(0.4, B().dly));
    a.gain.setValueAtTime(lvl * 0.5, t); a.gain.exponentialRampToValueAtTime(0.0006, t + 0.35);
    o.start(t); o2.start(t); o.stop(t + 0.37); o2.stop(t + 0.37);
  }
  /* 工場の音：蒸気が抜ける音 */
  function hiss(t) {
    const n = ctx.createBufferSource(); n.buffer = noiseBuf;
    const f = filt('highpass', 2000, 0.7), a = g(0, B().out); n.connect(f); f.connect(a);
    f.frequency.setValueAtTime(5000, t); f.frequency.exponentialRampToValueAtTime(900, t + 1.2);
    a.gain.setValueAtTime(0, t); a.gain.linearRampToValueAtTime(0.025, t + 0.08); a.gain.exponentialRampToValueAtTime(0.0008, t + 1.3);
    n.start(t, Math.random() * 1); n.stop(t + 1.35);
  }

  /* ----- 天穹区・戦い・中央区で使う楽器 ----- */
  /* なめらかに立ち上がって消える音の入れ物 */
  function swell(t, dur, lvl, atk, rel, dest) {
    const a = g(0, dest);
    a.gain.setValueAtTime(0, t); a.gain.linearRampToValueAtTime(lvl, t + atk);
    a.gain.setValueAtTime(lvl, t + Math.max(atk, dur)); a.gain.linearRampToValueAtTime(0, t + Math.max(atk, dur) + rel);
    return a;
  }
  /* ガラスの和音：澄んだサイン波を少しずらして重ねる */
  function glass(tones, t, dur, lvl) {
    const f = filt('lowpass', 2600, 0.5, B().out), a = swell(t, dur, lvl, 2.6, 3.2, f);
    tones.forEach((m, i) => {
      [['sine', -4], ['triangle', 5]].forEach(([ty, det]) => {
        const o = ctx.createOscillator(); o.type = ty; o.frequency.value = mtof(m); o.detune.value = det + i;
        o.connect(a); o.start(t); o.stop(t + dur + 3.4);
      });
    });
  }
  /* 低い持続音 */
  function sub(m, t, dur, lvl) {
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = mtof(m);
    o.connect(swell(t, dur, lvl, 2.0, 2.4, B().out)); o.start(t); o.stop(t + dur + 2.6);
  }
  /* オルゴール・チェレスタ風の鐘 */
  function bell(m, t, lvl, dec, echo) {
    const f = mtof(m), a = g(0); a.connect(B().out); if (echo) a.connect(g(echo, B().dly));
    [[1, 1, dec], [2, 0.28, dec * 0.45], [3, 0.08, dec * 0.25], [4.01, 0.05, dec * 0.15]].forEach(([r, l, d]) => {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f * r;
      const e = g(0, a); o.connect(e);
      e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(lvl * l, t + 0.004); e.gain.exponentialRampToValueAtTime(0.0004, t + d);
      o.start(t); o.stop(t + d + 0.05);
    });
  }
  /* 時計のような小さな刻み */
  function tick(t, lvl) {
    const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = 2350;
    const a = g(0, B().out); o.connect(a);
    a.gain.setValueAtTime(lvl, t); a.gain.exponentialRampToValueAtTime(0.0003, t + 0.025);
    o.start(t); o.stop(t + 0.04);
  }
  /* わずかにずれた2つの音（ゆっくりうなる。きれいだが落ち着かない） */
  function beating(m, t, dur, lvl) {
    const a = swell(t, dur, lvl, 3.0, 3.0, B().out);
    [0, 1.3].forEach(df => { const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = mtof(m) + df; o.connect(a); o.start(t); o.stop(t + dur + 3.1); });
  }
  /* 戦いのベース：16分で刻む、短く切れのいい音 */
  function fbass(m, t, sd, acc) {
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mtof(m);
    const s = ctx.createOscillator(); s.type = 'sine'; s.frequency.value = mtof(m);
    const f = filt('lowpass', 900, 5), a = g(0, B().out);
    o.connect(f); f.connect(a); s.connect(a);
    f.frequency.setValueAtTime(300 + 1300 * acc * (0.7 + 0.3 * st.bright), t); f.frequency.exponentialRampToValueAtTime(120, t + sd * 0.9);
    a.gain.setValueAtTime(0, t); a.gain.linearRampToValueAtTime(0.08 * acc, t + 0.005); a.gain.exponentialRampToValueAtTime(0.001, t + sd * 1.1);
    o.start(t); s.start(t); o.stop(t + sd * 1.2); s.stop(t + sd * 1.2);
  }
  function snare(t, lvl) {
    bnz(t, 0.14, lvl, 'bandpass', 1900, 0.7);
    const o = ctx.createOscillator(); o.type = 'triangle';
    o.frequency.setValueAtTime(210, t); o.frequency.exponentialRampToValueAtTime(160, t + 0.08);
    const a = g(0, B().out); o.connect(a);
    a.gain.setValueAtTime(lvl * 1.4, t); a.gain.exponentialRampToValueAtTime(0.0005, t + 0.1);
    o.start(t); o.stop(t + 0.12);
  }
  /* 金管のような短い和音 */
  function stab(tones, t, lvl, dur) {
    const f = filt('lowpass', 2400, 1.5, null), a = g(0, B().out); f.connect(a); a.connect(g(0.3, B().dly));
    f.frequency.setValueAtTime(2600, t); f.frequency.exponentialRampToValueAtTime(500, t + dur);
    a.gain.setValueAtTime(0, t); a.gain.linearRampToValueAtTime(lvl, t + 0.006); a.gain.exponentialRampToValueAtTime(0.0006, t + dur);
    tones.slice(0, 3).forEach((m, i) => [-8, 8].forEach(det => {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mtof(m); o.detune.value = det + i;
      o.connect(f); o.start(t); o.stop(t + dur + 0.05);
    }));
  }
  /* 旋律（戦い）：ざらっとしたシンセ */
  function lead(m, t, dur, lvl) {
    const f = filt('lowpass', 2200, 2), a = swell(t, dur, lvl, 0.01, 0.12, B().out); a.connect(g(0.35, B().dly));
    f.connect(a);
    [['sawtooth', -6], ['square', 6]].forEach(([ty, det]) => {
      const o = ctx.createOscillator(); o.type = ty; o.frequency.value = mtof(m); o.detune.value = det;
      o.connect(f); o.start(t); o.stop(t + dur + 0.2);
    });
  }
  /* 1周の終わりの盛り上げ（音もフィルターも上がっていく） */
  function riser(t, dur) {
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(330, t + dur);
    const f = filt('lowpass', 300, 4); f.frequency.setValueAtTime(300, t); f.frequency.exponentialRampToValueAtTime(3200, t + dur);
    const a = g(0, B().out); o.connect(f); f.connect(a);
    a.gain.setValueAtTime(0, t); a.gain.linearRampToValueAtTime(0.03, t + dur * 0.95); a.gain.linearRampToValueAtTime(0, t + dur);
    o.start(t); o.stop(t + dur + 0.02);
  }
  /* 番人：低く重い、不穏な和音の一撃 */
  function bossHit(root, t) {
    const f = filt('lowpass', 700, 1.2, null), a = g(0, B().out); f.connect(a);
    f.frequency.setValueAtTime(1100, t); f.frequency.exponentialRampToValueAtTime(260, t + 1.2);
    a.gain.setValueAtTime(0, t); a.gain.linearRampToValueAtTime(0.06, t + 0.01); a.gain.exponentialRampToValueAtTime(0.0005, t + 1.3);
    [root - 12, root - 6, root].forEach(m => [-6, 6].forEach(det => {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mtof(m); o.detune.value = det;
      o.connect(f); o.start(t); o.stop(t + 1.35);
    }));
  }
  /* パイプオルガンのような和音（倍音を重ねた波形） */
  function organ(tones, t, dur, lvl) {
    const f = filt('lowpass', 1600, 0.6, null), a = swell(t, dur, lvl, 3.0, 3.5, B().out); f.connect(a);
    f.frequency.setValueAtTime(900, t); f.frequency.linearRampToValueAtTime(2600 + 1200 * st.bright, t + dur * 0.6);
    tones.forEach(m => [-3, 3].forEach(det => {
      const o = ctx.createOscillator(); o.setPeriodicWave(organWave); o.frequency.value = mtof(m); o.detune.value = det;
      o.connect(f); o.start(t); o.stop(t + dur + 3.6);
    }));
  }
  /* ひとりの歌声のような旋律（ゆっくり揺れる） */
  function voice(m, t, dur, lvl) {
    const o = ctx.createOscillator(); o.setPeriodicWave(voiceWave); o.frequency.value = mtof(m);
    const vib = ctx.createOscillator(); vib.frequency.value = 4.6;
    const vd = g(0); vib.connect(vd); vd.connect(o.detune);
    vd.gain.setValueAtTime(0, t); vd.gain.linearRampToValueAtTime(9, t + Math.min(1.2, dur));
    const f = filt('lowpass', 1900, 0.7), a = swell(t, dur, lvl, 0.45, 1.4, B().out); a.connect(g(0.45, B().dly));
    o.connect(f); f.connect(a);
    o.start(t); vib.start(t); o.stop(t + dur + 1.5); vib.stop(t + dur + 1.5);
  }
  /* 巨大なAIの鼓動：一定の間隔で鳴る、澄んだ短い音 */
  function pulse(t, strong) {
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = mtof(strong ? 84 : 79);
    const a = g(0); a.connect(B().out); a.connect(g(0.6, B().dly));
    a.gain.setValueAtTime(0, t); a.gain.linearRampToValueAtTime(strong ? 0.016 : 0.009, t + 0.01); a.gain.exponentialRampToValueAtTime(0.0004, t + 0.5);
    o.start(t); o.stop(t + 0.55);
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
  /* 天穹区：ドラムもベースもない。ガラスの和音、毎回同じに鳴るオルゴール、かすかな時計の刻み。
     D♭の和音のところで、高い音がゆっくりうなって落ち着かない */
  function playSky(s, t) {
    const b = st.bright, sd = stepDur(), bar = s % 32, ci = Math.floor(s / 32) % 4, ch = PROG_SKY[ci], odd = Math.floor(s / 128) % 2;
    if (bar === 0) {
      if (st.pad) glass(ch.tones, t, 32 * sd, 0.016);
      sub(ch.root - 12, t, 32 * sd, 0.05);
    }
    for (const [k, i] of SKY_BELL) {
      if (bar !== k) continue;
      if (odd && ci === 2 && k === 26) continue; /* 2周目は、ここだけ1音抜ける */
      bell(ch.tones[i] + 12, t, 0.034 + 0.012 * b, 2.6, 0.3);
    }
    if (odd && bar === 16) bell(ch.tones[0], t, 0.022, 3.2, 0.4); /* 2周目は低い答えの音 */
    if (s % 4 === 0) tick(t, s % 16 === 0 ? 0.007 : 0.004);
    if (ci === 2 && bar === 4) beating(ch.tones[3] + 12, t, 18 * sd, 0.009);
  }
  /* 戦い：Am→F→D♭→E を速い16分のベースで。前半はベースとドラムと刻み、後半は金管の和音と旋律が加わる。
     16小節の最後に盛り上げ。'boss' では低い不穏な一撃が小節ごとに加わる */
  function playFight(s, t, boss) {
    const sd = stepDur(), ss = s % 16, bar = s % 32, ci = Math.floor(s / 32) % 4, ch = PROG_FIGHT[ci];
    const p = s % 256, sec = p >= 128 ? 1 : 0, fill = p >= 240;
    fbass(ch.root - 12 + FIGHT_BASS[ss], t, sd, ss % 4 === 0 ? 1 : 0.72);
    if (!fill || ss < 8) {
      if (ss === 0 || ss === 7 || ss === 8 || ss === 10) kick(t, ss === 0 ? 0.42 : 0.32);
      if (ss === 4 || ss === 12) snare(t, 0.07);
    } else if (ss % 2 === 0 || p >= 252) snare(t, 0.03 + 0.004 * (p - 240));
    hat(t, ss % 4 === 2 ? 0.028 : 0.012, ss === 14 && sec === 1);
    arp(ch.tones[FIGHT_ARP[ss % 8]] + 12, t, sec ? 0.013 : 0.018, 0.5);
    if (sec && (bar === 0 || bar === 6 || bar === 16 || bar === 22)) stab(ch.tones, t, 0.03, sd * 3);
    if (sec) for (const [k, m, len] of FIGHT_LEAD[ci]) if (bar === k) lead(m, t, len * sd * 0.92, 0.028);
    if (p === 240) riser(t, 16 * sd);
    if (bar === 0 && st.pad) pad({ root: ch.root, tones: ch.tones.map(m => m - 12) }, t, 32 * sd);
    if (boss && ss === 0) bossHit(ch.root, t);
  }
  /* 中央区：ずっと鳴っている低いド、ゆっくりふくらむオルガンの和音、一定に鳴る機械の鼓動。
     2周目から、ひとりの歌声のような旋律。ドラムはない */
  function playTop(s, t) {
    const sd = stepDur(), bar = s % 32, ci = Math.floor(s / 32) % 4, ch = PROG_TOP[ci], p = s % 256;
    if (bar === 0) {
      if (st.pad) organ(ch.tones, t, 32 * sd, 0.009);
      sub(ch.root, t, 32 * sd, 0.05); sub(ch.root - 12, t, 32 * sd, 0.05);
    }
    if (bar === 16 && st.pad) glass(ch.tones.slice(2).map(m => m + 12), t, 16 * sd, 0.006);
    if (s % 4 === 0) pulse(t, s % 16 === 0);
    if (p >= 128) for (const [k, m, len] of TOP_VOICE[ci]) if (bar === k) voice(m, t, len * sd, 0.04);
  }
  function playStep(s, t) {
    if (st.mood === 'lower') return playLower(s, t);
    if (st.mood === 'corp') return playCorp(s, t);
    if (st.mood === 'sky') return playSky(s, t);
    if (st.mood === 'fight' || st.mood === 'boss') return playFight(s, t, st.mood === 'boss');
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
      nextTime += stepDur(); step = (step + 1) % LOOP;
    }
  }

  function start() {
    if (!ctx || st.playing) return;
    switchBus(0.1, 0.02); /* 止める前の曲の残りを消してから始める */
    st.playing = true;
    const t = ctx.currentTime;
    bgmMix.gain.cancelScheduledValues(t); bgmMix.gain.setValueAtTime(bgmMix.gain.value, t); bgmMix.gain.linearRampToValueAtTime(1, t + 1.2);
    nextTime = t + 0.06; step = 0;
    sched();
    timer = setInterval(sched, 25);
  }
  function stop(fade) {
    if (!ctx || !st.playing) return;
    st.playing = false; clearInterval(timer); timer = null;
    const t = ctx.currentTime, f = fade > 0 ? fade : 1.0;
    bgmMix.gain.cancelScheduledValues(t); bgmMix.gain.setValueAtTime(bgmMix.gain.value, t); bgmMix.gain.linearRampToValueAtTime(0, t + f);
  }

  function applyBright(b) {
    if (!ctx) return;
    const t = ctx.currentTime;
    if (bus) bus.pf.frequency.setTargetAtTime(padFreq(), t, 0.6);
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
  /* 曲を切り替える。戦いに入るときは素早く、戦いから出るときと層の移動はゆっくり入れ替える */
  function setMood(m) {
    m = MOODS.includes(m) ? m : 'out';
    if (m === st.mood) return;
    const prev = st.mood, toFight = m === 'fight' || m === 'boss', fromFight = prev === 'fight' || prev === 'boss';
    st.mood = m;
    if (!ctx) return;
    if (toFight && fromFight) { st.mood = m; return; } /* 戦いの途中で番人に変わるときは、拍を止めずにそのまま */
    if (toFight) switchBus(0.25, 0.03);
    else if (fromFight) switchBus(1.2, 1.5);
    else switchBus(0.8, 1.0);
  }
  function setBrightness(b) { st.bright = clamp01(+b || 0); applyBright(st.bright); }

  function setVolume(kind, v) {
    v = clamp01(+v);
    if (kind === 'bgm') { st.bgmVol = v; if (bgmIn) bgmIn.gain.setTargetAtTime(v, ctx.currentTime, 0.05); }
    else if (kind === 'se') { st.seVol = v; if (seIn) seIn.gain.setTargetAtTime(v * SE_BOOST, ctx.currentTime, 0.05); }
  }
  function setMuted(m) { st.muted = !!m; if (master) master.gain.setTargetAtTime(st.muted ? 0 : OUT_GAIN, ctx.currentTime, 0.05); }

  /* ===== 効果音 ===== */
  /* opt：to（音程の行き先）・slide・detune・lp（ローパス）・lpTo（ローパスの行き先）・q・attack・echo */
  function tone(type, f0, t, dur, lvl, opt) {
    opt = opt || {};
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f0, t);
    if (opt.to) o.frequency.exponentialRampToValueAtTime(opt.to, t + (opt.slide || dur));
    if (opt.detune) o.detune.value = opt.detune;
    const a = g(0);
    let node = o;
    if (opt.lp) {
      const f = filt('lowpass', opt.lp, opt.q || 1); o.connect(f); node = f;
      if (opt.lpTo) { f.frequency.setValueAtTime(opt.lp, t); f.frequency.exponentialRampToValueAtTime(opt.lpTo, t + dur); }
    }
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
    return a;
  }
  /* ノイズ（フィルターが動く・立ち上がりを付けられる版）。o：type・f・to・q・rate・attack・echo */
  function nz(t, dur, lvl, o) {
    const n = ctx.createBufferSource(); n.buffer = noiseBuf; if (o.rate) n.playbackRate.value = o.rate;
    const f = filt(o.type || 'bandpass', o.f, o.q || 1), a = g(0, seIn); n.connect(f); f.connect(a);
    if (o.to) { f.frequency.setValueAtTime(o.f, t); f.frequency.exponentialRampToValueAtTime(o.to, t + dur); }
    if (o.echo) a.connect(g(o.echo, delayIn));
    const at = o.attack || 0.002;
    a.gain.setValueAtTime(0, t); a.gain.linearRampToValueAtTime(lvl, t + at); a.gain.exponentialRampToValueAtTime(0.0006, t + dur);
    n.start(t, Math.random() * 2); n.stop(t + dur + 0.02);
    return a;
  }
  /* 金属が鳴る音（倍音がずれた三角波を重ねる） */
  function metal(t, f0, dur, lvl, ratios) {
    (ratios || [1, 1.48, 2.13]).forEach((r, i) => tone('triangle', f0 * r, t, dur * (1 - i * 0.2), lvl / (1 + i * 0.6)));
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
    /* 被弾・ミス（ミニゲーム） */
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
    /* パルスガン：高い音が下がる「ピュン」は使わない。低めの芯＋電気の「バチッ」＋短い反響 */
    shot(t) {
      nz(t, 0.025, 0.14, { f: 3200, q: 1.2 });
      tone('square', 196, t, 0.11, 0.08, { lp: 3600, lpTo: 400 });
      tone('sawtooth', 392, t, 0.07, 0.035, { lp: 5000, lpTo: 900, detune: 8 });
      tone('sine', 120, t, 0.12, 0.1, { to: 70, slide: 0.1 });
      nz(t + 0.004, 0.06, 0.035, { f: 1400, q: 3, echo: 0.12 });
    },
    /* ミナ・ソウの射撃（少し低く、控えめ） */
    shot2(t) {
      nz(t, 0.02, 0.07, { f: 2400, q: 1.2 });
      tone('square', 147, t, 0.09, 0.05, { lp: 2400, lpTo: 300 });
      tone('sine', 100, t, 0.1, 0.05, { to: 62, slide: 0.08 });
    },
    /* 弾切れ：乾いた「カチッ、カチッ」 */
    empty(t) {
      [0, 0.075].forEach((d, i) => {
        nz(t + d, 0.018, 0.18 - i * 0.05, { f: 3400, q: 5 });
        tone('triangle', 1250, t + d, 0.02, 0.04 - i * 0.012);
      });
      tone('square', 110, t, 0.03, 0.03, { lp: 700 });
    },
    /* 敵の弾：低くにごったブーン（高い音が下がる音は使わない） */
    eshot(t) {
      tone('sawtooth', 262, t, 0.12, 0.055, { lp: 1800, lpTo: 450, q: 3 });
      tone('sawtooth', 277, t, 0.12, 0.035, { lp: 1800, lpTo: 450 });
      nz(t, 0.02, 0.06, { f: 1800, q: 2 });
    },
    /* 敵に当たった：金属を打つ短い「カン」 */
    ehit(t) {
      nz(t, 0.035, 0.17, { f: 2800, q: 2.5 });
      metal(t, 1240, 0.1, 0.07);
      tone('sine', 180, t, 0.07, 0.08, { to: 120 });
    },
    /* 弱点に当たった：「カン」に、上がる2音を重ねる */
    weak(t) {
      nz(t, 0.05, 0.16, { f: 3400, q: 3 });
      metal(t, 1480, 0.12, 0.07);
      [84, 91].forEach((m, i) => tone('square', mtof(m), t + 0.02 + i * 0.045, 0.1, 0.045, { lp: 6000, echo: 0.15 }));
      tone('sine', 200, t, 0.08, 0.08, { to: 130 });
    },
    /* 敵が倒れた：低い爆発、金属の破片、機械の電源が落ちる低い音 */
    boom(t) {
      tone('sine', 110, t, 0.5, 0.15, { to: 36, slide: 0.42 });
      nz(t, 0.5, 0.15, { type: 'lowpass', f: 1400, to: 200, q: 0.8 });
      nz(t, 0.08, 0.12, { f: 2200, q: 1 });
      tone('sawtooth', 140, t + 0.03, 0.45, 0.05, { to: 48, slide: 0.4, lp: 700 });
      [0.07, 0.15, 0.26].forEach((d, i) => metal(t + d, 1500 + i * 420 + Math.random() * 200, 0.06, 0.03 - i * 0.006, [1, 1.53]));
    },
    /* 被弾（戦い）：鈍い衝撃と、体がきしむ低いにごり。ミニゲームの hit とは別 */
    hurt(t) {
      tone('sine', 160, t, 0.22, 0.13, { to: 55, slide: 0.18 });
      tone('square', 92, t, 0.2, 0.07, { lp: 900, lpTo: 200, detune: -12 });
      tone('square', 98, t, 0.2, 0.05, { lp: 900, lpTo: 200, detune: 14 });
      nz(t, 0.14, 0.14, { f: 1100, q: 1.2 });
      tone('triangle', 620, t + 0.12, 0.12, 0.025, { lp: 1600 });
    },
    /* 跳ぶ：軽く上がる音と、地面を蹴る音 */
    jump(t) {
      nz(t, 0.05, 0.1, { type: 'lowpass', f: 600, q: 0.8 });
      tone('triangle', 220, t, 0.12, 0.05, { to: 470, slide: 0.1 });
    },
    /* 着地：やわらかい「トッ」 */
    land(t) {
      tone('sine', 120, t, 0.12, 0.13, { to: 55, slide: 0.1 });
      nz(t, 0.09, 0.14, { type: 'lowpass', f: 500, q: 0.8 });
    },
    /* 回避：風を切る「シュッ」（音程は上がる方向だけ） */
    dodge(t) {
      nz(t, 0.2, 0.13, { f: 700, to: 2600, q: 1.4, attack: 0.05, rate: 1.4 });
      tone('sine', 300, t, 0.18, 0.03, { to: 520, slide: 0.16, attack: 0.04 });
    },
    /* 警報（区画が封鎖された）。戦いの曲の刻みに埋もれないよう、低い音を足した */
    alarm(t) {
      for (let i = 0; i < 3; i++) {
        tone('square', 880, t + i * 0.24, 0.12, 0.065, { lp: 2400 }); tone('square', 660, t + i * 0.24 + 0.12, 0.12, 0.065, { lp: 2400 });
        tone('sawtooth', 220, t + i * 0.24, 0.22, 0.04, { lp: 900 });
      }
    },
    /* 区画の封鎖：重いシャッターが落ちる「ドガン」、金属の響き、電気の錠がかかる2音 */
    lock(t) {
      tone('sine', 75, t, 0.6, 0.19, { to: 38, slide: 0.5 });
      nz(t, 0.28, 0.2, { type: 'lowpass', f: 900, to: 250, q: 0.8 });
      metal(t + 0.01, 196, 1.1, 0.06, [1, 1.51, 2.38]);
      tone('square', 55, t + 0.1, 0.5, 0.05, { lp: 300, attack: 0.08 });
      tone('square', 880, t + 0.5, 0.07, 0.04, { lp: 3000 });
      tone('square', 880, t + 0.62, 0.1, 0.04, { lp: 3000 });
    },
    /* 区画の解除：錠が外れる「ガチャン」、低いうなりが上がって、開いた合図の明るい和音 */
    unlock(t) {
      nz(t, 0.05, 0.18, { f: 1300, q: 2 });
      tone('sine', 100, t, 0.15, 0.14, { to: 60 });
      metal(t + 0.02, 330, 0.4, 0.05, [1, 1.51]);
      tone('sawtooth', 55, t + 0.08, 0.6, 0.05, { to: 110, slide: 0.5, lp: 500, attack: 0.1 });
      [64, 68, 71, 76].forEach((m, i) => tone('triangle', mtof(m + 12), t + 0.32 + i * 0.07, 0.6, 0.07, { echo: 0.3 }));
    },
    /* 番人の登場：地面を揺らす一撃、低く不穏な和音がふくらみ、目が開くように音が上がって、高い2音で止まる */
    warden(t) {
      tone('sine', 80, t, 0.9, 0.26, { to: 30, slide: 0.7 });
      nz(t, 0.35, 0.18, { type: 'lowpass', f: 700, to: 150, q: 0.8 });
      metal(t + 0.02, 155, 2.0, 0.06, [1, 1.47, 2.31, 3.07]);
      [36, 42, 48].forEach((m, i) => tone('sawtooth', mtof(m), t + 0.15, 2.3, 0.045, { lp: 260, lpTo: 900, attack: 1.0, detune: i * 5 - 5 }));
      tone('sine', mtof(36) / 2, t + 0.1, 2.4, 0.12, { attack: 0.8 });
      tone('triangle', 200, t + 0.9, 1.0, 0.04, { to: 800, slide: 0.95, attack: 0.5, lp: 2400 });
      tone('square', 1175, t + 1.95, 0.09, 0.035, { lp: 4000, echo: 0.35 });
      tone('square', 1175, t + 2.1, 0.2, 0.035, { lp: 4000, echo: 0.35 });
    },
    /* 攻撃の予兆（記憶バッファがあるときだけ） */
    warn(t) { tone('sine', 1760, t, 0.06, 0.03); },
    /* サイボーグの突進 */
    dash(t) { noise(t, 0.3, 0.1, 'bandpass', 900, 1.2, 0.7); tone('sawtooth', 160, t, 0.3, 0.05, { to: 480, slide: 0.25, lp: 1600 }); },
    /* 番人のレーザー：ためて上がり、太い光線がうなる（高い音が下がる音は使わない） */
    laser(t) {
      tone('sawtooth', 220, t, 0.22, 0.055, { to: 660, slide: 0.2, lp: 2600 });
      [330, 333.5].forEach(f => tone('sawtooth', f, t + 0.18, 0.42, 0.055, { lp: 2400, lpTo: 900, attack: 0.02 }));
      tone('sine', 110, t + 0.18, 0.42, 0.09, { attack: 0.02 });
    },
    /* ソウの一撃 */
    slash(t) { noise(t, 0.12, 0.12, 'highpass', 2000, 0.8, 1.4); metal(t + 0.02, 1700, 0.12, 0.025, [1, 1.41]); },
    /* ミナの手当て：やわらかい和音がふくらみ、上がっていく澄んだ音 */
    heal(t) {
      tone('triangle', mtof(60), t, 0.9, 0.05, { attack: 0.15 });
      tone('triangle', mtof(67), t, 0.9, 0.04, { attack: 0.15 });
      [72, 76, 79, 84].forEach((m, i) => tone('sine', mtof(m), t + 0.05 + i * 0.08, 0.5, 0.058, { echo: 0.3 }));
    },
    /* ミナが弾を渡す：弾倉を差し込む「カシャッ」「カチッ」と、短い確認音 */
    ammo(t) {
      nz(t, 0.04, 0.21, { f: 900, q: 3 }); tone('triangle', 300, t, 0.05, 0.07);
      nz(t + 0.09, 0.025, 0.21, { f: 2600, q: 5 }); metal(t + 0.09, 1500, 0.05, 0.04, [1, 1.33]);
      tone('square', 660, t + 0.17, 0.05, 0.045, { lp: 3000 }); tone('square', 990, t + 0.23, 0.08, 0.045, { lp: 3000 });
    },
    /* 手配書に赤いバツを書く音：ペンが紙に触れる「トッ」、紙をこする「キュッ」（紙のざらつきで細かく揺れる）。
       2本目の線は少しだけ高く、最後に少しかすれる */
    xmark(t) {
      const second = (xCount++ % 2) === 1, k = second ? 1.15 : 1, dur = 0.36;
      nz(t, 0.03, 0.12, { type: 'lowpass', f: 900, q: 0.8 });
      tone('sine', 190, t, 0.05, 0.06);
      const a = nz(t + 0.01, dur, 0.2, { f: 1300 * k, to: 2100 * k, q: 1.6, attack: 0.03, rate: 0.9 });
      const lfo = ctx.createOscillator(); lfo.type = 'triangle'; lfo.frequency.value = 33 + Math.random() * 8;
      const amt = g(0.07); lfo.connect(amt); amt.connect(a.gain); lfo.start(t); lfo.stop(t + dur + 0.05);
      nz(t + 0.02, dur * 0.9, 0.05, { type: 'highpass', f: 4500, q: 0.6, attack: 0.03 });
      tone('sine', 1150 * k, t + 0.04, dur * 0.8, 0.008, { to: 1300 * k, slide: dur * 0.8, attack: 0.08 });
      nz(t + dur - 0.04, 0.08, 0.06, { f: 2600 * k, q: 2 });
    },
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
    scan: [0.35, 1.1], implant: [0.35, 1.0], lift: [0.4, 1.6], honne: [0.55, 1.8], goal: [0.6, 0.5],
    shot: [0.75, 0.06], shot2: [0.85, 0.05], eshot: [0.85, 0.05], ehit: [0.8, 0.06], weak: [0.7, 0.1],
    boom: [0.55, 0.3], hurt: [0.5, 0.18], jump: [0.85, 0.05], land: [0.8, 0.06], dodge: [0.75, 0.1],
    empty: [0.75, 0.08], heal: [0.5, 0.5], ammo: [0.6, 0.25], warn: [0.85, 0.05],
    dash: [0.7, 0.2], laser: [0.6, 0.45], slash: [0.75, 0.08],
    alarm: [0.5, 0.7], lock: [0.35, 0.8], unlock: [0.45, 0.8], warden: [0.25, 2.2],
    xmark: [1, 0.1], allow: [0.4, 0.8], deny: [0.4, 0.6]
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
    init, start, stop, se, setBrightness, setLayer, setCyber, setMood, setVolume, setMuted, SE_NAMES, MOODS,
    isPlaying: () => st.playing,
    analyser: () => an,
    context: () => ctx,
    state: () => Object.assign({}, st)
  };
})(typeof window !== 'undefined' ? window : globalThis);
