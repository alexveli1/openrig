// Seat restart-in-place for opencode seats.
//
// Relaunches a running, OpenRig-managed opencode seat in its OWN pane on its OWN session, so the
// relaunched opencode re-reads its seat-cwd opencode.json with the same effective posture a normal
// resume launch uses, while the conversation is preserved. For opencode this IS the config-reload
// path: opencode has no runtime config hot-reload of opencode.json (the TUI reads it at process
// boot), so applying a config change without losing the conversation means a same-session relaunch.
//
// This mirrors the Codex restart-in-place cutover (hold the pane, stop the running client, relaunch
// the same conversation, verify) but is deliberately simpler, because opencode has no CODEX_HOME,
// credential store, or rollout/Account-line model:
//   - Resume verification is SCREEN-based (the opencode TUI becomes active again), matching how
//     launchHarness already verifies an opencode resume. opencode is not a NativeRuntime, so there
//     is no native-process exact-resume lineage to check; we never claim one.
//   - The stop step TERM/KILLs the specific running opencode client process (mirroring Codex's
//     stopUnderShell) rather than the pane's shell, so the shell stays and no opencode is orphaned.
//   - direct_native panes (the pane's process IS opencode) use the generic hold → terminate →
//     respawn cutover from pane-cutover.js.
//
// The Codex restart path (seat-restart-in-place.ts) is NOT touched by this file.

import type Database from "better-sqlite3";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { HarnessLaunchResult, NodeBinding } from "./runtime-adapter.js";
import { terminatePaneInPlace, type PaneCutoverTiming, type PaneTerminationResult } from "./pane-cutover.js";
import { isShellForeground } from "./shell-classifier.js";
import type { NativeProcessLister, NativeProcessRow } from "./native-process-lineage.js";

/** The opencode runtime adapter's resume surface this operation reuses. */
export interface OpencodeInPlaceLauncher {
  buildResumeCommand(binding: NodeBinding, opts: { name: string; resumeToken: string }):
    Promise<{ ok: true; command: string; core: string } | { ok: false; error: string }>;
  sendResumeCommand(tmuxSession: string, command: string, resumeToken: string): Promise<HarnessLaunchResult>;
  verifyResumeInPane(tmuxSession: string, resumeToken: string): Promise<HarnessLaunchResult>;
}

/** The seat as the caller resolved it, under its lifecycle lease, with the opencode session id to resume. */
export interface OpencodeRestartTarget {
  seat: { rigId: string; rigName: string; logicalId: string; nodeId: string };
  sessionName: string;
  /** The opencode session id (`sessions.resume_token` where `resume_type = opencode_session_id`). */
  resumeToken: string;
  /** Where the relaunched opencode runs and how it is resumed (the binding the relaunch is built from). */
  binding: NodeBinding;
}

type PaneShape = "shell_backed" | "direct_native";

export type OpencodeRestartRefusalCode =
  | "resume_binding_unverified" | "pane_unverified" | "pane_shape_unknown"
  | "relaunch_unavailable" | "tmux_probe_failed" | "not_stopped";

export interface OpencodeRestartRefusal { ok: false; code: OpencodeRestartRefusalCode; message: string; guidance?: string }

export interface OpencodeRestartReport {
  ok: true;
  outcome: "restarted" | "planned" | "not_started" | "incomplete" | "unknown";
  pane: string;
  paneShape: PaneShape;
  /** The exact relaunch line the operator could run by hand if the automatic resume did not land. */
  recoveryCommand: string;
  message: string;
  paneHeld?: { option: "remain-on-exit"; value: "on"; previous: string | null };
  warnings?: string[];
  /** Required restart reason (carried for audit, mirrors the Codex restart path's `--reason`). */
  reason?: string;
  /** Requesting operator (carried for audit, mirrors the Codex restart path's `--operator`). */
  operator?: string | null;
}

export type OpencodeRestartResult = OpencodeRestartReport | OpencodeRestartRefusal;

export interface OpencodeInPlaceRestartDeps {
  db: Database.Database;
  tmux: TmuxAdapter;
  opencode: OpencodeInPlaceLauncher;
  listProcesses: NativeProcessLister;
  timing?: Partial<PaneCutoverTiming>;
  now?: () => Date;
}

