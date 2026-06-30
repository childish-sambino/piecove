// piecove · Pi voice notifications
//
// Claude Code speaks on lifecycle events via settings.json hooks that shell out
// to claude-notify.sh (a distinct macOS voice per event — Flo when a run finishes,
// Whisper on compaction, …). Pi has no settings.json hooks, but its lifecycle
// events can do the same job: this extension maps Pi events to the SAME script,
// so both agents speak from one source of truth.
//
// The script lives at ~/.claude/hooks/claude-notify.sh (staged + symlinked by the
// entrypoint). Inside the container `say`/`afplay` are stubbed to forward the
// utterance to your Mac via ./host-bridge --watch, so it plays on real speakers.
//
// Event mapping (Pi → claude-notify.sh):
//   agent_end       → stop      "right, that's done!"  (your turn again)
//   session_compact → compact   "memories… fading"
// Pi has no plan mode or elicitation event, so plan-start/plan-stop/question
// have no Pi trigger. The "permission" cue fires from pi-allowlist.ts, which is
// the only place that knows a gate prompt is about to appear.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const SCRIPT = `${process.env.HOME}/.claude/hooks/claude-notify.sh`;

// Fire-and-forget: never block Pi's loop, never throw out of a handler. The
// script backgrounds the actual playback itself, so this returns immediately.
export function speak(event: string): void {
  if (!existsSync(SCRIPT)) return;
  try {
    spawnSync("bash", [SCRIPT, event], { stdio: "ignore", timeout: 5000 });
  } catch {
    /* a missing voice or audio bridge must never break the agent */
  }
}

export default function (pi: any) {
  pi.on("agent_end", async () => {
    speak("stop");
  });
  pi.on("session_compact", async () => {
    speak("compact");
  });
}
