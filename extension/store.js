function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('range-resume', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('tasks', { keyPath: 'task.id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function transaction(mode, operation) {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('tasks', mode);
      const request = operation(tx.objectStore('tasks'));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('任务记录写入中断。'));
    });
  } finally { db.close(); }
}
export const list = () => transaction('readonly', store => store.getAll());
export const put = record => transaction('readwrite', store => store.put(record));
export const remove = id => transaction('readwrite', store => store.delete(id));
