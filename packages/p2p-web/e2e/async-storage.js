// AsyncStorage for the e2e page bundle (the app uses an IndexedDB shim on web; localStorage is
// enough here).
const AsyncStorage = {
  getItem: async (k) => localStorage.getItem(k),
  setItem: async (k, v) => localStorage.setItem(k, v),
  removeItem: async (k) => localStorage.removeItem(k)
}
module.exports = AsyncStorage
module.exports.default = AsyncStorage
