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
    WHEEL_R: 0.38,
    MOTOR_SPEED: 38,       // rad/s；半徑 0.38 → 理論約 16 m/s
    TORQUE_REAR: 16,
    TORQUE_FRONT: 14,
    BRAKE_TORQUE: 28,
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
    roof: "#f3efe6",
    wheel: "#2a2622",
    hub: "#d9d0c3",
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
    let spawn = { x: 2.2, y: 0.95 };
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
      spawnAt(sx, sy) { spawn = { x: sx, y: sy == null ? y + 0.92 : sy }; return api; },
      pad(len) {
        const s = x;
        push(x + (len == null ? 10 : len), y);
        spawn = { x: s + 2.2, y: y + 0.92 };
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
        const cx = x + L * 0.5, cy = y + tck;
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
      par3: 12, par2: 18, cargo: false,
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
      const wheel = world.createBody({ type: "dynamic", position: { x: wx, y: y - 0.42 } });
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

  function applyDrive(car) {
    const gas = car.gas, brake = car.brake;
    const vx = car.chassis.getLinearVelocity().x;
    let speed = 0, torqueMul = 1, enable = true;
    if (gas && !brake) {
      speed = -CFG.MOTOR_SPEED;
    } else if (brake && !gas) {
      if (vx > 0.55) {
        speed = CFG.MOTOR_SPEED * 0.85; // 前進中煞車＝反向扭力
        torqueMul = 1.15;
      } else {
        speed = CFG.MOTOR_SPEED * 0.7; // 停穩後後退
      }
    } else if (brake && gas) {
      speed = 0;
      torqueMul = 1.2;
    } else {
      enable = false;
      speed = 0;
    }
    [car.rear, car.front].forEach(function (w) {
      if (!w.joint || !w.joint.isActive || (w.joint.m_bodyA && !w.joint.m_bodyA.isActive())) return;
      try {
        if (!w.joint.getBodyA) return;
        w.joint.enableMotor(enable);
        w.joint.setMotorSpeed(speed);
        w.joint.setMaxMotorTorque((brake && !gas && vx > 0.55 ? CFG.BRAKE_TORQUE : w.torque) * torqueMul);
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
  let camX = 0, camY = 1.2, result = null;
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
    ppm = Math.max(32, Math.min(56, w / 18));
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
    continueUsed = !!opts.keepContinueUsed && continueUsed;
    if (!opts.keepContinueUsed) { continueUsed = false; hideContinueBtn(); }

    for (let i = 0; i < 45; i++) { world.step(CFG.TICK, CFG.VEL_IT, CFG.POS_IT); world.clearForces(); }
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
      applyDrive(car);
      if (motorAt === 0 && (car.gas || car.brake)) motorAt = performance.now();
    } else {
      car.gas = 0; car.brake = 0;
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
  function wx(x) { return (x - camX) * ppm + viewW * 0.38; }
  function wy(y) { return viewH * 0.68 - (y - camY) * ppm; }

  function updateCam(alpha) {
    if (!car) return;
    const p = car.chassis.getPosition();
    const v = car.chassis.getLinearVelocity();
    const look = Math.max(2.5, Math.min(7, 3 + v.x * 0.35));
    const tx = p.x + look * 0.55;
    const ty = p.y + 0.4;
    const k = 1 - Math.pow(0.001, Math.max(0.001, alpha || 0.016));
    camX += (tx - camX) * Math.min(1, k * 8);
    camY += (ty - camY) * Math.min(1, k * 6);
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

  function drawBody(body) {
    const xf = body.getTransform();
    for (let f = body.getFixtureList(); f; f = f.getNext()) {
      const ud = f.getUserData() || {};
      const shape = f.getShape();
      const kind = ud.kind || "";
      if (kind === "ground" || kind === "loop" || kind === "wall" || kind === "endwall") {
        drawShape(shape, xf, kind === "endwall" ? palette.dirtDark : palette.dirt, true);
      } else if (kind === "wheel") {
        drawWheel(body, xf, shape);
      } else if (kind === "chassis") {
        drawShape(shape, xf, palette.teal, false);
        // 頭燈
        const p = body.getWorldPoint({ x: 1.22, y: 0.02 });
        ctx.fillStyle = "#f7e7a8";
        ctx.beginPath(); ctx.arc(wx(p.x), wy(p.y), 4.2, 0, Math.PI * 2); ctx.fill();
      } else if (kind === "roof") {
        drawShape(shape, xf, palette.roof, false);
      } else if (kind === "pot") {
        drawShape(shape, xf, palette.pot, false);
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
    if (st === "play" && car && !adsPaused) { car.gas = gasHeld ? 1 : 0; applyDrive(car); if (v) motorAt = performance.now(); }
  }
  function setBrake(v) {
    if (v && !brakeHeld) inputAt = performance.now();
    brakeHeld = !!v; syncPedals();
    if (st === "play" && car && !adsPaused) { car.brake = brakeHeld ? 1 : 0; applyDrive(car); if (v) motorAt = performance.now(); }
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
        result: result, adsPaused: adsPaused
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
