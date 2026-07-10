import { createPersistentKV } from '../persistence';
import { createFixOutbox } from './fix-outbox';

/** One process-wide queue instance so enqueue/drain share the same mutex. */
export const backgroundOutbox = createFixOutbox({ kv: createPersistentKV() });
