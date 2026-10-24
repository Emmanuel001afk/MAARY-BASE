package com.marrybase.platform;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Performs the connection check used before opening the Studio.
 *
 * <p>It calls the server's {@code /ready} endpoint and reports what the server
 * itself says about its dependencies. A server that answers but is not ready is
 * surfaced as a configuration problem instead of being treated as reachable.</p>
 */
public final class ConnectionProbe {

    public static final class Result {
        public final boolean ready;
        public final String message;
        public final String details;
        public final String version;

        Result(boolean ready, String message, String details, String version) {
            this.ready = ready;
            this.message = message;
            this.details = details;
            this.version = version;
        }
    }

    private ConnectionProbe() {}

    public static Result probe(String normalizedServerUrl) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(ServerAddress.readyUrl(normalizedServerUrl));
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(8_000);
            connection.setReadTimeout(10_000);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("User-Agent", "MARRY-BASE-Android");
            int status = connection.getResponseCode();
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String body = readFully(stream);
            if (status == HttpURLConnection.HTTP_NOT_FOUND) {
                return new Result(false,
                    "This address does not look like a MARRY BASE server.",
                    "/ready returned 404. Check the host, port, and path.", null);
            }
            if (status == 401 || status == 403) {
                return new Result(false,
                    "The server rejected the health check.",
                    "HTTP " + status + " from /ready. Check any reverse-proxy access rules.", null);
            }
            JSONObject json = null;
            try {
                json = new JSONObject(body);
            } catch (Exception ignored) {
                // Handled below: a non-JSON response is not a MARRY BASE server.
            }
            if (json == null) {
                return new Result(false,
                    "The server responded, but not with MARRY BASE status information.",
                    "Expected JSON from /ready. Check that you are using the API port, not another service.", null);
            }
            String state = json.optString("status", "");
            JSONObject dependencies = json.optJSONObject("dependencies");
            StringBuilder detail = new StringBuilder();
            if (dependencies != null) {
                detail.append("Database: ").append(dependencies.optString("postgres", "unknown"));
                detail.append(" · Migrations: ").append(dependencies.optString("migrations", "unknown"));
                detail.append(" · Storage: ").append(dependencies.optString("storage", "unknown"));
            }
            JSONObject worker = json.optJSONObject("worker");
            if (worker != null) {
                detail.append(" · Worker: ").append(worker.optBoolean("running") ? "running" : "stopped");
            }
            String version = json.optString("version", null);
            if ("ready".equals(state)) {
                return new Result(true, "Server is ready.", detail.toString(), version);
            }
            if (status == HttpURLConnection.HTTP_UNAVAILABLE || "not_ready".equals(state)) {
                return new Result(false,
                    "The server is running but is not ready yet.",
                    detail.toString(), version);
            }
            return new Result(false,
                "Unexpected response from the server.",
                "HTTP " + status + " · " + (detail.length() > 0 ? detail.toString() : body), version);
        } catch (java.net.SocketTimeoutException error) {
            return new Result(false, "The server did not respond in time.",
                "Check that the server is running and reachable from this device.", null);
        } catch (java.net.UnknownHostException error) {
            return new Result(false, "This host name could not be resolved.",
                "Check the address and your network connection.", null);
        } catch (javax.net.ssl.SSLException error) {
            return new Result(false, "The secure connection could not be established.",
                "The server's certificate was rejected. Use a valid certificate or a private HTTP address for local development.", null);
        } catch (IOException error) {
            return new Result(false, "The server could not be reached.",
                String.valueOf(error.getMessage()), null);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static String readFully(InputStream stream) throws IOException {
        if (stream == null) return "";
        try (InputStream input = stream) {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1 && output.size() < 262_144) {
                output.write(buffer, 0, read);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }
}
