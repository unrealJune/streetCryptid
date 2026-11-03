package org.jakebot.blew

import android.bluetooth.BluetoothSocket
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * Shared L2CAP socket management used by both [BleCentralManager] and [BlePeripheralManager].
 *
 * Handles socket registration, read loops, writes, and closes. JNI callbacks
 * (channel data, channel closed) are forwarded via the provided lambdas so each
 * manager routes to its own `external fun` declarations.
 *
 * @param startId  Starting socket ID. Central and peripheral use non-overlapping
 *                 ranges (1 vs 100 000) to avoid collisions in the shared Rust-side state.
 */
class L2capSocketManager(
    private val tag: String,
    private val onData: (socketId: Int, data: ByteArray) -> Unit,
    private val onClosed: (socketId: Int, error: String?) -> Unit,
    startId: Int = 1,
) {
    private val sockets = ConcurrentHashMap<Int, BluetoothSocket>()
    private val nextId = AtomicInteger(startId)

    /**
     * One monitor per socket, so concurrent writers cannot interleave partial
     * payloads on the same stream. blew's own outbound path is already serial
     * per channel, but [write] is reachable from anywhere and a close can race
     * a write.
     */
    private val writeLocks = ConcurrentHashMap<Int, Any>()

    /**
     * Blocking socket reads live here rather than on raw threads.
     * `BluetoothSocket` exposes only blocking `InputStream`/`OutputStream`, so
     * a blocking read per channel is unavoidable; what is avoidable is creating
     * an unbounded number of unmanaged threads to host them.
     */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** Size of each read against the socket, from `L2capConfig::read_chunk_size`. */
    @Volatile
    var readBufferSize: Int = DEFAULT_READ_BUFFER_SIZE
        set(value) {
            field = if (value > 0) value else DEFAULT_READ_BUFFER_SIZE
        }

    fun register(socket: BluetoothSocket): Int {
        val id = nextId.getAndIncrement()
        sockets[id] = socket
        writeLocks[id] = Any()
        return id
    }

    /** Run [socketId]'s blocking read loop on the shared IO dispatcher. */
    fun startReadLoopAsync(
        socketId: Int,
        deviceAddr: String,
        socket: BluetoothSocket,
    ) {
        scope.launch { startReadLoop(socketId, deviceAddr, socket) }
    }

    fun write(
        socketId: Int,
        data: ByteArray,
    ) {
        val socket = sockets[socketId] ?: return
        val lock = writeLocks[socketId] ?: return
        try {
            synchronized(lock) {
                socket.outputStream.write(data)
                socket.outputStream.flush()
            }
        } catch (e: Exception) {
            Log.e(tag, "L2CAP write failed (socket $socketId): ${e.message}")
            close(socketId, e.message ?: "write failed")
        }
    }

    /**
     * Close [socketId], reporting [error] when the channel is ending because
     * something went wrong rather than because either side asked it to.
     *
     * Idempotent: the first caller wins, so a deliberate close followed by the
     * read loop noticing the socket died reports the deliberate close.
     */
    @JvmOverloads
    fun close(
        socketId: Int,
        error: String? = null,
    ) {
        val socket = sockets.remove(socketId) ?: return
        writeLocks.remove(socketId)
        try {
            socket.close()
        } catch (_: Exception) {
        }
        onClosed(socketId, error)
    }

    fun startReadLoop(
        socketId: Int,
        deviceAddr: String,
        socket: BluetoothSocket,
    ) {
        val buf = ByteArray(readBufferSize)
        var failure: String? = null
        try {
            val input = socket.inputStream
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                onData(socketId, buf.copyOf(n))
            }
        } catch (e: Exception) {
            Log.d(tag, "L2CAP read ended (socket $socketId): ${e.message}")
            // Closing a BluetoothSocket makes the blocking read throw. If the
            // socket is already deregistered this exception is the consequence
            // of a deliberate close, not a transport failure, and reporting it
            // as one would turn every ordinary close into an error.
            failure = if (sockets.containsKey(socketId)) e.message ?: "read failed" else null
        }
        close(socketId, failure)
    }

    private companion object {
        const val DEFAULT_READ_BUFFER_SIZE = 4096
    }
}
