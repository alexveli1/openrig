import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore, hookEventState } from "../src/domain/agent-activity-store.js";
import { SeatActivityService, HOOK_AUTHORITY_WINDOW_MS } from "../src/domain/seat-activity-service.js";
import { activityRoutes } from "../src/routes/activity.js";
import {
  CLAUDE_ACTIVITY_RUNG_INVENTORY,
  CODEX_ACTIVITY_RUNG_INVENTORY,
  OMP_ACTIVITY_RUNG_INVENTORY,
  PI_ACTIVITY_RUNG_INVENTORY,
  TMUX_GENERIC_RUNG_INVENTORY,
  runtimeRungInventory,
} from "../src/domain/activity-taxonomy.js";
import { mapPiEvent } from "../src/adapters/pi-runner.js";
import { diagnoseSeatParked } from "../src/domain/parked-query.js";

// pi and omp seats read activity from their runners' own turn events, through the one activity service.
// Every test posts what the runner posts for a runner event (mapPiEvent's hook), through the real route and recorder.

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function fixture(runtime: "pi" | "omp") {
  const clock = { now: Date.parse("2026-10-21T12:00:00.000Z") };
  const db = createFullTestDb();
  cleanups.push(() => db.close());
  const rigs = new RigRepository(db);
  const rig = rigs.createRig("runner-activity");
  const node = rigs.addNode(rig.id, "dev.a", { runtime });
  const sessions = new SessionRegistry(db);
  // The seat's previous occupant, under its own session name and generation, then the current one by handover.
  const oldSession = sessions.registerSession(node.id, "dev-a-old@runner-activity");
  const oldGeneration = sessions.currentOccupantTenure(node.id)!.generationUuid;
  sessions.updateStatus(oldSession.id, "exited");
  const session = sessions.registerSession(node.id, "dev-a@runner-activity", "handover");
  sessions.updateStatus(session.id, "running");
  const eventBus = new EventBus(db);
  const store = new AgentActivityStore({ db, eventBus,
    resolveOccupantGeneration: id => sessions.currentOccupantTenure(id)?.generationUuid ?? null,
    isRegisteredOccupantGeneration: (id, generation) => sessions.isOccupantGenerationRegistered(id, generation) });
  const oracle = new SeatActivityService({ tmux: { readPaneLastActivity: async () => null }, defaultWindowSeconds: 3,
    now: () => new Date(clock.now) });
  oracle.declareRungInventory({ seatNodeId: node.id, sessionName: session.sessionName }, runtimeRungInventory(runtime));
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("agentActivityStore" as never, store as never);
    c.set("activityHookToken" as never, "fixture-token" as never);
    c.set("seatActivityService" as never, oracle as never);
    await next();
  });
  app.route("/api/activity", activityRoutes);
  const generation = sessions.currentOccupantTenure(node.id)!.generationUuid;
  /** What the runner posts (its activityPayload) for a hook event. */
  async function post(hookEvent: string, subtype: string | null, over: Record<string, unknown> = {}) {
    const response = await app.request("/api/activity/hooks", { method: "POST",
      headers: { authorization: "Bearer fixture-token", "Content-Type": "application/json" },
      body: JSON.stringify({ sessionName: session.sessionName, nodeId: node.id, generation, runtime, hookEvent, subtype,
        occurredAt: new Date(clock.now).toISOString(), ...over }) });
    expect(response.status).toBe(200);
  }
  /** A runner event, posted exactly as the runner maps it; events that post nothing post nothing. */
  async function runnerEvent(event: Record<string, unknown>) {
    const mapped = mapPiEvent(event, runtime);
    if (mapped.activity) await post(mapped.activity.hookEvent, mapped.activity.subtype);
  }
  const state = () => oracle.getSeatState(node.id)!;
  const later = (ms: number) => { clock.now += ms; };
  const parked = () => diagnoseSeatParked({
    getSeatState: (id) => oracle.getSeatState(id),
    listOpenObligations: () => ({ rows: [{ qitemId: "q-1", state: "pending" }] as never, limit: 500 }),
  } as never, { seatNodeId: node.id, sessionName: session.sessionName }).parked;
  expect(generation).not.toBe(oldGeneration);
  return { post, runnerEvent, state, later, parked, oracle, node, session, oldGeneration };
}

const PAST_HOOK_WINDOW = HOOK_AUTHORITY_WINDOW_MS + 60_000;

describe("runner inventories", () => {
  it("gives pi and omp the runner inventory and leaves every other runtime as it was", () => {
    expect(runtimeRungInventory("pi")).toBe(PI_ACTIVITY_RUNG_INVENTORY);
    expect(runtimeRungInventory("omp")).toBe(OMP_ACTIVITY_RUNG_INVENTORY);
    expect(runtimeRungInventory("claude-code")).toBe(CLAUDE_ACTIVITY_RUNG_INVENTORY);
    expect(runtimeRungInventory("codex")).toBe(CODEX_ACTIVITY_RUNG_INVENTORY);
    for (const runtime of ["terminal", "stub", null]) expect(runtimeRungInventory(runtime)).toBe(TMUX_GENERIC_RUNG_INVENTORY);
    for (const inventory of [PI_ACTIVITY_RUNG_INVENTORY, OMP_ACTIVITY_RUNG_INVENTORY]) {
      expect(inventory.rungs).toEqual([
        { rung: "lifecycle-hooks", lifecycleCoverage: "full", initialTrust: "authoritative", durableBoundaries: true },
        { rung: "window-sampling", lifecycleCoverage: "partial", initialTrust: "positive-only" },
      ]);
    }
    // Claude and Codex hooks stay time-bounded.
    for (const inventory of [CLAUDE_ACTIVITY_RUNG_INVENTORY, CODEX_ACTIVITY_RUNG_INVENTORY]) {
      expect(inventory.rungs.some((r) => "durableBoundaries" in r)).toBe(false);
    }
  });
});

