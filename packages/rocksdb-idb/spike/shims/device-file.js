// device-file (CORESTORE lock file, native fs locks) has no meaning without a file system: the
// browser storage is an injected rocksdb-idb instance, so hypercore-storage never constructs it.
module.exports = class DeviceFile {
  constructor() {
    throw new Error('device-file is not available in browsers')
  }
}
