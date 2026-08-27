# Chrome ウェブストア申請チェックリスト

リポジトリ側の準備と、Developer Dashboard 上でしか実施できない作業をまとめたものです。
コードで自動化できない操作はすべてここに集約しています。

---

## A. リポジトリ側（`npm test` で確認できるもの）

すべて v0.6.0 の時点で完了しています。`npm test` が通ることが確認の代わりになります。

- [x] `manifest.json` が Manifest V3（`manifest_version: 3`）
- [x] 権限が `activeTab` / `scripting` / `storage` のみ、`host_permissions` なし
- [x] `<all_urls>` / `*://*/*` などの広範なパターンがない
- [x] CSP がリモートコードを許可していない（`script-src 'self'; object-src 'self'`）
- [x] `description` が 132 文字以内
- [x] 128px を含む 4 サイズのアイコンが揃っている（[icons.md](icons.md)）
- [x] 外部通信を行うコードがない（`fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource` / `sendBeacon` / `importScripts`）
- [x] リモートコードの参照がない（外部 URL のスクリプト・`eval` / `new Function`）
- [x] 認証情報がログ・例外メッセージへ出力されない（`console` 出力自体が存在しない）
- [x] 公開用 ZIP を生成でき、直下に `manifest.json` がある
- [x] 公開用 ZIP に `docs/` `test/` `.github/` `tools/` などが混入しない
- [x] 実行に必要なファイルが公開用 ZIP から漏れていない
- [x] Privacy Policy（`PRIVACY.md` / `docs/privacy.html`）が存在し、内容が一致している
- [x] Reviewer Demo（`docs/reviewer-demo.html`）が存在する
- [x] `manifest.json` / README / `release-note.md` のバージョンが一致している

## B. 事前準備（Google アカウント側）

- [ ] **Google アカウントで 2 段階認証を有効にする**
      （Chrome ウェブストアのデベロッパー登録には 2 段階認証が必須）
- [ ] <https://chrome.google.com/webstore/devconsole> へアクセスする
- [ ] **デベロッパー登録**を行う（デベロッパー契約への同意 + 一度限りの登録料 5 USD の支払い）
- [ ] デベロッパーの連絡先メールアドレスを登録し、確認（verify）する
      （Account → Contact email。未確認だと公開できない）
- [ ] 公開者の表示名を設定する（個人名／組織名。ストア上に表示される）
- [ ] 通知設定で、公開・審査完了の通知メールを有効にする（Account ページ）

## C. パッケージの用意

- [ ] `main` が最新であることを確認する
- [ ] `npm test` がすべて通ることを確認する
- [ ] 公開用 ZIP を取得する
      - GitHub Actions の `webstore-package` workflow の artifact（`lgpwmng-webstore-package`）を
        ダウンロードする。タグ（`v0.6.0`）を push した場合も同じ workflow が動く
      - または手元で `npm run package` を実行し、`dist/lgpwmng-webstore-v0.6.0.zip` を使う
- [ ] ZIP を展開し、直下に `manifest.json` があること、`docs/` `test/` が入っていないことを目視で確認する
- [ ] 拡張を `chrome://extensions` の「パッケージ化されていない拡張機能を読み込む」で
      読み込み、Reviewer Demo ページで一通り動作することを確認する
      （手順は [../webstore-review.md](../webstore-review.md)）

## D. GitHub Pages の公開

Privacy Policy URL と Reviewer Demo URL は、審査までに実際にアクセスできる必要があります。

- [ ] GitHub リポジトリの **Settings → Pages** を開く
- [ ] Source を **Deploy from a branch**、Branch を **`main`**、フォルダを **`/docs`** に設定して保存する
- [ ] 数分後、次の URL が表示されることを確認する
      - <https://yantkys.github.io/lgpwmng/>
      - <https://yantkys.github.io/lgpwmng/privacy.html>
      - <https://yantkys.github.io/lgpwmng/reviewer-demo.html>
      - <https://yantkys.github.io/lgpwmng/reviewer-demo-frame.html>
- [ ] Reviewer Demo で拡張が動作することを、公開 URL 上でも確認する

## E. 掲載画像の用意

- [ ] [screenshots.md](screenshots.md) の手順でスクリーンショットを 4 枚撮影する
- [ ] 実在の認証情報・組織名・業務システム名・内部 URL が写っていないことを確認する
- [ ] 1280x800 px（または 640x400 px）ちょうどであることを確認する
- [ ] `docs/webstore/assets/` へ保存する（任意。アップロードは Dashboard から行う）

## F. Developer Dashboard での作業

### F-1. アイテムの作成とアップロード

- [ ] Developer Dashboard → **Add new item**
- [ ] 公開用 ZIP（`lgpwmng-webstore-v0.6.0.zip`）をアップロードする
- [ ] Package タブで、バージョンが `0.6.0` として認識されていることを確認する

### F-2. Store listing タブ

[listing-ja.md](listing-ja.md) の内容を入力します。

