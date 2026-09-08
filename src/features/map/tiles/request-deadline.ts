/**
 * Bounds headers AND body consumption. Aborting native fetch is best-effort:
 * rejecting our own deadline also releases shared in-flight cache entries when
 * the native request never settles.
 */
export async function withRequestDeadline<T>(
  request: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<T> {
  if (signal?.aborted) throw requestError('AbortError', 'Aborted');

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    const cancel = (error: Error) => {
      reject(error);
      controller.abort();
    };
    onAbort = () => cancel(requestError('AbortError', 'Aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(
      () => cancel(requestError('TimeoutError', `Tile request timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
  });

  try {
    return await Promise.race([request(controller.signal), cancelled]);
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

function requestError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}
