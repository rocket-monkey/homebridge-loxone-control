/* eslint-disable @typescript-eslint/no-explicit-any */
import LoxoneClient from "loxone-ts-api";
import { LoxoneControlPlatform } from "../platform.js";
import { parseIdentifier } from "./utils/parseIdentifier.js";
import { STATUS_STALE_THRESHOLD } from "../settings.js";

/**
 * Native-command translation from the plugin's internal command arrays to the
 * tokens the Loxone Miniserver IO command (`jdev/sps/io/<uuid>/<cmd>`) expects.
 *
 * The accessory code sends arrays such as `["on"]`, `["off"]`, `["auto"]`,
 * `["stop"]`, `["FullUp"]`, `["FullDown"]`, `["NoAuto"]`, `["shade"]`, a bare
 * numeric `["50"]` (dimmer/position), `["50","override"]` (dimmer) or `["4"]`
 * (fan level). Most of those tokens ARE the native Loxone IO command verbs —
 * the web path forwards them unchanged to Loxone's own `_sendCommand`, which
 * posts `jdev/sps/io/<uuid>/<token>`. So the default translation is
 * "join the tokens with '/'".
 *
 * `override` is the one known web-only suffix (a Loxone-web-JS argument, not an
 * IO verb); it is dropped. Everything else is passed through verbatim.
 *
 * ⚠️ LIVE-VERIFY (post-firmware): a few tokens are not yet confirmed against a
 * real Miniserver because Remote Connect is locked (HTTP 418) until the
 * pending firmware update — specifically `shade` and the fan-level command
 * shape. The mapping is deliberately a pass-through so that whatever the web
 * path sent is what the app path sends; adjust here once a live login is
 * possible. See test-app-connector.mjs for the pinned cases.
 */
export function toNativeCommand(cmdArray: unknown[]): string {
  const tokens = (cmdArray ?? [])
    .map((t) => (t === null || t === undefined ? "" : String(t)))
    .filter((t) => t.length > 0 && t !== "override");
  return tokens.join("/");
}

/**
 * App-protocol connector: speaks the documented Loxone WebSocket/token
 * protocol via `loxone-ts-api` instead of driving the web UI in a headless
 * browser. Selected with `remoteMode: "app"` in the platform config; the web
 * (Puppeteer) connector stays the default.
 *
 * It feeds state into the SAME `platform.onStatusUpdate(stateContainer)` path
 * the web connector uses, by synthesising a stateContainer from each enriched
 * Loxone event, so every existing accessory keeps working unchanged. Routing
 * keys on `type` + `uuidAction` (onStatusUpdate's fallback match), so the
 * approximate `searchDescription` built here does not need to match Loxone's.
 *
 * ⚠️ The connection/auth/relay path and the per-control state value shapes can
 * only be verified against the live Miniserver once the firmware update lands
 * (Remote Connect currently answers 418). This is wired against the library's
 * typed API + the documented protocol; the deterministic parts (command
 * translation, stateContainer synthesis, controlStateMaps build) are unit
 * tested in test-app-connector.mjs.
 */
export class LoxoneAppConnector {
  private client: LoxoneClient | undefined;
  private connected = false;
  private ready = false;
  private lastDataAt = 0;
  private shuttingDown = false;

  constructor(private readonly platform: LoxoneControlPlatform) {}

  async init(): Promise<boolean> {
    const serial = this.platform.config.loxoneMiniServerId as string;
    const user = this.platform.config.loxoneUser as string;
    const password = this.platform.config.loxonePassword as string;
    if (!serial || !user || !password) {
      this.platform.logger.error(
        "🔌 App connector: loxoneMiniServerId / loxoneUser / loxonePassword missing",
      );
      return false;
    }

    this.client = new LoxoneClient(serial, user, password, {
      autoReconnectEnabled: true,
      keepAliveEnabled: true,
      maintainLatestEvents: true,
    });
    this.client.setLogLevel(this.platform.config.verboseLogging ? "debug" : "warn");

    this.wireEvents();

    try {
      this.platform.logger.info(
        `🔌 App connector: connecting to Miniserver ${serial} via Remote Connect…`,
      );
      await this.client.connect();
      // Parse the structure so controls/states/rooms are populated and events
      // can be enriched, then switch on binary status updates.
      await this.client.parseStructureFile();
      this.buildControlStateMaps();
      await this.client.enableUpdates();
      this.ready = true;
      this.platform.logger.info(
        `✅ App connector ready — ${this.client.controls.size} controls, ${this.client.states.size} states`,
      );
      // Reuse the platform's readiness gate + initial replay (harmless no-op
      // replay: allStates is empty until the first events arrive).
      this.platform.onReady();
      return true;
    } catch (e) {
      this.platform.logger.error(`🔌 App connector init failed: ${e}`);
      return false;
    }
  }

