// OpenCode runtime adapter (direct-CLI, no runner-in-a-pane shim).
//
// Unlike Pi (which needs the pane-hosted pi-runner to front `pi --mode rpc`),
// opencode exposes session resume/attach primitives directly on its CLI
// (form, verified against the opencode 2.x CLI: per-seat agent profiles carry
// the model + the `permission: {"*":"allow"}` that removes `--auto`; the
// profile is resolved from the seat cwd's `opencode.json` `default_agent`
// — NOT a CLI flag; `--prompt` and resume are opt-in):
//   - `cd '<cwd>' && opencode` ............ fresh TUI seat (no positional
//     project, no `--model`, no `--auto`)
//   - `opencode --session <id>` ............ exact session continuation
//     (never bare `--continue`, which resumes the LAST session — the
//     picker-equivalent, forbidden in managed paths, mirroring Pi's
//     never-resume rule)
//   - `opencode --session <id> --fork` ..... whole-session fork with
//     parent linkage (same spelling as `opencode run --fork` / attach --fork)
//   - `opencode serve` ......................... headless server (NOT used
//     here — the managed seat is the TUI in the pane, same as every other
//     adapter)
// so the adapter types `opencode` commands straight into the seat's tmux pane
// and reads back only opencode-authored surfaces — never TUI heuristics.
//
// Session identity: sessions live in the opencode.db sqlite store (`session`
// table: id `ses_*`, directory, time_created/time_updated ms). Fresh-launch
// capture reads that store cwd-scoped (a read, same posture as the
// claude-code status-line sidecar); resume/fork tokens are the `ses_*`
// session ids (`opencode_session_id`, id-shaped like codex/muse tokens).
//
// Trust posture: every managed launch carries an EXPLICIT posture segment
// from opencodePostureFlag (yolo-mode.ts) — YOLO / a per-seat resolved
// full_bypass selects ` --auto` (auto-approve permissions that are not
// explicitly denied — opencode marks it dangerous); otherwise the harness
// default floor applies (no flag, interactive approvals). The same decision
// runs on fresh / resume / fork so posture is uniform, never path-dependent.

import nodePath from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import type { TmuxAdapter } from "./tmux.js";
import { opencodePostureFlag } from "./yolo-mode.js";
import type {
  RuntimeAdapter, NodeBinding, ResolvedStartupFile,
  InstalledResource, ProjectionResult, StartupDeliveryResult, ReadinessResult,
  HarnessLaunchResult, ForkSource,
} from "../domain/runtime-adapter.js";
import { resolveConcreteHint } from "../domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../domain/projection-planner.js";
import { validateResumeToken } from "../domain/resume-token-validation.js";
import { mergeManagedBlock } from "../domain/managed-blocks.js";
import { observeOpencodeApproval } from "../domain/permission-drift.js";
import { shellQuote } from "./shell-quote.js";

const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);

export interface OpencodeAdapterFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
  listFiles?(dirPath: string): string[];
}

export interface OpencodeRuntimeAdapterDeps {
  tmux: TmuxAdapter;
  fsOps: OpencodeAdapterFsOps;
  sleep?: (ms: number) => Promise<void>;
  /** Absolute path to the opencode.db sqlite store. Defaults to the
   *  XDG-resolved data dir (<XDG_DATA_HOME or ~/.local/share>/opencode/opencode.db,
   *  matching `opencode db path`). Tests inject. */
  opencodeDbPath?: string;
  /** Home dir for the default db-path resolution. Defaults to os.homedir(). */
  homedir?: string;
  /** Session-id reader override (cwd-scoped newest; tests inject; the default
   *  queries the opencode.db `session` table read-only and returns null on
   *  ANY failure — capture is best-effort, never a launch failure). */
  readLatestSessionId?: (cwd: string | null, minTimeCreatedMs?: number | null) => Promise<string | null>;
  /** Fork-candidate lister override (all ids created at/after a timestamp;
   *  tests inject; the default queries opencode.db read-only, [] on ANY
   *  failure). */
  listSessionIdsSince?: (cwd: string | null, minTimeCreatedMs: number) => Promise<string[]>;
}

// ── Pure command builders (single source of truth; hermetically tested) ──

