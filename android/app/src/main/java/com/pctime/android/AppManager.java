package com.pctime.android;

import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import org.json.JSONArray;
import org.json.JSONObject;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Iterator;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;

final class AppManager {
    interface Callback { void done(JSONObject value, Exception error); }
    // The constructor receives only the application context, never an Activity.
    @android.annotation.SuppressLint("StaticFieldLeak")
    private static AppManager instance;
    static synchronized AppManager get(Context context) { if (instance == null) instance = new AppManager(context.getApplicationContext()); return instance; }
    final Context context;
    final LocalStore store;
    final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final SessionVault vault;
    private final AtomicLong epoch = new AtomicLong();
    private volatile JSONObject session;
    private volatile Api activeApi;
    private volatile String lastSync, lastError;
    private AppManager(Context context) {
        this.context = context; store = new LocalStore(context); vault = new SessionVault(context);
        try { session = vault.load(); }
        catch (Exception error) {
            lastError = "安全会话无法读取，请重新登录；本地记录仍保留。";
            try { vault.clear(); } catch (Exception cleanup) { lastError = cleanup.getMessage(); }
        }
    }
    JSONObject state() throws Exception {
        JSONObject current = session;
        return new JSONObject().put("signedIn", current != null).put("email", current == null ? "" : current.getJSONObject("user").getString("email"))
                .put("server", current == null ? "" : current.getString("server"))
                .put("userId", current == null ? "" : current.getJSONObject("user").getString("id"))
                .put("deviceName", current == null ? Build.MANUFACTURER + " " + Build.MODEL : current.getJSONObject("device").getString("name"))
                .put("lastSync", lastSync == null ? JSONObject.NULL : lastSync).put("error", lastError == null ? JSONObject.NULL : lastError);
    }
    private void run(Callable<JSONObject> task, Callback callback) {
        worker.execute(() -> {
            JSONObject result = null; Exception failure = null;
            try { result = task.call(); } catch (Exception error) { failure = error; }
            JSONObject value = result; Exception error = failure;
            if (callback != null) main.post(() -> callback.done(value, error));
        });
    }
    private void current(long expected) throws Exception { if (expected != epoch.get()) throw new java.io.IOException("账号已切换，旧操作已取消"); }
    private Api authorized(JSONObject account) throws Exception { Api api = new Api(account.getString("server"), account.getString("token")); activeApi = api; return api; }
    void authenticate(String server, String email, String password, String name, boolean register, Callback callback) {
        long expected = epoch.incrementAndGet();
        run(() -> {
            current(expected);
            if (password.length() < 10 || password.length() > 128) throw new java.io.IOException("密码需为 10–128 个字符，空格不会被自动删除");
            String origin = Api.validateOrigin(server);
            Api api = new Api(origin, null); activeApi = api;
            current(expected);
            JSONObject result = api.request("POST", register ? "/v1/auth/register" : "/v1/auth/login", new JSONObject().put("email", email.trim()).put("password", password));
            JSONObject account = new JSONObject().put("server", origin).put("token", result.getString("token"))
                    .put("expiresAt", result.getString("expiresAt")).put("user", result.getJSONObject("user"));
            api = authorized(account);
            try {
                current(expected);
                JSONObject device = api.request("POST", "/v1/devices", new JSONObject().put("clientId", store.read().getString("clientId"))
                        .put("name", name.trim().isEmpty() ? Build.MODEL : name.trim()).put("platform", "android").put("timeZone", ZoneId.systemDefault().getId()));
                current(expected); account.put("device", device.getJSONObject("device"));
                synchronized (this) { current(expected); vault.save(account); session = account; lastError = null; }
                return state();
            } catch (Exception error) {
                try { new Api(origin, account.getString("token")).request("POST", "/v1/auth/logout", new JSONObject()); } catch (Exception ignored) { }
                throw error;
            } finally { activeApi = null; }
        }, callback);
    }
    void logout(Callback callback) {
        JSONObject previous; Exception cleanup = null;
        synchronized (this) {
            epoch.incrementAndGet(); previous = session; session = null; lastSync = null; lastError = null;
            try { vault.clear(); } catch (Exception error) { cleanup = error; lastError = error.getMessage(); }
        }
        Api current = activeApi; if (current != null) current.cancel();
        try { callback.done(state(), cleanup); } catch (Exception error) { callback.done(null, error); }
        if (previous != null) worker.execute(() -> {
            try { new Api(previous.getString("server"), previous.getString("token")).request("POST", "/v1/auth/logout", new JSONObject()); }
            catch (Exception ignored) { /* Offline logout still removes all local session credentials. */ }
        });
    }
    private void synchronize(long expected) throws Exception {
        Collector.collect(context, store); current(expected);
        JSONObject account = session; if (account == null) return;
        String accountKey = account.getString("server") + "|" + account.getJSONObject("user").getString("id");
        Api api = authorized(account);
        try {
            for (String date : store.pending(accountKey)) {
                current(expected);
                JSONObject day = store.read().getJSONObject("days").getJSONObject(date), apps = day.getJSONObject("apps");
                JSONArray records = new JSONArray();
                for (Iterator<String> it = apps.keys(); it.hasNext();) {
                    String source = it.next();
                    records.put(new JSONObject().put("sourceId", source).put("sourceName", uploadName(source)).put("totalMs", apps.getLong(source)));
                }
                long revision = day.getLong("revision");
                JSONObject response = api.request("PUT", "/v1/devices/" + account.getJSONObject("device").getString("id") + "/days/" + date,
                        new JSONObject().put("revision", revision).put("timeZone", day.getString("timeZone")).put("apps", records));
                current(expected);
                if (!(response.opt("accepted") instanceof Boolean) || response.getLong("revision") != revision)
                    throw new java.io.IOException("设备同步版本冲突；本机数据已保留。请检查是否复制或恢复过此设备的数据目录。");
                store.acknowledge(accountKey, date, revision);
            }
            current(expected); lastSync = java.time.Instant.now().toString(); lastError = null;
        } catch (Api.Failure error) {
            if (error.status == 401 && expected == epoch.get()) {
                synchronized (this) { epoch.incrementAndGet(); session = null; vault.clear(); }
                throw new java.io.IOException("登录已过期，请重新登录；本地记录仍保留");
            }
            throw error;
        } finally { activeApi = null; }
    }
    void background(Callback callback) {
        long expected = epoch.get();
        run(() -> { synchronize(expected); return state(); }, callback);
    }
    String appName(String packageName) {
        try { return context.getPackageManager().getApplicationLabel(context.getPackageManager().getApplicationInfo(packageName, 0)).toString(); }
        catch (Exception ignored) { return packageName; }
    }
    private String uploadName(String packageName) {
        String name = appName(packageName).replaceAll("[\\p{Cc}]", " ").trim();
        if (name.isEmpty()) name = packageName;
        if (name.length() > 200) name = name.substring(0, Character.isHighSurrogate(name.charAt(199)) ? 199 : 200);
        return name;
    }
    void dashboard(String date, String deviceId, boolean upload, Callback callback) {
        long expected = epoch.get();
        run(() -> {
            String warning = null;
            if (upload) {
                try { synchronize(expected); }
                catch (Exception error) {
                    if (expected != epoch.get() && session == null) throw error;
                    current(expected); warning = error.getMessage(); lastError = warning;
                }
            } else Collector.collect(context, store);
            current(expected);
            JSONObject account = session;
            JSONObject summary; JSONArray devices = new JSONArray();
            if (account == null || deviceId.equals("local")) {
                summary = store.localSummary(date, Build.MODEL);
                JSONArray apps = summary.getJSONArray("apps");
                for (int i = 0; i < apps.length(); i++) { JSONObject app = apps.getJSONObject(i); app.put("name", appName(app.getString("canonicalId"))); }
            } else {
                Api api = authorized(account);
                try {
                    devices = api.request("GET", "/v1/devices", null).getJSONArray("devices"); current(expected);
                    String path = "/v1/summary?date=" + date + (deviceId.isEmpty() ? "" : "&deviceId=" + URLEncoder.encode(deviceId, StandardCharsets.UTF_8.name()));
                    summary = api.request("GET", path, null); current(expected);
                } catch (Api.Failure error) {
                    if (error.status == 401 && expected == epoch.get()) {
                        synchronized (this) { epoch.incrementAndGet(); session = null; vault.clear(); }
                        throw new java.io.IOException("登录已过期，请重新登录");
                    }
                    throw error;
                } finally { activeApi = null; }
            }
            JSONArray raw = summary.getJSONArray("apps"); List<JSONObject> apps = new ArrayList<>();
            for (int i = 0; i < raw.length(); i++) apps.add(raw.getJSONObject(i));
            apps.sort(Comparator.comparingLong((JSONObject app) -> app.optLong("totalMs")).reversed());
            summary.put("apps", new JSONArray(apps));
            return new JSONObject().put("summary", summary).put("devices", devices).put("state", state())
                    .put("warning", warning == null ? store.read().optString("collectionWarning", "") : warning);
        }, callback);
    }
}
