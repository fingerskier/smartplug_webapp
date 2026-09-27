import { describe, expect, it } from 'vitest'
import { RpcError, ShellyRpc, type Characteristic } from './shelly-ble'

/** A fake Shelly RPC GATT service that answers with `respond(request)`. */
function fakeShelly(respond: (request: any) => object, readChunk = 20, pendingPolls = 2) {
  const log = { txCtl: [] as number[], requests: [] as any[] }
  let incoming: number[] = []
  let expected = 0
  let outgoing = new Uint8Array()
  let polls = 0

  const bytes = (value: BufferSource) =>
    value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)

  const txCtl: Characteristic = {
    async readValue() {
      throw new Error('not readable')
    },
    async writeValueWithResponse(value) {
      expected = new DataView(bytes(value).slice().buffer).getUint32(0)
      log.txCtl.push(expected)
      incoming = []
    },
  }

  const data: Characteristic = {
    async readValue() {
      const chunk = outgoing.slice(0, readChunk)
      outgoing = outgoing.slice(readChunk)
      return new DataView(chunk.buffer)
    },
    async writeValueWithResponse(value) {
      const chunk = bytes(value)
      expect(chunk.length).toBeLessThanOrEqual(20)
      incoming.push(...chunk)
      if (incoming.length === expected) {
        const request = JSON.parse(new TextDecoder().decode(new Uint8Array(incoming)))
        log.requests.push(request)
        outgoing = new TextEncoder().encode(JSON.stringify({ id: request.id, ...respond(request) }))
        polls = 0
      }
    },
  }

  const rxCtl: Characteristic = {
    async readValue() {
      const view = new DataView(new ArrayBuffer(4))
      view.setUint32(0, polls++ < pendingPolls ? 0 : outgoing.length)
      return view
    },
    async writeValueWithResponse() {
      throw new Error('not writable')
    },
  }

  return { rpc: new ShellyRpc(data, txCtl, rxCtl), log }
}

describe('ShellyRpc', () => {
  it('frames the request and reassembles a chunked response', async () => {
    const { rpc, log } = fakeShelly(() => ({
      result: { id: 0, output: true, apower: 12.5, note: 'x'.repeat(100) },
    }))

    const status = await rpc.getSwitch()

    expect(status.output).toBe(true)
    expect(log.requests[0]).toMatchObject({ method: 'Switch.GetStatus', params: { id: 0 } })
    expect(log.txCtl[0]).toBe(new TextEncoder().encode(JSON.stringify(log.requests[0])).length)
  })

  it('sends Switch.Set with the requested state', async () => {
    const { rpc, log } = fakeShelly(() => ({ result: { was_on: false } }))

    await rpc.setSwitch(true)

    expect(log.requests[0]).toMatchObject({ method: 'Switch.Set', params: { id: 0, on: true } })
  })

  it('serializes concurrent calls', async () => {
    const { rpc, log } = fakeShelly((req) => ({ result: { method: req.method } }))

    const results = await Promise.all([
      rpc.call<{ method: string }>('A'),
      rpc.call<{ method: string }>('B'),
      rpc.call<{ method: string }>('C'),
    ])

    expect(results.map((r) => r.method)).toEqual(['A', 'B', 'C'])
    expect(log.requests.map((r) => r.method)).toEqual(['A', 'B', 'C'])
  })

  it('surfaces RPC errors', async () => {
    const { rpc } = fakeShelly(() => ({ error: { code: 401, message: 'Unauthorized' } }))

    await expect(rpc.getDeviceInfo()).rejects.toEqual(new RpcError(401, 'Unauthorized'))
  })

  it('keeps working after a failed call', async () => {
    let fail = true
    const { rpc } = fakeShelly(() =>
      fail ? ((fail = false), { error: { code: -103, message: 'busy' } }) : { result: { ok: 1 } },
    )

    await expect(rpc.call('X')).rejects.toBeInstanceOf(RpcError)
    await expect(rpc.call('Y')).resolves.toEqual({ ok: 1 })
  })
})
