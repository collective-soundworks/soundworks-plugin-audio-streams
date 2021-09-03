// @todo - replace with some buffer loader that could be cancelled...
export function loadAudioBuffer(audioContext, url) {
  const promise = new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('GET', url, true);
    request.responseType = 'arraybuffer';

    request.onload = () => {
      const response = request.response;
      audioContext.decodeAudioData(response, buffer => {
        resolve(buffer);
      }, (err) => {
        reject(err);
      });
    }

    request.send();
  });

  return promise;
}
