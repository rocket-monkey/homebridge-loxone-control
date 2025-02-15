/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable no-undef */
/* eslint-disable @typescript-eslint/no-var-requires */
import { HomebridgePluginUiServer } from "@homebridge/plugin-ui-utils";

class PluginUiServer extends HomebridgePluginUiServer {
  constructor() {
    // super() MUST be called first
    super();

    // this MUST be called when you are ready to accept requests
    this.ready();
  }
}

(() => {
  return new PluginUiServer();
})();
