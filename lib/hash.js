import * as fs from 'node:fs';
import crypto from 'node:crypto';

/**
 * Calculates the MD5 hash of a given file.
 * @param {string} filePath - The path to the file to hash.
 * @returns {Promise<string>} A promise that resolves with the MD5 hash in hexadecimal format.
 */
export function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('md5');
    const s = fs.createReadStream(filePath);
    s.on('error', reject);
    s.on('data', (chunk) => h.update(chunk));
    s.on('end', () => resolve(h.digest('hex')));
  });
}
