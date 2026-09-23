package com.pctime.android;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Pure event reconstruction. At most one foreground app owns any instant. */
public final class UsageIntervals {
    public static final int RESUME = 1, PAUSE = 2, SCREEN_ON = 15, SCREEN_OFF = 16,
            LOCK = 17, UNLOCK = 18, SHUTDOWN = 26, STARTUP = 27;
    public static final class Event {
        public final long time;
        public final int type;
        public final String app;
        public final String activity;
        public Event(long time, int type, String app) { this(time, type, app, null); }
        public Event(long time, int type, String app, String activity) { this.time = time; this.type = type; this.app = app; this.activity = activity; }
    }
    public static final class State {
        public String active, activeActivity;
        public boolean interactive = true, unlocked = true, powered = true;
        public State copy() { State s = new State(); s.active = active; s.activeActivity = activeActivity; s.interactive = interactive; s.unlocked = unlocked; s.powered = powered; return s; }
    }
    public static final class Result {
        public final Map<String, Map<String, Long>> days = new LinkedHashMap<>();
        public final State state;
        Result(State state) { this.state = state; }
    }
    private UsageIntervals() {}
    public static boolean canAdvance(long cursor, long now) { return now >= cursor; }

    public static Result reconstruct(List<Event> events, long from, long until, ZoneId zone, State initial, String ownPackage) {
        Result result = new Result(initial.copy());
        if (until <= from) return result;
        List<Event> ordered = new ArrayList<>(events);
        ordered.sort(Comparator.comparingLong(e -> e.time));
        long cursor = from;
        for (Event event : ordered) {
            if (event.time < from || event.time > until) continue;
            // An unmatched startup cannot close the previous app: shutdown time is unknown.
            if (event.type != STARTUP) accrue(result, cursor, event.time, zone);
            cursor = event.time;
            switch (event.type) {
                case RESUME:
                    result.state.active = !result.state.powered || event.app == null || event.app.equals(ownPackage) ? null : event.app;
                    result.state.activeActivity = event.activity;
                    break;
                case PAUSE:
                    if (event.app != null && event.app.equals(result.state.active) && (event.activity == null || result.state.activeActivity == null || event.activity.equals(result.state.activeActivity))) result.state.active = null;
                    break;
                case SCREEN_OFF:
                    result.state.interactive = false;
                    result.state.active = null;
                    break;
                case SCREEN_ON: result.state.interactive = true; break;
                case LOCK:
                    result.state.unlocked = false;
                    result.state.active = null;
                    break;
                case UNLOCK: result.state.unlocked = true; break;
                case SHUTDOWN: result.state.powered = false; result.state.active = null; break;
                case STARTUP: result.state.powered = true; result.state.active = null; break;
                default: break;
            }
        }
        accrue(result, cursor, until, zone);
        return result;
    }
    private static void accrue(Result result, long from, long until, ZoneId zone) {
        State state = result.state;
        if (state.active == null || !state.powered || !state.interactive || !state.unlocked) return;
        long cursor = from;
        while (cursor < until) {
            LocalDate date = Instant.ofEpochMilli(cursor).atZone(zone).toLocalDate();
            long midnight = date.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli();
            long end = Math.min(until, midnight);
            if (end <= cursor) break;
            Map<String, Long> apps = result.days.computeIfAbsent(date.toString(), ignored -> new LinkedHashMap<>());
            apps.merge(state.active, end - cursor, Long::sum);
            cursor = end;
        }
    }
}
