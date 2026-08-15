package link.drhub.pagermonitor

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.TimeUnit
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONArray
import org.json.JSONObject

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
 *
 * Auto-listen mode (ACTION_AUTO_WATCH) additionally parses the {"type":"channel_activity"}
 * text broadcasts the same socket receives, and picks/switches which channel to stream
 * entirely on this side — mirroring LiveChannels.jsx's JS auto-listen effect, but able to
 * keep working once the WebView's JS is frozen in the background. JS still owns the
 * "auto-listen is armed" toggle and UI; this only owns the moment-to-moment decision of
 * which channel (if any) to actually be streaming while that toggle is on.
 */
class LiveAudioService : Service() {

    companion object {
        const val CHANNEL_ID = "pm_listening"
        private const val NOTIF_ID = 2001
        private const val SAMPLE_RATE = 16000
        private const val STALL_TIMEOUT_MS = 8000L
        // Mirrors LiveChannels.jsx's AUTO_SWITCH_GRACE_MS — radio chatter often has a few
        // seconds of dead air mid-conversation, not the end of it.
        private const val AUTO_SWITCH_GRACE_MS = 3500L

        const val ACTION_START = "link.drhub.pagermonitor.action.LIVE_AUDIO_START"
        const val ACTION_STOP = "link.drhub.pagermonitor.action.LIVE_AUDIO_STOP"
        const val ACTION_AUTO_WATCH = "link.drhub.pagermonitor.action.LIVE_AUDIO_AUTO_WATCH"
        const val EXTRA_WS_URL = "wsUrl"
        const val EXTRA_CHANNEL_ID = "channelId"
        const val EXTRA_DESCRIPTION = "description"
        const val EXTRA_REST_BASE = "restBase"
        const val EXTRA_TOKEN = "token"
        const val EXTRA_CHANNELS_JSON = "channelsJson"

        // In-process only — the plugin and this service always share one process.
        @Volatile
        var statusListener: ((status: String, message: String?, channelId: Int) -> Unit)? = null

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
    // Muted (not paused) on losing audio focus — e.g. a phone call — so the live relay
    // itself never stalls: incoming frames just get dropped instead of written while
    // muted, rather than blocking AudioTrack.write() on a track that isn't draining.
    private var audioManager: AudioManager? = null
    private var focusRequest: AudioFocusRequest? = null
    @Volatile private var audioMuted = false
    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        when (change) {
            AudioManager.AUDIOFOCUS_GAIN -> audioMuted = false
            AudioManager.AUDIOFOCUS_LOSS,
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> audioMuted = true
        }
    }
    private var channelId: Int = -1 // -1 while auto-watching with nothing currently selected
    private val handler = Handler(Looper.getMainLooper())
    private var watchdog: Runnable? = null
    private var reconnectRunnable: Runnable? = null
    private var reconnectAttempt = 0
    private var lastWsUrl: String? = null
    // Bumped on every connect()/connectAutoWatch()/teardown() — each WebSocketListener
    // closure captures the value current at its creation, and checks it before doing
    // anything. Stopping doesn't synchronously prevent a frame that was already in flight
    // on OkHttp's reader thread from being delivered a moment later; without this guard
    // that stray callback would report state from a session that's already gone.
    @Volatile
    private var sessionId = 0

    // Auto-watch mode state — see class doc.
    private var autoWatch = false
    private var restBase: String? = null
    private var authToken: String? = null
    private var channelOrder: List<Pair<Int, String>> = emptyList() // id -> description, in priority order (first active wins, matches JS's channels.find())
    private val activeSet = mutableSetOf<Int>()
    private var autoGraceRunnable: Runnable? = null

    override fun onBind(intent: Intent?): IBinder? = null

