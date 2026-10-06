// Probing of local files (downloaded episodes): the same container / codec detection as for a
// remote source, read straight from the disk. Kept apart from probe.ts so that the unit tests
// (no expo-file-system there) can import the policy.
import { File } from 'expo-file-system';

import { probeBytes, type Probe } from './policy';
import { setLocalSniffer } from './probe';

/** Container + codecs of a local file (`file://…` or a path), null when it cannot be read. */
export function sniffLocalFile(uri: string): Probe | null {
  try {
    const file = new File(uri);
    if (!file.exists) return null;
    const h = file.open();
    try {
      const size = h.size ?? file.size;
      return probeBytes((start, length) => {
        if (start >= size) return null;
        h.offset = start;
        return h.readBytes(Math.min(length, size - start));
      });
    } finally {
      h.close();
    }
  } catch {
    return null;
  }
}

setLocalSniffer(sniffLocalFile);
