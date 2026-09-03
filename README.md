# 関東の水源モニター

東京都水道局「[貯水量情報](https://www.waterworks.metro.tokyo.lg.jp/suigen/suigen)」（利根川水系・荒川水系・多摩川水系）と、神奈川県企業庁「[かながわの水がめ](https://kanagawa-dam.jp/web_data/saves_rainfall_sagami.html)」（相模川水系）をもとに、東京都民目線でダムの貯水状況を可視化する静的サイトです。東京都は相模川水系からも川崎市の長沢浄水場経由で分水を受けているため、参考として含めています。

## 構成

- `index.html` / `styles.css` / `app.js` … 表示用の静的サイト本体。`data/reservoir.json` を読み込んで描画する。トップの「東京の水はどこから来ている？」は、東京都水道局が公表する水系別供給割合（80% / 17% / 3%、固定値）に、各水系の現在の貯水状況を重ねた構成比バー。
- `scripts/scrape.mjs` … 東京都水道局のページと神奈川県企業庁のAPIを取得し `data/reservoir.json` を生成するNode.jsスクリプト（東京都側は公式API/CSVが存在しないためHTMLスクレイピング）。神奈川県側の取得に失敗しても、東京都側3水系の更新は継続する（`try/catch`で分離）。
- `.github/workflows/update-data.yml` … 上記スクレイパーを1日2回（0時・7時の更新に合わせて）実行し、変更があれば自動コミットするGitHub Actions。
- `data/reservoir.json` … 直近の取得結果。サイトはこのファイルだけを読む（クライアントからのリアルタイム取得はしない）。

## ローカルでの確認

**`index.html` をダブルクリックして `file://` で開かないでください。** ブラウザのセキュリティ制限により `fetch()` が失敗し、「Failed to fetch」というエラーになります。必ずHTTPサーバー経由で開いてください。

```bash
npm install
npm run scrape          # data/reservoir.json を最新化
python3 -m http.server 8000   # もしくは npx serve .
# http://localhost:8000 を開く
```

## GitHub Pages への公開

1. このディレクトリの内容をリポジトリのルート（または任意のサブディレクトリ）にpush
2. リポジトリの Settings → Pages で、公開元を対象ブランチ・フォルダに設定
3. Settings → Actions → General で Workflow permissions を「Read and write permissions」にする（`update-data.yml` がコミット・pushするため）

以降はGitHub Actionsが定期的にデータを更新し、コミットするたびにPagesが再デプロイされます。

## データと危機度区分について

- データ更新頻度は東京都水道局側の日次更新に依存します。ページ内の「更新する」ボタンは、Actionsが最後に取得したデータを再読み込みするだけで、その場でリアルタイム取得するものではありません。
- 「順調 / やや注意 / 警戒 / 危機的」の区分（貯水率80%・50%・30%を境界とする）は本サイト独自の目安です。東京都・国が公表する取水制限等の公式基準とは異なります。
- スクレイパーはHTMLの表構造に依存しているため、東京都水道局側のページ構成が変わると動作しなくなる可能性があります。その場合は `scripts/scrape.mjs` の修正が必要です。
- 神奈川県側（相模川水系）の有効容量は、当日の貯水率から逆算した近似値です。洪水期/非洪水期で満水量自体が変わるため、前年同日・前々年同日・平年値の貯水率もあくまで参考値です。
- `kanagawa-dam.jp` は小規模なサイトで、短時間に連続アクセスするとレート制限がかかることがあります（ローカル確認時に発生する場合は少し時間を空けてください）。GitHub Actions実行時にこの取得が失敗しても、東京都側のデータ更新は継続します。
