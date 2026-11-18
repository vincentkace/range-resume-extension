export const BLOCK_SIZE = 8 * 1024 * 1024;
export const SAMPLE_SIZE = 64 * 1024;
export const JOURNAL = 'resume-task.json';
const HASH = /^[a-f0-9]{64}$/i;
const encoder = new TextEncoder();

export function cleanURL(value) {
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('请输入完整的 http:// 或 https:// 文件网址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('只支持 HTTP/HTTPS 网址，且网址不能包含用户名或密码。');
  }
  url.hash = '';
  return url.href;
}

export function cleanHash(value = '') {
  const hash = value.trim().toLowerCase();
  if (hash && !HASH.test(hash)) throw new Error('SHA-256 应为 64 位十六进制字符。');
  return hash;
}

export function filename(url) {
  let value = new URL(url).pathname.split('/').pop() || 'download.bin';
  try { value = decodeURIComponent(value); } catch { /* Keep the encoded name. */ }
  value = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 160);
  if (!value || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) value = `download-${value || 'file.bin'}`;
  return value;
}

export async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
}

function stopped(signal) {
  if (signal?.aborted) throw new DOMException('已暂停', 'AbortError');
}

export function contentRange(value) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value || '');
  if (!match) throw new Error('服务器没有提供有效的 Content-Range，不能安全续传。');
  const [start, end, total] = match.slice(1).map(Number);
  if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || end >= total) {
    throw new Error('服务器返回的文件范围无效。');
  }
  return { start, end, total };
}

// Only complete, bounded responses reach disk. A partial network response is discarded.
export async function range(url, start, end, { signal, fetcher = fetch, identity = null } = {}) {
  stopped(signal);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  let timer;
  let timedOut = false;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { timedOut = true; controller.abort(); }, 45000);
  };
  let reader;
  try {
    arm();
    const headers = { Range: `bytes=${start}-${end}` };
    if (identity?.etag && !identity.etag.startsWith('W/')) headers['If-Match'] = identity.etag;
    else if (identity?.lastModified) headers['If-Unmodified-Since'] = identity.lastModified;
    const response = await fetcher(url, { headers, signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'error' });
    if (response.status === 416 && start === 0 && response.headers.get('content-range') === 'bytes */0') {
      await response.body?.cancel();
      return { bytes: new Uint8Array(), total: 0, etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified') };
    }
    if (response.status !== 206) {
      await response.body?.cancel();
      if (response.status === 200) throw new Error('服务器返回了完整页面或忽略了 Range。请使用具体文件的网址，确认服务支持断点续传。');
      if (response.status === 412) throw new Error('服务器文件已变化（HTTP 412），已停止以保护已下载内容。');
      throw new Error(`无法获取文件范围：HTTP ${response.status}。请检查新网址、隧道连接和访问权限。`);
    }
    const encoding = response.headers.get('content-encoding');
    if (encoding && encoding !== 'identity') { await response.body?.cancel(); throw new Error('服务器对文件进行了压缩转换，无法安全按字节续传。'); }
    const bounds = contentRange(response.headers.get('content-range'));
    if (bounds.start !== start || bounds.end !== Math.min(end, bounds.total - 1)) {
      await response.body?.cancel(); throw new Error('服务器返回的范围与请求不符，已停止写入。');
    }
    const etag = response.headers.get('etag');
    const lastModified = response.headers.get('last-modified');
    if (identity && (bounds.total !== identity.total || (identity.etag && etag && identity.etag !== etag) ||
        (identity.lastModified && lastModified && identity.lastModified !== lastModified))) {
      await response.body?.cancel(); throw new Error('下载过程中源文件的大小或版本发生变化，已停止写入。');
    }
    const expected = bounds.end - bounds.start + 1;
    if (expected > BLOCK_SIZE) { await response.body?.cancel(); throw new Error('单次请求超过安全范围。'); }
    const bytes = new Uint8Array(expected);
    reader = response.body?.getReader();
    if (!reader) throw new Error('服务器没有返回文件内容。');
    let received = 0;
    while (true) {
      arm();
      const { value, done } = await reader.read();
      if (done) break;
      if (received + value.byteLength > expected) throw new Error('服务器返回的内容超过声明范围，已丢弃本次数据。');
      bytes.set(value, received);
      received += value.byteLength;
    }
    if (received !== expected) throw new Error('连接中断或响应不完整；之前完整保存的数据仍然有效。');
    return { bytes, total: bounds.total, etag, lastModified };
  } catch (error) {
    if (signal?.aborted) throw new DOMException('已暂停', 'AbortError');
    if (timedOut) throw new Error('连接超过 45 秒没有收到数据，已停止；可以更换网址后继续。');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    try { await reader?.cancel(); } catch { /* A disconnected response may already be closed. */ }
    controller.abort();
  }
}

