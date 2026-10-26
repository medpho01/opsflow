import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isQuestionToUs } from "../replies";

describe("a lab asking us, rather than answering (27 Oct 2026)", () => {
  it("a question quoting our message", () => {
    assert.ok(isQuestionToUs("Could you please clarify the exact issue? is there anything pending from our end", true, null));
    assert.ok(isQuestionToUs("@919999999999 kindly confirm the same BLR6361177", false, "919999999999"));
    assert.ok(isQuestionToUs("@Labstack Operations BLR6361177", false, null) === false, "a bare tag with no question is not a question");
  });
  it("a question not addressed to us is the lab's own conversation", () => {
    assert.equal(isQuestionToUs("Could you please share the address?", false, "919999999999"), false);
  });
  it("an answer is not a question, even when it quotes us", () => {
    assert.equal(isQuestionToUs("The sample has been collected.", true, null), false);
    assert.equal(isQuestionToUs("Rescheduled for tomorrow 8 am", true, null), false);
  });
});
