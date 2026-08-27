# Chrome ウェブストア掲載素材

Developer Dashboard の Store listing へアップロードする画像を置くディレクトリです。
撮影手順と注意点は [../screenshots.md](../screenshots.md) を参照してください。

## 置くファイル

| ファイル | サイズ | 要否 | 内容 |
| --- | --- | --- | --- |
| `screenshot-1-popup.png` | 1280x800 | 必須（最低 1 枚） | popup でサービス／アカウントを選択する画面 |
| `screenshot-2-setup.png` | 1280x800 | 推奨 | ログイン画面設定画面（入力項目の登録） |
| `screenshot-3-options.png` | 1280x800 | 推奨 | options のサービス／アカウント管理 |
| `screenshot-4-share.png` | 1280x800 | 推奨 | アカウント共有（共有用ファイルの作成） |
| `small-promo-440x280.png` | 440x280 | 任意 | Small promo tile |
| `marquee-1400x560.png` | 1400x560 | 任意 | Marquee promo tile |

Store icon は別途用意する必要はありません。拡張パッケージ内の `icons/icon128.png` が
そのまま使われます（[icons.md](../icons.md) を参照）。

## 撮影時の禁止事項

- 実在する認証情報を写さない（ダミー値: `123456` / `test-user` / `test-pass-123`）
- 実在する業務システム名・組織名を写さない
- 実在する自治体内部の URL・ホスト名を写さない
- 撮影には Reviewer Demo だけを使う
  - <https://yantkys.github.io/lgpwmng/reviewer-demo.html>
  - <https://yantkys.github.io/lgpwmng/reviewer-demo-frame.html>

## 補足

これらの画像は Chrome ウェブストアの掲載ページで使うもので、拡張機能の動作には使用しません。
公開用 ZIP（`lgpwmng-webstore-v*.zip`）には `docs/` 以下を含めないため、
このディレクトリの内容がパッケージへ入ることはありません。
