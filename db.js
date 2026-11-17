// Tiny IndexedDB wrapper. Everything is stored on-device in the browser.
const DB = (() => {
  const NAME = 'recipes-db';
  const VERSION = 1;
  let dbPromise;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('recipes')) db.createObjectStore('recipes', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('media')) db.createObjectStore('media', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function tx(stores, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode);
      let result;
      Promise.resolve(fn(t)).then(r => { result = r; });
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Transaction aborted'));
    });
  }

  const wrap = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

  return {
    async allRecipes() {
      return tx(['recipes'], 'readonly', t => wrap(t.objectStore('recipes').getAll()));
    },
    async getRecipe(id) {
      return tx(['recipes'], 'readonly', t => wrap(t.objectStore('recipes').get(id)));
    },
    async saveRecipe(recipe, newMedia = [], deletedMediaIds = []) {
      return tx(['recipes', 'media'], 'readwrite', t => {
        const ms = t.objectStore('media');
        newMedia.forEach(m => ms.put({ id: m.id, blob: m.blob, type: m.type }));
        deletedMediaIds.forEach(id => ms.delete(id));
        t.objectStore('recipes').put(recipe);
      });
    },
    async deleteRecipe(recipe) {
      const ids = mediaIdsOf(recipe);
      return tx(['recipes', 'media'], 'readwrite', t => {
        ids.forEach(id => t.objectStore('media').delete(id));
        t.objectStore('recipes').delete(recipe.id);
      });
    },
    async getMedia(id) {
      return tx(['media'], 'readonly', t => wrap(t.objectStore('media').get(id)));
    },
    async allMedia() {
      return tx(['media'], 'readonly', t => wrap(t.objectStore('media').getAll()));
    },
    async putMedia(items) {
      return tx(['media'], 'readwrite', t => { items.forEach(m => t.objectStore('media').put(m)); });
    },
    async putRecipes(items) {
      return tx(['recipes'], 'readwrite', t => { items.forEach(r => t.objectStore('recipes').put(r)); });
    },
  };
})();

function mediaIdsOf(recipe) {
  const ids = [...(recipe.media || [])];
  (recipe.steps || []).forEach(s => ids.push(...(s.media || [])));
  if (recipe.cover) ids.push(recipe.cover);
  return [...new Set(ids)];
}
