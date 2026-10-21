// Opencode seat restart-in-place: the same-session relaunch that re-reads the seat's opencode.json.
// Hermetic unit tests over the OpencodeInPlaceRestart class — a fake tmux, process table, and launcher
// prove every safety refusal fires BEFORE any signal, and that the two pane shapes stop and relaunch
// correctly. No live opencode, no real db query is made by the class (the resume token is supplied).

import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import type { NativeProcessRow } from "../src/domain/native-process-lineage.js";
import type { HarnessLaunchResult } from "../src/domain/runtime-adapter.js";
import {
  OpencodeInPlaceRestart, readOpencodeResumeToken,
  type OpencodeInPlaceLauncher, type OpencodeRestartTarget,
} from "../src/domain/seat-restart-in-place-opencode.js";

const SESSION = "devopencode-a@some-rig";
const PANE = "%7";
const RESUME = "ses_f3bb408d9ffeA9wfnyVhkcmv6C";
const RESUME_CMD = `cd '/work' && opencode --session '${RESUME}'`;

function target(overrides?: Partial<OpencodeRestartTarget>): OpencodeRestartTarget {
  return {
    seat: { rigId: "r", rigName: "some-rig", logicalId: "devopencode-a", nodeId: "n1" },
    sessionName: SESSION,
    resumeToken: RESUME,
    binding: { nodeId: "n1", tmuxSession: SESSION, tmuxPane: PANE, cwd: "/work" } as OpencodeRestartTarget["binding"],
    ...overrides,
  };
}

interface WorldOptions {
  shape?: "shell_backed" | "direct_native";
  paneCount?: number;
  noOpencodeProcess?: boolean;
  clientIgnoresSignals?: boolean;
  buildFails?: string;
  launchFails?: string;
  respawnFails?: string;
  throwAt?: "listPanes" | "signalPaneProcess" | "respawnPane";
}

function makeLauncher(opts: { buildFails?: string; launchFails?: string } = {}) {
  return {
    buildResumeCommand: vi.fn(async () => opts.buildFails
      ? { ok: false as const, error: opts.buildFails }
      : { ok: true as const, command: RESUME_CMD, core: RESUME_CMD }),
    sendResumeCommand: vi.fn(async (): Promise<HarnessLaunchResult> => opts.launchFails
      ? { ok: false, error: opts.launchFails }
      : { ok: true }),
    verifyResumeInPane: vi.fn(async (): Promise<HarnessLaunchResult> => opts.launchFails
      ? { ok: false, error: opts.launchFails }
      : { ok: true }),
  };
}

function buildWorld(opts: WorldOptions = {}) {
  const shellPid = 100;
  const clientPid = opts.shape === "direct_native" ? shellPid : 101;
  let alive = true;
  const typed: string[] = [];
  const respawned: Array<{ command: string; cwd?: string }> = [];
  const signals: Array<{ pid: number; signal: string }> = [];
  let remainOnExit: string | null = null;
  const restored: Array<string | null> = [];

  const rows = (): NativeProcessRow[] => {
    const list: NativeProcessRow[] = [];
    if (opts.shape === "direct_native") {
      list.push({ pid: clientPid, ppid: 1, pgid: clientPid, tpgid: clientPid, executableName: "opencode", command: `opencode --session ${RESUME}`, startedAt: "x" });
    } else {
      list.push({ pid: shellPid, ppid: 1, pgid: shellPid, tpgid: shellPid, executableName: "bash", command: "-bash", startedAt: "x" });
      if (!opts.noOpencodeProcess && alive) {
        list.push({ pid: clientPid, ppid: shellPid, pgid: clientPid, tpgid: clientPid, executableName: "opencode", command: `opencode --session ${RESUME}`, startedAt: "x" });
      }
    }
    return list;
  };

  const listPanes = opts.throwAt === "listPanes"
    ? vi.fn(async () => { throw new Error("tmux exploded"); })
    : vi.fn(async () => Array.from({ length: opts.paneCount ?? 1 }, (_, i) => ({ id: i === 0 ? PANE : `%${90 + i}` })));

  const ok: TmuxResult = { ok: true } as TmuxResult;
  const tmux = {
    listPanes,
    getPanePid: vi.fn(async () => shellPid),
    getPaneCommand: vi.fn(async () => (alive || opts.shape === "direct_native" ? "opencode" : "bash")),
    capturePaneContent: vi.fn(async () => ""),
    signalPid: vi.fn(async (pid: number, signal: "TERM" | "KILL") => {
      signals.push({ pid, signal });
      if (!opts.clientIgnoresSignals && opts.shape !== "direct_native") alive = false;
      return ok;
    }),
    signalPaneProcess: vi.fn(async () => {
      if (opts.throwAt === "signalPaneProcess") throw new Error("signal failed");
      alive = false;
      return ok;
    }),
    isPaneDead: vi.fn(async () => true),
    setRemainOnExit: vi.fn(async () => { remainOnExit = "on"; return ok; }),
    getPaneLocalOption: vi.fn(async () => remainOnExit),
    restorePaneOption: vi.fn(async (_pane: string, _opt: string, value: string | null) => { restored.push(value); remainOnExit = value; return ok; }),
    respawnPane: vi.fn(async (_pane: string, command: string, o?: { cwd?: string }) => {
      if (opts.throwAt === "respawnPane") throw new Error("respawn exploded");
      if (opts.respawnFails) return { ok: false, message: opts.respawnFails } as unknown as TmuxResult;
      respawned.push({ command, cwd: o?.cwd });
      alive = true;
      return ok;
    }),
    sendShellCommand: vi.fn(async (_t: string, command: string) => { typed.push(command); return ok; }),
  } as unknown as TmuxAdapter;

  const launcher = makeLauncher({ buildFails: opts.buildFails, launchFails: opts.launchFails });
  const restart = new OpencodeInPlaceRestart({
    db: new Database(":memory:"),
    tmux,
    opencode: launcher as unknown as OpencodeInPlaceLauncher,
    listProcesses: async () => rows(),
    timing: { timeoutMs: 60, pollMs: 1, sleep: async () => {} },
  });
  return { restart, launcher, signals, typed, respawned, restored };
}

