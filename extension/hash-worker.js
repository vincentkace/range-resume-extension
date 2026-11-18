import { Sha256 } from './sha256.js';
const hash = new Sha256();
self.onmessage = ({ data }) => {
  try {
    const result = data.type === 'digest' ? hash.digest() : (hash.update(data.bytes), null);
    self.postMessage({ id: data.id, result });
  } catch (error) { self.postMessage({ id: data.id, error: error.message }); }
};
