// content.js

let translationBox = null;
let lastTranslationText = '';

function createTranslationBox() {
  let box = document.getElementById('seamless-translation-box');
  if (box) {
    translationBox = box;
    return;
  }
  
  if (!document.body) return;

  translationBox = document.createElement('div');
  translationBox.id = 'seamless-translation-box';
  
  const header = document.createElement('div');
  header.className = 'header';
  header.textContent = 'FluentMeet AI';
  
  const content = document.createElement('div');
  content.id = 'translation-content';
  content.textContent = 'Waiting for audio...';
  
  translationBox.appendChild(header);
  translationBox.appendChild(content);
  
  document.body.appendChild(translationBox);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', createTranslationBox, { once: true });
} else {
  createTranslationBox();
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'DISPLAY_TRANSLATION') {
    if (typeof message.data !== 'string') return;

    createTranslationBox();
    const content = document.getElementById('translation-content');
    if (!content) return;

    const text = message.data.trim();
    if (!text) return;

    if (text === 'Listening...' || text.toLowerCase().includes('silence')) {
      const iterItem = document.createElement('i');
      iterItem.textContent = text;
      content.textContent = '';
      content.appendChild(iterItem);
      lastTranslationText = '';
      return;
    }

    const hasStatusElement = content.firstElementChild && content.firstElementChild.tagName === 'I';
    if (content.textContent === 'Waiting for audio...' || content.firstElementChild === null || hasStatusElement) {
      content.textContent = '';
    }

    if (text === lastTranslationText) {
      return;
    }

    const newTranslation = document.createElement('div');
    newTranslation.textContent = text;
    newTranslation.style.marginTop = '4px';
    newTranslation.style.borderTop = '1px solid #333';
    newTranslation.style.paddingTop = '4px';

    content.appendChild(newTranslation);

    // Keep only the last 3 chunks to prevent the box from growing infinitely
    while (content.children.length > 3) {
      content.removeChild(content.firstChild);
    }

    lastTranslationText = text;
  }
});
