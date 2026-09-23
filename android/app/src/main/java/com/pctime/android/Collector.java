package com.pctime.android;

import android.app.AppOpsManager;
import android.app.usage.UsageEvents;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.os.Process;
import org.json.JSONObject;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;

final class Collector {
    static boolean allowed(Context context) {
        AppOpsManager ops = (AppOpsManager) context.getSystemService(Context.APP_OPS_SERVICE);
        return ops != null && ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.getPackageName()) == AppOpsManager.MODE_ALLOWED;
    }
    static void collect(Context context, LocalStore store) throws Exception {
        if (!allowed(context)) return;
        long now = System.currentTimeMillis(); ZoneId zone = ZoneId.systemDefault();
        JSONObject previous = store.read();
        long oldest = LocalDate.now(zone).minusDays(6).atStartOfDay(zone).toInstant().toEpochMilli();
        long cursor = previous.optLong("cursor", oldest);
        if (!UsageIntervals.canAdvance(cursor, now)) {
            store.warning("系统时间已回拨；为避免重复计时，将等待时间追上已记录位置后继续。");
            return;
        }
        boolean truncated = cursor < oldest;
        UsageIntervals.State state = new UsageIntervals.State();
        if (cursor >= oldest && now - cursor < 86400000L && cursor <= now) {
            state.active = previous.isNull("active") ? null : previous.optString("active", null);
            state.activeActivity = previous.isNull("activeActivity") ? null : previous.optString("activeActivity", null);
            state.interactive = previous.optBoolean("interactive", true); state.unlocked = previous.optBoolean("unlocked", true);
            state.powered = previous.optBoolean("powered", true);
        }
        cursor = Math.max(oldest, cursor);
        UsageStatsManager manager = (UsageStatsManager) context.getSystemService(Context.USAGE_STATS_SERVICE);
        UsageEvents events = manager.queryEvents(cursor, now);
        if (events == null) throw new java.io.IOException("系统暂时无法提供使用记录，请解锁后重试");
        List<UsageIntervals.Event> input = new ArrayList<>();
        UsageEvents.Event event = new UsageEvents.Event();
        while (events.hasNextEvent()) {
            events.getNextEvent(event);
            int type = event.getEventType();
            if (type == 1 || type == 2 || (type >= 15 && type <= 18) || type == 26 || type == 27)
                input.add(new UsageIntervals.Event(event.getTimeStamp(), type, event.getPackageName(), event.getClassName()));
        }
        UsageIntervals.Result result = UsageIntervals.reconstruct(input, cursor, now, zone, state, context.getPackageName());
        store.record(result, now, zone.getId(), Instant.ofEpochMilli(now).atZone(zone).toLocalDate().toString(), truncated);
    }
}
