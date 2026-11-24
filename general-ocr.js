(() => {
  const files = {
    worker: 'worker.mjs',
    engine: 'engine.mjs',
    wasm: 'ort-wasm-simd-threaded.wasm',
    loader: 'ort-wasm-simd-threaded.mjs',
    detection: 'PP-OCRv6_tiny_det_onnx_infer.tar',
    recognition: 'PP-OCRv6_tiny_rec_onnx_infer.tar'
  };

  async function recognize(image, signal, onRecognizing) {
    if (typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') {
      throw new Error('通用识别需要浏览器的 OffscreenCanvas');
    }
    const root = new URL('./ocr/general/', location.href);
    const embedded = document.querySelector('#general-ocr-assets');
    const objectUrls = [];
    let worker;
    let timer;
    let abort;
    try {
      const assets = {};
      const transfer = [];
      for (const [name, file] of Object.entries(files)) {
        if (!embedded) {
          assets[name] = new URL(file, root).href;
          continue;
        }
        const data = embedded.content.querySelector('[data-ocr="' + name + '"]').textContent;
        const bytes = typeof Uint8Array.fromBase64 === 'function'
          ? Uint8Array.fromBase64(data)
          : Uint8Array.from(atob(data), char => char.charCodeAt(0));
        const type = file.endsWith('.mjs') ? 'text/javascript'
          : file.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
        if (name === 'worker') {
          assets.worker = URL.createObjectURL(new Blob([bytes], {type}));
          objectUrls.push(assets.worker);
        } else {
          assets[name] = {bytes, type};
          transfer.push(bytes.buffer);
        }
      }
      return await new Promise((resolve, reject) => {
        abort = () => reject(signal.reason);
        if (signal.aborted) return abort();
        signal.addEventListener('abort', abort, {once: true});
        timer = setTimeout(() => reject(new Error('通用识别加载超时')), 30_000);
        worker = new Worker(assets.worker);
        worker.onerror = event => reject(new Error(event.message || '通用识别进程已停止'));
        worker.onmessageerror = () => reject(new Error('无法读取通用识别结果'));
        worker.onmessage = ({data}) => {
          if (data.phase === 'recognizing') {
            clearTimeout(timer);
            onRecognizing();
          } else if (data.error) reject(new Error(data.error));
          else resolve(data.text);
        };
        worker.postMessage({image, assets}, transfer);
      });
    } finally {
      clearTimeout(timer);
      if (abort) signal.removeEventListener('abort', abort);
      worker?.terminate();
      for (const url of objectUrls) URL.revokeObjectURL(url);
    }
  }

  window.HorizonGeneralOcr = {recognize};
})();
