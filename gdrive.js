const https = require('https');
const http = require('http');
const urlParser = require('url');

const activeBridgeStreams = new Map();

/**
 * Streams a file from the Android HTTP server (or local bridge stream) directly to Google Drive API.
 * Tracks progress and sends updates via socket.io.
 */
const uploadToGoogleDrive = (androidUrl, fileItem, accessToken, io, uploadId) => {
  return new Promise((resolve, reject) => {
    const parsedUrl = urlParser.parse(androidUrl, true);
    const transferId = parsedUrl.query.transferId;
    let sourceStream = null;

    // Check if there is an active memory bridge stream available
    if (transferId && activeBridgeStreams.has(transferId)) {
      sourceStream = activeBridgeStreams.get(transferId);
    }

    const startTime = Date.now();
    let bytesTransferred = 0;

    const startUpload = (streamSource, totalSize) => {
      // 2. Prepare Google Drive upload request
      const metadata = JSON.stringify({
        name: fileItem.name,
        mimeType: fileItem.mime || 'application/octet-stream'
      });

      const initOptions = {
        hostname: 'www.googleapis.com',
        path: '/upload/drive/v3/files?uploadType=resumable',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': fileItem.mime || 'application/octet-stream',
          'X-Upload-Content-Length': totalSize.toString()
        }
      };

      const initReq = https.request(initOptions, (initRes) => {
        if (initRes.statusCode !== 200) {
          reject(new Error(`Google Drive auth error: HTTP ${initRes.statusCode}`));
          return;
        }

        const uploadLocation = initRes.headers['location'];
        if (!uploadLocation) {
          reject(new Error('Failed to retrieve resumable upload URL from Google Drive.'));
          return;
        }

        const parsedLocation = urlParser.parse(uploadLocation);
        const putOptions = {
          hostname: parsedLocation.hostname,
          path: parsedLocation.path,
          method: 'PUT',
          headers: {
            'Content-Length': totalSize.toString()
          }
        };

        const driveReq = https.request(putOptions, (driveRes) => {
          let body = '';
          driveRes.on('data', chunk => body += chunk);
          driveRes.on('end', () => {
            if (transferId) activeBridgeStreams.delete(transferId);
            if (driveRes.statusCode === 200 || driveRes.statusCode === 201) {
              io.emit('upload_progress', {
                uploadId,
                status: 'success',
                progress: 100,
                speed: 0,
                eta: 0
              });
              resolve(JSON.parse(body));
            } else {
              reject(new Error(`Google Drive upload failed: HTTP ${driveRes.statusCode} - ${body}`));
            }
          });
        });

        driveReq.on('error', (err) => {
          if (transferId) activeBridgeStreams.delete(transferId);
          reject(err);
        });

        streamSource.on('data', (chunk) => {
          bytesTransferred += chunk.length;
          driveReq.write(chunk);

          const elapsed = (Date.now() - startTime) / 1000;
          const speed = elapsed > 0 ? (bytesTransferred / elapsed) : 0;
          const progress = totalSize > 0 ? ((bytesTransferred / totalSize) * 100) : 0;
          const remainingBytes = Math.max(0, totalSize - bytesTransferred);
          const eta = speed > 0 ? (remainingBytes / speed) : 0;

          io.emit('upload_progress', {
            uploadId,
            status: 'uploading',
            progress: Math.min(99.9, Math.round(progress * 10) / 10),
            speed: Math.round(speed / 1024), // KB/s
            eta: Math.round(eta)
          });
        });

        streamSource.on('end', () => {
          driveReq.end();
        });

        streamSource.on('error', (err) => {
          driveReq.destroy();
          if (transferId) activeBridgeStreams.delete(transferId);
          reject(err);
        });
      });

      initReq.on('error', (err) => {
        if (transferId) activeBridgeStreams.delete(transferId);
        reject(err);
      });
      initReq.write(metadata);
      initReq.end();
    };

    if (sourceStream) {
      // Use the direct memory bridge stream
      startUpload(sourceStream, fileItem.size || 0);
    } else {
      // Fallback: standard HTTP request to local Android server
      const getOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.path,
        method: 'GET'
      };

      const androidReq = http.request(getOptions, (androidRes) => {
        if (androidRes.statusCode !== 200 && androidRes.statusCode !== 206) {
          reject(new Error(`Failed to read file from Android: HTTP ${androidRes.statusCode}`));
          return;
        }

        const totalSize = parseInt(androidRes.headers['content-length'] || fileItem.size || '0');
        startUpload(androidRes, totalSize);
      });

      androidReq.on('error', (err) => reject(err));
      androidReq.end();
    }
  });
};

module.exports = {
  uploadToGoogleDrive,
  activeBridgeStreams
};
