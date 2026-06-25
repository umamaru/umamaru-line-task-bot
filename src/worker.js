const LINE_REPLY_URL = "https://api.line.me/v2/bot/message/reply";
const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "umamaru-line-task-bot" });
    }

    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("Not found", { status: 404 });
    }

    const body = await request.text();
    const signature = request.headers.get("x-line-signature") || "";
    const valid = await verifyLineSignature(body, signature, env.LINE_CHANNEL_SECRET);

    if (!valid) {
      return new Response("Invalid signature", { status: 401 });
    }

    const payload = JSON.parse(body);

    for (const event of payload.events || []) {
      await handleEvent(event, env);
    }

    return new Response("OK");
  },

  async scheduled(_controller, env) {
    const configuredSourceGroupId = env.SOURCE_GROUP_ID?.trim();
    const configuredNotifyGroupId = env.NOTIFY_GROUP_ID?.trim();

    if (configuredSourceGroupId && configuredNotifyGroupId) {
      const tasks = await getOpenTasks(env.DB, configuredSourceGroupId);
      if (tasks.length) {
        await pushMessages(env, configuredNotifyGroupId, [buildTaskListFlex(tasks)]);
      }
      return;
    }

    const groups = await env.DB.prepare(
      "SELECT group_id FROM groups WHERE enabled = 1 ORDER BY created_at"
    ).all();

    for (const group of groups.results || []) {
      const tasks = await getOpenTasks(env.DB, group.group_id);
      if (tasks.length) {
        await pushMessages(env, group.group_id, [buildTaskListFlex(tasks)]);
      }
    }
  },
};

async function handleEvent(event, env) {
  const groupId = event.source?.groupId;

  if (!groupId) {
    if (event.replyToken) {
      await replyText(
        env,
        event.replyToken,
        "このBotは、うままる業務連絡のLINEグループ内で使ってください。"
      );
    }
    return;
  }

  const route = getRoute(env, groupId);
  if (!route.isAllowed) return;

  await registerGroup(env.DB, groupId);

  if (event.type === "join") {
    if (route.isNotifyGroup) {
      await replyText(
        env,
        event.replyToken,
        "やることリスト用の通知グループです。\n\n業務連絡グループで拾った依頼をここへ通知します。\n未完了一覧、完了、誤登録、必要な時だけ完了報告ができます。"
      );
    }
    return;
  }

  if (event.type === "postback") {
    if (!route.isNotifyGroup) return;
    const response = await executePostback(
      env,
      env.DB,
      route.taskGroupId,
      groupId,
      event.source?.userId || null,
      event.postback.data
    );
    await replyMessages(env, event.replyToken, response);
    return;
  }

  if (event.type !== "message" || event.message?.type !== "text") {
    return;
  }

  const text = event.message.text.trim();

  if (route.isNotifyGroup) {
    const pendingResponse = await consumePendingAction(
      env,
      env.DB,
      groupId,
      route.taskGroupId,
      event.source?.userId || null,
      text
    );

    if (pendingResponse) {
      await replyText(env, event.replyToken, pendingResponse);
      return;
    }
  }

  if (text === "AI確認") {
    if (!route.isNotifyGroup) return;
    const result = await checkAIConnection(env.AI);
    await replyText(env, event.replyToken, result);
    return;
  }

  const command = parseCommand(text);

  if (command) {
    if (!route.isNotifyGroup) return;
    if (command.type === "list") {
      const tasks = await getOpenTasks(env.DB, route.taskGroupId);
      const messages = tasks.length
        ? [buildTaskListFlex(tasks)]
        : [{ type: "text", text: "✅ 未完了の業務依頼はありません。" }];
      await replyMessages(env, event.replyToken, messages);
      return;
    }

    const response = await executeCommand(env.DB, route.taskGroupId, command);
    await replyText(env, event.replyToken, response);
    return;
  }

  if (!route.isSourceGroup) return;

  let task = parseTaskMessage(text);

  if (!task && env.AI) {
    task = await classifyTaskWithAI(env.AI, text);
  }

  if (!task) {
    return;
  }

  const existing = await env.DB.prepare(
    "SELECT id FROM tasks WHERE message_id = ?"
  )
    .bind(event.message.id)
    .first();

  if (existing) return;

  const result = await env.DB.prepare(
    `INSERT INTO tasks
      (group_id, message_id, source_user_id, kind, title, due_text, note, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', datetime('now'), datetime('now'))
     RETURNING id`
  )
    .bind(
      route.taskGroupId,
      event.message.id,
      event.source.userId || null,
      task.kind,
      task.title,
      task.dueText,
      task.note
    )
    .first();

  const receipt = buildCompactTaskReceipt(result.id, displayTaskText(task));
  if (route.notifyGroupId && route.notifyGroupId !== groupId) {
    await pushMessages(env, route.notifyGroupId, [receipt]);
    return;
  }

  await replyMessages(env, event.replyToken, [receipt]);
}