- [ ] Language: **日本語**
- [ ] Name: `lgpwmng`
- [ ] Short description（132 文字以内）を貼り付ける
- [ ] Detailed description を貼り付ける
- [ ] Category: **Workflow & Planning**（Productivity）
- [ ] Screenshots を 1〜5 枚アップロードする（最低 1 枚必須）
- [ ] Small promo tile（440x280）をアップロードする（任意）
- [ ] Homepage URL: `https://github.com/YanTKYS/lgpwmng`
- [ ] Support URL: `https://github.com/YanTKYS/lgpwmng/issues`
- [ ] Store icon は ZIP 内の `icons/icon128.png` が使われることを確認する

### F-3. Privacy practices タブ

[privacy-practices.md](privacy-practices.md) の内容を入力します。

- [ ] **Single purpose description** に [single-purpose.md](single-purpose.md) の本文を貼り付ける
- [ ] **Permission justification** に [permissions.md](permissions.md) の各項を貼り付ける
      - [ ] `activeTab`
      - [ ] `scripting`
      - [ ] `storage`
- [ ] **Are you using remote code?** で **`No, I am not using remote code`** を選ぶ
      （根拠: [remote-code.md](remote-code.md)）
- [ ] **Data usage** で次の 3 つにチェックを入れる
      - [ ] Personally identifiable information
      - [ ] Authentication information
      - [ ] Website content
      （Health / Financial / Personal communications / Location / Web history / User activity は
      チェックしない）
- [ ] **Certifications** の 3 つすべてにチェックを入れる
      - [ ] 第三者へのデータ販売・転送を行わない
      - [ ] 単一目的と無関係な用途にデータを使用・転送しない
      - [ ] 信用力の判定・融資目的にデータを使用・転送しない
- [ ] **Privacy policy URL** に `https://yantkys.github.io/lgpwmng/privacy.html` を入力する
      （このフィールドはアカウント設定側にある場合もある。URL が実際に開けることを確認する）

### F-4. Distribution タブ

- [ ] 無料（Free）であることを確認する（in-app purchases なし）
- [ ] 配布国を選択する（日本のみ、または全世界）
- [ ] **Visibility: `Unlisted`** を選ぶ（[初回公開の方針](#初回公開の方針)を参照）

### F-5. 審査へ提出

- [ ] **Submit for Review** を押す
- [ ] 表示されるダイアログの説明欄へ、[reviewer-notes.md](reviewer-notes.md) の文を貼り付ける
      （デモページの URL とダミー認証情報、確認手順）
- [ ] 審査完了後に自動公開するか、手動で公開する（Defer publish）かを選ぶ
      - 初回は **Defer publish（手動公開）** を推奨。審査通過後に自身で確認してから公開できる
      - 審査完了後 30 日以内に公開しないと、下書きへ戻り再提出が必要になる
- [ ] 提出後、ステータスが **Pending review** になったことを確認する

## G. 審査後

- [ ] 審査結果のメールを確認する
- [ ] 公開された場合、Unlisted の URL からインストールして動作を確認する
- [ ] 拒否された場合、理由に対応したうえで、`manifest.json` のバージョンを上げて再提出する
      （同じバージョン番号では再アップロードできない）

## H. 初回公開の方針 {#初回公開の方針}

初回は **`Unlisted`（限定公開）** で審査を受け、配布と動作を確認します。

```text
Unlisted で申請
  ↓ 審査通過
URL を知っている人だけがインストールできる状態で配布・確認
  ↓ 必要に応じて
Public（一般公開）へ変更
```

- `Unlisted` でも `Public` と同じ審査を受けます。審査基準は変わりません。
- 組織内の限られた利用者へ配布する用途であれば、`Unlisted` のまま運用することもできます。
- より限定したい場合は `Private`（指定した Trusted testers / Google グループのみ）も選べます。
- 公開範囲は Dashboard の設定であり、拡張のコードには含めません。
  変更するときは Distribution タブの Visibility を切り替えるだけで、再審査は不要な場合と
  必要な場合があります（Chrome ウェブストアの案内に従ってください）。

## I. 更新時の手順（2 回目以降）

- [ ] `manifest.json` の `version` を上げる（前回より大きい番号にする）
- [ ] README の「現在のバージョン」と `release-note.md` を更新する（`npm test` が整合を検査します）
- [ ] `npm test` を通す
- [ ] 公開用 ZIP を生成し、Dashboard の該当アイテム → **Package** → **Upload new package**
- [ ] 変更に応じて Privacy practices / Store listing を見直す
- [ ] **Submit for Review**

## J. 今回のリリースで実施しないこと

以下は v0.6.0 の範囲外です。導入する場合は、Privacy practices の申告内容を見直す必要があります。

- Chrome Web Store API による自動公開、自動審査申請
- Google OAuth、クラウド同期、Native Messaging
- テレメトリ、Google Analytics、Sentry 等の外部エラー収集、利用状況収集
- 広告
- 新しい広範な permissions
- Chrome 以外のブラウザへの対応
