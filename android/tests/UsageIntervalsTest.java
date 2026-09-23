import com.pctime.android.UsageIntervals;
import com.pctime.android.UsageIntervals.Event;
import com.pctime.android.UsageIntervals.State;
import java.time.Instant;
import java.time.ZoneId;
import java.util.List;

public final class UsageIntervalsTest {
    private static long t(String value) { return Instant.parse(value).toEpochMilli(); }
    private static long total(UsageIntervals.Result r, String date, String app) { return r.days.getOrDefault(date, java.util.Map.of()).getOrDefault(app, 0L); }
    private static void check(boolean ok, String message) { if (!ok) throw new AssertionError(message); }
    public static void main(String[] args) {
        ZoneId zone = ZoneId.of("Asia/Shanghai");
        long start = t("2026-09-23T15:59:50Z"), end = start + 20000;
        var midnight = UsageIntervals.reconstruct(List.of(new Event(start, 1, "a")), start, end, zone, new State(), "self");
        check(total(midnight, "2026-09-23", "a") == 10000 && total(midnight, "2026-09-24", "a") == 10000, "midnight split");
        start = t("2026-09-23T01:00:00Z"); end = start + 100000;
        var screen = UsageIntervals.reconstruct(List.of(new Event(start, 1, "a"), new Event(start + 10000, 16, null), new Event(start + 70000, 15, null), new Event(start + 75000, 18, null), new Event(start + 80000, 1, "a")), start, end, zone, new State(), "self");
        check(total(screen, "2026-09-23", "a") == 30000, "screen-off time excluded, no stale foreground on unlock");
        var locked = UsageIntervals.reconstruct(List.of(new Event(start, 1, "a"), new Event(start + 5000, 17, null), new Event(start + 10000, 1, "b"), new Event(start + 70000, 18, null)), start, end, zone, new State(), "self");
        check(total(locked, "2026-09-23", "a") == 5000 && total(locked, "2026-09-23", "b") == 30000, "locked interval excluded");
        var switches = UsageIntervals.reconstruct(List.of(new Event(start, 1, "a"), new Event(start + 10000, 1, "a"), new Event(start + 20000, 1, "b"), new Event(start + 30000, 2, "a"), new Event(start + 40000, 1, "b"), new Event(start + 80000, 2, "b")), start, end, zone, new State(), "self");
        check(total(switches, "2026-09-23", "a") == 20000 && total(switches, "2026-09-23", "b") == 60000, "multiwindow duplicates and delayed pauses do not double count");
        var samePackage = UsageIntervals.reconstruct(List.of(new Event(start, 1, "a", "A1"), new Event(start + 10000, 1, "a", "A2"), new Event(start + 20000, 2, "a", "A1"), new Event(end, 2, "a", "A2")), start, end, zone, new State(), "self");
        check(total(samePackage, "2026-09-23", "a") == 100000, "delayed pause for an older activity cannot end the current activity in the same app");
        var self = UsageIntervals.reconstruct(List.of(new Event(start, 1, "self")), start, end, zone, new State(), "self");
        check(self.days.isEmpty(), "collector UI is excluded");
        var first = UsageIntervals.reconstruct(List.of(new Event(start, 1, "a")), start, start + 30000, zone, new State(), "self");
        var second = UsageIntervals.reconstruct(List.of(new Event(start + 70000, 2, "a")), start + 30000, end, zone, first.state, "self");
        check(total(first, "2026-09-23", "a") + total(second, "2026-09-23", "a") == 70000, "offline checkpoint continuation");
        long dst = t("2026-11-01T04:00:00Z");
        var daylight = UsageIntervals.reconstruct(List.of(new Event(dst, 1, "a")), dst, dst + 90000000, ZoneId.of("America/New_York"), new State(), "self");
        check(total(daylight, "2026-11-01", "a") == 90000000, "25-hour local day");
        check(UsageIntervals.reconstruct(List.of(), end, start, zone, new State(), "self").days.isEmpty(), "clock rollback never creates negative time");
        check(!UsageIntervals.canAdvance(end, start) && !UsageIntervals.canAdvance(end, end - 1) && UsageIntervals.canAdvance(end, end), "clock rollback never rewinds the persisted checkpoint");
        var shutdown = UsageIntervals.reconstruct(List.of(new Event(start, 1, "a"), new Event(start + 5000, 26, null), new Event(start + 6000, 1, "b")), start, start + 50000, zone, new State(), "self");
        var reboot = UsageIntervals.reconstruct(List.of(new Event(start + 60000, 27, null), new Event(start + 70000, 1, "c")), start + 50000, end, zone, shutdown.state, "self");
        check(total(shutdown, "2026-09-23", "a") == 5000 && total(shutdown, "2026-09-23", "b") == 0 && total(reboot, "2026-09-23", "c") == 30000, "shutdown survives checkpoints and excludes intervening app events");
        State stale = new State(); stale.active = "a";
        var unmatchedStartup = UsageIntervals.reconstruct(List.of(new Event(start + 70000, 27, null)), start, end, zone, stale, "self");
        check(unmatchedStartup.days.isEmpty(), "startup without shutdown cannot charge the preceding open interval");
        System.out.println("Usage interval fixtures passed: midnight, screen-off, lock, app switches, duplicate events, own app, restart, DST, clock rollback");
    }
}