function getRoute(env, groupId) {
  const sourceGroupId = env.SOURCE_GROUP_ID?.trim() || null;
  const notifyGroupId = env.NOTIFY_GROUP_ID?.trim() || sourceGroupId;

  if (!sourceGroupId && !notifyGroupId) {
    return {
      isAllowed: true,
      isSourceGroup: true,
      isNotifyGroup: true,
      taskGroupId: groupId,
      notifyGroupId: groupId,
    };
  }

  return {
    isAllowed: groupId === sourceGroupId || groupId === notifyGroupId,
    isSourceGroup: groupId === sourceGroupId,
    isNotifyGroup: groupId === notifyGroupId,
    taskGroupId: sourceGroupId,
    notifyGroupId,
  };
}

async function registerGroup(db, groupId) {
  await db
    .prepare(
      `INSERT INTO groups (group_id, enabled, created_at)
       VALUES (?, 1, datetime('now'))
       ON CONFLICT(group_id) DO NOTHING`
    )
    .bind(groupId)
    .run();
}

export function parseTaskMessage(text) {
  const cleaned = text.trim();
  const match = cleaned.match(/^【(依頼|確認)】\s*([\s\S]*)$/u);
  const kind = match?.[1] === "確認" ? "check" : "request";
  const body = match ? match[2] : cleaned;

  if (!match && !looksLikeNaturalTask(body)) return null;

  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let title = "";
  let dueText = null;
  let note = null;
  const extra = [];

  for (const line of lines) {
    const due = line.match(/^期限\s*[:：]\s*(.+)$/);
    if (due) {
      dueText = due[1].trim();
      continue;
    }

    const supplemental = line.match(/^補足\s*[:：]\s*(.+)$/);
    if (supplemental) {
      note = supplemental[1].trim();
      continue;
    }

    if (!title) title = line;
    else extra.push(line);
  }

  if (!title) return null;
  if (extra.length) note = [note, ...extra].filter(Boolean).join("\n");

  return { kind, title, dueText, note };
}

export function looksLikeNaturalTask(text) {
  if (!text.trim() || text.length > 1000) return false;

  const lines = text
    .split(/\r?\n/u)
    .map((line) =>
      line
        .replace(/[\s　]+/gu, " ")
        .replace(/[。．.!！?？〜～ー]+$/gu, "")
        .trim()
    )
    .filter(Boolean);

  return lines.some((line) => {
    // 返事だけの「お願いします」「これでよろしく」は、内容がないので登録しない。
    if (/^(?:お願いします|よろしく|よろしくお願いします|これでよろしく)$/u.test(line)) {
      return false;
    }

    // 奥さまの履歴で多い、自然な発注・依頼表現。
    if (
      /(?:頼んどいて|頼んでおいて|頼んで|頼むよ|頼んでおきましょ(?:う)?|頼んでください)(?:ね|よ)?$/u.test(
        line
      )
    ) {
      return true;
    }

    // 「聞いといて」「置いといて」「揚げといて」などの短縮形。
    if (/(?:ておいて|といて|どいて)(?:ね|よ)?$/u.test(line)) {
      return true;
    }

    // 妻の履歴に実際に多かった一言依頼。
    if (
      /(?:発注して|注文して|印刷して(?:きて)?|許可(?:を)?(?:取って|とって|取りして|どりして)|返信して|連絡して|聞いて|持ってきて|持っていって|買って(?:きて)?|取って(?:きて)?|とって(?:きて)?|送って|確認して|電話して|入力して|登録して|用意して|直して|作って|調べて|振り込んで|支払って|迎えにきて|もらってきて|入れて|増やして|届けて)(?:ね|よ|ください|下さい|ほしい|欲しい)?$/u.test(
        line
      )
    ) {
      return true;
    }

    if (/(?:してほしい|して欲しい|してくれる|してもらえる)(?:ね|よ)?$/u.test(line)) {
      return true;
    }

    if (/(?:お願い(?:します)?|よろしく(?:お願いします)?|忘れずに)$/u.test(line)) {
      return true;
    }

    // 「来週揚げ餅ほしい」「50cmの袋が欲しい」など。
    if (/(?:ほしい|欲しい)(?:かも)?$/u.test(line)) {
      return true;
    }

    // 「これ印刷」「許可取り」のような名詞だけの短い指示。
    return /(?:印刷|許可取り|許可どり)$/u.test(line);
  });
}

