# Privacy Practices 申告案

Chrome ウェブストア Developer Dashboard → **Privacy practices** タブへ入力する内容の案です。
分類名称は現在の Dashboard の選択肢に合わせています（Dashboard の文言が変わっている場合は、
実際の画面の表記を優先してください）。

Dashboard の Privacy practices タブは、次の 5 つのブロックで構成されています。

1. Single purpose description
2. Permission justification（`manifest.json` の権限ごと）
3. Are you using remote code?
4. Data usage（収集するデータの種類の申告 + 3 つの証明チェック）
5. Privacy policy URL

---

## 1. Single purpose description

[single-purpose.md](single-purpose.md) の本文をそのまま貼り付けます。

## 2. Permission justification

[permissions.md](permissions.md) の `activeTab` / `scripting` / `storage` の項をそれぞれ貼り付けます。

## 3. Are you using remote code?

**選択: `No, I am not using remote code`**

根拠は [remote-code.md](remote-code.md) を参照してください。

## 4. Data usage

### 4.1 収集するデータの種類（チェックする項目）

Dashboard の選択肢と、lgpwmng での該当有無は次のとおりです。

| Dashboard の選択肢 | 該当 | 内容 |
| --- | --- | --- |
| Personally identifiable information | **チェックする** | 利用者が登録するログインID・利用者番号・職員番号など、業務システム上の識別番号が該当し得るため |
| Health information | しない | 扱わない |
| Financial and payment information | しない | 扱わない |
| Authentication information | **チェックする** | ログインID・パスワード・第二パスワード・PIN 等を利用者が登録する |
| Personal communications | しない | 扱わない |
| Location | しない | 扱わない |
| Web history | **チェックする** | 利用者が拡張アイコンを操作した時点の現在のタブ／フレームの URL を読み取り、登録したログイン画面の URL 条件（origin + pathname）を保存するため。Chrome の閲覧履歴を取得するものではない（下記の補足を参照） |
| User activity | しない | クリック・スクロール等の操作記録、利用状況を収集しない |
| Website content | **チェックする** | 「このログイン画面を設定」実行時に、対象ページの入力欄の構造情報（種別・`id` / `name` / セレクタ・ラベル文言・フレーム情報）と、そのとき入力されている値を取得する |

> 4 項目にチェックを入れますが、いずれも **利用者の端末内に保存するだけ**で、開発者や第三者へ
> 送信することはありません。Dashboard の申告は「拡張が扱う（handle する）データの種類」を示すもので、
> 「外部へ送信する」ことを意味するものではありません。Google のユーザーデータ FAQ も、収集・送信・
> 使用・共有のいずれかを行えば handle に当たるとしており、端末内で処理・保存するだけでも申告の
> 対象になります。この点は Privacy Policy 本文
> （<https://yantkys.github.io/lgpwmng/privacy.html>）でも明記しています。

### Web history をチェックする理由

Google は「Web browsing activity」を **利用者が要求・操作する Web サイトや Web リソースに関する
あらゆる情報（ブラウザがやり取りするドメインや URL を含む）** と定義しています。lgpwmng は、

- 利用者が拡張アイコンを操作した時点の、現在のタブ／フレームの URL を読み取る
- 利用者が登録したログイン画面の URL 条件（origin + pathname）を暗号化 Vault に保存する
- 入力の直前に、現在の URL がその条件に一致するかを照合する

という形で URL を扱うため、この定義に該当します。**閲覧履歴の一覧を取得したり、利用者が訪れた
ページを記録したりするものではありません**が、申告・Privacy Policy・実際の挙動が食い違うと
ポリシー違反になり得るため、安全側に倒して Web history もチェックします。

Limited Use の「許可された使用」は、利用者向け機能を提供するために必要な範囲での web browsing
activity の利用を認めています。lgpwmng の URL の扱いは、誤ったサイトへ認証情報を入力しないための
照合と、対象ログイン画面の特定という、単一目的そのものに必要な用途に限られます。

### 4.2 証明（Certifications）

3 つとも **チェックできます**。

