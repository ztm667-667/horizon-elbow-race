// PaddleOCR's canvas adapter uses DOM constructors. Provide their worker
// equivalents in this isolated scope; the main document is unaffected.
self.document = {createElement: () => new OffscreenCanvas(1, 1)};
self.HTMLCanvasElement = OffscreenCanvas;
self.HTMLImageElement = class {};

function lineBounds(poly, canvas) {
  const xs = poly.map(point => point[0]);
  const ys = poly.map(point => point[1]);
  const left = Math.max(0, Math.floor(Math.min(...xs)));
  const top = Math.max(0, Math.floor(Math.min(...ys)));
  const right = Math.min(canvas.width, Math.ceil(Math.max(...xs)));
  const bottom = Math.min(canvas.height, Math.ceil(Math.max(...ys)));
  return {left, top, width: right - left, height: bottom - top};
}

function coloredSuffix(canvas, line) {
  const text = line.text.trim();
  const match = /^(.+\S)\s+[A-Za-z0-9]$/.exec(text);
  if (!match || !line.poly?.length) return null;
  const {left, top, width, height} = lineBounds(line.poly, canvas);
  if (width < 32 || height < 12) return null;

  const context = canvas.getContext('2d', {willReadFrequently: true});
  const {data} = context.getImageData(left, top, width, height);
  const colorCut = Math.floor(width * .65);
  let coloredPrefixPixels = 0;
  let coloredSuffixPixels = 0;
  let firstColorColumn = width;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const r = data[offset], g = data[offset + 1], b = data[offset + 2];
      if (Math.max(r, g, b) - Math.min(r, g, b) < 52) continue;
      if (x < colorCut) coloredPrefixPixels++;
      else {
        coloredSuffixPixels++;
        firstColorColumn = Math.min(firstColorColumn, x);
      }
    }
  }
  if (coloredPrefixPixels > width * height * .025 || coloredSuffixPixels < height) return null;
  // Run OCR again with the colored area masked. Accept the shorter reading only
  // when recognition independently agrees on the rest of the text.
  const cropWidth = firstColorColumn - Math.ceil(height * .12);
  if (cropWidth < colorCut) return null;
  const margin = 10;
  const crop = new OffscreenCanvas(cropWidth + margin * 2, height + margin * 2);
  const output = crop.getContext('2d');
  output.fillStyle = '#ffffff';
  output.fillRect(0, 0, crop.width, crop.height);
  output.drawImage(canvas, left, top, cropWidth, height, margin, margin, cropWidth, height);
  return {crop, prefix: match[1]};
}

self.onmessage = async ({data: {image, assets}}) => {
  let engine;
  let bitmap;
  const embeddedUrls = [];
  try {
    bitmap = await createImageBitmap(image);
    for (const [name, asset] of Object.entries(assets)) {
      if (typeof asset === 'string') continue;
      assets[name] = URL.createObjectURL(new Blob([asset.bytes], {type: asset.type}));
      embeddedUrls.push(assets[name]);
    }
    const {PaddleOCR} = await import(assets.engine);
    engine = await PaddleOCR.create({
      textDetectionModelName: 'PP-OCRv6_tiny_det',
      textRecognitionModelName: 'PP-OCRv6_tiny_rec',
      textDetectionModelAsset: {url: assets.detection},
      textRecognitionModelAsset: {url: assets.recognition},
      ortOptions: {backend: 'wasm', numThreads: 1, wasmPaths: {wasm: assets.wasm, mjs: assets.loader}}
    });
    self.postMessage({phase: 'recognizing'});
    const longEdge = Math.max(bitmap.width, bitmap.height);
    const scale = longEdge < 650 ? 1.5 : Math.min(1, 2048 / longEdge);
    const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
    canvas.getContext('2d', {willReadFrequently: true}).drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const [result] = await engine.predict(canvas);
    const lines = [];
    for (const line of result.items) {
      if (line.score < .35) continue;
      const suffix = coloredSuffix(canvas, line);
      if (suffix) {
        try {
          const [retry] = await engine.predict(suffix.crop);
          const read = retry.items.map(item => item.text.trim()).join(' ');
          if (read === suffix.prefix) {
            lines.push(read);
            continue;
          }
        } catch {
          // A refinement failure should still leave the original line available for review.
        }
      }
      lines.push(line.text.trim());
    }
    self.postMessage({text: lines.join('\n')});
  } catch (error) {
    self.postMessage({error: error instanceof Error ? error.message : String(error)});
  } finally {
    bitmap?.close();
    await engine?.dispose();
    for (const url of embeddedUrls) URL.revokeObjectURL(url);
  }
};