async function classifyTaskWithAI(ai, text) {
  if (!ai || !text.trim() || text.length > 1000) return null;

  const messages = [
    {
      role: "system",
      content: `小規模事業を営む夫婦のLINE業務連絡を分類してください。
夫が後で何らかの行動をする必要がある文章はTASK、それ以外はCHATです。
直接命令していなくても、在庫不足、補充の必要、遠回しな依頼、提案形、くだけた言い方はTASKです。
特に「なくなる」「足りない」「残り少ない」「あった方がよくない？」は、仕入れや補充が必要なのでTASKです。

TASKの例:
さつまいも頼んどいて
来週揚げ餅ほしい
そろそろ芋なくなるよ
次の販売分、ミニトマトあった方がよくない？
在庫あと2個だよ
許可まだだからお願い

CHATの例:
さつまいも頼んだよ
さつまいも頼んだ？
今日は揚げ餅がよく売れたね
ありがとう

説明は付けず、TASKまたはCHATの一語だけを返してください。`,
    },
    { role: "user", content: text },
  ];

  try {
    const result = await ai.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages,
      temperature: 0,
      max_tokens: 8,
    });

    const raw =
      typeof result === "string"
        ? result
        : typeof result?.response === "string"
          ? result.response
          : "";
    const decision = raw.trim().toUpperCase().match(/^(TASK|CHAT)\b/u)?.[1];
    if (decision !== "TASK") return null;

    const lines = text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) return null;

    return {
      kind: "request",
      title: lines[0],
      dueText: null,
      note: lines.length > 1 ? lines.slice(1).join("\n") : null,
    };
  } catch (error) {
    console.error("Workers AI classification failed", error);
    return null;
  }
}

async function checkAIConnection(ai) {
  if (!ai) return "❌ AI接続なし: Workers AI bindingを確認してください。";

  try {
    const result = await ai.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: [
        {
          role: "system",
          content: "返答は必ず OK の2文字だけにしてください。",
        },
        { role: "user", content: "接続確認" },
      ],
      temperature: 0,
      max_tokens: 8,
    });

    const raw =
      typeof result === "string"
        ? result
        : typeof result?.response === "string"
          ? result.response
          : "";

    return raw.trim().toUpperCase().startsWith("OK")
      ? "✅ AI接続OK"
      : `⚠️ AI応答を確認できません: ${raw.slice(0, 100) || "応答なし"}`;
  } catch (error) {
    return `❌ AI接続エラー: ${String(error?.message || error).slice(0, 180)}`;
  }
}

export function parseCommand(text) {
  if (/^(一覧|未完了)$/u.test(text)) return { type: "list" };

  let match = text.match(/^完了\s+(\d+)$/u);
  if (match) return { type: "done", id: Number(match[1]) };

  return null;
}

async function executeCommand(db, groupId, command) {
  const task = await db
    .prepare("SELECT id, title, note, status FROM tasks WHERE id = ? AND group_id = ?")
    .bind(command.id, groupId)
    .first();

  if (!task) return `${formatTaskId(command.id)} は見つかりませんでした。`;

  if (command.type === "done") {
    await db
      .prepare(
        `UPDATE tasks
         SET status = 'done', completed_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ? AND group_id = ?`
      )
      .bind(command.id, groupId)
      .run();
    return `完了 ${formatTaskId(command.id)}\n${displayTaskText(task)}`;
  }

  return "操作を確認できませんでした。";
}