describe("OpencodeInPlaceRestart — safety refusals (nothing signalled)", () => {
  it("refuses with no stored opencode session id", async () => {
    const { restart, signals } = buildWorld();
    const res = await restart.execute(target({ resumeToken: "" }));
    expect(!res.ok && (res as { code: string }).code).toBe("resume_binding_unverified");
    expect(signals).toEqual([]);
  });

  it("refuses when the tmux session has more than the bound pane", async () => {
    const { restart, signals } = buildWorld({ paneCount: 2 });
    const res = await restart.execute(target());
    expect(!res.ok && (res as { code: string }).code).toBe("pane_unverified");
    expect(signals).toEqual([]);
  });

  it("refuses when no opencode process is in the pane", async () => {
    const { restart, signals } = buildWorld({ noOpencodeProcess: true });
    const res = await restart.execute(target());
    expect(!res.ok && (res as { code: string }).code).toBe("pane_shape_unknown");
    expect(signals).toEqual([]);
  });

  it("refuses when the resume command cannot be built, before signalling", async () => {
    const { restart, signals } = buildWorld({ buildFails: "invalid token" });
    const res = await restart.execute(target());
    expect(!res.ok && (res as { code: string }).code).toBe("relaunch_unavailable");
    expect(signals).toEqual([]);
  });

  it("plan mode stops before any signal and previews the command", async () => {
    const { restart, signals, launcher } = buildWorld();
    const res = await restart.execute(target(), { plan: true });
    expect(res.ok && "outcome" in res ? res.outcome : "refused").toBe("planned");
    expect(signals).toEqual([]);
    expect(launcher.sendResumeCommand.mock.calls).toEqual([]);
  });
});

describe("OpencodeInPlaceRestart — shell_backed relaunch", () => {
  it("stops the opencode client (not the shell), relaunches its session, and restarts", async () => {
    const { restart, signals, launcher, respawned } = buildWorld();
    const res = await restart.execute(target());
    expect(res.ok && "outcome" in res ? res.outcome : "refused").toBe("restarted");
    // only the client pid (101) is signalled, never the shell (100); no respawn in the shell path
    expect(signals.map((s) => s.pid)).toEqual([101]);
    expect(launcher.sendResumeCommand.mock.calls).toEqual([[SESSION, RESUME_CMD, RESUME]]);
    expect(respawned).toEqual([]);
  });

  it("reports not_started when the client ignores signals and never relaunches", async () => {
    const { restart, launcher } = buildWorld({ clientIgnoresSignals: true });
    const res = await restart.execute(target());
    expect(res.ok && "outcome" in res ? res.outcome : "refused").toBe("not_started");
    expect(launcher.sendResumeCommand.mock.calls).toEqual([]);
  });

  it("reports incomplete when the client stops but the resume does not verify", async () => {
    const { restart } = buildWorld({ launchFails: "opencode resume: no saved session" });
    const res = await restart.execute(target());
    expect(res.ok && "outcome" in res ? res.outcome : "refused").toBe("incomplete");
  });
});

describe("OpencodeInPlaceRestart — direct_native relaunch", () => {
  it("holds, terminates, respawns with the resume command, verifies, and restores the hold", async () => {
    const { restart, respawned, restored, signals } = buildWorld({ shape: "direct_native" });
    const res = await restart.execute(target());
    expect(res.ok && "outcome" in res ? res.outcome : "refused").toBe("restarted");
    // signals go to the pane, not a specific pid (signalPaneProcess); the pane is respawned with the resume command
    expect(signals).toEqual([]);
    expect(respawned).toEqual([{ command: RESUME_CMD, cwd: "/work" }]);
    // remain-on-exit was restored to its prior value (null)
    expect(restored).toEqual([null]);
  });

  it("reports not_started and restores the hold when respawn fails", async () => {
    const { restart, restored } = buildWorld({ shape: "direct_native", respawnFails: "no pty" });
    const res = await restart.execute(target());
    expect(res.ok && "outcome" in res ? res.outcome : "refused").toBe("not_started");
    expect(restored).toEqual([null]);
  });
});

describe("readOpencodeResumeToken", () => {
  it("returns the token only when resume_type is opencode_session_id", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, resume_token TEXT, resume_type TEXT)");
    db.prepare("INSERT INTO sessions VALUES (?,?,?)").run("s1", RESUME, "opencode_session_id");
    db.prepare("INSERT INTO sessions VALUES (?,?,?)").run("s2", "019a-uuid", "codex_id");
    db.prepare("INSERT INTO sessions VALUES (?,?,?)").run("s3", null, "opencode_session_id");
    expect(readOpencodeResumeToken(db, "s1")).toBe(RESUME);
    expect(readOpencodeResumeToken(db, "s2")).toBeNull();
    expect(readOpencodeResumeToken(db, "s3")).toBeNull();
    expect(readOpencodeResumeToken(db, "missing")).toBeNull();
    db.close();
  });
});
