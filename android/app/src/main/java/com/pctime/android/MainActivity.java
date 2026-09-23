package com.pctime.android;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.DatePickerDialog;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.view.View;
import android.view.WindowInsets;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;

public final class MainActivity extends Activity {
    private static final int BG = Color.rgb(245,247,249), TEXT = Color.rgb(23,39,56), MUTED = Color.rgb(98,113,129),
            BLUE = Color.rgb(20,125,158), SOFT = Color.rgb(234,244,248), YELLOW = Color.rgb(244,204,57), CORAL = Color.rgb(244,129,88);
    private AppManager manager;
    private LinearLayout body, appRows, deviceRows, accountCard;
    private TextView total, totalLabel, status, permissionStatus, scope, accountLabel;
    private Button dateButton, syncButton, loginButton, registerButton;
    private Spinner devices;
    private final List<String> deviceIds = new ArrayList<>();
    private JSONArray knownDevices = new JSONArray();
    private LocalDate date = LocalDate.now();
    private String deviceId = "local", renderedAccount = null;
    private boolean busy, updatingSpinner, signedIn;
    private int generation;
    private EditText serverField, emailField, passwordField, nameField;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state); manager = AppManager.get(this);
        if (state != null) { try { date = LocalDate.parse(state.getString("date", date.toString())); } catch (Exception ignored) { } deviceId = state.getString("device", "local"); }
        build(); SyncJob.schedule(this);
    }
    @Override protected void onResume() { super.onResume(); updatePermission(); if (!busy) refresh(true); }
    @Override protected void onSaveInstanceState(Bundle state) { super.onSaveInstanceState(state); state.putString("date", date.toString()); state.putString("device", deviceId); }
    @Override protected void onDestroy() { generation++; super.onDestroy(); }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private GradientDrawable background(int color, int radius) { GradientDrawable drawable = new GradientDrawable(); drawable.setColor(color); drawable.setCornerRadius(dp(radius)); return drawable; }
    private LinearLayout column() { LinearLayout view = new LinearLayout(this); view.setOrientation(LinearLayout.VERTICAL); return view; }
    private LinearLayout card(int color) {
        LinearLayout view = column(); view.setPadding(dp(18), dp(18), dp(18), dp(18)); view.setBackground(background(color, 16));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.setMargins(0, 0, 0, dp(16)); view.setLayoutParams(params); return view;
    }
    private TextView text(String value, int size, int color, boolean bold) {
        TextView view = new TextView(this); view.setText(value); view.setTextSize(size); view.setTextColor(color);
        view.setLineSpacing(dp(3), 1); if (bold) view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.setMargins(0, 0, 0, dp(8)); view.setLayoutParams(params); return view;
    }
    private Button button(String value, boolean primary) {
        Button view = new Button(this); view.setText(value); view.setTextSize(14); view.setAllCaps(false);
        view.setMinHeight(dp(48)); view.setPadding(dp(12), dp(8), dp(12), dp(8));
        view.setTextColor(primary ? Color.WHITE : BLUE); view.setBackgroundTintList(android.content.res.ColorStateList.valueOf(primary ? BLUE : SOFT));
        return view;
    }
    private void build() {
        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true); scroll.setBackgroundColor(BG);
        body = column(); body.setPadding(dp(20), dp(22), dp(20), dp(28)); scroll.addView(body);
        LinearLayout wrapper = column(); wrapper.setBackgroundColor(BG); wrapper.addView(scroll); setContentView(wrapper);
        wrapper.setOnApplyWindowInsetsListener((view, insets) -> {
            int top, bottom;
            if (Build.VERSION.SDK_INT >= 30) { android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime()); top = bars.top; bottom = bars.bottom; }
            else { top = insets.getSystemWindowInsetTop(); bottom = insets.getSystemWindowInsetBottom(); }
            view.setPadding(0, top, 0, bottom); return insets;
        });
        body.addView(text("PCTime", 29, TEXT, true)); body.addView(text("手机与电脑的时间，放在一起看。", 14, MUTED, false));

        LinearLayout hero = card(SOFT); totalLabel = text("本机 · 累计使用", 14, TEXT, false); hero.addView(totalLabel);
        total = text("—", 36, TEXT, true); hero.addView(total);
        scope = text("加载本地记录…", 13, MUTED, false); hero.addView(scope); body.addView(hero);

        LinearLayout filters = card(Color.WHITE); filters.addView(text("日期与设备", 17, TEXT, true));
        dateButton = button(date.toString() + "  ▾", false); filters.addView(dateButton);
        dateButton.setOnClickListener(view -> {
            DatePickerDialog picker = new DatePickerDialog(this, (control, year, month, day) -> { date = LocalDate.of(year, month + 1, day); dateButton.setText(date + "  ▾"); refresh(false); }, date.getYear(), date.getMonthValue() - 1, date.getDayOfMonth());
            picker.getDatePicker().setMaxDate(System.currentTimeMillis()); picker.show();
        });
        filters.addView(text("设备范围", 13, MUTED, false)); devices = new Spinner(this); devices.setMinimumHeight(dp(48)); filters.addView(devices);
        devices.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                if (updatingSpinner || position >= deviceIds.size()) return;
                String selected = deviceIds.get(position); if (!selected.equals(deviceId)) { deviceId = selected; refresh(false); }
            }
            @Override public void onNothingSelected(AdapterView<?> parent) { }
        });
        syncButton = button("刷新并同步", true); filters.addView(syncButton); syncButton.setOnClickListener(view -> refresh(true));
        status = text("", 13, MUTED, false); status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); filters.addView(status); body.addView(filters);

        LinearLayout access = card(Color.WHITE); access.addView(text("使用记录权限", 17, TEXT, true)); permissionStatus = text("", 13, MUTED, false); access.addView(permissionStatus);
        Button grant = button("打开使用情况访问权限", false); access.addView(grant); grant.setOnClickListener(view -> {
            try { startActivity(new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS, Uri.parse("package:" + getPackageName()))); }
            catch (Exception error) { startActivity(new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)); }
        });
        access.addView(text("只统计前台应用时长，排除灭屏、锁屏与 PCTime 自身。不读取屏幕内容，不使用无障碍服务。", 12, MUTED, false)); body.addView(access, 2);

        LinearLayout deviceCard = card(Color.WHITE); deviceCard.addView(text("设备贡献", 17, TEXT, true)); deviceRows = column(); deviceCard.addView(deviceRows); body.addView(deviceCard);
        LinearLayout apps = card(Color.WHITE); apps.addView(text("应用使用明细", 17, TEXT, true)); apps.addView(text("点击应用查看各设备贡献。", 12, MUTED, false)); appRows = column(); apps.addView(appRows); body.addView(apps);
        accountCard = card(Color.WHITE); body.addView(accountCard);
        LinearLayout note = card(Color.rgb(255,246,214)); note.addView(text("后台同步与离线记录", 15, TEXT, true));
        note.addView(text("后台任务约每 15 分钟尝试运行，系统省电策略可能延后；打开应用或手动同步会刷新记录。长期不运行时，系统可能清理旧事件，无法补回。", 12, TEXT, false));
        note.addView(text("上传内容只有每天每个应用的时长与设备信息，不含窗口标题、浏览记录或密码。退出账号后停止上传，本机统计仍保留。", 12, TEXT, false)); body.addView(note);
        updateAccount(); updateDeviceOptions();
    }
    private void updatePermission() { permissionStatus.setText(Collector.allowed(this) ? "已授权 · 可读取系统应用使用事件" : "尚未授权 · 点击下方按钮，在系统页面为 PCTime 开启权限"); permissionStatus.setTextColor(Collector.allowed(this) ? BLUE : Color.rgb(161,62,32)); }
    private EditText field(LinearLayout container, String label, String hint, int type) {
        TextView title = text(label, 13, MUTED, false); container.addView(title);
        EditText edit = new EditText(this); edit.setTextSize(14); edit.setTextColor(TEXT); edit.setHintTextColor(MUTED); edit.setSingleLine(true); edit.setInputType(type); edit.setHint(hint);
        edit.setPadding(dp(10), dp(8), dp(10), dp(8)); edit.setMinimumHeight(dp(48)); edit.setBackgroundTintList(android.content.res.ColorStateList.valueOf(BLUE));
        edit.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO); container.addView(edit);
        edit.setId(View.generateViewId()); title.setLabelFor(edit.getId()); return edit;
    }
    private void updateAccount() {
        try {
            JSONObject state = manager.state(); signedIn = state.optBoolean("signedIn"); String key = accountKey(state);
            if (key.equals(renderedAccount)) return; renderedAccount = key; accountCard.removeAllViews();
            knownDevices = new JSONArray(); deviceId = state.optBoolean("signedIn") ? "" : "local";
            total.setText("—"); totalLabel.setText(date + " · 等待刷新"); scope.setText("账号已更新，正在读取当前范围的记录。");
            appRows.removeAllViews(); deviceRows.removeAllViews();
            updateDeviceOptions();
            accountCard.addView(text("跨设备同步 · 可选", 17, TEXT, true));
            if (state.optBoolean("signedIn")) {
                accountLabel = text(state.getString("email") + "\n" + state.getString("server"), 14, TEXT, false); accountCard.addView(accountLabel);
                accountCard.addView(text("设备名称：" + state.getString("deviceName"), 13, MUTED, false));
                Button logout = button("退出账号", false); accountCard.addView(logout); logout.setOnClickListener(view -> new AlertDialog.Builder(this).setTitle("退出当前账号？")
                        .setMessage("停止上传并清除本机登录凭据；已经记录的本机时长仍会保留。")
                        .setNegativeButton("取消", null).setPositiveButton("退出", (dialog, which) -> {
                            generation++; manager.logout((value, error) -> { setBusy(false); deviceId = "local"; knownDevices = new JSONArray(); updateAccount(); updateDeviceOptions(); if (error != null) showError(error); else refresh(false); });
                        }).show());
            } else {
                accountCard.addView(text("本机统计无需账号，开启上方权限即可开始。统一在线同步尚未开放，服务上线后登录即可汇总手机与电脑。", 12, MUTED, false));
                Button advanced = button("高级设置 · 连接已有服务", false); accountCard.addView(advanced);
                LinearLayout accountForm = column(); accountForm.setVisibility(View.GONE); accountCard.addView(accountForm);
                advanced.setOnClickListener(view -> { boolean expand = accountForm.getVisibility() != View.VISIBLE; accountForm.setVisibility(expand ? View.VISIBLE : View.GONE); advanced.setText(expand ? "收起连接设置" : "高级设置 · 连接已有服务"); });
                serverField = field(accountForm, "服务器地址", "http://192.168.1.10:4318", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
                serverField.setText(getPreferences(MODE_PRIVATE).getString("server", ""));
                emailField = field(accountForm, "邮箱", "you@example.com", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
                passwordField = field(accountForm, "密码", "10–128 个字符", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
                passwordField.setSaveEnabled(false);
                nameField = field(accountForm, "此设备名称", "例如：我的手机", InputType.TYPE_CLASS_TEXT); nameField.setText(Build.MANUFACTURER + " " + Build.MODEL);
                loginButton = button("登录", true); registerButton = button("创建账号", false); accountForm.addView(loginButton); accountForm.addView(registerButton);
                loginButton.setOnClickListener(view -> login(false)); registerButton.setOnClickListener(view -> login(true));
                if (state.optString("error", "").contains("清理")) {
                    accountCard.addView(text(state.getString("error"), 13, Color.rgb(161,62,32), false));
                    Button retry = button("重试清除登录信息", false); accountCard.addView(retry);
                    retry.setOnClickListener(view -> manager.logout((value, error) -> { if (error != null) showError(error); else { renderedAccount = null; updateAccount(); status.setText("登录信息已清除，本机记录仍保留。"); } }));
                }
            }
        } catch (Exception error) { status.setText("账号信息读取失败，请重试"); }
    }
    private String accountKey(JSONObject state) throws Exception {
        return state.optBoolean("signedIn") ? state.getString("server") + "|" + state.getString("userId") : "signed-out";
    }
    private void login(boolean register) {
        if (busy) return;
        String origin = serverField.getText().toString(), email = emailField.getText().toString(), password = passwordField.getText().toString(), name = nameField.getText().toString();
        setBusy(true); status.setText(register ? "正在创建账号…" : "正在登录…"); int request = ++generation;
        manager.authenticate(origin, email, password, name, register, (state, error) -> {
            if (request != generation || isDestroyed()) return;
            setBusy(false); passwordField.setText("");
            if (error != null) { showError(error); return; }
            getPreferences(MODE_PRIVATE).edit().putString("server", origin.trim()).apply(); deviceId = ""; updateAccount(); refresh(true);
        });
    }
    private void setBusy(boolean value) {
        busy = value; syncButton.setEnabled(!value); dateButton.setEnabled(!value); devices.setEnabled(!value);
        if (loginButton != null) loginButton.setEnabled(!value); if (registerButton != null) registerButton.setEnabled(!value);
        syncButton.setText(value ? "正在处理…" : signedIn ? "刷新并同步" : "刷新记录");
    }
    private void refresh(boolean upload) {
        if (busy) return; setBusy(true); updatePermission(); status.setText("正在读取 " + date + "…"); status.setTextColor(MUTED);
        int request = ++generation; String requestedDate = date.toString(), requestedDevice = deviceId;
        manager.dashboard(requestedDate, requestedDevice, upload, (result, error) -> {
            if (request != generation || isDestroyed()) return;
            setBusy(false); updateAccount();
            if (error != null) { total.setText("—"); totalLabel.setText(date + " · 暂无法读取"); scope.setText("可切换“本机离线记录”查看已保存的时长。"); appRows.removeAllViews(); deviceRows.removeAllViews(); showError(error); updateDeviceOptions(); return; }
            try {
                if (!accountKey(result.getJSONObject("state")).equals(accountKey(manager.state()))) { refresh(false); return; }
                JSONArray incoming = result.getJSONArray("devices"); if (incoming.length() > 0) knownDevices = incoming;
                updateDeviceOptions(); renderSummary(result.getJSONObject("summary"));
                String warning = result.optString("warning", "");
                String synced = result.getJSONObject("state").optString("lastSync", "");
                String freshness = synced.isEmpty() || synced.equals("null") ? "" : "\n本机最近同步：" + displayTime(synced);
                status.setText((warning.isEmpty() ? (upload && signedIn ? "记录已刷新，并同步到账号。" : "本机记录已更新。") : warning) + freshness);
                status.setTextColor(warning.isEmpty() ? BLUE : Color.rgb(161,62,32));
            } catch (Exception invalid) { showError(new Exception("服务器数据格式不正确，请重试")); }
        });
    }
    private void showError(Exception error) { status.setText(error.getMessage() == null ? "操作失败，请检查网络后重试" : error.getMessage()); status.setTextColor(Color.rgb(161,62,32)); }
    private void updateDeviceOptions() {
        try {
            boolean signedIn = manager.state().optBoolean("signedIn");
            List<String> labels = new ArrayList<>(); deviceIds.clear();
            if (signedIn) { deviceIds.add(""); labels.add("全部设备 · 时长相加"); }
            deviceIds.add("local"); labels.add("本机离线记录");
            if (signedIn) for (int i = 0; i < knownDevices.length(); i++) { JSONObject device = knownDevices.getJSONObject(i); deviceIds.add(device.getString("id")); labels.add(device.getString("name") + " · " + platform(device.optString("platform"))); }
            if (!deviceIds.contains(deviceId)) deviceId = "local";
            updatingSpinner = true; ArrayAdapter<String> adapter = new ArrayAdapter<>(this, android.R.layout.simple_spinner_item, labels); adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
            devices.setAdapter(adapter); devices.setSelection(deviceIds.indexOf(deviceId)); devices.post(() -> updatingSpinner = false);
        } catch (Exception error) { showError(error); }
    }
    private String platform(String value) { return value.equals("windows") ? "电脑" : "手机"; }
    private String displayTime(String value) {
        try { return java.time.Instant.parse(value).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("MM-dd HH:mm")); }
        catch (Exception ignored) { return "暂无同步时间"; }
    }
    private String duration(long ms) { long minutes = Math.max(0, ms) / 60000; return minutes >= 60 ? minutes / 60 + " 小时 " + minutes % 60 + " 分钟" : minutes + " 分钟"; }
    private void renderSummary(JSONObject summary) throws Exception {
        boolean local = summary.optString("metric").equals("local");
        total.setText(duration(summary.getLong("totalMs"))); totalLabel.setText(summary.getString("date") + (local ? " · 本机离线记录" : deviceId.isEmpty() ? " · 全部设备" : " · 所选设备"));
        scope.setText(local ? "来自这部手机的系统事件；不含其他设备。" : "各设备时长直接相加；两台设备各用 10 分钟，合计 20 分钟。日期采用各设备的本地日期。");
        deviceRows.removeAllViews(); JSONArray contributions = summary.getJSONArray("devices");
        for (int i = 0; i < contributions.length(); i++) {
            JSONObject device = contributions.getJSONObject(i);
            String synced = device.optString("lastSyncedAt", "");
            String freshness = local ? "" : "\n最近同步：" + displayTime(synced);
            deviceRows.addView(text(device.getString("name") + " · " + platform(device.optString("platform")) + "\n" + duration(device.getLong("totalMs")) + freshness, 14, TEXT, false));
        }
        if (contributions.length() == 0) deviceRows.addView(text("这个日期还没有已同步的设备记录。", 13, MUTED, false));
        appRows.removeAllViews(); JSONArray apps = summary.getJSONArray("apps");
        if (apps.length() == 0) appRows.addView(text("此日期暂无记录。授予使用记录权限后，使用其他应用，再回来刷新。", 13, MUTED, false));
        for (int i = 0; i < apps.length(); i++) {
            JSONObject app = apps.getJSONObject(i); LinearLayout row = column(); row.setPadding(0, dp(4), 0, dp(8));
            Button title = button(app.getString("name") + "   " + duration(app.getLong("totalMs")) + "  ▾", false); title.setGravity(android.view.Gravity.START | android.view.Gravity.CENTER_VERTICAL); row.addView(title);
            JSONArray details = app.optJSONArray("devices"); StringBuilder content = new StringBuilder();
            if (local) content.append("本机 · ").append(duration(app.getLong("totalMs"))).append("\n").append(app.getString("canonicalId"));
            else if (details != null) for (int j = 0; j < details.length(); j++) { JSONObject item = details.getJSONObject(j); if (j > 0) content.append('\n'); content.append(item.getString("name")).append(" · ").append(platform(item.optString("platform"))).append("  ").append(duration(item.getLong("totalMs"))); }
            TextView expanded = text(content.length() == 0 ? "暂无设备明细" : content.toString(), 13, MUTED, false); expanded.setPadding(dp(10), dp(10), dp(10), dp(10)); expanded.setVisibility(View.GONE); row.addView(expanded);
            title.setOnClickListener(view -> { boolean open = expanded.getVisibility() != View.VISIBLE; expanded.setVisibility(open ? View.VISIBLE : View.GONE); title.setContentDescription(app.optString("name") + (open ? "，已展开设备贡献" : "，已收起")); });
            appRows.addView(row);
        }
    }
}
