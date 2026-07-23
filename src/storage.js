// Camada de persistência (IndexedDB). Substitui o antigo localStorage/window.storage
// do artefato de chat por um banco local real, assíncrono e sem limite prático de tamanho.

const DB_NAME = 'livro-de-gastos';
const DB_VERSION = 1;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (ev) => {
      const db = req.result;

      if (!db.objectStoreNames.contains('expenses')) {
        const store = db.createObjectStore('expenses', { keyPath: 'id' });
        store.createIndex('by_data', 'data', { unique: false });
        store.createIndex('by_parcelaKey', 'parcelaKey', { unique: false });
      }
      if (!db.objectStoreNames.contains('categories')) {
        db.createObjectStore('categories', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('faturas')) {
        db.createObjectStore('faturas', { keyPath: 'vencimento' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };

    req.onsuccess = () => {
      const db = req.result;
      // Se o schema for atualizado numa outra aba, fechamos esta conexão em vez de
      // travar o upgrade indefinidamente (bug clássico de IndexedDB multi-aba).
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Abertura do banco bloqueada por outra aba aberta do app. Feche outras abas/instâncias e recarregue.'));
  });
  return dbPromise;
}

function tx(db, storeName, mode) {
  let t;
  try {
    // 3º parâmetro (durability) é suportado nos navegadores modernos; em algum motor mais
    // antigo que rejeite a assinatura de 3 argumentos, cai pro modo padrão (2 argumentos).
    t = mode === 'readwrite' ? db.transaction(storeName, mode, { durability: 'strict' }) : db.transaction(storeName, mode);
  } catch (e) {
    t = db.transaction(storeName, mode);
  }
  return t.objectStore(storeName);
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getAll(storeName) {
  const db = await openDB();
  return reqToPromise(tx(db, storeName, 'readonly').getAll());
}

export async function get(storeName, key) {
  const db = await openDB();
  return reqToPromise(tx(db, storeName, 'readonly').get(key));
}

export async function put(storeName, value) {
  const db = await openDB();
  return reqToPromise(tx(db, storeName, 'readwrite').put(value));
}

export async function putMany(storeName, values) {
  if (!values.length) return;
  const db = await openDB();
  const store = tx(db, storeName, 'readwrite');
  await Promise.all(values.map((v) => reqToPromise(store.put(v))));
}

export async function remove(storeName, key) {
  const db = await openDB();
  return reqToPromise(tx(db, storeName, 'readwrite').delete(key));
}

export async function clearStore(storeName) {
  const db = await openDB();
  return reqToPromise(tx(db, storeName, 'readwrite').clear());
}

export async function resetAllData() {
  await clearStore('expenses');
  await clearStore('categories');
  await clearStore('faturas');
  await clearStore('meta');
}

export async function getByIndex(storeName, indexName, value) {
  const db = await openDB();
  const idx = tx(db, storeName, 'readonly').index(indexName);
  return reqToPromise(idx.getAll(value));
}

export async function getMeta(key, fallback = null) {
  const row = await get('meta', key);
  return row ? row.value : fallback;
}

export async function setMeta(key, value) {
  return put('meta', { key, value });
}

// --- Migração de dados legados (localStorage do arquivo HTML antigo, mesma origem) ---
// Só se aplica se o usuário abrir a PWA nova a partir do MESMO domínio/origem onde o
// gastos-app.html antigo salvava no localStorage. Na prática o caminho de migração
// recomendado é sempre "Backup completo" (.xlsx) no app antigo -> "Importar backup" no
// novo, mas isso aqui serve de rede de segurança caso o localStorage exista na mesma origem.
export async function migrateFromLocalStorageIfPresent() {
  try {
    const existing = await getAll('expenses');
    if (existing.length > 0) return { migrated: false, reason: 'já há dados no IndexedDB' };
    const rawExp = localStorage.getItem('expenses');
    const rawCat = localStorage.getItem('categories');
    if (!rawExp && !rawCat) return { migrated: false, reason: 'nada no localStorage' };
    const exp = rawExp ? JSON.parse(rawExp) : [];
    const cat = rawCat ? JSON.parse(rawCat) : [];
    await putMany('expenses', exp);
    await putMany('categories', cat);
    return { migrated: true, expenses: exp.length, categories: cat.length };
  } catch (e) {
    return { migrated: false, reason: e.message };
  }
}
