// background.js

function notify(message) {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      title: 'FluentMeet AI',
      message: message,
      priority: 2
    });
  } catch (e) {
    console.error('Notification failed:', e);
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  console.log('Action clicked on tab:', tab.id, tab.url);

  if (!tab.url || !tab.url.includes('meet.google.com/')) {
    notify('Please join a Google Meet call first.');
    return;
  }

  try {
    const existingContexts = await chrome.runtime.getContexts({});
    const offscreenDocument = existingContexts.find(
      (c) => c.contextType === 'OFFSCREEN_DOCUMENT'
    );

    if (!offscreenDocument) {
      console.log('Creating offscreen document...');
      await chrome.offscreen.createDocument({
        url: 'src/offscreen.html',
        reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
        justification: 'Processing Google Meet audio'
      });
    }

    console.log('Requesting Stream ID for tab:', tab.id);
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tab.id
    });

    if (!streamId) {
      throw new Error('Could not generate Stream ID. Is the tab active?');
    }

    console.log('Stream ID obtained:', streamId);
    chrome.runtime.sendMessage({
      type: 'START_TRANSLATION',
      target: 'offscreen',
      data: { streamId, tabId: tab.id }
    });

    chrome.tabs.sendMessage(tab.id, {
      type: 'DISPLAY_TRANSLATION',
      data: 'Listening...'
    }, () => {
      if (chrome.runtime.lastError) {
        console.debug('Failed to deliver startup status to tab:', chrome.runtime.lastError.message);
      }
    });
    
    notify('Processor started. Downloading model (this may take a minute)...');

  } catch (err) {
    console.error('CRITICAL ERROR:', err);
    notify('Error: ' + err.message);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'TRANSLATION_RESULT') {
    if (typeof message.tabId !== 'number') return;

    chrome.tabs.sendMessage(message.tabId, {
      type: 'DISPLAY_TRANSLATION',
      data: message.data
    }, () => {
      if (chrome.runtime.lastError) {
        console.debug('Failed to deliver translation to tab:', chrome.runtime.lastError.message);
      }
    });
  } else if (message.type === 'ERROR') {
    notify('Error: ' + String(message.data));
  } else if (message.type === 'MODEL_LOADED') {
    notify('AI Model Ready! Start speaking.');
  }
});
