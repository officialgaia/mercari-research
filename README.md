# メルカリ相場リサーチ

中国輸入の仕入れ候補について、メルカリで**どれだけ売れているか・いくらで売れているか・競合がどれだけいるか**を調べ、1個あたりの利益と「◎仕入れOK／△微妙／×見送り」を出すサイトです。

- サイト：https://officialgaia.github.io/mercari-research/
- 取得は **GitHub Actions** が行います（毎朝6時ごろ自動、サイトの「今すぐ更新」でも実行）
- 候補・設定・結果は**パスワードで暗号化**してリポジトリに置いています。サイトを開いても、パスワードを知らない人は中身を読めません

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
1. 「追加」でキーワード（例：`バッグチャーム ビーズ`）と仕入れ値（円 or 元）、国際送料を入れて保存
2. GitHub Actions が数分でメルカリの相場を取得し、ランキングに反映
3. 候補をタップすると、利益の内訳・売れた価格の分布（赤字ライン付き）・推移・最近売れた商品が見られる

コスト（仕入れ値・送料）や判定の目安を変えたときは、取り直さずにすぐ再計算されます。

### 指標の意味
- **相場**：期間内（初期30日）に売れた価格の中央値（設定で「安め＝下位25%」にもできる）
- **売れやすさ**：期間内に売れた数 ÷ 今出品されている数
- **売れるまで**：出品から売れるまでの日数の中央値
- **赤字ライン**：(仕入れ＋国際送料＋国内送料) ÷ (1−手数料)。これより安いと赤字

### 判定の基準（設定で変更可）
- ◎ 仕入れOK：利益300円以上・売れた数10件以上・売れやすさ0.3以上をすべて満たす
- △ 微妙：利益と売れた数がその半分以上
- × 見送り：それ以外

---

## うまく取得できないとき
- サイトの「設定 → 実行履歴（GitHub）」で Actions のログを見る
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
| `docs/data/config.enc.json` | 候補と設定（暗号化。サイトから編集） |
| `docs/data/results.enc.json` | 取得結果と履歴（暗号化。Actions が書き込み） |
| `research/update.py` | Actions で動く取得スクリプト |
| `research/fetcher.py` | メルカリからの取得（mercapi） |
| `research/analyzer.py` | 相場の集計・利益計算・判定 |
| `research/crypto.py` / `docs/crypto.js` | 暗号化（PBKDF2-SHA256 + AES-256-GCM） |
| `.github/workflows/update.yml` | 毎日・手動・候補変更時に取得 |

### テスト
```bash
pip install -r requirements.txt pytest
python -m pytest        # Node.js があれば、Python と JS の計算・暗号の一致も確認
```

### ダミーデータで試す
```bash
DATA_PASSWORD=test MOCK=1 DATA_DIR=/tmp/mr python -m research.update
```
