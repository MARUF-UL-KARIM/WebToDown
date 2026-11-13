import { AlertCircle, CheckCircle2, Download, Loader2, Trash2, XCircle } from 'lucide-react';
import type { DownloadJob } from '../types';
import { formatBytes } from '../utils/formatters';

interface DownloadManagerProps {
  jobs: DownloadJob[];
  onCancelJob: (jobId: string) => void;
  onDismissJob: (jobId: string) => void;
}

export function DownloadManager({ jobs, onCancelJob, onDismissJob }: DownloadManagerProps) {
  if (jobs.length === 0) {
    return null;
  }

  return (
    <section className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 sm:p-6">
      <div className="flex items-center justify-between gap-4 mb-4">
        <h2 className="text-lg font-bold text-slate-900 dark:text-white">Download Manager</h2>
        <span className="text-xs font-mono text-slate-500 dark:text-slate-400 tabular-nums">
          {jobs.length} {jobs.length === 1 ? 'task' : 'tasks'}
        </span>
      </div>

      <div className="divide-y divide-slate-200 dark:divide-slate-800">
        {jobs.map((job) => {
          const isActive =
            job.status === 'queued' ||
            job.status === 'downloading' ||
            job.status === 'merging' ||
            job.status === 'processing';
          const isReady = job.status === 'ready';
          const isError = job.status === 'error';
          const isCancelled = job.status === 'cancelled';
          const progressValue = job.progress ?? 0;

          return (
            <div key={job.jobId} className="py-4 first:pt-0 last:pb-0">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    {isActive && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-600" />}
                    {isReady && <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />}
                    {isError && <AlertCircle className="h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />}
                    {isCancelled && <XCircle className="h-4 w-4 shrink-0 text-slate-500" />}

                    <p className="text-sm font-semibold text-slate-900 dark:text-white truncate">
                      {job.filename || job.phaseLabel}
                    </p>
                  </div>

                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                    <span>{job.phaseLabel}</span>
                    {job.downloadedBytes > 0 && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>
                          {formatBytes(job.downloadedBytes)}
                          {job.totalBytes ? ` / ${formatBytes(job.totalBytes)}` : ''}
                        </span>
                      </>
                    )}
                    {job.speedText && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{job.speedText}</span>
                      </>
                    )}
                    {job.etaText && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>ETA {job.etaText}</span>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {isActive && (
                    <button
                      type="button"
                      onClick={() => onCancelJob(job.jobId)}
                      className="min-h-[44px] inline-flex items-center justify-center gap-1.5 rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 px-4 py-2 text-xs font-semibold text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/50 transition-colors"
                    >
                      <XCircle className="h-4 w-4" />
                      <span>Cancel</span>
                    </button>
                  )}

                  {isReady && job.downloadUrl && (
                    <a
                      href={job.downloadUrl}
                      download={job.filename || 'video'}
                      className="min-h-[44px] w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-bold text-white hover:bg-emerald-700 transition-colors"
                    >
                      <Download className="h-4 w-4" />
                      <span>Save File ({formatBytes(job.fileSize)})</span>
                    </a>
                  )}

                  {!isActive && (
                    <button
                      type="button"
                      onClick={() => onDismissJob(job.jobId)}
                      aria-label="Remove item from list"
                      className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-xl border border-slate-200 dark:border-slate-700 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white transition-colors"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>

              {isActive && (
                <div className="mt-3">
                  <div className="flex items-center justify-between text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400 mb-1">
                    <span>{job.status === 'processing' ? 'FFmpeg Processing' : 'Transfer Progress'}</span>
                    <span>{job.progress !== null ? `${progressValue}%` : 'Streaming...'}</span>
                  </div>
                  <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                    <div
                      className="h-full rounded-full bg-blue-600 transition-[width] duration-200"
                      style={{ width: `${job.progress !== null ? progressValue : 35}%` }}
                    />
                  </div>
                </div>
              )}

              {isError && job.error && (
                <div className="mt-2.5 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/50 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                  {job.error}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
