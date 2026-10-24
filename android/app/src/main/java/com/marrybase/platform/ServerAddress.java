package com.marrybase.platform;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/**
 * Pure server-URL policy for the MARRY BASE companion app.
 *
 * <p>The native app owns connection setup and validation; every management
 * workflow runs inside the Management Studio served by the connected instance.
 * Keeping this logic free of Android APIs makes it verifiable with plain JUnit
 * tests in CI.</p>
 */
public final class ServerAddress {

    public enum Scheme { HTTPS, HTTP }

    private ServerAddress() {}

    /** Normalizes a user-entered address or throws IllegalArgumentException. */
    public static String normalize(String input) {
        String raw = input == null ? "" : input.trim();
        if (raw.isEmpty()) {
            throw new IllegalArgumentException("Enter the URL of your MARRY BASE server.");
        }
        if (raw.contains(" ")) {
            throw new IllegalArgumentException("Server URLs cannot contain spaces.");
        }
        if (raw.contains("://") && !raw.matches("(?i)^https?://.*")) {
            throw new IllegalArgumentException("Use an http:// or https:// server address.");
        }
        String withScheme = raw.matches("(?i)^https?://.*") ? raw : "https://" + raw;
        URI uri;
        try {
            uri = new URI(withScheme);
        } catch (URISyntaxException error) {
            throw new IllegalArgumentException("That address is not a valid URL.");
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (!"http".equals(scheme) && !"https".equals(scheme)) {
            throw new IllegalArgumentException("Use an http:// or https:// server address.");
        }
        if (uri.getHost() == null || uri.getHost().isEmpty()) {
            throw new IllegalArgumentException("Include the host name or IP address, for example https://api.example.com.");
        }
        if (uri.getUserInfo() != null) {
            throw new IllegalArgumentException("Remove credentials from the URL. Sign in inside the Studio instead.");
        }
        if (uri.getQuery() != null || uri.getFragment() != null) {
            throw new IllegalArgumentException("Use the server address without a query string or fragment.");
        }
        if (uri.getPort() != -1 && (uri.getPort() < 1 || uri.getPort() > 65535)) {
            throw new IllegalArgumentException("That port number is not valid.");
        }
        String path = uri.getPath() == null ? "" : uri.getPath();
        path = path.replaceAll("/+$", "");
        if (path.endsWith("/dashboard")) {
            path = path.substring(0, path.length() - "/dashboard".length());
        }
        if (path.endsWith("/index.html")) {
            path = path.substring(0, path.length() - "/index.html".length());
        }
        if (!path.isEmpty() && !path.matches("/[A-Za-z0-9._~\\-/]*")) {
            throw new IllegalArgumentException("The server path may only contain letters, digits, dots, dashes, underscores, and slashes.");
        }
        if (scheme.equals("http") && !isPrivateHost(uri.getHost())) {
            throw new IllegalArgumentException(
                "Plain HTTP is only allowed for local or private-network servers. Use HTTPS for " + uri.getHost() + ".");
        }
        StringBuilder builder = new StringBuilder(scheme).append("://").append(uri.getHost());
        if (uri.getPort() != -1) {
            builder.append(':').append(uri.getPort());
        }
        builder.append(path);
        return builder.toString();
    }

    public static Scheme schemeOf(String normalizedUrl) {
        return normalizedUrl.toLowerCase(Locale.ROOT).startsWith("http://") ? Scheme.HTTP : Scheme.HTTPS;
    }

    /** True for loopback, emulator loopback, RFC1918 and link-local addresses. */
    public static boolean isPrivateHost(String host) {
        if (host == null) return false;
        String value = host.toLowerCase(Locale.ROOT);
        if (value.equals("localhost") || value.equals("::1") || value.equals("[::1]")) return true;
        if (value.equals("10.0.2.2") || value.equals("10.0.3.2")) return true; // Android emulator host loopback
        if (!value.matches("[0-9.]+")) return false;
        String[] parts = value.split("\\.");
        if (parts.length != 4) return false;
        int[] octets = new int[4];
        try {
            for (int i = 0; i < 4; i++) {
                octets[i] = Integer.parseInt(parts[i]);
                if (octets[i] < 0 || octets[i] > 255) return false;
            }
        } catch (NumberFormatException error) {
            return false;
        }
        if (octets[0] == 127) return true;
        if (octets[0] == 10) return true;
        if (octets[0] == 192 && octets[1] == 168) return true;
        if (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31) return true;
        if (octets[0] == 169 && octets[1] == 254) return true;
        return false;
    }

    public static String studioUrl(String normalizedServerUrl) {
        return normalizedServerUrl + "/dashboard";
    }

    public static String readyUrl(String normalizedServerUrl) {
        return normalizedServerUrl + "/ready";
    }

    public static String platformUrl(String normalizedServerUrl) {
        return normalizedServerUrl + "/v1/platform/status";
    }
}
