package link.drhub.pagermonitor

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import android.content.Context
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.provider.Settings
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

// The "alert" notification tier (user_notif_prefs.alert_* — see fanout.js/fcmPush.js's
// sendAlertPerUser) needs two things the standard @capacitor/push-notifications plugin's
// createChannel() can't do: a channel that requests to bypass Do Not Disturb, and the
// system's stock alarm tone instead of the regular notification chime. Neither is exposed
// by that plugin's Channel API, hence this small dedicated one.
@CapacitorPlugin(name = "AlertChannel")
class AlertChannelPlugin : Plugin() {
    companion object {
        const val CHANNEL_ID = "pm_alert"
    }

    override fun load() {
        createChannel(context)
    }

    private fun createChannel(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        // Channel settings (sound, bypassDnd, importance) are locked by Android the first
        // time a channel id is created on a given install — this only takes effect once.
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return

        val soundUri = RingtoneManager.getActualDefaultRingtoneUri(context, RingtoneManager.TYPE_ALARM)
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
        val audioAttrs = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM) // plays on the alarm stream, not notification volume
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()

        val channel = NotificationChannel(CHANNEL_ID, "Alerts", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Messages you've marked as alert-worthy — can bypass silent/Do Not Disturb once access is granted below"
            enableLights(true)
            enableVibration(true)
            setSound(soundUri, audioAttrs)
            setBypassDnd(true)
        }
        nm.createNotificationChannel(channel)
    }

    // setBypassDnd(true) on the channel above is silently ignored by Android unless the
    // user has also separately granted this app "Do Not Disturb access" — there is no
    // runtime permission dialog for this, only a system settings screen the user must
    // toggle manually, which is what requestDndAccess() below sends them to.
    @PluginMethod
    fun checkDndAccess(call: PluginCall) {
        val nm = context.getSystemService(NotificationManager::class.java)
        val ret = JSObject()
        ret.put("granted", nm.isNotificationPolicyAccessGranted)
        call.resolve(ret)
    }

    @PluginMethod
    fun requestDndAccess(call: PluginCall) {
        val intent = Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        call.resolve()
    }
}
