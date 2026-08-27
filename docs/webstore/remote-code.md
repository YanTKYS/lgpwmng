# Remote Code 申告

Chrome ウェブストア Developer Dashboard → **Privacy practices** → **Are you using remote code?**

## 回答

```text
No, I am not using remote code
```

## 根拠

Chrome ウェブストアが「リモートコード」と呼ぶのは、拡張パッケージに含まれず、実行時に外部から
取得・解釈されるコードです。lgpwmng には次のいずれも存在しません。

| 種類 | 状況 | 確認方法 |
| --- | --- | --- |
| 外部 JavaScript ファイルの読み込み | なし。すべての `<script src>` は拡張パッケージ内の相対パス | `src/**/*.html` の `src=` を検査 |
| CDN の利用 | なし。スクリプト・スタイル・フォント・画像はすべてパッケージ内 | 外部 URL 参照がないことを検査 |
| `eval()` / `new Function()` / 文字列の `setTimeout` | なし | ソース全体を検査 |
| 外部サーバーから取得した実行コード | なし。通信 API の呼び出しがない | `fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource` / `sendBeacon` / `importScripts` の不在を検査 |
| リモートホストの WebAssembly | なし | 同上 |
| `<iframe>` による外部ページの埋め込み | なし | 拡張の HTML に `iframe` を含まない |

### CSP

`manifest.json` は既定より緩めない CSP を明示しています。

```json
"content_security_policy": {
  "extension_pages": "script-src 'self'; object-src 'self'"
}
```

`'unsafe-eval'`、`'unsafe-inline'`、`wasm-unsafe-eval`、外部ホストの許可は含みません。
Manifest V3 では、そもそもリモートホストのコードを読み込んで実行することはできません。

### `chrome.scripting.executeScript` について

lgpwmng はページ内の入力欄を走査・入力するために `chrome.scripting.executeScript` を使用します。
これはリモートコードには当たりません。

- 注入するのは、拡張パッケージ内の関数（`src/background/page-agent.js` の `pageAgent`）だけです。
- `func` 形式で関数を渡しており、文字列のコードを組み立てて実行することはありません。
- 注入は、利用者が拡張アイコンから操作したときにだけ行われます。

## 自動検査

上記の不在は `npm test`（`test/package.test.js`）で機械的に検査しており、拡張のソースへ
外部通信やリモートコードが混入した場合はテストが失敗します。
