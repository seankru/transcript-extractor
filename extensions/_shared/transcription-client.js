// Shared popup client, copied into each independently installable extension.
const localTranscription = (() => {
  let timer;
  let busy = false;
  let pending = null;
  let preferenceError = null;
  let extractionStarted = false;
  let statusVersion = 0;
  const automatic = document.getElementById('auto-transcribe');
  const confirmation = document.getElementById('transcription-confirmation');
  const preferenceKey = 'automaticLocalTranscription';
  const terminal = job => ['complete', 'failed'].includes(job?.state);

  function showError(message) {
    const status = document.getElementById('status');
    status.textContent = message;
    status.classList.add('error');
  }

  const settingsReady = chrome.storage.local.get(preferenceKey).then(settings => {
    automatic.checked = settings[preferenceKey] === true;
    automatic.disabled = false;
  }).catch(error => {
    preferenceError = 'Could not load automatic transcription preference: ' + error.message;
    showError(preferenceError);
  });
  let saving = settingsReady;
  automatic.addEventListener('change', () => {
    const checked = automatic.checked;
    automatic.disabled = true;
    saving = chrome.storage.local.set({ [preferenceKey]: checked }).then(() => {
      preferenceError = null;
    }).catch(error => {
      automatic.checked = !checked;
      preferenceError = 'Could not save automatic transcription preference: ' + error.message;
      showError(preferenceError);
    }).finally(() => { automatic.disabled = false; });
  });

  function show(job) {
    pending = null;
    confirmation.hidden = true;
    busy = !terminal(job);
    const status = document.getElementById('status');
    status.textContent = job.message +
      (!terminal(job) ? '\nYou can close this popup. Reopen it to see progress.' : '');
    status.classList.toggle('error', job.state === 'failed');
    document.getElementById('extract').disabled = !terminal(job);
    if (!terminal(job)) {
      clearTimeout(timer);
      timer = setTimeout(restore, 2500);
    }
  }

  async function restore() {
    const version = statusVersion;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'transcription-status' });
      if (version !== statusVersion) return;
      if (response?.error) throw new Error(response.error);
      if (response?.job && !pending && (!extractionStarted || !terminal(response.job))) show(response.job);
    } catch (error) {
      if (version !== statusVersion || extractionStarted) return;
      const status = document.getElementById('status');
      status.textContent = 'Could not read local transcription status: ' + error.message;
      status.classList.add('error');
    }
  }

  async function queue(provider, tab, format, name) {
    extractionStarted = false;
    statusVersion++;
    pending = null;
    confirmation.hidden = true;
    busy = true;
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'transcribe', provider, tabId: tab.id, tabUrl: tab.url, format, name,
      });
      if (response?.error) throw new Error(response.error);
      if (!response?.job) throw new Error('The local transcription worker returned no job.');
      show(response.job);
    } catch (error) {
      busy = false;
      throw error;
    }
  }

  async function start(provider, tab, format, name) {
    await saving;
    if (preferenceError) throw new Error(preferenceError);
    const settings = await chrome.storage.local.get(preferenceKey);
    if (settings[preferenceKey] === true) return queue(provider, tab, format, name);
    clearTimeout(timer);
    pending = { provider, tab, format, name };
    confirmation.hidden = false;
    const status = document.getElementById('status');
    status.textContent = 'No usable published transcript. Download the recording and transcribe it locally with Whisper? ' +
      'This uses bandwidth and CPU, may download model weights on first use, and saves the transcript to Downloads.';
    status.classList.remove('error');
  }

  document.getElementById('extract').addEventListener('click', () => {
    extractionStarted = true;
    statusVersion++;
    pending = null;
    confirmation.hidden = true;
    clearTimeout(timer);
    chrome.runtime.sendMessage({ type: 'transcription-dismiss' }).then(response => {
      if (response?.error) showError('Could not clear previous transcription status: ' + response.error);
    }).catch(error => {
      showError('Could not clear previous transcription status: ' + error.message);
    });
  });
  document.getElementById('transcription-confirm').addEventListener('click', async () => {
    if (!pending || busy) return;
    const { provider, tab, format, name } = pending;
    pending = null;
    confirmation.hidden = true;
    document.getElementById('extract').disabled = true;
    try {
      await queue(provider, tab, format, name);
    } catch (error) {
      showError('Could not start local transcription: ' + error.message);
    } finally {
      document.getElementById('extract').disabled = busy;
    }
  });
  document.getElementById('transcription-cancel').addEventListener('click', () => {
    pending = null;
    confirmation.hidden = true;
    const status = document.getElementById('status');
    status.textContent = 'Local transcription cancelled. No recording was downloaded or job started.';
    status.classList.remove('error');
  });

  // Defer until the popup's existing caption discovery has initialized.
  window.addEventListener('load', restore);
  return { start, restore, get busy() { return busy; } };
})();
