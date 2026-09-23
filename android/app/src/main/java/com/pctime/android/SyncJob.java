package com.pctime.android;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;

public final class SyncJob extends JobService {
    static void schedule(Context context) {
        JobScheduler scheduler = (JobScheduler) context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        scheduler.schedule(new JobInfo.Builder(4318, new ComponentName(context, SyncJob.class))
                .setPeriodic(15 * 60 * 1000L).setPersisted(true).build());
    }
    @Override public boolean onStartJob(JobParameters params) {
        AppManager.get(this).background((result, error) -> jobFinished(params, error != null));
        return true;
    }
    @Override public boolean onStopJob(JobParameters params) { return true; }
}
