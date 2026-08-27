# Permissions Justification（権限の利用理由）

Chrome ウェブストア Developer Dashboard → **Privacy practices** → **Permission justification** に
入力する内容です。Dashboard には `manifest.json` で宣言した権限ごとに入力欄が表示されます。

`manifest.json` が宣言している権限は次の 3 つだけです。

```json
"permissions": ["activeTab", "scripting", "storage"]
```

`host_permissions` は宣言していません。`<all_urls>` や `*://*/*` などの広範なホスト権限、
`tabs`、`webNavigation`、`cookies`、`downloads`、`nativeMessaging`、`identity`、
`declarativeNetRequest`、`externally_connectable` はいずれも使用していません。

---

## activeTab

### 入力する文（日本語）

```text
利用者が拡張アイコンから明示的に操作した、現在のタブのページだけを対象に、ログインフォームを
解析し、登録済みの値を入力するために使用します。

対象となるのは「このログイン画面を設定」または「ログイン情報を入力」を実行した時点の
アクティブなタブだけです。利用者が拡張を操作していない間、拡張はページへアクセスしません。
恒久的なホスト権限（<all_urls> 等）を要求しないために activeTab を採用しています。
```

### 入力する文（英語）

```text
Used to access only the current tab, and only when the user explicitly acts through the extension's
toolbar icon, in order to analyze the login form on that page and fill in the values the user has
registered.

Access is limited to the active tab at the moment the user runs "set up this login page" or
"fill login information". The extension does not touch any page while the user is not interacting
with it. activeTab is used specifically so that no broad, persistent host permission
(such as <all_urls>) is required.
```

---

## scripting

### 入力する文（日本語）

```text
現在のページの input / select / textarea 要素を検出し、利用者が選択したアカウントの登録値を
それらの入力欄へ入力するために使用します。

chrome.scripting.executeScript でその都度コードを注入する方式をとっており、常駐する
content script は登録していません。注入するコードは拡張パッケージ内の関数だけで、外部から
取得したコードは実行しません。入力の直前に、注入したコード自身がページの location を再確認し、
登録済みの URL 条件に一致しない場合は 1 項目も入力しません。

注入したコードへ Vault 全体を渡すことはなく、その回の入力に必要な項目の値だけを引数として
渡します。
```

### 入力する文（英語）

```text
Used to detect the input, select and textarea elements on the current page and to fill them with
the values of the account the user selected.

Code is injected on demand with chrome.scripting.executeScript; no persistent content script is
registered. Only functions contained in the extension package are injected; no remotely fetched
code is executed. Immediately before filling, the injected code re-checks the page's own location
and fills nothing if it no longer matches the URL rules registered for the service.

The injected code never receives the whole vault - only the values needed for that single fill
operation are passed as arguments.
```

---

## storage

### 入力する文（日本語）

```text
暗号化された Vault（登録済みのサービス設定・認証情報）、利用者の設定、およびアンロック状態を
端末内へ保存するために使用します。

chrome.storage.local には暗号化済みの Vault と鍵導出パラメータだけを保存し、平文の認証情報は
保存しません。アンロック中の導出鍵は chrome.storage.session にのみ保持し、アクセスレベルを
TRUSTED_CONTEXTS に設定しています。ブラウザ終了時に破棄されます。

chrome.storage.sync は使用していません。データが端末外へ出ることはありません。
```

### 入力する文（英語）

```text
Used to store the encrypted vault (registered service settings and credentials), user preferences,
and the unlocked session state on the user's own device.

chrome.storage.local holds only the encrypted vault and its key-derivation parameters; no
plaintext credential is stored. The derived key for the current unlocked session is kept only in
chrome.storage.session with access level TRUSTED_CONTEXTS, and is discarded when the browser exits.

chrome.storage.sync is not used. No data leaves the device.
```

---

## 権限を要求していないことの補足

Dashboard の入力欄には現れませんが、審査コメント欄で補足する場合に使える内容です。

| 使っていない仕組み | 代わりにしていること |
| --- | --- |
| `host_permissions` / `<all_urls>` | `activeTab` のみ。利用者の操作時にだけ現在のタブへアクセスする |
| 常駐 content script（`content_scripts`） | `chrome.scripting.executeScript` による都度注入 |
| `tabs` | 現在のタブの URL は `activeTab` の範囲で取得する |
| `downloads` | バックアップ・共有ファイルの保存は `<a download>` によるブラウザ標準のダウンロード |
| `webRequest` / `declarativeNetRequest` | 通信を一切行わないため不要 |
| `identity` / OAuth | アカウント登録・外部認証を行わない |
| `nativeMessaging` | 外部プロセスと連携しない |
| `externally_connectable` | 他の拡張・Web ページからのメッセージを受け付けない |
