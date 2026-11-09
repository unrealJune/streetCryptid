import * as iroh from '../generated/napi';
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

const node = new iroh.LocationNode(undefined, undefined);
const me = hex(node.endpointId());

// latency of a sync getter and an async method, to size the FFI overhead
let t = performance.now();
for (let i = 0; i < 2000; i++) node.endpointId();
console.log('sync endpointId(): ', (((performance.now() - t) / 2000) * 1000).toFixed(1), 'us/call');
t = performance.now();
for (let i = 0; i < 200; i++) await node.isStarted();
console.log('async isStarted():  ', (((performance.now() - t) / 200) * 1000).toFixed(1), 'us/call');

// start: no relay, IP only, no BLE (BLE is compiled out on Linux anyway)
t = performance.now();
await node.start([], '', false, true, false);
console.log('start() ->', await node.isStarted(), 'in', (performance.now() - t).toFixed(0), 'ms');
console.log('ticket():', (await node.ticket()).slice(0, 24) + '...');

// a with_foreign listener implemented in TypeScript, handed to Rust
const seen: string[] = [];
const listener: iroh.FixListener = {
  onFix(author, seq, fix, backfill, via, viaPeer) {
    seen.push(`fix seq=${seq} via=${via} ${fix.lat},${fix.lon}`);
  },
  onOpaque(author, seq) {
    seen.push(`opaque seq=${seq}`);
  },
  onStatus(status) {
    seen.push(`status ${status}`);
  },
} as iroh.FixListener;
// ownSubscription takes Option<Arc<dyn FixListener>>: a TS listener inside an Option cannot be
// lowered in ubrn 0.31.0-6 (FfiConverterObjectWithCallbacks lacks writeIntoCursor). subscribe()
// takes the listener as a direct argument, which goes through lower() and works.
const sub = await node.subscribe(iroh.deriveTopic(node.endpointId()), [], listener);
console.log('subscribe(own topic, TS listener) ->', Object.getPrototypeOf(sub).constructor.name);

// recipients: ourselves, so sealing has someone to wrap for
await node.setRecipientKeys([{ endpointId: me, recvPublic: hex(node.recvPublic()) }]);
await node.setSharingRecipients([me], []);

const battery: iroh.BatteryState = { level: 0.9, charging: false, lowPower: false };
const fix: iroh.LocationFix = {
  lat: 35.0116,
  lon: 135.7681,
  accuracyM: 12,
  headingDeg: 90,
  ts: BigInt(Date.now()),
};
t = performance.now();
const out = await sub.ingestFix('own', fix, battery, 300_000n, BigInt(Date.now()));
console.log(
  'ingestFix ->',
  {
    accepted: out.accepted,
    rejection: out.rejection === undefined ? undefined : iroh.FixRejection[out.rejection],
    enqueued: out.enqueued,
    published: out.published,
    reached: out.reached,
    pending: out.pending,
  },
  'in',
  (performance.now() - t).toFixed(0),
  'ms'
);
const stale: iroh.LocationFix = { ...fix, ts: BigInt(Date.now() - 3 * 3600_000) };
const out2 = await sub.ingestFix('own', stale, battery, 300_000n, BigInt(Date.now()));
console.log('ingestFix(stale) ->', {
  accepted: out2.accepted,
  rejection: out2.rejection === undefined ? undefined : iroh.FixRejection[out2.rejection],
});
const hb = await sub.heartbeatFix('own', battery, 300_000n, BigInt(Date.now()), true);
console.log('heartbeatFix(parked) ->', { enqueued: hb.enqueued, published: hb.published });
console.log(
  'takeOwnPublished ->',
  (await node.takeOwnPublished()).map((p) => `seq=${p.seq} state=${p.fix.state}`)
);
console.log('publishWatermarks ->', await node.publishWatermarks());
console.log('lastSealReport ->', await node.lastSealReport());
console.log('listener events:', seen);

await node.shutdown();
node.uniffiDestroy();
console.log('shutdown ok');
process.exit(0);