| Dashboard の証明文 | lgpwmng での状況 |
| --- | --- |
| I do not sell or transfer user data to third parties, outside of the approved use cases | データを第三者へ販売・転送しない。転送する経路自体が存在しない |
| I do not use or transfer user data for purposes that are unrelated to my item's single purpose | 取り扱う情報は、ログインフォームへの入力補助とその設定管理・バックアップ・利用者による共有ファイル作成のためだけに使用する |
| I do not use or transfer user data to determine creditworthiness or for lending purposes | 与信・融資目的の利用は一切ない |

### 4.3 各観点への回答（審査コメント欄へ補足する場合の内容）

| 観点 | 回答 |
| --- | --- |
| どの種類のユーザーデータを扱うか | 認証情報（ログインID・パスワード・第二パスワード・PIN 等）、組織識別情報（自治体コード・所属コード・職員番号等）、利用者が定義した任意のフォーム入力値、対象ログイン画面の URL（オリジン + パス）、入力欄の構造情報、サービス名・アカウント名・メモ。Dashboard の分類では Personally identifiable information / Authentication information / Website content / Web history に該当する |
| 何の目的で扱うか | (1) ログインフォームへの入力補助、(2) サービス／アカウント設定の管理、(3) バックアップ、(4) 利用者が明示的に作成する共有用ファイル。以上に限る |
| 外部送信するか | **しない。** ネットワーク通信を行うコードを含まない（`fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource` / `sendBeacon` の呼び出しなし）。`host_permissions` なし。外部 API・CDN・クラウド同期・分析・広告・テレメトリのいずれも使用しない |
| 販売するか | **しない。** 取得していないため販売できない |
| 広告利用するか | **しない。** 広告機能を持たず、広告目的のデータ利用・転送も行わない |
| 人による閲覧があるか | **ない。** 開発者を含め、誰も利用者のデータへアクセスできない。データは利用者の端末内にのみ存在し、マスターパスワードなしでは復号できない |
| データの保存場所 | 利用者の端末内のみ。`chrome.storage.local`（暗号化済み Vault と KDF パラメータ）と `chrome.storage.session`（アンロック中の導出鍵、アクセスレベル `TRUSTED_CONTEXTS`）。`chrome.storage.sync` は不使用 |
| 暗号化 | 鍵導出は PBKDF2-SHA256（310,000 回、16 バイトのランダムソルト）、暗号化は AES-GCM 256bit。いずれもブラウザの Web Crypto API を使用し、独自暗号は実装していない。マスターパスワードそのものもハッシュも保存しない（復号の成否で判定）。復号済みの Vault は Service Worker のメモリ上にのみ存在し、永続化しない |
| single purpose との関係 | 扱う情報はすべて、単一目的（ログインフォームへの入力補助）とそれを支える設定管理・保全のためだけに使用する。目的外の収集・利用は行わない |
| 保持期間・削除 | 利用者が削除するまで端末内に保持。拡張を削除すると `chrome.storage` 上のデータは Chrome によって削除される。導出鍵はブラウザ終了時または「ロック」実行時に破棄される |

### 4.4 Limited Use への適合

Chrome ウェブストアのユーザーデータポリシーが求める Limited Use 開示は、Privacy Policy の
「9. Chrome ウェブストア『限定的な使用（Limited Use）』への適合」に記載しています。

- 許可された使用: 単一目的とそれを支える機能のためだけに使用
- 許可された転送: 転送しない（経路が存在しない）
- 広告の禁止: 広告目的の利用・転送を行わない
- 人による閲覧の禁止: 開発者を含め誰も閲覧できない

### 4.5 目立つ開示と明示的な同意（Prominent disclosure / Affirmative consent）

**v0.6.0 で、初回のデータ利用開示と明示的な同意を実装しました。**

拡張アイコンを初めて押すと、popup に次の内容を示す画面が出ます。「同意して利用を開始」を
押すまで、`chrome.tabs.query()` による現在のタブの URL 取得も、ページへのコード注入
（走査・取り込み・入力）も行いません。