async function executePostback(env, db, groupId, notifyGroupId, userId, data) {
  const params = new URLSearchParams(data);
  const action = params.get("action");
  const id = Number(params.get("id"));

  if (!Number.isInteger(id) || id <= 0) {
    return [{ type: "text", text: "タスクを確認できませんでした。もう一度一覧を開いてください。" }];
  }

  const task = await db
    .prepare("SELECT id, title, note, status FROM tasks WHERE id = ? AND group_id = ?")
    .bind(id, groupId)
    .first();

  if (!task) {
    return [{ type: "text", text: "このタスクは見つかりませんでした。" }];
  }

  if (action === "done") {
    await db
      .prepare(
        `UPDATE tasks
         SET status = 'done', completed_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ? AND group_id = ?`
      )
      .bind(id, groupId)
      .run();
    return [{ type: "text", text: `✅ 完了にしました\n${displayTaskText(task)}` }];
  }

  if (action === "report_done") {
    await db
      .prepare(
        `UPDATE tasks
         SET status = 'done', completed_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ? AND group_id = ?`
      )
      .bind(id, groupId)
      .run();

    const sourceGroupId = env.SOURCE_GROUP_ID?.trim();
    if (sourceGroupId) {
      await pushMessages(env, sourceGroupId, [buildCompletionReport(displayTaskText(task))]);
      return [{ type: "text", text: `✅ 完了にして、業務連絡グループへ報告しました\n${displayTaskText(task)}` }];
    }

    return [{ type: "text", text: `✅ 完了にしました\n${displayTaskText(task)}` }];
  }

  if (action === "report_comment") {
    if (!userId) {
      return [{ type: "text", text: "コメント入力を開始できませんでした。もう一度お試しください。" }];
    }

    await db
      .prepare(
        `INSERT INTO pending_actions (group_id, user_id, task_group_id, task_id, action_type, created_at)
         VALUES (?, ?, ?, ?, 'report_comment', datetime('now'))
         ON CONFLICT(group_id, user_id) DO UPDATE SET
           task_group_id = excluded.task_group_id,
           task_id = excluded.task_id,
           action_type = excluded.action_type,
           created_at = excluded.created_at`
      )
      .bind(notifyGroupId, userId, groupId, id)
      .run();

    return [
      {
        type: "text",
        text: `📝 報告コメントを入力してください\n\n対象:\n${displayTaskText(task)}\n\n例: 明日納品で依頼済み\nやめる場合は「キャンセル」と送ってください。`,
      },
    ];
  }

  if (action === "cancel") {
    await db
      .prepare("DELETE FROM tasks WHERE id = ? AND group_id = ?")
      .bind(id, groupId)
      .run();
    return [{ type: "text", text: `🗑️ 誤登録として取り消しました\n${displayTaskText(task)}` }];
  }

  return [{ type: "text", text: "操作を確認できませんでした。" }];
}

async function consumePendingAction(env, db, notifyGroupId, taskGroupId, userId, text) {
  if (!userId) return null;

  const pending = await db
    .prepare(
      `SELECT task_group_id, task_id, action_type
       FROM pending_actions
       WHERE group_id = ? AND user_id = ?
         AND created_at >= datetime('now', '-30 minutes')`
    )
    .bind(notifyGroupId, userId)
    .first();

  if (!pending) {
    await db
      .prepare(
        `DELETE FROM pending_actions
         WHERE group_id = ? AND user_id = ?
           AND created_at < datetime('now', '-30 minutes')`
      )
      .bind(notifyGroupId, userId)
      .run();
    return null;
  }

  await db
    .prepare("DELETE FROM pending_actions WHERE group_id = ? AND user_id = ?")
    .bind(notifyGroupId, userId)
    .run();

  if (text === "キャンセル") {
    return "報告コメント付き完了をキャンセルしました。タスクは未完了のままです。";
  }

  if (pending.action_type !== "report_comment") {
    return "入力待ちの操作を確認できませんでした。";
  }

  const sourceGroupId = env.SOURCE_GROUP_ID?.trim();
  if (!sourceGroupId) {
    return "業務連絡グループが設定されていないため、報告できませんでした。";
  }

  const task = await db
    .prepare("SELECT id, title, note FROM tasks WHERE id = ? AND group_id = ?")
    .bind(pending.task_id, pending.task_group_id || taskGroupId)
    .first();

  if (!task) return "コメント先のタスクが見つかりませんでした。";

  const comment = text.slice(0, 500);
  await db
    .prepare(
      `UPDATE tasks
       SET status = 'done', completed_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ? AND group_id = ?`
    )
    .bind(pending.task_id, pending.task_group_id || taskGroupId)
    .run();

  await pushMessages(env, sourceGroupId, [
    buildCompletionReport(displayTaskText(task), comment),
  ]);

  return `✅ コメント付きで完了報告しました\n${displayTaskText(task)}\n\nコメント:\n${comment}`;
}

