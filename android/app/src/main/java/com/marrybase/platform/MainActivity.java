package com.marrybase.platform;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.net.URI;
import java.util.Locale;

public class MainActivity extends Activity {
    private static final String PREFS = "maary_base_settings";
    private static final String SERVER_URL_KEY = "server_url";

    private WebView webView;
    private TextView statusView;
    private SharedPreferences preferences;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        preferences = getSharedPreferences(PREFS, MODE_PRIVATE);
        buildScreen();

        String savedUrl = preferences.getString(SERVER_URL_KEY, "");
        if (savedUrl == null || savedUrl.trim().isEmpty()) {
            promptForServerUrl();
        } else {
            loadDashboard(savedUrl);
        }
    }

    private void buildScreen() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(11, 15, 23));

        LinearLayout toolbar = new LinearLayout(this);
        toolbar.setOrientation(LinearLayout.HORIZONTAL);
        toolbar.setPadding(dp(12), dp(8), dp(12), dp(8));
        toolbar.setGravity(android.view.Gravity.CENTER_VERTICAL);

        TextView title = new TextView(this);
        title.setText("MARRY BASE");
        title.setTextColor(Color.WHITE);
        title.setTextSize(18);
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        toolbar.addView(title, new LinearLayout.LayoutParams(0, dp(48), 1));

        Button changeServer = new Button(this);
        changeServer.setText("Server");
        changeServer.setOnClickListener(v -> promptForServerUrl());
        toolbar.addView(changeServer, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, dp(48)));

        root.addView(toolbar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        statusView = new TextView(this);
        statusView.setTextColor(Color.LTGRAY);
        statusView.setPadding(dp(16), dp(10), dp(16), dp(10));
        statusView.setText("Connect to your MARRY BASE server to continue.");
        root.addView(statusView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        webView.setWebViewClient(new WebViewClient());
        root.addView(webView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));

        setContentView(root);
    }

    private void promptForServerUrl() {
        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setInputType(android.text.InputType.TYPE_CLASS_TEXT
                | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        input.setHint("https://your-server.example or http://192.168.1.10:4100");
        input.setText(preferences.getString(SERVER_URL_KEY, ""));

        new AlertDialog.Builder(this)
                .setTitle("Connect to MARRY BASE")
                .setMessage("Enter the base URL of your running MARRY BASE server. Use the server's reachable address, not localhost, when connecting from a phone.")
                .setView(input)
                .setCancelable(false)
                .setNegativeButton("Cancel", (dialog, which) -> {
                    if (preferences.getString(SERVER_URL_KEY, "").isEmpty()) {
                        statusView.setText("No server configured. Tap Server when you are ready to connect.");
                    }
                })
                .setPositiveButton("Connect", (dialog, which) -> {
                    String normalized = normalizeServerUrl(input.getText().toString());
                    if (normalized == null) {
                        Toast.makeText(this,
                                "Enter a valid http:// or https:// server URL.",
                                Toast.LENGTH_LONG).show();
                        promptForServerUrl();
                        return;
                    }
                    preferences.edit().putString(SERVER_URL_KEY, normalized).apply();
                    loadDashboard(normalized);
                })
                .show();
    }

    private String normalizeServerUrl(String raw) {
        if (raw == null) return null;
        String value = raw.trim();
        while (value.endsWith("/")) {
            value = value.substring(0, value.length() - 1);
        }
        try {
            URI uri = URI.create(value);
            String scheme = uri.getScheme();
            if (scheme == null || uri.getHost() == null) return null;
            scheme = scheme.toLowerCase(Locale.ROOT);
            if (!scheme.equals("http") && !scheme.equals("https")) return null;
            if (value.toLowerCase(Locale.ROOT).endsWith("/dashboard")) return value;
            return value + "/dashboard";
        } catch (IllegalArgumentException ex) {
            return null;
        }
    }

    private void loadDashboard(String dashboardUrl) {
        statusView.setText("Connecting to " + dashboardUrl);
        webView.loadUrl(dashboardUrl);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
