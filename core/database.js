const DB_NAME = "UniversalFileConverterDB";
const DB_VERSION = 1;
const FILE_STORE = "files";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(FILE_STORE)) {
        db.createObjectStore(FILE_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Unable to open IndexedDB"));
  });
}

async function transact(mode, action) {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(FILE_STORE, mode);
      const store = transaction.objectStore(FILE_STORE);
      let request;
      try {
        request = action(store);
      } catch (error) {
        reject(error);
        return;
      }
      if (request) {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
      } else {
        transaction.oncomplete = () => resolve(undefined);
      }
      transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
      transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
    });
  } finally {
    db.close();
  }
}

export async function putFile(id, file) {
  return transact("readwrite", store => store.put({
    id,
    file,
    name: file.name,
    size: file.size,
    type: file.type,
    lastModified: file.lastModified,
    createdAt: Date.now()
  }));
}

export async function getStoredFile(id) {
  const record = await transact("readonly", store => store.get(id));
  return record?.file || null;
}

export async function deleteStoredFile(id) {
  return transact("readwrite", store => store.delete(id));
}

export async function clearStoredFiles() {
  return transact("readwrite", store => store.clear());
}
