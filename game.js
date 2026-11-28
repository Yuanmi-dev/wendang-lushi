/* 穩當路試 — 固定 60 tick 的側視路試。物理用本地打包的 planck.js（Box2D / MIT）。 */
(function () {
  "use strict";
  const pl = window.planck;
  if (!pl) throw new Error("planck.js 未載入");

  const CFG = {
    TICK: 1 / 60,
    VEL_IT: 8,
    POS_IT: 3,
    GRAVITY: 9.81,
    // 車
    WHEEL_R: 0.28,
    WHEEL_Y: -0.30,        // 輪心相對底盤，讓車身蓋住大部分輪胎
    MOTOR_SPEED: 52,       // rad/s；與舊 38×0.38 維持相近線速度
    TORQUE_REAR: 11.8,     // 力矩隨半徑縮小，維持相近驅動力
    TORQUE_FRONT: 10.3,
    BRAKE_TORQUE: 20.6,
    COAST_TORQUE: 1.6,     // 無輸入時的引擎煞車／滾動阻力；陡坡仍可緩緩下滑
    STOP_VX: 0.28,         // 視為停穩的水平速度
    REVERSE_HOLD_S: 0.6,   // 停穩後持續按住煞車，超過此時長才進入倒車
    PEDAL_TOUCH: 0.25,     // 按下當下的力度
    PEDAL_RAMP_UP: 0.6,    // 由輕踩加到滿力的時間（秒）
    PEDAL_RAMP_DOWN: 0.1,  // 放開後收到 0 的時間（秒）
    PEDAL_SEGS: 4,
    SPRING_HZ: 4.2,
    SPRING_ZETA: 0.72,
    BREAK_WHEEL: 280,
    BREAK_WHEEL_IMPACT: 95, // 輪子只在撞擊衝量過大時脫落，不用懸吊反力       // 輪軸反力超過此值（N，已乘 inv_dt 尺度）則脫落
    BREAK_PART: 200,
    BREAK_CARGO: 55,
    BREAK_PLANK: 55,
    KILL_Y: -8,
    GOAL_HOLD: 0.45,
    COUNTDOWN_S: 3,
    // 廣告（與白雞跳跳相同策略：預設關閉、無 publisher id、可測試）
    ADS_ENABLED: false,
    ADS_TEST_MODE: true,
    ADS_CLIENT: "",
    ADS_INTERSTITIAL_EVERY: 3,
    ADS_FAKE_MS: 1400
  };

  function spawnLift() {
    return -CFG.WHEEL_Y + CFG.WHEEL_R + 0.12;
  }

  // concept-03 精靈：車身朝右，單位為公尺；inBody 裡 y 朝上
  const SPRITE = {
    mPerPx: 0.0026923076923076926,
    body: { src: "assets/car-body.webp", w: 1124, h: 433, ox: -1.462076923076923, oy: 0.6868461538461538 },
    wheel: { src: "assets/car-wheel.webp", w: 220, h: 220 },
    roof: {
      src: "assets/car-roof.webp", w: 412, h: 52,
      ox: -0.8266923076923076, oy: 0.6706923076923077,
      cx: -0.2720769230769229, cy: 0.6006923076923077
    }
  };
  const spriteImgs = { body: new Image(), wheel: new Image(), roof: new Image() };
  let spritesReady = false;
  (function preloadSprites() {
    const keys = ["body", "wheel", "roof"];
    let left = keys.length;
    function tick() {
      left -= 1;
      if (left <= 0) spritesReady = true;
    }
    keys.forEach(function (k) {
      spriteImgs[k].onload = tick;
      spriteImgs[k].onerror = tick;
      spriteImgs[k].src = SPRITE[k].src;
    });
  })();
  function spriteOk(img) {
    if (!img) return false;
    if (img.tagName === "CANVAS") return img.width > 0 && img.height > 0;
    return !!(img.complete && img.naturalWidth > 0);
  }
  function drawSpriteYUp(img, x, y, wPx, hPx) {
    // inBody 後座標 y 朝上；用 scale 翻轉影像，避免 drawImage 負高度再翻一次
    const s = SPRITE.mPerPx;
    ctx.imageSmoothingEnabled = true;
    if (ctx.imageSmoothingQuality) ctx.imageSmoothingQuality = "high";
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, -s);
    ctx.drawImage(img, 0, 0, wPx, hPx);
    ctx.restore();
  }

  const URL_PARAMS = new URLSearchParams((location.search || "").replace(/^\?/, ""));
  const DEBUG = URL_PARAMS.get("debug") === "1";
  const PROMO = URL_PARAMS.get("promo") === "1";
  if (PROMO) document.documentElement.classList.add("promo");
  const FAKE_AD = URL_PARAMS.get("fakead") === "1";
  const ADS_FORCE = (URL_PARAMS.get("ads") || "").toLowerCase().trim();
  const START_LEVEL = parseInt(URL_PARAMS.get("level") || "", 10);
  const AUTO_BOT = URL_PARAMS.get("bot") === "1";

  const STORE_KEY = "wendangLushi.v1";
  const CAT = { GROUND: 0x0001, CAR: 0x0002, CARGO: 0x0004, PROP: 0x0008 };

  const palette = {
    skyTop: "#6ea7d8",
    skyMid: "#f3c07a",
    skyHorizon: "#f6d09a",
    dirt: "#c48a4a",
    dirtDark: "#8a5a2e",
    dirtDeep: "#3a1e10",
    grass: "#5e8a32",
    grassLite: "#9cc456",
    ink: "#2b241c",
    paper: "#fbf6ee",
    teal: "#1f7a6f",
    tealLight: "#3aa89b",
    roof: "#f4f1ea",
    wheel: "#1a1a1d",
    hub: "#9aa0aa",
    wood: "#c9a06a",
    pot: "#c45c36",
    rust: "#a3452f",
    flag: "#1f7a6f"
  };

  // ---------- 存檔 ----------
  function loadStore() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
      return {
        stars: s.stars || {},
        bestTime: s.bestTime || {},
        unlocked: s.unlocked || 1,
        muted: !!s.muted
      };
    } catch (e) {
      return { stars: {}, bestTime: {}, unlocked: 1, muted: false };
    }
  }
  function saveStore() {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  }
  let store = loadStore();

  const bgImgs = { sky: new Image(), far: new Image(), mid: new Image(), near: new Image() };
  ["sky", "far", "mid"].forEach(function (k) { bgImgs[k].src = "assets/bg/" + k + ".webp"; });
  const propImgs = { tree: new Image(), pine: new Image(), bush: new Image(), fence: new Image(), lamp: new Image(), sign: new Image() };
  Object.keys(propImgs).forEach(function (k) { propImgs[k].src = "assets/props/" + k + ".webp"; });

  const AUDIO_FILES = {
    engine: "assets/audio/engine",
    brake: "assets/audio/brake",
    crash: "assets/audio/crash",
    land: "assets/audio/land",
    fanfare: "assets/audio/fanfare",
    tap: "assets/audio/tap",
    bgm: "assets/audio/bgm"
  };
  const VOL_SFX = 0.32, VOL_BGM = 0.14;
  const audio = {
    ctx: null, master: null, sfxG: null, bgmG: null,
    bufs: {}, unlocked: false, bgmNode: null, engNode: null, engGain: null,
    lastSkidAt: 0, lastLandAt: 0, wasAir: false
  };
  function audioMuted() { return !!(store.muted || adsSoundMuted); }
  function applyAudioMute() {
    if (!audio.master || !audio.ctx) return;
    const on = audio.unlocked && !audioMuted();
    audio.master.gain.setTargetAtTime(on ? 1 : 0, audio.ctx.currentTime, 0.03);
  }
  function syncMuteBtn() {
    const btn = document.getElementById("btnMute");
    if (!btn) return;
    btn.setAttribute("aria-pressed", store.muted ? "false" : "true");
    btn.textContent = store.muted ? "聲音 關" : "聲音 開";
  }
  function setMuted(on) {
    store.muted = !!on;
    saveStore();
    applyAudioMute();
    syncMuteBtn();
  }
  function syncPauseBtn() {
    const btn = document.getElementById("btnPause");
    if (!btn) return;
    const show = st === "play" || st === "countdown" || st === "pause";
    btn.hidden = !show;
  }
  function preloadAudioBuf(base, key) {
    const urls = [base + ".mp3", base + ".ogg"];
    function tryAt(i) {
      if (i >= urls.length || !audio.ctx) return;
      fetch(urls[i]).then(function (r) { return r.ok ? r.arrayBuffer() : Promise.reject(); })
        .then(function (ab) { return audio.ctx.decodeAudioData(ab.slice(0)); })
        .then(function (buf) {
          audio.bufs[key] = buf;
          if (key === "bgm") startBgm();
          if (key === "engine") ensureEngine();
        })
        .catch(function () { tryAt(i + 1); });
    }
    tryAt(0);
  }
  function unlockAudio() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!audio.ctx) {
        audio.ctx = new AC();
        audio.master = audio.ctx.createGain();
        audio.sfxG = audio.ctx.createGain();
        audio.bgmG = audio.ctx.createGain();
        audio.sfxG.gain.value = VOL_SFX;
        audio.bgmG.gain.value = VOL_BGM;
        audio.sfxG.connect(audio.master);
        audio.bgmG.connect(audio.master);
        audio.master.connect(audio.ctx.destination);
        audio.master.gain.value = 0;
        Object.keys(AUDIO_FILES).forEach(function (k) { preloadAudioBuf(AUDIO_FILES[k], k); });
      }
      if (audio.ctx.state === "suspended") audio.ctx.resume();
      audio.unlocked = true;
      applyAudioMute();
      startBgm();
    } catch (e) {}
  }
  function playSfx(key, opts) {
    opts = opts || {};
    if (!audio.ctx || !audio.unlocked || audioMuted()) return null;
    const buf = audio.bufs[key];
    if (!buf) return null;
    const src = audio.ctx.createBufferSource();
    src.buffer = buf;
    if (opts.rate) src.playbackRate.value = opts.rate;
    const g = audio.ctx.createGain();
    g.gain.value = opts.vol != null ? opts.vol : 1;
    src.connect(g);
    g.connect(audio.sfxG);
    try { src.start(); } catch (e) { return null; }
    return src;
  }
  function startBgm() {
    if (!audio.ctx || !audio.unlocked || audio.bgmNode || !audio.bufs.bgm) return;
    const src = audio.ctx.createBufferSource();
    src.buffer = audio.bufs.bgm;
    src.loop = true;
    src.connect(audio.bgmG);
    try { src.start(); } catch (e) { return; }
    audio.bgmNode = src;
  }
  function ensureEngine() {
    if (audio.engNode || !audio.bufs.engine || !audio.ctx || !audio.unlocked) return;
    const src = audio.ctx.createBufferSource();
    src.buffer = audio.bufs.engine;
    src.loop = true;
    const g = audio.ctx.createGain();
    g.gain.value = 0;
    src.connect(g);
    g.connect(audio.sfxG);
    try { src.start(); } catch (e) { return; }
    audio.engNode = src;
    audio.engGain = g;
  }
  function updateEngine(strength, playing) {
    if (!audio.ctx || !audio.unlocked) return;
    ensureEngine();
    if (!audio.engGain || !audio.engNode) return;
    const t = audio.ctx.currentTime;
    const on = playing && strength > 0.02 && !audioMuted();
    const vol = on ? (0.08 + 0.55 * strength) : 0;
    const rate = 0.78 + 0.55 * Math.max(0, strength);
    try {
      audio.engGain.gain.setTargetAtTime(vol, t, 0.06);
      audio.engNode.playbackRate.setTargetAtTime(rate, t, 0.08);
    } catch (e) {}
  }
  function tickGameAudio() {
    const playing = st === "play" && !!car && !adsPaused && !botMode;
    const gas = playing && car ? (car.gas || 0) : 0;
    updateEngine(gas, playing);
  }
  function tickImpactAudio() {
    if (st !== "play" || !car) return;
    const wr = car.rear && car.rear.body ? car.rear.body.getPosition() : null;
    const wf = car.front && car.front.body ? car.front.body.getPosition() : null;
    if (!wr || !wf) return;
    const wrL = car.chassis.getLocalPoint(wr);
    const wfL = car.chassis.getLocalPoint(wf);
    const droop = Math.min(wrL.y, wfL.y);
    const air = droop < -0.50;
    const vy = car.chassis.getLinearVelocity().y;
    if (audio.wasAir && !air && vy < -1.2 && tRun - (audio.lastLandAt || 0) > 0.28) {
      audio.lastLandAt = tRun;
      spawnLandPuff(vy);
      if (vy < -3.0) addShake(Math.min(0.42, (-vy - 3) * 0.08));
      if (!botMode) playSfx("land", { vol: Math.min(1, 0.4 + Math.abs(vy) * 0.12) });
    }
    audio.wasAir = air;
    const vx = car.chassis.getLinearVelocity().x;
    if ((car.brake || 0) > 0.35 && Math.abs(vx) > 3 && tRun - (audio.lastSkidAt || 0) > 0.7) {
      audio.lastSkidAt = tRun;
      if (!botMode) playSfx("brake", { vol: Math.min(1, 0.35 + car.brake * 0.4) });
    }
  }

  // ---------- 廣告包裝 ----------
  let adsPaused = false, adsSoundMuted = false, adCompletedRuns = 0;
  let pendingShowAdFn = null, rewardGranted = false, lastPlacementInfo = null, fakeAdTimer = 0;
  let continueUsed = false, adContinueOffered = false;

  function adsWanted() {
    if (ADS_FORCE === "0" || ADS_FORCE === "off" || ADS_FORCE === "false") return false;
    if (FAKE_AD || ADS_FORCE === "1" || ADS_FORCE === "on") return true;
    return !!CFG.ADS_ENABLED;
  }
  function adsUseGoogle() { return adsWanted() && !FAKE_AD; }
  function hideContinueBtn() {
    adContinueOffered = false;
    const btn = document.getElementById("adContinueBtn");
    if (btn) btn.classList.remove("visible");
  }
  function showContinueBtn() {
    adContinueOffered = true;
    const btn = document.getElementById("adContinueBtn");
    if (btn) btn.classList.add("visible");
  }
  function pauseForAd() {
    adsPaused = true;
    adsSoundMuted = true;
    applyAudioMute();
  }
  function resumeAfterAd() {
    adsPaused = false;
    adsSoundMuted = false;
    hideFakeAd();
    applyAudioMute();
  }
  function hideFakeAd() {
    if (fakeAdTimer) { clearTimeout(fakeAdTimer); fakeAdTimer = 0; }
    const el = document.getElementById("adFake");
    if (el) el.classList.remove("visible");
  }
  function showFakeAd(kind) {
    const el = document.getElementById("adFake");
    const title = document.getElementById("adFakeTitle");
    const view = document.getElementById("adFakeView");
    const skip = document.getElementById("adFakeSkip");
    const close = document.getElementById("adFakeClose");
    if (title) title.textContent = kind === "reward" ? "測試廣告（再試一次）" : "測試廣告（關卡之間）";
    if (view) view.hidden = kind !== "reward";
    if (skip) skip.hidden = kind !== "reward";
    if (close) close.hidden = kind === "reward";
    if (el) el.classList.add("visible");
  }
  function placementInfo(opts, status) {
    return {
      breakType: opts.type,
      breakName: opts.name || "",
      breakFormat: opts.type === "reward" ? "reward" : "interstitial",
      breakStatus: status
    };
  }
  function finishAdBreak(opts, status) {
    const info = placementInfo(opts, status);
    lastPlacementInfo = info;
    if (typeof opts.adBreakDone === "function") {
      try { opts.adBreakDone(info); } catch (e) { console.warn("[ads]", e); }
    }
  }
  function runFakeAd(opts) {
    if (opts.type === "reward") {
      if (typeof opts.beforeReward !== "function") { finishAdBreak(opts, "other"); return; }
      opts.beforeReward(function showAdFn() {
        pauseForAd();
        if (opts.beforeAd) opts.beforeAd();
        showFakeAd("reward");
        const view = document.getElementById("adFakeView");
        const skip = document.getElementById("adFakeSkip");
        function done(viewed) {
          hideFakeAd();
          if (viewed) { if (opts.adViewed) opts.adViewed(); }
          else if (opts.adDismissed) opts.adDismissed();
          if (opts.afterAd) opts.afterAd();
          finishAdBreak(opts, viewed ? "viewed" : "dismissed");
        }
        if (view) view.onclick = function (ev) { ev.preventDefault(); ev.stopPropagation(); done(true); };
        if (skip) skip.onclick = function (ev) { ev.preventDefault(); ev.stopPropagation(); done(false); };
      });
      return;
    }
    pauseForAd();
    if (opts.beforeAd) opts.beforeAd();
    showFakeAd("next");
    const minMs = Math.max(400, CFG.ADS_FAKE_MS || 1400);
    const opened = Date.now();
    function closeNext() {
      if (Date.now() - opened < minMs - 20) {
        fakeAdTimer = setTimeout(closeNext, minMs - (Date.now() - opened));
        return;
      }
      hideFakeAd();
      if (opts.afterAd) opts.afterAd();
      finishAdBreak(opts, "viewed");
    }
    const close = document.getElementById("adFakeClose");
    if (close) close.onclick = function (ev) { ev.preventDefault(); ev.stopPropagation(); closeNext(); };
    fakeAdTimer = setTimeout(closeNext, minMs);
  }
  function safeAdBreak(opts) {
    opts = opts || {};
    if (!adsWanted()) { finishAdBreak(opts, "ignored"); return; }
    if (FAKE_AD) { runFakeAd(opts); return; }
    const fn = window.adBreak;
    if (typeof fn !== "function") { finishAdBreak(opts, "notReady"); return; }
    try {
      fn({
        type: opts.type, name: opts.name,
        beforeAd: opts.beforeAd, afterAd: opts.afterAd,
        beforeReward: opts.beforeReward, adDismissed: opts.adDismissed, adViewed: opts.adViewed,
        adBreakDone: function (info) {
          lastPlacementInfo = info || placementInfo(opts, "other");
          if (opts.adBreakDone) opts.adBreakDone(lastPlacementInfo);
        }
      });
    } catch (e) {
      console.warn("[ads]", e);
      finishAdBreak(opts, "error");
    }
  }
  function installAdsTag() {
    if (window.__WENDANG_ADS_TAG__ || !adsUseGoogle()) return;
    window.adsbygoogle = window.adsbygoogle || [];
    window.adBreak = window.adConfig = function (o) { window.adsbygoogle.push(o); };
    const s = document.createElement("script");
    s.async = true;
    const client = (CFG.ADS_CLIENT || "").trim();
    s.src = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js" +
      (client ? ("?client=" + encodeURIComponent(client)) : "");
    if (client) s.setAttribute("data-ad-client", client);
    if (CFG.ADS_TEST_MODE || !client) s.setAttribute("data-adbreak-test", "on");
    s.crossOrigin = "anonymous";
    document.head.appendChild(s);
    window.__WENDANG_ADS_TAG__ = true;
    try { window.adConfig({ preloadAdBreaks: "on", sound: "off", onReady: function () {} }); } catch (e) {}
  }

  // ---------- 關卡建構 ----------
  const fdGround = { density: 0, friction: 0.75, filterCategoryBits: CAT.GROUND, filterMaskBits: 0xffff };
  const fdProp = { density: 0.8, friction: 0.7, filterCategoryBits: CAT.PROP, filterMaskBits: 0xffff };

  function makeBuilder(world) {
    let x = 0, y = 0;
    const pts = [];
    const props = [];
    const paths = [];
    let spawn = { x: 2.2, y: spawnLift() };
    let goal = { x: 20, y: 0, w: 3.2, h: 3.2 };
    let killY = CFG.KILL_Y;
    const groundBody = world.createBody({ type: "static" });

    function push(nx, ny) {
      if (!pts.length) pts.push({ x: x, y: y });
      pts.push({ x: nx, y: ny });
      x = nx; y = ny;
    }
    function flush() {
      if (pts.length >= 2) {
        paths.push(pts.map(function (p) { return { x: p.x, y: p.y }; }));
        const shape = pts.length > 2 ? new pl.Chain(pts, false) : new pl.Edge(pts[0], pts[1]);
        const fx = groundBody.createFixture({ shape: shape, ...fdGround });
        fx.setUserData({ kind: "ground" });
      }
      pts.length = 0;
    }
    const api = {
      get x() { return x; },
      get y() { return y; },
      spawnAt(sx, sy) { spawn = { x: sx, y: sy == null ? y + spawnLift() : sy }; return api; },
      pad(len) {
        const s = x;
        push(x + (len == null ? 10 : len), y);
        spawn = { x: s + 2.2, y: y + spawnLift() };
        return api;
      },
      flat(len) { push(x + len, y); return api; },
      slope(len, dy) { push(x + len, y + dy); return api; },
      bump(w, h) {
        const w2 = w * 0.5;
        push(x + w2 * 0.6, y + h);
        push(x + w2 * 1.4, y + h);
        push(x + w, y);
        return api;
      },
      gap(w) { flush(); x += w; return api; },
      jump(gapW, h) {
        const H = h == null ? 0.5 : h;
        const take = 3.0;
        const baseY = y;
        push(x + take, baseY + H);
        flush();
        x += (gapW == null ? 1.8 : gapW);
        // 落地略低再爬回平台高度，避免卡在棱角或回落到缺口
        const landY = baseY + H;
        pts.push({ x: x, y: landY - 0.14 });
        pts.push({ x: x + 1.4, y: landY });
        pts.push({ x: x + 2.8, y: landY });
        x = x + 2.8; y = landY;
        return api;
      },
      drop(dy) { y += dy; return api; },
      seesaw(len, thick) {
        flush();
        const L = len || 7, tck = thick || 0.2;
        // 板心貼齊路面，前端落差約一個板厚，讓低底盤也能開上去
        const cx = x + L * 0.5, cy = y;
        const board = world.createBody({ type: "dynamic", position: { x: cx, y: cy } });
        const fx = board.createFixture({ shape: new pl.Box(L * 0.5, tck), density: 0.9, friction: 0.85, filterCategoryBits: CAT.PROP, filterMaskBits: 0xffff });
        fx.setUserData({ kind: "seesaw" });
        const j = world.createJoint(new pl.RevoluteJoint({
          lowerAngle: (-10 * Math.PI) / 180,
          upperAngle: (10 * Math.PI) / 180,
          enableLimit: true
        }, groundBody, board, { x: cx, y: cy }));
        props.push({ kind: "seesaw", body: board, joint: j });
        // 板端後方緩坡承接，落差小以免撞擊拆輪
        x += L + 0.2;
        pts.push({ x: x, y: y - 0.28 });
        pts.push({ x: x + 4.0, y: y });
        x = x + 4.0;
        return api;
      },
      bridge(n, seg) {
        flush();
        const s = seg || 1.15, count = n || 10;
        const yb = y - 0.05;
        let prev = groundBody;
        let i;
        for (i = 0; i < count; i++) {
          const bx = x + s * i + s * 0.5;
          const b = world.createBody({ type: "dynamic", position: { x: bx, y: yb } });
          const fx = b.createFixture({ shape: new pl.Box(s * 0.5, 0.11), density: 0.7, friction: 0.7, filterCategoryBits: CAT.PROP, filterMaskBits: 0xffff });
          fx.setUserData({ kind: "bridge" });
          world.createJoint(new pl.RevoluteJoint({}, prev, b, { x: x + s * i, y: yb }));
          prev = b;
          props.push({ kind: "bridge", body: b });
        }
        world.createJoint(new pl.RevoluteJoint({}, prev, groundBody, { x: x + s * count, y: yb }));
        x += s * count;
        return api;
      },
      planks(n, w) {
        flush();
        const count = n || 5, pw = w || 1.4;
        for (let i = 0; i < count; i++) {
          const px = x + i * (pw + 0.08) + pw * 0.5;
          const b = world.createBody({ type: "dynamic", position: { x: px, y: y + 0.1 } });
          const fx = b.createFixture({
            shape: new pl.Box(pw * 0.5, 0.1),
            density: 0.35, friction: 0.8,
            filterCategoryBits: CAT.PROP, filterMaskBits: 0xffff
          });
          fx.setUserData({ kind: "plank", breakImpulse: CFG.BREAK_PLANK });
          const j = world.createJoint(new pl.WeldJoint({ frequencyHz: 0, dampingRatio: 0 }, groundBody, b, { x: px, y: y }));
          props.push({ kind: "plank", body: b, joint: j, breakForce: CFG.BREAK_PLANK });
        }
        x += count * (pw + 0.08);
        return api;
      },
      // 餘弦凹槽：兩端斜率為 0，可與平地平滑銜接
      bowl(w, d) {
        const W = w == null ? 10 : w;
        const D = d == null ? 2.0 : d;
        const x0 = x, y0 = y, n = 24;
        for (let i = 1; i <= n; i++) {
          const u = i / n;
          push(x0 + W * u, y0 - D * 0.5 * (1 - Math.cos(Math.PI * 2 * u)));
        }
        killY = Math.min(killY, y0 - D - 5);
        return api;
      },
      // 餘弦圓丘：同樣兩端水平，避免半圓在地面垂直擋住
      ring(w, h) {
        const W = w == null ? 12 : w;
        const H = h == null ? 2.8 : h;
        const x0 = x, y0 = y, n = 28;
        for (let i = 1; i <= n; i++) {
          const u = i / n;
          push(x0 + W * u, y0 + H * 0.5 * (1 - Math.cos(Math.PI * 2 * u)));
        }
        return api;
      },
      loop(w, h) { return api.ring(w, h); },
      boxes(n, atX) {
        const c = n || 3;
        const bx = atX == null ? x - 1 : atX;
        for (let i = 0; i < c; i++) {
          const b = world.createBody({ type: "dynamic", position: { x: bx, y: y + 0.5 + i } });
          const fx = b.createFixture({ shape: new pl.Box(0.45, 0.45), density: 0.4, friction: 0.5, filterCategoryBits: CAT.PROP, filterMaskBits: 0xffff });
          fx.setUserData({ kind: "crate" });
          props.push({ kind: "crate", body: b });
        }
        return api;
      },
      wall(h) {
        flush();
        const fx = groundBody.createFixture({
          shape: new pl.Box(0.25, (h || 2) * 0.5, { x: x, y: y + (h || 2) * 0.5 }, 0),
          ...fdGround
        });
        fx.setUserData({ kind: "wall" });
        return api;
      },
      goal(pad) {
        const p = pad == null ? 8 : pad;
        const gx = x + 2.2;
        push(x + p, y);
        goal = { x: gx, y: y, w: 3.4, h: 3.4 };
        killY = Math.min(killY, y - 6);
        flush();
        // 終點後的擋土，避免飛出世界
        const end = groundBody.createFixture({
          shape: new pl.Box(0.3, 4, { x: x + 0.2, y: y + 4 }, 0),
          ...fdGround
        });
        end.setUserData({ kind: "endwall" });
        return api;
      },
      finish() { flush(); return { spawn: spawn, goal: goal, killY: killY, ground: groundBody, props: props, paths: paths, endX: x, endY: y }; }
    };
    return api;
  }

  const LEVELS = [
    {
      id: 1, name: "場地熱身", hint: "輕踩油門，到旗門前緩緩煞車。",
      par3: 15, par2: 22, cargo: false,
      bot: [{ x: 0, v: 4.2 }, { x: 8, v: 5.5 }, { x: 18, v: 3.2 }, { x: 24, v: 1.2 }],
      build: function (b) { b.pad(8).flat(18).goal(8); }
    },
    {
      id: 2, name: "緩坡來回", hint: "上坡多給一點油，下坡先收。",
      par3: 15, par2: 22, cargo: false,
      bot: [{ x: 0, v: 5 }, { x: 10, v: 7 }, { x: 22, v: 5 }, { x: 34, v: 6.5 }, { x: 46, v: 2 }],
      build: function (b) {
        b.pad(8).slope(8, 2.2).flat(4).slope(8, -2.2).flat(5).slope(6, 1.4).slope(6, -1.4).flat(4).goal(8);
      }
    },
    {
      id: 3, name: "小缺口", hint: "缺口前穩穩加速，落地再收油。",
      par3: 11, par2: 18, cargo: false,
      bot: [{ x: 0, v: 5 }, { x: 10, v: 7.4 }, { x: 16, v: 7.8 }, { x: 24, v: 4 }, { x: 32, v: 2 }],
      build: function (b) { b.pad(8).flat(6).jump(2.2, 0.65).flat(12).goal(8); }
    },
    {
      id: 4, name: "獨木晃板", hint: "上蹺板時少踩油門，讓板自己轉。",
      par3: 14, par2: 22, cargo: false,
      bot: [{ x: 0, v: 4.2 }, { x: 10, v: 3.8 }, { x: 14, v: 3.3 }, { x: 20, v: 3.5 }, { x: 28, v: 4 }, { x: 34, v: 2 }],
      build: function (b) { b.pad(8).flat(4).seesaw(7).flat(10).goal(8); }
    },
    {
      id: 5, name: "陡坡別翻", hint: "爬坡要持續給油，但別一開始就踩死，免得後輪翹起。",
      par3: 15, par2: 22, cargo: false,
      bot: [{ x: 0, v: 5 }, { x: 8, v: 7 }, { x: 16, v: 8 }, { x: 26, v: 6 }, { x: 32, v: 4.2 }, { x: 46, v: 3.8 }, { x: 56, v: 2 }],
      build: function (b) {
        b.pad(8).flat(4).slope(14, 4.2).flat(6).slope(14, -2.6).flat(6).goal(8);
      }
    },
    {
      id: 6, name: "細橋慢過", hint: "木橋會搖，保持中等車速，不要在橋上急煞。",
      par3: 13, par2: 20, cargo: false,
      bot: [{ x: 0, v: 4.2 }, { x: 8, v: 4.8 }, { x: 14, v: 4.4 }, { x: 28, v: 4.6 }, { x: 36, v: 2 }],
      build: function (b) { b.pad(8).flat(4).bridge(14, 1.15).flat(8).goal(8); }
    },
    {
      id: 7, name: "陶罐要穩", hint: "車斗裡有陶罐，顛簸或重刹都可能摔碎。慢即是快。",
      par3: 32, par2: 42, cargo: true,
      bot: [{ x: 0, v: 3.6 }, { x: 8, v: 4.2 }, { x: 16, v: 3.8 }, { x: 24, v: 4.5 }, { x: 34, v: 3.2 }, { x: 42, v: 1.6 }],
      build: function (b) {
        b.pad(8).flat(6).bump(5, 0.7).flat(5).slope(6, 1.1).slope(6, -1.1).flat(6).bump(4, 0.45).flat(6).goal(8);
      }
    },
    {
      id: 8, name: "連續跳台", hint: "每個缺口前加速，落地先鬆開油門再準備下一次。",
      par3: 13, par2: 20, cargo: false,
      bot: [
        { x: 0, v: 5 }, { x: 10, v: 7.2 }, { x: 16, v: 7.6 }, { x: 24, v: 6.8 },
        { x: 30, v: 7.6 }, { x: 38, v: 6.8 }, { x: 44, v: 7.6 }, { x: 56, v: 3 }
      ],
      build: function (b) {
        b.pad(8).flat(5).jump(1.7, 0.48).flat(5).jump(1.8, 0.5).flat(5).jump(1.8, 0.52).flat(10).goal(8);
      }
    },
    {
      id: 9, name: "環形坡道", hint: "先過環形凹槽再爬圓丘，坡頂別猛加油免得翹輪。",
      par3: 15, par2: 24, cargo: false,
      bot: [
        { x: 0, v: 4.8 }, { x: 12, v: 6 }, { x: 22, v: 6.2 }, { x: 32, v: 5.8 },
        { x: 42, v: 7.2 }, { x: 54, v: 6.2 }, { x: 68, v: 3.5 }, { x: 80, v: 2 }
      ],
      build: function (b) { b.pad(10).flat(8).bowl(14, 1.3).flat(6).ring(16, 2.2).flat(10).goal(8); }
    },
    {
      id: 10, name: "脆弱棧道", hint: "木板承受不了重擊。慢慢開過去，墜下去就得重來。",
      par3: 13, par2: 20, cargo: false,
      bot: [{ x: 0, v: 3.8 }, { x: 8, v: 3.4 }, { x: 16, v: 3.2 }, { x: 26, v: 3.4 }, { x: 34, v: 2 }],
      build: function (b) { b.pad(8).flat(3).planks(8, 1.45).flat(8).goal(8); }
    },
    {
      id: 11, name: "連串蹺板", hint: "連續蹺板像走路，一張一張過，不要加速衝。",
      par3: 20, par2: 30, cargo: false,
      bot: [
        { x: 0, v: 3.8 }, { x: 10, v: 3.4 }, { x: 20, v: 4.4 }, { x: 26, v: 4.2 }, { x: 32, v: 3.6 },
        { x: 44, v: 3.3 }, { x: 56, v: 3.6 }, { x: 66, v: 5.0 }, { x: 76, v: 2 }
      ],
      build: function (b) {
        b.pad(8).flat(4).seesaw(6).flat(5).seesaw(6).flat(12).goal(8);
      }
    },
    {
      id: 12, name: "收工路試", hint: "綜合考試：坡、橋、缺口、貨物。零件要在、陶罐盡量保住。",
      par3: 23, par2: 34, cargo: true,
      bot: [
        { x: 0, v: 4.5 }, { x: 10, v: 6.5 }, { x: 20, v: 5 }, { x: 30, v: 4.2 },
        { x: 42, v: 4.6 }, { x: 52, v: 7.8 }, { x: 62, v: 5 }, { x: 72, v: 2.2 }
      ],
      build: function (b) {
        b.pad(8).flat(4).slope(8, 2.6).flat(3).slope(6, -2.0).flat(3).bridge(8, 1.1).flat(4)
          .jump(2.1, 0.65).flat(8).bump(5, 0.5).flat(6).goal(8);
      }
    }
  ];

  function levelById(id) {
    return LEVELS.find(function (L) { return L.id === id; }) || LEVELS[0];
  }

  // ---------- 車輛 ----------
  function filterCar() {
    return { groupIndex: -1, categoryBits: CAT.CAR, maskBits: CAT.GROUND | CAT.PROP };
  }
  function filterCargo() {
    return { groupIndex: 0, categoryBits: CAT.CARGO, maskBits: CAT.GROUND | CAT.PROP | CAT.CARGO };
  }

  function createCar(world, x, y, withCargo) {
    // 碰撞外形貼齊 concept-03 精靈輪廓（凸包，最多 8 點）
    const chassisVerts = [
      { x: 0.0295, y: -0.3378 }, { x: 1.4295, y: -0.3324 }, { x: 1.5345, y: -0.1616 },
      { x: 1.4295, y: 0.0861 }, { x: 0.2125, y: 0.4657 }, { x: -0.2559, y: 0.5599 },
      { x: -1.3625, y: 0.2934 }, { x: -1.3732, y: -0.2678 }
    ];
    const chassis = world.createBody({ type: "dynamic", position: { x: x, y: y }, angularDamping: 0.15 });
    const fxC = chassis.createFixture({
      shape: new pl.Polygon(chassisVerts),
      density: 1.15, friction: 0.35, filter: filterCar()
    });
    fxC.setUserData({ kind: "chassis", color: palette.teal });
    // 車頭配重，避免一給油就翹成直立（接近真實前軸荷重）
    const fxB = chassis.createFixture({
      shape: new pl.Box(0.28, 0.12, { x: 0.72, y: -0.12 }, 0),
      density: 2.4, friction: 0.3, filter: filterCar()
    });
    fxB.setUserData({ kind: "ballast", color: palette.teal });

    // 可掉落的車頂殼
    const roof = world.createBody({ type: "dynamic", position: { x: x + SPRITE.roof.cx, y: y + SPRITE.roof.cy } });
    const fxR = roof.createFixture({
      shape: new pl.Box(SPRITE.roof.w * SPRITE.mPerPx * 0.5, SPRITE.roof.h * SPRITE.mPerPx * 0.5),
      density: 0.25, friction: 0.3, filter: filterCar()
    });
    fxR.setUserData({ kind: "roof", color: palette.roof });
    const roofJ = world.createJoint(new pl.WeldJoint({ frequencyHz: 8, dampingRatio: 0.5 }, chassis, roof, roof.getPosition()));

    function makeWheel(wx, motorTorque) {
      const wheel = world.createBody({ type: "dynamic", position: { x: wx, y: y + CFG.WHEEL_Y } });
      const fx = wheel.createFixture({
        shape: new pl.Circle(CFG.WHEEL_R),
        density: 0.9, friction: 1.05, restitution: 0.05, filter: filterCar()
      });
      fx.setUserData({ kind: "wheel", color: palette.wheel, breakImpulse: CFG.BREAK_WHEEL_IMPACT });
      const joint = world.createJoint(new pl.WheelJoint({
        motorSpeed: 0,
        maxMotorTorque: motorTorque,
        enableMotor: true,
        frequencyHz: CFG.SPRING_HZ,
        dampingRatio: CFG.SPRING_ZETA
      }, chassis, wheel, wheel.getPosition(), { x: 0, y: 1 }));
      return { body: wheel, joint: joint, torque: motorTorque };
    }
    const rear = makeWheel(x - 0.8051538461538462, CFG.TORQUE_REAR);
    const front = makeWheel(x + 0.8651538461538463, CFG.TORQUE_FRONT);

    const cargo = [];
    if (withCargo) {
      const pot = world.createBody({ type: "dynamic", position: { x: x + 0.55, y: y + 0.55 } });
      const fxP = pot.createFixture({
        shape: new pl.Circle(0.22),
        density: 0.35, friction: 0.5, restitution: 0.02, filter: filterCargo()
      });
      fxP.setUserData({ kind: "pot", color: palette.pot });
      const j = world.createJoint(new pl.WeldJoint({ frequencyHz: 6, dampingRatio: 0.4 }, chassis, pot, pot.getPosition()));
      cargo.push({ body: pot, joint: j, kind: "pot", broken: false, breakForce: CFG.BREAK_CARGO });
    }

    const breakables = [
      { body: roof, joint: roofJ, kind: "roof", broken: false, breakForce: CFG.BREAK_PART },
      { body: rear.body, joint: rear.joint, kind: "wheel", broken: false, breakForce: CFG.BREAK_WHEEL, wheel: rear },
      { body: front.body, joint: front.joint, kind: "wheel", broken: false, breakForce: CFG.BREAK_WHEEL, wheel: front }
    ].concat(cargo);

    return {
      chassis: chassis, roof: roof, rear: rear, front: front, cargo: cargo, breakables: breakables,
      gas: 0, brake: 0
    };
  }

  function resetDriveState() {
    reversing = false; revHoldT = 0; revReady = false; brakePrev = false;
    vfx = [];
    syncRevBadge();
  }
  function syncRevBadge() {
    const badge = document.getElementById("revBadge");
    if (badge) badge.classList.toggle("on", !!reversing);
  }
  function updateRevState(dt) {
    if (!car) return;
    // 以按住與否判定倒車閘門，不受放開後 0.1 秒收力影響
    const brake = !!brakeHeld, gas = !!gasHeld;
    const vx = car.chassis.getLinearVelocity().x;
    const stopped = Math.abs(vx) <= CFG.STOP_VX;
    if (gas) {
      reversing = false;
      revHoldT = 0;
      if (!stopped) revReady = false;
    } else if (brake) {
      if (reversing) {
        revHoldT = 0;
      } else if (stopped) {
        if (revReady && !brakePrev) {
          reversing = true;
          revHoldT = 0;
          revReady = false;
        } else {
          revHoldT += dt;
          if (revHoldT >= CFG.REVERSE_HOLD_S) {
            reversing = true;
            revHoldT = 0;
            revReady = false;
          }
        }
      } else {
        revHoldT = 0;
      }
    } else {
      if (brakePrev && stopped) revReady = true;
      if (!stopped) revReady = false;
      reversing = false;
      revHoldT = 0;
    }
    brakePrev = brake;
    syncRevBadge();
  }
  function applyDrive(car) {
    const gas = car.gas || 0, brake = car.brake || 0;
    let speed = 0, torque = 0, enable = true, driveScale = 0;
    if (gas > 0 && !(brake > 0)) {
      speed = -CFG.MOTOR_SPEED * gas;
      driveScale = gas;
    } else if (brake > 0 && !(gas > 0) && reversing) {
      speed = CFG.MOTOR_SPEED * 0.7 * brake;
      driveScale = brake;
    } else if (brake > 0) {
      // 真正的煞車：馬達速度 0、高扭力把車輪剎住；扭力隨力度縮放
      speed = 0;
      torque = CFG.BRAKE_TORQUE * brake * (gas > 0 ? 1.05 : 1);
    } else {
      // 無輸入：輕微引擎煞車，陡坡重力仍可慢慢下滑
      speed = 0;
      torque = CFG.COAST_TORQUE;
    }
    [car.rear, car.front].forEach(function (w) {
      if (!w.joint || !w.joint.isActive || (w.joint.m_bodyA && !w.joint.m_bodyA.isActive())) return;
      try {
        if (!w.joint.getBodyA) return;
        w.joint.enableMotor(enable);
        w.joint.setMotorSpeed(speed);
        w.joint.setMaxMotorTorque(driveScale > 0 ? w.torque * driveScale : torque);
      } catch (e) {}
    });
  }

  function queueBreaks(world, list, invDt) {
    const doomed = [];
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (item.broken || !item.joint) continue;
      if (item.kind === "wheel") continue; // 輪軸反力含懸吊彈簧，改由撞擊衝量判定
      let force = 0, torque = 0;
      try {
        const f = item.joint.getReactionForce(invDt);
        force = Math.hypot(f.x, f.y);
        torque = Math.abs(item.joint.getReactionTorque(invDt));
      } catch (e) { continue; }
      const lim = item.breakForce || CFG.BREAK_PART;
      if (force > lim || torque > lim * 0.65) doomed.push(item);
    }
    for (let i = 0; i < doomed.length; i++) {
      const item = doomed[i];
      try { world.destroyJoint(item.joint); } catch (e) {}
      item.joint = null;
      item.broken = true;
      if (item.wheel) item.wheel.joint = null;
    }
    return doomed.length;
  }

  // ---------- 模擬狀態 ----------
  let world = null, car = null, meta = null, level = null;
  let st = "menu"; // menu | countdown | play | pause | result | ads
  let tRun = 0, tGoal = 0, tOver = 0, tImmune = 0, countN = 0, countT = 0;
  let gasHeld = false, brakeHeld = false;
  let gasStrength = 0, brakeStrength = 0;
  let gasSlideLock = false, brakeSlideLock = false;
  let gasSegPrev = 0, brakeSegPrev = 0;
  let reversing = false, revHoldT = 0, revReady = false, brakePrev = false;
  let vfx = [];
  let camX = 0, camY = 1.2, camAx = 0.33, camAy = 0.56, result = null;
  let brokenCount = 0, cargoLost = false;
  let acc = 0, lastTs = 0;
  let inputAt = 0, motorAt = 0; // 延遲量測
  let fpsSamples = [], lastFpsTs = 0, fpsNow = 60;
  let botMode = false;
  let fxQuality = "high", fxAuto = !PROMO, fxLowStreak = 0;
  let basePpm = 42, camZoom = 1;
  let shakeAmp = 0, shakePhase = 0, shakeX = 0, shakeY = 0;
  let dirtTile = null, dirtPat = null, vignetteCanvas = null, vignetteKey = "";
  let litBody = null, litWheel = null;

  function fxIsLow() { return fxQuality === "low"; }
  function fxIsHigh() { return fxQuality === "high"; }
  function addShake(a) { shakeAmp = Math.min(0.6, shakeAmp + a); }
  function stepShake(dt) {
    shakeAmp = Math.max(0, shakeAmp - dt * 2.6);
    if (shakeAmp < 0.012) { shakeX = 0; shakeY = 0; return; }
    shakePhase += dt * 42;
    shakeX = Math.sin(shakePhase * 1.7) * shakeAmp * 6;
    shakeY = Math.cos(shakePhase * 2.05) * shakeAmp * 3.6;
  }
  function updateVisualZoom() {
    let target = 1;
    if (car && (st === "play" || st === "countdown")) {
      const v = car.chassis.getLinearVelocity();
      const sp = Math.hypot(v.x, v.y);
      target = 1 - Math.min(0.10, Math.max(0, (sp - 3.2) / 16) * 0.10);
    }
    camZoom += (target - camZoom) * 0.07;
    ppm = basePpm * camZoom;
  }
  function tickFxQuality() {
    if (!fxAuto) return;
    if (fpsNow > 0 && fpsNow < 48) {
      fxLowStreak += 1;
      if (fxLowStreak > 50 && fxQuality === "high") { fxQuality = "medium"; vignetteKey = ""; }
      else if (fxLowStreak > 100 && fxQuality !== "low") { fxQuality = "low"; vignetteKey = ""; layout(); }
    } else {
      fxLowStreak = Math.max(0, fxLowStreak - 2);
    }
  }
  function hash01(n) {
    n = Math.imul((n | 0) ^ 0x9e3779b9, 0x85ebca6b);
    n = (n ^ (n >>> 13)) >>> 0;
    return n / 4294967296;
  }
  function ensureDirtPattern() {
    if (dirtPat) return dirtPat;
    const s = 256;
    const c = document.createElement("canvas");
    c.width = s;
    c.height = s;
    const g = c.getContext("2d");
    g.fillStyle = "#8d6238";
    g.fillRect(0, 0, s, s);
    function blob(x, y, r, color) {
      for (let ox = -s; ox <= s; ox += s) {
        for (let oy = -s; oy <= s; oy += s) {
          g.beginPath();
          g.ellipse(x + ox, y + oy, r, r * (0.65 + hash01((x + y + r) | 0) * 0.5), hash01((x * 3 + y) | 0) * 1.2, 0, Math.PI * 2);
          g.fillStyle = color;
          g.fill();
        }
      }
    }
    for (let i = 0; i < 240; i++) {
      const x = hash01(i * 3 + 1) * s;
      const y = hash01(i * 3 + 2) * s;
      const r = 1.6 + hash01(i * 3 + 3) * 8;
      const k = hash01(i * 7 + 4);
      blob(x, y, r, k > 0.58 ? "rgba(52,28,12,0.24)" : "rgba(214,176,118,0.2)");
    }
    const img = g.getImageData(0, 0, s, s);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (hash01((i * 13) | 0) - 0.5) * 20;
      d[i] = Math.max(0, Math.min(255, d[i] + n));
      d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n * 0.88));
      d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n * 0.7));
    }
    g.putImageData(img, 0, 0);
    dirtTile = c;
    dirtPat = ctx.createPattern(c, "repeat");
    return dirtPat;
  }
  function applyDirtPattern(alpha) {
    const pat = ensureDirtPattern();
    if (!pat) return;
    const tw = 256, th = 256;
    const ox = -(((camX * ppm) % tw) + tw) % tw;
    const oy = -(((camY * ppm) % th) + th) % th;
    ctx.save();
    ctx.translate(ox, oy);
    ctx.fillStyle = pat;
    ctx.globalCompositeOperation = "multiply";
    ctx.globalAlpha = alpha == null ? 0.3 : alpha;
    ctx.fillRect(-tw, -th, viewW + tw * 2, viewH + th * 2 + 48);
    ctx.restore();
  }
  function surfaceYAt(pts, x) {
    if (!pts || pts.length < 2) return null;
    if (x < pts[0].x || x > pts[pts.length - 1].x) return null;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      if (x < a.x || x > b.x) continue;
      const t = b.x === a.x ? 0 : (x - a.x) / (b.x - a.x);
      return a.y + (b.y - a.y) * t;
    }
    return pts[pts.length - 1].y;
  }
  function offsetSurface(pts, depthFn) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const d = depthFn(pts[i].x, i);
      out.push({ x: wx(pts[i].x), y: wy(pts[i].y - d) });
    }
    return out;
  }
  function tracePoly(arr) {
    ctx.moveTo(arr[0].x, arr[0].y);
    for (let i = 1; i < arr.length; i++) ctx.lineTo(arr[i].x, arr[i].y);
  }
  function fillBand(topArr, botArr, c0, c1) {
    ctx.beginPath();
    tracePoly(topArr);
    for (let i = botArr.length - 1; i >= 0; i--) ctx.lineTo(botArr[i].x, botArr[i].y);
    ctx.closePath();
    const mid = (topArr.length * 0.5) | 0;
    const g = ctx.createLinearGradient(0, topArr[mid].y, 0, botArr[mid].y);
    g.addColorStop(0, c0);
    g.addColorStop(1, c1);
    ctx.fillStyle = g;
    ctx.fill();
  }
  function wobbleDepth(x, base, layer) {
    const amp = 0.07 + Math.min(0.16, base * 0.018);
    const w = Math.sin(x * 1.12 + layer * 1.65) * amp
      + Math.sin(x * 0.33 + layer * 0.7) * (amp * 1.35)
      + (hash01(((x * 5 + layer * 17) * 10) | 0) - 0.5) * (amp * 0.9);
    return Math.max(0, base + w);
  }
  function fillContourSection(pts) {
    if (!pts || pts.length < 2) return;
    const bottom = viewH + 48;
    ctx.beginPath();
    ctx.moveTo(wx(pts[0].x), wy(pts[0].y));
    for (let i = 1; i < pts.length; i++) ctx.lineTo(wx(pts[i].x), wy(pts[i].y));
    ctx.lineTo(wx(pts[pts.length - 1].x), bottom);
    ctx.lineTo(wx(pts[0].x), bottom);
    ctx.closePath();
    ctx.save();
    ctx.clip();
    // 先鋪最深的暖褐色，避免底部出現空洞或死黑塊
    ctx.fillStyle = "#3c2618";
    ctx.fillRect(-8, -8, viewW + 16, viewH + 64);
    const bands = fxIsLow()
      ? [
          { d0: 0, d1: 0.3, c0: "#e2c388", c1: "#d0a45c" },
          { d0: 0.3, d1: 1.2, c0: "#c08a48", c1: "#8d552e" },
          { d0: 1.2, d1: 3.2, c0: "#7a4a28", c1: "#5c3420" },
          { d0: 3.2, d1: 6.5, c0: "#52301c", c1: "#422818" },
          { d0: 6.5, d1: 80, c0: "#3f2618", c1: "#332014" }
        ]
      : [
          { d0: 0, d1: 0.22, c0: "#ecd39a", c1: "#dcb56a" },
          { d0: 0.22, d1: 0.62, c0: "#d6a45c", c1: "#c08644" },
          { d0: 0.62, d1: 1.15, c0: "#b47c40", c1: "#9a632f" },
          { d0: 1.15, d1: 1.85, c0: "#966034", c1: "#7e4c28" },
          { d0: 1.85, d1: 2.7, c0: "#8a552e", c1: "#704226" },
          { d0: 2.7, d1: 3.7, c0: "#7a4a28", c1: "#643c20" },
          { d0: 3.7, d1: 5.0, c0: "#6b3e24", c1: "#57321c" },
          { d0: 5.0, d1: 6.5, c0: "#5c3420", c1: "#4c2c1c" },
          { d0: 6.5, d1: 8.4, c0: "#522e1c", c1: "#452818" },
          { d0: 8.4, d1: 10.8, c0: "#4a2a1a", c1: "#3f2418" },
          { d0: 10.8, d1: 80, c0: "#3f2418", c1: "#332016" }
        ];
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i];
      const top = offsetSurface(pts, function (x) { return wobbleDepth(x, b.d0, i); });
      const cap = b.d1 >= 40 ? 24 : b.d1;
      const bot = offsetSurface(pts, function (x) { return wobbleDepth(x, cap, i + 1); });
      if (b.d1 >= 40) {
        for (let k = 0; k < bot.length; k++) bot[k].y = Math.max(bot[k].y, bottom);
      }
      fillBand(top, bot, b.c0, b.c1);
      if (!fxIsLow() && i > 0) {
        ctx.beginPath();
        tracePoly(top);
        ctx.strokeStyle = "rgba(48,24,10,0.36)";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.strokeStyle = "rgba(220,180,110,0.12)";
        ctx.lineWidth = 1.1;
        ctx.stroke();
      }
    }
    applyDirtPattern(fxIsLow() ? 0.18 : 0.32);
    // 草唇下方的環境遮蔽，沿地表走
    const aoTop = offsetSurface(pts, function () { return 0; });
    const aoBot = offsetSurface(pts, function (x) { return 0.16 + hash01((x * 9) | 0) * 0.08; });
    ctx.beginPath();
    tracePoly(aoTop);
    for (let i = aoBot.length - 1; i >= 0; i--) ctx.lineTo(aoBot[i].x, aoBot[i].y);
    ctx.closePath();
    ctx.fillStyle = "rgba(40,22,10,0.32)";
    ctx.fill();
    if (!fxIsLow()) drawBuriedDetails(pts);
    ctx.restore();
  }
  function drawBuriedDetails(pts) {
    const x0 = Math.max(pts[0].x, camX - 2 - viewW / ppm);
    const x1 = Math.min(pts[pts.length - 1].x, camX + 2 + viewW / ppm);
    if (x1 <= x0) return;
    const step = fxIsHigh() ? 0.62 : 0.95;
    const gi0 = Math.floor(x0 / step);
    const gi1 = Math.ceil(x1 / step);
    for (let gi = gi0; gi <= gi1; gi++) {
      const hx = gi * step + hash01(gi + 31) * step * 0.55;
      const sy = surfaceYAt(pts, hx);
      if (sy == null) continue;
      const depth = 0.28 + hash01(gi + 71) * (fxIsHigh() ? 9.5 : 6.2);
      const px = wx(hx), py = wy(sy - depth);
      if (py < -20 || py > viewH + 20) continue;
      const rx = (0.08 + hash01(gi + 9) * 0.22) * ppm;
      const ry = rx * (0.55 + hash01(gi + 11) * 0.4);
      ctx.beginPath();
      ctx.ellipse(px, py, rx, ry, (hash01(gi + 3) - 0.5) * 1.1, 0, Math.PI * 2);
      ctx.fillStyle = hash01(gi + 5) > 0.45 ? "rgba(72,44,28,0.7)" : "rgba(140,96,58,0.55)";
      ctx.fill();
      if (fxIsHigh()) {
        ctx.beginPath();
        ctx.ellipse(px - rx * 0.25, py - ry * 0.25, rx * 0.35, ry * 0.25, 0, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(230,200,150,0.22)";
        ctx.fill();
      }
    }
    if (!fxIsHigh()) return;
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(70,40,20,0.5)";
    ctx.lineWidth = 1.5;
    const r0 = Math.floor(x0 / 1.7);
    const r1 = Math.ceil(x1 / 1.7);
    for (let gi = r0; gi <= r1; gi++) {
      if (hash01(gi + 401) < 0.35) continue;
      const hx = gi * 1.7 + hash01(gi + 90) * 0.6;
      const sy = surfaceYAt(pts, hx);
      if (sy == null) continue;
      const px = wx(hx), py = wy(sy - 0.06);
      const lean = (hash01(gi + 12) - 0.5) * 22;
      const drop = (0.35 + hash01(gi + 14) * 0.45) * ppm;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.quadraticCurveTo(px + lean, py + drop * 0.45, px - lean * 0.4, py + drop);
      ctx.stroke();
      if (hash01(gi + 18) > 0.55) {
        ctx.beginPath();
        ctx.moveTo(px + lean * 0.35, py + drop * 0.4);
        ctx.quadraticCurveTo(px + lean * 0.9, py + drop * 0.55, px + lean * 0.5, py + drop * 0.85);
        ctx.stroke();
      }
    }
    // 深處稀疏的化石或短管，沒有品牌
    const f0 = Math.floor(x0 / 7.5);
    const f1 = Math.ceil(x1 / 7.5);
    for (let gi = f0; gi <= f1; gi++) {
      if (hash01(gi + 801) < 0.55) continue;
      const hx = gi * 7.5 + hash01(gi + 810) * 3;
      const sy = surfaceYAt(pts, hx);
      if (sy == null) continue;
      const depth = 2.4 + hash01(gi + 820) * 4.5;
      const px = wx(hx), py = wy(sy - depth);
      if (py < 0 || py > viewH) continue;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate((hash01(gi + 830) - 0.5) * 1.2);
      if (hash01(gi + 840) > 0.5) {
        ctx.strokeStyle = "rgba(160,130,96,0.45)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, 0.16 * ppm, 0.4, Math.PI * 2.2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, 0, 0.09 * ppm, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.strokeStyle = "rgba(110,86,64,0.5)";
        ctx.lineWidth = 3.2;
        ctx.beginPath();
        ctx.moveTo(-0.28 * ppm, 0);
        ctx.lineTo(0.28 * ppm, 0);
        ctx.stroke();
        ctx.strokeStyle = "rgba(70,52,38,0.4)";
        ctx.lineWidth = 1;
        ctx.strokeRect(-0.28 * ppm, -0.07 * ppm, 0.56 * ppm, 0.14 * ppm);
      }
      ctx.restore();
    }
  }
  function drawTerrain() {
    if (!meta || !meta.paths || !meta.paths.length) return;
    for (let i = 0; i < meta.paths.length; i++) {
      const pts = meta.paths[i];
      if (!pts || pts.length < 2) continue;
      fillContourSection(pts);
      strokeGrassEdge(function () {
        ctx.beginPath();
        for (let k = 0; k < pts.length; k++) {
          const x = wx(pts[k].x), y = wy(pts[k].y) - 2;
          if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
      });
      strokeGrassBlades(pts);
    }
  }
  function drawMenuGround() {
    const y0 = viewH * 0.62;
    const pts = [];
    const span = 28;
    for (let i = 0; i <= 10; i++) {
      const x = camX - 8 + span * (i / 10);
      pts.push({ x: x, y: (viewH * camAy - y0) / ppm + camY + Math.sin(i * 0.7) * 0.25 });
    }
    fillContourSection(pts);
    strokeGrassEdge(function () {
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const x = wx(pts[i].x), y = wy(pts[i].y) - 2;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
    });
  }
  function strokeGrassEdge(drawTop) {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(20,10,4,0.55)";
    ctx.lineWidth = 16;
    drawTop(); ctx.stroke();
    ctx.strokeStyle = "#6a3c1c";
    ctx.lineWidth = 11;
    drawTop(); ctx.stroke();
    ctx.strokeStyle = "#3f6a1c";
    ctx.lineWidth = 9;
    drawTop(); ctx.stroke();
    ctx.strokeStyle = "#5f8f2c";
    ctx.lineWidth = 6.2;
    drawTop(); ctx.stroke();
    ctx.strokeStyle = "#9ccc58";
    ctx.lineWidth = 3.2;
    drawTop(); ctx.stroke();
    ctx.strokeStyle = "rgba(236,255,190,0.7)";
    ctx.lineWidth = 1.35;
    drawTop(); ctx.stroke();
  }
  function strokeGrassBlades(pts) {
    if (fxIsLow() || !pts || pts.length < 2) return;
    ctx.save();
    ctx.lineCap = "round";
    ctx.strokeStyle = "#c8e878";
    ctx.lineWidth = 1.15;
    ctx.beginPath();
    const step = fxIsHigh() ? 0.18 : 0.32;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
      if (len < 0.05) continue;
      const n = Math.max(1, Math.floor(len / step));
      for (let k = 0; k < n; k++) {
        const u = (k + hash01((a.x * 10 + k + i * 17) | 0)) / n;
        const x = a.x + dx * u, y = a.y + dy * u;
        const ang = Math.atan2(dy, dx);
        const h = 0.16 + hash01((x * 40 + 3) | 0) * 0.2;
        const lean = (hash01((x * 21) | 0) - 0.5) * 0.12;
        ctx.moveTo(wx(x), wy(y) - 1);
        ctx.lineTo(wx(x + Math.cos(ang) * lean - Math.sin(ang) * 0.02), wy(y + h));
      }
    }
    ctx.stroke();
    ctx.restore();
  }
  function getLitSprite(img, kind) {
    if (!spriteOk(img) || fxIsLow()) return img;
    if (kind === "body" && litBody && litBody._src === img) return litBody;
    if (kind === "wheel" && litWheel && litWheel._src === img) return litWheel;
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    g.globalCompositeOperation = "source-atop";
    const grd = g.createLinearGradient(c.width * 0.08, c.height * 0.04, c.width * 0.85, c.height * 0.7);
    grd.addColorStop(0, "rgba(255,252,245,0.32)");
    grd.addColorStop(0.32, "rgba(255,248,230,0.10)");
    grd.addColorStop(0.7, "rgba(0,0,0,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, c.width, c.height);
    const rim = g.createLinearGradient(0, 0, 0, c.height * 0.28);
    rim.addColorStop(0, "rgba(255,255,255,0.34)");
    rim.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = rim;
    g.fillRect(0, 0, c.width, c.height * 0.3);
    c._src = img;
    if (kind === "body") litBody = c;
    else litWheel = c;
    return c;
  }

  const canvas = document.getElementById("c");
  const ctx = canvas.getContext("2d", { alpha: false });
  let viewW = 800, viewH = 450, ppm = 42;

  function layout() {
    const vv = window.visualViewport;
    const w = Math.max(1, (vv && vv.width) || window.innerWidth || 800);
    const h = Math.max(1, (vv && vv.height) || window.innerHeight || 450);
    const dprCap = (typeof fxQuality === "string" && fxQuality === "low") ? 1.25 : 2;
    const dpr = Math.min(dprCap, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    viewW = w; viewH = h;
    if (h > w * 1.15) {
      // 直式手機：略為拉近，讓車體更大，同時還留得出前方路面
      basePpm = Math.max(44, Math.min(54, w / 8.3));
    } else {
      basePpm = Math.max(36, Math.min(56, Math.min(w / 15.5, h / 9.5)));
    }
    ppm = basePpm * camZoom;
  }

  function isPortrait() {
    return viewH > viewW * 1.15;
  }

  function destroyWorld() {
    world = null; car = null; meta = null;
  }

  function setupLevel(id, opts) {
    opts = opts || {};
    level = levelById(id);
    if (world) { /* drop refs; new world replaces */ }
    world = new pl.World({ gravity: { x: 0, y: -CFG.GRAVITY } });
    const b = makeBuilder(world);
    level.build(b);
    meta = b.finish();
    car = createCar(world, meta.spawn.x, meta.spawn.y, !!level.cargo);
    brokenCount = 0;
    cargoLost = false;
    tRun = 0; tGoal = 0; tOver = 0; tImmune = 0.9; result = null;
    camX = meta.spawn.x; camY = meta.spawn.y;
    gasHeld = false; brakeHeld = false;
    gasStrength = 0; brakeStrength = 0;
    gasSlideLock = false; brakeSlideLock = false;
    gasSegPrev = 0; brakeSegPrev = 0;
    if (car) { car.gas = 0; car.brake = 0; }
    resetDriveState();
    syncPedals();
    continueUsed = !!opts.keepContinueUsed && continueUsed;
    if (!opts.keepContinueUsed) { continueUsed = false; hideContinueBtn(); }

    for (let i = 0; i < 45; i++) { world.step(CFG.TICK, CFG.VEL_IT, CFG.POS_IT); world.clearForces(); }
    if (car) snapCam();
    world.on("post-solve", function (contact, impulse) {
      const im = impulse && impulse.normalImpulses ? impulse.normalImpulses[0] : 0;
      if (!(im > 0)) return;
      const fa = contact.getFixtureA();
      const fb = contact.getFixtureB();
      [fa, fb].forEach(function (fx) {
        const ud = fx && fx.getUserData && fx.getUserData();
        if (ud && (ud.kind === "plank" || ud.kind === "wheel") && ud.breakImpulse && im > ud.breakImpulse) {
          ud._wantBreak = true;
        }
      });
    });
  }

  function breakPendingWheels() {
    if (!car) return 0;
    let n = 0;
    const list = car.breakables || [];
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (item.kind !== "wheel" || item.broken || !item.body) continue;
      let hit = false;
      for (let f = item.body.getFixtureList(); f; f = f.getNext()) {
        const u = f.getUserData();
        if (u && u._wantBreak) hit = true;
      }
      if (hit) {
        item.broken = true;
        if (item.joint) { try { world.destroyJoint(item.joint); } catch (e) {} item.joint = null; }
        if (item.wheel) item.wheel.joint = null;
        n++;
      }
    }
    return n;
  }

  function breakPendingPlanks() {
    if (!meta) return;
    for (let i = 0; i < meta.props.length; i++) {
      const p = meta.props[i];
      if (p.kind !== "plank" || p.broken || !p.body) continue;
      const fxs = [];
      for (let f = p.body.getFixtureList(); f; f = f.getNext()) fxs.push(f);
      const hit = fxs.some(function (f) { const u = f.getUserData(); return u && u._wantBreak; });
      if (hit) {
        p.broken = true;
        if (p.joint) { try { world.destroyJoint(p.joint); } catch (e) {} p.joint = null; }
        // 讓木板掉落：已是 dynamic，只拆焊即可
      }
    }
  }

  function chassisUpright() {
    const a = car.chassis.getAngle();
    let d = Math.abs(Math.atan2(Math.sin(a), Math.cos(a)));
    return d < (55 * Math.PI / 180);
  }

  function inGoal() {
    const p = car.chassis.getPosition();
    const g = meta.goal;
    return p.x >= g.x && p.x <= g.x + g.w && p.y >= g.y - 0.2 && p.y <= g.y + g.h;
  }

  function starCount(time, cargoOk, partsOk) {
    if (time <= level.par3 && cargoOk && partsOk) return 3;
    if (time <= level.par2 && cargoOk) return 2;
    if (time <= level.par2) return 2;
    return 1;
  }

  function finishRun(ok, reason) {
    if (st === "result") return;
    const cargoOk = !level.cargo || !cargoLost;
    const partsOk = brokenCount === 0;
    const time = tRun;
    const stars = ok ? starCount(time, cargoOk, partsOk) : 0;
    result = {
      ok: ok, reason: reason || (ok ? "到達" : "失敗"),
      time: time, stars: stars, cargoOk: cargoOk, partsOk: partsOk,
      broken: brokenCount, levelId: level.id
    };
    if (ok) {
      const prev = store.stars[level.id] || 0;
      if (stars > prev) store.stars[level.id] = stars;
      const bt = store.bestTime[level.id];
      if (bt == null || time < bt) store.bestTime[level.id] = time;
      if (store.unlocked < level.id + 1) store.unlocked = Math.min(LEVELS.length, level.id + 1);
      saveStore();
    }
    st = "result";
    if (ok) {
      spawnConfetti();
      playSfx("fanfare");
    }
    showResult();
    if (!ok) offerRewardRetry();
  }

  // ---------- 逐步模擬 ----------
  function stepSim(dt) {
    if (!world || !car) return;
    if (!botMode) updatePedalStrength(dt);
    if (st === "play") {
      tRun += dt;
      if (botMode) applyBot();
      else {
        car.gas = gasStrength;
        car.brake = brakeStrength;
      }
      updateRevState(dt);
      applyDrive(car);
      stepVfx(dt);
      if (motorAt === 0 && (car.gas || car.brake)) motorAt = performance.now();
    } else {
      car.gas = 0; car.brake = 0;
      updateRevState(dt);
      applyDrive(car);
      if (st === "result") stepVfx(dt);
    }
    world.step(dt, CFG.VEL_IT, CFG.POS_IT);
    world.clearForces();
    if (tImmune > 0) tImmune = Math.max(0, tImmune - dt);
    if (tImmune <= 0) breakPendingPlanks();
    const nw = tImmune > 0 ? 0 : breakPendingWheels();
    const n = (tImmune > 0 ? 0 : queueBreaks(world, car.breakables, 1 / dt)) + nw;
    if (n) {
      brokenCount += n;
      spawnDebris(n);
      if (!botMode) playSfx("crash");
      car.breakables.forEach(function (it) {
        if (it.kind === "pot" && it.broken) cargoLost = true;
      });
    }
    // 貨物掉落判定：關節斷了，或離車斗太遠／過低
    if (level.cargo) {
      car.cargo.forEach(function (c) {
        if (c.broken) cargoLost = true;
        else {
          const p = c.body.getPosition(), q = car.chassis.getPosition();
          if (p.y < q.y - 1.6 || Math.hypot(p.x - q.x, p.y - q.y) > 3.2) {
            cargoLost = true;
          }
        }
      });
    }
    if (st !== "play") return;
    tickImpactAudio();
    const p = car.chassis.getPosition();
    if (p.y < (meta.killY != null ? meta.killY : CFG.KILL_Y)) {
      finishRun(false, "掉出跑道");
      return;
    }
    if (inGoal() && chassisUpright()) {
      tGoal += dt;
      if (tGoal >= CFG.GOAL_HOLD) finishRun(true, "穩當到達");
    } else {
      tGoal = 0;
    }
    if (tRun > 180) finishRun(false, "逾時");
  }

  function targetSpeed(x) {
    const pts = level.bot || [{ x: 0, v: 4 }];
    if (x <= pts[0].x) return pts[0].v;
    for (let i = 1; i < pts.length; i++) {
      if (x <= pts[i].x) {
        const a = pts[i - 1], b = pts[i];
        const u = (x - a.x) / Math.max(0.001, b.x - a.x);
        return a.v + (b.v - a.v) * u;
      }
    }
    return pts[pts.length - 1].v;
  }

  function wrapAng(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }
  function applyBot() {
    if (!car) return;
    const p = car.chassis.getPosition();
    const v = car.chassis.getLinearVelocity();
    const want = targetSpeed(p.x);
    const err = want - v.x;
    const pitch = wrapAng(car.chassis.getAngle());
    const ang = Math.abs(pitch);
    gasHeld = false; brakeHeld = false;
    gasStrength = 0; brakeStrength = 0;
    if (ang > 2.0) { // 翻覆後不要硬給油
      if (Math.abs(v.x) > 1) { brakeHeld = true; brakeStrength = 1; }
    } else if (pitch > 0.72) { // 翹輪：超過一般坡度才收油
      if (pitch > 1.0 && v.x > 1) { brakeHeld = true; brakeStrength = 1; }
    } else if (pitch < -0.7 && v.x > 7) { // 很陡且過快才強制收速，避免淺凹槽裡翻車
      brakeHeld = true; brakeStrength = 1;
    } else if (err > 0.35) {
      gasHeld = true;
      // 誤差大時滿力，接近目標才用部分力度
      gasStrength = Math.max(CFG.PEDAL_TOUCH, Math.min(1, (err - 0.10) / 1.0));
    } else if (err < -0.45) {
      brakeHeld = true;
      brakeStrength = Math.max(CFG.PEDAL_TOUCH, Math.min(1, (-err - 0.15) / 1.0));
    }
    // 在空中略收（兩輪幾乎離地時不要猛加速）
    const wr = car.rear.body.getPosition().y, wf = car.front.body.getPosition().y;
    const gY = p.y;
    if (wr > gY - 0.15 && wf > gY - 0.15 && v.y > 1.2) {
      if (v.x > want) { gasHeld = false; brakeHeld = false; gasStrength = 0; brakeStrength = 0; }
    }
    car.gas = gasStrength;
    car.brake = brakeStrength;
  }

  // ---------- 繪製 ----------
  function wx(x) { return (x - camX) * ppm + viewW * camAx; }
  function wy(y) { return viewH * camAy - (y - camY) * ppm; }

  function vehicleAABB() {
    const box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    function add(x, y) {
      if (x < box.minX) box.minX = x;
      if (x > box.maxX) box.maxX = x;
      if (y < box.minY) box.minY = y;
      if (y > box.maxY) box.maxY = y;
    }
    function addLocal(body, lx, ly) {
      if (!body) return;
      const p = body.getWorldPoint({ x: lx, y: ly });
      add(p.x, p.y);
    }
    if (car && car.chassis) {
      // 含牛欄、排氣管與車頂的外輪廓，再留一點餘裕
      const corners = [
        [-1.50, -0.52], [1.62, -0.52], [1.62, 0.64], [-1.50, 0.64]
      ];
      for (let i = 0; i < corners.length; i++) addLocal(car.chassis, corners[i][0], corners[i][1]);
    }
    [car.rear, car.front].forEach(function (w) {
      if (!w || !w.body) return;
      const p = w.body.getPosition();
      const r = CFG.WHEEL_R * 1.16;
      add(p.x - r, p.y - r); add(p.x + r, p.y + r);
    });
    if (car.roof) {
      const p = car.roof.getPosition();
      add(p.x - 0.62, p.y - 0.10); add(p.x + 0.62, p.y + 0.12);
    }
    if (car.cargo) {
      car.cargo.forEach(function (c) {
        if (!c || !c.body) return;
        const p = c.body.getPosition();
        add(p.x - 0.24, p.y - 0.24); add(p.x + 0.24, p.y + 0.24);
      });
    }
    return box;
  }

  function camPads() {
    return {
      l: 16,
      r: 16,
      t: 70,
      b: Math.min(viewH * 0.24, isPortrait() ? 150 : 96)
    };
  }

  function clampCam(cx, cy, ax, ay, box) {
    const pads = camPads();
    const maxCx = box.minX + (viewW * ax - pads.l) / ppm;
    const minCx = box.maxX - (viewW * (1 - ax) - pads.r) / ppm;
    if (minCx <= maxCx) cx = Math.max(minCx, Math.min(maxCx, cx));
    else cx = (box.minX + box.maxX) * 0.5;
    const minCy = box.maxY - (viewH * ay - pads.t) / ppm;
    const maxCy = box.minY + (viewH * (1 - ay) - pads.b) / ppm;
    if (minCy <= maxCy) cy = Math.max(minCy, Math.min(maxCy, cy));
    else cy = (box.minY + box.maxY) * 0.5;
    return { x: cx, y: cy };
  }

  function snapCam() {
    updateCam(1, true);
  }

  function updateCam(alpha, snap) {
    if (!car) return;
    const portrait = isPortrait();
    const p = car.chassis.getPosition();
    const v = car.chassis.getLinearVelocity();
    const goingLeft = v.x < -0.85 || (reversing && v.x < 0.15);
    const baseAx = portrait ? 0.33 : 0.36;
    let ax = goingLeft ? (1 - baseAx) : baseAx;
    const speed = Math.abs(v.x);
    // 車體本身已在畫面 30–35%，只需依速度做很小的前視，避免被推到左緣
    const leadT = Math.max(0, Math.min(1, (speed - 2) / 12));
    ax += (goingLeft ? 1 : -1) * leadT * 0.028;
    const lookX = Math.max(0, Math.min(0.7, speed * 0.055)) * (goingLeft ? -1 : 1);
    let tx = p.x + lookX;
    let pitch = car.chassis.getAngle();
    while (pitch > Math.PI) pitch -= Math.PI * 2;
    while (pitch < -Math.PI) pitch += Math.PI * 2;
    let lookY = portrait ? 0.22 : 0.32;
    lookY += Math.max(-0.9, Math.min(1.3, v.y * 0.28));
    if (pitch > 0.12) lookY += Math.min(1.1, pitch * 1.05);
    if (pitch < -0.12) lookY += Math.max(-1.0, pitch * 0.9);
    let ty = p.y + lookY;
    const ay = portrait ? 0.54 : 0.62;
    const box = vehicleAABB();
    const cl = clampCam(tx, ty, ax, ay, box);
    tx = cl.x; ty = cl.y;
    if (snap) {
      camX = tx; camY = ty; camAx = ax; camAy = ay;
      return;
    }
    const k = 1 - Math.pow(0.001, Math.max(0.001, alpha || CFG.TICK));
    camX += (tx - camX) * Math.min(1, k * 7);
    camY += (ty - camY) * Math.min(1, k * 6);
    camAx += (ax - camAx) * Math.min(1, k * 5);
    camAy += (ay - camAy) * Math.min(1, k * 5);
    const held = clampCam(camX, camY, camAx, camAy, box);
    camX = held.x; camY = held.y;
  }

  function camFraming() {
    if (!car) return null;
    const box = vehicleAABB();
    const pads = camPads();
    const left = wx(box.minX), right = wx(box.maxX);
    const top = wy(box.maxY), bottom = wy(box.minY);
    const mid = wx((box.minX + box.maxX) * 0.5);
    return {
      ppm: ppm, viewW: viewW, viewH: viewH, camAx: camAx, camAy: camAy,
      left: left, right: right, top: top, bottom: bottom, mid: mid,
      pads: pads,
      clipped: left < pads.l - 0.5 || right > viewW - pads.r + 0.5 ||
        top < pads.t - 0.5 || bottom > viewH - pads.b + 0.5
    };
  }

  function drawTiledBg(img, yBottom, drawH, parallax, alpha) {
    if (!spriteOk(img) || drawH <= 0) return;
    const scale = drawH / img.naturalHeight;
    const tw = img.naturalWidth * scale;
    if (tw < 8) return;
    const shift = -(((camX * ppm * parallax) % tw) + tw) % tw;
    ctx.save();
    if (alpha != null && alpha < 1) ctx.globalAlpha = alpha;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    for (let x = shift; x < viewW; x += tw) {
      ctx.drawImage(img, x, yBottom - drawH, tw, drawH);
    }
    ctx.restore();
  }
  function drawCoverBg(img, yBottom, drawH, parallax, alpha) {
    if (!spriteOk(img) || drawH <= 0) return;
    // Overscale slightly and clamp so a parallax shift cannot leave a sky-gap at either edge.
    const scale = Math.max(drawH / Math.max(1, img.naturalHeight), viewW / Math.max(1, img.naturalWidth)) * 1.06;
    const tw = Math.ceil(img.naturalWidth * scale) + 4;
    const th = Math.ceil(img.naturalHeight * scale) + 4;
    const slack = Math.max(0, tw - viewW);
    let x = -slack * 0.5 - (camX * ppm * (parallax || 0));
    x = slack > 0 ? Math.max(-slack, Math.min(0, x)) : 0;
    ctx.save();
    if (alpha != null && alpha < 1) ctx.globalAlpha = alpha;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, x, yBottom - th, tw, th);
    ctx.restore();
  }
  function drawSunAndRays(horizon) {
    const sx = viewW * 0.82, sy = Math.max(36, horizon * 0.22);
    const rg = ctx.createRadialGradient(sx, sy, 6, sx, sy, Math.max(viewW, viewH) * 0.7);
    rg.addColorStop(0, "rgba(255,245,210,0.95)");
    rg.addColorStop(0.08, "rgba(255,210,120,0.55)");
    rg.addColorStop(0.28, "rgba(255,170,80,0.16)");
    rg.addColorStop(1, "rgba(255,170,80,0)");
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, viewW, viewH);
    ctx.beginPath();
    ctx.arc(sx, sy, 16, 0, Math.PI * 2);
    ctx.fillStyle = "#fff6c8";
    ctx.fill();
    if (fxIsLow()) return;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const rays = fxIsHigh() ? 9 : 5;
    for (let i = 0; i < rays; i++) {
      const a = -0.9 + i * (1.5 / rays) + Math.sin((tRun || 0) * 0.15) * 0.03;
      const len = viewH * (0.55 + (i % 3) * 0.08);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + Math.cos(a - 0.035) * len, sy + Math.sin(a - 0.035) * len);
      ctx.lineTo(sx + Math.cos(a + 0.035) * len, sy + Math.sin(a + 0.035) * len);
      ctx.closePath();
      ctx.fillStyle = "rgba(255,220,140," + (0.07 + (i % 2) * 0.03) + ")";
      ctx.fill();
    }
    ctx.restore();
  }
  function drawNearHills(horizon) {
    const y0 = horizon + 8;
    const shift = -(((camX * ppm * 0.48) % 420) + 420) % 420;
    ctx.beginPath();
    ctx.moveTo(shift - 40, viewH);
    for (let x = shift - 40; x <= viewW + 60; x += 30) {
      const yy = y0 - 28 - Math.abs(Math.sin((x - shift) * 0.012 + 1.2)) * 52
        - Math.abs(Math.sin((x - shift) * 0.027)) * 22;
      ctx.lineTo(x, yy);
    }
    ctx.lineTo(viewW + 60, viewH);
    ctx.closePath();
    const ng = ctx.createLinearGradient(0, y0 - 80, 0, viewH);
    ng.addColorStop(0, "#4a6a30");
    ng.addColorStop(0.45, "#2f4a20");
    ng.addColorStop(1, "#1a2810");
    ctx.fillStyle = ng;
    ctx.fill();
  }
  function drawSky() {
    const horizon = meta ? wy(0) : viewH * 0.62;
    const g = ctx.createLinearGradient(0, 0, 0, Math.max(horizon, viewH * 0.7));
    g.addColorStop(0, palette.skyTop);
    g.addColorStop(0.38, "#b7d4ee");
    g.addColorStop(0.62, palette.skyMid);
    g.addColorStop(1, palette.skyHorizon);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, viewW, viewH);
    if (spriteOk(bgImgs.sky)) {
      const skyH = Math.max(horizon + 28, viewH * 0.82);
      drawCoverBg(bgImgs.sky, skyH, skyH, 0.012, 1);
    } else {
      drawSunAndRays(horizon);
    }
    if (spriteOk(bgImgs.far)) {
      const fh = Math.max(110, Math.min(viewH * 0.36, 240));
      drawTiledBg(bgImgs.far, horizon + fh * 0.1, fh, 0.1, 1);
    } else {
      ctx.fillStyle = "rgba(130,110,150,0.28)";
      ctx.beginPath();
      ctx.moveTo(0, horizon);
      for (let i = 0; i <= 10; i++) {
        const xx = (i / 10) * viewW;
        const yy = horizon - 70 - Math.abs(Math.sin(i * 1.1 + camX * 0.015)) * 80;
        ctx.lineTo(xx, yy);
      }
      ctx.lineTo(viewW, horizon); ctx.closePath(); ctx.fill();
    }
    if (!fxIsLow()) {
      const hg = ctx.createLinearGradient(0, horizon - 160, 0, horizon + 10);
      hg.addColorStop(0, "rgba(246,208,154,0.08)");
      hg.addColorStop(0.55, "rgba(246,208,154,0.28)");
      hg.addColorStop(1, "rgba(246,208,154,0)");
      ctx.fillStyle = hg;
      ctx.fillRect(0, horizon - 160, viewW, 180);
    }
    if (spriteOk(bgImgs.mid)) {
      const mh = Math.max(90, Math.min(viewH * 0.28, 200));
      drawTiledBg(bgImgs.mid, horizon + 6, mh, 0.26, 1);
    }
    if (spriteOk(bgImgs.near) && !fxIsLow()) {
      const nh = Math.max(70, Math.min(viewH * 0.2, 150));
      drawTiledBg(bgImgs.near, horizon + 16, nh, 0.48, 1);
    } else if (!fxIsLow()) {
      drawNearHills(horizon);
    }
  }


  function inBody(body, fn) {
    if (!body) return;
    const p = body.getPosition();
    const a = body.getAngle();
    ctx.save();
    ctx.translate(wx(p.x), wy(p.y));
    ctx.rotate(-a);
    ctx.scale(ppm, -ppm);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    fn();
    ctx.restore();
  }

  function polyPath(pts) {
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      if (i === 0) ctx.moveTo(pts[i][0], pts[i][1]);
      else ctx.lineTo(pts[i][0], pts[i][1]);
    }
    ctx.closePath();
  }

  function strokeFill(fill, stroke, lw) {
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw || 0.03; ctx.stroke(); }
  }

  function drawBuggyWheel(wheelBody) {
    const av = Math.abs(wheelBody.getAngularVelocity ? wheelBody.getAngularVelocity() : 0);
    const blur = !fxIsLow() && av > 10;
    inBody(wheelBody, function () {
      const src = spriteImgs.wheel;
      const ox = -SPRITE.wheel.w * SPRITE.mPerPx * 0.5;
      const oy = SPRITE.wheel.h * SPRITE.mPerPx * 0.5;
      if (!spriteOk(src)) {
        ctx.beginPath();
        ctx.arc(0, 0, CFG.WHEEL_R, 0, Math.PI * 2);
        ctx.fillStyle = "#1a1a1d";
        ctx.fill();
        if (blur) {
          ctx.strokeStyle = "rgba(30,30,34,0.35)";
          ctx.lineWidth = 0.08;
          ctx.beginPath(); ctx.arc(0, 0, CFG.WHEEL_R * 0.92, 0, Math.PI * 2); ctx.stroke();
        }
        return;
      }
      const img = getLitSprite(src, "wheel");
      if (blur) {
        const copies = fxIsHigh() ? 5 : 3;
        const span = Math.min(0.55, av * 0.012);
        for (let i = 0; i < copies; i++) {
          const a = (i / (copies - 1) - 0.5) * span;
          ctx.save();
          ctx.rotate(a);
          ctx.globalAlpha = 0.22;
          drawSpriteYUp(img, ox, oy, SPRITE.wheel.w, SPRITE.wheel.h);
          ctx.restore();
        }
        ctx.globalAlpha = 0.7;
      }
      drawSpriteYUp(img, ox, oy, SPRITE.wheel.w, SPRITE.wheel.h);
      ctx.globalAlpha = 1;
    });
  }

  function drawSuspension() {
    // 物理懸吊仍在；外觀比照概念圖，不畫出彈簧
  }

  function roofBroken() {
    if (!car || !car.breakables) return false;
    for (let i = 0; i < car.breakables.length; i++) {
      if (car.breakables[i].kind === "roof" && car.breakables[i].broken) return true;
    }
    return false;
  }

  function drawHull() {
    if (!car || !car.chassis) return;
    inBody(car.chassis, function () {
      const src = spriteImgs.body;
      if (!spriteOk(src)) return;
      drawSpriteYUp(getLitSprite(src, "body"), SPRITE.body.ox, SPRITE.body.oy, SPRITE.body.w, SPRITE.body.h);
      if (!fxIsLow()) {
        const sweep = ((tRun || 0) * 0.35) % 2.6 - 1.1;
        ctx.save();
        ctx.beginPath();
        ctx.rect(SPRITE.body.ox, SPRITE.body.oy - SPRITE.body.h * SPRITE.mPerPx, SPRITE.body.w * SPRITE.mPerPx, SPRITE.body.h * SPRITE.mPerPx);
        ctx.clip();
        ctx.translate(sweep, 0.05);
        ctx.rotate(-0.55);
        const sg = ctx.createLinearGradient(0, -0.4, 0, 0.4);
        sg.addColorStop(0, "rgba(255,255,255,0)");
        sg.addColorStop(0.45, "rgba(255,255,255,0.22)");
        sg.addColorStop(0.55, "rgba(255,255,255,0.08)");
        sg.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = sg;
        ctx.fillRect(-0.15, -0.8, 0.28, 1.6);
        ctx.restore();
      }
      if (roofBroken() && spriteOk(spriteImgs.roof)) {
        ctx.save();
        ctx.globalCompositeOperation = "destination-out";
        drawSpriteYUp(spriteImgs.roof, SPRITE.roof.ox, SPRITE.roof.oy, SPRITE.roof.w, SPRITE.roof.h);
        ctx.restore();
        ctx.save();
        ctx.globalCompositeOperation = "destination-over";
        ctx.fillStyle = "#1a222c";
        ctx.fillRect(SPRITE.roof.ox, SPRITE.roof.oy - SPRITE.roof.h * SPRITE.mPerPx, SPRITE.roof.w * SPRITE.mPerPx, SPRITE.roof.h * SPRITE.mPerPx);
        ctx.restore();
      }
    });
  }

  function drawRoofPanel() {
    if (!car || !car.roof || !roofBroken()) return;
    if (!spriteOk(spriteImgs.roof)) return;
    inBody(car.roof, function () {
      const w = SPRITE.roof.w * SPRITE.mPerPx, h = SPRITE.roof.h * SPRITE.mPerPx;
      drawSpriteYUp(spriteImgs.roof, -w * 0.5, h * 0.5, SPRITE.roof.w, SPRITE.roof.h);
    });
  }

  function drawCargoPot(body) {
    inBody(body, function () {
      // 陶罐：圓形碰撞，視覺畫成有罐口、肩線與束帶的陶甕，避免看起來像球
      ctx.beginPath();
      ctx.moveTo(-0.11, -0.18);
      ctx.quadraticCurveTo(-0.20, -0.04, -0.18, 0.06);
      ctx.quadraticCurveTo(-0.16, 0.14, -0.10, 0.16);
      ctx.lineTo(0.10, 0.16);
      ctx.quadraticCurveTo(0.16, 0.14, 0.18, 0.06);
      ctx.quadraticCurveTo(0.20, -0.04, 0.11, -0.18);
      ctx.closePath();
      const g = ctx.createLinearGradient(-0.16, 0.16, 0.18, -0.18);
      g.addColorStop(0, "#e08a58");
      g.addColorStop(0.45, "#c45c36");
      g.addColorStop(1, "#7a2c14");
      ctx.fillStyle = g;
      ctx.fill();
      ctx.strokeStyle = "#5a200e";
      ctx.lineWidth = 0.025;
      ctx.stroke();
      // 罐口
      ctx.beginPath();
      ctx.ellipse(0, 0.16, 0.11, 0.045, 0, 0, Math.PI * 2);
      ctx.fillStyle = "#a34722";
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(0, 0.175, 0.08, 0.03, 0, 0, Math.PI * 2);
      ctx.fillStyle = "#4a1c10";
      ctx.fill();
      // 束帶
      ctx.strokeStyle = "#d9a078";
      ctx.lineWidth = 0.028;
      ctx.beginPath();
      ctx.ellipse(0, 0.02, 0.185, 0.05, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(-0.06, 0.08, 0.035, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,220,190,0.3)";
      ctx.fill();
    });
  }

  function drawCarShadow() {
    if (!car) return;
    const wr = car.rear && car.rear.body ? car.rear.body.getPosition() : null;
    const wf = car.front && car.front.body ? car.front.body.getPosition() : null;
    if (!wr || !wf) return;
    const ch = car.chassis.getPosition();
    const wrL = car.chassis.getLocalPoint(wr);
    const wfL = car.chassis.getLocalPoint(wf);
    const droop = Math.min(wrL.y, wfL.y);
    const air = Math.max(0, Math.min(1, (-0.50 - droop) / 0.35));
    const a = 0.42 * (1 - air);
    if (a < 0.03) return;
    const mx = (wr.x + wf.x) * 0.5, my = Math.min(wr.y, wf.y) - CFG.WHEEL_R * 0.15;
    const sx = wx(mx), sy = wy(my);
    const ang = -car.chassis.getAngle();
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(ang);
    const rx = 1.42 * ppm, ry = 0.24 * ppm;
    if (!fxIsLow()) {
      ctx.fillStyle = "rgba(20,10,4," + (a * 0.45) + ")";
      ctx.beginPath(); ctx.ellipse(0, 0, rx * 1.35, ry * 1.7, 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = "rgba(40,24,12," + a + ")";
    ctx.beginPath(); ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    if (air < 0.65) {
      const ca = 0.34 * (1 - air);
      [[wr, wrL], [wf, wfL]].forEach(function (pair) {
        const p = pair[0], loc = pair[1];
        const grounded = loc.y > -0.52;
        if (!grounded) return;
        ctx.save();
        ctx.fillStyle = "rgba(30,16,8," + ca + ")";
        ctx.beginPath();
        ctx.ellipse(wx(p.x), wy(p.y - CFG.WHEEL_R * 0.92), 0.32 * ppm, 0.11 * ppm, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      });
    }
  }

  function pushVfx(p) {
    const cap = fxIsLow() ? 24 : fxIsHigh() ? 110 : 55;
    vfx.push(p);
    if (vfx.length > cap) vfx.splice(0, vfx.length - cap);
  }
  function spawnVfx() {
    if (!car || st !== "play") return;
    const vel = car.chassis.getLinearVelocity();
    const gas = (car.gas || 0) > 0.08 && !reversing;
    const ang = car.chassis.getAngle();
    if (gas && Math.random() < (fxIsLow() ? 0.28 : 0.7)) {
      const ex = car.chassis.getWorldPoint({ x: -1.34, y: -0.12 });
      pushVfx({
        kind: "exhaust",
        x: ex.x, y: ex.y,
        vx: -Math.cos(ang) * (0.6 + Math.random() * 0.5) + vel.x * 0.15,
        vy: 0.2 + Math.random() * 0.4,
        life: 0.45 + Math.random() * 0.25,
        age: 0,
        r: 0.07 + Math.random() * 0.04
      });
    }
    const wheels = [car.rear && car.rear.body, car.front && car.front.body];
    const dustChance = fxIsLow() ? 0.22 : (0.35 + Math.min(0.5, (car.gas || 0) * 0.4 + Math.abs(vel.x) * 0.03));
    for (let w = 0; w < wheels.length; w++) {
      const body = wheels[w];
      if (!body) continue;
      const wr = body.getPosition();
      const wrL = car.chassis.getLocalPoint(wr);
      if (wrL.y > -0.52 && Math.abs(vel.x) > 1.2 && Math.random() < dustChance) {
        const dir = vel.x >= 0 ? -1 : 1;
        pushVfx({
          kind: "dust",
          x: wr.x + dir * 0.12, y: wr.y - CFG.WHEEL_R * 0.8,
          vx: dir * (0.5 + Math.random() * 0.8) + vel.x * 0.08,
          vy: 0.2 + Math.random() * 0.45,
          life: 0.32 + Math.random() * 0.28,
          age: 0,
          r: 0.09 + Math.random() * 0.08
        });
      }
    }
  }
  function spawnLandPuff(vy) {
    if (!car) return;
    const wr = car.rear.body.getPosition();
    const wf = car.front.body.getPosition();
    const power = Math.min(1.5, 0.45 + Math.abs(vy) * 0.16);
    const n = fxIsLow() ? 6 : (fxIsHigh() ? 18 : 12);
    for (let i = 0; i < n; i++) {
      const src = i % 2 ? wr : wf;
      pushVfx({
        kind: "puff",
        x: src.x + (Math.random() - 0.5) * 0.28,
        y: src.y - CFG.WHEEL_R * 0.7,
        vx: (Math.random() - 0.5) * 2.6 * power,
        vy: 0.5 + Math.random() * 1.3,
        life: 0.28 + Math.random() * 0.26,
        age: 0,
        r: 0.09 + Math.random() * 0.11 * power
      });
    }
    if (Math.abs(vy) > 3.2 && !fxIsLow()) {
      pushVfx({
        kind: "shock",
        x: (wr.x + wf.x) * 0.5,
        y: Math.min(wr.y, wf.y) - CFG.WHEEL_R * 0.85,
        vx: 0, vy: 0,
        life: 0.34, age: 0, r: 0.2 * power
      });
      for (let i = 0; i < (fxIsHigh() ? 10 : 6); i++) {
        pushVfx({
          kind: "spark",
          x: (wr.x + wf.x) * 0.5,
          y: Math.min(wr.y, wf.y) - CFG.WHEEL_R * 0.5,
          vx: (Math.random() - 0.5) * 3.6,
          vy: 1.6 + Math.random() * 3.0,
          life: 0.16 + Math.random() * 0.14,
          age: 0,
          r: 0.03
        });
      }
    }
  }
  function spawnDebris(n) {
    if (!car) return;
    const src = car.chassis.getPosition();
    const vel = car.chassis.getLinearVelocity();
    const count = fxIsLow() ? Math.min(3, 2 + n) : Math.min(12, 4 + n * 3);
    for (let i = 0; i < count; i++) {
      pushVfx({
        kind: "debris",
        x: src.x + (Math.random() - 0.5) * 0.5,
        y: src.y + 0.15 + Math.random() * 0.25,
        vx: vel.x * 0.25 + (Math.random() - 0.5) * 2.4,
        vy: vel.y * 0.2 + 1.1 + Math.random() * 2.2,
        rot: Math.random() * 6.28,
        rv: (Math.random() - 0.5) * 10,
        life: 0.65 + Math.random() * 0.45,
        age: 0,
        r: 0.045 + Math.random() * 0.05,
        tint: Math.random() > 0.45 ? "#c9a06a" : "#c45c36"
      });
    }
  }

  function stepVfx(dt) {
    spawnVfx();
    for (let i = vfx.length - 1; i >= 0; i--) {
      const p = vfx[i];
      p.age += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.kind === "debris" || p.kind === "spark" || p.kind === "confetti") p.vy -= 9 * dt;
      else if (p.kind === "shock") { /* ring expands via age */ }
      else p.vy += 0.35 * dt;
      if (p.rv) p.rot = (p.rot || 0) + p.rv * dt;
      if (p.age >= p.life) vfx.splice(i, 1);
    }
  }

  function drawVfx() {
    for (let i = 0; i < vfx.length; i++) {
      const p = vfx[i];
      const u = 1 - p.age / p.life;
      const cx = wx(p.x), cy = wy(p.y);
      if (p.kind === "spark") {
        ctx.strokeStyle = "rgba(255,210,120," + (0.85 * u) + ")";
        ctx.lineWidth = 1.4;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + p.vx * 4, cy - p.vy * 4);
        ctx.stroke();
        continue;
      }
      if (p.kind === "debris") {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(p.rot || 0);
        const s = p.r * ppm * 2.2;
        ctx.fillStyle = p.tint || "#c9a06a";
        ctx.globalAlpha = 0.85 * u;
        ctx.fillRect(-s * 0.5, -s * 0.3, s, s * 0.6);
        ctx.restore();
        continue;
      }
      if (p.kind === "shock") {
        const rr = (0.25 + (1 - u) * 1.4) * ppm;
        ctx.beginPath();
        ctx.ellipse(cx, cy, rr * 1.8, rr * 0.45, 0, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(255,244,220," + (0.55 * u) + ")";
        ctx.lineWidth = 3 * u + 1;
        ctx.stroke();
        continue;
      }
      if (p.kind === "confetti") {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(p.rot || 0);
        ctx.fillStyle = p.tint;
        ctx.globalAlpha = 0.9 * u;
        ctx.fillRect(-p.r * ppm, -p.r * ppm * 0.45, p.r * ppm * 2, p.r * ppm * 0.9);
        ctx.restore();
        continue;
      }
      const rr = p.r * ppm * (0.8 + (1 - u) * 1.6);
      ctx.beginPath();
      ctx.ellipse(cx, cy, rr * 1.25, rr * 0.72, 0, 0, Math.PI * 2);
      if (p.kind === "exhaust") ctx.fillStyle = "rgba(70,66,62," + (0.28 * u) + ")";
      else ctx.fillStyle = "rgba(196,150,96," + ((p.kind === "puff" ? 0.5 : 0.42) * u) + ")";
      ctx.fill();
    }
  }
  function spawnConfetti() {
    if (!car || fxIsLow()) return;
    const src = car.chassis.getPosition();
    const colors = ["#f2d45c", "#1f7a6f", "#f4f1ea", "#c45c36", "#8aaa52", "#fff4c8"];
    const n = 42;
    for (let i = 0; i < n; i++) {
      pushVfx({
        kind: "confetti",
        x: src.x + (Math.random() - 0.5) * 1.4,
        y: src.y + 0.4 + Math.random() * 0.6,
        vx: (Math.random() - 0.5) * 4.2,
        vy: 2.4 + Math.random() * 3.6,
        rot: Math.random() * 6.28,
        rv: (Math.random() - 0.5) * 12,
        life: 1.1 + Math.random() * 0.7,
        age: 0,
        r: 0.05 + Math.random() * 0.04,
        tint: colors[i % colors.length]
      });
    }
  }
  function drawSpeedLines() {
    if (fxIsLow() || !car || st !== "play") return;
    const v = car.chassis.getLinearVelocity();
    const sp = Math.abs(v.x);
    if (sp < 7) return;
    const a = Math.min(0.20, (sp - 7) / 16 * 0.20);
    const dir = v.x >= 0 ? 1 : -1;
    const p = car.chassis.getPosition();
    const cx = wx(p.x), cy = wy(p.y);
    ctx.save();
    ctx.strokeStyle = "rgba(255,244,220," + a + ")";
    ctx.lineWidth = 1.15;
    ctx.lineCap = "round";
    let seed = (Math.floor(tRun * 48) * 1103515245 + 12345) >>> 0;
    function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
    const n = fxIsHigh() ? 11 : 6;
    for (let i = 0; i < n; i++) {
      const ox = (rnd() - 0.25) * 200 * -dir;
      const oy = (rnd() - 0.5) * 78;
      const len = 16 + rnd() * 34;
      ctx.beginPath();
      ctx.moveTo(cx + ox, cy + oy);
      ctx.lineTo(cx + ox - dir * len, cy + oy);
      ctx.stroke();
    }
    ctx.restore();
  }
  function drawVignette() {
    if (fxIsLow()) return;
    const key = Math.round(viewW) + "x" + Math.round(viewH);
    if (vignetteKey !== key || !vignetteCanvas) {
      vignetteCanvas = document.createElement("canvas");
      vignetteCanvas.width = Math.max(2, Math.round(viewW));
      vignetteCanvas.height = Math.max(2, Math.round(viewH));
      const g = vignetteCanvas.getContext("2d");
      const cx = viewW * 0.5, cy = viewH * 0.42;
      const inner = Math.min(viewW, viewH) * 0.38;
      const outer = Math.max(viewW, viewH) * 0.74;
      const grd = g.createRadialGradient(cx, cy, inner, cx, cy, outer);
      grd.addColorStop(0, "rgba(20,12,8,0)");
      grd.addColorStop(0.55, "rgba(20,12,8,0.08)");
      grd.addColorStop(1, "rgba(8,4,2,0.42)");
      g.fillStyle = grd;
      g.fillRect(0, 0, viewW, viewH);
      vignetteKey = key;
    }
    ctx.drawImage(vignetteCanvas, 0, 0, viewW, viewH);
    if (fxIsLow()) return;
    const grade = ctx.createLinearGradient(0, 0, 0, viewH);
    grade.addColorStop(0, "rgba(90,150,210,0.08)");
    grade.addColorStop(0.45, "rgba(255,200,120,0.05)");
    grade.addColorStop(1, "rgba(80,30,10,0.14)");
    ctx.fillStyle = grade;
    ctx.fillRect(0, 0, viewW, viewH);
  }
  function drawBloom() {
    if (fxIsLow()) return;
    const horizon = meta ? wy(0) : viewH * 0.62;
    const sx = viewW * 0.82, sy = Math.max(36, horizon * 0.22);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const g = ctx.createRadialGradient(sx, sy, 4, sx, sy, 140);
    g.addColorStop(0, "rgba(255,240,180,0.22)");
    g.addColorStop(1, "rgba(255,200,100,0)");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(sx, sy, 140, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function drawVehicle() {
    if (!car) return;
    drawCarShadow();
    drawVfx();
    if (car.rear && car.rear.body) drawBuggyWheel(car.rear.body);
    if (car.front && car.front.body) drawBuggyWheel(car.front.body);
    drawSuspension();
    drawHull();
    drawRoofPanel();
    if (car.cargo) {
      car.cargo.forEach(function (c) { if (c && c.body) drawCargoPot(c.body); });
    }
  }

  function drawBody(body) {
    const xf = body.getTransform();
    for (let f = body.getFixtureList(); f; f = f.getNext()) {
      const ud = f.getUserData() || {};
      const shape = f.getShape();
      const kind = ud.kind || "";
      if (kind === "chassis" || kind === "ballast" || kind === "wheel" || kind === "roof" || kind === "pot") {
        continue; // 車體改由 drawVehicle 繪製
      } else if (kind === "ground" || kind === "loop" || kind === "wall" || kind === "endwall" || kind === "bowl" || kind === "ring") {
        drawShape(shape, xf, kind === "endwall" ? palette.dirtDark : palette.dirt, true);
      } else if (kind === "seesaw" || kind === "bridge" || kind === "plank" || kind === "crate") {
        drawShape(shape, xf, palette.wood, false);
      } else {
        drawShape(shape, xf, ud.color || "#888", false);
      }
    }
  }

  function xform(xf, v) {
    const c = Math.cos(xf.q.getAngle ? xf.q.getAngle() : (xf.q.s != null ? Math.atan2(xf.q.s, xf.q.c) : 0));
    const s = Math.sin(xf.q.getAngle ? xf.q.getAngle() : (xf.q.s != null ? Math.atan2(xf.q.s, xf.q.c) : 0));
    // planck Rot has c,s
    const rc = xf.q.c != null ? xf.q.c : c;
    const rs = xf.q.s != null ? xf.q.s : s;
    return { x: xf.p.x + rc * v.x - rs * v.y, y: xf.p.y + rs * v.x + rc * v.y };
  }

  function drawShape(shape, xf, color, isGround) {
    const typ = shape.getType && shape.getType();
    ctx.fillStyle = color;
    ctx.strokeStyle = isGround ? palette.dirtDark : "rgba(43,36,28,0.55)";
    ctx.lineWidth = isGround ? 3 : 1.2;
    if (typ === "circle") {
      const r = shape.getRadius();
      const p = xform(xf, shape.getVertex ? { x: 0, y: 0 } : (shape.m_p || { x: 0, y: 0 }));
      ctx.beginPath(); ctx.arc(wx(p.x), wy(p.y), r * ppm, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    } else if (typ === "edge" || typ === "chain") {
      // 地面剖面改由 drawTerrain 依路徑連續繪製，這裡略過以免重疊出接縫
      if (isGround) return;
      const n = typ === "edge" ? 2 : (shape.getVertexCount ? shape.getVertexCount() : (shape.m_vertices || []).length);
      if (n < 2) return;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const v = typ === "edge"
          ? (i === 0 ? (shape.getVertex1 ? shape.getVertex1() : shape.m_vertex1) : (shape.getVertex2 ? shape.getVertex2() : shape.m_vertex2))
          : (shape.getVertex ? shape.getVertex(i) : shape.m_vertices[i]);
        const p = xform(xf, v);
        if (i === 0) ctx.moveTo(wx(p.x), wy(p.y));
        else ctx.lineTo(wx(p.x), wy(p.y));
      }
      ctx.stroke();
    } else {
      // polygon / box（planck 1.5 沒有 getVertexCount，用 m_vertices）
      const verts = shape.m_vertices || [];
      const n = shape.m_count != null ? shape.m_count : verts.length;
      if (n < 3) return;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const v = verts[i];
        const p = xform(xf, v);
        if (i === 0) ctx.moveTo(wx(p.x), wy(p.y)); else ctx.lineTo(wx(p.x), wy(p.y));
      }
      ctx.closePath();
      if (isGround) {
        ctx.save();
        ctx.clip();
        const g = ctx.createLinearGradient(0, 0, 0, viewH);
        g.addColorStop(0, "#d6a45c");
        g.addColorStop(0.45, "#8a552e");
        g.addColorStop(1, "#4a2c1a");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, viewW, viewH);
        applyDirtPattern(0.22);
        ctx.restore();
        ctx.strokeStyle = "rgba(90,58,28,0.4)";
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  function drawWheel(body, xf, shape) {
    const r = shape.getRadius();
    const p = body.getPosition();
    const a = body.getAngle();
    const cx = wx(p.x), cy = wy(p.y), rr = r * ppm;
    ctx.fillStyle = palette.wheel;
    ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#111"; ctx.lineWidth = 2; ctx.stroke();
    ctx.strokeStyle = palette.hub; ctx.lineWidth = 2;
    for (let i = 0; i < 4; i++) {
      const ang = a + i * Math.PI * 0.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(ang) * rr * 0.78, cy - Math.sin(ang) * rr * 0.78);
      ctx.stroke();
    }
    ctx.fillStyle = palette.hub;
    ctx.beginPath(); ctx.arc(cx, cy, rr * 0.28, 0, Math.PI * 2); ctx.fill();
  }

  function drawFlag() {
    if (!meta) return;
    const g = meta.goal;
    const x = wx(g.x + 0.3), y0 = wy(g.y), y1 = wy(g.y + 2.6);
    ctx.strokeStyle = palette.ink; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
    ctx.fillStyle = palette.flag;
    ctx.beginPath();
    ctx.moveTo(x, y1);
    ctx.lineTo(x + 28, y1 + 12);
    ctx.lineTo(x, y1 + 24);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = "rgba(31,122,111,0.18)";
    ctx.fillRect(wx(g.x), wy(g.y + g.h), g.w * ppm, g.h * ppm);
  }

  function drawProceduralProp(kind, x, y, scale) {
    const sx = wx(x), sy = wy(y);
    ctx.save();
    ctx.translate(sx, sy);
    ctx.scale(scale, scale);
    if (kind === "tree" || kind === "pine") {
      ctx.fillStyle = "#5a3a22";
      ctx.fillRect(-4, -8, 8, 10);
      if (kind === "pine") {
        ctx.fillStyle = "#2f5a28";
        for (let i = 0; i < 3; i++) {
          ctx.beginPath();
          ctx.moveTo(0, -88 + i * 18);
          ctx.lineTo(28 - i * 5, -36 + i * 16);
          ctx.lineTo(-28 + i * 5, -36 + i * 16);
          ctx.closePath(); ctx.fill();
        }
      } else {
        ctx.fillStyle = "#3f7a30";
        ctx.beginPath(); ctx.ellipse(0, -46, 32, 28, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#2f5e24";
        ctx.beginPath(); ctx.ellipse(-14, -36, 18, 16, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#6aa844";
        ctx.beginPath(); ctx.ellipse(12, -52, 16, 14, 0, 0, Math.PI * 2); ctx.fill();
      }
    } else if (kind === "bush") {
      ctx.fillStyle = "#3d6a28";
      ctx.beginPath(); ctx.ellipse(0, -10, 22, 14, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#5e9440";
      ctx.beginPath(); ctx.ellipse(-10, -14, 12, 9, 0, 0, Math.PI * 2); ctx.fill();
    } else if (kind === "fence") {
      ctx.fillStyle = "#7a5230";
      ctx.fillRect(-22, -22, 5, 22);
      ctx.fillRect(16, -22, 5, 22);
      ctx.fillRect(-24, -18, 46, 4);
      ctx.fillRect(-24, -10, 46, 4);
    } else if (kind === "lamp") {
      ctx.fillStyle = "#3a3a40";
      ctx.fillRect(-2, -46, 4, 46);
      ctx.fillRect(-10, -50, 20, 5);
      if (!fxIsLow()) {
        const lg = ctx.createRadialGradient(0, -48, 2, 0, -48, 36);
        lg.addColorStop(0, "rgba(255,220,140,0.55)");
        lg.addColorStop(1, "rgba(255,200,100,0)");
        ctx.fillStyle = lg;
        ctx.beginPath(); ctx.arc(0, -48, 36, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = "#ffe7a0";
      ctx.beginPath(); ctx.arc(0, -48, 5, 0, Math.PI * 2); ctx.fill();
    } else if (kind === "sign") {
      ctx.fillStyle = "#5a3a22";
      ctx.fillRect(-2, -34, 4, 34);
      ctx.fillStyle = "#c9a06a";
      ctx.fillRect(-16, -48, 32, 18);
      ctx.strokeStyle = "#5a3a22";
      ctx.lineWidth = 2;
      ctx.strokeRect(-16, -48, 32, 18);
      ctx.beginPath();
      ctx.moveTo(-6, -39); ctx.lineTo(6, -39); ctx.lineTo(2, -43);
      ctx.moveTo(6, -39); ctx.lineTo(2, -35);
      ctx.stroke();
    }
    ctx.restore();
  }
  function drawRoadsideProps() {
    if (!meta || !meta.paths || fxIsLow()) return;
    const kinds = ["tree", "bush", "pine", "fence", "lamp", "sign", "tree", "bush"];
    const viewL = camX - 3 - viewW / ppm;
    const viewR = camX + 3 + viewW / ppm;
    for (let pi = 0; pi < meta.paths.length; pi++) {
      const path = meta.paths[pi];
      if (path.length < 2) continue;
      let acc = 0;
      for (let i = 0; i < path.length - 1; i++) {
        const a = path[i], b = path[i + 1];
        const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
        const slope = Math.abs(dy) / Math.max(0.001, Math.abs(dx));
        const x0 = acc;
        acc += len;
        if (slope > 0.55) continue;
        for (let s = Math.ceil((x0 + 0.4) / 3.6) * 3.6; s < acc - 0.4; s += 3.6) {
          const u = (s - x0) / len;
          const x = a.x + dx * u, y = a.y + dy * u;
          if (x < viewL || x > viewR) continue;
          if (meta.spawn && Math.abs(x - meta.spawn.x) < 3.2) continue;
          if (meta.goal && x > meta.goal.x - 1.2 && x < meta.goal.x + meta.goal.w + 1.5) continue;
          const h = hash01(((x * 10) | 0) * 17 + pi * 13);
          if (h < 0.22) continue;
          const kind = kinds[((h * 80) | 0) % kinds.length];
          const sc = 0.85 + hash01(((x * 7) | 0) + 3) * 0.45;
          const img = propImgs[kind];
          if (spriteOk(img)) {
            const ih = img.naturalHeight || img.height;
            const iw = img.naturalWidth || img.width;
            const ph = (kind === "bush" || kind === "fence" ? 0.85 : 2.15) * sc * ppm;
            const pw = ph * (iw / Math.max(1, ih));
            ctx.drawImage(img, wx(x) - pw * 0.5, wy(y) - ph + 2, pw, ph);
          } else {
            drawProceduralProp(kind, x, y, sc * (ppm / 42));
          }
        }
      }
    }
  }
  function drawForeground() {
    if (fxIsLow()) return;
    const shift = -(((camX * ppm * 1.12) % 260) + 260) % 260;
    ctx.beginPath();
    ctx.moveTo(shift - 20, viewH + 4);
    for (let x = shift - 20; x <= viewW + 40; x += 14) {
      const h = 16 + Math.abs(Math.sin((x - shift) * 0.08)) * 18
        + Math.abs(Math.sin((x - shift) * 0.17 + 2)) * 10;
      ctx.lineTo(x, viewH - h);
    }
    ctx.lineTo(viewW + 40, viewH + 4);
    ctx.closePath();
    ctx.fillStyle = "rgba(12,22,8,0.42)";
    ctx.fill();
  }
  function draw() {
    updateVisualZoom();
    ctx.save();
    if (shakeX || shakeY) ctx.translate(shakeX, shakeY);
    drawSky();
    if (!world) {
      drawMenuGround();
      ctx.restore();
      drawVignette();
      return;
    }
    updateCam(CFG.TICK);
    drawTerrain();
    drawRoadsideProps();
    drawFlag();
    for (let b = world.getBodyList(); b; b = b.getNext()) drawBody(b);
    drawVehicle();
    drawForeground();
    drawSpeedLines();
    ctx.restore();
    drawVignette();
    drawBloom();
    if (DEBUG && car) {
      const p = car.chassis.getPosition();
      const v = car.chassis.getLinearVelocity();
      ctx.fillStyle = "rgba(43,36,28,0.8)";
      ctx.font = "12px monospace";
      ctx.textAlign = "left";
      ctx.fillText(
        "x " + p.x.toFixed(2) + " y " + p.y.toFixed(2) +
        " vx " + v.x.toFixed(2) + " t " + tRun.toFixed(2) +
        " fps " + fpsNow.toFixed(0) + " broke " + brokenCount,
        12, viewH - 8
      );
    }
  }

  // ---------- 畫面流程 ----------
  const el = {
    menu: document.getElementById("sheetMenu"),
    pause: document.getElementById("sheetPause"),
    result: document.getElementById("sheetResult"),
    hud: document.getElementById("hud"),
    hudTitle: document.getElementById("hudTitle"),
    hudSub: document.getElementById("hudSub"),
    controls: document.getElementById("controls"),
    hint: document.getElementById("hintBar"),
    count: document.getElementById("count"),
    levelList: document.getElementById("levelList"),
    resultTitle: document.getElementById("resultTitle"),
    resultBody: document.getElementById("resultBody"),
    btnNext: document.getElementById("btnNext")
  };

  function setSheet(name) {
    el.menu.classList.toggle("on", name === "menu");
    el.pause.classList.toggle("on", name === "pause");
    el.result.classList.toggle("on", name === "result");
  }

  function starText(n) {
    n = n || 0;
    return "★".repeat(n) + "☆".repeat(Math.max(0, 3 - n));
  }

  function renderMenu() {
    el.levelList.innerHTML = "";
    LEVELS.forEach(function (L) {
      const btn = document.createElement("button");
      const locked = L.id > store.unlocked && !DEBUG && !AUTO_BOT;
      if (locked) btn.classList.add("locked");
      const stars = store.stars[L.id] || 0;
      const best = store.bestTime[L.id];
      btn.innerHTML = "<div class='n'>" + L.id + "　" + L.name + "</div>" +
        "<div class='s'><span class='stars'>" + (stars ? starText(stars) : "尚未通過") + "</span>" +
        (best != null ? "　最佳 " + best.toFixed(2) + " 秒" : "") + "</div>";
      btn.disabled = !!locked;
      btn.addEventListener("click", function () { if (!locked) startLevel(L.id); });
      el.levelList.appendChild(btn);
    });
  }

  function showMenu() {
    st = "menu";
    botMode = false;
    setSheet("menu");
    el.hud.hidden = true;
    el.controls.classList.remove("on");
    el.hint.classList.remove("on");
    el.count.classList.remove("on");
    renderMenu();
    destroyWorld();
    syncPauseBtn();
  }

  function startLevel(id, opts) {
    opts = opts || {};
    setupLevel(id, opts);
    st = "countdown";
    countN = CFG.COUNTDOWN_S;
    countT = 0;
    setSheet("");
    el.hud.hidden = false;
    el.hudTitle.textContent = level.id + "　" + level.name;
    el.hudSub.textContent = "準備";
    el.controls.classList.add("on");
    el.hint.textContent = level.hint;
    el.hint.classList.add("on");
    el.count.classList.add("on");
    el.count.textContent = String(countN);
    gasHeld = false; brakeHeld = false;
    gasStrength = 0; brakeStrength = 0;
    gasSlideLock = false; brakeSlideLock = false;
    syncPedals();
    if (opts.bot) botMode = true;
    if (AUTO_BOT) botMode = true;
    audio.wasAir = false;
    audio.lastSkidAt = 0;
    audio.lastLandAt = 0;
    syncPauseBtn();
  }

  function beginPlay() {
    st = "play";
    el.count.classList.remove("on");
    el.hudSub.textContent = "0.00 秒";
    inputAt = 0; motorAt = 0;
  }

  function showPause() {
    if (st !== "play" && st !== "countdown") return;
    st = "pause";
    setSheet("pause");
    document.getElementById("pauseHint").textContent = level.hint;
    el.controls.classList.remove("on");
    syncPauseBtn();
  }
  function resumePlay() {
    if (st !== "pause") return;
    setSheet("");
    el.controls.classList.add("on");
    beginPlay();
  }

  function showResult() {
    setSheet("result");
    el.controls.classList.remove("on");
    el.count.classList.remove("on");
    const r = result;
    el.resultTitle.textContent = r.ok ? "穩當到達" : "這次沒過";
    const lines = [];
    if (r.ok) {
      lines.push("時間 " + r.time.toFixed(2) + " 秒　" + starText(r.stars));
      if (level.cargo) lines.push(r.cargoOk ? "陶罐平安。" : "陶罐沒保住。");
      lines.push(r.partsOk ? "車身零件都還在。" : ("掉了 " + r.broken + " 件。"));
    } else {
      lines.push(r.reason + "。");
      lines.push("用過 " + r.time.toFixed(2) + " 秒。");
    }
    el.resultBody.innerHTML = lines.join("<br>");
    const hasNext = r.ok && level.id < LEVELS.length;
    el.btnNext.style.display = hasNext ? "" : "none";
    el.hudSub.textContent = r.ok ? ("完成　" + r.time.toFixed(2) + " 秒") : r.reason;
    syncPauseBtn();
  }

  function offerRewardRetry() {
    hideContinueBtn();
    pendingShowAdFn = null;
    rewardGranted = false;
    if (continueUsed || !adsWanted() || (result && result.ok)) return;
    safeAdBreak({
      type: "reward",
      name: "retry-level",
      beforeReward: function (showAdFn) {
        pendingShowAdFn = showAdFn;
        showContinueBtn();
      },
      beforeAd: pauseForAd,
      afterAd: resumeAfterAd,
      adDismissed: function () { rewardGranted = false; hideContinueBtn(); },
      adViewed: function () { rewardGranted = true; },
      adBreakDone: function (info) {
        lastPlacementInfo = info;
        resumeAfterAd();
        pendingShowAdFn = null;
        if (rewardGranted && !continueUsed) {
          rewardGranted = false;
          hideContinueBtn();
          continueUsed = true;
          startLevel(level.id, { keepContinueUsed: true, bot: botMode });
        } else {
          hideContinueBtn();
        }
      }
    });
  }

  function clickContinueAd() {
    if (!pendingShowAdFn || continueUsed || adsPaused) return false;
    const fn = pendingShowAdFn;
    pendingShowAdFn = null;
    hideContinueBtn();
    fn();
    return true;
  }

  function goNextOrMenu() {
    const nxt = level && level.id < LEVELS.length ? level.id + 1 : null;
    function go() {
      resumeAfterAd();
      if (nxt) startLevel(nxt, { bot: AUTO_BOT });
      else showMenu();
    }
    adCompletedRuns += 1;
    const every = Math.max(1, CFG.ADS_INTERSTITIAL_EVERY || 3);
    if (!(adsWanted() && adCompletedRuns % every === 0)) { go(); return; }
    let started = false;
    safeAdBreak({
      type: "next",
      name: "next-level",
      beforeAd: pauseForAd,
      afterAd: resumeAfterAd,
      adBreakDone: function (info) {
        lastPlacementInfo = info;
        if (started) return;
        started = true;
        go();
      }
    });
  }

  // ---------- 迴圈 ----------
  function loop(ts) {
    const frameDt = Math.min(0.05, ((ts - lastTs) / 1000) || 0);
    lastTs = ts;
    if (frameDt > 0) {
      fpsSamples.push(frameDt);
      if (fpsSamples.length > 30) fpsSamples.shift();
      if (!lastFpsTs || ts - lastFpsTs > 250) {
        const sum = fpsSamples.reduce(function (a, b) { return a + b; }, 0);
        fpsNow = sum > 0 ? fpsSamples.length / sum : 60;
        lastFpsTs = ts;
      }
    }
    if (!adsPaused) {
      if (st === "countdown") {
        acc += frameDt;
        while (acc >= CFG.TICK) {
          stepSim(CFG.TICK); // 靜止穩定用
          acc -= CFG.TICK;
          countT += CFG.TICK;
        }
        if (countT >= 1) {
          countT -= 1;
          countN -= 1;
          if (countN <= 0) beginPlay();
          else el.count.textContent = String(countN);
        }
      } else if (st === "play") {
        acc += frameDt;
        let n = 0;
        while (acc >= CFG.TICK && n < 5) {
          stepSim(CFG.TICK);
          acc -= CFG.TICK;
          n++;
        }
        if (n >= 5) acc = 0;
        if (st === "play") el.hudSub.textContent = tRun.toFixed(2) + " 秒"
          + (level.cargo ? (cargoLost ? "　陶罐已掉" : "　陶罐還在") : "")
          + (brokenCount ? "　零件 " + brokenCount : "");
      } else {
        acc = 0;
      }
    }
    syncPedals();
    tickGameAudio();
    stepShake(frameDt);
    tickFxQuality();
    draw();
    requestAnimationFrame(loop);
  }

  // ---------- 輸入 ----------
  function pedalSegment(s) {
    if (s <= 0.001) return 0;
    if (s < 0.50) return 1;
    if (s < 0.75) return 2;
    if (s < 0.999) return 3;
    return 4;
  }
  function hapticSeg(prev, next) {
    if (next === prev || next <= 0) return;
    try {
      if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(next > prev ? 12 : 8);
    } catch (e) {}
  }
  function applySegDots(root, n) {
    if (!root) return;
    const dots = root.querySelectorAll("i");
    for (let i = 0; i < dots.length; i++) dots[i].classList.toggle("on", i < n);
  }
  function syncPedals() {
    const gBtn = document.getElementById("btnGas");
    const bBtn = document.getElementById("btnBrake");
    if (gBtn) gBtn.classList.toggle("held", gasHeld || gasStrength > 0.02);
    if (bBtn) bBtn.classList.toggle("held", brakeHeld || brakeStrength > 0.02);
    const gFill = document.getElementById("gasFill");
    const bFill = document.getElementById("brakeFill");
    if (gFill) gFill.style.height = (Math.max(0, Math.min(1, gasStrength)) * 100).toFixed(1) + "%";
    if (bFill) bFill.style.height = (Math.max(0, Math.min(1, brakeStrength)) * 100).toFixed(1) + "%";
    const gSeg = pedalSegment(gasStrength);
    const bSeg = pedalSegment(brakeStrength);
    applySegDots(document.getElementById("gasSegs"), gSeg);
    applySegDots(document.getElementById("brakeSegs"), bSeg);
    applySegDots(document.getElementById("hudGas"), gSeg);
    applySegDots(document.getElementById("hudBrake"), bSeg);
  }
  function stepOnePedal(cur, held, slideLock, dt) {
    if (held) {
      if (slideLock) return cur;
      if (cur < CFG.PEDAL_TOUCH) return CFG.PEDAL_TOUCH;
      const rate = (1 - CFG.PEDAL_TOUCH) / CFG.PEDAL_RAMP_UP;
      return Math.min(1, cur + rate * dt);
    }
    if (cur <= 0) return 0;
    return Math.max(0, cur - (1 / CFG.PEDAL_RAMP_DOWN) * dt);
  }
  function noteSegChange(kind, next) {
    const held = kind === "gas" ? gasHeld : brakeHeld;
    if (kind === "gas") {
      if (held) hapticSeg(gasSegPrev, next);
      gasSegPrev = next;
    } else {
      if (held) hapticSeg(brakeSegPrev, next);
      brakeSegPrev = next;
    }
  }
  function updatePedalStrength(dt) {
    const g0 = gasStrength, b0 = brakeStrength;
    gasStrength = stepOnePedal(gasStrength, gasHeld, gasSlideLock, dt);
    brakeStrength = stepOnePedal(brakeStrength, brakeHeld, brakeSlideLock, dt);
    if (gasStrength !== g0) noteSegChange("gas", pedalSegment(gasStrength));
    if (brakeStrength !== b0) noteSegChange("brake", pedalSegment(brakeStrength));
  }
  function setPedal(kind, on, opts) {
    opts = opts || {};
    const isGas = kind === "gas";
    const held = isGas ? gasHeld : brakeHeld;
    if (on && !held) {
      inputAt = performance.now();
      if (isGas) { gasStrength = CFG.PEDAL_TOUCH; gasSlideLock = false; }
      else { brakeStrength = CFG.PEDAL_TOUCH; brakeSlideLock = false; }
      noteSegChange(kind, pedalSegment(CFG.PEDAL_TOUCH));
    }
    if (on && opts.slide) {
      const s = Math.max(0, Math.min(1, +opts.strength));
      if (isGas) { gasStrength = s; gasSlideLock = true; }
      else { brakeStrength = s; brakeSlideLock = true; }
      noteSegChange(kind, pedalSegment(s));
    }
    if (!on) {
      if (isGas) gasSlideLock = false;
      else brakeSlideLock = false;
    }
    if (isGas) gasHeld = !!on;
    else brakeHeld = !!on;
    syncPedals();
    if (st === "play" && car && !adsPaused && !botMode) {
      car.gas = gasStrength;
      car.brake = brakeStrength;
      updateRevState(0);
      applyDrive(car);
      if (on) motorAt = performance.now();
    }
  }
  function setGas(v) { setPedal("gas", !!v); }
  function setBrake(v) { setPedal("brake", !!v); }

  function bindPedal(btn, kind) {
    let pid = null, startY = 0, slid = false;
    function travel() {
      const h = btn.getBoundingClientRect().height;
      return Math.max(72, h);
    }
    function applySlide(ev) {
      const dy = startY - ev.clientY; // 上滑加力、下滑減力
      if (!slid && Math.abs(dy) < 8) return;
      slid = true;
      const s = Math.max(0, Math.min(1, CFG.PEDAL_TOUCH + dy / travel() * (1 - CFG.PEDAL_TOUCH)));
      setPedal(kind, true, { slide: true, strength: s });
    }
    btn.addEventListener("pointerdown", function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      pid = ev.pointerId;
      startY = ev.clientY;
      slid = false;
      try { btn.setPointerCapture(ev.pointerId); } catch (e) {}
      setPedal(kind, true);
    });
    btn.addEventListener("pointermove", function (ev) {
      if (pid == null || ev.pointerId !== pid) return;
      ev.preventDefault();
      applySlide(ev);
    });
    function release(ev) {
      if (pid == null || (ev && ev.pointerId !== pid)) return;
      if (ev) ev.preventDefault();
      try { btn.releasePointerCapture(pid); } catch (e) {}
      pid = null;
      slid = false;
      setPedal(kind, false);
    }
    btn.addEventListener("pointerup", release);
    btn.addEventListener("pointercancel", release);
  }
  bindPedal(document.getElementById("btnGas"), "gas");
  bindPedal(document.getElementById("btnBrake"), "brake");

  window.addEventListener("keydown", function (ev) {
    if (ev.target && ev.target.closest && ev.target.closest("button, input, #adFake")) return;
    if (ev.repeat) return;
    if (ev.code === "ArrowRight" || ev.code === "KeyD" || ev.code === "ArrowUp" || ev.code === "KeyW") { ev.preventDefault(); setGas(true); }
    if (ev.code === "ArrowLeft" || ev.code === "KeyA" || ev.code === "ArrowDown" || ev.code === "KeyS" || ev.code === "Space") { ev.preventDefault(); setBrake(true); }
    if (ev.code === "Escape") { ev.preventDefault(); if (st === "play") showPause(); }
  });
  window.addEventListener("keyup", function (ev) {
    if (ev.code === "ArrowRight" || ev.code === "KeyD" || ev.code === "ArrowUp" || ev.code === "KeyW") setGas(false);
    if (ev.code === "ArrowLeft" || ev.code === "KeyA" || ev.code === "ArrowDown" || ev.code === "KeyS" || ev.code === "Space") setBrake(false);
  });
  window.addEventListener("contextmenu", function (ev) { ev.preventDefault(); });
  window.addEventListener("blur", function () { setGas(false); setBrake(false); });

  window.addEventListener("pointerdown", function () { unlockAudio(); }, true);
  window.addEventListener("keydown", function () { unlockAudio(); }, true);
  document.getElementById("btnMute").addEventListener("click", function (ev) {
    ev.preventDefault();
    ev.stopPropagation();
    unlockAudio();
    if (!store.muted) playSfx("tap");
    setMuted(!store.muted);
  });
  document.getElementById("btnMute").addEventListener("pointerdown", function (ev) { ev.stopPropagation(); });
  document.addEventListener("click", function (ev) {
    const btn = ev.target && ev.target.closest && ev.target.closest("button");
    if (!btn || btn.id === "btnGas" || btn.id === "btnBrake" || btn.id === "btnMute") return;
    unlockAudio();
    playSfx("tap");
  });
  document.getElementById("btnPause").addEventListener("click", showPause);
  document.getElementById("btnResume").addEventListener("click", resumePlay);
  document.getElementById("btnRetryPause").addEventListener("click", function () { startLevel(level.id); });
  document.getElementById("btnMenuPause").addEventListener("click", showMenu);
  document.getElementById("btnRetry").addEventListener("click", function () { startLevel(level.id); });
  document.getElementById("btnMenu").addEventListener("click", showMenu);
  document.getElementById("btnNext").addEventListener("click", goNextOrMenu);
  document.getElementById("adContinueBtn").addEventListener("click", function (ev) {
    ev.preventDefault(); ev.stopPropagation(); clickContinueAd();
  });
  document.getElementById("adContinueBtn").addEventListener("pointerdown", function (ev) { ev.stopPropagation(); });

  // ---------- 無頭檢查 ----------
  function beatLevel(id, opts) {
    opts = opts || {};
    const L = levelById(id);
    const saved = { st: st, botMode: botMode, gasHeld: gasHeld, brakeHeld: brakeHeld, gasStrength: gasStrength, brakeStrength: brakeStrength };
    setupLevel(id, {});
    botMode = true;
    st = "play";
    const limit = opts.limit || 90;
    const maxSteps = Math.ceil(limit / CFG.TICK);
    let ok = false, reason = "逾時", time = 0;
    for (let i = 0; i < maxSteps; i++) {
      stepSim(CFG.TICK);
      time = tRun;
      if (st === "result") {
        ok = !!(result && result.ok);
        reason = result ? result.reason : reason;
        break;
      }
    }
    const out = {
      id: L.id, name: L.name, ok: ok, reason: reason, time: time,
      stars: result && result.ok ? result.stars : 0,
      cargoOk: result ? result.cargoOk : true,
      partsOk: result ? result.partsOk : true,
      broken: brokenCount
    };
    // 恢復選單狀態，避免檢查污染畫面
    botMode = saved.botMode;
    gasHeld = saved.gasHeld; brakeHeld = saved.brakeHeld;
    gasStrength = saved.gasStrength; brakeStrength = saved.brakeStrength;
    st = "menu";
    destroyWorld();
    return out;
  }

  function beatAll() {
    const rows = [];
    for (let i = 0; i < LEVELS.length; i++) rows.push(beatLevel(LEVELS[i].id));
    return { ok: rows.every(function (r) { return r.ok; }), rows: rows };
  }

  window.__WENDANG__ = {
    CFG: CFG,
    LEVELS: LEVELS.map(function (L) {
      return { id: L.id, name: L.name, hint: L.hint, par3: L.par3, par2: L.par2, cargo: !!L.cargo };
    }),
    startLevel: startLevel,
    showMenu: showMenu,
    beatLevel: beatLevel,
    beatAll: beatAll,
    traceLevel: function (id, seconds) {
      setupLevel(id, {});
      botMode = true;
      st = "play";
      const samples = [];
      const max = Math.ceil((seconds || 12) / CFG.TICK);
      for (let i = 0; i < max; i++) {
        stepSim(CFG.TICK);
        if (i % 15 === 0 || st === "result") {
          const p = car.chassis.getPosition();
          const v = car.chassis.getLinearVelocity();
          samples.push({ t: tRun, x: p.x, y: p.y, vx: v.x, vy: v.y, ang: car.chassis.getAngle(), gas: gasHeld, brake: brakeHeld, gasStrength: gasStrength, brakeStrength: brakeStrength, st: st, broken: brokenCount });
        }
        if (st === "result") break;
      }
      const kinds = (car && car.breakables ? car.breakables : []).filter(function (it) { return it.broken; }).map(function (it) { return it.kind; });
      const out = { samples: samples, result: result, broken: brokenCount, brokenKinds: kinds };
      botMode = false;
      st = "menu";
      destroyWorld();
      return out;
    },
    get: function () {
      const p = car && car.chassis ? car.chassis.getPosition() : { x: 0, y: 0 };
      const v = car && car.chassis ? car.chassis.getLinearVelocity() : { x: 0, y: 0 };
      return {
        st: st, tRun: tRun, level: level && level.id, name: level && level.name,
        x: p.x, y: p.y, vx: v.x, vy: v.y, gas: gasHeld, brake: brakeHeld,
        gasStrength: gasStrength, brakeStrength: brakeStrength,
        gasSeg: pedalSegment(gasStrength), brakeSeg: pedalSegment(brakeStrength),
        broken: brokenCount, cargoLost: cargoLost, fps: fpsNow,
        result: result, adsPaused: adsPaused, reversing: !!reversing,
        revReady: !!revReady, revHoldT: revHoldT,
        cam: camFraming()
      };
    },
    pressGas: function (v, s) {
      if (s != null) setPedal("gas", !!v, { slide: true, strength: +s });
      else setGas(!!v);
    },
    pressBrake: function (v, s) {
      if (s != null) setPedal("brake", !!v, { slide: true, strength: +s });
      else setBrake(!!v);
    },
    endRun: function (ok, reason) {
      finishRun(!!ok, reason || (ok ? "穩當到達" : "測試結束"));
    },
    clickContinueAd: clickContinueAd,
    beginPlay: beginPlay,
    inputLatency: function () { return { inputAt: inputAt, motorAt: motorAt, ms: (motorAt && inputAt) ? (motorAt - inputAt) : null }; },
    adsState: function () {
      return {
        wanted: adsWanted(), fake: FAKE_AD, enabled: !!CFG.ADS_ENABLED, testMode: !!CFG.ADS_TEST_MODE,
        client: CFG.ADS_CLIENT || "", paused: !!adsPaused, continueUsed: !!continueUsed,
        offered: !!adContinueOffered, completedRuns: adCompletedRuns,
        lastPlacement: lastPlacementInfo, soundMuted: !!adsSoundMuted
      };
    },
    clickContinueAd: clickContinueAd,
    offerRewardRetry: offerRewardRetry,
    goNextOrMenu: goNextOrMenu,
    store: function () { return JSON.parse(JSON.stringify(store)); },
    resetStore: function () {
      store = { stars: {}, bestTime: {}, unlocked: 1, muted: !!(store && store.muted) };
      saveStore();
      syncMuteBtn();
      renderMenu();
    }
  };

  // boot
  function onViewport() { layout(); }
  window.addEventListener("resize", onViewport);
  window.addEventListener("orientationchange", onViewport);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", onViewport);
    window.visualViewport.addEventListener("scroll", onViewport);
  }
  layout();
  renderMenu();
  syncMuteBtn();
  syncPauseBtn();
  installAdsTag();
  lastTs = performance.now();
  requestAnimationFrame(loop);
  if (START_LEVEL >= 1) startLevel(START_LEVEL, { bot: AUTO_BOT });
  else showMenu();
})();
