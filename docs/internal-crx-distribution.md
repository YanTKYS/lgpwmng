# 庁内テスト配布（署名済み CRX + IIS）の検証手順

Chrome ウェブストア公開前に、**AD 管理下の Windows 版 Chrome で、希望する職員だけが庁内 IIS の案内ページから
lgpwmng を導入できるか**を、検証用の 1 台で確認するための手順です。

> **現在の状態: 実機での導入可否は未検証です。**
> CRX を生成できること（GitHub Actions で自動化済み）と、IIS のリンクから導入できることは別です。
> 後者は Chrome のバージョン・企業ポリシー・端末の管理状態に依存するため、
> [6. 検証結果の記録](#6-検証結果の記録) に実機の結果を書き込むまでは「IIS から 1 クリックで導入できる」とは言えません。
> 各ポリシーの最新の仕様は、公式ドキュメント（[拡張機能の配布方法](https://developer.chrome.com/docs/extensions/how-to/distribute) /
> [アプリと拡張機能のインストール元](https://support.google.com/chrome/a/answer/9039146?hl=en) /
> [ExtensionSettings](https://support.google.com/chrome/a/answer/9867568?hl=en)）で確認してください。

本書の URL・ホスト名・パスはすべて例示です。実際の庁内 URL や端末の識別情報は書き込まないでください。

対象外: AD/GPO への実際の適用（実環境の作業）、全端末への強制・自動配布、CRX 自動更新用 XML、
GitHub から IIS への自動アップロード、ブラウザや OS の制限を回避する非公式な導入手段。

## 1. CRX の入手と署名鍵

### 署名鍵を初回に一度だけ作る

拡張 ID は署名鍵で決まります。**鍵を固定すれば、版が変わっても拡張 ID は変わりません**（保存データの連続性に影響します）。
鍵は初回に一度だけ作り、以後は同じものを使い続けます。workflow は鍵が無いとき、理由を示して失敗します
（毎回新しい鍵を黙って作ることはありません）。

```bash
openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out lgpwmng-crx-key.pem
```

1. 作った `lgpwmng-crx-key.pem` の中身を、GitHub のリポジトリ Secrets に **`LGPWMNG_CRX_KEY`** として登録します
   （Settings → Secrets and variables → Actions）。`gh secret set LGPWMNG_CRX_KEY < lgpwmng-crx-key.pem` でも登録できます。
2. 鍵のバックアップを、リポジトリの外の安全な場所（庁内の管理された保管先）へ**オフラインで**保管し、作業用のコピーは削除します。
   **鍵を失うと、同じ拡張 ID の CRX を二度と作れません。** リポジトリ・Issue・ログ・Release・IIS には置きません
   （`.gitignore` で `*.pem` を除外しています）。
3. `v*` タグを作成できる人を、リポジトリ設定（タグの保護ルールなど）で必要な人に限ってください。
   workflow は main に含まれるコミットのタグだけを対象にしますが、タグを作れる人は鍵を使う workflow を動かせます。

### CRX を生成する

`manifest.json` のバージョンと同じタグ（例: `v<version>`）を **main のコミット**に付けて push すると、
`internal-crx` workflow が次を行います。

1. `npm test`、タグと `manifest.json` のバージョン照合
2. Web ストア用 ZIP の生成（`npm run package`。既存の `webstore-package` workflow と同じ処理）
3. その ZIP と同じ内容を Chrome 公式の `--pack-extension` / `--pack-extension-key` で署名して CRX 化
4. 署名・拡張 ID・中身（Web ストア用 ZIP と一致、秘密鍵の混入なし）の検証（`tools/crx.mjs`）
5. GitHub Release へ **`lgpwmng-webstore-v<version>.zip`**（Web ストア用）と **`lgpwmng-v<version>.crx`**（庁内テスト用）を添付

秘密鍵は 3 の 1 ステップにだけ渡され、Pull Request や main への push では使われません。ジョブの要約（Summary）に拡張 ID が出ます。
初回の ID が分かったら、リポジトリの変数 **`LGPWMNG_CRX_EXTENSION_ID`** に登録しておくと、
以後の版で鍵が取り違えられたとき（ID が変わるとき）に workflow が失敗します。

### 手元で再現する（開発者向け）

```bash
npm run package
mkdir -p work/lgpwmng && unzip dist/lgpwmng-webstore-v<version>.zip -d work/lgpwmng
chrome --headless=new --pack-extension="$PWD/work/lgpwmng" --pack-extension-key="$PWD/lgpwmng-crx-key.pem"
node tools/crx.mjs verify work/lgpwmng.crx --zip dist/lgpwmng-webstore-v<version>.zip
```

`chrome` は実行ファイルの名前に置き換えてください（Windows では `chrome.exe` のパス）。

## 2. IIS への配置

1. Release から `lgpwmng-v<version>.crx` をダウンロードし、IIS の公開フォルダ（例: `C:\inetpub\wwwroot\lgpwmng\`）へ**手動で**置きます。
2. 同じフォルダに、案内ページ `index.html` を置きます。リンクは通常の `<a href>` にします（`download` 属性は付けません）。

   ```html
   <!doctype html>
   <html lang="ja">
   <meta charset="utf-8">
   <title>lgpwmng 庁内テスト版</title>
   <h1>lgpwmng 庁内テスト版</h1>
   <p>検証に参加する職員向けです。<a href="lgpwmng-v<version>.crx">lgpwmng-v&lt;version&gt;.crx</a></p>
   ```

3. `.crx` の MIME タイプ `application/x-chrome-extension` を IIS に登録します。未登録の拡張子は、IIS が
   既定では配信しません（404）。サイトの `web.config` の例です（すでに別の場所で定義済みなら、重複エラーになるため追加しません）。

   ```xml
   <configuration>
     <system.webServer>
       <staticContent>
         <mimeMap fileExtension=".crx" mimeType="application/x-chrome-extension" />
       </staticContent>
     </system.webServer>
   </configuration>
   ```

4. テスト端末から到達性と応答を確認します。`StatusCode` が 200、`Content-Type` が上記になっていること。

   ```powershell
   Invoke-WebRequest -Method Head -Uri https://iis.example.lg.jp/lgpwmng/lgpwmng-v<version>.crx |
     Select-Object StatusCode, @{n='ContentType';e={$_.Headers['Content-Type']}}
   ```

## 3. テスト端末のポリシー（検証用 1 台のみ）

Chrome は、管理されていない Windows で Chrome ウェブストア以外からの拡張の導入を制限します。
管理環境で、**案内ページの URL と CRX 本体の URL の両方**を「インストール元」として許可する必要があります
（どちらかが許可されていないと、導入の流れに入らない想定です）。

| 項目 | 例 |
| --- | --- |
| 案内ページ | `https://iis.example.lg.jp/lgpwmng/index.html` |
| CRX 本体 | `https://iis.example.lg.jp/lgpwmng/lgpwmng-v<version>.crx` |
| 両方を含むパターン（同じフォルダに置く場合） | `https://iis.example.lg.jp/lgpwmng/*` |

次のどちらかで設定します。

- ポリシー **`ExtensionInstallSources`**（GPO の Chrome 用管理用テンプレート）に、上記のパターンを追加する。
- すでに **`ExtensionSettings`** を使っている場合は、`install_sources` に追加する（例）。

  ```json
  {
    "*": {
      "install_sources": ["https://iis.example.lg.jp/lgpwmng/*"]
    }
  }
  ```

注意:

- **自動インストール設定（`normal_installed` / `force_installed`）は使わない**でください。この検証の目的は、希望者だけが自分で導入できることの確認です。
- 拡張のインストールを一括でブロックするポリシー（`ExtensionInstallBlocklist` など）が別にある場合は、
  それが導入を妨げていないかを `chrome://policy` で確認します。
- 検証用の端末・ユーザーにだけ適用し、全端末へは展開しません。

## 4. 操作の確認と記録

1. テスト端末の Chrome で `chrome://policy` を開き、「ポリシーを再読み込み」してから、`ExtensionInstallSources`
   （または `ExtensionSettings`）が**適用済み**で、値が意図どおりか（エラー表示がないか）を確認します。Chrome のバージョン
   （`chrome://version`）も記録します。
2. IIS の案内ページを開き、CRX のリンクをクリックします。次のどれになったかを記録します。

   | 結果 | 意味 |
   | --- | --- |
   | A. インストール確認のダイアログが出る | 導入できる可能性が高い。許可して導入し、4-3 へ |
   | B. ファイルがダウンロードされるだけ | インストール元として扱われていない。下の切り分けへ |
   | C. エラーが表示される | エラーの文言をそのまま記録し、下の切り分けへ |

3. 導入できた場合は、`chrome://extensions` で拡張が有効か、拡張アイコンから popup が開くか、設定ページ（サービス一覧）が開くかを確認します。
   データ利用への同意の画面が出る（初回）ことも確認します。
4. B・C の切り分け（順に確認し、結果を記録します）:
   - `chrome://policy` に該当ポリシーがあり、状態が「OK」か。URL のパターンが案内ページと CRX の**両方**に一致しているか。
   - IIS の応答（手順 2-4）が 200 で、`Content-Type` が `application/x-chrome-extension` か。HTTPS の証明書が端末で信頼されているか。
   - Chrome のバージョンと、端末が管理されている状態か（ドメイン参加・Chrome の管理対象など）。
   - ブロック系のポリシーがないか。
   - ダウンロードした CRX を `chrome://extensions` へドラッグした場合の結果（導入できる／できない、エラー文言）。

## 5. 更新版と拡張 ID

- **同じ署名鍵で作った次版は、拡張 ID が一致します。** 次版を配置したら、`chrome://extensions` の ID が前版と同じか確認します
  （Release のジョブ要約と、変数 `LGPWMNG_CRX_EXTENSION_ID` の値とも照合）。CRX 自動更新用 XML は用意しないため、更新は新しい CRX の再配置と手動の再導入です
  （既存の拡張の上へ導入できるかも、実機で確認します）。
- **Web ストア版とは拡張 ID が異なる可能性があります**（ストア公開時はストア側で決まる鍵を使うため）。
  ID が違うと別の拡張として扱われ、`chrome.storage.local` に保存された Vault は**引き継がれません**。
- ID が変わる移行（庁内テスト版 → Web ストア版、鍵を作り直した場合など）は、設定ページの
  **マスターバックアップ**（暗号化バックアップ）で行います。移行前の拡張で「バックアップを保存」し、
  移行後の拡張で「バックアップを復元」します。パスフレーズを忘れると復元できません。
  バックアップファイルは取り扱いに注意し、復元後は不要なファイルを削除してください。

## 6. 検証結果の記録

実機で確認したら、次の表を埋めます（未記入の間は「未検証」です）。

| 項目 | 結果 |
| --- | --- |
| Chrome のバージョン | 未検証 |
| 端末の管理状態 | 未検証 |
| `chrome://policy` での適用状態 | 未検証 |
| IIS の応答（200 / Content-Type） | 未検証 |
| リンクをクリックしたときの挙動（A / B / C） | 未検証 |
| 導入後の動作（popup / 設定 / 同意画面） | 未検証 |
| 次版との拡張 ID の一致 | 未検証 |

## 7. 導入できなかった場合の代替運用案

結果が B・C で解消できない場合は、事実（Chrome のバージョン・ポリシー・応答・エラー文言）をこの表に記録したうえで、次を検討します。

- **現行の方法を案内する**: Release の ZIP を展開し、`chrome://extensions` の「パッケージ化されていない拡張機能を読み込む」で導入する（README 参照）。
- **管理者による配布へ切り替える**: 情報システム部門が `ExtensionSettings` / 強制インストールなどで配布する（本検証の対象外。別途方針の検討が必要）。
- **Chrome ウェブストアで公開する**: 公開後はストアからの導入にする（拡張 ID が変わる場合は 5 のバックアップ移行）。
