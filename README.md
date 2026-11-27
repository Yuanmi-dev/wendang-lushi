# 穩當路試

側視物理路試小遊戲：小心控制油門與煞車，讓還沒完全鎖緊的試作車穩穩開到旗門。衝太猛會翻車，撞擊過大時車頂、貨物或輪軸可能脫落。

- 公開示範：https://yuanmi-dev.github.io/wendang-lushi/
- 儲存庫：https://github.com/Yuanmi-dev/wendang-lushi
- 這是 GitHub Pages 示範站，不是正式官網，也不會部署到 yuanmi.tw。日後預計放到 wantcar.autos 的遊戲站，本資料夾保持自我完整。

本遊戲是每週小遊戲線的第 1 週，預定可玩日為 2026-12-02（週三，Asia/Taipei）。名稱「穩當路試」為原創；曾考慮「還沒鎖緊」「細踏路試」。不是 Drive Mad 的名稱、關卡或美術。

## 怎麼玩

觸控用畫面上的「油門」「煞車」兩顆按鈕：點下去先是輕踩（約四分之一力），按住約 0.6 秒加到滿力，放開約 0.1 秒收掉；按住時上下滑可直接調力度。電腦可用方向鍵或 W／S、A／D，空白鍵也可煞車，同樣會逐漸加力。煞車會把車輪剎住（可停在坡上）。完全停穩後再按一次，或停住後按住約 0.6 秒，才會倒車；倒車時煞車鍵上方會顯示「倒車」。鬆開所有按鍵時有輕微的引擎煞車，但陡坡仍可能緩緩滑下。開始與重開前有 3 秒倒數。

過關依時間給 1～3 顆星；若該關有陶罐，陶罐掉落會少一顆星，零件脫落也會少一顆星。進度存在瀏覽器 `localStorage`（鍵名 `wendangLushi.v1`）。

## 架構

- `index.html`：繁中介面、全螢幕版面、踏板與選單。
- `game.js`：關卡、物理、繪製、存檔、廣告呼叫點與自動檢查介面 `window.__WENDANG__`。
- `vendor/planck.min.js`：本機打包的 [planck.js](https://github.com/shakiba/planck.js) 1.5.1（MIT，Box2D 的 JS 移植）。授權見 `vendor/planck.LICENSE.txt`。

固定 60 Hz 模擬（`World.step`，速度迭代 8、位置迭代 3）。重力 9.81 m/s²。車輛有車體、可焊斷的車頂、前後輪的 WheelJoint（扭力、懸吊彈簧與阻尼、地面摩擦）；貨物以 WeldJoint 固定。關卡以手刻路段組合：平地、坡、跳台、蹺板、木橋、脆弱棧道、餘弦凹槽與圓丘。美術為程序繪製的 Canvas 2D，沒有外部圖檔依賴。

廣告採 Google Ad Placement API 預埋 `adBreak`／`adConfig`，寫法與白雞跳跳 v0.2 相同。尚無 publisher id；預設 `CFG.ADS_ENABLED` 為關閉。沒有廣告、被擋或回呼失敗時，遊戲會照常進行。

## CFG 重要參數

都寫在 `game.js` 開頭的 `CFG` 物件：

| 參數 | 說明 |
| --- | --- |
| `GRAVITY`、`TICK`、`VEL_IT`、`POS_IT` | 重力與固定步長 |
| `MOTOR_SPEED`、`TORQUE_REAR`／`FRONT`、`BRAKE_TORQUE` | 輪上扭力與煞車 |
| `SPRING_HZ`、`SPRING_ZETA`、`WHEEL_R` | 懸吊與輪徑 |
| `BREAK_PART`、`BREAK_CARGO` | 車頂、貨物的關節反力閾值 |
| `BREAK_WHEEL_IMPACT`、`BREAK_PLANK` | 輪子與木板改看撞擊衝量，避免懸吊彈簧誤拆輪 |
| `COUNTDOWN_S` | 開始與重開前的倒數 |
| `ADS_ENABLED` | 是否啟用廣告呼叫。正式投放前請保持 `false` |
| `ADS_TEST_MODE` | `true` 時加上 `data-adbreak-test="on"`，只顯示測試廣告 |
| `ADS_CLIENT` | 日後填入 `ca-pub-…`。現在請留空 |
| `ADS_INTERSTITIAL_EVERY` | 每完成 N 關（下一關前）插一次 interstitial（預設 3） |

## URL 參數

可組合使用，例如 `?debug=1&fakead=1`。

| 參數 | 說明 |
| --- | --- |
| `debug` | `1` 時顯示座標、速度、幀率與零件數 |
| `fakead` | `1` 時用本機模擬廣告流程，不向 Google 發請求；建議搭配 `debug=1` |
| `ads` | `1` 強制開啟廣告呼叫（仍受測試模式與空的 client 限制）；`0` 強制關閉 |
| `level` | 進入頁面後直接開指定關卡編號 |
| `bot` | `1` 時用內建路點控制器自動開 |

檢查可用瀏覽器主控台：`__WENDANG__.beatAll()`、`__WENDANG__.beatLevel(id)`、`__WENDANG__.traceLevel(id, seconds)`、`__WENDANG__.inputLatency()`、`__WENDANG__.adsState()`。

## 部署

1. 先 `git pull --rebase`，再改檔，一般 `git push`，不要 force push。
2. 把本資料夾（`index.html`、`game.js`、`vendor/`、README、run-log）提交到本儲存庫的 `main`。GitHub Pages 由此分支根目錄發布。
3. 不要部署到 yuanmi.tw 或其他正式網域，除非另行決定。
4. 本機預覽可用 `python3 -m http.server 8765`，瀏覽器打開 `http://localhost:8765/`。測試廣告流程請用 `http://localhost:8765/?debug=1&fakead=1`。

要換成正式 AdSense 時：申請並通過 AdSense／H5 遊戲廣告、取得 `ca-pub-` 編號，填入 `CFG.ADS_CLIENT`，將 `ADS_ENABLED` 設為 `true`，並在確定可投放後把 `ADS_TEST_MODE` 改為 `false`（同時不要再輸出 `data-adbreak-test="on"`）。網域要加到 AdSense 網站，且廣告標籤必須與遊戲在同一份文件（若用 iframe 包住遊戲，標籤要放在 iframe 內，並加上 `allow="autoplay"`）。

驗證紀錄見 `run-log.md`。
