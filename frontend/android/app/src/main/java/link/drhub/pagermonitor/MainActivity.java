package link.drhub.pagermonitor;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LiveAudioPlugin.class);
        registerPlugin(AlertChannelPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
