window.ClipFetchDownloader = {
  async createJob(payload) {
    const response = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Could not start download job.');
    }
    return data;
  },

  async cancelJob(jobId) {
    await fetch(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
  },

  subscribe(jobId, onUpdate) {
    let closedByTerminal = false;
    let currentEs = null;
    let retryTimer = null;

    const connect = () => {
      currentEs = new EventSource(`/api/jobs/${jobId}/events`);
      currentEs.onmessage = (event) => {
        try {
          const snapshot = JSON.parse(event.data);
          onUpdate(snapshot);
          if (['ready', 'error', 'cancelled'].includes(snapshot.status)) {
            closedByTerminal = true;
            currentEs.close();
          }
        } catch (_) {}
      };
      currentEs.onerror = () => {
        currentEs.close();
        if (closedByTerminal) return;
        fetch(`/api/jobs/${jobId}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((snapshot) => {
            if (!snapshot) return;
            onUpdate(snapshot);
            if (!['ready', 'error', 'cancelled'].includes(snapshot.status)) {
              retryTimer = setTimeout(connect, 1000);
            } else {
              closedByTerminal = true;
            }
          })
          .catch(() => {});
      };
    };

    connect();
    return {
      close() {
        closedByTerminal = true;
        if (retryTimer) clearTimeout(retryTimer);
        if (currentEs) currentEs.close();
      },
    };
  },
};
