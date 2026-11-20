(() => {
  const imageInput = document.querySelector('#image');
  const pickImage = document.querySelector('#pick-image');
  const pasteImage = document.querySelector('#paste-image');
  const imageStatus = document.querySelector('#image-status');
  const review = document.querySelector('#ocr-review');
  const recognizedText = document.querySelector('#ocr-text');
  const roster = document.querySelector('#names');
  const vendor = new URL('./ocr/', window.location.href);
  let loadEngine;
  let requestNumber = 0;

  function getEngine() {
    if (!loadEngine) {
      loadEngine = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = new URL('tesseract.min.js', vendor).href;
        script.onload = () => resolve(window.Tesseract);
        script.onerror = () => {
          script.remove();
          reject(new Error('无法加载识别引擎'));
        };
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

  async function recognizeImage(image) {
    if (!image || pickImage.disabled || !canRecognizeImage()) return;
    if (image.size > 16 * 1024 * 1024) {
      imageStatus.textContent = '图片超过 16 MB。请先裁出名单区域，再试一次。';
      return;
    }

    const request = ++requestNumber;
    let worker;
    clearReview();
    setImageBusy(true);
    imageStatus.textContent = '正在加载识别引擎…';
    try {
      const engine = await getEngine();
      if (request !== requestNumber) return;
      let rejectInitialization;
      const initializationError = new Promise((resolve, reject) => {
        rejectInitialization = reject;
      });
      const initialization = engine.createWorker(['chi_sim', 'eng'], engine.OEM.LSTM_ONLY, {
        workerPath: new URL('worker.min.js', vendor).href,
        corePath: vendor.href,
        langPath: new URL('models', vendor).href,
        workerBlobURL: false,
        cacheMethod: 'none',
        errorHandler: message => rejectInitialization(new Error(String(message))),
        logger: message => {
          if (request === requestNumber && message.status === 'recognizing text') {
            imageStatus.textContent = '正在识别… ' + Math.round(message.progress * 100) + '%';
          }
        }
      });
      worker = await Promise.race([initialization, initializationError]);
      if (request !== requestNumber) return;

      const result = await worker.recognize(image);
      if (request !== requestNumber) return;
      // Tesseract often inserts spaces between characters in a Chinese nickname.
      const text = result.data.text.replace(/(\p{Script=Han})[^\S\r\n]+(?=\p{Script=Han})/gu, '$1').trim();
      if (!text) {
        imageStatus.textContent = '没有识别到文字。可以试试更清晰的截图，或裁出昵称所在区域。';
        return;
      }
      recognizedText.value = text;
      review.hidden = false;
      imageStatus.textContent = '识别完成，请先核对。';
      if (document.activeElement === document.body) recognizedText.focus({preventScroll: true});
    } catch {
      if (request === requestNumber) {
        imageStatus.textContent = '图片识别失败。请换一张清晰的 PNG、JPG 或 WebP 图片重试。';
      }
    } finally {
      if (request === requestNumber) setImageBusy(false);
      if (worker) await worker.terminate().catch(() => {});
    }
  }

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

  window.addEventListener('pagehide', () => {
    requestNumber++;
    imageInput.value = '';
    setImageBusy(false);
    imageStatus.textContent = '';
    clearReview();
  });
})();
