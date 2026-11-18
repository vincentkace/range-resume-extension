import * as core from './core.js';
import * as store from './store.js';

const $ = id => document.getElementById(id);
const labels = { downloading: '下载中', paused: '已暂停', error: '需要处理', ready: '待导出', complete: '已导出' };
let records = [];
let active = null;
let checked = null;
let busy = false;
let controller = null;
let checking = false;

function size(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const unit = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** unit).toFixed(unit > 1 ? 2 : 1)} ${['B','KiB','MiB','GiB'][unit]}`;
}

function notice(message, error = false) {
  $('notice').textContent = message;
  $('notice').classList.toggle('error', error);
  $('notice').hidden = !message;
}

function explain(error) {
  if (error.name === 'AbortError') return '操作已取消，已保存的数据仍然保留。';
  if (['NotAllowedError','SecurityError'].includes(error.name)) return '浏览器没有授予文件或网址访问权限。请通过按钮重新授权；沙箱策略也可能限制此功能。';
  if (error instanceof TypeError) return '网络请求失败。请检查新网址、Cloudflare 隧道、扩展的网站权限及沙箱访问策略。';
  return error.message || String(error);
}

async function remember(record) {
  const index = records.findIndex(item => item.task.id === record.task.id);
  if (index < 0) records.unshift(record);
  else records[index] = record;
  try { await store.put(record); }
  catch { notice('浏览器任务列表未能保存。分块和任务记录仍在本地任务目录，下次可以通过“导入任务目录”恢复。', true); }
}

function renderList() {
  $('tasks').replaceChildren();
  $('task-count').textContent = records.length;
  if (!records.length) {
    const empty = document.createElement('div');
    empty.className = 'no-tasks';
    empty.textContent = '还没有下载任务';
    $('tasks').append(empty);
  }
  for (const record of records) {
    const button = document.createElement('button');
    button.className = `task-row${active?.task.id === record.task.id ? ' selected' : ''}`;
    button.disabled = busy || checking;
    const title = document.createElement('strong');
    title.textContent = record.task.name;
    const subtitle = document.createElement('small');
    subtitle.textContent = `${size(core.completedBytes(record.task))} / ${size(record.task.total)} · ${labels[record.task.status] || '已保存'}`;
    button.append(title, subtitle);
    button.addEventListener('click', () => selectRecord(record).catch(error => notice(explain(error), true)));
    $('tasks').append(button);
  }
}

function render(fields = false) {
  renderList();
  $('empty').hidden = !!active;
  $('details').hidden = !active;
  for (const id of ['check','import','new-url','new-hash']) $(id).disabled = busy || checking;
  $('create').disabled = busy || checking || !checked;
  if (!active) return;
  const { task, directory } = active;
  const done = core.completedBytes(task);
  const percent = task.total ? done / task.total * 100 : 100;
  $('file-name').textContent = task.name;
  $('status').textContent = labels[task.status] || '已保存';
  $('downloaded').textContent = size(done);
  $('total').textContent = size(task.total);
  $('percent').textContent = `${percent.toFixed(1)}%`;
  $('progress').value = percent;
  $('task-message').textContent = task.message || '';
  $('folder').textContent = `任务目录：${directory.name}`;
  if (fields) { $('task-url').value = task.url; $('task-hash').value = task.expectedHash || ''; }
  $('task-url').disabled = busy;
  $('task-hash').disabled = busy;
  $('resume').disabled = busy || checking;
  $('resume').textContent = done === task.total ? '重新检查链接' : done ? '继续下载' : '开始下载';
  $('pause').disabled = !busy;
  $('pause').textContent = busy && !$('export-progress').hidden ? '取消导出' : '暂停';
  $('export').disabled = busy || checking || done !== task.total;
  $('forget').disabled = busy || checking;
  $('hash-result').hidden = !task.actualHash;
  $('actual-hash').textContent = task.actualHash || '';
}

async function selectRecord(record) {
  if (busy) return;
  if (await record.directory.queryPermission({ mode: 'readwrite' }) === 'granted') {
    record.task = await core.readTask(record.directory);
    if (record.task.status === 'downloading') {
      record.task.status = 'paused';
      record.task.message = '上次下载已中断，完整保存的分块可以继续使用。';
    }
  }
  active = record;
  $('export-progress').hidden = true;
  render(true);
}

async function authorize(value) {
  const url = core.cleanURL(value);
  const pattern = `${new URL(url).origin}/*`;
  const allowed = await chrome.permissions.request({ origins: [pattern] });
  if (!allowed) throw new Error('尚未授予此网址的访问权限，未开始下载。');
  return url;
}

async function directoryPermission(directory) {
  if (await directory.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('需要重新授权本地任务目录才能继续。');
}

async function locked(operation) {
  const record = active;
  if (busy || !record) return;
  busy = true;
  controller = new AbortController();
  render();
  try {
    await navigator.locks.request(`range-resume-${record.task.id}`, { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('这个任务正在另一个扩展标签页中使用，请先暂停另一个页面。');
      await operation(record, controller.signal);
    });
  } catch (error) { notice(explain(error), error.name !== 'AbortError'); }
  finally {
    busy = false;
    controller = null;
    await remember(record);
    render();
  }
}

async function runDownload(record, value, signal) {
  // The directory journal is authoritative if a prior tab closed before IndexedDB updated.
  record.task = await core.readTask(record.directory);
  record.task.expectedHash = core.cleanHash($('task-hash').value);
  record.task.actualHash = null;
  await core.download(record.directory, record.task, value, {
    signal,
    onProgress: async () => { await remember(record); render(); }
  });
  notice('所有分块已保存。点击“导出并校验文件”生成最终文件。');
}

class WorkerHash {
  constructor() {
    this.worker = new Worker(new URL('./hash-worker.js', import.meta.url), { type: 'module' });
    this.pending = new Map();
    this.id = 0;
    this.worker.onmessage = ({ data }) => {
      const job = this.pending.get(data.id);
      if (!job) return;
      this.pending.delete(data.id);
      if (data.error) job.reject(new Error(data.error));
      else job.resolve(data.result);
    };
    this.worker.onerror = () => {
      this.failed = new Error('SHA-256 校验线程启动失败。');
      for (const job of this.pending.values()) job.reject(this.failed);
      this.pending.clear();
    };
  }
  send(type, bytes) {
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type, id, bytes }, bytes ? [bytes] : []);
    });
  }
  update(bytes) { return this.send('update', bytes); }
  digest() { return this.send('digest'); }
  close() {
    for (const job of this.pending.values()) job.reject(new Error('校验线程已关闭。'));
    this.pending.clear();
    this.worker.terminate();
  }
}

$('check').addEventListener('click', async () => {
  if (busy || checking) return;
  checking = true;
  $('check').disabled = true;
  $('check').textContent = '正在检查…';
  checked = null;
  $('probe-info').hidden = true;
  $('create').disabled = true;
  render();
  try {
    const url = await authorize($('new-url').value);
    core.cleanHash($('new-hash').value);
    checked = await core.probe(url);
    if ($('new-url').value.trim() !== url) $('new-url').value = url;
    $('probe-info').textContent = `${checked.name} · ${size(checked.total)} · Range 支持已确认`;
    $('probe-info').hidden = false;
    notice('链接检查通过，可以选择本地保存目录。');
  } catch (error) { notice(explain(error), true); }
  finally { checking = false; $('check').textContent = '授权并检查链接'; render(); }
});

$('new-url').addEventListener('input', () => { checked = null; $('probe-info').hidden = true; $('create').disabled = true; });

$('create').addEventListener('click', async () => {
  if (busy || !checked) return;
  try {
    const parent = await showDirectoryPicker({ id: 'range-resume-downloads', mode: 'readwrite' });
    const record = await core.createTask(parent, checked, $('new-hash').value);
    active = record;
    await remember(record);
    render(true);
    await locked((current, signal) => runDownload(current, checked.url, signal));
  } catch (error) { notice(explain(error), error.name !== 'AbortError'); }
});

$('resume').addEventListener('click', async () => {
  if (busy || !active) return;
  try {
    const url = await authorize($('task-url').value);
    await directoryPermission(active.directory);
    $('export-progress').hidden = true;
    await locked((record, signal) => runDownload(record, url, signal));
  } catch (error) { notice(explain(error), true); }
});

$('pause').addEventListener('click', () => { controller?.abort(); $('pause').disabled = true; });

$('export').addEventListener('click', async () => {
  if (busy || !active) return;
  try {
    const expectedHash = core.cleanHash($('task-hash').value);
    const output = await showSaveFilePicker({ suggestedName: active.task.name });
    await directoryPermission(active.directory);
    $('export-progress').textContent = '正在准备导出…';
    $('export-progress').hidden = false;
    await locked(async (record, signal) => {
      record.task = await core.readTask(record.directory);
      record.task.expectedHash = expectedHash;
      const hasher = new WorkerHash();
      try {
        await core.exportTask(record.directory, record.task, output, hasher, {
          signal,
          onProgress: (done, total) => { $('export-progress').textContent = `正在合并并校验：${size(done)} / ${size(total)}`; }
        });
      } finally { hasher.close(); }
      $('export-progress').textContent = record.task.message;
      notice(record.task.message);
    });
  } catch (error) { notice(explain(error), error.name !== 'AbortError'); }
});

$('import').addEventListener('click', async () => {
  if (busy) return;
  try {
    const directory = await showDirectoryPicker({ id: 'range-resume-import', mode: 'readwrite' });
    const task = await core.readTask(directory);
    const record = { task, directory };
    await remember(record);
    await selectRecord(record);
    notice('任务已恢复。输入可访问的文件网址后，点击“继续下载”。');
  } catch (error) { notice(explain(error), error.name !== 'AbortError'); }
});

$('forget').addEventListener('click', async () => {
  if (busy || !active) return;
  if (!confirm('仅移除浏览器列表记录。本地任务目录和下载分块会保留，可重新导入。继续吗？')) return;
  try {
    await store.remove(active.task.id);
    records = records.filter(record => record.task.id !== active.task.id);
    active = null;
    render();
    notice('列表记录已移除。本地任务目录未删除。');
  } catch (error) { notice(explain(error), true); }
});

window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });

try {
  if (!window.showDirectoryPicker || !window.showSaveFilePicker || !navigator.locks) {
    throw new Error('当前浏览器或沙箱不支持所需的本地文件接口。请使用允许文件访问的新版桌面 Chrome / Edge。');
  }
  records = await store.list();
  for (const record of records) {
    core.validateTask(record.task);
    if (record.task.status === 'downloading') record.task.status = 'paused';
  }
  records.sort((a, b) => b.task.updatedAt.localeCompare(a.task.updatedAt));
  if (records.length) await selectRecord(records[0]);
} catch (error) { notice(explain(error), true); }
render();
