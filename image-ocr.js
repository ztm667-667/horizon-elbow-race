(() => {
  const imageInput = document.querySelector('#image');
  const pickImage = document.querySelector('#pick-image');
  const cancelButton = document.querySelector('#cancel-recognition');
  const imageStatus = document.querySelector('#image-status');
  const review = document.querySelector('#ocr-review');
  const recognizedText = document.querySelector('#ocr-text');
  const roster = document.querySelector('#names');
  const vendor = new URL('./ocr/', window.location.href);
  let loadEngine;
  let requestNumber = 0;
  let cancelRecognition;

  function getEngine() {
    if (typeof window.Tesseract?.createWorker === 'function') return Promise.resolve(window.Tesseract);
    if (!loadEngine) {
      loadEngine = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = new URL('tesseract.min.js', vendor).href;
        function fail(error) {
          clearTimeout(timer);
          script.remove();
          reject(error);
        }
        const timer = setTimeout(() => fail(new DOMException('识别引擎加载超时', 'TimeoutError')), 25_000);
        script.onload = () => {
          if (typeof window.Tesseract?.createWorker !== 'function') {
            fail(new Error('识别引擎未初始化'));
            return;
          }
          clearTimeout(timer);
          resolve(window.Tesseract);
        };
        script.onerror = () => fail(new Error('无法加载识别引擎'));
        document.head.append(script);
      }).catch(error => {
        loadEngine = null;
        throw error;
      });
    }
    return loadEngine;
  }

  function clearReview() {
    review.hidden = true;
    recognizedText.value = '';
  }

  function canRecognizeImage() {
    if (location.protocol === 'file:') {
      imageStatus.textContent = '请通过在线网站或本地 HTTP 地址打开页面，再使用图片识别。';
      return false;
    }
    return true;
  }

  function isImageType(type) {
    return type.startsWith('image/');
  }

  function cleanRecognizedText(text) {
    return text.split(/\r\n|[\r\n]/)
      .map(line => line.replace(/[^A-Za-z0-9 \t]/g, '').replace(/[ \t]+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
  }

  async function prepareDarkRoster(image) {
    if (typeof createImageBitmap !== 'function') return null;
    const bitmap = await createImageBitmap(image);
    try {
      const {width, height} = bitmap;
      // Apply this only to narrow list crops. Photos and full screenshots use normal OCR.
      if (width < 64 || width > 720 || height < width || height > 2160) return null;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', {willReadFrequently: true});
      context.fillStyle = 'white';
      context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, width, height);
      const {data} = pixels;
      const histogram = new Uint32Array(256);
      for (let i = 0; i < data.length; i += 4) {
        // Luminance keeps both yellow highlights and white names brighter than the UI background.
        const light = Math.round(.2126 * data[i] + .7152 * data[i + 1] + .0722 * data[i + 2]);
        data[i] = light;
        histogram[light]++;
      }
      const percentile = fraction => {
        let count = 0;
        for (let light = 0; light < histogram.length; light++) {
          count += histogram[light];
          if (count >= fraction * width * height) return light;
        }
        return 255;
      };
      const background = percentile(.8);
      const foreground = percentile(.9);
      const contrast = foreground - background;
      if (background > 150 || foreground < 175 || contrast < 45) return null;

      const cutoff = Math.round(background + contrast * .55);
      const range = Math.round(contrast * .7);
      for (let i = 0; i < data.length; i += 4) {
        const gray = 255 - (data[i] - cutoff) * 255 / range;
        // Uint8ClampedArray clamps out-of-range values to white or black.
        data[i] = data[i + 1] = data[i + 2] = gray;
      }
      context.putImageData(pixels, 0, 0);

      // A white margin protects glyphs touching the crop; enlarge only small crops.
      const padding = 16;
      const scale = width < 180 ? 2 : 1;
      const prepared = document.createElement('canvas');
      prepared.width = width * scale + padding * 2;
      prepared.height = height * scale + padding * 2;
      const output = prepared.getContext('2d');
      output.fillStyle = 'white';
      output.fillRect(0, 0, prepared.width, prepared.height);
      output.drawImage(canvas, padding, padding, width * scale, height * scale);
      return prepared;
    } finally {
      bitmap.close();
    }
  }

  function terminateWorker(worker) {
    if (worker) void worker.terminate().catch(() => {});
  }

  async function recognizeImage(image) {
    if (!image || pickImage.disabled || !canRecognizeImage()) return;
    if (image.size > 16 * 1024 * 1024) {
      imageStatus.textContent = '图片超过 16 MB。请先裁出名单区域，再试一次。';
      return;
    }

    const request = ++requestNumber;
    let stopped = false;
    let worker;
    let interrupt;
    const generalAbort = new AbortController();
    const interruption = new Promise((_, reject) => {
      interrupt = error => {
        stopped = true;
        generalAbort.abort(error);
        reject(error);
      };
    });
    const isCurrent = () => request === requestNumber && !stopped;
    const deadline = setTimeout(() => interrupt(new DOMException('识别超时', 'TimeoutError')), 75_000);
    cancelRecognition = () => interrupt(new DOMException('取消识别', 'AbortError'));
    clearReview();
    pickImage.disabled = true;
    if (cancelButton) cancelButton.hidden = false;
    imageStatus.textContent = '正在加载识别引擎…';
    async function recognize() {
      if (window.HorizonGeneralOcr) {
        try {
          const text = await window.HorizonGeneralOcr.recognize(image, generalAbort.signal, () => {
            if (isCurrent()) imageStatus.textContent = '正在检测并识别文字…';
          });
          if (cleanRecognizedText(text)) return text;
        } catch {
          // Browsers without the general OCR runtime can still use the lighter engine.
        }
      }
      if (!isCurrent()) return;
      const engine = await getEngine();
      if (!isCurrent()) return;
      const prepared = await prepareDarkRoster(image).catch(() => null);
      if (!isCurrent()) return;
      imageStatus.textContent = '正在加载识别模型…';
      // On mixed screenshots, read UI text before filtering to avoid forcing it into Latin characters.
      const languages = prepared ? 'eng' : ['chi_sim', 'eng'];
      const initialization = engine.createWorker(languages, engine.OEM.LSTM_ONLY, {
        workerPath: new URL('worker.min.js', vendor).href,
        corePath: vendor.href,
        langPath: new URL('models', vendor).href,
        workerBlobURL: false,
        cacheMethod: 'none',
        errorHandler: message => interrupt(new Error(String(message))),
        logger: message => {
          if (isCurrent() && message.status === 'recognizing text') {
            imageStatus.textContent = '正在识别… ' + Math.round(message.progress * 100) + '%';
          }
        }
      }, prepared ? {load_system_dawg: false, load_freq_dawg: false} : undefined);
      const initialized = await initialization;
      if (!isCurrent()) {
        terminateWorker(initialized);
        return;
      }
      worker = initialized;
      const workerFailed = () => interrupt(new Error('识别进程已停止'));
      worker.worker?.addEventListener('error', workerFailed, {once: true});
      worker.worker?.addEventListener('messageerror', workerFailed, {once: true});
      imageStatus.textContent = '正在识别文字…';
      if (!prepared) return (await worker.recognize(image)).data.text;

      await worker.setParameters({
        tessedit_pageseg_mode: engine.PSM.SINGLE_BLOCK,
        tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 '
      });
      if (!isCurrent()) return;
      const enhanced = await worker.recognize(prepared);
      if (!isCurrent() || cleanRecognizedText(enhanced.data.text)) return enhanced.data.text;

      await worker.reinitialize(['chi_sim', 'eng'], engine.OEM.LSTM_ONLY, {
        load_system_dawg: true, load_freq_dawg: true
      });
      if (!isCurrent()) return;
      await worker.setParameters({tessedit_char_whitelist: ''});
      if (isCurrent()) return (await worker.recognize(image)).data.text;
    }

    try {
      const result = await Promise.race([recognize(), interruption]);
      if (!isCurrent() || typeof result !== 'string') return;
      const text = cleanRecognizedText(result);
      if (!text) {
        imageStatus.textContent = '没有识别到文字。可以试试更清晰的截图，或裁出昵称所在区域。';
        return;
      }
      recognizedText.value = text;
      review.hidden = false;
      imageStatus.textContent = '识别出 ' + text.split('\n').length + ' 行，请核对漏行、空格和大小写。';
      if (document.activeElement === document.body) recognizedText.focus({preventScroll: true});
    } catch (error) {
      if (request === requestNumber) {
        if (error?.name === 'AbortError') imageStatus.textContent = '已取消识别，可以重新选择图片。';
        else if (error?.name === 'TimeoutError') imageStatus.textContent = '识别超时。请裁出昵称区域后重试，也可以手动输入名单。';
        else imageStatus.textContent = '图片识别失败。请换一张清晰的 PNG、JPG 或 WebP 图片重试。';
      }
    } finally {
      clearTimeout(deadline);
      stopped = true;
      terminateWorker(worker);
      if (request === requestNumber) {
        cancelRecognition = undefined;
        pickImage.disabled = false;
        if (cancelButton) {
          if (document.activeElement === cancelButton) pickImage.focus({preventScroll: true});
          cancelButton.hidden = true;
        }
      }
    }
  }

  cancelButton?.addEventListener('click', () => cancelRecognition?.());

  pickImage.addEventListener('click', () => {
    if (canRecognizeImage()) imageInput.click();
  });

  imageInput.addEventListener('change', () => {
    const file = imageInput.files[0];
    imageInput.value = '';
    void recognizeImage(file);
  });

  document.addEventListener('paste', event => {
    const data = event.clipboardData;
    if (!data || event.defaultPrevented) return;
    const item = Array.from(data.items).find(entry => entry.kind === 'file' && isImageType(entry.type));
    const image = item?.getAsFile() ?? Array.from(data.files).find(file => isImageType(file.type));
    if (!image) return;
    event.preventDefault();
    void recognizeImage(image);
  });

  document.querySelector('#import-names').addEventListener('click', () => {
    const imported = recognizedText.value.split(/\r\n|[\n\r]/).map(line => line.trim()).filter(Boolean);
    if (!imported.length) {
      imageStatus.textContent = '请先在识别结果里保留至少一行昵称。';
      recognizedText.focus();
      return;
    }
    roster.value = [roster.value.trim(), ...imported].filter(Boolean).join('\n');
    roster.dispatchEvent(new Event('input', {bubbles: true}));
    clearReview();
    imageStatus.textContent = '已追加 ' + imported.length + ' 行到名单。';
    roster.focus();
  });

  document.querySelector('#discard-text').addEventListener('click', () => {
    clearReview();
    imageStatus.textContent = '';
    pickImage.focus();
  });

  function resetImageState() {
    requestNumber++;
    cancelRecognition?.();
    cancelRecognition = undefined;
    if (cancelButton) cancelButton.hidden = true;
    imageInput.value = '';
    pickImage.disabled = false;
    imageStatus.textContent = '';
    clearReview();
  }
  window.addEventListener('pagehide', resetImageState);
  window.addEventListener('pageshow', event => {
    if (event.persisted) resetImageState();
  });
})();
