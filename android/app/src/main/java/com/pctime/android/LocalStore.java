package com.pctime.android;

import android.content.Context;
import android.util.AtomicFile;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.UUID;

final class LocalStore {
    private final AtomicFile file;
    LocalStore(Context context) { file = new AtomicFile(new File(context.getFilesDir(), "daily-usage.json")); }
    synchronized JSONObject read() throws Exception {
        try { return new JSONObject(new String(file.readFully(), StandardCharsets.UTF_8)); }
        catch (java.io.FileNotFoundException error) {
            // openRead/readFully restores AtomicFile's legacy .bak after an interrupted write.
            File base = file.getBaseFile();
            if (base.exists() || new File(base.getPath() + ".bak").exists() || new File(base.getPath() + ".new").exists()) throw error;
            JSONObject initial = new JSONObject().put("clientId", UUID.randomUUID().toString()).put("revision", 0)
                    .put("days", new JSONObject()).put("acks", new JSONObject());
            write(initial); return initial;
        }
    }
    private void write(JSONObject state) throws Exception {
        FileOutputStream output = null;
        try { output = file.startWrite(); output.write(state.toString().getBytes(StandardCharsets.UTF_8)); file.finishWrite(output); }
        catch (Exception error) { if (output != null) file.failWrite(output); throw error; }
    }
    synchronized void record(UsageIntervals.Result result, long cursor, String zone, String today, boolean truncated) throws Exception {
        JSONObject root = read(), days = root.getJSONObject("days");
        if (cursor < root.optLong("cursor")) throw new java.io.IOException("系统时间回拨，已保留原有记录位置");
        if (!days.has(today)) result.days.putIfAbsent(today, new java.util.LinkedHashMap<>());
        for (Map.Entry<String, Map<String, Long>> dayEntry : result.days.entrySet()) {
            JSONObject day = days.optJSONObject(dayEntry.getKey());
            if (day == null) day = new JSONObject().put("timeZone", zone).put("apps", new JSONObject());
            JSONObject apps = day.getJSONObject("apps");
            long dailyTotal = 0; for (Iterator<String> it = apps.keys(); it.hasNext();) dailyTotal += apps.optLong(it.next());
            for (Map.Entry<String, Long> entry : dayEntry.getValue().entrySet()) {
                if (!apps.has(entry.getKey()) && apps.length() >= 2000) {
                    root.put("collectionWarning", "当日应用数量超过 2000，超出部分未记录；已有时长仍保留。");
                    continue;
                }
                long delta = Math.max(0, Math.min(entry.getValue(), 90000000L - dailyTotal));
                apps.put(entry.getKey(), apps.optLong(entry.getKey()) + delta); dailyTotal += delta;
            }
            long revision = root.optLong("revision") + 1;
            if (revision >= 9007199254740991L) throw new java.io.IOException("本地同步版本超出范围");
            root.put("revision", revision); day.put("revision", revision); days.put(dayEntry.getKey(), day);
        }
        root.put("cursor", cursor).put("timeZone", zone).put("active", result.state.active == null ? JSONObject.NULL : result.state.active)
                .put("activeActivity", result.state.activeActivity == null ? JSONObject.NULL : result.state.activeActivity)
                .put("interactive", result.state.interactive).put("unlocked", result.state.unlocked).put("powered", result.state.powered);
        if (truncated) root.put("collectionWarning", "长期不运行时系统可能清理旧事件，部分历史无法补回；已有记录已保留。");
        write(root);
    }
    synchronized void warning(String message) throws Exception {
        JSONObject root = read();
        if (!message.equals(root.optString("collectionWarning"))) { root.put("collectionWarning", message); write(root); }
    }
    synchronized void acknowledge(String account, String date, long revision) throws Exception {
        JSONObject root = read(), acks = root.getJSONObject("acks");
        JSONObject accountAcks = acks.optJSONObject(account); if (accountAcks == null) accountAcks = new JSONObject();
        accountAcks.put(date, Math.max(accountAcks.optLong(date), revision)); acks.put(account, accountAcks); write(root);
    }
    synchronized List<String> pending(String account) throws Exception {
        JSONObject root = read(), days = root.getJSONObject("days"), acks = root.getJSONObject("acks").optJSONObject(account);
        List<String> result = new ArrayList<>();
        for (Iterator<String> it = days.keys(); it.hasNext();) { String date = it.next(); if (acks == null || acks.optLong(date) < days.getJSONObject(date).getLong("revision")) result.add(date); }
        Collections.sort(result); return result;
    }
    synchronized JSONObject localSummary(String date, String name) throws Exception {
        JSONObject day = read().getJSONObject("days").optJSONObject(date);
        JSONObject applications = day == null ? new JSONObject() : day.getJSONObject("apps");
        JSONArray apps = new JSONArray(); long total = 0;
        for (Iterator<String> it = applications.keys(); it.hasNext();) {
            String id = it.next(); long time = applications.getLong(id); total += time;
            apps.put(new JSONObject().put("canonicalId", id).put("name", id).put("totalMs", time).put("devices", new JSONArray()));
        }
        return new JSONObject().put("date", date).put("metric", "local").put("totalMs", total).put("apps", apps)
                .put("devices", new JSONArray().put(new JSONObject().put("id", "local").put("name", name).put("platform", "android").put("totalMs", total)));
    }
}
