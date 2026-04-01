/* eslint-disable @typescript-eslint/no-explicit-any */
import { LoxoneControlPlatform } from "./platform";

export class Logger {
  public readonly verbose: boolean;

  constructor(public readonly platform: LoxoneControlPlatform) {
    this.verbose = platform.config.verboseLogging;
  }

  info = (message: string, ...parameters: any[]) => {
    if (!this.verbose) {
      return;
    }
    this.platform.log.info(message, ...parameters);
  };

  debug = (message: string, ...parameters: any[]) => {
    if (!this.verbose) {
      return;
    }
    this.platform.log.debug(message, ...parameters);
  };

  warn = (message: string, ...parameters: any[]) => {
    this.platform.log.warn(message, ...parameters);
  };

  error = (message: string, ...parameters: any[]) => {
    this.platform.log.error(message, ...parameters);
  };
}
