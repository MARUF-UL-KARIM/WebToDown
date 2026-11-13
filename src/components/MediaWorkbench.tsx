import { useEffect, useMemo, useState } from 'react';
import { Download, Film, Music, Scissors, Gauge } from 'lucide-react';
import type { AnalyzedMedia, VideoFormatOption } from '../types';
import {
  formatBytes,
  secondsToTimestamp,
  shortCodec,
  timestampToSeconds,
} from '../utils/formatters';

interface MediaWorkbenchProps {
  media: AnalyzedMedia;
  isSubmitting: boolean;
  onStartDownload: (payload: {
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
  }) => void;
}

const SPEED_OPTIONS = [0.5, 1, 1.5, 2, 3] as const;

export function MediaWorkbench({ media, isSubmitting, onStartDownload }: MediaWorkbenchProps) {
  const [mode, setMode] = useState<'video' | 'audio'>(
    media.videoFormats.length > 0 ? 'video' : 'audio'
  );
  const [selectedVideoId, setSelectedVideoId] = useState<string>(
    media.videoFormats[0]?.id || ''
  );
  const [selectedAudioId, setSelectedAudioId] = useState<string>(
    media.audioFormats[0]?.id || ''
  );
  const [container, setContainer] = useState<string>('mp4');
  const [speed, setSpeed] = useState<number>(1);
  const [trimEnabled, setTrimEnabled] = useState<boolean>(false);
  const [trimStartSec, setTrimStartSec] = useState<number>(0);
  const [trimEndSec, setTrimEndSec] = useState<number>(
    media.duration ? Math.min(media.duration, Math.max(10, Math.round(media.duration))) : 30
  );
  const [startInput, setStartInput] = useState<string>('00:00');
  const [endInput, setEndInput] = useState<string>(
    secondsToTimestamp(media.duration || 30)
  );
  const [thumbFailed, setThumbFailed] = useState<boolean>(false);
  const [useProxyThumb, setUseProxyThumb] = useState<boolean>(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    const initialMode = media.videoFormats.length > 0 ? 'video' : 'audio';
    setMode(initialMode);
    setSelectedVideoId(media.videoFormats[0]?.id || '');
    setSelectedAudioId(media.audioFormats[0]?.id || '');
    setContainer(initialMode === 'video' ? 'mp4' : 'mp3');
    setSpeed(1);
    setTrimEnabled(false);
    setTrimStartSec(0);
    const maxDur = media.duration ? Math.floor(media.duration) : 30;
    setTrimEndSec(maxDur);
    setStartInput('00:00');
    setEndInput(secondsToTimestamp(maxDur));
    setThumbFailed(false);
    setUseProxyThumb(false);
    setValidationError(null);
  }, [media]);

  const activeFormats: VideoFormatOption[] =
    mode === 'video' ? media.videoFormats : media.audioFormats;

  const selectedFormat = useMemo(() => {
    const targetId = mode === 'video' ? selectedVideoId : selectedAudioId;
    return activeFormats.find((f) => f.id === targetId) || activeFormats[0] || null;
  }, [activeFormats, mode, selectedAudioId, selectedVideoId]);

  const containerOptions = mode === 'video' ? ['mp4', 'webm', 'mkv'] : ['mp3', 'm4a'];

  const handleModeChange = (nextMode: 'video' | 'audio') => {
    setMode(nextMode);
    setContainer(nextMode === 'video' ? 'mp4' : 'mp3');
    setValidationError(null);
  };

  const syncTrimStart = (nextSec: number) => {
    const maxBound = media.duration ? Math.max(0, Math.floor(media.duration) - 1) : 3600;
    const clamped = Math.max(0, Math.min(nextSec, maxBound));
    setTrimStartSec(clamped);
    setStartInput(secondsToTimestamp(clamped));
    if (clamped >= trimEndSec) {
      const bumpedEnd = media.duration ? Math.min(Math.floor(media.duration), clamped + 1) : clamped + 5;
      setTrimEndSec(bumpedEnd);
      setEndInput(secondsToTimestamp(bumpedEnd));
    }
  };

  const syncTrimEnd = (nextSec: number) => {
    const maxBound = media.duration ? Math.ceil(media.duration) : 3600;
    const clamped = Math.max(trimStartSec + 1, Math.min(nextSec, maxBound));
    setTrimEndSec(clamped);
    setEndInput(secondsToTimestamp(clamped));
  };

  const applyStartText = () => {
    const parsed = timestampToSeconds(startInput);
    if (parsed === null) {
      setStartInput(secondsToTimestamp(trimStartSec));
      return;
    }
    syncTrimStart(parsed);
  };

  const applyEndText = () => {
    const parsed = timestampToSeconds(endInput);
    if (parsed === null) {
      setEndInput(secondsToTimestamp(trimEndSec));
      return;
    }
    syncTrimEnd(parsed);
  };

  const handleDownloadClick = () => {
    setValidationError(null);
    if (!selectedFormat) {
      setValidationError('No downloadable format is selected.');
      return;
    }

    let finalStart = trimStartSec;
    let finalEnd = trimEndSec;

    if (trimEnabled) {
      const parsedStart = timestampToSeconds(startInput);
      const parsedEnd = timestampToSeconds(endInput);
      if (parsedStart === null || parsedEnd === null) {
        setValidationError('Enter valid MM:SS timestamps for trim start and end.');
        return;
      }
      finalStart = Math.max(0, parsedStart);
      finalEnd = parsedEnd;
      if (finalEnd <= finalStart) {
        setValidationError('Trim end time must be strictly greater than start time.');
        return;
      }
      if (media.duration && finalEnd > Math.ceil(media.duration) + 1) {
        setValidationError('Trim end time cannot exceed the video duration.');
        return;
      }
    }

    onStartDownload({
      url: media.url,
      title: media.title,
      mode,
      formatId: selectedFormat.id,
      audioFormatId: selectedFormat.audioFormatId,
      needsMerge: selectedFormat.needsMerge,
      container,
      isDirectMedia: media.isDirectMedia,
      duration: media.duration,
      trim: {
        enabled: trimEnabled,
        start: finalStart,
        end: finalEnd,
      },
      speed,
    });
  };

  const thumbnailSrc = media.thumbnail
    ? useProxyThumb
      ? `/api/thumbnail?url=${encodeURIComponent(media.thumbnail)}`
      : media.thumbnail
    : null;

  const trimmedDuration = Math.max(0, trimEndSec - trimStartSec);
  const outputDurationEstimate =
    speed !== 1
      ? (trimEnabled ? trimmedDuration : media.duration || 0) / speed
      : trimEnabled
        ? trimmedDuration
        : media.duration || 0;

  return (
    <section className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 sm:p-6">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 lg:items-start">
        {/* Left: Video Preview & Metadata */}
        <div className="lg:col-span-5">
          <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-950 aspect-video relative">
            {thumbnailSrc && !thumbFailed ? (
              <img
                src={thumbnailSrc}
                alt={media.title}
                referrerPolicy="no-referrer"
                onError={() => {
                  if (!useProxyThumb) {
                    setUseProxyThumb(true);
                  } else {
                    setThumbFailed(true);
                  }
                }}
                className="h-full w-full object-cover"
              />
            ) : media.isDirectMedia && media.videoFormats.length > 0 ? (
              <video
                src={media.url}
                controls
                preload="metadata"
                playsInline
                className="h-full w-full bg-black object-contain"
              />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-slate-400 dark:text-slate-600">
                <Film className="h-10 w-10" />
                <span className="text-xs font-medium text-center">{media.source}</span>
              </div>
            )}
          </div>

          <h2 className="mt-4 text-lg sm:text-xl font-bold text-slate-900 dark:text-white leading-snug break-words">
            {media.title}
          </h2>

          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs sm:text-sm text-slate-500 dark:text-slate-400">
            <span>{media.source}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">Duration: {media.durationFormatted}</span>
            {media.uploader && (
              <>
                <span aria-hidden="true">·</span>
                <span className="truncate max-w-[220px]">{media.uploader}</span>
              </>
            )}
          </div>

          <div className="mt-4 border-t border-slate-200 dark:border-slate-800 pt-3 text-xs text-slate-500 dark:text-slate-400 space-y-1">
            <p>
              Extractor: <span className="font-medium text-slate-700 dark:text-slate-200">{media.extractor}</span>
            </p>
            <p>
              Server limit: <span className="font-mono tabular-nums">{media.limits.maxFileSizeMb} MB</span> max per job
            </p>
          </div>
        </div>

        {/* Right: Format, Quality, Trim & Playback Speed Controls */}
        <div className="lg:col-span-7 space-y-5">
          {/* Mode Tabs */}
          <div className="flex items-center gap-2 rounded-xl bg-slate-100 dark:bg-slate-950 p-1 border border-slate-200 dark:border-slate-800">
            <button
              type="button"
              disabled={media.videoFormats.length === 0}
              onClick={() => handleModeChange('video')}
              className={`flex-1 min-h-[44px] inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors whitespace-nowrap ${
                mode === 'video'
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white disabled:opacity-40'
              }`}
            >
              <Film className="h-4 w-4" />
              <span>Video</span>
            </button>

            <button
              type="button"
              disabled={!media.hasAudioTrack && media.audioFormats.length === 0}
              onClick={() => handleModeChange('audio')}
              className={`flex-1 min-h-[44px] inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors whitespace-nowrap ${
                mode === 'audio'
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white disabled:opacity-40'
              }`}
            >
              <Music className="h-4 w-4" />
              <span>Audio Only</span>
            </button>
          </div>

          {/* Quality Selection */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                Available {mode === 'video' ? 'Resolutions' : 'Audio Streams'}
              </label>
              <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                {activeFormats.length} detected
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 max-h-60 overflow-y-auto pr-0.5">
              {activeFormats.map((fmt, index) => {
                const isSelected = selectedFormat?.id === fmt.id && (index === 0 || selectedFormat?.label === fmt.label);
                const codecs = [shortCodec(fmt.vcodec), shortCodec(fmt.acodec)].filter(Boolean).join(' + ');

                return (
                  <button
                    key={`${fmt.id}-${fmt.qualityTag}-${index}`}
                    type="button"
                    onClick={() => {
                      if (mode === 'video') setSelectedVideoId(fmt.id);
                      else setSelectedAudioId(fmt.id);
                    }}
                    className={`min-h-[56px] w-full rounded-xl border px-3.5 py-2.5 text-left transition-colors ${
                      isSelected
                        ? 'border-blue-600 bg-blue-50/70 dark:bg-blue-950/40 text-slate-900 dark:text-white'
                        : 'border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-950/60 text-slate-800 dark:text-slate-200 hover:border-slate-300 dark:hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-bold truncate">{fmt.label}</span>
                      <span className="font-mono text-xs font-medium text-slate-500 dark:text-slate-400 tabular-nums shrink-0">
                        {formatBytes(fmt.filesize)}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 truncate">
                      <span>{fmt.ext.toUpperCase()}</span>
                      {codecs && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>{codecs}</span>
                        </>
                      )}
                      {fmt.fps && fmt.fps > 30 && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="tabular-nums">{fmt.fps}fps</span>
                        </>
                      )}
                      {fmt.needsMerge && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>FFmpeg merge</span>
                        </>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Output Container + Playback Speed */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-semibold text-slate-800 dark:text-slate-200 mb-2">
                Output Container
              </label>
              <div className="flex items-center gap-2">
                {containerOptions.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setContainer(c)}
                    className={`flex-1 min-h-[44px] rounded-xl border px-3 py-2 text-xs font-bold uppercase tracking-wide transition-colors ${
                      container === c
                        ? 'border-blue-600 bg-blue-600 text-white'
                        : 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="flex items-center gap-1.5 text-sm font-semibold text-slate-800 dark:text-slate-200 mb-2">
                <Gauge className="h-4 w-4 text-slate-500" />
                <span>Playback Speed</span>
              </label>
              <div className="grid grid-cols-5 gap-1.5">
                {SPEED_OPTIONS.map((sp) => (
                  <button
                    key={sp}
                    type="button"
                    onClick={() => setSpeed(sp)}
                    className={`min-h-[44px] rounded-xl border px-1 py-2 font-mono text-xs font-semibold tabular-nums transition-colors ${
                      speed === sp
                        ? 'border-blue-600 bg-blue-600 text-white'
                        : 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    {sp}x
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Trim Controls */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <Scissors className="h-4 w-4 text-slate-600 dark:text-slate-400" />
                <span className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                  Trim Video Segment
                </span>
              </div>

              <button
                type="button"
                role="switch"
                aria-checked={trimEnabled}
                disabled={!media.canTrim}
                onClick={() => setTrimEnabled((prev) => !prev)}
                className={`min-h-[36px] rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-40 ${
                  trimEnabled
                    ? 'bg-blue-600 text-white'
                    : 'border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300'
                }`}
              >
                {media.canTrim ? (trimEnabled ? 'Enabled' : 'Enable Trim') : 'Unavailable'}
              </button>
            </div>

            {trimEnabled && media.duration && (
              <div className="mt-4 space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                      Start Time (MM:SS)
                    </label>
                    <input
                      type="text"
                      value={startInput}
                      onChange={(e) => {
                        const raw = e.target.value;
                        setStartInput(raw);
                        const parsed = timestampToSeconds(raw);
                        if (parsed !== null && parsed >= 0) {
                          setTrimStartSec(parsed);
                        }
                      }}
                      onBlur={applyStartText}
                      className="w-full min-h-[44px] rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 font-mono text-sm tabular-nums text-slate-900 dark:text-white"
                    />
                    <input
                      type="range"
                      min={0}
                      max={Math.max(1, Math.floor(media.duration) - 1)}
                      value={trimStartSec}
                      onChange={(e) => syncTrimStart(Number(e.target.value))}
                      aria-label="Trim start slider"
                      className="clipfetch-range mt-2 w-full"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                      End Time (MM:SS)
                    </label>
                    <input
                      type="text"
                      value={endInput}
                      onChange={(e) => {
                        const raw = e.target.value;
                        setEndInput(raw);
                        const parsed = timestampToSeconds(raw);
                        if (parsed !== null && parsed >= 0) {
                          setTrimEndSec(parsed);
                        }
                      }}
                      onBlur={applyEndText}
                      className="w-full min-h-[44px] rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 font-mono text-sm tabular-nums text-slate-900 dark:text-white"
                    />
                    <input
                      type="range"
                      min={1}
                      max={Math.ceil(media.duration)}
                      value={trimEndSec}
                      onChange={(e) => syncTrimEnd(Number(e.target.value))}
                      aria-label="Trim end slider"
                      className="clipfetch-range mt-2 w-full"
                    />
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-400">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        syncTrimStart(0);
                        syncTrimEnd(Math.min(15, Math.ceil(media.duration || 15)));
                      }}
                      className="min-h-[34px] rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1 font-medium hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      First 15s
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        syncTrimStart(0);
                        syncTrimEnd(Math.min(30, Math.ceil(media.duration || 30)));
                      }}
                      className="min-h-[34px] rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1 font-medium hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      First 30s
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        syncTrimStart(0);
                        syncTrimEnd(Math.ceil(media.duration || 30));
                      }}
                      className="min-h-[34px] rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1 font-medium hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      Full Length
                    </button>
                  </div>

                  <span className="font-mono tabular-nums">
                    Clip: {secondsToTimestamp(trimmedDuration)}
                    {speed !== 1 ? ` -> Output: ${secondsToTimestamp(Math.round(outputDurationEstimate))}` : ''}
                  </span>
                </div>
              </div>
            )}
          </div>

          {validationError && (
            <p className="text-sm text-red-600 dark:text-red-400" role="alert">
              {validationError}
            </p>
          )}

          {/* Primary Download CTA */}
          <button
            type="button"
            disabled={isSubmitting || !selectedFormat}
            onClick={handleDownloadClick}
            className="w-full min-h-[52px] inline-flex items-center justify-center gap-2.5 rounded-xl bg-blue-600 px-6 py-3.5 text-base font-bold text-white hover:bg-blue-700 active:scale-[0.99] disabled:opacity-60 disabled:cursor-not-allowed transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
          >
            <Download className="h-5 w-5" />
            <span>
              {isSubmitting
                ? 'Starting Job...'
                : `Download ${mode === 'audio' ? 'Audio' : selectedFormat?.qualityTag || 'Video'} (${container.toUpperCase()})`}
            </span>
          </button>

          {(speed !== 1 || trimEnabled || selectedFormat?.needsMerge) && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {speed !== 1
                ? `FFmpeg will re-encode at ${speed}x playback speed while keeping audio synchronized.`
                : trimEnabled
                  ? 'FFmpeg will extract only your selected time window before serving the download.'
                  : 'FFmpeg will automatically merge separate video and audio streams.'}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
