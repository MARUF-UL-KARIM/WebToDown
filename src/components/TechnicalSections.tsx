const COMPATIBILITY_ROWS = [
  {
    source: 'Direct Video URLs (.mp4, .webm, .mov, .m3u8)',
    status: 'Full Support',
    notes: 'Extracted via yt-dlp or FFprobe; supports stream copy, trimming, and 0.5x–3x playback speed.',
  },
  {
    source: 'Wikimedia Commons / Internet Archive / Vimeo Public',
    status: 'Full Support',
    notes: 'Public streams and metadata extract cleanly on both cloud and local deployments.',
  },
  {
    source: 'YouTube (Public Videos)',
    status: 'Conditional',
    notes:
      'Works on residential/local deployments (and Android Termux). Shared cloud datacenter IPs often trigger YouTube bot-verification without cookies.',
  },
  {
    source: 'Facebook / Instagram / TikTok / X',
    status: 'Public Only',
    notes: 'Public posts are supported via yt-dlp when not rate-limited or behind login walls.',
  },
  {
    source: 'Private, Paywalled, or DRM Media (Widevine / FairPlay)',
    status: 'Unsupported',
    notes: 'Blocked intentionally. ClipFetch never bypasses DRM, logins, or access controls.',
  },
];

const HOSTING_PROVIDERS = [
  {
    provider: 'Render (Free Web Service)',
    specs: '512 MB RAM · 0.1 CPU · Ephemeral Disk',
    verdict: 'Small clips only (<150 MB)',
    notes: 'Sleeps after 15m idle; 1080p FFmpeg speed re-encoding can hit the 512 MB RAM ceiling.',
  },
  {
    provider: 'Hugging Face Spaces (Docker Free)',
    specs: '16 GB RAM · 2 vCPU · 50 GB Ephemeral',
    verdict: 'Recommended Free Cloud',
    notes: 'Generous RAM for FFmpeg 1080p/4K merging & speed re-encoding; supports custom Dockerfiles.',
  },
  {
    provider: 'Oracle Cloud Always Free VM',
    specs: 'Up to 24 GB RAM · 4 ARM OCPU',
    verdict: 'Best Production Free Tier',
    notes: 'No sleep timeout, persistent storage, full root control for yt-dlp updates and FFmpeg.',
  },
  {
    provider: 'Vercel / Netlify / Cloudflare Pages',
    specs: 'Serverless (10–60s timeout, no FFmpeg)',
    verdict: 'Not Suitable for Backend',
    notes: 'Cannot host long downloads or FFmpeg binary pipelines; usable only for static frontend hosting.',
  },
  {
    provider: 'Android Termux (Self-Hosted)',
    specs: 'Device CPU & Storage · Residential IP',
    verdict: 'Best Mobile Reliability',
    notes: 'Avoids datacenter bot-checks (including YouTube) and saves directly to Android storage.',
  },
];

export function TechnicalSections() {
  return (
    <div className="space-y-8">
      {/* Compatibility Matrix */}
      <section
        id="compatibility"
        className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 sm:p-6"
      >
        <h2 className="text-xl font-bold text-slate-900 dark:text-white">
          Source Compatibility Matrix
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Real extraction capabilities and network constraints across supported media sources.
        </p>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[600px] text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-500 dark:text-slate-400">
                <th className="py-3 pr-4">Source Type</th>
                <th className="py-3 pr-4">Support Level</th>
                <th className="py-3">Technical Behavior</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {COMPATIBILITY_ROWS.map((row) => (
                <tr key={row.source}>
                  <td className="py-3 pr-4 font-semibold text-slate-900 dark:text-slate-100">
                    {row.source}
                  </td>
                  <td className="py-3 pr-4 font-medium text-slate-700 dark:text-slate-300 whitespace-nowrap">
                    {row.status}
                  </td>
                  <td className="py-3 text-slate-600 dark:text-slate-400">{row.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Free Hosting Analysis */}
      <section
        id="hosting"
        className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 sm:p-6"
      >
        <h2 className="text-xl font-bold text-slate-900 dark:text-white">
          Free-Tier Hosting & Resource Feasibility
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Video stream merging and FFmpeg re-encoding require memory, disk space, and long-lived HTTP connections.
        </p>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-500 dark:text-slate-400">
                <th className="py-3 pr-4">Platform</th>
                <th className="py-3 pr-4">Limits</th>
                <th className="py-3 pr-4">Feasibility</th>
                <th className="py-3">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {HOSTING_PROVIDERS.map((item) => (
                <tr key={item.provider}>
                  <td className="py-3 pr-4 font-semibold text-slate-900 dark:text-slate-100">
                    {item.provider}
                  </td>
                  <td className="py-3 pr-4 font-mono text-xs text-slate-600 dark:text-slate-400">
                    {item.specs}
                  </td>
                  <td className="py-3 pr-4 font-medium text-slate-800 dark:text-slate-200 whitespace-nowrap">
                    {item.verdict}
                  </td>
                  <td className="py-3 text-slate-600 dark:text-slate-400">{item.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Architecture Overview */}
      <section
        id="architecture"
        className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 sm:p-6"
      >
        <h2 className="text-xl font-bold text-slate-900 dark:text-white">
          Security, Pipeline & Deliverable Stack
        </h2>
        <div className="mt-4 grid grid-cols-1 gap-6 md:grid-cols-3 text-sm text-slate-600 dark:text-slate-400">
          <div>
            <h3 className="font-semibold text-slate-900 dark:text-white">SSRF & File Isolation</h3>
            <p className="mt-1.5 leading-relaxed">
              Every URL is parsed and DNS-resolved before extraction to block loopback, RFC1918 private subnets,
              and cloud metadata IPs. Jobs run in isolated UUID temp directories cleaned automatically on cancellation or expiry.
            </p>
          </div>
          <div>
            <h3 className="font-semibold text-slate-900 dark:text-white">Real FFmpeg Processing</h3>
            <p className="mt-1.5 leading-relaxed">
              Lossless stream copy handles standard 1x trims, while playback speed changes (0.5x–3x) synchronize video
              PTS (<code className="font-mono text-xs">setpts</code>) and audio tempo (<code className="font-mono text-xs">atempo</code>)
              after inspecting streams via FFprobe.
            </p>
          </div>
          <div>
            <h3 className="font-semibold text-slate-900 dark:text-white">Dual Runtime Parity</h3>
            <p className="mt-1.5 leading-relaxed">
              This repository includes both the live port-3000 Express runtime and the complete modular Python/Flask
              backend (<code className="font-mono text-xs">backend/</code>) + Vanilla JS frontend (<code className="font-mono text-xs">frontend/</code>) for Docker or Termux deployment.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
