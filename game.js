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

  const URL_PARAMS = new URLSearchParams((location.search || "").replace(/^\?/, ""));
  const DEBUG = URL_PARAMS.get("debug") === "1";
  const FAKE_AD = URL_PARAMS.get("fakead") === "1";
  const ADS_FORCE = (URL_PARAMS.get("ads") || "").toLowerCase().trim();
  const START_LEVEL = parseInt(URL_PARAMS.get("level") || "", 10);
  const AUTO_BOT = URL_PARAMS.get("bot") === "1";

  const STORE_KEY = "wendangLushi.v1";
  const CAT = { GROUND: 0x0001, CAR: 0x0002, CARGO: 0x0004, PROP: 0x0008 };

  const palette = {
    skyTop: "#f7edd9",
    skyHorizon: "#f0c9a0",
    dirt: "#c48a4a",
    dirtDark: "#8a5a2e",
    grass: "#6f9444",
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
        unlocked: s.unlocked || 1
      };
    } catch (e) {
      return { stars: {}, bestTime: {}, unlocked: 1 };
    }
  }
  function saveStore() {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  }
  let store = loadStore();

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
  }
  function resumeAfterAd() {
    adsPaused = false;
    adsSoundMuted = false;
    hideFakeAd();
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
      finish() { flush(); return { spawn: spawn, goal: goal, killY: killY, ground: groundBody, props: props, endX: x, endY: y }; }
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
        { x: 0, v: 3.8 }, { x: 10, v: 3.4 }, { x: 20, v: 3.3 }, { x: 32, v: 3.4 },
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
    const chassisVerts = [
      { x: -1.15, y: -0.28 }, { x: 1.25, y: -0.28 }, { x: 1.32, y: 0.08 },
      { x: 0.35, y: 0.22 }, { x: -0.15, y: 0.72 }, { x: -0.95, y: 0.72 }, { x: -1.22, y: 0.12 }
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
    const roof = world.createBody({ type: "dynamic", position: { x: x - 0.45, y: y + 0.78 } });
    const fxR = roof.createFixture({
      shape: new pl.Box(0.46, 0.08),
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
    const rear = makeWheel(x - 0.82, CFG.TORQUE_REAR);
    const front = makeWheel(x + 0.88, CFG.TORQUE_FRONT);

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
    const brake = !!car.brake, gas = !!car.gas;
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
    const gas = car.gas, brake = car.brake;
    let speed = 0, torque = 0, enable = true, perWheel = false;
    if (gas && !brake) {
      speed = -CFG.MOTOR_SPEED;
      perWheel = true;
    } else if (brake && !gas && reversing) {
      speed = CFG.MOTOR_SPEED * 0.7;
      perWheel = true;
    } else if (brake) {
      // 真正的煞車：馬達速度 0、高扭力把車輪剎住
      speed = 0;
      torque = CFG.BRAKE_TORQUE * (gas ? 1.05 : 1);
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
        w.joint.setMaxMotorTorque(perWheel ? w.torque : torque);
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
  let reversing = false, revHoldT = 0, revReady = false, brakePrev = false;
  let vfx = [];
  let camX = 0, camY = 1.2, camAx = 0.33, camAy = 0.56, result = null;
  let brokenCount = 0, cargoLost = false;
  let acc = 0, lastTs = 0;
  let inputAt = 0, motorAt = 0; // 延遲量測
  let fpsSamples = [], lastFpsTs = 0, fpsNow = 60;
  let botMode = false;

  const canvas = document.getElementById("c");
  const ctx = canvas.getContext("2d", { alpha: false });
  let viewW = 800, viewH = 450, ppm = 42;

  function layout() {
    const vv = window.visualViewport;
    const w = Math.max(1, (vv && vv.width) || window.innerWidth || 800);
    const h = Math.max(1, (vv && vv.height) || window.innerHeight || 450);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    viewW = w; viewH = h;
    if (h > w * 1.15) {
      // 直式手機：略為拉近，讓車體更大，同時還留得出前方路面
      ppm = Math.max(44, Math.min(54, w / 8.3));
    } else {
      ppm = Math.max(36, Math.min(56, Math.min(w / 15.5, h / 9.5)));
    }
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
    if (car) { car.gas = 0; car.brake = 0; }
    resetDriveState();
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
    showResult();
    if (!ok) offerRewardRetry();
  }

  // ---------- 逐步模擬 ----------
  function stepSim(dt) {
    if (!world || !car) return;
    if (st === "play") {
      tRun += dt;
      car.gas = gasHeld ? 1 : 0;
      car.brake = brakeHeld ? 1 : 0;
      if (botMode) applyBot();
      updateRevState(dt);
      applyDrive(car);
      stepVfx(dt);
      if (motorAt === 0 && (car.gas || car.brake)) motorAt = performance.now();
    } else {
      car.gas = 0; car.brake = 0;
      updateRevState(dt);
      applyDrive(car);
    }
    world.step(dt, CFG.VEL_IT, CFG.POS_IT);
    world.clearForces();
    if (tImmune > 0) tImmune = Math.max(0, tImmune - dt);
    if (tImmune <= 0) breakPendingPlanks();
    const nw = tImmune > 0 ? 0 : breakPendingWheels();
    const n = (tImmune > 0 ? 0 : queueBreaks(world, car.breakables, 1 / dt)) + nw;
    if (n) {
      brokenCount += n;
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
    if (ang > 2.0) { // 翻覆後不要硬給油
      brakeHeld = Math.abs(v.x) > 1;
    } else if (pitch > 0.72) { // 翹輪：超過一般坡度才收油
      gasHeld = false;
      if (pitch > 1.0 && v.x > 1) brakeHeld = true;
    } else if (pitch < -0.7 && v.x > 7) { // 很陡且過快才強制收速，避免淺凹槽裡翻車
      brakeHeld = true;
    } else if (err > 0.35) gasHeld = true;
    else if (err < -0.45) brakeHeld = true;
    // 在空中略收（兩輪幾乎離地時不要猛加速）
    const wr = car.rear.body.getPosition().y, wf = car.front.body.getPosition().y;
    const gY = p.y;
    if (wr > gY - 0.15 && wf > gY - 0.15 && v.y > 1.2) {
      if (v.x > want) { gasHeld = false; brakeHeld = false; }
    }
    car.gas = gasHeld ? 1 : 0;
    car.brake = brakeHeld ? 1 : 0;
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
        [-1.42, -0.35], [1.50, -0.35], [1.50, 0.95], [-1.42, 0.95]
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
      add(p.x - 0.58, p.y - 0.16); add(p.x + 0.58, p.y + 0.20);
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
    ax += (goingLeft ? 1 : -1) * leadT * 0.02; // 0.33 → 約 0.31
    const lookX = Math.max(0, Math.min(0.45, speed * 0.04)) * (goingLeft ? -1 : 1);
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

  function drawSky() {
    const g = ctx.createLinearGradient(0, 0, 0, viewH);
    g.addColorStop(0, palette.skyTop);
    g.addColorStop(0.62, palette.skyHorizon);
    g.addColorStop(1, "#d9b07a");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, viewW, viewH);
    // 遠丘
    ctx.fillStyle = "rgba(180,120,70,0.18)";
    ctx.beginPath();
    ctx.moveTo(0, viewH * 0.62);
    for (let i = 0; i <= 8; i++) {
      const xx = (i / 8) * viewW;
      const yy = viewH * 0.52 + Math.sin(i * 1.3 + camX * 0.02) * 28;
      ctx.lineTo(xx, yy);
    }
    ctx.lineTo(viewW, viewH); ctx.lineTo(0, viewH); ctx.fill();
  }

  function drawGroundFill() {
    if (!meta) return;
    // 在鏡頭下方鋪土
    const y0 = wy(meta.endY != null ? Math.min(0, meta.endY) : 0);
    ctx.fillStyle = palette.dirt;
    ctx.fillRect(0, Math.min(viewH, y0), viewW, viewH);
    ctx.fillStyle = palette.dirtDark;
    ctx.fillRect(0, Math.min(viewH, y0 + 18), viewW, viewH);
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
    inBody(wheelBody, function () {
      const R = CFG.WHEEL_R;
      // 視覺幾乎等於物理半徑，光滑胎壁，沒有越野胎塊
      ctx.beginPath();
      ctx.arc(0, 0, R, 0, Math.PI * 2);
      ctx.fillStyle = "#1a1a1d";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.97, 0, Math.PI * 2);
      ctx.strokeStyle = "#2c2c32";
      ctx.lineWidth = 0.018;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.82, 0, Math.PI * 2);
      ctx.fillStyle = "#2a2a30";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.78, 0, Math.PI * 2);
      const lip = ctx.createLinearGradient(-R, 0, R, 0);
      lip.addColorStop(0, "#7a7e86");
      lip.addColorStop(0.45, "#d8dce2");
      lip.addColorStop(1, "#6a6e76");
      ctx.fillStyle = lip;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.70, 0, Math.PI * 2);
      const dish = ctx.createRadialGradient(-0.04, 0.04, 0.01, 0, 0, R * 0.70);
      dish.addColorStop(0, "#9aa2aa");
      dish.addColorStop(1, "#5a616a");
      ctx.fillStyle = dish;
      ctx.fill();
      const spokes = 5;
      for (let i = 0; i < spokes; i++) {
        const a = i * Math.PI * 2 / spokes - 0.12;
        ctx.save();
        ctx.rotate(a);
        ctx.beginPath();
        ctx.moveTo(0.035, -0.032);
        ctx.lineTo(R * 0.62, -0.022);
        ctx.lineTo(R * 0.65, 0);
        ctx.lineTo(R * 0.62, 0.022);
        ctx.lineTo(0.035, 0.032);
        ctx.closePath();
        const sg = ctx.createLinearGradient(0.04, 0, R * 0.65, 0);
        sg.addColorStop(0, "#d8dce2");
        sg.addColorStop(0.5, "#9aa2aa");
        sg.addColorStop(1, "#eceef2");
        ctx.fillStyle = sg;
        ctx.fill();
        ctx.restore();
      }
      ctx.beginPath();
      ctx.arc(0, 0, 0.072, 0, Math.PI * 2);
      ctx.fillStyle = "#c4c8ce";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 0, 0.038, 0, Math.PI * 2);
      ctx.fillStyle = "#5a6068";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.96, 0.75, 1.45);
      ctx.strokeStyle = "rgba(255,255,255,0.18)";
      ctx.lineWidth = 0.02;
      ctx.stroke();
    });
  }

  function drawSuspension() {
    // 物理懸吊仍在；外觀比照概念圖，不畫出彈簧
  }

  function drawHull() {
    inBody(car.chassis, function () {
      const wr = CFG.WHEEL_R;
      const wY = CFG.WHEEL_Y;
      const aR = wr + 0.045;
      function archOver(cx, cy, rx, ry, a0, a1) {
        for (let i = 0; i <= 16; i++) {
          const ang = a0 + (a1 - a0) * (i / 16);
          ctx.lineTo(cx + Math.cos(ang) * rx, cy + Math.sin(ang) * ry);
        }
      }
      function bodyPath() {
        ctx.beginPath();
        ctx.moveTo(-1.16, -0.30);
        ctx.quadraticCurveTo(-1.36, -0.26, -1.34, -0.06);
        ctx.quadraticCurveTo(-1.32, 0.16, -1.20, 0.28);
        ctx.quadraticCurveTo(-1.28, 0.40, -1.14, 0.46);
        ctx.lineTo(-1.02, 0.48);
        ctx.quadraticCurveTo(-0.88, 0.62, -0.52, 0.78);
        ctx.quadraticCurveTo(-0.32, 0.86, -0.08, 0.80);
        ctx.quadraticCurveTo(0.10, 0.66, 0.18, 0.56);
        ctx.quadraticCurveTo(0.30, 0.32, 0.36, 0.16);
        ctx.quadraticCurveTo(0.95, 0.10, 1.24, 0.06);
        ctx.quadraticCurveTo(1.42, 0.04, 1.46, -0.06);
        ctx.quadraticCurveTo(1.50, -0.16, 1.40, -0.30);
        ctx.quadraticCurveTo(1.24, -0.34, 1.12, -0.32);
        const skirtY = -0.32;
        const sEdge = Math.max(-0.95, Math.min(0.95, (skirtY - wY) / aR));
        const aEdge = Math.asin(sEdge);
        archOver(0.88, wY, aR, aR, aEdge, Math.PI - aEdge);
        ctx.lineTo(-0.30, skirtY);
        archOver(-0.82, wY, aR, aR, aEdge, Math.PI - aEdge);
        ctx.closePath();
      }

      ctx.beginPath();
      ctx.moveTo(-0.30, -0.32);
      ctx.lineTo(0.36, -0.32);
      ctx.lineTo(0.36, -0.24);
      ctx.lineTo(-0.30, -0.24);
      ctx.closePath();
      ctx.fillStyle = "#1a1e26";
      ctx.fill();

      bodyPath();
      const g = ctx.createLinearGradient(0, -0.32, 0, 0.84);
      g.addColorStop(0, "#145a96");
      g.addColorStop(0.22, "#1a78c4");
      g.addColorStop(0.52, "#2a92dc");
      g.addColorStop(0.78, "#5eb4ee");
      g.addColorStop(1, "#9ad0f5");
      ctx.fillStyle = g;
      ctx.fill();
      ctx.strokeStyle = "#0c3a68";
      ctx.lineWidth = 0.028;
      ctx.stroke();

      ctx.save();
      bodyPath();
      ctx.clip();
      ctx.beginPath();
      ctx.moveTo(-1.2, 0.20);
      ctx.quadraticCurveTo(0.2, 0.30, 1.3, 0.10);
      ctx.strokeStyle = "rgba(220,240,255,0.45)";
      ctx.lineWidth = 0.045;
      ctx.stroke();
      const shade = ctx.createLinearGradient(0, -0.32, 0, 0.00);
      shade.addColorStop(0, "rgba(8,30,60,0.28)");
      shade.addColorStop(1, "rgba(8,30,60,0)");
      ctx.fillStyle = shade;
      ctx.fillRect(-1.5, -0.34, 3.2, 0.34);
      ctx.restore();

      function fenderLip(cx) {
        ctx.beginPath();
        const rLip = aR + 0.02;
        const sL = Math.max(-0.95, Math.min(0.95, ((-0.32) - wY) / rLip));
        const a0 = Math.asin(sL), a1 = Math.PI - a0;
        for (let i = 0; i <= 16; i++) {
          const ang = a0 + (a1 - a0) * (i / 16);
          const x = cx + Math.cos(ang) * rLip, y = wY + Math.sin(ang) * rLip;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = "#1568aa";
        ctx.lineWidth = 0.07;
        ctx.stroke();
        ctx.strokeStyle = "rgba(200,230,255,0.45)";
        ctx.lineWidth = 0.018;
        ctx.stroke();
      }
      fenderLip(-0.82);
      fenderLip(0.88);

      // 肩線
      ctx.beginPath();
      ctx.moveTo(-1.08, 0.16);
      ctx.quadraticCurveTo(-0.10, 0.22, 0.40, 0.16);
      ctx.quadraticCurveTo(0.95, 0.12, 1.24, 0.08);
      ctx.strokeStyle = "rgba(10,40,80,0.35)";
      ctx.lineWidth = 0.022;
      ctx.stroke();

      // 紅／藍飾條，沿肩線
      function stripe(yOff, color, w) {
        ctx.beginPath();
        ctx.moveTo(-1.00, 0.12 + yOff);
        ctx.quadraticCurveTo(0.05, 0.18 + yOff, 0.70, 0.14 + yOff);
        ctx.lineTo(1.14, 0.09 + yOff);
        ctx.strokeStyle = color;
        ctx.lineWidth = w;
        ctx.stroke();
      }
      stripe(0.010, "#0c3a68", 0.016);
      stripe(-0.006, "#e02a3c", 0.015);

      // 長引擎蓋折線
      ctx.beginPath();
      ctx.moveTo(0.32, 0.18);
      ctx.quadraticCurveTo(0.90, 0.12, 1.22, 0.07);
      ctx.strokeStyle = "rgba(10,40,80,0.25)";
      ctx.lineWidth = 0.014;
      ctx.stroke();

      // 車門
      ctx.beginPath();
      ctx.moveTo(0.02, -0.28);
      ctx.lineTo(0.10, 0.18);
      ctx.strokeStyle = "rgba(8,30,60,0.35)";
      ctx.lineWidth = 0.016;
      ctx.stroke();
      ctx.beginPath();
      ctx.roundRect(0.18, 0.08, 0.10, 0.028, 0.01);
      ctx.fillStyle = "#0c3a68";
      ctx.fill();
      ctx.beginPath();
      ctx.roundRect(0.195, 0.088, 0.07, 0.012, 0.005);
      ctx.fillStyle = "#d0d8e4";
      ctx.fill();

      // 側裙
      ctx.beginPath();
      ctx.moveTo(-0.28, -0.32);
      ctx.lineTo(0.36, -0.32);
      ctx.lineTo(0.34, -0.26);
      ctx.lineTo(-0.26, -0.26);
      ctx.closePath();
      ctx.fillStyle = "#12151c";
      ctx.fill();

      // 前輪後方小進氣口
      ctx.beginPath();
      ctx.moveTo(0.44, -0.06);
      ctx.lineTo(0.58, -0.04);
      ctx.lineTo(0.56, 0.06);
      ctx.lineTo(0.42, 0.04);
      ctx.closePath();
      ctx.fillStyle = "#12151c";
      ctx.fill();

      // 低寬前保桿，單橫縫，不是雙腎
      ctx.beginPath();
      ctx.moveTo(1.18, -0.30);
      ctx.quadraticCurveTo(1.50, -0.24, 1.50, -0.06);
      ctx.quadraticCurveTo(1.46, 0.06, 1.28, 0.08);
      ctx.lineTo(1.20, -0.06);
      ctx.quadraticCurveTo(1.22, -0.18, 1.18, -0.28);
      ctx.closePath();
      const bg = ctx.createLinearGradient(1.20, 0.08, 1.50, -0.30);
      bg.addColorStop(0, "#5eb4ee");
      bg.addColorStop(0.45, "#1e82d0");
      bg.addColorStop(1, "#145a96");
      ctx.fillStyle = bg;
      ctx.fill();
      ctx.strokeStyle = "#0c3a68";
      ctx.lineWidth = 0.02;
      ctx.stroke();
      ctx.beginPath();
      ctx.roundRect(1.34, -0.16, 0.13, 0.05, 0.02);
      ctx.fillStyle = "#12151c";
      ctx.fill();
      ctx.beginPath();
      ctx.roundRect(1.30, -0.30, 0.16, 0.036, 0.01);
      ctx.fillStyle = "#0e1218";
      ctx.fill();

      function lamp(cx, cy, r) {
        ctx.beginPath();
        ctx.arc(cx, cy, r * 1.08, 0, Math.PI * 2);
        ctx.fillStyle = "#12151c";
        ctx.fill();
        ctx.beginPath();
        ctx.arc(cx, cy, r * 0.86, 0, Math.PI * 2);
        const lg = ctx.createRadialGradient(cx - r * 0.22, cy + r * 0.2, r * 0.08, cx, cy, r * 0.86);
        lg.addColorStop(0, "#ffffff");
        lg.addColorStop(0.4, "#e8f2ff");
        lg.addColorStop(1, "#7a9cc8");
        ctx.fillStyle = lg;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(cx, cy, r * 0.96, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(230,245,255,0.95)";
        ctx.lineWidth = r * 0.16;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.ellipse(1.26, 0.00, 0.15, 0.13, -0.15, 0, Math.PI * 2);
      ctx.fillStyle = "#12151c";
      ctx.fill();
      lamp(1.22, 0.05, 0.072);
      lamp(1.30, -0.04, 0.062);

      // 短車尾
      ctx.beginPath();
      ctx.moveTo(-1.14, -0.28);
      ctx.quadraticCurveTo(-1.38, -0.22, -1.36, 0.00);
      ctx.quadraticCurveTo(-1.34, 0.18, -1.18, 0.24);
      ctx.lineTo(-1.12, 0.02);
      ctx.quadraticCurveTo(-1.14, -0.12, -1.12, -0.24);
      ctx.closePath();
      const rg = ctx.createLinearGradient(-1.14, 0.24, -1.38, -0.28);
      rg.addColorStop(0, "#4aa0e0");
      rg.addColorStop(1, "#145a96");
      ctx.fillStyle = rg;
      ctx.fill();
      ctx.strokeStyle = "#0c3a68";
      ctx.lineWidth = 0.02;
      ctx.stroke();
      // 小尾翼
      ctx.beginPath();
      ctx.moveTo(-1.04, 0.44);
      ctx.lineTo(-1.24, 0.45);
      ctx.lineTo(-1.22, 0.50);
      ctx.lineTo(-1.00, 0.48);
      ctx.closePath();
      ctx.fillStyle = "#1a78c4";
      ctx.fill();
      ctx.strokeStyle = "#0c3a68";
      ctx.lineWidth = 0.016;
      ctx.stroke();

      ctx.beginPath();
      ctx.roundRect(-1.32, 0.04, 0.14, 0.15, 0.035);
      ctx.fillStyle = "#3a1014";
      ctx.fill();
      ctx.beginPath();
      ctx.roundRect(-1.30, 0.06, 0.10, 0.11, 0.025);
      const tg = ctx.createLinearGradient(-1.30, 0.18, -1.20, 0.04);
      tg.addColorStop(0, "#ffb0a0");
      tg.addColorStop(0.45, "#e4453c");
      tg.addColorStop(1, "#7a1418");
      ctx.fillStyle = tg;
      ctx.fill();

      function tip(x, y, s) {
        ctx.beginPath();
        ctx.ellipse(x, y, 0.032 * s, 0.020 * s, 0, 0, Math.PI * 2);
        ctx.fillStyle = "#2a2c30";
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(x - 0.008, y, 0.016 * s, 0.010 * s, 0, 0, Math.PI * 2);
        ctx.fillStyle = "#0e1014";
        ctx.fill();
      }
      tip(-1.38, -0.18, 1);
      tip(-1.38, -0.23, 1);
      tip(-1.34, -0.18, 0.75);
      tip(-1.34, -0.23, 0.75);

      // 斜背側窗
      ctx.beginPath();
      ctx.moveTo(0.16, 0.22);
      ctx.lineTo(-0.04, 0.62);
      ctx.quadraticCurveTo(-0.30, 0.74, -0.62, 0.70);
      ctx.lineTo(-0.90, 0.56);
      ctx.lineTo(-0.98, 0.38);
      ctx.lineTo(-0.88, 0.26);
      ctx.lineTo(-0.74, 0.22);
      ctx.closePath();
      const wg = ctx.createLinearGradient(-0.3, 0.20, -0.3, 0.74);
      wg.addColorStop(0, "rgba(20, 42, 64, 0.94)");
      wg.addColorStop(0.55, "rgba(60, 110, 140, 0.80)");
      wg.addColorStop(1, "rgba(180, 215, 230, 0.70)");
      ctx.fillStyle = wg;
      ctx.fill();
      ctx.strokeStyle = "#12151c";
      ctx.lineWidth = 0.042;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0.10, 0.28);
      ctx.lineTo(-0.06, 0.58);
      ctx.quadraticCurveTo(-0.30, 0.70, -0.58, 0.66);
      ctx.lineTo(-0.86, 0.54);
      ctx.strokeStyle = "rgba(220,235,245,0.4)";
      ctx.lineWidth = 0.014;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-0.28, 0.24);
      ctx.lineTo(-0.22, 0.66);
      ctx.strokeStyle = "rgba(18, 24, 32, 0.55)";
      ctx.lineWidth = 0.028;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(-0.44, 0.40, 0.07, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(28, 22, 20, 0.65)";
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(-0.44, 0.30, 0.09, 0.05, 0, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(20, 28, 40, 0.6)";
      ctx.fill();

      ctx.beginPath();
      ctx.roundRect(0.20, 0.22, 0.12, 0.065, 0.018);
      ctx.fillStyle = "#12151c";
      ctx.fill();
      ctx.beginPath();
      ctx.roundRect(0.225, 0.234, 0.08, 0.036, 0.01);
      ctx.fillStyle = "#8ab0c4";
      ctx.fill();
    });
  }

  function drawRoofPanel() {
    if (!car || !car.roof) return;
    inBody(car.roof, function () {
      // 薄片貼齊車頂，避免看起來像車頂行李架
      ctx.beginPath();
      ctx.moveTo(-0.42, -0.09);
      ctx.quadraticCurveTo(-0.10, -0.01, 0.20, -0.03);
      ctx.quadraticCurveTo(0.38, -0.06, 0.42, -0.09);
      ctx.quadraticCurveTo(0.10, -0.12, -0.16, -0.12);
      ctx.quadraticCurveTo(-0.34, -0.11, -0.42, -0.09);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, -0.12, 0, 0.00);
      g.addColorStop(0, "#1a78c4");
      g.addColorStop(0.6, "#2a92dc");
      g.addColorStop(1, "#5eb4ee");
      ctx.fillStyle = g;
      ctx.fill();
      ctx.strokeStyle = "rgba(12,58,104,0.35)";
      ctx.lineWidth = 0.012;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-0.28, -0.02);
      ctx.quadraticCurveTo(0.00, 0.02, 0.24, -0.03);
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 0.012;
      ctx.stroke();
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
    const a = 0.22 * (1 - air);
    if (a < 0.03) return;
    const mx = (wr.x + wf.x) * 0.5, my = Math.min(wr.y, wf.y) - CFG.WHEEL_R * 0.15;
    const sx = wx(mx), sy = wy(my);
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(-car.chassis.getAngle());
    ctx.fillStyle = "rgba(40,24,12," + a + ")";
    ctx.beginPath();
    ctx.ellipse(0, 0, 1.35 * ppm, 0.22 * ppm, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function spawnVfx() {
    if (!car || st !== "play") return;
    const gas = !!car.gas && !reversing;
    if (!gas) return;
    if (Math.random() > 0.45) return;
    const ex = car.chassis.getWorldPoint({ x: -1.34, y: -0.12 });
    const ang = car.chassis.getAngle();
    vfx.push({
      kind: "exhaust",
      x: ex.x, y: ex.y,
      vx: -Math.cos(ang) * (0.6 + Math.random() * 0.5) + car.chassis.getLinearVelocity().x * 0.15,
      vy: 0.2 + Math.random() * 0.4,
      life: 0.45 + Math.random() * 0.25,
      age: 0,
      r: 0.07 + Math.random() * 0.04
    });
    const wr = car.rear.body.getPosition();
    const wrL = car.chassis.getLocalPoint(wr);
    if (wrL.y > -0.55 && Math.random() < 0.5) {
      vfx.push({
        kind: "dust",
        x: wr.x - 0.15, y: wr.y - CFG.WHEEL_R * 0.8,
        vx: -0.4 - Math.random() * 0.6, vy: 0.15 + Math.random() * 0.3,
        life: 0.35 + Math.random() * 0.2,
        age: 0,
        r: 0.08 + Math.random() * 0.06
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
      p.vy += 0.4 * dt;
      if (p.age >= p.life) vfx.splice(i, 1);
    }
    if (vfx.length > 40) vfx.splice(0, vfx.length - 40);
  }

  function drawVfx() {
    for (let i = 0; i < vfx.length; i++) {
      const p = vfx[i];
      const u = 1 - p.age / p.life;
      const cx = wx(p.x), cy = wy(p.y);
      const rr = p.r * ppm * (0.7 + (1 - u) * 1.1);
      ctx.beginPath();
      ctx.arc(cx, cy, rr, 0, Math.PI * 2);
      if (p.kind === "exhaust") ctx.fillStyle = "rgba(70,66,62," + (0.28 * u) + ")";
      else ctx.fillStyle = "rgba(170,130,80," + (0.30 * u) + ")";
      ctx.fill();
    }
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
    } else if (typ === "edge") {
      const a = shape.getVertex1 ? shape.getVertex1() : shape.m_vertex1;
      const b = shape.getVertex2 ? shape.getVertex2() : shape.m_vertex2;
      const p1 = xform(xf, a), p2 = xform(xf, b);
      ctx.beginPath(); ctx.moveTo(wx(p1.x), wy(p1.y)); ctx.lineTo(wx(p2.x), wy(p2.y));
      ctx.lineWidth = 6; ctx.strokeStyle = palette.dirt; ctx.stroke();
      ctx.strokeStyle = palette.grass; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(wx(p1.x), wy(p1.y) - 3); ctx.lineTo(wx(p2.x), wy(p2.y) - 3); ctx.stroke();
    } else if (typ === "chain") {
      const n = shape.getVertexCount ? shape.getVertexCount() : (shape.m_vertices || []).length;
      if (n < 2) return;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const v = shape.getVertex ? shape.getVertex(i) : shape.m_vertices[i];
        const p = xform(xf, v);
        if (i === 0) ctx.moveTo(wx(p.x), wy(p.y)); else ctx.lineTo(wx(p.x), wy(p.y));
      }
      // 往下填土
      const last = shape.getVertex ? shape.getVertex(n - 1) : shape.m_vertices[n - 1];
      const first = shape.getVertex ? shape.getVertex(0) : shape.m_vertices[0];
      const lp = xform(xf, last), fp = xform(xf, first);
      ctx.lineTo(wx(lp.x), viewH + 20);
      ctx.lineTo(wx(fp.x), viewH + 20);
      ctx.closePath();
      ctx.fillStyle = palette.dirt;
      ctx.fill();
      ctx.strokeStyle = palette.grass;
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const v = shape.getVertex ? shape.getVertex(i) : shape.m_vertices[i];
        const p = xform(xf, v);
        if (i === 0) ctx.moveTo(wx(p.x), wy(p.y)); else ctx.lineTo(wx(p.x), wy(p.y));
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
      ctx.fill();
      ctx.stroke();
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

  function draw() {
    drawSky();
    if (!world) {
      ctx.fillStyle = palette.dirt;
      ctx.fillRect(0, viewH * 0.7, viewW, viewH);
      return;
    }
    updateCam(CFG.TICK);
    drawGroundFill();
    drawFlag();
    for (let b = world.getBodyList(); b; b = b.getNext()) drawBody(b);
    drawVehicle();
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
    syncPedals();
    if (opts.bot) botMode = true;
    if (AUTO_BOT) botMode = true;
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
    draw();
    requestAnimationFrame(loop);
  }

  // ---------- 輸入 ----------
  function syncPedals() {
    document.getElementById("btnGas").classList.toggle("held", gasHeld);
    document.getElementById("btnBrake").classList.toggle("held", brakeHeld);
  }
  function setGas(v) {
    if (v && !gasHeld) inputAt = performance.now();
    gasHeld = !!v; syncPedals();
    if (st === "play" && car && !adsPaused) {
      car.gas = gasHeld ? 1 : 0;
      updateRevState(0);
      applyDrive(car);
      if (v) motorAt = performance.now();
    }
  }
  function setBrake(v) {
    if (v && !brakeHeld) inputAt = performance.now();
    brakeHeld = !!v; syncPedals();
    if (st === "play" && car && !adsPaused) {
      car.brake = brakeHeld ? 1 : 0;
      updateRevState(0);
      applyDrive(car);
      if (v) motorAt = performance.now();
    }
  }

  function bindPedal(btn, setter) {
    const down = function (ev) { ev.preventDefault(); ev.stopPropagation(); setter(true); };
    const up = function (ev) { ev.preventDefault(); ev.stopPropagation(); setter(false); };
    btn.addEventListener("pointerdown", down);
    btn.addEventListener("pointerup", up);
    btn.addEventListener("pointercancel", up);
    btn.addEventListener("pointerleave", function (ev) {
      if (ev.buttons) return;
      setter(false);
    });
  }
  bindPedal(document.getElementById("btnGas"), setGas);
  bindPedal(document.getElementById("btnBrake"), setBrake);

  window.addEventListener("keydown", function (ev) {
    if (ev.target && ev.target.closest && ev.target.closest("button, input, #adFake")) return;
    if (ev.repeat) return;
    if (ev.code === "ArrowRight" || ev.code === "KeyD" || ev.code === "ArrowUp") { ev.preventDefault(); setGas(true); }
    if (ev.code === "ArrowLeft" || ev.code === "KeyA" || ev.code === "ArrowDown" || ev.code === "KeyS" || ev.code === "Space") { ev.preventDefault(); setBrake(true); }
    if (ev.code === "Escape") { ev.preventDefault(); if (st === "play") showPause(); }
  });
  window.addEventListener("keyup", function (ev) {
    if (ev.code === "ArrowRight" || ev.code === "KeyD" || ev.code === "ArrowUp") setGas(false);
    if (ev.code === "ArrowLeft" || ev.code === "KeyA" || ev.code === "ArrowDown" || ev.code === "KeyS" || ev.code === "Space") setBrake(false);
  });
  window.addEventListener("contextmenu", function (ev) { ev.preventDefault(); });
  window.addEventListener("blur", function () { setGas(false); setBrake(false); });

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
    const saved = { st: st, botMode: botMode, gasHeld: gasHeld, brakeHeld: brakeHeld };
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
          samples.push({ t: tRun, x: p.x, y: p.y, vx: v.x, vy: v.y, ang: car.chassis.getAngle(), gas: gasHeld, brake: brakeHeld, st: st, broken: brokenCount });
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
        broken: brokenCount, cargoLost: cargoLost, fps: fpsNow,
        result: result, adsPaused: adsPaused, reversing: !!reversing,
        revReady: !!revReady, revHoldT: revHoldT,
        cam: camFraming()
      };
    },
    pressGas: function (v) { setGas(!!v); },
    pressBrake: function (v) { setBrake(!!v); },
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
      store = { stars: {}, bestTime: {}, unlocked: 1 };
      saveStore();
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
  installAdsTag();
  lastTs = performance.now();
  requestAnimationFrame(loop);
  if (START_LEVEL >= 1) startLevel(START_LEVEL, { bot: AUTO_BOT });
  else showMenu();
})();
