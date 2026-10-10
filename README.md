# 詰め将棋道場（tsume-shogi）

公開URL（予定）: https://kenken6291.github.io/tsume-shogi/

## 構成
```
index.html / style.css        GitHub Pages（すべてリポジトリ直下）
config.js                     設定（GAS_URL・バージョン）
shogi.js                      将棋ルール・詰み探索エンジン
app.js                        画面・操作
gas/Code.gs, appsscript.json  GAS Web API（問題配信・Gemini・取り込み）
gas/shogi.gs                  shogi.js と同じ内容（取り込み時の検証用）
tools/generate.js             正しい詰将棋の自動生成（Node.jsで実行）
```

## セットアップ
1. スプレッドシートを新規作成し、IDを控える
2. GASプロジェクトに gas/ の2ファイルを貼り付け
3. スクリプトプロパティに設定
   - SPREADSHEET_ID（必須）
   - GEMINI_API_KEY（AIヒント・解説を使う場合）
   - GEMINI_MODEL（任意・省略時 gemini-2.5-flash）
   - IMPORT_FOLDER_ID（取り込むDriveフォルダのID。URLのままでも可）
4. エディタで setupSheet → importFromDrive を実行
5. デプロイ → 新しいデプロイ → ウェブアプリ（実行：自分 / アクセス：全員）
6. 発行URLを config.js の GAS_URL に貼ってプッシュ

※ Code.gs を変更したら「デプロイを管理 → 編集 → 新バージョン」で更新しないと反映されません。
※ シートを直接編集したら clearCache を実行（キャッシュは最大6時間）。

## 問題データ（シート problems）
| id | moves | sfen | solution | difficulty | title | comment |
|----|-------|------|----------|------------|-------|---------|
| 1 | 1 | 4k4/9/4P4/9/9/9/9/9/9 b G2r2b3g4s4n4l17p 1 | G*5b | 1 | 頭金 | |

- solution は USI形式・空白区切り。空欄ならブラウザ側で探索して補完（9手程度まで）
- 正解手順と違う手でも、残り手数以内に詰む手は「別解」として正解扱い
- 王手でない手は即座に指摘、詰まない手は逃れる応手まで盤上で再生

## 問題を増やす
```
node tools/generate.js 5 100 3600
```
できた .txt を取り込みフォルダに入れて importFromDrive を実行。不正な問題は import_errors シートに記録され、取り込まれません。
