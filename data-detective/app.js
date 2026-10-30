(() => {
  const $ = selector => document.querySelector(selector);
  const welcome = $('#welcome'), conversation = $('#conversation'), input = $('#fileInput');
  const question = $('#questionInput'), followup = $('#followupInput');
  const analyze = $('#analyzeButton'), askFollowup = $('#followupButton'), externalConsent = $('#externalConsent');
  const state = { file: null, csv: '', sessionId: '', report: [], busy: false, sample: false, chartData: '', reportMarkdown: '' };
  const sampleCsv = `date,region,channel,product,revenue,orders,ad_spend,customer_rating\n2025-01-01,North,Search,Atlas,12400,42,1800,4.5\n2025-01-01,South,Social,Beacon,8300,31,2400,4.1\n2025-01-01,East,Email,Atlas,9200,38,600,4.7\n2025-01-01,West,Search,Cirrus,10400,35,1500,4.3\n2025-02-01,North,Social,Beacon,13800,48,2600,4.2\n2025-02-01,South,Email,Atlas,10100,40,650,4.8\n2025-02-01,East,Search,Cirrus,11900,41,1650,4.4\n2025-02-01,West,Social,Atlas,11300,39,2300,4.6\n2025-03-01,North,Email,Cirrus,15700,53,700,4.8\n2025-03-01,South,Search,Beacon,10700,37,1700,3.9\n2025-03-01,East,Social,Atlas,14600,51,2800,4.6\n2025-03-01,West,Email,Beacon,12100,43,720,4.4\n2025-04-01,North,Search,Beacon,16900,56,1900,4.3\n2025-04-01,South,Social,Cirrus,11500,39,2700,4.2\n2025-04-01,East,Email,Beacon,13200,45,740,4.7\n2025-04-01,West,Search,Atlas,15400,50,1800,4.9\n2025-05-01,North,Social,Atlas,18100,60,2900,4.7\n2025-05-01,South,Email,Cirrus,12400,42,800,4.4\n2025-05-01,East,Search,Beacon,15800,52,1850,4.1\n2025-05-01,West,Social,Cirrus,14800,47,2500,4.3\n2025-06-01,North,Email,Beacon,20300,66,820,4.8\n2025-06-01,South,Search,Atlas,13900,46,1950,4.5\n2025-06-01,East,Social,Cirrus,17600,57,3100,4.4\n2025-06-01,West,Email,Atlas,16900,54,850,4.8`;

  function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 2800); }
  function esc(s) { return s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]); }
  function setFile(file, content) {
    state.file = file; state.csv = content; state.sample = file.name === 'sample-growth-data.csv';
    const selected = $('#selectedFile'); selected.hidden = false; selected.textContent = `✓  ${file.name} · ${(file.size / 1024).toFixed(1)} KB`;
    analyze.disabled = !question.value.trim() || state.busy || !externalConsent.checked;
  }
  async function readFile(file) {
    if (!file || !file.name.toLowerCase().endsWith('.csv')) return toast('Please choose a .csv file.');
    if (file.size > 1_500_000) return toast('This CSV is over the 1.5 MB limit.');
    const content = await file.text();
    if (!content.trim() || content.includes('\0')) return toast('That file does not look like a readable CSV.');
    setFile(file, content);
  }
  $('#browseFiles').addEventListener('click', () => input.click());
  input.addEventListener('change', () => readFile(input.files[0]));
  $('#loadSample').addEventListener('click', () => {
    setFile(new File([sampleCsv], 'sample-growth-data.csv', { type: 'text/csv' }), sampleCsv);
    question.value = 'Which product and region show the strongest revenue growth?';
    analyze.disabled = !externalConsent.checked;
    question.focus();
    toast('Sample loaded. Confirm the data-sharing notice, then analyze it.');
  });
  const drop = $('#dropZone');
  ['dragenter', 'dragover'].forEach(name => drop.addEventListener(name, e => { e.preventDefault(); drop.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach(name => drop.addEventListener(name, e => { e.preventDefault(); drop.classList.remove('dragover'); }));
  drop.addEventListener('drop', e => readFile(e.dataTransfer.files[0]));
  question.addEventListener('input', () => analyze.disabled = !state.file || !question.value.trim() || state.busy || !externalConsent.checked);
  externalConsent.addEventListener('change', () => analyze.disabled = !state.file || !question.value.trim() || state.busy || !externalConsent.checked);
  followup.addEventListener('input', () => askFollowup.disabled = !followup.value.trim() || state.busy);
  document.querySelectorAll('.suggestions button').forEach(button => button.addEventListener('click', () => { question.value = button.dataset.question; analyze.disabled = !state.file || state.busy || !externalConsent.checked; if (!state.file) toast('Upload a CSV or try the sample dataset first.'); else beginAnalysis(); }));
  question.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); beginAnalysis(); } });
  followup.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendFollowup(); } });
  analyze.addEventListener('click', beginAnalysis); askFollowup.addEventListener('click', sendFollowup);
  $('#newAnalysis').addEventListener('click', () => { state.file = null; state.csv = ''; state.sessionId = ''; state.report = []; state.sample = false; state.chartData = ''; state.reportMarkdown = ''; input.value = ''; question.value = ''; followup.value = ''; $('#selectedFile').hidden = true; $('#thread').replaceChildren(); $('#downloadReport').disabled = true; conversation.hidden = true; welcome.hidden = false; window.scrollTo({ top: 0, behavior: 'smooth' }); });

  function addMessage(kind, text) {
    const node = document.createElement('div'); node.className = `message ${kind}`; node.textContent = text;
    $('#thread').append(node); node.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); return node;
  }
  const steps = ['Checking the file and its structure', 'Running Python to verify the numbers', 'Writing findings and caveats'];
  function showProgress() {
    const panel = $('#progressPanel'); panel.hidden = false;
    $('#progressSteps').innerHTML = steps.map((s, i) => `<div class="progress-step${i === 0 ? ' active' : ''}">${esc(s)}</div>`).join('');
    let index = 0; const timer = setInterval(() => { if (!state.busy) return clearInterval(timer); index = Math.min(index + 1, steps.length - 1); $('#progressSteps').querySelectorAll('.progress-step').forEach((el, i) => { el.classList.toggle('done', i < index); el.classList.toggle('active', i === index); }); $('#progressTitle').textContent = ['Reading the evidence', 'Checking the analysis', 'Preparing your findings'][index]; }, 5200);
  }
  function finishProgress() { state.busy = false; $('#progressPanel').hidden = true; askFollowup.disabled = !followup.value.trim(); $('#downloadReport').disabled = state.report.length === 0; }
  async function readEvents(response, answerNode) {
    if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new Error(payload.error || 'The analysis could not start.'); }
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
    while (true) {
      const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n'); buffer = frames.pop();
      for (const frame of frames) {
        const dataLine = frame.split('\n').find(line => line.startsWith('data: ')); if (!dataLine) continue;
        let event; try { event = JSON.parse(dataLine.slice(6)); } catch { continue; }
        if (/environment/.test(event.type || '')) $('#progressTitle').textContent = 'Preparing your Python workspace';
        else if (/command|tool/.test(event.type || '')) $('#progressTitle').textContent = 'Running Python analysis';
        else if (/item/.test(event.type || '')) $('#progressTitle').textContent = 'Checking the results and caveats';
        if (event.type === 'data_detective.artifact') {
          if (event.name === 'chart.png') state.chartData = event.data;
          if (event.name === 'report.md') state.reportMarkdown = new TextDecoder().decode(Uint8Array.from(atob(event.data), char => char.charCodeAt(0)));
        } else if (event.type === 'data_detective.complete') {
          if (event.session_id) state.sessionId = event.session_id;
          const text = event.output_text || 'The run finished without a written answer.';
          answerNode.textContent = text;
          if (state.chartData) {
            const image = document.createElement('img'); image.className = 'chart-preview'; image.alt = 'Chart generated from the dataset'; image.src = `data:image/png;base64,${state.chartData}`; answerNode.append(image); state.chartData = '';
          }
          state.report.push({ question: '', answer: text });
        } else if (event.type === 'data_detective.error') throw new Error(event.error);
        else if (/turn\.failed|turn\.cancelled/.test(event.type || '')) throw new Error('The agent could not complete this analysis. Please try again.');
      }
    }
    if (!state.sessionId) throw new Error('The analysis session ended before a response was saved. Please try again.');
  }
  function base64(text) { const bytes = new TextEncoder().encode(text); let binary = ''; for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(binary); }
  async function beginAnalysis() {
    if (!state.file || !question.value.trim() || state.busy) return;
    if (!externalConsent.checked) return toast('Please confirm that this CSV may be sent to OpenAI for analysis.');
    welcome.hidden = true; conversation.hidden = false; $('#datasetBadge').textContent = state.file.name;
    const ask = question.value.trim(); addMessage('user', ask); const answer = addMessage('assistant', ''); state.busy = true; analyze.disabled = true; askFollowup.disabled = true; showProgress();
    try {
      const response = await fetch('/api/data-detective/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: state.file.name, csv: base64(state.csv), question: ask }) });
      await readEvents(response, answer); state.report[state.report.length - 1].question = ask;
    } catch (error) { answer.textContent = 'The investigation hit a snag.'; $('#thread').insertAdjacentHTML('beforeend', `<div class="analysis-error">${esc(error.message)}</div>`); }
    finally { finishProgress(); }
  }
  async function sendFollowup() {
    const ask = followup.value.trim(); if (!ask || !state.sessionId || state.busy) return;
    state.reportMarkdown = '';
    followup.value = ''; addMessage('user', ask); const answer = addMessage('assistant', ''); state.busy = true; askFollowup.disabled = true; showProgress();
    try {
      const response = await fetch(`/api/data-detective/${encodeURIComponent(state.sessionId)}/follow-up`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: ask }) });
      await readEvents(response, answer); state.report[state.report.length - 1].question = ask;
    } catch (error) { answer.textContent = 'The follow-up hit a snag.'; $('#thread').insertAdjacentHTML('beforeend', `<div class="analysis-error">${esc(error.message)}</div>`); }
    finally { finishProgress(); }
  }
  $('#downloadReport').addEventListener('click', () => {
    const report = state.reportMarkdown || [`# Data Detective report\n\n**Dataset:** ${state.file?.name || 'CSV'}\n\n**Generated:** ${new Date().toLocaleString()}\n\n---\n`, ...state.report.map((item, i) => `\n## ${i + 1}. ${item.question || 'Finding'}\n\n${item.answer}\n\n---\n`)].join('');
    const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([report], { type: 'text/markdown;charset=utf-8' })); link.download = 'data-detective-report.md'; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });
})();