  private wireEvents() {
    const c = this.client!;
    c.on("connected", () => {
      this.connected = true;
      this.platform.logger.info("🔌 App connector: websocket connected");
    });
    c.on("authenticated", () =>
      this.platform.logger.info("🔌 App connector: authenticated"),
    );
    c.on("disconnected", (reason: string) => {
      this.connected = false;
      this.platform.logger.warn(`🔌 App connector: disconnected (${reason})`);
    });
    c.on("error", (err: Error) =>
      this.platform.logger.error(`🔌 App connector error: ${err.message}`),
    );
    c.on("event_value", (ev: any) => this.onEnrichedEvent(ev, "value"));
    c.on("event_text", (ev: any) => this.onEnrichedEvent(ev, "text"));
  }

  /**
   * Build `controlStateMaps[uuidAction][stateName] = stateUuid`, the exact
   * structure the platform's `resolveStateValue()` and the window-covering
   * Auto-Sun extraction read. Stored on the (otherwise idle in app mode) web
   * interface instance so those code paths work identically.
   */
  private buildControlStateMaps() {
    const maps: { [uuidAction: string]: { [name: string]: string } } = {};
    for (const control of this.client!.controls.values()) {
      const uuidAction = (control as any).uuidAction;
      if (!uuidAction) {
        continue;
      }
      const nameToUuid: { [name: string]: string } = {};
      const byName: Map<string, any> = (control as any).statesByName;
      if (byName) {
        for (const [name, state] of byName) {
          nameToUuid[name] = String(state.uuid);
        }
      }
      maps[uuidAction] = nameToUuid;
    }
    this.platform.applyControlStateMaps(maps);
  }

  /**
   * Translate one enriched Loxone event into the stateContainer shape
   * `platform.onStatusUpdate` consumes and dispatch it. Enrichment attaches
   * `event.state` (→ parentControl); without it we cannot route, so skip.
   */
  private onEnrichedEvent(ev: any, kind: "value" | "text") {
    this.lastDataAt = Date.now();
    const state = ev?.state;
    const control = state?.parentControl;
    if (!control) {
      // Not enriched (structure not parsed yet, or an unmodelled state) — the
      // library keeps the latest value regardless; nothing to route here.
      return;
    }
    const uuidAction = control.uuidAction;
    const type = control.type;
    const roomName = control.room?.name ?? "unknown";
    const searchDescription = `${roomName} • ${control.name ?? "unknown"}`;
    const stateUuid = String(state.uuid);

    // Name→UUID map for this control (what onStatusUpdate stores on .control.states)
    const stateNameMap: { [name: string]: string } = {};
    if (control.statesByName) {
      for (const [name, s] of control.statesByName as Map<string, any>) {
        stateNameMap[name] = String(s.uuid);
      }
    }

    const value = kind === "value" ? ev.value : ev.text;
    const stateContainer: any = {
      control: { searchDescription, type, uuidAction, states: stateNameMap },
      newVals: { [stateUuid]: value },
    };
    if (kind === "text") {
      stateContainer.stateText = ev.text;
    }

    try {
      this.platform.onStatusUpdate(stateContainer);
    } catch (e) {
      this.platform.logger.debug(`App connector dispatch error: ${e}`);
    }
  }

  /**
   * Send a control command. `identifier` is the config device identifier
   * (`<desc>:type=<type>:<uuidAction>`); `cmdArray` is the accessory's command
   * array (e.g. `["on"]`, `["50","override"]`). Returns a JS error on failure
   * or null on success, matching sendCommand.ts's contract.
   */
  async control(identifier: string, cmdArray: unknown[]): Promise<unknown> {
    if (!this.client || !this.ready) {
      return "App connector not ready";
    }
    const { actionUuid } = parseIdentifier(identifier);
    if (!actionUuid) {
      return `App connector: no uuidAction in identifier "${identifier}"`;
    }
    const command = toNativeCommand(cmdArray);
    if (!command) {
      return `App connector: empty command for "${identifier}"`;
    }
    try {
      this.platform.logger.debug(
        `   🔌 app control ${actionUuid} → ${command}`,
      );
      await this.client.control(actionUuid, command);
      return null;
    } catch (e) {
      return e;
    }
  }

  async getHealthStatus() {
    const dataAgeMs = this.lastDataAt ? Date.now() - this.lastDataAt : null;
    const dataFresh = dataAgeMs !== null && dataAgeMs < STATUS_STALE_THRESHOLD;
    return {
      status:
        this.connected && this.ready && dataFresh
          ? "healthy"
          : this.connected
            ? "unhealthy"
            : "disconnected",
      browser: "n/a (app mode)",
      page: "n/a (app mode)",
      data: dataAgeMs === null ? "none" : dataFresh ? "flowing" : "stale",
      dataAge: dataAgeMs === null ? null : Math.round(dataAgeMs / 1000),
      recovering: false,
      recoveryCount: 0,
      uptime: Math.round(process.uptime()),
      mode: "app",
    };
  }

  shutdown() {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    try {
      this.client?.disconnect();
    } catch {
      // best effort on shutdown
    }
  }
}
