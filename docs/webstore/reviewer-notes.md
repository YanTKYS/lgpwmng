# 審査コメント欄へ貼り付ける文（要約版）

Developer Dashboard で **Submit for Review** を押したときのダイアログ、または審査担当者から
問い合わせがあった場合の返信に貼り付ける短い版です。詳細な手順は
[../webstore-review.md](../webstore-review.md) にあります。

---

## 日本語版

```text
【動作確認用のデモページ】
対象となる業務システムは組織の閉域ネットワーク内にあり、外部からアクセスできません。
動作確認用に、架空の業務システムを模した公開デモページを用意しています。

  Reviewer Demo: https://yantkys.github.io/lgpwmng/reviewer-demo.html
  Privacy Policy: https://yantkys.github.io/lgpwmng/privacy.html

【ダミー認証情報】（実在の認証情報ではありません）
  自治体コード: 123456
  ユーザーID:   test-user
  パスワード:   test-pass-123
マスターパスワードは任意の 8 文字以上を設定してください（保存も送信もされません）。

【確認手順】
1. Reviewer Demo ページを開く
2. lgpwmng のアイコンをクリックする
3. 初回のみ「lgpwmng のデータ利用について」が表示される。扱う情報・用途・外部送信しないことを
   確認し、「同意して利用を開始」を押す
4. マスターパスワードを設定する（初回のみ、8 文字以上の任意の値）
5. 「このログイン画面を設定」を選択する
6. 自治体コード / ユーザーID / パスワードの入力欄が候補として表示されることを確認する
7. 上記のダミー値を入力して「保存」を押す
8. Reviewer Demo のタブへ戻り、再読み込みする
9. lgpwmng のアイコンをクリックし、アカウントを選択する
10.「ログイン情報を入力」を実行する
11. 3 つの入力欄へ値が入ることを確認する
12. ログインボタンが自動で押されないことを確認する

【補足】
・初回に扱うデータの開示と明示的な同意を行います。同意するまで、現在のタブの URL の取得
  （chrome.tabs.query）もページへのコード注入も行いません。同意状態は画面側だけでなく
  Service Worker 側でも確認しています。同意の記録は chrome.storage.local に開示バージョンのみで、
  認証情報は含みません。
・リモートコードは使用していません。
・ネットワーク通信を行うコードを含みません（fetch / XMLHttpRequest / WebSocket /
  EventSource / sendBeacon のいずれも使用していません）。host_permissions もありません。
・権限は activeTab / scripting / storage のみです。ページへのアクセスは、利用者が
  拡張アイコンを操作したときに限られます。常駐 content script はありません。
・認証情報は PBKDF2-SHA256（310,000 回）+ AES-GCM 256bit で暗号化し、
  chrome.storage.local にのみ保存します。マスターパスワードは保存しません。
・iframe 内のログインフォームへの対応を確認する場合は、次のページを使用してください。
  https://yantkys.github.io/lgpwmng/reviewer-demo-frame.html
```

## English version

```text
[Demo page for testing]
The target systems are internal government/enterprise web applications on closed networks and are
not reachable from outside. A public demo page that imitates such a login screen is provided for
testing:

  Reviewer Demo: https://yantkys.github.io/lgpwmng/reviewer-demo.html
  Privacy Policy: https://yantkys.github.io/lgpwmng/privacy.html

[Dummy credentials] (not real credentials)
  Organization code: 123456
  User ID:           test-user
  Password:          test-pass-123
Set any master password of 8+ characters. It is never stored or transmitted.

[Steps]
1. Open the Reviewer Demo page.
2. Click the lgpwmng toolbar icon.
3. On first run a data-use disclosure appears ("lgpwmng のデータ利用について"). It lists what the
   extension handles and states that nothing is sent to any server. Press
   "同意して利用を開始" (Agree and start).
4. Set a master password (first run only; any value with 8+ characters).
5. Choose "このログイン画面を設定" (Set up this login page).
6. Confirm the three fields are detected as candidates.
7. Enter the dummy values above and press "保存" (Save).
8. Go back to the Reviewer Demo tab and reload it.
9. Click the lgpwmng icon and select an account.
10. Run "ログイン情報を入力" (Fill login information).
11. Confirm the three fields are filled.
12. Confirm the login button is NOT clicked automatically.

[Notes]
- A prominent data-use disclosure with affirmative consent is shown on first run. Before consent is
  given the extension does not read the active tab's URL (no chrome.tabs.query) and injects no code
  into any page. This is enforced in the service worker as well as in the popup UI. Only the
  disclosure version is stored (chrome.storage.local); no credential is part of that record.
- No remote code is used.
- The extension contains no networking code at all (no fetch, XMLHttpRequest, WebSocket,
  EventSource or sendBeacon) and declares no host_permissions.
- Permissions are activeTab, scripting and storage only. Page access happens only when the user
  acts through the toolbar icon; no persistent content script is registered.
- Credentials are encrypted with PBKDF2-SHA256 (310,000 iterations) + AES-GCM 256-bit and stored
  only in chrome.storage.local. The master password itself is never stored.
- To check support for login forms inside an iframe, use:
  https://yantkys.github.io/lgpwmng/reviewer-demo-frame.html
```
