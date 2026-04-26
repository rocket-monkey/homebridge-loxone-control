import { CharacteristicValue, PlatformAccessory, Service } from "homebridge";
import { AccessoryBase } from "./accessoryBase.js";
import { LoxoneControlPlatform } from "./platform.js";
import { sendCommandSafe } from "./loxone/utils/sendCommand.js";
import { sleep } from "./loxone/utils/sleep.js";
import { States } from "./loxone/types.js";
import { PlatformWindowCoveringAccessory } from "./platformWindowCoveringAccessory.js";

interface CentralBlindState {
  controlUUID?: string;
  autoActive?: boolean;
  [key: string]: unknown;
}

export class PlatformCentralBlindsAccessory extends AccessoryBase {
  protected override get modelName() {
    return "Loxone Central Blinds";
  }

  private momentaryServices: Service[] = [];
  private autoSwitchService: Service | undefined;
  private autoActive = false;
  // Set of controlUUIDs Loxone reports as part of this central. Awnings
  // (Markise) sit outside Loxone's CentralJalousie aggregation, so the
  // central Auto switch must not fan out to them.
  private memberControlUUIDs: Set<string> = new Set();

  constructor(
    public readonly platform: LoxoneControlPlatform,
    public readonly accessory: PlatformAccessory,
    public readonly identifier: string,
  ) {
    super(platform, accessory, identifier);

    const { device } = accessory.context;

    // Remove all non-AccessoryInformation services from previous versions
    const servicesToRemove = this.accessory.services.filter(
      (s) => s.UUID !== this.platform.Service.AccessoryInformation.UUID,
    );
    for (const s of servicesToRemove) {
      this.accessory.removeService(s);
    }

    const momentaryButtons: Array<{ name: string; subtype: string; emoji: string; command: string }> = [
      { name: `${device.name} Up`, subtype: `${device.name}-all-up`, emoji: "⬆️", command: "FullUp" },
      { name: `${device.name} Down`, subtype: `${device.name}-all-down`, emoji: "⬇️", command: "FullDown" },
      { name: `${device.name} Stop`, subtype: `${device.name}-stop`, emoji: "✋", command: "stop" },
      { name: `${device.name} Shade`, subtype: `${device.name}-shade`, emoji: "🌤️", command: "shade" },
    ];

    momentaryButtons.forEach(({ name, subtype, emoji, command }, index) => {
      const svc = this.accessory.addService(
        this.platform.Service.Switch,
        name,
        subtype,
      );
      this.setServiceName(svc, name);

      svc.getCharacteristic(this.platform.Characteristic.On)
        .onGet(() => false)
        .onSet(async (value: CharacteristicValue) => {
          if (value) {
            this.platform.logger.info(`${emoji} ${device.name}: Sending ${command}`);
            await sendCommandSafe(this.platform, this.identifier, [command]);
            await sleep(1000);
            this.resetMomentaryButtons();
          }
        });

      this.momentaryServices.push(svc);

      if (index === 0) {
        this.service = svc;
      }
    });

    // Stateful Auto switch — reflects whether sun-shading automation is active
    // across all blinds. Loxone's CentralJalousie state is an array of per-blind
    // states each with an autoActive boolean; the switch is ON only when every
    // blind has autoActive=true.
    this.autoSwitchService = this.accessory.addService(
      this.platform.Service.Switch,
      `${device.name} Auto`,
      `${device.name}-auto`,
    );
    this.setServiceName(this.autoSwitchService, `${device.name} Auto`);

    this.autoSwitchService
      .getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.autoActive)
      .onSet(this.setAutoOn.bind(this));
  }

  private resetMomentaryButtons() {
    for (const svc of this.momentaryServices) {
      svc.updateCharacteristic(this.platform.Characteristic.On, false);
    }
  }

  private async setAutoOn(value: CharacteristicValue) {
    const desired = value as boolean;
    const { name } = this.accessory.context.device;
    this.platform.logger.info(
      `☀️ ${name}: All Blinds Auto ${desired ? "ON" : "OFF"} ` +
      `(scope: ${this.memberControlUUIDs.size} blind(s); awnings excluded)`,
    );

    this.autoActive = desired;

    // Send to the central Loxone control. Loxone propagates internally to all
    // member covers — but only those it actually aggregates (awnings are not
    // part of CentralJalousie and stay independent, per Loxone's design).
    const centralCmd = desired ? "auto" : "stop";
    const memberCmd = desired ? "auto" : "NoAuto";
    await sendCommandSafe(this.platform, this.identifier, [centralCmd]);

    // Optimistic snappiness: also push the command (and the optimistic switch
    // state) directly to each member cover, bypassing the wait for Loxone's
    // re-broadcast. Scoped by memberControlUUIDs so awnings are skipped.
    if (this.memberControlUUIDs.size > 0) {
      this.platform.resetAllBlindAutoCooldowns();
      const targets = this.platform.instances.filter(
        (inst): inst is PlatformWindowCoveringAccessory =>
          inst instanceof PlatformWindowCoveringAccessory &&
          [...this.memberControlUUIDs].some((u) => inst.identifier.includes(u)),
      );
      for (const t of targets) {
        t.autoSunPosition = desired;
        t.autoSunSwitchService?.updateCharacteristic(
          this.platform.Characteristic.On,
          desired,
        );
        t.lastAutoSunCommand = Date.now();
      }
      await Promise.all(
        targets.map((t) => sendCommandSafe(this.platform, t.identifier, [memberCmd])),
      );
    }
  }

  getAutoActive(): boolean {
    return this.autoActive;
  }

  setState = (newStates: States) => {
    // Momentary buttons don't track state — flick them back to OFF in case
    // HomeKit ever pushed them to ON.
    this.resetMomentaryButtons();
    this.states = newStates;

    if (!Array.isArray(newStates)) {
      return;
    }

    const blinds = newStates as CentralBlindState[];
    // Refresh membership set from the broadcast so the next setAutoOn knows
    // exactly which covers Loxone aggregates under this central.
    this.memberControlUUIDs = new Set(
      blinds.map((b) => b.controlUUID).filter((u): u is string => typeof u === "string"),
    );
    const allAutoActive = blinds.length > 0 && blinds.every((b) => b.autoActive === true);
    const autoActiveCount = blinds.filter((b) => b.autoActive === true).length;

    if (this.autoActive !== allAutoActive) {
      this.platform.logger.info(
        `☀️ ${this.accessory.context.device.name}: ${autoActiveCount}/${blinds.length} blinds auto, ` +
        `central Auto switch → ${allAutoActive ? "ON" : "OFF"}`,
      );
      this.autoActive = allAutoActive;
      this.autoSwitchService?.updateCharacteristic(
        this.platform.Characteristic.On,
        this.autoActive,
      );
    }

    // Dispatch per-blind autoActive to each individual WindowCovering accessory.
    // The central CentralJalousie state is the canonical source — per-blind
    // status messages don't carry autoActive on their own.
    for (const blind of blinds) {
      if (!blind.controlUUID || typeof blind.autoActive !== "boolean") {
        continue;
      }
      const target = this.platform.instances.find(
        (inst): inst is PlatformWindowCoveringAccessory =>
          inst instanceof PlatformWindowCoveringAccessory &&
          inst.identifier.includes(blind.controlUUID as string),
      );
      target?.applyAutoActiveFromCentral(blind.autoActive);
    }
  };
}
