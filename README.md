# Door Dashboard

玄関ドア内側の Android タブレット（Fully Kiosk Browser）向け、子ども別チェックリスト付きダッシュボード。
GitHub Pages で静的ホストする。サーバー・バックエンドはなし。

- 時計・日付を大きく表示。天気・気温・降水確率は Open-Meteo から取得（APIキー不要）
- 子どもごとの列で、**いまの時間帯・曜日に当てはまるタスクだけ**を表示
- タップで完了をトグル（打ち消し線＋グレー）。状態は端末の localStorage に日付ごとに保存し、日付が変わると自動でリセット
- ゴミの日の朝はバッジ、雨の日は傘アラート、夜は翌日のゴミを予告
- 子どもの列の見出し（アイコン）をタップするとその子だけズーム。**顔認識**でも自動でズームできる（任意）
- Fully 連携：バッテリーが20%以下で未充電なら赤いバナー、右下の ⏻ で画面オフ、夜間の減光

## ファイル構成

```
index.html                    メインビュー（SPA）
css/style.css                 ダークテーマ（純黒背景）
js/app.js                     ロジック全体（先頭に CONFIG）
js/face.js                    顔認識（登録・照合。端末内だけで動く）
vendor/face-api/              顔認識ライブラリとモデル（約7.8MB）
data/tasks.json               子ども・ルーティンのマスターデータ
.github/workflows/deploy.yml  検証とPagesデプロイ
.github/workflows/tasks-from-issue.yml  Issue → tasks.json の自動反映
.github/ISSUE_TEMPLATE/task.yml         タスク追加フォーム
scripts/issue_task.py         Issueの解析と tasks.json の更新
```

## タスクの追加：GitHub Issue から（おすすめ）

スマホの GitHub アプリやブラウザでIssueを作るだけで、`tasks.json` の更新からデプロイまで自動で進む。
結果はIssueにコメントされ、Issueは自動で閉じる。タブレットへの反映は数分〜10分後。

**① タイトル1行で（いちばん速い）**

| 書き方 | 意味 |
|---|---|
| `+ 11/5 茶和子 体操服` | 11/5 に、茶和子の単発TODO |
| `+ 明日 花乃子 寛成 集金袋` | 担当は複数でもOK |
| `+ 上履きを持ち帰る` | 日付を省くと「明日」、担当を省くと全員 |
| `+ 来週の月曜 全員 遠足のお弁当` | 日付は `今日` `明日` `あさって` `金曜` `来週の月曜` `11/5` `5日` などが使える |
| `- 体操服` | タイトルに「体操服」を含む項目を削除（複数当たったら id の候補を返す） |

- `+` は全角の `＋` でもいい。区切りは全角スペースでもいい
- 本文は空のままでいい
- 単発TODOは、**前日17時から「明日：体操服」** と表示され、当日は5〜23時に表示される
- 担当の名前を書き間違えると、その語はタイトルの一部になり担当は全員になる。コメントの内容で確認する

**② フォームで（ルーティンの追加や細かい指定に）**
「New issue」→「タスクを追加・削除」を選び、種類・日付・担当・時間帯・曜日を選ぶ。
単発TODOだけでなく、毎週のルーティンの追加や削除もできる。

**仕組みと安全性**
- `.github/workflows/tasks-from-issue.yml` が `scripts/issue_task.py` を実行する
- 公開リポジトリなので、**持ち主（と招待した共同編集者）が作ったIssueだけ**を処理する。他人のIssueは無視する
- 2日以上前の単発TODOは、Issueを処理するたびに自動で消える
- 子どもの名前を変えたら、`.github/ISSUE_TEMPLATE/task.yml` の「担当」の選択肢も書き換える

## タスクの編集（`data/tasks.json` を直接）

```jsonc
{
  "members": [
    { "id": "kid1", "name": "茶和子", "icon": "🦁", "color": "#60a5fa" }
  ],
  "todos": [
    {
      "id": "todo_2026-11-05_12",  // Issueから追加すると自動で付く
      "title": "体操服",
      "date": "2026-11-05",
      "members": ["kid1"],
      "start_hour": 5, "end_hour": 23,  // 省略時は 5〜23
      "prev_evening": true              // 前日17時から「明日：」付きで表示
    }
  ],
  "routines": [
    {
      "id": "morning_trash",       // 一意。チェック状態のキーになる
      "title": "可燃ゴミ出し",
      "category": "morning",       // categories のキー（見出しに使う）
      "start_hour": 5,             // この時刻から表示（含む）
      "end_hour": 9,               // この時刻で非表示（含まない）。start より小さいと日付またぎ（例 19→2）
      "days": [1, 4],              // 0=日 … 6=土
      "members": ["kid1"],         // 担当。["all"] または省略で全員
      "tags": ["ゴミ", "お手伝い"]   // 「ゴミ」タグはゴミ出しアラートの対象
    }
  ]
}
```

- `members` の名前・アイコン・色はサンプルなので書き換える
- push すると Actions が JSON をチェックしてからデプロイ。タブレットは **10分ごと** に `tasks.json` を読み直すので、リロードは不要
- 日付またぎのタスク（19時→翌2時など）は、**始まった日**の曜日で判定する

## ローカルで確認

```bash
python3 -m http.server 8000
# http://localhost:8000/?now=2026-11-02T07:30   ← 時刻を指定して表示を確認
```

URLパラメータ：`now`（デバッグ用の時刻）、`lat` / `lon` / `loc`（天気の地点。既定は厚木）。

## GitHub Pages の有効化

