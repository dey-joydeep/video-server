import * as fs from 'node:fs';
import crypto from 'node:crypto';

export function hashFile(filePath) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('md5');
        const s = fs.createReadStream(filePath);
        s.on('error', reject);
        s.on('data', (chunk) => h.update(chunk));
        s.on('end', () => resolve(h.digest('hex')));
    });
}
