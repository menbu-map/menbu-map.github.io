# 麺部マップ

公開ページ: https://menbu-map.github.io/

## 構成

| 部品 | 場所 | 役割 |
|---|---|---|
| 地図ページ | このリポジトリの `index.html`（GitHub Pages） | 地図・検索・麺部AIの画面 |
| 麺部AIの受け口 | Supabase Edge Function `menbu-ask`（控え: `ops/menbu-ask.index.ts`） | 質問に答える／店一覧を返す |
| 店データ | Supabase の表 `menbu_shops` | 行を足すとページとAIに反映される |
| 取り込み記録 | Supabase の表 `menbu_imports` | 取り込み済みのLINE書き出しの記録 |
| AI利用回数 | Supabase の表 `menbu_ai_usage` | 1日の上限（600回＝約300問）の管理 |
| 旧URL | `startright3/menbu-map` | 新URLへの転送だけ |

## 更新のしかた

- 店を足す: `menbu_shops` に行を足す（ページの作り直しは不要）。LINEの書き出しを Googleドライブ「麺部LINE取り込み」に置くと、毎日の定期タスクが自動で足す。
- 画面を直す: `index.html` を直して main に push（1分ほどで反映）。
- 受け口を直す: `ops/menbu-ask.index.ts` を直して Supabase に配備し直す。配備したら控えも更新する。

## 守ること

- このリポジトリは公開。メンバーの名前・LINEの発言・鍵は置かない。
- 鍵（AI・ホットペッパー）は Supabase 側にだけあり、コードには書かない。
- 麺部AIは `https://menbu-map.github.io` からの利用だけ受け付ける。URLを変えるときは受け口の `ORIGIN_RE` も変える。

## 止まったときの確認順

1. https://menbu-map.github.io/ が開くか（GitHub Pages）
2. `https://uvdodybrxmllldazdtbu.supabase.co/functions/v1/menbu-ask` を開いて `{"ok":true,"llm":"...","hotpepper":true}` が返るか
3. AIだけ答えない: 1日の上限に達していないか（`menbu_ai_usage`）、AIの鍵の残高
4. 「未開拓」の店が地図に出ない: 外部の無料サーバー（Overpass）の混雑。時間をおく
