# LINE業務アシスタントBot 設定手順

この手順は、プログラミング初心者がCloudflareの画面から設定する前提です。

## 料金の目安

小規模な夫婦・家族内運用なら、現在の無料枠で開始できます。

- LINE公式アカウント コミュニケーションプラン: 月額0円、無料メッセージ200通/月
- Messaging APIのReply messages: メッセージ通数に算入されない
- Cloudflare Workers Free: 100,000リクエスト/日
- Cloudflare D1 Free: 5,000,000行読み取り/日、100,000行書き込み/日、合計5GB
- Cloudflare Workers AI Free: 10,000 Neurons/日

料金や無料枠は変更される可能性があるため、導入時に公式ページも確認してください。

## 事前に必要なもの

- LINE公式アカウント
- LINE DevelopersのMessaging APIチャネル
- Cloudflareアカウント
- 初回設定用のPCとChrome

パスワード、Channel secret、Channel access tokenをチャットや通常ファイルへ保存しないでください。

## 1. 内部業務専用のLINE公式アカウントを作る

顧客向け公式LINEがすでにあっても、内部業務Botは別アカウントを推奨します。誤配信、会話ログ、Webhook、認証情報を分離できるためです。

1. LINE Official Account Managerで新規アカウントを作る
2. 例としてアカウント名を `業務アシスタントBot` にする
3. コミュニケーションプランになっていることを確認する

## 2. LINE DevelopersでMessaging APIチャネルを作る

1. LINE Developersへログイン
2. プロバイダーを作成
3. 作成した公式アカウントのMessaging APIチャネルを作る
4. Channel secretを確認
5. Messaging API設定から長期Channel access tokenを発行

認証情報は後でCloudflareへ直接貼り付けます。

## 3. Cloudflare Workerを作る

1. Cloudflareへ登録してメール認証
2. `Compute` → `Workers & Pages`
3. Workerを新規作成
4. 例として名前を `gyomu-assistant-bot` にする
5. `src/worker.js` の全内容をChromeのコード編集画面へ貼り付けてDeploy

Codex内ブラウザでは長文のクリップボード貼り付けが失敗したため、Cloudflareのコード編集はChromeを推奨します。

## 4. D1データベースを作る

1. Cloudflareの `Storage & databases` → `D1 SQLite Database`
2. データベースを作る
3. 例として `gyomu-assistant-tasks` と命名
4. Consoleを開く
5. `schema.sql` の内容を貼り付けて実行

## 5. WorkerへD1を接続する

1. Worker `gyomu-assistant-bot` を開く
2. `Bindings` → `Add binding`
3. `D1 database` を選ぶ
4. Variable nameを `DB` にする
5. 作成したD1を選択して保存

## 6. LINEの認証情報を暗号化Secretへ登録する

1. Workerの `Settings`
2. `Variables and secrets` → `Add`
3. Typeを `Secret` にする
4. 次の2つを登録

```text
LINE_CHANNEL_SECRET
LINE_CHANNEL_ACCESS_TOKEN
```

値はLINE Developersから直接貼り付けます。保存後はCloudflare上でも再表示されません。

## 6-2. 対象グループを環境変数へ登録する

このBotは、依頼を拾うグループと通知するグループを分けます。

```text
SOURCE_GROUP_ID
NOTIFY_GROUP_ID
```

- `SOURCE_GROUP_ID`: 妻との業務連絡用グループ。Botは依頼を拾うだけで、基本的に返信しません。
- `NOTIFY_GROUP_ID`: 若菜さん用のやることリストグループ。新規タスク通知、完了操作、定時リマインドを出します。

グループIDはWebhookイベントから取得します。認証情報ではありませんが、公開資料やスクリーンショットには載せないでください。

## 7. Workers AIを接続する

1. Workerの `Bindings`
2. `Add binding`
3. `Workers AI` を選択
4. `Add Binding` を押す
5. Connected Bindingsに `Workers AI / AI` と表示されることを確認

AIは固定ルールで拾えなかった文章だけを判定します。AI障害や無料枠上限時も、固定ルールの受付は継続します。

## 8. 定時通知を設定する

Workerの `Settings` → `Trigger events` → `Cron triggers` で追加します。CloudflareのCronはUTCです。

```text
0 20 * * *
0 2 * * *
0 7 * * *
```

- 20:00 UTC = 翌日の日本時間5:00
- 02:00 UTC = 日本時間11:00
- 07:00 UTC = 日本時間16:00

## 9. LINEへWebhookを登録する

Worker URLが次の場合:

```text
https://gyomu-assistant-bot.example.workers.dev
```

Webhook URLは次です。

```text
https://gyomu-assistant-bot.example.workers.dev/webhook
```

LINE DevelopersのMessaging API設定で:

1. Webhook URLを登録
2. `検証` を押し「成功」を確認
3. `Webhookの利用` を有効化

## 10. LINE側の応答設定を整える

LINE Official Account Managerで:

1. `グループ・複数人トークへの参加を許可する` を選択
2. 標準の「あいさつメッセージ」を停止
3. 標準の「応答メッセージ」を停止

停止しないと、Botの返答とLINE標準の返答が二重に表示される場合があります。

## 11. LINEグループへ追加する

1. Botを友だち追加
2. 既存の業務連絡グループへ招待
3. 若菜さん用のやることリストグループを作り、Botを招待
4. `SOURCE_GROUP_ID` と `NOTIFY_GROUP_ID` を設定
5. 業務連絡グループで普段どおり依頼を送る

```text
揚げ餅2箱発注しておいて。
```

業務連絡グループにはBotは返信しません。やることリストグループに受付カードが表示されたら「消す」「完了」「報告」「コメ報」を試します。

## 12. AI判定を確認する

まず接続確認:

```text
AI確認
```

`✅ AI接続OK` が出たら、固定ルールにない遠回しな表現を試します。

```text
そろそろ芋なくなるよ
```

受付カードが表示されればAI判定も正常です。

## トラブルシューティング

| 症状 | 確認すること |
|---|---|
| `一覧` に反応しない | Webhook、Channel secret、Channel access token、Workerログ |
| 業務連絡グループにBotが返事をする | `SOURCE_GROUP_ID` と `NOTIFY_GROUP_ID` が未設定または誤設定 |
| やることリストグループに通知が来ない | `NOTIFY_GROUP_ID`、Push API、Channel access token |
| 明確な依頼だけ反応する | Workers AI binding `AI`、`AI確認` |
| 返答が二重に出る | LINE標準の応答メッセージとあいさつメッセージ |
| グループへ招待できない | グループトーク参加の許可設定 |
| 定時通知が来ない | CronのUTC時刻、未完了タスクの有無 |
| コードを貼り付けられない | Codex内ブラウザではなくChromeを使用 |
| 誤った会話を登録した | やることリストグループの「誤登録」 |

## 公式情報

- [LINE公式アカウント料金プラン](https://www.lycbiz.com/jp/service/line-official-account/plan/)
- [Messaging API料金](https://developers.line.biz/en/docs/messaging-api/pricing/)
- [LINEグループでのMessaging API](https://developers.line.biz/en/docs/messaging-api/group-chats/)
- [Cloudflare Workers料金](https://developers.cloudflare.com/workers/platform/pricing/)
- [Cloudflare D1料金](https://developers.cloudflare.com/d1/platform/pricing/)
- [Cloudflare Workers AI料金](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [Workers AI Bindings](https://developers.cloudflare.com/workers-ai/configuration/bindings/)
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
