package com.marrybase.platform;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class MainActivity extends Activity {
    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        webView.setWebViewClient(new WebViewClient());
        String serverUrl = getIntent().getStringExtra("MARRY_BASE_URL");
        if (serverUrl == null || serverUrl.isEmpty()) {
            serverUrl = "http://10.0.2.2:4100/dashboard";
        }
        webView.loadUrl(serverUrl);
        setContentView(webView);
    }
}
