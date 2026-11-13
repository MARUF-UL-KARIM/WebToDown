export interface VideoFormatOption {
  id: string;
  label: string;
  qualityTag: string;
  height: number | null;
  width: number | null;
  fps: number | null;
  ext: string;
  vcodec: string | null;
  acodec: string | null;
  filesize: number | null;
  tbr: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  needsMerge: boolean;
  audioFormatId: string | null;
}

export interface AnalyzedMedia {
  url: string;
  webpageUrl: string;
  title: string;
  thumbnail: string | null;
  duration: number | null;
  durationFormatted: string;
  uploader: string | null;
  source: string;
  extractor: string;
  isDirectMedia: boolean;
  hasAudioTrack: boolean;
  canTrim: boolean;
  canChangeSpeed: boolean;
  videoFormats: VideoFormatOption[];
  audioFormats: VideoFormatOption[];
  limits: {
    maxFileSizeMb: number;
    maxDurationSec: number;
  };
}

export type JobStatus =
  | 'queued'
  | 'downloading'
  | 'merging'
  | 'processing'
  | 'ready'
  | 'cancelled'
  | 'error';

export interface DownloadJob {
  jobId: string;
  status: JobStatus;
  phaseLabel: string;
  progress: number | null;
  downloadedBytes: number;
  totalBytes: number | null;
  speedText: string | null;
  etaText: string | null;
  filename: string | null;
  fileSize: number | null;
  downloadUrl: string | null;
  error: string | null;
  createdAt: number;
}

export interface HealthInfo {
  status: string;
  tools: {
    ytdlp: string | null;
    ffmpeg: string | null;
    ffprobe: string | null;
  };
  activeJobs: number;
  limits: {
    maxFileSizeMb: number;
    maxDurationSec: number;
    maxConcurrentJobs: number;
  };
}
