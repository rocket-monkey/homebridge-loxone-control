// Unit tests for the app-protocol connector (remoteMode=app), added v3.1.0.
// Run with: node test-app-connector.mjs (after npm run build).
//
// These cover the DETERMINISTIC parts that do not need a live Miniserver:
//   - command-array → native Loxone IO command translation
//   - enriched-event → stateContainer synthesis + routing into onStatusUpdate
//   - identifier → uuidAction command routing to the client
//   - control name→UUID map build (controlStateMaps)
// The live login / relay / real per-control value shapes can only be verified
// once Remote Connect is reachable again (firmware update); not covered here.

import { LoxoneAppConnector, toNativeCommand } from "./dist/loxone/appConnector.js";

let failed = 0;
function expect(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  actual=${a}  expected=${e}`);
  if (!ok) failed++;
}

// ── 1. toNativeCommand ────────────────────────────────────────────────────
expect("cmd on", toNativeCommand(["on"]), "on");
expect("cmd off", toNativeCommand(["off"]), "off");
expect("cmd auto", toNativeCommand(["auto"]), "auto");
expect("cmd stop", toNativeCommand(["stop"]), "stop");
expect("cmd FullUp", toNativeCommand(["FullUp"]), "FullUp");
expect("cmd FullDown", toNativeCommand(["FullDown"]), "FullDown");
expect("cmd NoAuto", toNativeCommand(["NoAuto"]), "NoAuto");
expect("cmd numeric position", toNativeCommand(["50"]), "50");
expect("cmd brightness drops override", toNativeCommand(["50", "override"]), "50");
expect("cmd fan level", toNativeCommand(["4"]), "4");
expect("cmd shade (pass-through)", toNativeCommand(["shade"]), "shade");
expect("cmd empty", toNativeCommand([]), "");
expect("cmd null-safe", toNativeCommand([null, undefined, "on"]), "on");

// ── Shared fakes ──────────────────────────────────────────────────────────
function makeStructure() {
  const state = { uuid: { toString: () => "state-uuid-1" }, name: "active" };
  const control = {
    uuidAction: "0f12aaaa-bbbb",
    type: "Switch",
    name: "Licht",
    room: { name: "Küche" },
    statesByName: new Map([["active", state]]),
  };
  state.parentControl = control;
  return { state, control };
}
function makePlatform() {
  const captured = {};
  return {
    captured,
    logger: { info() {}, debug() {}, warn() {}, error() {} },
    config: { loxoneMiniServerId: "SN", loxoneUser: "u", loxonePassword: "p" },
    onStatusUpdate(sc) { captured.stateContainer = sc; },
    onReady() { captured.ready = true; },
    applyControlStateMaps(m) { captured.maps = m; },
  };
}

// ── 2. enriched event → stateContainer synthesis ──────────────────────────
{
  const { state, control } = makeStructure();
  const platform = makePlatform();
  const conn = new LoxoneAppConnector(platform);
  conn.onEnrichedEvent({ value: 1, state }, "value");
  const sc = platform.captured.stateContainer;
  expect("event → control.type", sc?.control?.type, "Switch");
  expect("event → control.uuidAction", sc?.control?.uuidAction, control.uuidAction);
  expect("event → newVals keyed by state uuid", sc?.newVals, { "state-uuid-1": 1 });
  expect("event → control.states name map", sc?.control?.states, { active: "state-uuid-1" });
}

// text event carries stateText
{
  const { state } = makeStructure();
  const platform = makePlatform();
  const conn = new LoxoneAppConnector(platform);
  conn.onEnrichedEvent({ text: "100%", state }, "text");
  const sc = platform.captured.stateContainer;
  expect("text event stateText", sc?.stateText, "100%");
  expect("text event newVals", sc?.newVals, { "state-uuid-1": "100%" });
}

// unenriched event (no state) is skipped, not crashing
{
  const platform = makePlatform();
  const conn = new LoxoneAppConnector(platform);
  conn.onEnrichedEvent({ value: 1 }, "value");
  expect("unenriched event skipped", platform.captured.stateContainer, undefined);
}

// ── 3. control() routing to client ────────────────────────────────────────
{
  const { control } = makeStructure();
  const platform = makePlatform();
  const conn = new LoxoneAppConnector(platform);
  const sent = {};
  conn.client = { control: (uuid, cmd) => { sent.uuid = uuid; sent.cmd = cmd; return Promise.resolve({}); } };
  conn.ready = true;
  const id = `Küche • Licht:type=Switch:${control.uuidAction}`;
  const err = await conn.control(id, ["on"]);
  expect("control routes uuid", sent.uuid, control.uuidAction);
  expect("control routes native cmd", sent.cmd, "on");
  expect("control returns null on success", err, null);
}

// not ready → returns an error string, does not throw
{
  const platform = makePlatform();
  const conn = new LoxoneAppConnector(platform);
  const err = await conn.control("x:type=Switch:uuid", ["on"]);
  expect("control not-ready guarded", typeof err, "string");
}

// ── 4. buildControlStateMaps ──────────────────────────────────────────────
{
  const { control } = makeStructure();
  const platform = makePlatform();
  const conn = new LoxoneAppConnector(platform);
  conn.client = { controls: new Map([[control.uuidAction, control]]) };
  conn.buildControlStateMaps();
  expect("controlStateMaps structure", platform.captured.maps, {
    "0f12aaaa-bbbb": { active: "state-uuid-1" },
  });
}

console.log(failed === 0 ? "\nALL APP-CONNECTOR TESTS PASSED" : `\n${failed} TESTS FAILED`);
process.exit(failed === 0 ? 0 : 1);