export interface OpencodeLaunchOpts {
  cwd: string;
  /** Already-resolved posture segment (leading space) or "". Retained for
   *  launch-observation drift; the `opencode` form no longer emits
   *  posture flags (per-seat agent profiles carry model +
   *  `permission: {"*":"allow"}`, which removes `--auto`). */
  model?: string;
  postureArg: string;
  /** The startup brief, threaded by the startup-orchestrator for a FRESH
   *  opencode launch (DEC-1, 2026-10-08): rides the command as `--prompt` so
   *  opencode creates the session with the brief as the FIRST user message —
   *  no interactive tmux delivery of the brief (paste-synthesis unreliable).
   *  Fresh only; the resume/fork paths never take a prompt. */
  prompt?: string;
}

/** Fresh seat command: `cd '<cwd>' && opencode [--prompt <brief>]`
 *  (form, verified against the opencode 2.x CLI: no positional project, no --model,
 *  no --auto, no --agent — the per-seat agent profile is resolved from the
 *  seat cwd's `opencode.json` `default_agent`, not a CLI flag). */
export function buildOpencodeFreshCommand(
  opts: OpencodeLaunchOpts,
): string {
  const parts = ["cd", shellQuote(opts.cwd), "&&", openCommand()];
  if (opts.prompt?.trim()) {
    // The prompt rides the `opencode` invocation as --prompt.  It is typed
    // into the seat's tmux pane via paste-buffer + send-keys; embedded LF bytes
    // make the paste land across shell input boundaries, which races the Enter
    // key and leaves bash with an unclosed single-quoted string
    // ("unexpected end of file while looking for '" -> TUI never starts).
    // Collapse newlines to spaces so the command is a single line bash executes
    // atomically; the agent receives the full text, only line structure is
    // flattened.
    const prompt = opts.prompt.trim().replace(/\r?\n/g, " ");
    parts.push("--prompt", shellQuote(prompt));
  }
  return parts.join(" ");
}

/** Resume command: `cd '<cwd>' && opencode --session '<id>'`. Exact-id
 *  resume — never bare `--continue` (last-session picker). No --agent: the
 *  profile resolves from the seat cwd's `opencode.json`. */
export function buildOpencodeResumeCommand(
  opts: OpencodeLaunchOpts & { sessionId: string },
): string {
  const parts = [
    "cd",
    shellQuote(opts.cwd),
    "&&",
    openCommand(),
    "--session",
    shellQuote(opts.sessionId),
  ];
  return parts.join(" ");
}

/** Fork command: `cd '<cwd>' && opencode --session '<parent>' --fork`
 *  so opencode derives a child session; the NEW child id (never the parent's)
 *  is the resume token. */
export function buildOpencodeForkCommand(
  opts: OpencodeLaunchOpts & { parentId: string },
): string {
  const parts = [
    "cd",
    shellQuote(opts.cwd),
    "&&",
    openCommand(),
    "--session",
    shellQuote(opts.parentId),
    "--fork",
  ];
  return parts.join(" ");
}

/** Default opencode.db location: <XDG_DATA_HOME or ~/.local/share>/opencode/opencode.db. */
export function defaultOpencodeDbPath(homedir?: string): string {
  const dataHome = process.env.XDG_DATA_HOME?.trim()
    || nodePath.join(homedir ?? os.homedir(), ".local", "share");
  return nodePath.join(dataHome, "opencode", "opencode.db");
}

/** `opencode` binary for a seat (-form CLI). `opencode.bin` is the runtime's
 *  launcher shim some deployments install next to the TUI launcher; accepted by
 *  readiness/resume probes. Typed launches use the plain `opencode` name so the
 *  managed surface stays the TUI the profile expects. */
function opencodeBinary(): string {
  return process.env.OPENRIG_OPENCODE_BINARY?.trim() || "opencode";
}

function openCommand(): string {
  return `${opencodeBinary()}`;
}

/** Session tables present in the store (v2-first). opencode >= 2.0 writes NEW
 *  sessions to `session_v2`; the v1 `session` table remains as a legacy read
 *  store. Unioning both keeps capture working across the v1→v2 transition
 *  (a seat's newest session may be v2 while older rows stay v1). `ses_*`
 *  ids are unique across tables, so the union is duplicate-free. */
function opencodeSessionTables(db: Database.Database): string[] {
  const names = new Set(
    db
      .prepare<string[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('session','session_v2')"
      )
      .all()
      .map((r) => r.name),
  );
  const tables: string[] = [];
  if (names.has("session_v2")) tables.push("session_v2");
  if (names.has("session")) tables.push("session");
  return tables;
}