describe.each(["pi", "omp"] as const)("%s seat activity from its runner's turn events", (runtime) => {
  it("a quiet active turn stays working past the hook window; a completed turn reads idle and stays idle", async () => {
    const f = fixture(runtime);
    expect(f.state().activity).toBe("unknown");
    await f.runnerEvent({ type: "agent_start" });
    f.later(PAST_HOOK_WINDOW); // waiting on the model: the pane is quiet
    expect(f.state()).toMatchObject({ activity: "working", decidedBy: "lifecycle-hooks" });
    expect(f.parked()).toBe(false);
    await f.runnerEvent({ type: "agent_end" });
    f.later(PAST_HOOK_WINDOW);
    expect(f.state()).toMatchObject({ activity: "idle-at-prompt", decidedBy: "lifecycle-hooks" });
    expect(f.parked()).toBe(true); // the parked-owner wake has a parked seat to wake
  });

  it("a turn whose runner never sends agent_start still reads working from turn_start", async () => {
    const f = fixture(runtime);
    await f.runnerEvent({ type: "agent_end" });
    expect(f.state().activity).toBe("idle-at-prompt");
    await f.runnerEvent({ type: "turn_start" });
    f.later(PAST_HOOK_WINDOW);
    expect(f.state().activity).toBe("working");
  });

  it("process exit reads unknown, never idle, and stays so", async () => {
    const f = fixture(runtime);
    await f.runnerEvent({ type: "agent_start" });
    await f.post("Stop", `${runtime}_exited`);
    expect(f.state().activity).toBe("unknown");
    f.later(PAST_HOOK_WINDOW);
    expect(f.state().activity).toBe("unknown");
    expect(f.parked()).toBe("indeterminate");
    expect(hookEventState("Stop", `${runtime}_exited`, runtime)).toBe("unknown");
  });

  it("a late post from the previous occupant's generation or session changes nothing", async () => {
    const f = fixture(runtime);
    await f.runnerEvent({ type: "agent_start" });
    await f.post("Stop", "agent_end", { generation: f.oldGeneration });
    expect(f.state().activity).toBe("working");
    await f.post("Stop", "agent_end", { sessionName: "dev-a-old@runner-activity", nodeId: undefined, generation: f.oldGeneration });
    expect(f.state().activity).toBe("working");
  });
});

describe("omp only", () => {
  it("a nonterminal agent_end keeps the turn working", async () => {
    const f = fixture("omp");
    await f.runnerEvent({ type: "agent_start" });
    await f.runnerEvent({ type: "agent_end", isTerminal: false });
    f.later(PAST_HOOK_WINDOW);
    expect(f.state().activity).toBe("working");
  });

  it("attention reads needs-input, holds past the hook window, and the next turn clears it", async () => {
    const f = fixture("omp");
    await f.runnerEvent({ type: "agent_start" });
    await f.post("Notification", "permission_prompt");
    f.later(PAST_HOOK_WINDOW);
    expect(f.state().needsInput).toMatchObject({ count: 1 });
    expect(f.parked()).toBe(true); // needs-input with open work is parked
    await f.runnerEvent({ type: "agent_start" });
    expect(f.state()).toMatchObject({ activity: "working", needsInput: { count: 0 } });
  });
});

describe("Claude hooks stay time-bounded", () => {
  it("a Claude Stop older than the hook window no longer decides", () => {
    const clock = { now: Date.parse("2026-10-21T12:00:00.000Z") };
    const oracle = new SeatActivityService({ tmux: { readPaneLastActivity: async () => null }, defaultWindowSeconds: 3,
      now: () => new Date(clock.now) });
    const seat = { seatNodeId: "n-claude", sessionName: "c@r" };
    oracle.declareRungInventory(seat, CLAUDE_ACTIVITY_RUNG_INVENTORY);
    oracle.reportEvidence({ ...seat, rung: "lifecycle-hooks", sourceId: "claude-code:hooks", seq: 1,
      observedAt: new Date(clock.now).toISOString(), activity: "idle-at-prompt" });
    expect(oracle.getSeatState("n-claude")!.activity).toBe("idle-at-prompt");
    clock.now += PAST_HOOK_WINDOW;
    oracle.reportEvidence({ ...seat, rung: "needs-input-chrome", sourceId: "claude-code:chrome", seq: 1,
      observedAt: new Date(clock.now).toISOString(), needsInput: { count: 0, reason: null } });
    expect(oracle.getSeatState("n-claude")!.activity).toBe("unknown");
  });
});