```bash
git init && git add . && git commit -m "Initial commit"
gh repo create door-dashboard --public --source=. --push
```

1. リポジトリの **Settings → Pages → Build and deployment → Source** を **GitHub Actions** にする
   （このリポジトリはワークフローでデプロイする。「Deploy from a branch」は使わない）
2. `main` に push すると `https://<ユーザー名>.github.io/door-dashboard/` が公開される

> 公開リポジトリだと、子どもの名前を含む `tasks.json` は誰でも読める。気になる場合はニックネームにするか、Private リポジトリ＋Pages（有料プラン）を使う。

## Fully Kiosk Browser の設定

**基本**
- Settings → Web Content Settings → **Start URL**：上の Pages URL
- Settings → Advanced Web Settings → **Enable JavaScript Interface**：ON（バッテリー監視・画面オフ・減光に必要）
- Settings → Web Content Settings → **Enable Zoom / Pull to refresh**：OFF（誤操作防止）
- Settings → Kiosk Mode：必要に応じて ON（PINを設定）

**動体検知・擬似スリープ（推奨）**
1. Settings → Motion Detection (PLUS) → **Enable Visual Motion Detection**：ON
   - Motion Sensitivity：80〜90 くらい（玄関の明るさを見て調整）
   - **Turn Screen On on Motion**：ON
   - **Exit Screensaver on Motion**：ON
2. Settings → Device Management → **Keep Screen On**：ON
3. Settings → Screensaver → **Screensaver Timer**：120〜300秒
   - **Screensaver Brightness**：0
   - Screensaver Wallpaper URL：空欄（真っ黒になる）
   - 画面を完全に消したいなら **Screen Off Timer**（Device Management）を 600秒程度
4. Settings → Power Settings → **Prevent Sleep while Screen Off**：ON（Wi-Fi切断を防ぎ、復帰時にすぐ最新化）

人が来るとカメラで検知して画面が点き、アプリ側も `onMotion` / `screenOn` を受けて天気と表示を即更新する。

**電池まわり**
- 常時給電するなら、Power Settings で充電の上限設定（端末側の「バッテリー保護」80%など）を使うと膨張対策になる

## 顔認識で子どもを切り替える（任意）

普段は3人分の列が並ぶ。顔認識で子どもが分かると、その子の列が大きくなり、残りは細く畳まれる。
90秒操作がないと全員表示に戻る。認識が外れても、自分のアイコンをタップすれば切り替わる。

**しくみとプライバシー**
- 顔認識は `vendor/face-api/`（[@vladmandic/face-api](https://github.com/vladmandic/face-api) 1.7.15、MIT）でタブレット上だけで動かす。外部への通信はしない
- 保存するのは顔の特徴データ（128個の数値）だけ。**写真は保存しない**
- 保存先はそのタブレットの localStorage だけ。リポジトリには入らない（公開リポジトリでも漏れない）
- カメラを使っている間は、右下に必ずプレビューの小窓が出る

**セットアップ（タブレットで）**
1. 時計を **2秒長押し** → 設定を開く
2. 「顔認識で子どもの列をズーム」をON
3. 子どもごとに「登録」を押し、カメラを見てもらう（6枚分を自動で撮影）
   - 実際に立つ位置・明るさで登録する。朝と夕方の両方で「追加で登録」すると精度が上がる
4. 「認識テスト」で確認する

**いつ認識するか**
- Fully の動体検知で画面が点いたとき（`onMotion` / `screenOn`）に自動で8秒スキャン。連続実行は20秒あける
- 右下の 👤 ボタンでも手動でスキャンできる

**誤認識の対策（兄弟は似ているため）**
- 1位と2位の差が小さいときは「わからない」扱いにして、ズームしない
- 同じ子が2回続けて当たったら確定
- 外れが多いときは `js/face.js` 冒頭の `opts` を調整する：`threshold` を下げる（厳しく）、`margin` を上げる

**Fully 側で必要な設定**
- Web Content Settings → **Enable Webcam Access**：ON。Android のカメラ権限も Fully に許可する
- ⚠️ **Fully の動体検知もカメラを使う。** 端末によっては、動体検知中にページ側がカメラを開けない。その場合はスキャンの小窓が出たあとに「カメラが使えません」になる。対策の候補：
  - 動体検知をOFFにして、画面点灯は 👤 ボタンかタッチで行う
  - 動体検知は残して、顔スキャンは 👤 ボタンでだけ行う
  - 実機で両方試して、動く組み合わせを選ぶ

## 設定値（`js/app.js` 冒頭の `CONFIG`）

| 項目 | 既定 | 内容 |
|---|---|---|
| `lat` / `lon` | 35.44 / 139.36 | 天気の地点 |
| `tasksRefreshMin` | 10 | tasks.json を読み直す間隔（分） |
| `rainAlertPop` | 50 | 傘アラートを出す降水確率（%） |
| `batteryWarnLevel` | 20 | バッテリー警告を出す残量（%） |
| `nightStart` / `nightEnd` | 23 / 5 | 夜間減光の時間帯 |
| `dayBrightness` / `nightBrightness` | 180 / 20 | Fully の画面輝度（0–255） |
| `dailyReloadHour` | 3 | 長時間稼働対策で毎日リロードする時刻 |
| `focusTimeoutSec` | 90 | ズームから全員表示に戻るまでの無操作秒数 |
| `faceCooldownSec` | 20 | 自動の顔スキャンを繰り返さない間隔 |
| `longPressMs` | 2000 | 設定を開く長押しの長さ |

画面の焼き付き防止のため、表示全体を1分ごとに数ピクセルずらしている。
