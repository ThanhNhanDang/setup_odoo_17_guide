import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import { LoggerService } from '../services/logger';

// ---------------------------------------------------------------------------
// Download utility with progress - replaces urllib.request.urlretrieve
// ---------------------------------------------------------------------------

export function downloadFile(
  url: string,
  destPath: string,
  logger: LoggerService,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;

    const request = protocol.get(url, (response) => {
      // Handle redirects
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        downloadFile(response.headers.location, destPath, logger).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode && response.statusCode !== 200) {
        reject(new Error(`Download failed: HTTP ${response.statusCode}`));
        return;
      }

      const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
      let downloadedBytes = 0;
      let lastLogPct = -1;

      const file = fs.createWriteStream(destPath);

      response.on('data', (chunk: Buffer) => {
        downloadedBytes += chunk.length;
        if (totalBytes > 0) {
          const pct = Math.round((downloadedBytes / totalBytes) * 100);
          // Log every 10%
          if (pct >= lastLogPct + 10) {
            lastLogPct = pct;
            const mb = (downloadedBytes / 1024 / 1024).toFixed(1);
            const totalMb = (totalBytes / 1024 / 1024).toFixed(1);
            logger.log(`    Download: ${mb}MB / ${totalMb}MB (${pct}%)`);
          }
        }
      });

      response.pipe(file);

      file.on('finish', () => {
        file.close();
        resolve();
      });

      file.on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    });

    request.on('error', (err) => {
      reject(err);
    });

    request.setTimeout(300_000, () => {
      request.destroy();
      reject(new Error('Download timeout'));
    });
  });
}
