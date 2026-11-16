# 麺部マップ

公開ページ: https://menbu-map.github.io/ （SHOPを直接開く: https://menbu-map.github.io/#shop ）

## 画面

- 地図が全画面。上に検索欄（場所と麺を一緒に入れられる。全国対応）と絞り込みボタン、右下に現在地ボタン。
- 店の一覧は下から引き出すシート（PCでは左側）。ピンや一覧の店を押すと、店のカード（評価・写真・口コミ・経路）が出る。
- 麺AIは検索欄の右のボタン、SHOP（Tシャツ予約）と説明は上のバーから開く。

## 構成

| 部品 | 場所 | 役割 |
|---|---|---|
| 地図ページ | このリポジトリの `index.html`（GitHub Pages） | 地図・検索・麺AI・SHOPの画面 |
| 受け口 | Supabase Edge Function `menbu-ask`（控え: `ops/menbu-ask.index.ts`） | 麺AI／店一覧／近くの麺の店／Tシャツ予約 |
| 店データ | Supabase の表 `menbu_shops` | 行を足すとページとAIに反映される |
| 取り込み記録 | Supabase の表 `menbu_imports` | 取り込み済みのLINE書き出しの記録 |
| AI利用回数 | 表 `menbu_ai_usage`・`menbu_ai_ip`（関数 `menbu_ai_hit`） | 全体1日600回、同じ相手は1日80回まで。接続元は伏せ字で記録し8日で消える |
| Googleマップの回数 | 表 `menbu_gmaps_usage`（関数 `menbu_gmaps_hit`） | 地図の読み込みは1日300回まで。超えた日は国土地理院の地図で動く |
| Tシャツ予約 | 表 `menbu_tshirt_config`（設定1行）・`menbu_tshirt_orders`（予約） | 受付の開閉・価格・締切・サイズ・色と、予約の記録 |
| 旧URL | `startright3/menbu-map` | 新URLへの転送だけ |

受け口の使い分け（GETは `?…`、POSTは本文）:

- `?shops=1` 店一覧（とGoogleマップ用のブラウザ鍵）
- `?near=1&lat=…&lon=…&r=…&kw=…` 近くの麺の店（ホットペッパー。AIは使わない）
- `?tshirt=1` Tシャツの受付状況
- POST `{q:…}` 麺AI／POST `{action:"tshirt",…}` Tシャツ予約（同じ相手から1日5件まで）

## 外部サービスと無料枠

- Googleマップ（プロジェクト「menbu-map」）: 鍵「menbu-map browser」は `https://menbu-map.github.io/*` とMaps JavaScript API・Places API (New) だけに制限。鍵は Supabase の `GOOGLE_MAPS_BROWSER_KEY` にだけ置く。Google側の1日上限（地図320回、店の検索30回、写真30回、ほかは0）で月の無料枠内に収めている。
- ホットペッパーグルメ Webサービス: 近くの麺の店と麺AIの候補。表示には「Powered by ホットペッパーグルメ Webサービス」を出す。
- OpenStreetMap（Overpass）: 近くの麺の店の補助。混んでいて取れないことがある。
- 麺AIの文章: OpenAI（gpt-4o-mini）。

## 更新のしかた

- 店を足す: `menbu_shops` に行を足す（ページの作り直しは不要）。LINEの書き出しを Googleドライブ「麺部LINE取り込み」に置くと、毎日の定期タスクが足す候補を山下さんに出し、返事をもらってから足す。
- Tシャツの受付を開ける: `menbu_tshirt_config` の `open=true` と `price`・`deadline`（日付）・`sizes`・`colors`・`handover` を入れる。締切日の翌日から自動で受付終了になり、SHOPから消える。テストの予約は `status='canceled'` にする。
- 画面を直す: `index.html` を直して main に push（1分ほどで反映）。
- 受け口を直す: `ops/menbu-ask.index.ts` を直して Supabase に配備し直す。配備したら控えも更新する。

## 守ること

- このリポジトリとページは公開。メンバーの名前・LINEの発言・鍵は置かない。Tシャツ予約の名前は Supabase の表にだけあり、ページには出さない。
- 鍵（AI・ホットペッパー・Google）は Supabase 側にだけあり、コードには書かない。
- 受け口は `https://menbu-map.github.io` からの利用だけ受け付ける。URLを変えるときは受け口の `ORIGIN_RE` と、Googleの鍵の制限も変える。

## 止まったときの確認順

1. https://menbu-map.github.io/ が開くか（GitHub Pages）
2. `https://uvdodybrxmllldazdtbu.supabase.co/functions/v1/menbu-ask` を開いて `{"ok":true,"llm":"...","hotpepper":true}` が返るか
3. 地図が白黒のGoogleでなく国土地理院になる: その日の300回に達したか、Googleの鍵の制限・請求設定
4. 口コミ・写真が出ない: Google側の1日上限（店の検索・写真30回）に達したか
5. 麺AIだけ答えない: 1日の上限（`menbu_ai_usage`・`menbu_ai_ip`）、AIの鍵の残高
6. 近くの店が少ない・出ない: ホットペッパーの応答、Overpassの混雑。時間をおく