export async function probe(value, options = {}) {
  const url = cleanURL(value);
  const head = await range(url, 0, SAMPLE_SIZE - 1, options);
  const headHash = await sha256(head.bytes);
  const tail = head.total > SAMPLE_SIZE ? await range(url, head.total - SAMPLE_SIZE, head.total - 1, {
    ...options, identity: { total: head.total, etag: head.etag, lastModified: head.lastModified }
  }) : head;
  return { url, name: filename(url), total: head.total, headHash, tailHash: await sha256(tail.bytes), etag: head.etag, lastModified: head.lastModified };
}

export function compareIdentity(original, next) {
  if (original.total !== next.total || original.headHash !== next.headHash || original.tailHash !== next.tailHash ||
      (original.etag && next.etag && original.etag !== next.etag) ||
      (original.lastModified && next.lastModified && original.lastModified !== next.lastModified)) {
    throw new Error('新链接的文件大小、抽样内容或版本与原文件不一致，不能接着此任务下载。请新建任务。');
  }
}

export const blockName = index => `${String(index).padStart(8, '0')}.chunk`;
export const completedBytes = task => task.chunks.reduce((total, chunk) => total + chunk.size, 0);

export async function writeFile(directory, name, data) {
  const handle = await directory.getFileHandle(name, { create: true });
  const stream = await handle.createWritable();
  try { await stream.write(data); await stream.close(); }
  catch (error) { try { await stream.abort(); } catch {} throw error; }
}

export async function saveTask(directory, task) {
  task.updatedAt = new Date().toISOString();
  await writeFile(directory, JOURNAL, encoder.encode(JSON.stringify(task, null, 2)));
}

export function validateTask(task) {
  if (!task || task.schema !== 1 || typeof task.id !== 'string' || !/^[a-z0-9-]{8,80}$/i.test(task.id) ||
      typeof task.name !== 'string' || task.name !== filename(`https://local/${encodeURIComponent(task.name)}`) ||
      task.blockSize !== BLOCK_SIZE || !Number.isSafeInteger(task.total) || task.total < 0 ||
      !task.identity || task.identity.total !== task.total || !HASH.test(task.identity.headHash) || !HASH.test(task.identity.tailHash) ||
      !Array.isArray(task.chunks) || task.chunks.length > 100000) throw new Error('任务记录无效或版本不兼容。');
  cleanURL(task.url);
  cleanHash(task.expectedHash || '');
  for (let i = 0; i < task.chunks.length; i++) {
    const chunk = task.chunks[i];
    if (chunk.index !== i || !HASH.test(chunk.sha256) || chunk.size !== Math.min(BLOCK_SIZE, task.total - i * BLOCK_SIZE) || chunk.size <= 0) {
      throw new Error('任务分块记录不连续或大小无效。');
    }
  }
  return task;
}

export async function readTask(directory) {
  const file = await (await directory.getFileHandle(JOURNAL)).getFile();
  if (file.size > 8 * 1024 * 1024) throw new Error('任务记录过大。');
  return validateTask(JSON.parse(await file.text()));
}

export async function createTask(parent, identity, expectedHash = '') {
  const id = crypto.randomUUID();
  const directory = await parent.getDirectoryHandle(`续传下载-${id.slice(0, 8)}`, { create: true });
  await directory.getDirectoryHandle('blocks', { create: true });
  const task = { schema: 1, id, name: identity.name, url: identity.url, total: identity.total, identity,
    blockSize: BLOCK_SIZE, expectedHash: cleanHash(expectedHash), chunks: [], status: 'paused', message: '任务已创建，可以开始下载。',
    createdAt: new Date().toISOString(), actualHash: null };
  await saveTask(directory, task);
  return { task, directory };
}

export async function verifyLocal(directory, task) {
  const blocks = await directory.getDirectoryHandle('blocks');
  for (const chunk of task.chunks) {
    let file;
    try { file = await (await blocks.getFileHandle(blockName(chunk.index))).getFile(); }
    catch { throw new Error('本地分块文件缺失，请恢复原任务目录。'); }
    if (file.size !== chunk.size) throw new Error('本地分块大小发生变化，不能安全继续。');
  }
  if (task.chunks.length) {
    const last = task.chunks.at(-1);
    const data = await (await (await blocks.getFileHandle(blockName(last.index))).getFile()).arrayBuffer();
    if (await sha256(data) !== last.sha256) throw new Error('最后一个本地分块校验失败，已停止续传。');
  }
  return blocks;
}

