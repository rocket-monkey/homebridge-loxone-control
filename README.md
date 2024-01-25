<p align="center" style="display: flex;">
    <img src="assets/logo.png" height="200">
</p>
<span align="center">

# Homebridge Loxone Control

</span>

[Homebridge](https://github.com/homebridge/homebridge) plugin to control a [Loxone](https://www.loxone.com) web interface with [Puppeteer](https://pptr.dev/). This is very useful when you don't have network access to the Loxone Miniserver, but you can log into the web interface of Loxone:

### Plugin Information

- This plugin allows you to view and control all your Loxone devices within HomeKit. The plugin:
  - opens a headless Chrome browser with the Loxone web interface and intercepts the built-in websocket
  - attempts to control your devices by sending commands directly with the websocket connection
  - instantly getting state updates by listening for certain events on the websocket
  - support for various devices, including blinds (with percentage and tilt adjustments), lights (with dimming capabilities), outlets, ventilations and temperature sensors.

### Prerequisites

- To use this plugin, you will need to already have:
  - [Node](https://nodejs.org): latest version of `v18` or `v20` - any other major version is not supported.
  - [Homebridge](https://homebridge.io): `v1.6` - refer to link for more information and installation instructions.
  - Credentials for Loxone MiniServer: You will need your Loxone MiniServer ID and login credentials for the Loxone App. Typically, your landlord will provide a login link or similar access method for the Loxone App. Within the app, navigate to the info panel to locate the "serial number," which serves as your MiniServer ID.

### Tenants at Jägerstrasse 59, Winterthur

Check your emails for correspondence from the 'Living Services' portal. You likely have received emails from this service. Look for one of these emails and use it to access the 'Living Services' App on a desktop browser. Inside the app, there's a 'Loxone' link. Open it and log in using the credentials provided by Wincasa. If you're unsure of your credentials, reach out to Wincasa through a support ticket for assistance.

### Setup

1. Download the latest Chromium, open a terminal in the homebridge UI and execute `sudo apt-get install chromium`
2. Verify the Chromium installation by running `chromium`, output should be similar to `(chromium:30533): Gtk-WARNING **: cannot open display`
3. Install this plugin trough the homebrdige UI by the name `homebridge-loxone-control`, or manually with `sudo npm install -g homebridge-loxone-control`
4. Just go trough the configuration wizard of the plugin - it will discover all available devices automatically

### Configuration JSON

The plugin allows to control all values that need to be matched with your specific Loxone installation - so it can be used for really _any_ Loxone configuration out there. The `blindsTiming\*` values are there to control how long it takes for a blind to reach 100% in seconds, 3 different types are supported: standart "window", a bigger one "window-big" and "awning". It is also possible to define all available `fanLevels` within your specific ventilation installation.

### Blinds & Awning

```json
"devices": [
    {
        "name": "Livingroom Blinds",
        "identifier": "Wohnzimmer • Beschattung:type=Jalousie:1b2f65ea-0188-97df-ffff3270fa7dbe12"
    }
]
```

```json
"devices": [
    {
      "name": "Loggia Front Blinds",
      "identifier": "Loggia • Beschattung:type=Jalousie:1adc0782-020b-0acb-ffff61be6a4d6391",
      "blindsTiming": "awning"
    }
]
```

| Property     | Description                                                            |
| ------------ | ---------------------------------------------------------------------- |
| name         | The name of the device in HomeKit                                      |
| identifier   | The identifier of the device in Loxone                                 |
| blindsTiming | Which blind timing you want to use: `window`, `window-big` or `awning` |

### Light

```json
"devices": [
    {
      "name": "Kitchen Spot",
      "identifier": "Küche • Beleuchtung:type=Dimmer:1ae00af1-03c7-2aac-ffff4fded8e6fa73"
    }
]
```

| Property   | Description                            |
| ---------- | -------------------------------------- |
| name       | The name of the device in HomeKit      |
| identifier | The identifier of the device in Loxone |

### Outlet

```json
"devices": [
    {
      "name": "Office Plug",
      "identifier": "Wohnzimmer • Beleuchtung:type=Switch:1b2f67f3-01e2-210d-ffff62863f934c70",
      "lightOutlet": true
    }
]
```

| Property    | Description                                 |
| ----------- | ------------------------------------------- |
| name        | The name of the device in HomeKit           |
| identifier  | The identifier of the device in Loxone      |
| lightOutlet | Do you want to handle this light as outlet? |

### Fan

```json
"devices": [
    {
      "name": "Livingroom Fan",
      "identifier": "Wohnzimmer • Lüftung:type=Radio:1adc2790-03a4-5f71-ffff549825251d7a",
      "fanAddButtons": "2,3,6,7"
    }
]
```

### Temperature Sensor

```json
"devices": [
    {
      "name": "Livingroom Temperature",
      "identifier": "Wohnzimmer • Klima:type=InfoOnlyAnalog:1acf23d8-03df-100d-ffff549825251d7a"
    }
]
```

| Property   | Description                            |
| ---------- | -------------------------------------- |
| name       | The name of the device in HomeKit      |
| identifier | The identifier of the device in Loxone |
