import assert from "node:assert/strict";
import test from "node:test";
import { AutomaticSession } from "../src/renderer/src/lib/automaticSession.ts";
import type { BridgeProcessSnapshot, BridgeStartOptions } from "../src/shared/bridge.ts";

const options = (modelId = "tumbler"): BridgeStartOptions => ({ modelId, gamepadId: "auto" });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function harness(initial: BridgeProcessSnapshot = { status: "idle" }) {
  let snapshot = initial;
  const calls: string[] = [];
  const errors: string[] = [];
  const api = {
    getBridgeStatus: async () => snapshot,
    stopBridge: async () => { calls.push("stop"); snapshot = { status: "exited" }; return { ok: true }; },
    startBridge: async (options: BridgeStartOptions) => { calls.push(options.modelId); snapshot = { status: "starting", operation: "live" }; return { ok: true }; }
  };
  const session = new AutomaticSession(api, (error) => errors.push(error));
  return { session, api, calls, errors, status: (value: BridgeProcessSnapshot) => { snapshot = value; } };
}

test("startup starts once and backend reconnect states do not spawn duplicate workers", async () => {
  const h = harness();
  h.session.configure(options()); await tick();
  for (const status of ["starting", "running"] as const) {
    h.status({ status, operation: "live" });
    await h.session.reconcile();
  }
  assert.deepEqual(h.calls, ["tumbler"]);
  h.status({ status: "exited" }); await h.session.reconcile();
  assert.deepEqual(h.calls, ["tumbler", "tumbler"]);
});

test("renderer reload adopts existing driving and model changes stop before restarting", async () => {
  const h = harness({ status: "running", operation: "live" });
  h.session.configure(options()); await tick();
  assert.deepEqual(h.calls, []);
  h.session.configure(options("future-model")); await tick();
  assert.deepEqual(h.calls, ["stop", "future-model"]);
});

test("rapid selection changes during shutdown use only the latest model", async () => {
  const h = harness(); h.session.configure(options()); await tick();
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const stop = h.api.stopBridge;
  h.api.stopBridge = async () => { await gate; return stop(); };
  h.session.configure(options("intermediate")); await tick();
  h.session.configure(options("latest")); finish(); await tick();
  assert.deepEqual(h.calls, ["tumbler", "stop", "latest"]);
});

test("failed stop never starts another worker; failed starts retry with backoff", async () => {
  const h = harness(); h.session.configure(options()); await tick();
  h.api.stopBridge = async () => ({ ok: false });
  h.session.configure(options("future")); await tick();
  assert.deepEqual(h.calls, ["tumbler"]);
  assert.equal(h.errors.length, 1);
  await h.session.reconcile(0);
  assert.equal(h.errors.length, 1);
});

test("disposal prevents queued starts and diagnostics finish before resuming", async () => {
  const h = harness({ status: "running", operation: "scanHub" });
  h.session.setEnabled(false);
  h.session.configure(options()); await tick();
  assert.deepEqual(h.calls, []);
  h.status({ status: "exited" }); h.session.dispose(); await h.session.reconcile();
  assert.deepEqual(h.calls, []);
});

test("returning from diagnostics stops its worker before automatic driving resumes", async () => {
  const h = harness({ status: "running", operation: "probeGamepad" });
  h.session.setEnabled(false); h.session.configure(options()); await tick();
  assert.deepEqual(h.calls, []);
  h.session.setEnabled(true); await h.session.reconcile();
  assert.deepEqual(h.calls, ["stop", "tumbler"]);
});

test("failed startup retries after backoff without requiring a button", async () => {
  const h = harness();
  const start = h.api.startBridge;
  h.api.startBridge = async () => ({ ok: false });
  h.session.configure(options()); await tick();
  assert.equal(h.errors.length, 1);
  await h.session.reconcile(0);
  assert.equal(h.errors.length, 1);
  h.api.startBridge = start;
  await h.session.reconcile(Date.now() + 5000);
  assert.deepEqual(h.calls, ["tumbler"]);
});