export async function download(directory, task, value, { signal, fetcher, onProgress = () => {} } = {}) {
  validateTask(task);
  let blocks;
  try {
    blocks = await verifyLocal(directory, task);
    stopped(signal);
    const identity = await probe(value, { signal, fetcher });
    compareIdentity(task.identity, identity);
    if (task.chunks.length) {
      const last = task.chunks.at(-1);
      const start = last.index * BLOCK_SIZE;
      const remote = await range(identity.url, start, start + last.size - 1, { signal, fetcher, identity });
      if (await sha256(remote.bytes) !== last.sha256) throw new Error('新链接与已经保存的最后一个分块不一致，已停止续传。');
    }
    task.url = identity.url;
    task.status = 'downloading';
    task.message = '连接检查通过，正在下载。';
    await saveTask(directory, task);
    await onProgress(task);
    while (completedBytes(task) < task.total) {
      stopped(signal);
      const start = completedBytes(task);
      const end = Math.min(start + BLOCK_SIZE, task.total) - 1;
      const result = await range(task.url, start, end, { signal, fetcher, identity });
      stopped(signal);
      const chunk = { index: task.chunks.length, size: result.bytes.byteLength, sha256: await sha256(result.bytes) };
      await writeFile(blocks, blockName(chunk.index), result.bytes);
      // Update progress only after both the block and the journal have committed.
      const next = { ...task, chunks: [...task.chunks, chunk] };
      await saveTask(directory, next);
      Object.assign(task, next);
      await onProgress(task);
    }
    task.status = 'ready';
    task.message = '下载完成，请导出并校验文件。';
  } catch (error) {
    task.status = signal?.aborted ? 'paused' : 'error';
    task.message = signal?.aborted ? '已暂停，完整保存的分块可继续使用。' : (error.message || '网络连接失败，可以检查或更换网址后继续。');
    throw error;
  } finally {
    await saveTask(directory, task);
    await onProgress(task);
  }
}

// createWritable() replaces the destination only at close(). Abort on any hash mismatch.
export async function exportTask(directory, task, output, hasher, { signal, onProgress = () => {} } = {}) {
  validateTask(task);
  if (completedBytes(task) !== task.total) throw new Error('文件尚未下载完整。');
  const blocks = await verifyLocal(directory, task);
  if (output.isSameEntry) {
    const journal = await directory.getFileHandle(JOURNAL);
    if (await output.isSameEntry(journal)) throw new Error('最终文件不能覆盖任务记录，请选择任务目录以外的保存位置。');
    const chunk = task.chunks.find(item => blockName(item.index) === output.name);
    if (chunk && await output.isSameEntry(await blocks.getFileHandle(blockName(chunk.index)))) {
      throw new Error('最终文件不能覆盖下载分块，请选择任务目录以外的保存位置。');
    }
  }
  const writable = await output.createWritable();
  let written = 0;
  let committed = false;
  try {
    for (const chunk of task.chunks) {
      stopped(signal);
      const data = await (await (await blocks.getFileHandle(blockName(chunk.index))).getFile()).arrayBuffer();
      if (await sha256(data) !== chunk.sha256) throw new Error(`本地分块 ${chunk.index + 1} 校验失败，导出已取消。`);
      await writable.write(new Uint8Array(data));
      await hasher.update(data);
      written += chunk.size;
      await onProgress(written, task.total);
    }
    stopped(signal);
    const actual = await hasher.digest();
    task.actualHash = actual;
    if (task.expectedHash && actual !== task.expectedHash) throw new Error('完整文件 SHA-256 与预期不符，未提交导出文件。请核对原始文件及其校验值。');
    await writable.close();
    committed = true;
    task.status = 'complete';
    task.message = task.expectedHash ? '导出完成，SHA-256 校验通过。' : '导出完成；已计算 SHA-256，请与发送方提供的校验值核对。';
    await saveTask(directory, task);
    return actual;
  } catch (error) {
    task.status = signal?.aborted ? 'ready' : 'error';
    task.message = signal?.aborted ? '导出已取消，下载分块仍然保留。' : error.message;
    await saveTask(directory, task);
    throw error;
  } finally {
    if (!committed) { try { await writable.abort(); } catch {} }
    hasher.close?.();
  }
}
