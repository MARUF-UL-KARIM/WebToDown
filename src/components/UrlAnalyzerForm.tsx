import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { ChevronDown, ChevronUp, ClipboardPaste, KeyRound, Loader2, Search, Upload, X } from 'lucide-react';

interface UrlAnalyzerFormProps {
  url: string;
  cookiesText: string;
  isAnalyzing: boolean;
  error: string | null;
  onChangeUrl: (next: string) => void;
  onChangeCookies: (next: string) => void;
  onAnalyze: (targetUrl?: string) => void;
}

const SAMPLE_URLS = [
  {
    label: 'MDN CC0 Flower (MP4, 5s)',
    url: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
  },
  {
    label: 'Big Buck Bunny (WebM, 360p)',
    url: 'https://upload.wikimedia.org/wikipedia/commons/transcoded/c/c0/Big_Buck_Bunny_4K.webm/Big_Buck_Bunny_4K.webm.360p.vp9.webm',
  },
];

export function UrlAnalyzerForm({
  url,
  cookiesText,
  isAnalyzing,
  error,
  onChangeUrl,
  onChangeCookies,
  onAnalyze,
}: UrlAnalyzerFormProps) {
  const [clipboardNotice, setClipboardNotice] = useState<string | null>(null);
  const [showCookiesPanel, setShowCookiesPanel] = useState<boolean>(false);

  const isYouTubeBotError = Boolean(error && error.toLowerCase().includes('bot verification'));

  useEffect(() => {
    if (isYouTubeBotError) {
      setShowCookiesPanel(true);
    }
  }, [isYouTubeBotError]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    onAnalyze();
  };

  const handlePaste = async () => {
    setClipboardNotice(null);
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      setClipboardNotice('Browser clipboard access is unavailable here. Tap the input field and paste manually.');
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim()) {
        onChangeUrl(text.trim());
      } else {
        setClipboardNotice('Clipboard is empty.');
      }
    } catch {
      setClipboardNotice('Clipboard permission denied. Long-press or Ctrl+V inside the URL box.');
    }
  };

  const handleCookiesFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 256 * 1024) {
      setClipboardNotice('Cookies file exceeds 256 KB limit.');
      return;
    }
    const text = await file.text();
    onChangeCookies(text);
    e.target.value = '';
  };

  return (
    <section
      id="downloader"
      className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 sm:p-8"
    >
      <div className="max-w-3xl">
        <h1 className="text-2xl sm:text-4xl font-extrabold tracking-tight text-slate-900 dark:text-white [text-wrap:balance]">
          Download, trim, and convert public online videos
        </h1>
        <p className="mt-2.5 text-sm sm:text-base text-slate-600 dark:text-slate-300 leading-relaxed">
          Paste a publicly accessible video page or direct media URL to inspect genuine resolutions,
          trim segments, adjust playback speed, and download directly to your device.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="mt-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-stretch">
          <div className="relative flex flex-1 items-center">
            <input
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              value={url}
              onChange={(e) => onChangeUrl(e.target.value)}
              placeholder="https://example.com/video.mp4 or supported video page URL"
              aria-label="Video URL"
              className="w-full min-h-[52px] rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 pl-4 pr-28 text-sm sm:text-base text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:border-blue-600 focus:bg-white dark:focus:bg-slate-950 focus:outline-none"
            />

            <div className="absolute right-2 flex items-center gap-1">
              {url.length > 0 && (
                <button
                  type="button"
                  onClick={() => onChangeUrl('')}
                  aria-label="Clear URL"
                  className="inline-flex min-h-[40px] min-w-[40px] items-center justify-center rounded-lg text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white transition-colors"
                >
                  <X className="h-4 w-4" />
                </button>
              )}

              <button
                type="button"
                onClick={handlePaste}
                className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors whitespace-nowrap shrink-0"
              >
                <ClipboardPaste className="h-3.5 w-3.5" />
                <span>Paste</span>
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={isAnalyzing}
            className="inline-flex min-h-[52px] items-center justify-center gap-2 rounded-xl bg-blue-600 px-6 py-3 text-sm sm:text-base font-semibold text-white hover:bg-blue-700 active:scale-[0.99] disabled:opacity-60 disabled:cursor-not-allowed transition-all whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
          >
            {isAnalyzing ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Analyzing...</span>
              </>
            ) : (
              <>
                <Search className="h-4 w-4" />
                <span>Analyze URL</span>
              </>
            )}
          </button>
        </div>
      </form>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span>Test public URLs:</span>
          {SAMPLE_URLS.map((sample) => (
            <button
              key={sample.url}
              type="button"
              onClick={() => {
                onChangeUrl(sample.url);
                onAnalyze(sample.url);
              }}
              className="min-h-[32px] font-medium text-blue-600 dark:text-blue-400 hover:underline text-left"
            >
              {sample.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => setShowCookiesPanel((prev) => !prev)}
          className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-1.5 font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
        >
          <KeyRound className="h-3.5 w-3.5" />
          <span>{cookiesText.trim() ? 'Cookies Loaded' : 'Cookies (Optional)'}</span>
          {showCookiesPanel ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>
      </div>

      {showCookiesPanel && (
        <div className="mt-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-4 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-semibold text-slate-800 dark:text-slate-200">
              Optional Netscape cookies.txt (Ephemeral)
            </p>
            <div className="flex items-center gap-2">
              <label className="inline-flex min-h-[36px] cursor-pointer items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800">
                <Upload className="h-3.5 w-3.5" />
                <span>Load .txt File</span>
                <input
                  type="file"
                  accept=".txt,text/plain"
                  onChange={handleCookiesFile}
                  className="sr-only"
                />
              </label>
              {cookiesText.trim().length > 0 && (
                <button
                  type="button"
                  onClick={() => onChangeCookies('')}
                  className="min-h-[36px] rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
                >
                  Clear Cookies
                </button>
              )}
            </div>
          </div>
          <p className="mt-1.5 text-slate-600 dark:text-slate-400 leading-relaxed">
            Cloud datacenter IPs trigger YouTube bot verification. Supplying your own exported Netscape{' '}
            <code className="font-mono">cookies.txt</code> lets yt-dlp authenticate ephemerally (kept in
            browser memory only and deleted on the server immediately after each command), or run ClipFetch
            locally / on Android Termux without cookies.
          </p>
          <textarea
            rows={4}
            value={cookiesText}
            onChange={(e) => onChangeCookies(e.target.value)}
            placeholder="# Netscape HTTP Cookie File"
            spellCheck={false}
            className="mt-2.5 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-2.5 font-mono text-xs text-slate-800 dark:text-slate-200 focus:border-blue-600 focus:outline-none"
          />
        </div>
      )}

      {clipboardNotice && (
        <p className="mt-3 text-xs text-amber-700 dark:text-amber-400" role="status">
          {clipboardNotice}
        </p>
      )}

      {error && (
        <div
          role="alert"
          className="mt-4 rounded-xl border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-4 py-3 text-sm text-red-800 dark:text-red-300"
        >
          {error}
        </div>
      )}
    </section>
  );
}
