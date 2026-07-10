import type { ContactCard } from './types';
import { isHex } from './hex';

/**
 * Contact-card codec. A card is encoded as a `streetcryptid://contact?…` deep link so it
 * can be shared as a QR code or a tappable link. See docs/social/ARCHITECTURE.md §3.
 *
 * Params: e=endpointId, h=handle, s=sigil, n=cryptidName, c=color,
 * r=recvPublic, t=ticket, d=docTicket. The identity metadata is optional so older cards remain valid.
 */

export const CONTACT_SCHEME = 'streetcryptid';
export const CONTACT_PATH = 'contact';

function param(key: string, value: string): string {
  return `${key}=${encodeURIComponent(value)}`;
}

export function encodeContactCard(card: ContactCard): string {
  const parts = [
    param('e', card.endpointId),
    param('h', card.handle),
    param('s', card.sigil),
    param('r', card.recvPublic),
    param('t', card.ticket),
  ];
  if (card.cryptidName) parts.push(param('n', card.cryptidName));
  if (card.color) parts.push(param('c', card.color));
  if (card.docTicket) parts.push(param('d', card.docTicket));
  return `${CONTACT_SCHEME}://${CONTACT_PATH}?${parts.join('&')}`;
}

function parseQuery(input: string): Map<string, string> {
  const q = input.indexOf('?');
  const query = q === -1 ? input : input.slice(q + 1);
  const params = new Map<string, string>();
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawVal = eq === -1 ? '' : pair.slice(eq + 1);
    params.set(decodeURIComponent(rawKey), decodeURIComponent(rawVal));
  }
  return params;
}

export function decodeContactCard(input: string): ContactCard {
  const params = parseQuery(input);
  const endpointId = params.get('e') ?? '';
  const handle = params.get('h') ?? '';
  const sigil = params.get('s') ?? '';
  const cryptidName = params.get('n') ?? '';
  const color = params.get('c') ?? '';
  const recvPublic = params.get('r') ?? '';
  const ticket = params.get('t') ?? '';
  const docTicket = params.get('d') ?? '';

  if (!isHex(endpointId)) throw new Error('contact card: invalid endpointId');
  if (!isHex(recvPublic)) throw new Error('contact card: invalid recvPublic');
  if (!ticket) throw new Error('contact card: missing ticket');
  if (!handle) throw new Error('contact card: missing handle');
  if (color && !/^#[0-9a-f]{6}$/i.test(color)) {
    throw new Error('contact card: invalid color');
  }

  return {
    endpointId,
    handle,
    sigil,
    recvPublic,
    ticket,
    ...(cryptidName ? { cryptidName } : {}),
    ...(color ? { color: color.toUpperCase() } : {}),
    ...(docTicket ? { docTicket } : {}),
  };
}