async function getOpenTasks(db, groupId) {
  const result = await db
    .prepare(
      `SELECT id, title, due_text, status, hold_reason
       FROM tasks
       WHERE group_id = ? AND status IN ('open', 'hold')
       ORDER BY CASE WHEN due_text IS NULL THEN 1 ELSE 0 END, id`
    )
    .bind(groupId)
    .all();
  return result.results || [];
}

function buildCompactTaskReceipt(id, taskText) {
  return {
    type: "text",
    text: `📌 新しい依頼を拾いました\n\n${taskText}`,
    quickReply: {
      items: [
        quickPostback("誤登録", "cancel", id),
        quickPostback("完了", "done", id),
        quickPostback("報告完了", "report_done", id),
        quickPostback("コメント報告", "report_comment", id),
      ],
    },
  };
}

function quickPostback(label, action, id) {
  return {
    type: "action",
    action: {
      type: "postback",
      label,
      data: `action=${action}&id=${id}`,
    },
  };
}

function buildTaskFlex(task, headerText = null) {
  return {
    type: "flex",
    altText: `業務依頼: ${displayTaskText(task)}`,
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#EAF6EE",
        contents: [
          {
            type: "text",
            text: headerText || "□ 未完了",
            weight: "bold",
            color: "#176B3A",
          },
        ],
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: displayTaskText(task), weight: "bold", size: "lg", wrap: true },
        ],
      },
      footer: {
        type: "box",
        layout: "horizontal",
        spacing: "sm",
        contents: [
          actionButton("誤登録", "cancel", task.id, "secondary"),
          actionButton("完了", "done", task.id, "primary"),
          actionButton("報告完了", "report_done", task.id, "primary"),
          actionButton("コメント報告", "report_comment", task.id, "secondary"),
        ],
      },
    },
  };
}

function buildTaskListFlex(tasks) {
  const visible = tasks.slice(0, 10);

  return {
    type: "flex",
    altText: `うままる業務・未完了一覧 ${tasks.length}件`,
    contents: {
      type: "carousel",
      contents: visible.map(
        (task) => buildTaskFlex(task, "□ 未完了").contents
      ),
    },
  };
}

function buildCompletionReport(taskText, comment = null) {
  return {
    type: "text",
    text: `✅ 完了しました\n\n${taskText}${comment ? `\n\nコメント:\n${comment}` : ""}`,
  };
}

function displayTaskText(task) {
  return [task.title, task.note].filter(Boolean).join("\n");
}

function actionButton(label, action, id, style, height = "sm") {
  return {
    type: "button",
    style,
    height,
    action: {
      type: "postback",
      label,
      data: `action=${action}&id=${id}`,
    },
  };
}

async function replyText(env, replyToken, text) {
  if (!replyToken) return;
  await replyMessages(env, replyToken, [{ type: "text", text: limitText(text) }]);
}

async function replyMessages(env, replyToken, messages) {
  if (!replyToken) return;
  await callLineApi(env, LINE_REPLY_URL, {
    replyToken,
    messages,
  });
}

async function pushMessages(env, to, messages) {
  await callLineApi(env, LINE_PUSH_URL, { to, messages });
}

async function callLineApi(env, url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`LINE API error ${response.status}: ${detail}`);
  }
}

async function verifyLineSignature(body, signature, secret) {
  if (!signature || !secret) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return toBase64(digest) === signature;
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function formatTaskId(id) {
  return String(id);
}

function limitText(text) {
  return text.length <= 4900 ? text : `${text.slice(0, 4870)}\n…省略しました`;
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
