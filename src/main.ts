import { registerSW } from 'virtual:pwa-register'
import { bluetoothAvailable, connectShelly, requestShelly, type ShellyRpc } from './shelly-ble'
import './style.css'

registerSW({ immediate: true })

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const statusEl = $<HTMLParagraphElement>('status')
const powerBtn = $<HTMLButtonElement>('power')
const powerLabel = $<HTMLSpanElement>('power-label')
const connectBtn = $<HTMLButtonElement>('connect')
const messageEl = $<HTMLParagraphElement>('message')

const POLL_MS = 3000

let device: BluetoothDevice | undefined
let rpc: ShellyRpc | undefined
let on = false
let busy = false
let pollTimer: number | undefined

function say(text = '') {
  messageEl.textContent = text
  messageEl.hidden = !text
}

function render() {
  const connected = !!rpc
  powerBtn.disabled = !connected || busy
  powerBtn.setAttribute('aria-pressed', String(on))
  powerBtn.classList.toggle('on', connected && on)
  powerLabel.textContent = on ? 'On' : 'Off'
  connectBtn.disabled = busy
  connectBtn.textContent = connected ? 'Disconnect' : device ? 'Reconnect' : 'Connect'
}

function describe(error: unknown) {
  if (error instanceof DOMException && error.name === 'NotFoundError') return ''
  const detail = error instanceof Error ? error.message : String(error)
  return `Couldn't reach the plug (${detail}). Make sure it's powered and nearby. If it still fails, unplug it for a few seconds, plug it back in, and try again.`
}

async function refresh() {
  if (!rpc || busy) return
  try {
    on = (await rpc.getSwitch()).output
    render()
  } catch {
    // A dropped link is reported through gattserverdisconnected.
  }
}

function startPolling() {
  stopPolling()
  pollTimer = window.setInterval(() => {
    if (document.visibilityState === 'visible') void refresh()
  }, POLL_MS)
}

function stopPolling() {
  window.clearInterval(pollTimer)
  pollTimer = undefined
}

function onDisconnected() {
  rpc = undefined
  stopPolling()
  statusEl.textContent = `Disconnected from ${device?.name ?? 'plug'}`
  render()
}

async function connect() {
  busy = true
  say()
  render()
  try {
    if (!device) {
      device = await requestShelly()
      device.addEventListener('gattserverdisconnected', onDisconnected)
    }
    statusEl.textContent = `Connecting to ${device.name ?? 'plug'}…`
    rpc = await connectShelly(device)
    const info = await rpc.getDeviceInfo()
    on = (await rpc.getSwitch()).output
    statusEl.textContent = `Connected to ${info.name ?? device.name ?? info.id}`
    startPolling()
  } catch (error) {
    // Forget a device that won't connect so the next tap opens the chooser.
    device?.gatt?.disconnect()
    device?.removeEventListener('gattserverdisconnected', onDisconnected)
    device = undefined
    rpc = undefined
    statusEl.textContent = 'Not connected'
    say(describe(error))
  } finally {
    busy = false
    render()
  }
}

async function toggle() {
  if (!rpc) return
  busy = true
  say()
  render()
  try {
    await rpc.setSwitch(!on)
    on = !on
  } catch (error) {
    say(describe(error))
  } finally {
    busy = false
    render()
  }
}

connectBtn.addEventListener('click', () => {
  if (rpc) device?.gatt?.disconnect()
  else void connect()
})
powerBtn.addEventListener('click', () => void toggle())
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void refresh()
})

if (!bluetoothAvailable()) {
  connectBtn.disabled = true
  statusEl.textContent = 'Bluetooth unavailable'
  say(
    window.isSecureContext
      ? 'This browser can’t use Bluetooth. Use Chrome or Edge on Android, Windows, macOS or ChromeOS. On iPhone or iPad, open this page in the Bluefy browser.'
      : 'Bluetooth needs a secure (https) connection.',
  )
} else {
  render()
}
