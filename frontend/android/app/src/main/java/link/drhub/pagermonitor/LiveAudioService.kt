package link.drhub.pagermonitor

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString

/**
 * Plays a live voice channel via its own WebSocket connection, entirely independent of
 * the WebView's JavaScript. This exists because Chrome/WebView freezes a backgrounded
 * page's JS after a few minutes (Page Lifecycle "freeze"), which silently killed audio
 * even with a foreground service keeping the *process* alive — the process staying alive
 * doesn't stop the renderer from freezing that specific page's JS. Running here instead,
 * on a plain background thread owned by an Android Service, isn't subject to that at all.
 *
 * Wire format matches services/audioRelay.js on the backend exactly: connect to /ws with
 * the same bearer token as everything else, send {"type":"listen_start","channelId":N},
 * then receive binary frames of a 4-byte little-endian channel id followed by raw 32-bit
 * float mono PCM at 16kHz.
 */
class LiveAudioService : Service() {

    companion object {
        const val CHANNEL_ID = "pm_listening"
        private const val NOTIF_ID = 2001
        private const val SAMPLE_RATE = 16000
        private const val STALL_TIMEOUT_MS = 8000L

        const val ACTION_START = "link.drhub.pagermonitor.action.LIVE_AUDIO_START"
        const val ACTION_STOP = "link.drhub.pagermonitor.action.LIVE_AUDIO_STOP"
        const val EXTRA_WS_URL = "wsUrl"
        const val EXTRA_CHANNEL_ID = "channelId"
        const val EXTRA_DESCRIPTION = "description"

        // In-process only — the plugin and this service always share one process.
        @Volatile
        var statusListener: ((status: String, message: String?) -> Unit)? = null

        // Lets a freshly-mounted JS side (app reopened while this service was already
        // running in the background) ask "what are you currently doing" via the plugin's
        // getStatus(), instead of showing a status with no channel to attach it to.
        @Volatile
        var currentStatus: String = "stopped"
        @Volatile
        var currentChannelId: Int = -1
    }

    private var client: OkHttpClient? = null
    private var socket: WebSocket? = null
    private var audioTrack: AudioTrack? = null
    // handleFrame()/ensureAudioTrack() run on OkHttp's WebSocket-reader thread, while
    // releaseAudio() can fire on the main thread at any moment (watchdog timeout, a
    // channel switch, explicit stop) — without this, release() on one thread can pull
    // the native AudioTrack out from under a write() call in flight on the other,
    // segfaulting the whole process. Every access to audioTrack must go through this lock.
    private val audioLock = Any()
    private var channelId: Int = -1
    private val handler = Handler(Looper.getMainLooper())
    private var watchdog: Runnable? = null
    private var reconnectRunnable: Runnable? = null
    private var reconnectAttempt = 0
    private var lastWsUrl: String? = null
    // Bumped on every connect()/teardown() — each WebSocketListener closure captures the
    // value current at its creation, and checks it before doing anything. Stopping doesn't
    // synchronously prevent a frame that was already in flight on OkHttp's reader thread
    // from being delivered a moment later; without this guard that stray callback would
    // report "playing" (with no channel id, since JS already cleared it) right after the
    // "stopped" status teardown() just sent, flickering the icon back on for no reason.
    @Volatile
    private var sessionId = 0

    override fun onBind(intent: Intent?): IBinder? = null

    private fun updateStatus(status: String, message: String? = null) {
        currentStatus = status
        currentChannelId = if (status == "stopped") -1 else channelId
        statusListener?.invoke(status, message)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Every start of this service — regardless of action — must promote to foreground
        // immediately, or Android kills the whole app with ForegroundServiceDidNotStartInTimeException.
        // This matters even for ACTION_STOP: play() resets any prior session by calling stop()
        // first, so a stop-then-start pair issued back-to-back means this service can receive
        // a STOP intent as its very first (and only) onStartCommand call — which previously
        // tore itself down without ever satisfying that obligation. Once a Service class is
        // declared with a foregroundServiceType in the manifest, Android enforces this for
        // any start of it, not just ones that intend to actually stay foregrounded.
        startForegroundNotification(intent?.getStringExtra(EXTRA_DESCRIPTION) ?: "Live channel")

        when (intent?.action) {
            ACTION_START -> {
                val wsUrl = intent.getStringExtra(EXTRA_WS_URL)
                val id = intent.getIntExtra(EXTRA_CHANNEL_ID, -1)
                if (wsUrl == null || id < 0) {
                    stopForeground(STOP_FOREGROUND_REMOVE)
                    stopSelf()
                    return START_NOT_STICKY
                }
                connect(wsUrl, id)
            }
            else -> {
                teardown()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
        return START_NOT_STICKY
    }

    private fun startForegroundNotification(description: String) {
        val nm = getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            val channel = NotificationChannel(CHANNEL_ID, "Live listening", NotificationManager.IMPORTANCE_LOW)
            channel.description = "Shown while a voice channel is playing"
            nm.createNotificationChannel(channel)
        }

        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("📟 PagerMonitor")
            .setContentText("Listening: $description")
            .setSmallIcon(R.drawable.ic_stat_pager)
            .setOngoing(true)
            .setSilent(true)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        } else {
            startForeground(NOTIF_ID, notification)
        }
    }

