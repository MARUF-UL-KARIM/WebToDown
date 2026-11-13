import { useEffect, useRef, useState } from 'react';
import { Header } from './components/Header';
import { UrlAnalyzerForm } from './components/UrlAnalyzerForm';
import { MediaWorkbench } from './components/MediaWorkbench';
import { DownloadManager } from './components/DownloadManager';
import { TechnicalSections } from './components/TechnicalSections';
import type { AnalyzedMedia, DownloadJob } from './types';

export default function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof document !== 'undefined' && document.documentElement.classList.contains('dark')) {
      return 'dark';
    }
    return 'light';
  });

  const [url, setUrl] = useState<string>('');
  const [cookiesText, setCookiesText] = useState<string>('');
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [analyzedMedia, setAnalyzedMedia] = useState<AnalyzedMedia | null>(null);
  const [isSubmittingJob, setIsSubmittingJob] = useState<boolean>(false);
  const [jobs, setJobs] = useState<DownloadJob[]>([]);

  const eventSourcesRef = useRef<Map<string, EventSource>>(new Map());
  const retryTimersRef = useRef<Map<string, number>>(new Map());
  const mountedRef = useRef<boolean>(true);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    try {
      localStorage.setItem('clipfetch_theme', theme);
    } catch {
      // Ignore storage failures
    }
  }, [theme]);

  useEffect(() => {
    mountedRef.current = true;
    const sourcesMap = eventSourcesRef.current;
    const timersMap = retryTimersRef.current;
    return () => {
      mountedRef.current = false;
      for (const timerId of timersMap.values()) {
        window.clearTimeout(timerId);
      }
      timersMap.clear();
      for (const es of sourcesMap.values()) {
        es.close();
      }
      sourcesMap.clear();
    };
  }, []);

  const attachJobStream = (jobId: string) => {
    if (!mountedRef.current || eventSourcesRef.current.has(jobId)) return;

    const es = new EventSource(`/api/jobs/${jobId}/events`);
    eventSourcesRef.current.set(jobId, es);

    es.onmessage = (event) => {
      if (!mountedRef.current) return;
      try {
        const updated = JSON.parse(event.data) as DownloadJob;
        setJobs((prev) => prev.map((j) => (j.jobId === jobId ? updated : j)));

        if (
          updated.status === 'ready' ||
          updated.status === 'error' ||
          updated.status === 'cancelled'
        ) {
          es.close();
          eventSourcesRef.current.delete(jobId);
        }
      } catch {
        // Ignore malformed frame
      }
    };

    es.onerror = () => {
      // Fallback one-shot status poll if SSE drops
      es.close();
      eventSourcesRef.current.delete(jobId);
      fetch(`/api/jobs/${jobId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((snapshot: DownloadJob | null) => {
          if (!mountedRef.current || !snapshot) return;
          setJobs((prev) => prev.map((j) => (j.jobId === jobId ? snapshot : j)));
          if (
            snapshot.status !== 'ready' &&
            snapshot.status !== 'error' &&
            snapshot.status !== 'cancelled'
          ) {
            const timerId = window.setTimeout(() => {
              retryTimersRef.current.delete(jobId);
              attachJobStream(jobId);
            }, 1000);
            retryTimersRef.current.set(jobId, timerId);
          }
        })
        .catch(() => {});
    };
  };

  const handleAnalyze = async (overrideUrl?: string) => {
    const targetUrl = (overrideUrl ?? url).trim();
    if (!targetUrl) {
      setAnalyzeError('Please enter or paste a video URL to analyze.');
      return;
    }

    setIsAnalyzing(true);
    setAnalyzeError(null);

    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: targetUrl,
          cookiesText: cookiesText.trim() || undefined,
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        setAnalyzedMedia(null);
        setAnalyzeError(data.error || 'Could not analyze the provided URL.');
        return;
      }

      setAnalyzedMedia(data as AnalyzedMedia);
    } catch {
      setAnalyzeError('Network error while contacting the extraction backend.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleStartDownload = async (payload: {
    url: string;
    title: string;
    mode: 'video' | 'audio';
    formatId: string;
    audioFormatId: string | null;
    needsMerge: boolean;
    container: string;
    isDirectMedia: boolean;
    duration: number | null;
    trim: { enabled: boolean; start: number; end: number };
    speed: number;
  }) => {
    setIsSubmittingJob(true);
    setAnalyzeError(null);

    try {
      const response = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...payload,
          cookiesText: cookiesText.trim() || undefined,
        }),
      });
      const data = await response.json();

      if (!response.ok) {
        setAnalyzeError(data.error || 'Unable to queue download job.');
        return;
      }

      const newJob = data as DownloadJob;
      setJobs((prev) => [newJob, ...prev]);
      attachJobStream(newJob.jobId);
    } catch {
      setAnalyzeError('Failed to communicate with the download engine.');
    } finally {
      setIsSubmittingJob(false);
    }
  };

  const handleCancelJob = async (jobId: string) => {
    try {
      await fetch(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
    } catch {
      // Ignore network race
    }
  };

  const handleDismissJob = (jobId: string) => {
    const timerId = retryTimersRef.current.get(jobId);
    if (timerId !== undefined) {
      window.clearTimeout(timerId);
      retryTimersRef.current.delete(jobId);
    }
    const es = eventSourcesRef.current.get(jobId);
    if (es) {
      es.close();
      eventSourcesRef.current.delete(jobId);
    }
    setJobs((prev) => prev.filter((j) => j.jobId !== jobId));
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <Header
        theme={theme}
        onToggleTheme={() => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))}
      />

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-6 sm:py-10">
        <UrlAnalyzerForm
          url={url}
          cookiesText={cookiesText}
          isAnalyzing={isAnalyzing}
          error={analyzeError}
          onChangeUrl={setUrl}
          onChangeCookies={setCookiesText}
          onAnalyze={handleAnalyze}
        />

        <DownloadManager
          jobs={jobs}
          onCancelJob={handleCancelJob}
          onDismissJob={handleDismissJob}
        />

        {analyzedMedia && (
          <MediaWorkbench
            media={analyzedMedia}
            isSubmitting={isSubmittingJob}
            onStartDownload={handleStartDownload}
          />
        )}

        <TechnicalSections />
      </main>

      <footer className="border-t border-slate-200 dark:border-slate-800 py-6 text-center text-xs text-slate-500 dark:text-slate-400 px-4">
        ClipFetch — Only download publicly accessible media you have rights or permission to save.
      </footer>
    </div>
  );
}