function opencodeSessionUnion(tables: string[]): string {
  return tables.map((t) => `SELECT id, directory, time_created, time_updated FROM ${t}`).join(
    " UNION ALL ",
  );
}

/** Best-effort newest session id for a directory (or global latest when cwd
 *  is null) from the opencode.db session store (`session_v2` ∪ `session`).
 *  `minTimeCreatedMs` restricts to rows created at/after a launch timestamp:
 *  OpenCode may delay the session-row insert until the first prompt, so an
 *  unfiltered read right after launch can return a stale row (previous
 *  generation or pod-mate). Returns null on ANY failure (missing db, locked
 *  db, unknown schema) or when no row qualifies — capture must never fail or
 *  block its lifecycle op. */
export function queryLatestOpencodeSessionId(
  dbPath: string,
  cwd: string | null,
  minTimeCreatedMs?: number | null,
): string | null {
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const tables = opencodeSessionTables(db);
      if (tables.length === 0) return null;
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (cwd) {
        clauses.push("directory = ?");
        params.push(cwd);
      }
      if (typeof minTimeCreatedMs === "number") {
        clauses.push("time_created >= ?");
        params.push(minTimeCreatedMs);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const row = db.prepare(
        `SELECT id FROM (${opencodeSessionUnion(tables)}) ${where} ORDER BY time_updated DESC LIMIT 1`,
      ).get(...params) as { id: string } | undefined;
      const id = row?.id?.trim() ?? "";
      return id.length > 0 ? id : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** All session ids for a directory created at/after a timestamp, newest
 *  first (v2 ∪ v1). The fork waiter uses the full list (not LIMIT 1) so
 *  ambiguity — two qualifying rows, e.g. a pod-mate's session created inside
 *  the fork window — resolves to null (loud unresolved) instead of silently
 *  accepting the wrong conversation. */
export function queryOpencodeSessionIdsSince(
  dbPath: string,
  cwd: string | null,
  minTimeCreatedMs: number,
): string[] {
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const tables = opencodeSessionTables(db);
      if (tables.length === 0) return [];
      const clauses: string[] = ["time_created >= ?"];
      const params: unknown[] = [minTimeCreatedMs];
      if (cwd) {
        clauses.push("directory = ?");
        params.push(cwd);
      }
      const rows = db.prepare(
        `SELECT id FROM (${opencodeSessionUnion(tables)}) WHERE ${clauses.join(" AND ")} ORDER BY time_updated DESC`,
      ).all(...params) as Array<{ id: string }>;
      return rows.map((r) => r.id?.trim() ?? "").filter((id) => id.length > 0);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

export class OpencodeRuntimeAdapter implements RuntimeAdapter {
  readonly runtime = "opencode";
  private tmux: TmuxAdapter;
  private fs: OpencodeAdapterFsOps;
  private sleep: (ms: number) => Promise<void>;
  private opencodeDbPath: string;
  private readLatestSessionId: (cwd: string | null, minTimeCreatedMs?: number | null) => Promise<string | null>;
  private listSessionIdsSince: (cwd: string | null, minTimeCreatedMs: number) => Promise<string[]>;

  constructor(deps: OpencodeRuntimeAdapterDeps) {
    this.tmux = deps.tmux;
    this.fs = deps.fsOps;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.opencodeDbPath = deps.opencodeDbPath ?? defaultOpencodeDbPath(deps.homedir);
    const dbPath = this.opencodeDbPath;
    this.readLatestSessionId = deps.readLatestSessionId
      ?? (async (cwd, minTimeCreatedMs) => queryLatestOpencodeSessionId(dbPath, cwd, minTimeCreatedMs));
    this.listSessionIdsSince = deps.listSessionIdsSince
      ?? (async (cwd, minTimeCreatedMs) => queryOpencodeSessionIdsSince(dbPath, cwd, minTimeCreatedMs));
  }

  /** Session-id reader shape resume-token-capture consumes
   *  (deriveResumeToken's opencodeSessionStore dep). Seat-agnostic global
   *  latest — same posture as the Muse adapter's reader; the launch path
   *  and the metadata refresher prefer the cwd-scoped read below where the
   *  cwd is known. */
  async readSessionId(_sessionName: string): Promise<{ ok: true; sessionId: string } | { ok: false; reason: string }> {
    const id = await this.readLatestSessionId(null);
    if (!id) return { ok: false, reason: "missing_sidecar" };
    return { ok: true, sessionId: id };
  }

  /** Cwd-scoped session-id read (opencode.db `session` rows key on
   *  directory) — seat-precise for multi-seat rigs sharing a HOME store.
   *  Consumed by the resume-metadata refresher, which knows each seat's
   *  cwd, and the launch/fork paths, which pass their start timestamp so
   *  only rows created at/after launch qualify. */
  async readSessionIdForCwd(cwd: string | null, minTimeCreatedMs?: number | null): Promise<{ ok: true; sessionId: string } | { ok: false; reason: string }> {
    const id = await this.readLatestSessionId(cwd, minTimeCreatedMs ?? null);
    if (!id) return { ok: false, reason: "missing_sidecar" };
    return { ok: true, sessionId: id };
  }

  async listInstalled(_binding: NodeBinding): Promise<InstalledResource[]> {
    // No seat-scoped opencode projection target at MVP (guidance merges into
    // the shared <cwd>/AGENTS.md, which opencode reads natively; plugin
    // install is operator-side `opencode plugin`) — honest empty inventory,
    // never a fabricated list.
    return [];
  }

  async project(plan: ProjectionPlan, binding: NodeBinding): Promise<ProjectionResult> {
    const projected: string[] = [];
    const skipped: string[] = [];
    const failed: Array<{ effectiveId: string; error: string }> = [];

    for (const entry of plan.entries) {
      if (entry.classification === "no_op") {
        skipped.push(entry.effectiveId);
        continue;
      }
      try {
        if (this.projectEntry(entry, binding)) {
          projected.push(entry.effectiveId);
        } else {
          skipped.push(entry.effectiveId);
        }
      } catch (err) {
        failed.push({ effectiveId: entry.effectiveId, error: (err as Error).message });
      }
    }

    return { projected, skipped, failed };
  }

  async deliverStartup(files: ResolvedStartupFile[], binding: NodeBinding): Promise<StartupDeliveryResult> {
    let delivered = 0;
    const failed: Array<{ path: string; error: string }> = [];

    for (const file of files) {
      try {
        const content = this.fs.readFile(file.absolutePath);
        const hint = file.deliveryHint === "auto" ? resolveConcreteHint(file.path, content) : file.deliveryHint;

        switch (hint) {
          case "guidance_merge": {
            const targetPath = nodePath.join(binding.cwd, "AGENTS.md");
            const merged = this.mergeGuidance(targetPath, file.path, content);
            if (!merged) continue; // rig-role skip: do not count as delivered
            break;
          }
          case "skill_install": {
            // No verified opencode skills target at MVP (unlike Muse's
            // .muse/skills) — an honest skip, never a misdelivery.
            console.log(
              `[openrig] skip: skill_install has no verified opencode target at MVP (path=${file.path})`,
            );
            continue;
          }
          case "send_text": {
            if (binding.tmuxSession) {
              const textResult = await this.tmux.sendText(binding.tmuxSession, content);
              if (!textResult.ok) throw new Error(textResult.message);
              await this.sleep(200);
              const submitResult = await this.tmux.sendKeys(binding.tmuxSession, ["C-m"]);
              if (!submitResult.ok) throw new Error(submitResult.message);
            }
            break;
          }
        }
        delivered++;
      } catch (err) {
        if (file.required) {
          failed.push({ path: file.path, error: (err as Error).message });
        }
      }
    }

    return { delivered, failed };
  }

  async launchHarness(
    binding: NodeBinding,
    opts: {
      name: string;
      resumeToken?: string;
      forkSource?: ForkSource;
      /** DEC-1 (2026-10-08): the startup brief threaded by the
       *  startup-orchestrator for a FRESH opencode launch; rides the command
       *  as `--prompt`. Fresh only. */
      initialPrompt?: string;
    },
  ): Promise<HarnessLaunchResult> {
    if (!binding.tmuxSession) {
      return { ok: false, error: "No tmux session bound — cannot launch the OpenCode harness" };
    }
    if (opts.resumeToken && opts.forkSource) {
      return { ok: false, error: "resumeToken and forkSource are mutually exclusive — pick one" };
    }

    const postureArg = opencodePostureFlag(process.env, binding.launchPosture);
    const appliedLaunch = observeOpencodeApproval(postureArg);
    const sessionName = binding.tmuxSession;

    // Adopt-already-running guard (relaunch/reconcile safety). The opencode
    // runtime records no activity/launch telemetry of its own, so every daemon
    // restart re-runs the launch path for seats that are ALREADY running:
    // without this guard we would type a fresh launch command into a live TUI
    // (the paste quirk stages it into the agent's input) and then time out in
    // verifyLaunch, persisting a stale `attention_required` on healthy seats.
    // If the pane is already a live, authenticated opencode TUI, adopt it:
    // record the observation, capture a best-effort resume token, and tell
    // the orchestrator to skip all pane-input delivery. Never types.
    if (!opts.forkSource) {
      const ready = await this.checkReady(binding);
      if (ready.ready) {
        // Ambiguity guard: pod-mates share one HOME opencode.db, so a
        // cwd-scoped id is seat-precise only when exactly one session exists
        // for the cwd. Otherwise adopt with a null token (honest) — restore
        // falls back to fresh, same as before the adoption.
        let token: string | null = null;
        const ids = await this.listSessionIdsSince(binding.cwd ?? null, 0).catch(() => [] as string[]);
        if (ids.length === 1) {
          const validation = validateResumeToken("opencode", ids[0]);
          if (validation.ok) token = validation.token;
        }
        return {
          ok: true,
          adopted: true,
          appliedLaunch,
          ...(token ? { resumeToken: token, resumeType: "opencode_session_id" as const } : {}),
        };
      }
    }

    if (opts.forkSource) {
      if (opts.forkSource.kind !== "native_id") {
        return {
          ok: false,
          error: `opencode fork: ref.kind="${opts.forkSource.kind}" is not supported in v1; use ref.kind="native_id" with the parent opencode session id`,
        };
      }
      const parentId = opts.forkSource.value?.trim();
      if (!parentId) {
        return { ok: false, error: "opencode fork: forkSource.value is required (parent opencode session id)" };
      }
      // Validity floor before we type anything into the pane (same as resume).
      const parentValidation = validateResumeToken("opencode", parentId);
      if (!parentValidation.ok) {
        return { ok: false, error: `opencode fork: ${parentValidation.error}` };
      }
      const cmd = buildOpencodeForkCommand({
        parentId: parentValidation.token, cwd: binding.cwd, model: binding.model, postureArg,
      });
      // Fork timestamp BEFORE typing: the waiter below only accepts rows
      // created at/after this instant, so a pod-mate's newer pre-existing
      // row can never be mistaken for the fork child.
      const forkStartedAt = Date.now();
      const textResult = await this.tmux.sendText(sessionName, cmd);
      if (!textResult.ok) {
        return { ok: false, error: `Failed to send launch command: ${textResult.message}` };
      }
      const enterResult = await this.tmux.sendKeys(sessionName, ["Enter"]);
      if (!enterResult.ok) {
        return { ok: false, error: `Failed to send Enter: ${enterResult.message}` };
      }
      const childId = await this.waitForNewSessionId(binding.cwd, parentValidation.token, forkStartedAt);
      if (!childId) {
        return { ok: false, error: "opencode fork: could not capture the new post-fork session id", recovery: "attention_required" };
      }
      return { ok: true, resumeToken: childId, resumeType: "opencode_session_id", appliedLaunch };
    }

    if (opts.resumeToken) {
      // Validity floor before we type anything into the pane.
      const validation = validateResumeToken("opencode", opts.resumeToken);
      if (!validation.ok) {
        return { ok: false, error: `opencode resume: ${validation.error}` };
      }
      const cmd = buildOpencodeResumeCommand({
        sessionId: validation.token, cwd: binding.cwd, model: binding.model, postureArg,
      });
      const textResult = await this.tmux.sendText(sessionName, cmd);
      if (!textResult.ok) {
        return { ok: false, error: `Failed to send launch command: ${textResult.message}` };
      }
      const enterResult = await this.tmux.sendKeys(sessionName, ["Enter"]);
      if (!enterResult.ok) {
        return { ok: false, error: `Failed to send Enter: ${enterResult.message}` };
      }
      const verification = await this.verifyLaunch(sessionName, true);
      if (!verification.ok) return verification;
      return { ok: true, resumeToken: validation.token, resumeType: "opencode_session_id", appliedLaunch };
    }

    // DEC-1 (2026-10-08): the optional `initialPrompt` (the startup brief,
    // threaded by the startup-orchestrator for a FRESH opencode launch) rides
    // on the command as `--prompt`, so opencode creates the session with the
    // brief as the FIRST user message — no interactive tmux delivery of the
    // brief (paste-synthesis unreliable). Absent = the pre-patch command.
    const cmd = buildOpencodeFreshCommand({
      cwd: binding.cwd,
      model: binding.model,
      postureArg,
      prompt: opts.initialPrompt,
    });
    // Launch timestamp BEFORE typing: the capture below only accepts rows
    // created at/after this instant, so a delayed row insert (first prompt)
    // can never resolve to a stale previous-generation or pod-mate session.
    const launchStartedAt = Date.now();
    const textResult = await this.tmux.sendText(sessionName, cmd);
    if (!textResult.ok) {
      return { ok: false, error: `Failed to send launch command: ${textResult.message}` };
    }
    const enterResult = await this.tmux.sendKeys(sessionName, ["Enter"]);
    if (!enterResult.ok) {
      return { ok: false, error: `Failed to send Enter: ${enterResult.message}` };
    }
    const verification = await this.verifyLaunch(sessionName, false);
    if (!verification.ok) return verification;
    // Fresh-launch capture, cwd-scoped (the opencode.db session row keys on
    // directory, so this is seat-precise even for pod-mates sharing a HOME
    // store). A missed read leaves the token null (honest fresh fallback at
    // restore), never fabricated.
    // With `--prompt` the row insert is not instantaneous (opencode writes it
    // as it processes the prompt), so a bounded poll captures the token
    // reliably; without `--prompt` the pre-patch single read is kept.
    const freshId = opts.initialPrompt?.trim()
      ? await this.waitForFreshSessionId(binding.cwd ?? null, launchStartedAt)
      : await this.readLatestSessionId(binding.cwd ?? null, launchStartedAt).catch(() => null);
    return {
      ok: true,
      appliedLaunch,
      ...(freshId ? { resumeToken: freshId, resumeType: "opencode_session_id" as const } : {}),
      // Tells the orchestrator the brief already rode the launch command —
      // it must NOT re-deliver the folded components interactively.
      ...(opts.initialPrompt?.trim() ? { initialPromptDelivered: true } : {}),
    };
  }

  /** DEC-1 (2026-10-08): bounded poll for the `--prompt` fresh-launch session
   *  row. With `--prompt` opencode inserts the session row as it processes the
   *  prompt (not at TUI-ready), so a single read right after verifyLaunch can
   *  miss it; a bounded poll (10 x 300ms = ~3s) captures the token reliably.
   *  Same cwd-scoped + minTimeCreatedMs posture as the single read (the row
   *  must be created at/after this launch). Null on timeout/any failure — the
   *  honest fresh fallback, never a fabricated token. */
  private async waitForFreshSessionId(
    cwd: string | null,
    minTimeCreatedMs: number,
  ): Promise<string | null> {
    const pollMs = 300;
    const attempts = 10;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const id = await this.readLatestSessionId(cwd, minTimeCreatedMs).catch(() => null);
      if (id) {
        const validation = validateResumeToken("opencode", id);
        if (validation.ok) return validation.token;
      }
      if (attempt < attempts - 1) await this.sleep(pollMs);
    }
    return null;
  }

  async checkReady(binding: NodeBinding): Promise<ReadinessResult> {
    if (!binding.tmuxSession) {
      return { ready: false, reason: "No tmux session bound" };
    }
    const alive = await this.tmux.hasSession(binding.tmuxSession);
    if (!alive) {
      return { ready: false, reason: "tmux session not responsive" };
    }
    const paneCommand = (await this.tmux.getPaneCommand(binding.tmuxSession)) ?? "";
    const paneContent = (await this.tmux.capturePaneContent(binding.tmuxSession, 40)) ?? "";
    return assessOpencodePane(paneCommand, paneContent);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private projectEntry(entry: ProjectionEntry, binding: NodeBinding): boolean {
    if (entry.category === "guidance" && entry.mergeStrategy === "managed_block") {
      const targetPath = nodePath.join(binding.cwd, "AGENTS.md");
      const content = this.fs.readFile(entry.absolutePath);
      return this.mergeGuidance(targetPath, entry.effectiveId, content);
    }

    // Skills / plugins / subagents / runtime resources have no verified
    // opencode projection target at MVP (opencode reads AGENTS.md natively;
    // plugin install is operator-side `opencode plugin`) — an honest skip,
    // never a misdelivery.
    return false;
  }

  private mergeGuidance(targetPath: string, blockId: string, content: string): boolean {
    // Mirrors the Claude/Codex/Pi/Muse adapters: per-seat `rig-role` content
    // collides across pod-mates when merged into a shared cwd file; it is
    // delivered via send_text instead. See ADR-0006.
    if (blockId === "rig-role") {
      console.log(
        `[openrig] skip: effectiveId is rig-role, per-seat delivery via send_text path required (target=${targetPath})`
      );
      return false;
    }
    mergeManagedBlock(this.fs, targetPath, blockId, content, {
      replaceBlockIds: blockId === "openrig-start.md" ? ["using-openrig.md"] : [],
    });
    return true;
  }

  // ── In-place restart resume surface ─────────────────────────────────────────
  // Reused by the seat restart-in-place operation for opencode seats. These mirror the
  // Codex launcher's resume contract (build → type into the pane's shell → verify) so a
  // running opencode seat can be respawned in its own pane on its own session, re-reading
  // its seat-cwd opencode.json with the same effective posture a normal resume launch uses.
  // There is no managed config write and no core plugin: opencode reads its config from the
  // seat cwd natively, so a relaunch on the same session IS the config-reload path.

  /** Build the exact resume command the relaunch will run, from the seat binding. Same posture
   *  a normal resume launch resolves, so the relaunched seat keeps its effective settings. */
  async buildResumeCommand(
    binding: NodeBinding,
    opts: { name: string; resumeToken: string },
  ): Promise<{ ok: true; command: string; core: string } | { ok: false; error: string }> {
    if (!binding.tmuxSession) {
      return { ok: false, error: "No tmux session bound — cannot build an opencode resume command" };
    }
    const validation = validateResumeToken("opencode", opts.resumeToken);
    if (!validation.ok) return { ok: false, error: `opencode resume: ${validation.error}` };
    const postureArg = opencodePostureFlag(process.env, binding.launchPosture);
    const command = buildOpencodeResumeCommand({
      sessionId: validation.token, cwd: binding.cwd, model: binding.model, postureArg,
    });
    // opencode launches carry no seat-env wrapper, so the hand-run recovery line is the
    // same command (unlike Codex, whose core omits the env wrapper).
    return { ok: true, command, core: command };
  }

  /** Type the resume command buildResumeCommand built directly into the pane's shell, then verify the
   *  resume as launchHarness does. This mirrors the production opencode resume-launch send (sendText +
   *  Enter, NOT staged /bin/sh): opencode becomes the pane's own foreground process, so verifyLaunch's
   *  "runtime owns the pane" readiness — the same signal a normal resume launch relies on — holds after
   *  the relaunch. Staging via /bin/sh would leave a wrapper shell as the pane foreground and never verify.
   *  Nothing is decided again, so the command runs exactly as it was built. */
  async sendResumeCommand(tmuxSession: string, command: string, _resumeToken: string): Promise<HarnessLaunchResult> {
    const textResult = await this.tmux.sendText(tmuxSession, command);
    if (!textResult.ok) return { ok: false, error: `Failed to send launch command: ${textResult.message}` };
    const enterResult = await this.tmux.sendKeys(tmuxSession, ["Enter"]);
    if (!enterResult.ok) return { ok: false, error: `Failed to send Enter: ${enterResult.message}` };
    return this.verifyLaunch(tmuxSession, true);
  }

  /** launchHarness's resume verification for a resume the caller started itself (respawn path):
   *  require the opencode TUI to become active again in the pane. */
  async verifyResumeInPane(tmuxSession: string, _resumeToken: string): Promise<HarnessLaunchResult> {
    return this.verifyLaunch(tmuxSession, true);
  }

  private async verifyLaunch(sessionName: string, isResume: boolean): Promise<HarnessLaunchResult> {
    const pollMs = 250;
    const attempts = 20; // ~5s: opencode boot into the seat pane
    for (let attempt = 0; attempt < attempts; attempt++) {
      const paneCommand = (await this.tmux.getPaneCommand(sessionName)) ?? "";
      const paneContent = (await this.tmux.capturePaneContent(sessionName, 40)) ?? "";
      const verdict = assessOpencodePane(paneCommand, paneContent);
      if (verdict.ready) return { ok: true };
      if (verdict.code === "no_saved_session" && isResume) {
        return {
          ok: false,
          error: "opencode resume: no saved session found for the requested id",
          recovery: "retry_fresh",
        };
      }
      if (verdict.code === "opencode_error" || verdict.code === "login_required") {
        return {
          ok: false,
          error: `opencode launch failed: ${verdict.reason}`,
          recovery: "attention_required",
          evidence: paneContent.split("\n").slice(-12).join("\n"),
        };
      }
      if (attempt < attempts - 1) await this.sleep(pollMs);
    }
    return {
      ok: false,
      error: "opencode launch: timed out waiting for OpenCode to become active",
      recovery: "attention_required",
    };
  }

  private async waitForNewSessionId(cwd: string, parentId: string, minTimeCreatedMs: number): Promise<string | null> {
    const pollMs = 250;
    const attempts = 20; // ~5s for the forked child to register in opencode.db
    for (let attempt = 0; attempt < attempts; attempt++) {
      const candidates = (await this.listSessionIdsSince(cwd, minTimeCreatedMs).catch(() => [] as string[]))
        .filter((id) => id !== parentId);
      // Ambiguity (a pod-mate's session created inside the fork window) is
      // a loud unresolved null — never a silent accept of the wrong
      // conversation. v1 fork children carry no parent linkage, so
      // exactly-one-candidate is the only safe accept.
      if (candidates.length > 1) return null;
      const latest = candidates[0];
      // The adapter contract requires the NEW post-fork token, never the parent's.
      if (latest) {
        const validation = validateResumeToken("opencode", latest);
        if (validation.ok) return validation.token;
      }
      if (attempt < attempts - 1) await this.sleep(pollMs);
    }
    return null;
  }
}

/** Pane-state verdict for an OpenCode seat. Pure — shared by checkReady and
 *  the launch verifier so the two never disagree. */
export function assessOpencodePane(
  paneCommand: string,
  paneContent: string,
): ReadinessResult {
  const cmd = (paneCommand ?? "").trim().toLowerCase();
  const content = paneContent ?? "";
  // A dead resume id must win even inside a running TUI (the error renders
  // in-pane while `opencode` still owns it).
  if (/no (saved )?session found|unknown session|session (id )?not found|no such session/i.test(content)) {
    return { ready: false, reason: "OpenCode reports no saved session for the requested id", code: "no_saved_session" };
  }
  // Hosts with the raw ELF install (no wrapper) show `opencode.bin` as the
  // pane command; both spellings are the runtime owning the pane.
  const runtimeOwnsPane =
    cmd === "opencode" || cmd.startsWith("opencode ") ||
    cmd === "opencode.bin" || cmd.startsWith("opencode.bin ");
  // A running runtime is up even when agent output contains error-like text
  // (test runs print "exit code 1", tracebacks, ...): the generic markers
  // below apply only when the runtime does NOT own the pane. Narrow auth
  // phrases still count while it does — an auth-dead TUI is not operable.
  if (runtimeOwnsPane) {
    if (/login required|not authenticated|authentication (failed|required)|please run `?opencode (auth|login)`?/i.test(content)) {
      return { ready: false, reason: "OpenCode reports missing or expired authentication", code: "login_required" };
    }
    return { ready: true };
  }
  if (/login required|not authenticated|authentication (failed|required)|please run `?opencode (auth|login)`?/i.test(content)) {
    return { ready: false, reason: "OpenCode reports missing or expired authentication", code: "login_required" };
  }
  if (/\[opencode\] error|opencode: (error|failed)|exit(ed)?( with)? code \d+|traceback/i.test(content)) {
    return { ready: false, reason: "OpenCode reported an error in the pane", code: "opencode_error" };
  }
  if (SHELL_COMMANDS.has(cmd)) {
    return { ready: false, reason: "OpenCode has not started yet (pane is at a shell)", code: "awaiting_runtime" };
  }
  if (cmd.length === 0) {
    return { ready: false, reason: "OpenCode has not started yet", code: "awaiting_runtime" };
  }
  return { ready: false, reason: `OpenCode pane is running an unexpected foreground process (${paneCommand})`, code: "awaiting_runtime" };
}
