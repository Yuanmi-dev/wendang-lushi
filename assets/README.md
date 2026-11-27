# 車輛精靈

遊戲車身改用 `refs/fal-concepts/concept-03.png` 的裁切精靈，不再手繪車體。

- `car-body.webp`：去背、去掉輪胎後的車身（輪拱為深色空腔）。朝右。
- `car-wheel.webp`：從概念圖裁下的輪胎與五幅輪圈，可旋轉。
- `car-roof.webp`：車頂區塊，完好時不另畫（已含在車身裡）；斷開後才飛出。

去背使用 fal `fal-ai/birefnet/v2`。輪拱與輪圈精靈在本機由概念圖裁切與清理，以保持與 concept-03 相同的外形與顏色。無商標、無文字。
