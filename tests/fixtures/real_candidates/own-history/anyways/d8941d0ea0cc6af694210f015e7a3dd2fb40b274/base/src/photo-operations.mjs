export const PHOTO_IMAGE_TIMEOUT_MS = 12_000;
export const PHOTO_UPLOAD_TIMEOUT_MS = 45_000;
export const PHOTO_RECORD_TIMEOUT_MS = 20_000;
export const PHOTO_CLEANUP_TIMEOUT_MS = 8_000;

export function withPhotoTimeout(work, timeoutMs, message, { onTimeout, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimer(() => {
      try { onTimeout?.(); } catch {}
      reject(new Error(message));
    }, timeoutMs);
  });
  return Promise.race([Promise.resolve(work), timeout]).finally(() => clearTimer(timer));
}

export function inspectPhotoSource(source, {
  revoke = false,
  timeoutMs = PHOTO_IMAGE_TIMEOUT_MS,
  imageFactory = () => new Image(),
  revokeObjectUrl = value => URL.revokeObjectURL(value),
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  return new Promise(resolve => {
    const image = imageFactory();
    let settled = false;
    let timer;
    const finish = dimensions => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      image.onload = null;
      image.onerror = null;
      if (revoke) {
        try { revokeObjectUrl(source); } catch {}
      }
      resolve(dimensions);
    };
    image.onload = () => finish({ width: image.naturalWidth || null, height: image.naturalHeight || null, timedOut: false });
    image.onerror = () => finish({ width: null, height: null, timedOut: false });
    timer = setTimer(() => {
      finish({ width: null, height: null, timedOut: true });
      try { image.src = ''; } catch {}
    }, timeoutMs);
    try {
      image.src = source;
    } catch {
      finish({ width: null, height: null, timedOut: false });
    }
  });
}
