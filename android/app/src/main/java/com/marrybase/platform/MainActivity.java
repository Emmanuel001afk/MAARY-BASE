package com.marrybase.platform;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

import java.net.URI;

/**
 * MARRY BASE companion app.
 *
 * <p>Division of responsibility: this activity owns the device-side connection
 * workflow (address validation, readiness probing, persistence, TLS policy) and
 * then hosts the operator's Management Studio. Every project workflow — schema,
 * SQL, auth, storage, functions, realtime, backups — is served by the connected
 * MARRY BASE instance, so the app never re-implements the control plane and
 * never stores platform credentials itself.</p>
 */
public class MainActivity extends Activity {

    private static final String PREFS = "marry_base";
    private static final String KEY_SERVER = "server_url";
    private static final String KEY_VERIFIED_AT = "verified_at";
    private static final int COLOR_BG = Color.rgb(10, 15, 20);
    private static final int COLOR_SURFACE = Color.rgb(16, 26, 34);
    private static final int COLOR_TEXT = Color.rgb(242, 247, 250);
    private static final int COLOR_MUTED = Color.rgb(167, 184, 196);
    private static final int COLOR_ACCENT = Color.rgb(56, 232, 195);
    private static final int COLOR_DANGER = Color.rgb(255, 122, 122);

