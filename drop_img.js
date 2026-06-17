// drop_img.js — Photo upload via DragEvent simulation
// Depends on: utils.js (sleep, setStatus)

function base64ToFile(base64, filename) {
  const arr = base64.split(',');
  const mimeMatch = arr[0].match(/:(.*?);/);
  const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
  const bstr = atob(arr[1] !== undefined ? arr[1] : arr[0]);
  const n = bstr.length;
  const u8arr = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    u8arr[i] = bstr.charCodeAt(i);
  }
  return new File([u8arr], filename, { type: mime });
}

function simulateFileDrop(targetEl, fileObj) {
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(fileObj);

  const eventOptions = {
    bubbles: true,
    cancelable: true,
    composed: true,
    dataTransfer,
  };

  targetEl.dispatchEvent(new DragEvent('dragenter', { ...eventOptions, clientX: 1, clientY: 1 }));
  targetEl.dispatchEvent(new DragEvent('dragover',  { ...eventOptions, clientX: 1, clientY: 2 }));
  targetEl.dispatchEvent(new DragEvent('drop',      { ...eventOptions, clientX: 1, clientY: 2 }));
}

async function uploadPhoto(photoUrl, index) {
  setStatus(`Uploading photo ${index + 1}...`);

  let base64Data = null;
  try {
    base64Data = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { action: 'downloadImage', url: photoUrl },
        response => {
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
          } else if (response && response.data) {
            resolve(response.data);
          } else {
            reject(new Error('No data received from background'));
          }
        }
      );
    });
  } catch (err) {
    console.error('[Relister] Photo download failed:', err);
    return false;
  }

  const filename = `photo-${index}.jpg`;
  const fileObj = base64ToFile(base64Data, filename);

  let dropTarget = document.querySelector('div[aria-label="Add photos or videos"]');
  if (!dropTarget) {
    dropTarget = document.querySelector('input[accept="image/*,image/heif,image/heic"]');
  }
  if (!dropTarget) {
    console.error('[Relister] Could not find photo drop zone');
    return false;
  }

  simulateFileDrop(dropTarget, fileObj);

  await sleep(2000);
  return true;
}

async function uploadAllPhotos(photoUrls) {
  for (let i = 0; i < photoUrls.length; i++) {
    const success = await uploadPhoto(photoUrls[i], i);
    if (!success) {
      console.warn(`[Relister] Skipping photo ${i + 1} due to upload failure`);
    }
    if (i < photoUrls.length - 1) {
      await sleep(2000);
    }
  }
}