```text
lgpwmngのデータ利用について

lgpwmng はログイン入力補助のため、次の情報を扱います。

・現在のページの URL
・ログインフォームの入力欄の情報
・設定時に入力済みの値（ユーザーID・パスワード等を含む）

これらは端末内でのみ処理・保存し、外部サーバーへ送信しません。
認証情報はマスターパスワードから導出した鍵で暗号化して保存します。

[同意して利用を開始]
```

実装は次のとおりです。

| 項目 | 内容 |
| --- | --- |
| 表示場所 | popup の最初の画面（`src/popup/popup.html` の `#view-consent`） |
| 同意の操作 | 「同意して利用を開始」ボタンの明示的な押下 |
| 同意前に行わないこと | `chrome.tabs.query()`、`SERVICE_MATCH`、`PAGE_SCAN`、`PAGE_CAPTURE`、`SCAN_RESULT_GET`、`PAGE_HIGHLIGHT`、`FILL_RUN`。`SCAN_RESULT_GET` は新たな走査ではないが、過去にページから取得した入力欄の構造を読み出すため含める |
| 二重の確認 | 画面側の制御に加え、Service Worker 側でも `requireConsent()` で確認する（`src/background/service-worker.js`） |
| 同意の記録 | `chrome.storage.local` の `lgpwmng.consent` に `privacyConsentVersion`（現在 1）と `grantedAt` のみ。認証情報は含まない |
| 再同意 | 扱うデータの内容を変えたら `CONSENT_VERSION` を上げる。古いバージョンへの同意は未同意として扱う |
| 状態の確認 | 設定ページ →「マスターパスワード / バックアップ」タブ →「この拡張について」に表示 |
| 開示の常設 | 同じ内容を、上記「この拡張について」に表として常時掲載する |
| 自動テスト | 同意の確認が `chrome.tabs.query` より前にあること、5 つの要求が `requireConsent()` で保護されていることを `test/package.test.js` が検査。`consent.js` の挙動は `test/consent.test.js` |

#### 位置づけについての補足

ユーザーデータ FAQ の Q9 は、目立つ開示と明示的な同意が必要になるのは
**(a) 個人情報・機微情報を扱い、かつ (b) その取り扱いがストア掲載ページと UI で目立つ形で
説明されている機能と密接に関係しない場合**の両方を満たすときだ、としています。

lgpwmng が扱う URL・入力欄・認証情報は、掲載ページと UI で説明している「ログイン入力補助」
そのものに使うため、(b) には当てはまらない（＝厳密には必須ではない）という読み方もできます。
それでも、認証情報という機微性の高いデータを扱う以上、利用者が内容を理解したうえで開始できる
ほうが望ましいため、v0.6.0 で実装しています。審査時にも、扱うデータとその範囲を利用者へ
どう示しているかを、実物の画面で確認してもらえます。

## 5. Privacy policy URL

```text
https://yantkys.github.io/lgpwmng/privacy.html
```

同じ内容をリポジトリの [PRIVACY.md](../../PRIVACY.md) にも置いています。公開ページは PRIVACY.md から
生成しており（`node tools/build-docs.mjs`）、内容が食い違わないことを `npm test` で検査しています。

---

## 申告と実装の対応表（自己点検用）

| 申告内容 | 実装上の根拠 |
| --- | --- |
| 外部送信なし | 通信 API の呼び出しがないことを `test/package.test.js` が検査 |
| リモートコードなし | 外部 URL 参照・`eval` / `new Function` がないことを `test/package.test.js` が検査。CSP は `script-src 'self'; object-src 'self'` |
| 広範な権限なし | `manifest.json` の `permissions` が `activeTab` / `scripting` / `storage` のみ、`host_permissions` なしであることを `test/package.test.js` が検査 |
| 端末内保存・暗号化 | `src/lib/crypto.js`（PBKDF2 + AES-GCM）、`src/background/vault-store.js`（`chrome.storage.local` / `session`） |
| 認証情報をログへ出さない | `console` 出力がソース全体に存在しないことを `test/package.test.js` が検査 |
| 同意前にデータへ触れない | `src/background/consent.js` の `requireConsent()`。popup の同意確認が `chrome.tabs.query` より前にあることを `test/package.test.js` が検査 |