    private SharedPreferences preferences;
    private FrameLayout root;
    private LinearLayout studioShell;
    private LinearLayout configView;
    private EditText urlField;
    private TextView statusView;
    private TextView statusDetail;
    private Button primaryButton;
    private ProgressBar progressBar;
    private WebView webView;
    private String activeServer;
    private boolean verifying;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        preferences = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        root = new FrameLayout(this);
        root.setBackgroundColor(COLOR_BG);
        setContentView(root);
        showConfig(initialAddress(), false);
        if (savedInstanceState != null) {
            String restored = savedInstanceState.getString("active_server");
            if (restored != null && !restored.isEmpty() && preferences.getBoolean("auto_open", true)) {
                openStudio(restored, false);
            }
        }
    }

    private String initialAddress() {
        String saved = preferences.getString(KEY_SERVER, null);
        if (saved != null && !saved.isEmpty()) return saved;
        return BuildConfig.DEFAULT_SERVER_URL == null ? "" : BuildConfig.DEFAULT_SERVER_URL;
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (activeServer != null) outState.putString("active_server", activeServer);
    }

    // ---------------------------------------------------------------- config UI

    private void showConfig(String prefill, boolean showHelp) {
        activeServer = null;
        if (webView != null) {
            root.removeAllViews();
            webView.stopLoading();
            webView.setWebChromeClient(null);
            webView.setWebViewClient(null);
            webView.destroy();
            webView = null;
        }
        configView = new LinearLayout(this);
        configView.setOrientation(LinearLayout.VERTICAL);
        configView.setBackgroundColor(COLOR_BG);
        configView.setPadding(dp(22), dp(28), dp(22), dp(28));

        LinearLayout brandRow = new LinearLayout(this);
        brandRow.setOrientation(LinearLayout.HORIZONTAL);
        brandRow.setGravity(Gravity.CENTER_VERTICAL);
        TextView mark = new TextView(this);
        mark.setText("M");
        mark.setTextColor(COLOR_BG);
        mark.setTypeface(Typeface.DEFAULT_BOLD);
        mark.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        mark.setGravity(Gravity.CENTER);
        mark.setBackgroundColor(COLOR_ACCENT);
        LinearLayout.LayoutParams markParams = new LinearLayout.LayoutParams(dp(44), dp(44));
        markParams.setMargins(0, 0, dp(12), 0);
        brandRow.addView(mark, markParams);
        LinearLayout brandText = new LinearLayout(this);
        brandText.setOrientation(LinearLayout.VERTICAL);
        TextView title = new TextView(this);
        title.setText("MARRY BASE");
        title.setTextColor(COLOR_TEXT);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        TextView subtitle = new TextView(this);
        subtitle.setText("Independent backend platform");
        subtitle.setTextColor(COLOR_MUTED);
        subtitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        brandText.addView(title);
        brandText.addView(subtitle);
        brandRow.addView(brandText);
        configView.addView(brandRow);

        TextView heading = new TextView(this);
        heading.setText("Connect to your instance");
        heading.setTextColor(COLOR_TEXT);
        heading.setTypeface(Typeface.DEFAULT_BOLD);
        heading.setTextSize(TypedValue.COMPLEX_UNIT_SP, 26);
        heading.setPadding(0, dp(28), 0, dp(8));
        configView.addView(heading);

        TextView intro = new TextView(this);
        intro.setText("Enter the address of a MARRY BASE server you operate. The app verifies the server, stores the address on this device, and opens the Management Studio served by that instance.");
        intro.setTextColor(COLOR_MUTED);
        intro.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        intro.setLineSpacing(dp(3), 1f);
        configView.addView(intro);

        TextView label = new TextView(this);
        label.setText("Server URL");
        label.setTextColor(COLOR_TEXT);
        label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        label.setPadding(0, dp(24), 0, dp(6));
        configView.addView(label);

        urlField = new EditText(this);
        urlField.setSingleLine(true);
        urlField.setHint("https://api.example.com");
        urlField.setHintTextColor(Color.rgb(100, 120, 132));
        urlField.setTextColor(COLOR_TEXT);
        urlField.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        urlField.setBackgroundColor(COLOR_SURFACE);
        urlField.setPadding(dp(12), dp(10), dp(12), dp(10));
        urlField.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        urlField.setText(prefill == null ? "" : prefill);
        configView.addView(urlField);

        TextView hint = new TextView(this);
        hint.setText("Emulator: http://10.0.2.2:4100 · LAN: http://192.168.x.x:4100 · Production: HTTPS with a valid certificate.");
        hint.setTextColor(COLOR_MUTED);
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        hint.setPadding(0, dp(8), 0, 0);
        configView.addView(hint);

        statusView = new TextView(this);
        statusView.setTextColor(COLOR_MUTED);
        statusView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        statusView.setPadding(0, dp(16), 0, 0);
        statusView.setText(showHelp ? "Check the address to verify the server before opening the Studio." : "");
        configView.addView(statusView);

        statusDetail = new TextView(this);
        statusDetail.setTextColor(COLOR_MUTED);
        statusDetail.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        statusDetail.setPadding(0, dp(4), 0, 0);
        statusDetail.setLineSpacing(dp(2), 1f);
        configView.addView(statusDetail);

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setPadding(0, dp(20), 0, 0);

        Button testButton = new Button(this);
        testButton.setText("Test connection");
        testButton.setAllCaps(false);
        testButton.setTextColor(COLOR_TEXT);
        testButton.setBackgroundColor(COLOR_SURFACE);
        actions.addView(testButton, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        primaryButton = new Button(this);
        primaryButton.setText("Verify & open Studio");
        primaryButton.setAllCaps(false);
        primaryButton.setTextColor(COLOR_BG);
        primaryButton.setBackgroundColor(COLOR_ACCENT);
        LinearLayout.LayoutParams primaryParams = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1.25f);
        primaryParams.setMargins(dp(8), 0, 0, 0);
        actions.addView(primaryButton, primaryParams);
        configView.addView(actions);

        testButton.setOnClickListener(view -> verifyAddress(false));
        primaryButton.setOnClickListener(view -> verifyAddress(true));

        TextView saved = new TextView(this);
        String savedAt = preferences.getString(KEY_VERIFIED_AT, null);
        String savedUrl = preferences.getString(KEY_SERVER, null);
        if (savedUrl != null && savedAt != null) {
            saved.setText("Last verified server: " + savedUrl + "\nVerified: " + savedAt);
            saved.setTextColor(COLOR_MUTED);
            saved.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
            saved.setPadding(0, dp(16), 0, 0);
            configView.addView(saved);
        }

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.addView(configView);
        root.removeAllViews();
        root.addView(scroll);

        if (prefill != null && !prefill.isEmpty()) {
            // Auto-focus only when the field is empty, so returning users can tap "open".
            urlField.clearFocus();
        }
    }

    private void setStatus(String message, String detail, int color) {
        statusView.setTextColor(color);
        statusView.setText(message);
        statusDetail.setTextColor(COLOR_MUTED);
        statusDetail.setText(detail == null ? "" : detail);
    }

    private void verifyAddress(boolean openWhenReady) {
        if (verifying) return;
        verifying = true;
        if (primaryButton != null) primaryButton.setEnabled(false);
        setStatus("Checking the server…", "Contacting /ready", COLOR_MUTED);
        final String normalized;
        try {
            normalized = ServerAddress.normalize(urlField.getText().toString());
        } catch (IllegalArgumentException error) {
            verifying = false;
            if (primaryButton != null) primaryButton.setEnabled(true);
            setStatus(error.getMessage(), "Fix the address and try again.", COLOR_DANGER);
            return;
        }
        urlField.setText(normalized);
        hideKeyboard();
        new Thread(() -> {
            ConnectionProbe.Result result = ConnectionProbe.probe(normalized);
            runOnUiThread(() -> {
                verifying = false;
                if (primaryButton != null) primaryButton.setEnabled(true);
                if (!result.ready) {
                    setStatus(result.message, result.details, COLOR_DANGER);
                    if (openWhenReady) {
                        setStatus(result.message + " You can still open the Studio once the server reports ready.",
                            result.details, COLOR_DANGER);
                    }
                    return;
                }
                setStatus("Connected. " + result.message, result.details, COLOR_ACCENT);
                preferences.edit()
                    .putString(KEY_SERVER, normalized)
                    .putString(KEY_VERIFIED_AT, new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm", java.util.Locale.US).format(new java.util.Date()))
                    .apply();
                if (openWhenReady) openStudio(normalized, true);
            });
        }, "marry-base-connection-probe").start();
    }

    private void hideKeyboard() {
        InputMethodManager manager = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
        if (manager != null && urlField != null) manager.hideSoftInputFromWindow(urlField.getWindowToken(), 0);
    }

    // ---------------------------------------------------------------- studio UI

    private void openStudio(String serverUrl, boolean persist) {
        activeServer = serverUrl;
        if (persist) preferences.edit().putBoolean("auto_open", true).apply();

        studioShell = new LinearLayout(this);
        studioShell.setOrientation(LinearLayout.VERTICAL);
        studioShell.setBackgroundColor(COLOR_BG);

        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(dp(14), dp(10), dp(8), dp(10));
        header.setBackgroundColor(COLOR_SURFACE);

        LinearLayout headerText = new LinearLayout(this);
        headerText.setOrientation(LinearLayout.VERTICAL);
        TextView headerTitle = new TextView(this);
        headerTitle.setText("MARRY BASE");
        headerTitle.setTextColor(COLOR_TEXT);
        headerTitle.setTypeface(Typeface.DEFAULT_BOLD);
        headerTitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        TextView headerHost = new TextView(this);
        headerHost.setText(hostOf(serverUrl));
        headerHost.setTextColor(COLOR_MUTED);
        headerHost.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        headerText.addView(headerTitle);
        headerText.addView(headerHost);
        header.addView(headerText, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        Button serverButton = new Button(this);
        serverButton.setText("Server");
        serverButton.setAllCaps(false);
        serverButton.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        serverButton.setTextColor(COLOR_TEXT);
        serverButton.setBackgroundColor(Color.TRANSPARENT);
        serverButton.setOnClickListener(view -> {
            new android.app.AlertDialog.Builder(this)
                .setTitle("Server connection")
                .setItems(new CharSequence[]{"Reload Studio", "Change server", "Open in browser"}, (dialog, which) -> {
                    if (which == 0 && webView != null) webView.reload();
                    else if (which == 1) showConfig(serverUrl, true);
                    else openExternal(serverUrl + "/dashboard");
                })
                .show();
        });
        header.addView(serverButton);
        studioShell.addView(header);

        FrameLayout webContainer = new FrameLayout(this);
        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(100);
        progressBar.setVisibility(View.GONE);
        webContainer.addView(progressBar, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, dp(3), Gravity.TOP));

        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        CookieManager.getInstance().setAcceptCookie(true);
        if (ServerAddress.schemeOf(serverUrl) == ServerAddress.Scheme.HTTP) {
            // Session cookies are not marked secure on a private HTTP development server.
            CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        }
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int progress) {
                if (progressBar == null) return;
                progressBar.setVisibility(progress >= 100 ? View.GONE : View.VISIBLE);
                progressBar.setProgress(progress);
            }
        });
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme() == null ? "" : uri.getScheme();
                if (!"http".equals(scheme) && !"https".equals(scheme)) {
                    return true;
                }
                return !sameOrigin(uri, serverUrl) && openExternal(uri.toString());
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, android.net.http.SslError error) {
                // Never bypass certificate validation.
                handler.cancel();
                showNativeError("Secure connection rejected",
                    "The server's TLS certificate could not be verified. Install a valid certificate, or use a private HTTP address only for local development.");
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    showNativeError("The Studio could not be loaded",
                        String.valueOf(error.getDescription()) + " Check the server address and network connection.");
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (progressBar != null) progressBar.setVisibility(View.GONE);
            }
        });
        webView.loadUrl(ServerAddress.studioUrl(serverUrl));
        webContainer.addView(webView, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        studioShell.addView(webContainer, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        root.removeAllViews();
        root.addView(studioShell);
    }

    private void showNativeError(String title, String message) {
        new android.app.AlertDialog.Builder(this)
            .setTitle(title)
            .setMessage(message)
            .setPositiveButton("Retry", (dialog, which) -> {
                if (webView != null) webView.reload();
            })
            .setNegativeButton("Server settings", (dialog, which) -> showConfig(activeServer, true))
            .show();
    }

    private boolean openExternal(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    private static boolean sameOrigin(Uri uri, String serverUrl) {
        try {
            URI server = new URI(serverUrl);
            return server.getHost() != null && server.getHost().equalsIgnoreCase(uri.getHost())
                && (server.getPort() == -1 ? uri.getPort() == -1 || uri.getPort() == 80 || uri.getPort() == 443
                    : server.getPort() == uri.getPort())
                && String.valueOf(server.getScheme()).equalsIgnoreCase(uri.getScheme());
        } catch (Exception error) {
            return false;
        }
    }

    private static String hostOf(String serverUrl) {
        try {
            URI uri = new URI(serverUrl);
            return uri.getHost() + (uri.getPort() == -1 ? "" : ":" + uri.getPort());
        } catch (Exception error) {
            return serverUrl;
        }
    }

    private int dp(int value) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics()));
    }

    @Override
    public void onBackPressed() {
        if (webView != null) {
            if (webView.canGoBack()) {
                webView.goBack();
                return;
            }
            showConfig(activeServer, true);
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.stopLoading();
            webView.setWebChromeClient(null);
            webView.setWebViewClient(null);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
