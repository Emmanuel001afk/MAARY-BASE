package com.marrybase.platform;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    private static final String PREFS_NAME = "marry_base_companion_prefs";
    private static final String KEY_SAVED_URL = "saved_server_url";
    private static final String KEY_ALLOW_HTTP = "allow_cleartext_http";
    private static final int CONNECT_TIMEOUT_MS = 8000;
    private static final int READ_TIMEOUT_MS = 8000;

    private final ExecutorService networkExecutor = Executors.newSingleThreadExecutor();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private SharedPreferences prefs;
    private FrameLayout rootContainer;
    private ScrollView setupScreen;
    private LinearLayout studioScreen;

    private EditText urlInput;
    private CheckBox allowHttpCheck;
    private TextView statusTitle;
    private TextView statusDetail;
    private Button connectOpenButton;
    private Button verifyOnlyButton;

    private TextView barOriginLabel;
    private TextView recoveryBannerText;
    private LinearLayout recoveryBanner;
    private ProgressBar loadProgressBar;
    private WebView studioWebView;

    private String verifiedOrigin = null;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);

        rootContainer = new FrameLayout(this);
        rootContainer.setBackgroundColor(Color.parseColor("#090D16"));

        setupScreen = buildSetupScreen();
        studioScreen = buildStudioScreen();
        studioScreen.setVisibility(View.GONE);

        rootContainer.addView(setupScreen, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));
        rootContainer.addView(studioScreen, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));

        setContentView(rootContainer);

        String savedUrl = prefs.getString(KEY_SAVED_URL, "");
        if (savedUrl == null || savedUrl.trim().isEmpty()) {
            String bundledDefault = getString(R.string.default_server_url);
            savedUrl = bundledDefault != null ? bundledDefault.trim() : "";
        }
        boolean allowHttp = prefs.getBoolean(KEY_ALLOW_HTTP, false);
        allowHttpCheck.setChecked(allowHttp);

        if (!savedUrl.isEmpty()) {
            urlInput.setText(savedUrl);
            verifyServerAndProceed(savedUrl, true);
        }
    }

    private ScrollView buildSetupScreen() {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(Color.parseColor("#090D16"));

        LinearLayout outer = new LinearLayout(this);
        outer.setOrientation(LinearLayout.VERTICAL);
        outer.setGravity(Gravity.CENTER_VERTICAL);
        int pad = dp(20);
        outer.setPadding(pad, dp(28), pad, dp(28));

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(20), dp(22), dp(20), dp(22));
        card.setBackground(roundedRect("#111827", "#1F2937", 16));

        TextView badge = new TextView(this);
        badge.setText("MARI BASE ANDROID COMPANION");
        badge.setTextColor(Color.parseColor("#34D399"));
        badge.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        badge.setTypeface(Typeface.DEFAULT_BOLD);
        card.addView(badge);

        TextView title = new TextView(this);
        title.setText("Your backend workspace");
        title.setTextColor(Color.parseColor("#F9FAFB"));
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 21);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        LinearLayout.LayoutParams titleLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        titleLp.topMargin = dp(6);
        card.addView(title, titleLp);

        TextView subtitle = new TextView(this);
        subtitle.setText("This app is the control panel, not the server itself. Start or deploy MARI BASE first, then connect here. The backend must be reachable from this phone.");
        subtitle.setTextColor(Color.parseColor("#9CA3AF"));
        subtitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        LinearLayout.LayoutParams subLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        subLp.topMargin = dp(6);
        card.addView(subtitle, subLp);

        TextView inputLabel = new TextView(this);
        inputLabel.setText("Backend server address");
        inputLabel.setTextColor(Color.parseColor("#E5E7EB"));
        inputLabel.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        inputLabel.setTypeface(Typeface.DEFAULT_BOLD);
        LinearLayout.LayoutParams labelLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        labelLp.topMargin = dp(18);
        card.addView(inputLabel, labelLp);

        urlInput = new EditText(this);
        urlInput.setHint("https://api.yourdomain.com");
        urlInput.setHintTextColor(Color.parseColor("#6B7280"));
        urlInput.setTextColor(Color.parseColor("#F9FAFB"));
        urlInput.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        urlInput.setSingleLine(true);
        urlInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        urlInput.setPadding(dp(14), dp(12), dp(14), dp(12));
        urlInput.setBackground(roundedRect("#0B1120", "#374151", 10));
        LinearLayout.LayoutParams inputLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        inputLp.topMargin = dp(8);
        card.addView(urlInput, inputLp);

        LinearLayout presetRow = new LinearLayout(this);
        presetRow.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams presetLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        presetLp.topMargin = dp(10);

        Button emulatorChip = createSecondarySmallButton("Emulator (10.0.2.2:4100)");
        emulatorChip.setOnClickListener(v -> {
            urlInput.setText("http://10.0.2.2:4100");
            allowHttpCheck.setChecked(true);
        });
        presetRow.addView(emulatorChip);

        Button localChip = createSecondarySmallButton("LAN example");
        LinearLayout.LayoutParams localChipLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        localChipLp.leftMargin = dp(8);
        localChip.setOnClickListener(v -> {
            urlInput.setText("http://192.168.1.20:4100");
            allowHttpCheck.setChecked(true);
        });
        presetRow.addView(localChip, localChipLp);
        card.addView(presetRow, presetLp);

        TextView addressHelp = new TextView(this);
        addressHelp.setText("Important: localhost / 127.0.0.1 means this phone. If your server runs on a computer or another phone, use that device's Wi-Fi/LAN IP (example: http://192.168.1.20:4100) or its deployed HTTPS URL. Replace the example IP with the real one.");
        addressHelp.setTextColor(Color.parseColor("#A7B7C8"));
        addressHelp.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        addressHelp.setLineSpacing(dp(2), 1f);
        LinearLayout.LayoutParams addressHelpLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        addressHelpLp.topMargin = dp(8);
        card.addView(addressHelp, addressHelpLp);

        allowHttpCheck = new CheckBox(this);
        allowHttpCheck.setText("Allow cleartext HTTP for local / LAN development (HTTPS enforced for remote hosts)");
        allowHttpCheck.setTextColor(Color.parseColor("#D1D5DB"));
        allowHttpCheck.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        LinearLayout.LayoutParams checkLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        checkLp.topMargin = dp(12);
        card.addView(allowHttpCheck, checkLp);

        LinearLayout statusBox = new LinearLayout(this);
        statusBox.setOrientation(LinearLayout.VERTICAL);
        statusBox.setPadding(dp(14), dp(12), dp(14), dp(12));
        statusBox.setBackground(roundedRect("#0B1120", "#1F2937", 10));
        LinearLayout.LayoutParams statusLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        statusLp.topMargin = dp(14);

        statusTitle = new TextView(this);
        statusTitle.setText("No server connected");
        statusTitle.setTextColor(Color.parseColor("#E5E7EB"));
        statusTitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        statusTitle.setTypeface(Typeface.DEFAULT_BOLD);
        statusBox.addView(statusTitle);

        statusDetail = new TextView(this);
        statusDetail.setText("Enter the address of a running MARI BASE backend. A successful connection opens the full Studio interface.");
        statusDetail.setTextColor(Color.parseColor("#9CA3AF"));
        statusDetail.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        LinearLayout.LayoutParams detailLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        detailLp.topMargin = dp(4);
        statusBox.addView(statusDetail, detailLp);
        card.addView(statusBox, statusLp);

        connectOpenButton = new Button(this);
        connectOpenButton.setAllCaps(false);
        connectOpenButton.setText("Connect & Open Studio");
        connectOpenButton.setTextColor(Color.parseColor("#04130D"));
        connectOpenButton.setTypeface(Typeface.DEFAULT_BOLD);
        connectOpenButton.setBackground(roundedRect("#10B981", "#059669", 10));
        connectOpenButton.setPadding(dp(16), dp(12), dp(16), dp(12));
        connectOpenButton.setOnClickListener(v ->
                verifyServerAndProceed(urlInput.getText().toString(), true));
        LinearLayout.LayoutParams primaryLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        primaryLp.topMargin = dp(16);
        card.addView(connectOpenButton, primaryLp);

        LinearLayout actionRow = new LinearLayout(this);
        actionRow.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams actionRowLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        actionRowLp.topMargin = dp(10);

        verifyOnlyButton = new Button(this);
        verifyOnlyButton.setAllCaps(false);
        verifyOnlyButton.setText("Verify Server");
        verifyOnlyButton.setTextColor(Color.parseColor("#E5E7EB"));
        verifyOnlyButton.setBackground(roundedRect("#1F2937", "#374151", 10));
        verifyOnlyButton.setOnClickListener(v ->
                verifyServerAndProceed(urlInput.getText().toString(), false));
        LinearLayout.LayoutParams halfLp1 = new LinearLayout.LayoutParams(
                0,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                1f
        );
        halfLp1.rightMargin = dp(6);
        actionRow.addView(verifyOnlyButton, halfLp1);

        Button clearSavedBtn = new Button(this);
        clearSavedBtn.setAllCaps(false);
        clearSavedBtn.setText("Forget Saved URL");
        clearSavedBtn.setTextColor(Color.parseColor("#FCA5A5"));
        clearSavedBtn.setBackground(roundedRect("#1F1519", "#7F1D1D", 10));
        clearSavedBtn.setOnClickListener(v -> {
            prefs.edit().remove(KEY_SAVED_URL).remove(KEY_ALLOW_HTTP).apply();
            verifiedOrigin = null;
            urlInput.setText("");
            setStatusMessage("Saved configuration cleared", "Saved address cleared. Enter your running backend address.", "#9CA3AF");
        });
        LinearLayout.LayoutParams halfLp2 = new LinearLayout.LayoutParams(
                0,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                1f
        );
        halfLp2.leftMargin = dp(6);
        actionRow.addView(clearSavedBtn, halfLp2);

        card.addView(actionRow, actionRowLp);
        outer.addView(card);

        LinearLayout modulesCard = new LinearLayout(this);
        modulesCard.setOrientation(LinearLayout.VERTICAL);
        modulesCard.setPadding(dp(18), dp(18), dp(18), dp(18));
        modulesCard.setBackground(roundedRect("#0E1722", "#243342", 16));
        LinearLayout.LayoutParams modulesCardLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        modulesCardLp.topMargin = dp(14);

        TextView modulesHeading = new TextView(this);
        modulesHeading.setText("Inside Management Studio");
        modulesHeading.setTextColor(Color.parseColor("#F3F7FA"));
        modulesHeading.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        modulesHeading.setTypeface(Typeface.DEFAULT_BOLD);
        modulesCard.addView(modulesHeading);

        TextView modulesIntro = new TextView(this);
        modulesIntro.setText("Tools available after you connect to your running MARI BASE server.");
        modulesIntro.setTextColor(Color.parseColor("#91A4B7"));
        modulesIntro.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        LinearLayout.LayoutParams modulesIntroLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        modulesIntroLp.topMargin = dp(4);
        modulesIntroLp.bottomMargin = dp(12);
        modulesCard.addView(modulesIntro, modulesIntroLp);

        modulesCard.addView(createModuleRow(
                "Database & SQL", "Tables, queries, migrations",
                "Auth & users", "Accounts, roles, sessions"
        ));
        LinearLayout.LayoutParams rowTwoLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        rowTwoLp.topMargin = dp(8);
        modulesCard.addView(createModuleRow(
                "Storage", "Buckets and files",
                "Realtime", "Live data and events"
        ), rowTwoLp);
        LinearLayout.LayoutParams rowThreeLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        rowThreeLp.topMargin = dp(8);
        modulesCard.addView(createModuleRow(
                "Functions & jobs", "Server tasks and queues",
                "Backups & logs", "Recovery and diagnostics"
        ), rowThreeLp);

        outer.addView(modulesCard, modulesCardLp);
        scroll.addView(outer);
        return scroll;
    }

    private LinearLayout createModuleRow(String firstTitle, String firstDetail,
                                         String secondTitle, String secondDetail) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.addView(createModuleTile(firstTitle, firstDetail), new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f
        ));
        LinearLayout.LayoutParams secondLp = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f
        );
        secondLp.leftMargin = dp(8);
        row.addView(createModuleTile(secondTitle, secondDetail), secondLp);
        return row;
    }

    private LinearLayout createModuleTile(String title, String detail) {
        LinearLayout tile = new LinearLayout(this);
        tile.setOrientation(LinearLayout.VERTICAL);
        tile.setPadding(dp(10), dp(10), dp(10), dp(10));
        tile.setBackground(roundedRect("#111F2D", "#263849", 10));

        TextView titleView = new TextView(this);
        titleView.setText(title);
        titleView.setTextColor(Color.parseColor("#D9FBEA"));
        titleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        titleView.setTypeface(Typeface.DEFAULT_BOLD);
        tile.addView(titleView);

        TextView detailView = new TextView(this);
        detailView.setText(detail);
        detailView.setTextColor(Color.parseColor("#8FA3B6"));
        detailView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10);
        detailView.setLineSpacing(dp(1), 1f);
        LinearLayout.LayoutParams detailViewLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        detailViewLp.topMargin = dp(4);
        tile.addView(detailView, detailViewLp);
        return tile;
    }

    @SuppressLint("SetJavaScriptEnabled")
    private LinearLayout buildStudioScreen() {
        LinearLayout container = new LinearLayout(this);
        container.setOrientation(LinearLayout.VERTICAL);
        container.setBackgroundColor(Color.parseColor("#090D16"));

        LinearLayout topBar = new LinearLayout(this);
        topBar.setOrientation(LinearLayout.HORIZONTAL);
        topBar.setGravity(Gravity.CENTER_VERTICAL);
        topBar.setBackgroundColor(Color.parseColor("#111827"));
        topBar.setPadding(dp(12), dp(8), dp(12), dp(8));

        barOriginLabel = new TextView(this);
        barOriginLabel.setText("Not connected");
        barOriginLabel.setTextColor(Color.parseColor("#34D399"));
        barOriginLabel.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        barOriginLabel.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        barOriginLabel.setSingleLine(true);
        LinearLayout.LayoutParams originLp = new LinearLayout.LayoutParams(
                0,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                1f
        );
        topBar.addView(barOriginLabel, originLp);

        Button reloadBtn = createSecondarySmallButton("Reload");
        reloadBtn.setOnClickListener(v -> {
            recoveryBanner.setVisibility(View.GONE);
            if (studioWebView != null) {
                studioWebView.reload();
            }
        });
        topBar.addView(reloadBtn);

        Button switchServerBtn = createSecondarySmallButton("Server");
        LinearLayout.LayoutParams switchLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        switchLp.leftMargin = dp(6);
        switchServerBtn.setOnClickListener(v -> showSetupScreen());
        topBar.addView(switchServerBtn, switchLp);

        container.addView(topBar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        ));

        loadProgressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        loadProgressBar.setMax(100);
        loadProgressBar.setVisibility(View.GONE);
        container.addView(loadProgressBar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(3)
        ));

        recoveryBanner = new LinearLayout(this);
        recoveryBanner.setOrientation(LinearLayout.HORIZONTAL);
        recoveryBanner.setGravity(Gravity.CENTER_VERTICAL);
        recoveryBanner.setBackgroundColor(Color.parseColor("#3B1219"));
        recoveryBanner.setPadding(dp(12), dp(8), dp(12), dp(8));
        recoveryBanner.setVisibility(View.GONE);

        recoveryBannerText = new TextView(this);
        recoveryBannerText.setTextColor(Color.parseColor("#FECACA"));
        recoveryBannerText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        LinearLayout.LayoutParams bannerTxtLp = new LinearLayout.LayoutParams(
                0,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                1f
        );
        recoveryBanner.addView(recoveryBannerText, bannerTxtLp);

        Button retryBtn = createSecondarySmallButton("Re-verify");
        retryBtn.setOnClickListener(v -> {
            if (verifiedOrigin != null) {
                verifyServerAndProceed(verifiedOrigin, true);
            } else {
                showSetupScreen();
            }
        });
        recoveryBanner.addView(retryBtn);
        container.addView(recoveryBanner, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        ));

        studioWebView = new WebView(this);
        WebSettings settings = studioWebView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSupportMultipleWindows(false);

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(studioWebView, false);

        studioWebView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                if (newProgress < 100) {
                    loadProgressBar.setVisibility(View.VISIBLE);
                    loadProgressBar.setProgress(newProgress);
                } else {
                    loadProgressBar.setVisibility(View.GONE);
                }
            }
        });

        studioWebView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri requested = request != null ? request.getUrl() : null;
                String path = requested != null ? requested.getPath() : null;
                if (path != null && path.startsWith("/dashboard/")) {
                    String assetPath = path.substring("/dashboard/".length());
                    if ("logo.png".equals(assetPath) || "app-icon.png".equals(assetPath)) {
                        assetPath = "logo.svg";
                    }
                    String mimeType = "application/octet-stream";
                    if (assetPath.endsWith(".css")) mimeType = "text/css";
                    else if (assetPath.endsWith(".js")) mimeType = "application/javascript";
                    else if (assetPath.endsWith(".svg")) mimeType = "image/svg+xml";
                    else if (assetPath.endsWith(".png")) mimeType = "image/png";
                    try {
                        return new WebResourceResponse(
                                mimeType,
                                "UTF-8",
                                getAssets().open("dashboard/" + assetPath)
                        );
                    } catch (Exception ignored) {
                        // Fall through to the verified server for assets not bundled in this APK.
                    }
                }
                return super.shouldInterceptRequest(view, request);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri targetUri = request.getUrl();
                if (targetUri == null) {
                    return true;
                }
                String scheme = targetUri.getScheme() != null
                        ? targetUri.getScheme().toLowerCase(Locale.US)
                        : "";
                if (!"http".equals(scheme) && !"https".equals(scheme)) {
                    return true;
                }
                if (isSameVerifiedOrigin(targetUri)) {
                    String path = targetUri.getPath() != null ? targetUri.getPath() : "";
                    if (path.endsWith("/apk/download")) {
                        openExternalBrowser(targetUri);
                        return true;
                    }
                    return false;
                }
                openExternalBrowser(targetUri);
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request != null && request.isForMainFrame()) {
                    CharSequence desc = error != null ? error.getDescription() : "Network error";
                    showRecoveryBanner("Connection interrupted: " + desc);
                }
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
                if (request != null && request.isForMainFrame() && errorResponse != null) {
                    int status = errorResponse.getStatusCode();
                    if (status >= 502) {
                        showRecoveryBanner("Server returned HTTP " + status + ". Check backend readiness.");
                    }
                }
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                showRecoveryBanner("TLS certificate validation failed. Connection blocked for security.");
            }
        });

        container.addView(studioWebView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1f
        ));

        return container;
    }

    private void verifyServerAndProceed(String rawUrl, boolean launchStudioOnSuccess) {
        final String normalizedOrigin;
        try {
            normalizedOrigin = validateAndNormalizeOrigin(rawUrl, allowHttpCheck.isChecked());
        } catch (IllegalArgumentException ex) {
            setStatusMessage("Invalid server URL", ex.getMessage(), "#F87171");
            return;
        }

        if (!isNetworkAvailable()) {
            setStatusMessage(
                    "Device offline",
                    "No active network connection detected. Enable Wi-Fi or mobile data and retry.",
                    "#FBBF24"
            );
            return;
        }

        connectOpenButton.setEnabled(false);
        verifyOnlyButton.setEnabled(false);
        setStatusMessage("Verifying backend...", "Checking " + normalizedOrigin + "/ready and /v1/platform", "#60A5FA");

        networkExecutor.execute(() -> {
            try {
                JSONObject readyJson = fetchJson(normalizedOrigin + "/ready");
                String readyState = readyJson.optString("status", "");
                JSONObject deps = readyJson.optJSONObject("dependencies");
                String pgStatus = deps != null ? deps.optString("postgres", "unknown") : "unknown";
                String storageStatus = deps != null ? deps.optString("storage", "unknown") : "unknown";

                if (!"ready".equals(readyState)) {
                    throw new IllegalStateException(
                            "Server /ready returned '" + readyState + "' (postgres=" + pgStatus + ", storage=" + storageStatus + ")."
                    );
                }

                JSONObject platformJson = fetchJson(normalizedOrigin + "/v1/platform");
                String platformName = platformJson.optString("name", "MARI BASE");
                String version = platformJson.optString("version", "1.0.0");
                JSONObject dbObj = platformJson.optJSONObject("database");
                String dbMode = dbObj != null ? dbObj.optString("mode", "PostgreSQL") : "PostgreSQL";

                final String summary = platformName + " v" + version + " verified • DB: " + dbMode + " (" + pgStatus + ") • Storage: " + storageStatus;

                mainHandler.postDelayed(() -> {
                    connectOpenButton.setEnabled(true);
                    verifyOnlyButton.setEnabled(true);

                    prefs.edit()
                            .putString(KEY_SAVED_URL, normalizedOrigin)
                            .putBoolean(KEY_ALLOW_HTTP, allowHttpCheck.isChecked())
                            .apply();
                    verifiedOrigin = normalizedOrigin;
                    urlInput.setText(normalizedOrigin);
                    setStatusMessage("Backend Ready", summary, "#34D399");

                    if (launchStudioOnSuccess) {
                        openStudio(normalizedOrigin);
                    }
                }, 50);
            } catch (final Exception ex) {
                mainHandler.post(() -> {
                    connectOpenButton.setEnabled(true);
                    verifyOnlyButton.setEnabled(true);
                    setStatusMessage(
                            "Could not connect",
                            explainConnectionFailure(normalizedOrigin, ex),
                            "#F87171"
                    );
                    if (studioScreen.getVisibility() == View.VISIBLE) {
                        showRecoveryBanner("Server readiness check failed: " + ex.getMessage());
                    }
                });
            }
        });
    }

    private String explainConnectionFailure(String origin, Exception error) {
        String detail = error != null && error.getMessage() != null
                ? error.getMessage() : "The backend did not respond.";
        String lower = detail.toLowerCase(Locale.US);
        String hostHelp = "";
        try {
            URI uri = new URI(origin);
            String host = uri.getHost() != null ? uri.getHost().toLowerCase(Locale.US) : "";
            if ("localhost".equals(host) || "127.0.0.1".equals(host)) {
                hostHelp = " You entered localhost, which points to this Android phone. If the backend runs on another device, enter that device's LAN IP or a deployed HTTPS URL.";
            } else if ("10.0.2.2".equals(host)) {
                hostHelp = " 10.0.2.2 is for the Android emulator, not a normal physical phone.";
            }
        } catch (Exception ignored) {
            // Keep the original connection diagnostic.
        }
        if (lower.contains("timed out") || lower.contains("timeout")) {
            return "The server did not respond in time. Check that MARI BASE is running, the IP and port are correct, and both devices can reach each other." + hostHelp + " Technical detail: " + detail;
        }
        if (lower.contains("refused") || lower.contains("failed to connect") || lower.contains("unable to resolve") || lower.contains("unknown host")) {
            return "No reachable MARI BASE server was found at this address. Start/deploy the backend, check the address and port, and make sure the server accepts LAN connections." + hostHelp + " Technical detail: " + detail;
        }
        return "The server check failed. Confirm the backend is running and reachable from this phone, then retry." + hostHelp + " Technical detail: " + detail;
    }

    private String validateAndNormalizeOrigin(String rawInput, boolean allowCleartextHttp) {
        if (rawInput == null || rawInput.trim().isEmpty()) {
            throw new IllegalArgumentException("Please enter your MARI BASE server URL.");
        }
        String candidate = rawInput.trim();
        URI parsed;
        try {
            parsed = new URI(candidate);
        } catch (Exception e) {
            throw new IllegalArgumentException("Malformed URL syntax. Example: https://api.example.com");
        }

        String scheme = parsed.getScheme() != null ? parsed.getScheme().toLowerCase(Locale.US) : "";
        if (!"https".equals(scheme) && !"http".equals(scheme)) {
            throw new IllegalArgumentException("URL must start with https:// (or http:// for local development).");
        }
        if (parsed.getUserInfo() != null && !parsed.getUserInfo().isEmpty()) {
            throw new IllegalArgumentException("Embedded credentials in URLs are not permitted.");
        }

        String host = parsed.getHost();
        if (host == null || host.trim().isEmpty()) {
            throw new IllegalArgumentException("URL must include a valid hostname or IP address.");
        }

        if ("http".equals(scheme) && !allowCleartextHttp && !isLocalDevHost(host)) {
            throw new IllegalArgumentException(
                    "HTTPS is required for remote servers. Enable the local/LAN HTTP option only for trusted development hosts."
            );
        }

        int port = parsed.getPort();
        String portSuffix = "";
        if (port > 0 && !((port == 80 && "http".equals(scheme)) || (port == 443 && "https".equals(scheme)))) {
            portSuffix = ":" + port;
        }
        return scheme + "://" + host.toLowerCase(Locale.US) + portSuffix;
    }

    private boolean isLocalDevHost(String host) {
        String h = host.toLowerCase(Locale.US);
        return "localhost".equals(h) || "127.0.0.1".equals(h) || "10.0.2.2".equals(h);
    }

    private JSONObject fetchJson(String endpointUrl) throws Exception {
        HttpURLConnection conn = null;
        try {
            URI uri = new URI(endpointUrl);
            conn = (HttpURLConnection) uri.toURL().openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setInstanceFollowRedirects(false);
            conn.setRequestProperty("Accept", "application/json");
            conn.setRequestProperty("User-Agent", "MARI-BASE-Android/1.0");

            int code = conn.getResponseCode();
            InputStream stream = code >= 200 && code < 400 ? conn.getInputStream() : conn.getErrorStream();
            String body = readStream(stream);
            if (code < 200 || code >= 300) {
                throw new IllegalStateException("HTTP " + code + " from " + uri.getPath());
            }
            return new JSONObject(body);
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    private String readStream(InputStream stream) throws Exception {
        if (stream == null) return "{}";
        StringBuilder sb = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line);
                if (sb.length() > 65536) break;
            }
        }
        return sb.toString();
    }

    private String readBundledDashboardHtml() {
        StringBuilder html = new StringBuilder();
        try (InputStream input = getAssets().open("dashboard/index.html");
             BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                html.append(line).append('\n');
            }
            return html.toString();
        } catch (Exception ex) {
            return "<!doctype html><html lang=\"en\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>MARI BASE</title><body style=\"font:16px system-ui;background:#090e13;color:#edf5f2;padding:24px\"><h1>MARI BASE Studio</h1><p>The bundled Studio could not be opened. Please reconnect to your server and retry.</p></body></html>";
        }
    }

    private void openStudio(String origin) {
        barOriginLabel.setText(origin);
        recoveryBanner.setVisibility(View.GONE);
        setupScreen.setVisibility(View.GONE);
        studioScreen.setVisibility(View.VISIBLE);

        String current = studioWebView.getUrl();
        if (current == null || !current.startsWith(origin)) {
            studioWebView.loadDataWithBaseURL(
                    origin + "/",
                    readBundledDashboardHtml(),
                    "text/html",
                    "UTF-8",
                    null
            );
        }
    }

    private void showSetupScreen() {
        studioScreen.setVisibility(View.GONE);
        setupScreen.setVisibility(View.VISIBLE);
    }

    private void showRecoveryBanner(String message) {
        recoveryBannerText.setText(message);
        recoveryBanner.setVisibility(View.VISIBLE);
    }

    private boolean isSameVerifiedOrigin(Uri candidate) {
        if (verifiedOrigin == null) return false;
        try {
            URI base = new URI(verifiedOrigin);
            String cScheme = candidate.getScheme() != null ? candidate.getScheme().toLowerCase(Locale.US) : "";
            String cHost = candidate.getHost() != null ? candidate.getHost().toLowerCase(Locale.US) : "";
            int cPort = candidate.getPort();
            int effectiveCandidatePort = cPort > 0 ? cPort : ("https".equals(cScheme) ? 443 : 80);
            int effectiveBasePort = base.getPort() > 0 ? base.getPort() : ("https".equals(base.getScheme()) ? 443 : 80);

            return cScheme.equals(base.getScheme())
                    && cHost.equals(base.getHost().toLowerCase(Locale.US))
                    && effectiveCandidatePort == effectiveBasePort;
        } catch (Exception e) {
            return false;
        }
    }

    private void openExternalBrowser(Uri uri) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
            startActivity(intent);
        } catch (Exception ignored) {
            // No external browser handler installed
        }
    }

    private boolean isNetworkAvailable() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return true;
        Network active = cm.getActiveNetwork();
        if (active == null) return false;
        NetworkCapabilities caps = cm.getNetworkCapabilities(active);
        return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }

    private void setStatusMessage(String title, String detail, String titleHex) {
        statusTitle.setText(title);
        statusTitle.setTextColor(Color.parseColor(titleHex));
        statusDetail.setText(detail);
    }

    private Button createSecondarySmallButton(String label) {
        Button b = new Button(this);
        b.setAllCaps(false);
        b.setText(label);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        b.setTextColor(Color.parseColor("#E5E7EB"));
        b.setPadding(dp(10), dp(6), dp(10), dp(6));
        b.setMinHeight(0);
        b.setMinimumHeight(0);
        b.setMinWidth(0);
        b.setMinimumWidth(0);
        b.setBackground(roundedRect("#1F2937", "#374151", 8));
        return b;
    }

    private GradientDrawable roundedRect(String fillHex, String strokeHex, int radiusDp) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(Color.parseColor(fillHex));
        d.setCornerRadius(dp(radiusDp));
        d.setStroke(dp(1), Color.parseColor(strokeHex));
        return d;
    }

    private int dp(int value) {
        return Math.round(TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP,
                value,
                getResources().getDisplayMetrics()
        ));
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (studioScreen != null && studioScreen.getVisibility() == View.VISIBLE) {
            if (studioWebView != null && studioWebView.canGoBack()) {
                studioWebView.goBack();
                return;
            }
            showSetupScreen();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        networkExecutor.shutdownNow();
        if (studioWebView != null) {
            studioWebView.stopLoading();
            studioWebView.destroy();
        }
        super.onDestroy();
    }
}