    private fun updateStatus(status: String, message: String? = null) {
        currentStatus = status
        currentChannelId = if (status == "stopped") -1 else channelId
        statusListener?.invoke(status, message, currentChannelId)
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
            ACTION_AUTO_WATCH -> {
                val wsUrl = intent.getStringExtra(EXTRA_WS_URL)
                val base = intent.getStringExtra(EXTRA_REST_BASE)
                val token = intent.getStringExtra(EXTRA_TOKEN)
                val channelsJson = intent.getStringExtra(EXTRA_CHANNELS_JSON)
                if (wsUrl == null || base == null || token == null || channelsJson == null) {
                    stopForeground(STOP_FOREGROUND_REMOVE)
                    stopSelf()
                    return START_NOT_STICKY
                }
                connectAutoWatch(wsUrl, base, token, channelsJson)
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
        cancelAutoGrace()
        autoWatch = false
        releaseAudio()
        socket?.close(1000, null)
        channelId = id
        lastWsUrl = wsUrl
        reconnectAttempt = 0
        sessionId++
        openSocket(wsUrl, id)
    }

    private fun openSocket(wsUrl: String, id: Int) {
        val mySession = sessionId
        updateStatus("connecting")
        client = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build()
        val request = Request.Builder().url(wsUrl).build()
        socket = client!!.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (mySession != sessionId) return
                reconnectAttempt = 0
                webSocket.send("{\"type\":\"listen_start\",\"channelId\":$id}")
                armWatchdog()
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                if (mySession != sessionId) return
                armWatchdog()
                handleFrame(bytes, id)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (mySession != sessionId) return
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
        val mySession = sessionId
        reconnectAttempt++
        val delayMs = minOf(3000L * (1L shl minOf(reconnectAttempt - 1, 4)), 30000L)
        val r = Runnable { if (id == channelId && mySession == sessionId) openSocket(wsUrl, id) }
        reconnectRunnable = r
        handler.postDelayed(r, delayMs)
    }

    private fun cancelReconnect() {
        reconnectRunnable?.let { handler.removeCallbacks(it) }
        reconnectRunnable = null
    }

    // ── Auto-watch mode ─────────────────────────────────────────────────────────────
    // One persistent socket that both receives channel_activity broadcasts (sent to every
    // connected client regardless of what they're listening to) and, once a channel is
    // picked, that channel's PCM frames too — no need for a second connection.

    private fun connectAutoWatch(wsUrl: String, base: String, token: String, channelsJson: String) {
        cancelReconnect()
        cancelAutoGrace()
        releaseAudio()
        socket?.close(1000, null)
        autoWatch = true
        restBase = base
        authToken = token
        channelId = -1
        activeSet.clear()
        channelOrder = parseChannels(channelsJson)
        lastWsUrl = wsUrl
        reconnectAttempt = 0
        sessionId++
        fetchInitialActivity(wsUrl)
    }

    private fun parseChannels(json: String): List<Pair<Int, String>> = try {
        val arr = JSONArray(json)
        (0 until arr.length()).map {
            val o = arr.getJSONObject(it)
            o.getInt("id") to o.optString("description", "Live channel")
        }
    } catch (_: Exception) { emptyList() }

    // channel_activity is edge-triggered server-side (broadcast only on change), so a
    // transition that happens while this socket is (re)connecting would otherwise be
    // missed forever — fetch the real current snapshot first, same fix as the JS side's
    // ws_reconnected resync in useWebSocket.js/LiveChannels.jsx.
    private fun fetchInitialActivity(wsUrl: String) {
        val mySession = sessionId
        val base = restBase
        val tok = authToken
        if (base == null || tok == null) { openWatchSocket(wsUrl); return }
        val httpClient = client ?: OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build().also { client = it }
        val req = Request.Builder()
            .url("$base/api/voice-channels/active")
            .header("Authorization", "Bearer $tok")
            .build()
        httpClient.newCall(req).enqueue(object : Callback {
            override fun onResponse(call: Call, response: Response) {
                if (mySession == sessionId) {
                    try {
                        val obj = JSONObject(response.body?.string() ?: "{}")
                        val keys = obj.keys()
                        val ids = mutableSetOf<Int>()
                        while (keys.hasNext()) keys.next().toIntOrNull()?.let { ids.add(it) }
                        activeSet.clear()
                        activeSet.addAll(ids)
                    } catch (_: Exception) {}
                }
                response.close()
                if (mySession == sessionId) openWatchSocket(wsUrl)
            }
            override fun onFailure(call: Call, e: IOException) {
                // Proceed anyway — future channel_activity broadcasts will still arrive.
                if (mySession == sessionId) openWatchSocket(wsUrl)
            }
        })
    }

    private fun openWatchSocket(wsUrl: String) {
        val mySession = sessionId
        val request = Request.Builder().url(wsUrl).build()
        socket = (client ?: OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build().also { client = it })
            .newWebSocket(request, object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    if (mySession != sessionId) return
                    reconnectAttempt = 0
                    evaluateAutoDecision()
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    if (mySession != sessionId) return
                    try {
                        val obj = JSONObject(text)
                        if (obj.optString("type") == "channel_activity") {
                            val cid = obj.optInt("channelId", -1)
                            if (cid >= 0) {
                                if (obj.optBoolean("active", false)) activeSet.add(cid) else activeSet.remove(cid)
                                evaluateAutoDecision()
                            }
                        }
                    } catch (_: Exception) {}
                }

                override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                    if (mySession != sessionId || channelId < 0) return
                    armWatchdog()
                    handleFrame(bytes, channelId)
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    if (mySession != sessionId) return
                    updateStatus("error", t.message)
                    channelId = -1
                    releaseAudio()
                    scheduleAutoReconnect(wsUrl)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {}
            })
    }

    private fun scheduleAutoReconnect(wsUrl: String) {
        if (!autoWatch) return
        val mySession = sessionId
        reconnectAttempt++
        val delayMs = minOf(3000L * (1L shl minOf(reconnectAttempt - 1, 4)), 30000L)
        val r = Runnable { if (autoWatch && mySession == sessionId) fetchInitialActivity(wsUrl) }
        reconnectRunnable = r
        handler.postDelayed(r, delayMs)
    }

    // Mirrors LiveChannels.jsx's auto-listen effect: stay on the current channel while
    // it's active; on it going quiet, wait out the grace period (re-checking the latest
    // activeSet when it fires, since a lot can change in 3.5s) before switching away or
    // reverting to pure watching; jump straight to an active channel when idle.
    private fun evaluateAutoDecision() {
        if (!autoWatch) return
        if (channelId != -1) {
            if (activeSet.contains(channelId)) { cancelAutoGrace(); return }
            if (autoGraceRunnable == null) {
                val mySession = sessionId
                val r = Runnable {
                    autoGraceRunnable = null
                    if (mySession != sessionId || !autoWatch) return@Runnable
                    if (activeSet.contains(channelId)) return@Runnable // resumed just before firing
                    try { socket?.send("{\"type\":\"listen_stop\",\"channelId\":$channelId}") } catch (_: Exception) {}
                    releaseAudio()
                    channelId = -1
                    updateStatus("stopped")
                    startForegroundNotification("Auto-listen — waiting for activity")
                    val next = channelOrder.firstOrNull { activeSet.contains(it.first) }
                    if (next != null) startChannelOnWatchSocket(next.first)
                }
                autoGraceRunnable = r
                handler.postDelayed(r, AUTO_SWITCH_GRACE_MS)
            }
            return
        }
        val next = channelOrder.firstOrNull { activeSet.contains(it.first) }
        if (next != null) startChannelOnWatchSocket(next.first)
    }

    private fun startChannelOnWatchSocket(id: Int) {
        cancelAutoGrace()
        channelId = id
        val desc = channelOrder.firstOrNull { it.first == id }?.second ?: "Live channel"
        startForegroundNotification(desc)
        updateStatus("connecting")
        try { socket?.send("{\"type\":\"listen_start\",\"channelId\":$id}") } catch (_: Exception) {}
        armWatchdog()
    }

    private fun cancelAutoGrace() {
        autoGraceRunnable?.let { handler.removeCallbacks(it) }
        autoGraceRunnable = null
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
            if (!audioMuted) {
                try { audioTrack?.write(samples, 0, samples.size, AudioTrack.WRITE_BLOCKING) } catch (_: Exception) {}
            }
        }
    }

    private fun requestAudioFocus() {
        if (audioManager != null) return // already held for this playback session
        val am = getSystemService(AudioManager::class.java) ?: return
        val attrs = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()
        // TRANSIENT (not plain GAIN) — signals "brief interruption, give it back after",
        // which is what makes well-behaved music apps (Spotify etc.) auto-resume once we
        // release focus, instead of just staying paused indefinitely.
        val result = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(attrs)
                .setOnAudioFocusChangeListener(focusListener, handler)
                .build()
            focusRequest = req
            am.requestAudioFocus(req)
        } else {
            @Suppress("DEPRECATION")
            am.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        }
        // audioMuted defaults to false and otherwise only flips via the LOSS callback —
        // but if a call is already active when a fresh transmission (re-)requests focus
        // (e.g. after a gap long enough to have released it), the request can be denied
        // outright with no LOSS callback ever firing, since we never held focus to lose.
        // Without this, that case would silently play right through the call.
        audioMuted = result != AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        audioManager = am
    }

    private fun abandonAudioFocus() {
        val am = audioManager ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            focusRequest?.let { am.abandonAudioFocusRequest(it) }
        } else {
            @Suppress("DEPRECATION")
            am.abandonAudioFocus(focusListener)
        }
        audioManager = null
        focusRequest = null
        audioMuted = false
    }

    // Caller must hold audioLock.
    private fun ensureAudioTrackLocked() {
        if (audioTrack != null) return
        requestAudioFocus()
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
    // In auto-watch mode a stall means just that one channel's stream died, not the whole
    // socket — revert to watching and let evaluateAutoDecision() pick a replacement,
    // rather than tearing down and reconnecting the whole thing.
    private fun armWatchdog() {
        watchdog?.let { handler.removeCallbacks(it) }
        val id = channelId
        val mySession = sessionId
        val r = Runnable {
            if (mySession != sessionId) return@Runnable
            try { socket?.send("{\"type\":\"listen_stop\",\"channelId\":$id}") } catch (_: Exception) {}
            releaseAudio()
            if (autoWatch) {
                channelId = -1
                updateStatus("stopped")
                startForegroundNotification("Auto-listen — waiting for activity")
                evaluateAutoDecision()
            } else {
                updateStatus("error", "stalled")
                try { socket?.close(1000, null) } catch (_: Exception) {}
                scheduleReconnect(id)
            }
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
        abandonAudioFocus()
    }

    private fun teardown() {
        cancelReconnect()
        cancelAutoGrace()
        autoWatch = false
        sessionId++ // invalidate any callback still in flight from the session being torn down
        if (channelId >= 0) {
            try { socket?.send("{\"type\":\"listen_stop\",\"channelId\":$channelId}") } catch (_: Exception) {}
        }
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
