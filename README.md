# PBM Plug

An installable web app (PWA) that switches a **Shelly 1PM Mini Gen4** relay on and off over **Bluetooth**. No Wi-Fi setup, cloud account or Shelly app needed.

Live: https://fingerskier.github.io/smartplug_webapp/ (deployed from `main` by GitHub Actions)

## Using it

1. Open the app in a browser with Web Bluetooth: Chrome or Edge on Android, Windows, macOS or ChromeOS. On iPhone or iPad, use the Bluefy browser from the App Store, because Safari has no Web Bluetooth.
2. Tap **Connect** and pick `Shelly1PMMiniG4-…` from the list.
3. Tap the big button to switch the relay on or off.

Use the browser's "Install app" / "Add to Home screen" to get an app icon. The shell works offline; only the Bluetooth link is needed.

## How it talks to the Shelly

Shelly Gen2+ devices expose their JSON-RPC API over a BLE GATT service (Mongoose OS `rpc-gatts` framing), implemented in `src/shelly-ble.ts`:

| Characteristic | UUID | Role |
|---|---|---|
| service | `5f6d4f53-5f52-5043-5f53-56435f49445f` | RPC service |
| tx_ctl | `5f6d4f53-5f52-5043-5f74-785f63746c5f` | write request length (uint32 big-endian) |
| data | `5f6d4f53-5f52-5043-5f64-6174615f5f5f` | write request JSON in ≤20-byte chunks, read response chunks |
| rx_ctl | `5f6d4f53-5f52-5043-5f72-785f63746c5f` | read response length (uint32 BE; 0 until ready) |

The app calls `Shelly.GetDeviceInfo`, `Switch.GetStatus {id:0}` and `Switch.Set {id:0, on}`, and refreshes the status every 3 s while visible, so it notices changes made at the device.

The device advertises its name but not the RPC service UUID, so the chooser filters on `namePrefix: "Shelly"`.

### Why not Wi-Fi?

The device's local HTTP API (`http://192.168.33.1/rpc/...`) is plain HTTP. An HTTPS page such as GitHub Pages can't call it, because browsers block mixed content. Bluetooth avoids this and needs no network setup.

### Firmware caveat

This was verified on firmware `1.5.99-g4prod1`, where BLE RPC is always open and unauthenticated. Shelly firmware **2.0.0+** adds "secure provisioning". There, BLE RPC is open only in a 15-minute window after power-up (5 minutes after the device first goes online), and after that it needs BLE pairing. If a device on newer firmware refuses to connect, power-cycle it and connect within the window. Leave the plugs off Wi-Fi so they don't auto-update, or add a pairing step to the app.

## Development

```sh
npm install
npm run dev      # http://localhost:5173 (localhost counts as a secure context for Bluetooth)
npm test         # RPC framing unit tests
npm run build    # type-check + production build to dist/
```

The Node version in CI is 24. `BASE_PATH` sets the URL prefix for the build; the deploy workflow sets it to `/<repo-name>/`.

## Deployment

`.github/workflows/deploy.yml` runs the tests and build on every PR and push. Pushes to `main` also deploy `dist/` to GitHub Pages. One-time setup: **Settings → Pages → Source: GitHub Actions**. Pages on a private repo needs a GitHub plan that allows it.
