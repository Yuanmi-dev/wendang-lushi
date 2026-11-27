# 穩當路試驗證紀錄

檢查時間：2026-11-27 18:43 台北時間（Asia/Taipei）。以本機 `python3 -m http.server` 搭配 Playwright 與系統 Chrome（`--headless=new --disable-gpu --no-sandbox --disable-dev-shm-usage`）執行。未使用 fal 產生素材，花費 0 美元；畫面為程序繪製。

## 關卡與腳本過關

`__WENDANG__.beatAll()` 結果為 **12／12 通過**。腳本用每關手刻路點速度控制油門與煞車，限制 90 秒。三星時間依腳本成績加一些餘裕設定。

| 關 | 名稱 | 腳本時間 | 星 | 零件 | 貨物 | 備註 |
| --- | --- | ---: | ---: | --- | --- | --- |
| 1 | 場地熱身 | 9.80 秒 | 3 | 完整 | — | 平地進旗門 |
| 2 | 緩坡來回 | 11.85 秒 | 3 | 完整 | — | 上下坡 |
| 3 | 小缺口 | 8.58 秒 | 3 | 完整 | — | 跳台缺口 |
| 4 | 獨木晃板 | 10.87 秒 | 3 | 完整 | — | 限角蹺板 |
| 5 | 陡坡別翻 | 11.35 秒 | 3 | 完整 | — | 爬坡與下坡 |
| 6 | 細橋慢過 | 10.07 秒 | 3 | 完整 | — | 活動木橋 |
| 7 | 陶罐要穩 | 27.32 秒 | 3 | 完整 | 保住 | 貨物關，顛簸路 |
| 8 | 連續跳台 | 9.70 秒 | 3 | 完整 | — | 三連跳 |
| 9 | 環形坡道 | 11.63 秒 | 3 | 完整 | — | 餘弦凹槽與圓丘 |
| 10 | 脆弱棧道 | 10.00 秒 | 3 | 完整 | — | 可擊斷木板 |
| 11 | 連串蹺板 | 16.15 秒 | 3 | 完整 | — | 兩段蹺板 |
| 12 | 收工路試 | 17.92 秒 | 3 | 完整 | 保住 | 坡、橋、跳台、貨物 |

## 輸入延遲與幀率

- 在 `play` 狀態按下油門時，同一事件處理函式內就呼叫 `applyDrive` 設定輪上馬達。8 次量測中，7 次為 0 ms，1 次為 0.10 ms，相當於 0 幀延遲。
- 約 1.5 秒實跑：`requestAnimationFrame` 平均間隔 16.67 ms（60.00 fps），遊戲內建統計 60.01 fps。

## 廣告呼叫點

- 預設（無 `fakead`、`CFG.ADS_ENABLED === false`）：不注入 `adsbygoogle.js`，`adBreak` 未定義，`adsState().wanted === false`，`client` 為空字串。
- `?debug=1&fakead=1`：失敗後出現「看廣告再試一次」；點擊後本機模擬畫面文案為「這是本機模擬，沒有向 Google 發送請求」。選擇「看完」後 `breakStatus` 為 `viewed`，關卡自倒數重生，且同一關只給一次。
- 每完成 3 關，下一關前插入 interstitial：第 3 次 `goNextOrMenu` 時出現 `breakType: "next"`、`breakName: "next-level"`，狀態 `viewed`。模擬時長約 1.4 秒（`ADS_FAKE_MS`）。

## 截圖

放在 `screenshots/`：

- `menu-phone.png`、`menu-desktop.png`：關卡選單
- `countdown-l5-phone.png`：第 5 關倒數
- `play-l5-phone.png`：第 5 關爬坡
- `play-l1-desktop.png`：第 1 關接近旗門
- `play-l9-desktop.png`：第 9 關接近凹槽