    private fun connect(wsUrl: String, id: Int) {
        cancelReconnect()
        releaseAudio()
        socket?.close(1000, null)
        channelId = id
        lastWsUrl = wsUrl
        reconnectAttempt = 0
        openSocket(wsUrl, id)
    }

    private fun openSocket(wsUrl: String, id: Int) {
        updateStatus("connecting")
        client = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build()
        val request = Request.Builder().url(wsUrl).build()
        socket = client!!.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                reconnectAttempt = 0
                webSocket.send("{\"type\":\"listen_start\",\"channelId\":$id}")
                armWatchdog()
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                armWatchdog()
                handleFrame(bytes, id)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                updateStatus("error", t.message)
                releaseAudio()
                scheduleReconnect(id)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                // Explicit stop() already reports its own status — nothing to do here.
            }
        })
    }

    // A WiFi<->mobile-data handover (or any transient drop) kills the socket with no
    // help from us — without this, the channel just sits on "error" forever until the
    // user manually retries. Backoff caps at 30s; retries indefinitely, matching the
    // main app's own WebSocket reconnect policy (useWebSocket.js) rather than giving up.
    private fun scheduleReconnect(id: Int) {
        val wsUrl = lastWsUrl ?: return
        if (id != channelId) return // superseded by a channel switch — let that own the socket
        reconnectAttempt++
        val delayMs = minOf(3000L * (1L shl minOf(reconnectAttempt - 1, 4)), 30000L)
        val r = Runnable { if (id == channelId) openSocket(wsUrl, id) }
        reconnectRunnable = r
        handler.postDelayed(r, delayMs)
    }

    private fun cancelReconnect() {
        reconnectRunnable?.let { handler.removeCallbacks(it) }
        reconnectRunnable = null
    }

    private fun handleFrame(bytes: ByteString, expectedChannelId: Int) {
        val buf = ByteBuffer.wrap(bytes.toByteArray()).order(ByteOrder.LITTLE_ENDIAN)
        if (buf.remaining() < 4) return
        val frameChannelId = buf.int
        if (frameChannelId != expectedChannelId) return
        val floatCount = buf.remaining() / 4
        if (floatCount <= 0) return

        val samples = FloatArray(floatCount)
        buf.asFloatBuffer().get(samples)
        if (currentStatus != "playing") updateStatus("playing")
        synchronized(audioLock) {
            ensureAudioTrackLocked()
            try { audioTrack?.write(samples, 0, samples.size, AudioTrack.WRITE_BLOCKING) } catch (_: Exception) {}
        }
    }

    // Caller must hold audioLock.
    private fun ensureAudioTrackLocked() {
        if (audioTrack != null) return
        val format = AudioFormat.Builder()
            .setSampleRate(SAMPLE_RATE)
            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
            .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
            .build()
        val minBuf = AudioTrack.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_FLOAT)
        val attrs = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()
        audioTrack = AudioTrack.Builder()
            .setAudioAttributes(attrs)
            .setAudioFormat(format)
            .setBufferSizeInBytes(maxOf(minBuf, 1) * 2)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
        audioTrack?.play()
    }

    // Re-armed on every frame — a healthy channel is continuous=true server-side (always
    // sending, even through real RF silence), so a stall this long means the source
    // actually died, not just a quiet moment. Mirrors the web player's identical watchdog.
    private fun armWatchdog() {
        watchdog?.let { handler.removeCallbacks(it) }
        val id = channelId
        val r = Runnable {
            updateStatus("error", "stalled")
            try { socket?.send("{\"type\":\"listen_stop\",\"channelId\":$id}") } catch (_: Exception) {}
            try { socket?.close(1000, null) } catch (_: Exception) {}
            releaseAudio()
            scheduleReconnect(id)
        }
        watchdog = r
        handler.postDelayed(r, STALL_TIMEOUT_MS)
    }

    private fun releaseAudio() {
        watchdog?.let { handler.removeCallbacks(it) }
        watchdog = null
        synchronized(audioLock) {
            try { audioTrack?.stop() } catch (_: Exception) {}
            try { audioTrack?.release() } catch (_: Exception) {}
            audioTrack = null
        }
    }

    private fun teardown() {
        cancelReconnect()
        try { socket?.send("{\"type\":\"listen_stop\",\"channelId\":$channelId}") } catch (_: Exception) {}
        try { socket?.close(1000, null) } catch (_: Exception) {}
        socket = null
        client?.dispatcher?.executorService?.shutdown()
        client = null
        releaseAudio()
        updateStatus("stopped")
    }

    override fun onDestroy() {
        teardown()
        super.onDestroy()
    }
}
