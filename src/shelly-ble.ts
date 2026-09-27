/**
 * Shelly Gen2+ RPC over Bluetooth LE (Mongoose OS "rpc-gatts" framing).
 *
 * Request:  write the frame length (uint32 big-endian) to TX_CTL, then the
 *           JSON-RPC frame to DATA in small chunks.
 * Response: poll RX_CTL until it reports a non-zero length (uint32 BE), then
 *           read DATA repeatedly until that many bytes have arrived.
 */

export const RPC_SERVICE = '5f6d4f53-5f52-5043-5f53-56435f49445f'
export const DATA_CHAR = '5f6d4f53-5f52-5043-5f64-6174615f5f5f'
export const TX_CTL_CHAR = '5f6d4f53-5f52-5043-5f74-785f63746c5f'
export const RX_CTL_CHAR = '5f6d4f53-5f52-5043-5f72-785f63746c5f'

/** Safe for the minimum BLE MTU (23 bytes minus 3 bytes of ATT header). */
const CHUNK = 20
const POLL_MS = 50
const TIMEOUT_MS = 8000

/** The subset of BluetoothRemoteGATTCharacteristic this module relies on. */
export interface Characteristic {
  readValue(): Promise<DataView>
  writeValueWithResponse(value: BufferSource): Promise<void>
}

export interface SwitchStatus {
  id: number
  output: boolean
  apower?: number
  voltage?: number
  temperature?: { tC: number; tF: number }
}

export interface DeviceInfo {
  id: string
  name: string | null
  model: string
  gen: number
  ver: string
  auth_en: boolean
}

export class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class ShellyRpc {
  private nextId = 1
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private data: Characteristic,
    private txCtl: Characteristic,
    private rxCtl: Characteristic,
  ) {}

  /** Calls are serialized: a GATT server handles one operation at a time. */
  call<T>(method: string, params?: object): Promise<T> {
    const run = this.queue.then(() => this.send<T>(method, params))
    this.queue = run.catch(() => undefined)
    return run
  }

  private async send<T>(method: string, params?: object): Promise<T> {
    const id = this.nextId++
    const frame = new TextEncoder().encode(
      JSON.stringify({ id, src: 'smartplug-webapp', method, params }),
    )

    const length = new DataView(new ArrayBuffer(4))
    length.setUint32(0, frame.length)
    await this.txCtl.writeValueWithResponse(length)
    for (let i = 0; i < frame.length; i += CHUNK) {
      await this.data.writeValueWithResponse(frame.slice(i, i + CHUNK))
    }

    let expected = 0
    for (const deadline = Date.now() + TIMEOUT_MS; !expected; await sleep(POLL_MS)) {
      if (Date.now() > deadline) throw new RpcError(-1, `${method} timed out`)
      expected = (await this.rxCtl.readValue()).getUint32(0)
    }

    const response = new Uint8Array(expected)
    for (let got = 0; got < expected; ) {
      const chunk = await this.data.readValue()
      if (!chunk.byteLength) throw new RpcError(-1, `${method} response truncated`)
      response.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), got)
      got += chunk.byteLength
    }

    const reply = JSON.parse(new TextDecoder().decode(response))
    if (reply.error) throw new RpcError(reply.error.code, reply.error.message)
    return reply.result as T
  }

  getDeviceInfo() {
    return this.call<DeviceInfo>('Shelly.GetDeviceInfo')
  }

  getSwitch(id = 0) {
    return this.call<SwitchStatus>('Switch.GetStatus', { id })
  }

  setSwitch(on: boolean, id = 0) {
    return this.call<{ was_on: boolean }>('Switch.Set', { id, on })
  }
}

export const bluetoothAvailable = () => 'bluetooth' in navigator

/** Opens the browser's device chooser and connects to the picked Shelly. */
export async function requestShelly(): Promise<BluetoothDevice> {
  // Shellies advertise their name ("Shelly1PMMiniG4-<MAC>") but not the RPC
  // service UUID, so filter by name and ask for the service separately.
  return navigator.bluetooth.requestDevice({
    filters: [{ namePrefix: 'Shelly' }],
    optionalServices: [RPC_SERVICE],
  })
}

export async function connectShelly(device: BluetoothDevice): Promise<ShellyRpc> {
  const server = await device.gatt!.connect()
  const service = await server.getPrimaryService(RPC_SERVICE)
  const [data, txCtl, rxCtl] = await Promise.all(
    [DATA_CHAR, TX_CTL_CHAR, RX_CTL_CHAR].map((uuid) => service.getCharacteristic(uuid)),
  )
  return new ShellyRpc(data, txCtl, rxCtl)
}
