import test from "node:test";
import assert from "node:assert/strict";
import { looksLikeNaturalTask, parseCommand, parseTaskMessage } from "../src/worker.js";

test("依頼メッセージから内容・期限・補足を取得する", () => {
  assert.deepEqual(
    parseTaskMessage("【依頼】米を発注する\n期限: 6/25 12:00\n補足: 今週販売分"),
    {
      kind: "request",
      title: "米を発注する",
      dueText: "6/25 12:00",
      note: "今週販売分",
    }
  );
});

test("自然な依頼文を期限なしで登録する", () => {
  assert.deepEqual(parseTaskMessage("揚げ餅2箱発注しておいて。"), {
    kind: "request",
    title: "揚げ餅2箱発注しておいて。",
    dueText: null,
    note: null,
  });

  assert.deepEqual(parseTaskMessage("さつまいも頼んどいて"), {
    kind: "request",
    title: "さつまいも頼んどいて",
    dueText: null,
    note: null,
  });
});

test("依頼の後に数量が改行されても登録する", () => {
  assert.deepEqual(
    parseTaskMessage("来週揚げ餅ほしい\nコショウ15\n玄米30"),
    {
      kind: "request",
      title: "来週揚げ餅ほしい",
      dueText: null,
      note: "コショウ15\n玄米30",
    }
  );
});

test("通常の会話はタスク登録しない", () => {
  assert.equal(parseTaskMessage("今日は揚げ餅がよく売れたね"), null);
  assert.equal(looksLikeNaturalTask("発注しておいたよ"), false);
  assert.equal(looksLikeNaturalTask("頼んだ？"), false);
  assert.equal(looksLikeNaturalTask("何箱頼んだの？"), false);
});

test("完了コマンドを取得する", () => {
  assert.deepEqual(parseCommand("完了 12"), { type: "done", id: 12 });
});

test("保留コマンドは使わない", () => {
  assert.equal(parseCommand("保留 3 農家さんの返事待ち"), null);
  assert.equal(parseCommand("再開 3"), null);
});
