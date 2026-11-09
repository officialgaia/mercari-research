# 相場リサーチ

中国から仕入れやすい雑貨ジャンル（約50）を**毎日自動でメルカリで調べ**、売れ筋と「**いくら以下で仕入れれば儲かるか（仕入れ上限・元／円）**」を出すサイトです。

- サイト：https://officialgaia.github.io/mercari-research/
- 調べるのは **GitHub Actions**（毎朝6時ごろ自動。設定の「今すぐ調べる」でも実行、10分ほど）
- 売れている商品のタイトルから売れ筋の言葉を拾って、「バッグチャーム パール」のような細かいキーワードも自動で見つけます（一覧で「発見」と表示）
- キャラクター・ブランド物（偽物になる）や、PSE・食品衛生法・化粧品・技適が関係するジャンルは対象外
- 1688の中国語キーワードとリンク付き
- データはパスワードで暗号化してリポジトリに置いています

> ⚠ メルカリの公式APIではなく、非公式ライブラリ [mercapi](https://github.com/take-kun/mercapi) を使っています。メルカリの仕様変更で取得できなくなることがあります。

---

## 最初の設定（1回だけ）

### 1. パスワードを Secret に登録
リポジトリの **Settings → Secrets and variables → Actions → New repository secret**
- Name：`DATA_PASSWORD`
- Secret：自分で決めたパスワード（長めがおすすめ。サイトでも同じものを入れます）

### 2. GitHub Pages を有効にする
**Settings → Pages**
- Source：**Deploy from a branch**
- Branch：**main**、フォルダ：**/docs** → Save

1〜2分で https://officialgaia.github.io/mercari-research/ が開けるようになります。

### 3. 編集用のトークンを作る（候補の追加・編集に必要）
https://github.com/settings/personal-access-tokens/new （Fine-grained token）
- Token name：`mercari-research`（なんでもOK）
- Expiration：好きな期間（切れたら作り直してサイトの設定で入れ直す）
- Repository access：**Only select repositories** → `mercari-research`
- Permissions → Repository permissions：
  - **Contents**：Read and write
  - **Actions**：Read and write
- 「Generate token」→ 表示された `github_pat_...` をコピー

### 4. サイトを開く
https://officialgaia.github.io/mercari-research/ を開いて、
- パスワード：手順1と同じもの
- GitHubトークン：手順3のもの
- リポジトリ：`officialgaia/mercari-research`

を入れて「はじめる」。パスワードとトークンはそのブラウザの中にだけ保存されます（スマホとPCでそれぞれ1回入れる）。
iPhone なら Safari の「共有 → ホーム画面に追加」でアプリのように使えます。

---

## 使い方
- 一覧の「おすすめ」「候補」「すべて」で絞り込み。タップすると詳しい数字・1688で探す・最近売れた商品
- 右上の⚙（設定）で、目標利益・国際送料・国内送料を変更（すぐ計算し直し）、調べたいキーワードの追加、今すぐ調べる
- いらないキーワードは詳細の一番下「このキーワードを表示しない」（設定から戻せる）

### 仕入れ上限の計算
`相場（売れた価格の中央値） − 手数料10% − 国内送料 − 国際送料 − 目標利益`。この値段以下で仕入れれば目標の利益が出ます。元への換算は毎日の為替レート（欧州中央銀行）。

### 判定
- ◎ おすすめ：30日で15個以上売れた・売れやすさ0.3以上・仕入れ上限150円以上
- △ 候補：30日で5個以上売れた・仕入れ上限50円以上
- × 見送り：それ以外

調べるジャンルの一覧は `research/seeds.py` にあります（追加・削除できます）。

---

## うまく取得できないとき
- サイトの「⚙ → 実行履歴」で Actions のログを見る
- `パスワードが違うか、ファイルが壊れています` → Secret の `DATA_PASSWORD` とサイトで入れたパスワードが違う
- `ProxyError` `403` `429` など → メルカリが GitHub のサーバーからのアクセスを弾いている可能性。下の「自分のPCで取得する」を試す

### 自分のPCで取得する（ブロックされたとき）
GitHub の「セルフホストランナー」を使うと、サイトはそのままで取得だけ自分のPCから行えます。
1. **Settings → Actions → Runners → New self-hosted runner** の手順でPCにランナーを入れる
2. `.github/workflows/update.yml` の `runs-on: ubuntu-latest` を `runs-on: self-hosted` に変える
（PCの電源が入っている間だけ取得されます）

### 毎日の自動取得の時刻を変える
`.github/workflows/update.yml` の `cron: "17 21 * * *"` を変えます（UTC表記。日本時間から9時間引く）。
※ GitHub の仕様で、リポジトリに60日間動きがないと定期実行が止まることがあります。

---

## ファイル構成
| パス | 中身 |
|---|---|
| `docs/` | サイト本体（GitHub Pages） |
| `docs/data/config.enc.json` | 設定・追加キーワード・非表示（暗号化。サイトから編集） |
| `docs/data/results.enc.json` | 取得結果と履歴（暗号化。Actions が書き込み） |
| `research/update.py` | Actions で動く取得スクリプト |
| `research/fetcher.py` | メルカリからの取得（mercapi） |
| `research/seeds.py` | 自動で調べるジャンル（＋中国語）と除外する言葉 |
| `research/analyzer.py` | 相場の集計・売れ筋語の抽出・仕入れ上限と判定 |
| `research/crypto.py` / `docs/crypto.js` | 暗号化（PBKDF2-SHA256 + AES-256-GCM） |
| `.github/workflows/update.yml` | 毎日・手動・キーワード追加時に取得 |

### テスト
```bash
pip install -r requirements.txt pytest
python -m pytest        # Node.js があれば、Python と JS の計算・暗号の一致も確認
```

### ダミーデータで試す
```bash
DATA_PASSWORD=test MOCK=1 DATA_DIR=/tmp/mr python -m research.update
```
