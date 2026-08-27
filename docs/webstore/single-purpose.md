# Single Purpose（単一の目的）

Chrome ウェブストア Developer Dashboard → **Privacy practices** → **Single purpose description** に
入力する内容です。

## 入力する文（日本語）

```text
業務システムのログインフォームに、利用者が端末内へ登録した認証情報を安全に入力するための
ログイン入力補助ツールです。

利用者は、対象のログイン画面を開いた状態で拡張アイコンを操作し、その画面の入力欄
（ユーザーID・パスワード・自治体コード・所属コード・第二パスワード等）を lgpwmng に登録します。
以後、同じ画面でアカウントを選んで実行すると、登録済みの値がそれらの入力欄へ入力されます。
ログインボタンの自動押下は行わず、送信は常に利用者が行います。

認証情報はマスターパスワードから導出した鍵で暗号化し、利用者の端末内にのみ保存します。
外部サーバーへの送信は一切行いません。
```

## 入力する文（英語・必要な場合）

```text
lgpwmng fills login forms of enterprise/government web applications with credentials the user has
registered on their own device.

The user opens a target login page, clicks the extension icon, and registers that page's input
fields (user ID, password, organization code, department code, secondary password, and so on).
Afterwards, selecting an account on the same page fills those fields with the stored values.
The extension never clicks the login button; submitting the form is always the user's action.

Credentials are encrypted with a key derived from the user's master password and stored only in
local device storage. Nothing is transmitted to any external server.
```

## この目的から外れる機能がないことの確認

拡張が持つ機能は、いずれも「登録した認証情報をログインフォームへ入力する」ことを成立させるための
構成要素です。

| 機能 | 単一目的との関係 |
| --- | --- |
| ログイン画面の走査・入力欄の登録（setup） | 入力先を特定するために必要。入力機能そのものの前提 |
| 入力実行（popup →「ログイン情報を入力」） | 単一目的そのもの |
| サービス／アカウント管理（options） | 入力対象の設定を保守するために必要 |
| URL 条件（オリジン + パス）の照合 | 誤ったサイトへ認証情報を入力しないために必要な安全機構 |
| 複数アカウント・管理者アカウント区分 | 1 つのログイン画面で使い分けるアカウントを取り違えないために必要 |
| frame / iframe 対応 | 対象のログイン画面がフレーム構成でも入力できるようにするため |
| マスターパスワード・暗号化・ロック | 保存した認証情報を保護するために必要 |
| 初回のデータ利用開示と同意 | 扱う情報と用途を利用者へ示し、同意を得てから開始するために必要。同意まではページに触れない |
| バックアップ（エクスポート / 復元） | 端末故障・買い替え時に、登録済みの入力設定と認証情報を失わないために必要な補助機能。Vault の保全のみを目的とし、暗号化ファイルを端末内へ出力するだけ |
| アカウント共有（選択アカウントの受け渡し） | 同じ業務システムを複数の担当者が使う運用で、入力設定と認証情報を渡すための補助機能。利用者が選択したアカウントだけを暗号化ファイルとして出力するだけで、自動配布・同期は行わない |

バックアップとアカウント共有は、単一目的とは別の目的を持つ機能ではなく、**登録済みの入力設定・
認証情報を失わない／引き継ぐ**ための補助手段です。いずれも、

- 利用者が明示的に操作したときだけ動作する
- 出力先は利用者の端末内のファイルだけで、ネットワークを使わない
- 出力ファイルは AES-GCM で暗号化される

という点で、単一目的の範囲に収まっています。

## 含めていない機能

単一目的から外れるため、次の機能は実装していません。

- 汎用パスワードマネージャとしての機能（任意サイトの自動保存・自動入力・パスワード生成）
- 自動ログイン（ログインボタンの自動押下）
- クラウド同期、アカウント登録、OAuth 連携
- 閲覧履歴・利用状況の収集、広告、テレメトリ
- ページ内容の書き換え、コンテンツの挿入、検索・新しいタブの変更
