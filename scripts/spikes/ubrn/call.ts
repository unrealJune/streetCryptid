import * as iroh from '../generated/napi';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

console.log('exports:', Object.keys(iroh).length);

// 1. pure functions
const [recvSecret, recvPublic] = iroh.generateRecvKeypair();
console.log(
  'generateRecvKeypair ->',
  recvSecret.length,
  'bytes secret,',
  recvPublic.length,
  'bytes public'
);
const topic = iroh.deriveTopic(recvPublic);
console.log('deriveTopic ->', hex(topic).slice(0, 16), '...', topic.length, 'bytes');

// 2. error mapping: a bad ticket must throw a typed LocationError
try {
  iroh.endpointIdFromTicket('not-a-ticket');
  console.log('endpointIdFromTicket: NO THROW (unexpected)');
} catch (e: any) {
  console.log('endpointIdFromTicket threw:', {
    isLocationError: iroh.LocationError.instanceOf(e),
    isDecode: iroh.LocationError.Decode.instanceOf(e),
    tag: e.tag,
    tagName: iroh.LocationError_Tags[e.tag as iroh.LocationError_Tags],
    inner: e.inner,
    message: e.message,
  });
}

// 3. record round trip through Rust
const invite: iroh.PairInvite = {
  version: 2,
  inviteId: new Uint8Array(16).fill(7),
  secret: new Uint8Array(32).fill(9),
  endpointId: new Uint8Array(32).fill(1),
  endpointTicket: '',
  expiresAtMs: 1_700_000_000_000n,
};
try {
  const token = iroh.encodePairInvite(invite);
  const back = iroh.decodePairInvite(token);
  console.log(
    'pair invite round trip:',
    token.slice(0, 12) + '...',
    'expiresAtMs =',
    back.expiresAtMs,
    typeof back.expiresAtMs,
    'inviteId ok =',
    hex(back.inviteId) === hex(invite.inviteId)
  );
} catch (e: any) {
  console.log('pair invite:', e.message);
}

// 4. an object: construct a LocationNode (no network), read identity getters
const node = new iroh.LocationNode(undefined, undefined);
console.log(
  'LocationNode constructed; endpointId =',
  hex(node.endpointId()).slice(0, 16) + '...',
  'recvPublic len =',
  node.recvPublic().length
);
const started = await node.isStarted();
console.log('isStarted() ->', started);
try {
  await node.ticket();
  console.log('ticket(): NO THROW (unexpected)');
} catch (e: any) {
  console.log(
    'ticket() before start threw:',
    iroh.LocationError.NotStarted.instanceOf(e) ? 'LocationError.NotStarted' : e.message
  );
}
node.uniffiDestroy();
console.log('done');
