(() => {
  const imageInput = document.querySelector('#image');
  const pickImage = document.querySelector('#pick-image');
  const pasteImage = document.querySelector('#paste-image');
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

  function setImageBusy(busy) {
    pickImage.disabled = pasteImage.disabled = busy;
  }

  function isImageType(type) {
    return type.startsWith('image/');
  }

  function cleanRecognizedText(text) {
    return text.split(/\r\n|[\r\n]/)
      .map(line => line.replace(/[^A-Za-z0-9]/g, ''))
      .filter(Boolean)
      .join('\n');
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
    const interruption = new Promise((_, reject) => {
      interrupt = error => {
        stopped = true;
        reject(error);
      };
    });
    const isCurrent = () => request === requestNumber && !stopped;
    const deadline = setTimeout(() => interrupt(new DOMException('识别超时', 'TimeoutError')), 75_000);
    cancelRecognition = () => interrupt(new DOMException('取消识别', 'AbortError'));
    clearReview();
    setImageBusy(true);
    if (cancelButton) cancelButton.hidden = false;
    imageStatus.textContent = '正在加载识别引擎…';
    async function recognize() {
      const engine = await getEngine();
      if (!isCurrent()) return;
      imageStatus.textContent = '正在加载识别模型…';
      // Recognize UI text and symbols before filtering so they are less likely to be read as English letters.
      const initialization = engine.createWorker(['chi_sim', 'eng'], engine.OEM.LSTM_ONLY, {
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
      });
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
      return worker.recognize(image);
    }

    try {
      const result = await Promise.race([recognize(), interruption]);
      if (!isCurrent() || !result) return;
      const text = cleanRecognizedText(result.data.text);
      if (!text) {
        imageStatus.textContent = '没有识别到文字。可以试试更清晰的截图，或裁出昵称所在区域。';
        return;
      }
      recognizedText.value = text;
      review.hidden = false;
      imageStatus.textContent = '识别完成，请先核对。';
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
        setImageBusy(false);
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

  pasteImage.addEventListener('click', async () => {
    if (!canRecognizeImage()) return;
    const shortcutTip = '请在名单输入框按 Ctrl+V（Mac 用 ⌘V）粘贴，或手动选择图片。';
    if (!navigator.clipboard?.read) {
      imageStatus.textContent = shortcutTip;
      return;
    }

    const request = ++requestNumber;
    let image;
    setImageBusy(true);
    imageStatus.textContent = '正在读取剪贴板…';
    try {
      const items = await navigator.clipboard.read();
      if (request !== requestNumber) return;
      for (const item of items) {
        const type = item.types.find(isImageType);
        if (type) {
          image = await item.getType(type);
          break;
        }
      }
      if (request === requestNumber && !image) {
        imageStatus.textContent = '剪贴板里没有图片。请先复制截图。';
      }
    } catch {
      if (request === requestNumber) imageStatus.textContent = '无法读取剪贴板。' + shortcutTip;
    } finally {
      if (request === requestNumber) setImageBusy(false);
    }
    if (request === requestNumber) void recognizeImage(image);
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
    setImageBusy(false);
    imageStatus.textContent = '';
    clearReview();
  }
  window.addEventListener('pagehide', resetImageState);
  window.addEventListener('pageshow', event => {
    if (event.persisted) resetImageState();
  });
})();
