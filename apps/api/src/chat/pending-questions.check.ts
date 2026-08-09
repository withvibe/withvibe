/**
 * End-to-end check of the blocking-question path against the real SDK, using
 * the same pieces the chat service wires together: `canUseTool` parks on
 * `PendingQuestionsService`, the question reaches the output stream through
 * `SideChannel`, and an out-of-band answer (what the browser POSTs) unblocks
 * the turn.
 *
 * Needs Anthropic credentials in the environment.
 * Run: pnpm --filter @withvibe/api exec ts-node src/chat/pending-questions.check.ts
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { PendingQuestionsService } from "./pending-questions.service";
import { SideChannel, merge } from "./side-channel";

const noopLogger = {
  warn: (m: string) => console.log(`    [warn] ${m}`),
  info: () => {},
  error: (m: string) => console.log(`    [error] ${m}`),
} as unknown as ConstructorParameters<typeof PendingQuestionsService>[0];

async function main() {
  const pending = new PendingQuestionsService(noopLogger);
  const side = new SideChannel<Record<string, unknown>>();
  const USER = "user-under-test";

  let questionSeenAt = 0;
  let answeredAt = 0;
  let toolResultText = "";

  const q = query({
    prompt:
      "Use the AskUserQuestion tool to ask which database to use: Postgres " +
      "or MySQL. Then state which one I picked.",
    options: {
      systemPrompt: { type: "preset", preset: "claude_code" },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      canUseTool: async (toolName, input, { toolUseID, signal }) => {
        if (toolName !== "AskUserQuestion") return { behavior: "allow" };
        const questions = (input as { questions: { question: string }[] }).questions;
        side.push({ type: "ask_user_question", toolUseId: toolUseID, questions });
        const outcome = await pending.register({
          toolUseId: toolUseID,
          sessionId: null,
          envId: "env-under-test",
          askedOfUserId: USER,
          questions: questions as never,
          signal,
        });
        if (!outcome.answered) return { behavior: "deny", message: outcome.reason };
        return {
          behavior: "allow",
          updatedInput: { ...input, answers: outcome.answers },
        };
      },
    },
  });

  for await (const item of merge(q, side)) {
    if (item.kind === "side") {
      const ev = item.value as {
        type: string;
        toolUseId: string;
        questions: { question: string; options: { label: string }[] }[];
      };
      if (ev.type !== "ask_user_question") continue;
      questionSeenAt = Date.now();
      console.log(`  → question surfaced: "${ev.questions[0]?.question}"`);

      // Stand in for the browser POSTing an answer a moment later.
      setTimeout(() => {
        const answers: Record<string, string> = {};
        for (const question of ev.questions) {
          answers[question.question] = question.options[1]!.label;
        }
        const wrongUser = pending.answer({
          toolUseId: ev.toolUseId,
          userId: "someone-else",
          answers,
        });
        console.log(
          `  → rejected answer from another user: ${wrongUser.ok === false}`
        );
        const res = pending.answer({ toolUseId: ev.toolUseId, userId: USER, answers });
        answeredAt = Date.now();
        console.log(`  → answered with ${JSON.stringify(answers)} ok=${res.ok}`);
      }, 300);
      continue;
    }

    const msg = item.value;
    if (msg.type === "user" || msg.type === "assistant") {
      const content = msg.message?.content;
      if (!Array.isArray(content)) continue;
      for (const raw of content) {
        const block = raw as {
          type?: string;
          content?: unknown;
          text?: string;
        };
        if (block.type === "tool_result" && typeof block.content === "string") {
          toolResultText = block.content;
        } else if (block.type === "text" && block.text?.trim()) {
          console.log(`  → model: ${block.text.trim().slice(0, 120)}`);
        }
      }
    }
  }

  const ok =
    questionSeenAt > 0 &&
    answeredAt > questionSeenAt &&
    /MySQL/i.test(toolResultText);
  console.log(
    ok
      ? "\nPASS — question streamed out before the answer, and the answer reached the model."
      : `\nFAIL — seen=${questionSeenAt} answered=${answeredAt} result=${JSON.stringify(toolResultText).slice(0, 200)}`
  );
  process.exit(ok ? 0 : 1);
}

void main();