const DEFAULT_TIMING: PaneCutoverTiming = { timeoutMs: 10_000, pollMs: 250, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/** The opencode client's executable name: the wrapper `opencode` or the real `opencode.bin`. */
function isOpencodeExecutable(row: NativeProcessRow): boolean {
  const name = row.executableName ?? row.command.trim().split(/\s+/)[0] ?? "";
  const base = (name.split("/").pop() ?? name).replace(/^-/, "");
  return /^opencode(\.bin)?$/.test(base);
}

/** The deepest opencode process that is a descendant of `panePid` (or `panePid` itself), or null. */
function findOpencodeProcess(rows: NativeProcessRow[], panePid: number): NativeProcessRow | null {
  const childrenByPpid = new Map<number, NativeProcessRow[]>();
  for (const row of rows) {
    const list = childrenByPpid.get(row.ppid);
    if (list) list.push(row); else childrenByPpid.set(row.ppid, [row]);
  }
  let found: NativeProcessRow | null = null;
  const walk = (pid: number): void => {
    const row = rows.find((r) => r.pid === pid);
    if (row && isOpencodeExecutable(row)) found = row; // deeper visits overwrite → keep the deepest
    for (const child of childrenByPpid.get(pid) ?? []) walk(child.pid);
  };
  walk(panePid);
  return found;
}

/** The opencode session id stored for this managed session, or null when it has none. */
export function readOpencodeResumeToken(db: Database.Database, sessionId: string): string | null {
  const row = db.prepare("SELECT resume_token, resume_type FROM sessions WHERE id = ?").get(sessionId) as
    | { resume_token: string | null; resume_type: string | null } | undefined;
  const token = row?.resume_token?.trim();
  return token && row?.resume_type === "opencode_session_id" ? token : null;
}

export class OpencodeInPlaceRestart {
  private readonly timing: PaneCutoverTiming;
  private readonly now: () => Date;

  constructor(private readonly deps: OpencodeInPlaceRestartDeps) {
    this.timing = { ...DEFAULT_TIMING, ...deps.timing };
    this.now = deps.now ?? (() => new Date());
  }

  /** The full same-session relaunch: resolve the running opencode, stop it, relaunch its own session, verify.
   *  With `opts.plan`, stop after the read-only checks (before any signal) and preview the relaunch. */
   async execute(target: OpencodeRestartTarget, opts: { plan?: boolean; reason?: string; operator?: string | null } = {}): Promise<OpencodeRestartResult> {
    const { sessionName, seat } = target;
    const pane = target.binding.tmuxPane;
    const cwd = target.binding.cwd;
    if (!target.resumeToken) {
      return { ok: false, code: "resume_binding_unverified", message: `Seat "${seat.logicalId}" has no stored opencode session id, so there is nothing to resume in place.`,
        guidance: "Record the conversation with: rig seat set-resume-token" };
    }
    if (!pane || !cwd || !target.binding.tmuxSession) {
      return { ok: false, code: "pane_unverified", message: `Seat "${seat.logicalId}" has no bound opencode pane/working directory to restart in place. Nothing was stopped.` };
    }

    // The pane must be exactly the seat's bound pane: never act on an ambiguous session.
    let panes: Awaited<ReturnType<TmuxAdapter["listPanes"]>>;
    try { panes = await this.deps.tmux.listPanes(sessionName); }
    catch (error) { return { ok: false, code: "tmux_probe_failed", message: `tmux pane lookup failed: ${(error as Error).message}; nothing was stopped.` }; }
    if (panes.length !== 1 || panes[0]?.id !== pane) {
      return { ok: false, code: "pane_unverified", message: `Session "${sessionName}" must have exactly the seat's bound pane ${pane}; observed ${panes.map((p) => p.id).join(", ") || "no panes"}. Nothing was stopped.` };
    }

    const rows = await this.deps.listProcesses();
    if (rows.length === 0) {
      return { ok: false, code: "pane_shape_unknown", message: "The process table could not be read, so the running opencode could not be identified. Nothing was stopped." };
    }
    const panePid = await this.deps.tmux.getPanePid(pane);
    if (panePid === null || panePid === undefined) {
      return { ok: false, code: "pane_shape_unknown", message: `The pane ${pane}'s foreground process could not be read. Nothing was stopped.` };
    }
    const client = findOpencodeProcess(rows, panePid);
    if (!client) {
      return { ok: false, code: "pane_shape_unknown", message: `No running opencode process was found in pane ${pane}; refusing to restart an unknown pane. Nothing was stopped.` };
    }
    const root = rows.find((row) => row.pid === panePid);
    let paneShape: PaneShape;
    if (client.pid === panePid) paneShape = "direct_native";
    else if (root && isShellForeground(this.executableBase(root))) paneShape = "shell_backed";
    else return { ok: false, code: "pane_shape_unknown", message: "The pane is neither a shell running opencode nor opencode itself; nothing was stopped." };

    const relaunch = await this.deps.opencode.buildResumeCommand(target.binding, { name: sessionName, resumeToken: target.resumeToken });
    if (!relaunch.ok) {
      return { ok: false, code: "relaunch_unavailable", message: `The resume command could not be built: ${relaunch.error}. Nothing was stopped.` };
    }
    // Audit context (required reason + requesting operator) rides every report,
    // mirroring the Codex restart path so the CLI output records who restarted and why.
    const audit: Pick<OpencodeRestartReport, "reason" | "operator"> = {
      ...(opts.reason ? { reason: opts.reason } : {}),
      ...(opts.operator != null ? { operator: opts.operator } : {}),
    };
    if (opts.plan) {
      return { ok: true, outcome: "planned", pane, paneShape, recoveryCommand: relaunch.core, ...audit,
        message: `Ready to relaunch opencode in place on session ${target.resumeToken} (pane shape: ${paneShape}); nothing was stopped.` };
    }

    return paneShape === "shell_backed"
      ? this.restartShellBacked(target, pane, panePid, client.pid, relaunch.command, relaunch.core, audit)
      : this.restartDirectNative(target, pane, relaunch.command, relaunch.core, cwd, audit);
  }

  /** The pane runs a shell with opencode as its child: TERM/KILL the opencode client only, the shell
   *  returns, then type the resume command into it and verify the TUI comes back. No respawn (no orphan). */
  private async restartShellBacked(
    target: OpencodeRestartTarget, pane: string, panePid: number, clientPid: number,
    command: string, core: string,
    audit: Pick<OpencodeRestartReport, "reason" | "operator"> = {},
  ): Promise<OpencodeRestartResult> {
    const stopped = await this.stopUnderShell(pane, panePid, clientPid);
    if (stopped === "running") {
      return { ok: true, outcome: "not_started", pane, paneShape: "shell_backed", recoveryCommand: core, ...audit,
        message: "The opencode client did not exit after TERM and KILL; nothing was relaunched and the original process is still running." };
    }
    if (stopped === "unknown") {
      return { ok: true, outcome: "unknown", pane, paneShape: "shell_backed", recoveryCommand: core, ...audit,
        message: "Signals were sent, but the pane could not be observed afterwards; no relaunch was attempted." };
    }
    const launch = await this.deps.opencode.sendResumeCommand(target.sessionName, command, target.resumeToken);
    if (!launch.ok) {
      return { ok: true, outcome: "incomplete", pane, paneShape: "shell_backed", recoveryCommand: core, ...audit,
        message: `The opencode client was stopped but the relaunch did not verify: ${launch.error}. Run the recovery command in the pane to resume by hand.` };
    }
    return { ok: true, outcome: "restarted", pane, paneShape: "shell_backed", recoveryCommand: core, ...audit,
      message: "The opencode seat was relaunched in place on its own session; it re-read its seat config." };
  }

  /** The pane's process IS opencode: hold the pane (remain-on-exit), terminate it in place, respawn the
   *  pane with the resume command, verify the TUI, then restore the pane's remain-on-exit setting. */
  private async restartDirectNative(
    target: OpencodeRestartTarget, pane: string, command: string, core: string, cwd: string,
    audit: Pick<OpencodeRestartReport, "reason" | "operator"> = {},
  ): Promise<OpencodeRestartResult> {
    const prior = (await this.deps.tmux.getPaneLocalOption(pane, "remain-on-exit")) ?? null;
    const set = await this.deps.tmux.setRemainOnExit(pane, true);
    const readBack = await this.deps.tmux.getPaneLocalOption(pane, "remain-on-exit");
    if (readBack !== "on") {
      if (readBack !== prior) await this.deps.tmux.restorePaneOption(pane, "remain-on-exit", prior).catch(() => undefined);
      const why = !set.ok ? set.message : readBack === undefined ? "it could not be read back" : `it reads back as ${readBack ?? "unset"}`;
      return { ok: false, code: "not_stopped", message: `Nothing was stopped: the pane could not be held with remain-on-exit (${why}), so the opencode client was not signalled and is still running.` };
    }
    const paneHeld: NonNullable<OpencodeRestartReport["paneHeld"]> = { option: "remain-on-exit", value: "on", previous: prior };

    const terminated: PaneTerminationResult = await terminatePaneInPlace(this.deps.tmux, pane, this.timing, "opencode");
    if (!terminated.ok) {
      await this.restoreRemainOnExit(pane, prior);
      return { ok: true, outcome: "not_started", pane, paneShape: "direct_native", recoveryCommand: core, paneHeld, ...audit,
        message: `The opencode client could not be terminated in place (${terminated.message}); the pane was held and restored, nothing was relaunched.` };
    }
    const respawned = await this.deps.tmux.respawnPane(pane, command, { cwd });
    if (!respawned.ok) {
      await this.restoreRemainOnExit(pane, prior);
      return { ok: true, outcome: "not_started", pane, paneShape: "direct_native", recoveryCommand: core, paneHeld, ...audit,
        message: `The pane was terminated but could not be respawned (${respawned.message}); run the recovery command to resume by hand.` };
    }
    const launch = await this.deps.opencode.verifyResumeInPane(target.sessionName, target.resumeToken);
    if (!launch.ok) {
      await this.restoreRemainOnExit(pane, prior);
      return { ok: true, outcome: "incomplete", pane, paneShape: "direct_native", recoveryCommand: core, paneHeld, ...audit,
        message: `The opencode client was restarted but the resume did not verify: ${launch.error}. Run the recovery command in the pane to resume by hand.` };
    }
    const restored = await this.restoreRemainOnExit(pane, prior);
    return { ok: true, outcome: "restarted", pane, paneShape: "direct_native", recoveryCommand: core, ...audit,
      ...(restored ? {} : { paneHeld, warnings: ["remain-on-exit could not be restored to its previous value."] }),
      message: "The opencode seat was relaunched in place on its own session; it re-read its seat config." };
  }

  private async restoreRemainOnExit(pane: string, prior: string | null): Promise<boolean> {
    const restored = await this.deps.tmux.restorePaneOption(pane, "remain-on-exit", prior).catch(() => null);
    return !!restored?.ok;
  }

  /** TERM then KILL the client pid; return when it is gone and the pane's shell is back in the foreground. */
  private async stopUnderShell(pane: string, panePid: number, pid: number): Promise<"stopped" | "running" | "unknown"> {
    const gone = async (): Promise<boolean | null> => {
      const rows = await this.deps.listProcesses();
      if (rows.length === 0) return null;
      if (rows.some((row) => row.pid === pid && isOpencodeExecutable(row))) return false;
      const command = await this.deps.tmux.getPaneCommand(pane);
      const root = rows.find((row) => row.pid === panePid);
      return command !== null && isShellForeground(command) && !!root;
    };
    const wait = async (): Promise<boolean | null> => {
      const polls = Math.max(1, Math.ceil(this.timing.timeoutMs / this.timing.pollMs));
      let last: boolean | null = null;
      for (let i = 0; i <= polls; i++) {
        last = await gone();
        if (last) return true;
        if (i < polls) await this.timing.sleep(this.timing.pollMs);
      }
      return last;
    };
    await this.deps.tmux.signalPid(pid, "TERM");
    if (await wait()) return "stopped";
    await this.deps.tmux.signalPid(pid, "KILL");
    const last = await wait();
    return last ? "stopped" : last === null ? "unknown" : "running";
  }

  private executableBase(row: NativeProcessRow): string {
    const name = row.executableName ?? row.command.trim().split(/\s+/)[0] ?? "";
    return (name.split("/").pop() ?? name).replace(/^-/, "");
  }
}
