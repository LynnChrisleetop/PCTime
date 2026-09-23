package com.pctime.android;

import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

final class Api {
    static final class Failure extends IOException {
        final int status;
        Failure(int status, String message) { super(message); this.status = status; }
    }
    final String origin;
    private final String token;
    private volatile HttpURLConnection active;
    private volatile boolean cancelled;
    Api(String origin, String token) throws Exception { this.origin = validateOrigin(origin); this.token = token; }
    static String validateOrigin(String value) throws Exception {
        URI uri = new URI(value.trim());
        String host = uri.getHost();
        if (host == null || uri.getScheme() == null || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null ||
                (uri.getPath() != null && !uri.getPath().isEmpty() && !uri.getPath().equals("/")) || uri.getPort() == 0 || uri.getPort() > 65535)
            throw new IOException("服务器只填写协议、地址与端口，不要添加路径、账号或查询参数");
        String scheme = uri.getScheme().toLowerCase(Locale.ROOT);
        if (!scheme.equals("https") && !(scheme.equals("http") && privateHost(host)))
            throw new IOException("公网服务器必须使用 HTTPS；HTTP 仅限本机或局域网 IP");
        return new URI(scheme, null, host, uri.getPort(), null, null, null).toString();
    }
    static boolean privateHost(String host) {
        String h = host.toLowerCase(Locale.ROOT).replace("[", "").replace("]", "");
        if (h.equals("localhost") || h.equals("::1")) return true;
        if (h.contains(":")) return h.matches("(?:fc|fd)[0-9a-f]{2}:[0-9a-f:]+") || h.matches("fe[89ab][0-9a-f]:[0-9a-f:]+");
        String[] parts = h.split("\\.");
        if (parts.length != 4) return false;
        int[] ip = new int[4];
        try { for (int i = 0; i < 4; i++) { if (!parts[i].matches("[0-9]{1,3}")) return false; ip[i] = Integer.parseInt(parts[i]); if (ip[i] > 255) return false; } }
        catch (NumberFormatException error) { return false; }
        return ip[0] == 127 || ip[0] == 10 || (ip[0] == 172 && ip[1] >= 16 && ip[1] <= 31) ||
                (ip[0] == 192 && ip[1] == 168) || (ip[0] == 169 && ip[1] == 254);
    }
    void cancel() { cancelled = true; HttpURLConnection current = active; if (current != null) current.disconnect(); }
    JSONObject request(String method, String path, JSONObject body) throws Exception {
        if (cancelled) throw new IOException("操作已取消");
        HttpURLConnection connection = (HttpURLConnection) new URL(origin + path).openConnection();
        active = connection;
        try {
            connection.setConnectTimeout(12000); connection.setReadTimeout(15000);
            connection.setInstanceFollowRedirects(false); connection.setRequestMethod(method);
            connection.setRequestProperty("Accept", "application/json");
            if (token != null) connection.setRequestProperty("Authorization", "Bearer " + token);
            if (body != null) {
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                if (bytes.length > 1024 * 1024) throw new IOException("同步数据过大");
                connection.setDoOutput(true); connection.setFixedLengthStreamingMode(bytes.length);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                try (var output = connection.getOutputStream()) { output.write(bytes); }
            }
            int status = connection.getResponseCode();
            String text;
            try (InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream()) {
                ByteArrayOutputStream output = new ByteArrayOutputStream(); byte[] chunk = new byte[8192];
                if (input != null) { int length; while ((length = input.read(chunk)) != -1) {
                    if (output.size() + length > 2 * 1024 * 1024) throw new IOException("服务器响应过大"); output.write(chunk, 0, length);
                } }
                text = output.toString(StandardCharsets.UTF_8.name());
            }
            if (cancelled) throw new IOException("操作已取消");
            JSONObject result;
            try { result = text.isEmpty() ? new JSONObject() : new JSONObject(text); }
            catch (Exception error) { throw new Failure(status, "服务器返回了无效 JSON，请检查服务器地址"); }
            if (status < 200 || status >= 300) {
                String message = result.optString("error", "服务器请求失败（" + status + "）");
                throw new Failure(status, message.length() > 300 ? message.substring(0, 300) : message);
            }
            return result;
        } finally { active = null; connection.disconnect(); }
    }
}
