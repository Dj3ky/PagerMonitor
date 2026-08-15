package link.drhub.pagermonitor

import android.content.Intent
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

// Thin JS<->native bridge — all the actual work happens in LiveAudioService, which keeps
// running regardless of what state the WebView's JS is in (see its class doc for why).
@CapacitorPlugin(name = "LiveAudio")
class LiveAudioPlugin : Plugin() {

    override fun load() {
        LiveAudioService.statusListener = { status, message, channelId ->
            val data = JSObject()
            data.put("status", status)
            data.put("channelId", channelId)
            if (message != null) data.put("message", message)
            notifyListeners("statusChange", data)
        }
    }

    @PluginMethod
    fun start(call: PluginCall) {
        val wsUrl = call.getString("wsUrl")
        val channelId = call.getInt("channelId")
        if (wsUrl == null || channelId == null) {
            call.reject("wsUrl and channelId are required")
            return
        }
        val intent = Intent(context, LiveAudioService::class.java).apply {
            action = LiveAudioService.ACTION_START
            putExtra(LiveAudioService.EXTRA_WS_URL, wsUrl)
            putExtra(LiveAudioService.EXTRA_CHANNEL_ID, channelId)
            putExtra(LiveAudioService.EXTRA_DESCRIPTION, call.getString("description") ?: "Live channel")
        }
        context.startForegroundService(intent)
        call.resolve()
    }

    // Hands the auto-listen "which channel (if any) should be playing" decision to the
    // native service, so it keeps working once the WebView's JS is frozen in the
    // background — see LiveAudioService's class doc.
    @PluginMethod
    fun startAuto(call: PluginCall) {
        val wsUrl = call.getString("wsUrl")
        val restBase = call.getString("restBase")
        val token = call.getString("token")
        val channelsJson = call.getString("channelsJson")
        if (wsUrl == null || restBase == null || token == null || channelsJson == null) {
            call.reject("wsUrl, restBase, token, and channelsJson are required")
            return
        }
        val intent = Intent(context, LiveAudioService::class.java).apply {
            action = LiveAudioService.ACTION_AUTO_WATCH
            putExtra(LiveAudioService.EXTRA_WS_URL, wsUrl)
            putExtra(LiveAudioService.EXTRA_REST_BASE, restBase)
            putExtra(LiveAudioService.EXTRA_TOKEN, token)
            putExtra(LiveAudioService.EXTRA_CHANNELS_JSON, channelsJson)
            putExtra(LiveAudioService.EXTRA_DESCRIPTION, "Auto-listen — waiting for activity")
        }
        context.startForegroundService(intent)
        call.resolve()
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        val intent = Intent(context, LiveAudioService::class.java).apply {
            action = LiveAudioService.ACTION_STOP
        }
        // Every start of this service now always promotes to foreground (see
        // LiveAudioService.onStartCommand), so this must go through the same
        // startForegroundService() entry point as start() — not plain startService().
        context.startForegroundService(intent)
        call.resolve()
    }

    // Lets a freshly (re)opened app ask what the background service is already doing,
    // instead of showing a status with no channel attached to it.
    @PluginMethod
    fun getStatus(call: PluginCall) {
        val ret = JSObject()
        ret.put("status", LiveAudioService.currentStatus)
        ret.put("channelId", LiveAudioService.currentChannelId)
        call.resolve(ret)
    }
}
