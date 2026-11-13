(function () {
  const analyzer = window.ClipFetchAnalyzer;
  const downloader = window.ClipFetchDownloader;

  const state = {
    media: null,
    mode: 'video',
    selectedFormatId: null,
    container: 'mp4',
    speed: 1,
    trimEnabled: false,
    jobs: [],
  };

  const urlInput = document.getElementById('urlInput');
  const analyzeForm = document.getElementById('analyzeForm');
  const analyzeBtn = document.getElementById('analyzeBtn');
  const pasteBtn = document.getElementById('pasteBtn');
  const analyzeError = document.getElementById('analyzeError');
  const workbenchSection = document.getElementById('workbenchSection');
  const downloadsSection = document.getElementById('downloadsSection');
  const jobsList = document.getElementById('jobsList');
  const jobCountText = document.getElementById('jobCountText');
  const themeToggleBtn = document.getElementById('themeToggleBtn');

  function applyTheme(dark) {
    document.documentElement.classList.toggle('dark', dark);
    themeToggleBtn.textContent = dark ? 'Light Mode' : 'Dark Mode';
    try {
      localStorage.setItem('clipfetch_theme', dark ? 'dark' : 'light');
    } catch (_) {}
  }

  applyTheme(localStorage.getItem('clipfetch_theme') === 'dark');
  themeToggleBtn.addEventListener('click', () => {
    applyTheme(!document.documentElement.classList.contains('dark'));
  });

  pasteBtn.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) urlInput.value = text.trim();
    } catch (_) {
      analyzeError.textContent = 'Clipboard permission denied. Paste directly inside the URL box.';
      analyzeError.classList.remove('hidden');
    }
  });

  document.querySelectorAll('.sample-link').forEach((btn) => {
    btn.addEventListener('click', () => {
      urlInput.value = btn.getAttribute('data-sample-url') || '';
      analyzeForm.requestSubmit();
    });
  });

  function renderWorkbench() {
    if (!state.media) {
      workbenchSection.classList.add('hidden');
      return;
    }
    workbenchSection.classList.remove('hidden');

    const previewBox = document.getElementById('mediaPreviewBox');
    previewBox.innerHTML = '';
    if (state.media.thumbnail) {
      const img = document.createElement('img');
      img.src = state.media.thumbnail;
      img.alt = state.media.title;
      img.referrerPolicy = 'no-referrer';
      previewBox.appendChild(img);
    } else if (state.media.isDirectMedia) {
      const vid = document.createElement('video');
      vid.src = state.media.url;
      vid.controls = true;
      vid.preload = 'metadata';
      previewBox.appendChild(vid);
    }

    document.getElementById('mediaTitle').textContent = state.media.title;
    document.getElementById('mediaMeta').textContent = [
      state.media.source,
      'Duration: ' + state.media.durationFormatted,
      state.media.uploader,
    ]
      .filter(Boolean)
      .join(' · ');
    document.getElementById('mediaLimits').textContent =
      `Extractor: ${state.media.extractor} · Max ${state.media.limits.maxFileSizeMb} MB`;

    const formats = state.mode === 'video' ? state.media.videoFormats : state.media.audioFormats;
    if (!formats.some((f) => f.id === state.selectedFormatId)) {
      state.selectedFormatId = formats[0] ? formats[0].id : null;
    }

    const formatsGrid = document.getElementById('formatsGrid');
    formatsGrid.innerHTML = '';
    formats.forEach((fmt, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      const isSelected = fmt.id === state.selectedFormatId && (idx === 0 || formats[0]?.id !== fmt.id);
      btn.className = 'format-card' + (isSelected ? ' selected' : '');

      const titleEl = document.createElement('strong');
      titleEl.textContent = fmt.label;
      const metaEl = document.createElement('div');
      metaEl.className = 'muted';
      metaEl.textContent = `${fmt.ext.toUpperCase()} · ${analyzer.formatBytes(fmt.filesize)}`;

      btn.appendChild(titleEl);
      btn.appendChild(metaEl);
      btn.addEventListener('click', () => {
        state.selectedFormatId = fmt.id;
        renderWorkbench();
      });
      formatsGrid.appendChild(btn);
    });

    const containers = state.mode === 'video' ? ['mp4', 'webm', 'mkv'] : ['mp3', 'm4a'];
    if (!containers.includes(state.container)) state.container = containers[0];
    const containerGroup = document.getElementById('containerGroup');
    containerGroup.innerHTML = '';
    containers.forEach((c) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip-btn' + (state.container === c ? ' active' : '');
      btn.textContent = c.toUpperCase();
      btn.addEventListener('click', () => {
        state.container = c;
        renderWorkbench();
      });
      containerGroup.appendChild(btn);
    });

    const speedGroup = document.getElementById('speedGroup');
    speedGroup.innerHTML = '';
    [0.5, 1, 1.5, 2, 3].forEach((sp) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip-btn mono' + (state.speed === sp ? ' active' : '');
      btn.textContent = sp + 'x';
      btn.addEventListener('click', () => {
        state.speed = sp;
        renderWorkbench();
      });
      speedGroup.appendChild(btn);
    });
  }

  function renderJobs() {
    if (state.jobs.length === 0) {
      downloadsSection.classList.add('hidden');
      return;
    }
    downloadsSection.classList.remove('hidden');
    jobCountText.textContent = `${state.jobs.length} ${state.jobs.length === 1 ? 'task' : 'tasks'}`;
    jobsList.innerHTML = '';

    state.jobs.forEach((job) => {
      const card = document.createElement('div');
      card.className = 'job-card';
      const isActive = ['queued', 'downloading', 'merging', 'processing'].includes(job.status);

      const top = document.createElement('div');
      top.className = 'job-top';
      const info = document.createElement('div');
      const strong = document.createElement('strong');
      strong.textContent = job.filename || job.phaseLabel;
      const sub = document.createElement('div');
      sub.className = 'muted mono';
      sub.textContent = `${job.phaseLabel}${job.speedText ? ' · ' + job.speedText : ''}`;
      info.appendChild(strong);
      info.appendChild(sub);
      top.appendChild(info);

      if (isActive) {
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'secondary-btn';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => downloader.cancelJob(job.jobId));
        top.appendChild(cancelBtn);
      } else {
        const actionsWrap = document.createElement('div');
        actionsWrap.style.display = 'flex';
        actionsWrap.style.gap = '0.5rem';
        if (job.status === 'ready' && job.downloadUrl) {
          const link = document.createElement('a');
          link.className = 'save-link';
          link.href = job.downloadUrl;
          link.download = job.filename || 'video';
          link.textContent = `Save File (${analyzer.formatBytes(job.fileSize)})`;
          actionsWrap.appendChild(link);
        }
        const dismissBtn = document.createElement('button');
        dismissBtn.type = 'button';
        dismissBtn.className = 'secondary-btn';
        dismissBtn.textContent = 'Remove';
        dismissBtn.addEventListener('click', () => {
          state.jobs = state.jobs.filter((j) => j.jobId !== job.jobId);
          renderJobs();
        });
        actionsWrap.appendChild(dismissBtn);
        top.appendChild(actionsWrap);
      }

      card.appendChild(top);

      if (isActive) {
        const track = document.createElement('div');
        track.className = 'progress-track';
        const fill = document.createElement('div');
        fill.className = 'progress-fill';
        fill.style.width = `${job.progress !== null ? job.progress : 35}%`;
        track.appendChild(fill);
        card.appendChild(track);
      }

      if (job.status === 'error' && job.error) {
        const errEl = document.createElement('div');
        errEl.className = 'alert-error';
        errEl.textContent = job.error;
        card.appendChild(errEl);
      }

      jobsList.appendChild(card);
    });
  }

  document.getElementById('modeVideoBtn').addEventListener('click', () => {
    state.mode = 'video';
    state.container = 'mp4';
    document.getElementById('modeVideoBtn').classList.add('active');
    document.getElementById('modeAudioBtn').classList.remove('active');
    renderWorkbench();
  });

  document.getElementById('modeAudioBtn').addEventListener('click', () => {
    state.mode = 'audio';
    state.container = 'mp3';
    document.getElementById('modeAudioBtn').classList.add('active');
    document.getElementById('modeVideoBtn').classList.remove('active');
    renderWorkbench();
  });

  function updateTrimSummary() {
    const summary = document.getElementById('trimSummary');
    if (!summary) return;
    const start = analyzer.timestampToSeconds(document.getElementById('trimStartInput').value);
    const end = analyzer.timestampToSeconds(document.getElementById('trimEndInput').value);
    if (start === null || end === null || end <= start) {
      summary.textContent = 'Enter a valid range where End is greater than Start.';
      return;
    }
    summary.textContent = `Selected clip: ${analyzer.secondsToTimestamp(end - start)}`;
  }

  document.getElementById('trimStartInput').addEventListener('input', updateTrimSummary);
  document.getElementById('trimEndInput').addEventListener('input', updateTrimSummary);

  document.getElementById('trimToggleBtn').addEventListener('click', () => {
    state.trimEnabled = !state.trimEnabled;
    document.getElementById('trimControls').classList.toggle('hidden', !state.trimEnabled);
    document.getElementById('trimToggleBtn').textContent = state.trimEnabled ? 'Enabled' : 'Enable Trim';
    updateTrimSummary();
  });

  analyzeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    analyzeError.classList.add('hidden');
    analyzeBtn.disabled = true;
    analyzeBtn.textContent = 'Analyzing...';

    try {
      const media = await analyzer.analyzeUrl(urlInput.value.trim());
      state.media = media;
      state.mode = media.videoFormats.length > 0 ? 'video' : 'audio';
      state.selectedFormatId = media.videoFormats[0]?.id || media.audioFormats[0]?.id || null;
      state.trimEnabled = false;
      document.getElementById('trimControls').classList.add('hidden');
      document.getElementById('trimToggleBtn').textContent = 'Enable Trim';
      document.getElementById('trimStartInput').value = '00:00';
      document.getElementById('trimEndInput').value = analyzer.secondsToTimestamp(media.duration || 30);
      updateTrimSummary();
      renderWorkbench();
    } catch (err) {
      analyzeError.textContent = err.message;
      analyzeError.classList.remove('hidden');
    } finally {
      analyzeBtn.disabled = false;
      analyzeBtn.textContent = 'Analyze URL';
    }
  });

  document.getElementById('startDownloadBtn').addEventListener('click', async () => {
    if (!state.media) return;
    analyzeError.classList.add('hidden');
    const formats = state.mode === 'video' ? state.media.videoFormats : state.media.audioFormats;
    const fmt = formats.find((f) => f.id === state.selectedFormatId) || formats[0];
    if (!fmt) return;

    const start = analyzer.timestampToSeconds(document.getElementById('trimStartInput').value);
    const end = analyzer.timestampToSeconds(document.getElementById('trimEndInput').value);
    if (state.trimEnabled && (start === null || end === null || end <= start)) {
      analyzeError.textContent = 'Trim end time must be strictly greater than start time.';
      analyzeError.classList.remove('hidden');
      return;
    }

    try {
      const job = await downloader.createJob({
        url: state.media.url,
        title: state.media.title,
        mode: state.mode,
        formatId: fmt.id,
        audioFormatId: fmt.audioFormatId,
        needsMerge: fmt.needsMerge,
        container: state.container,
        isDirectMedia: state.media.isDirectMedia,
        duration: state.media.duration,
        trim: { enabled: state.trimEnabled, start: start || 0, end: end || 0 },
        speed: state.speed,
      });

      state.jobs.unshift(job);
      renderJobs();

      downloader.subscribe(job.jobId, (updated) => {
        state.jobs = state.jobs.map((j) => (j.jobId === updated.jobId ? updated : j));
        renderJobs();
      });
    } catch (err) {
      analyzeError.textContent = err.message;
      analyzeError.classList.remove('hidden');
    }
  });
})();
