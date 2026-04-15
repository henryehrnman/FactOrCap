(() => {
  function getPageText() {
    const bodyClone = document.body.cloneNode(true);

    const removable = bodyClone.querySelectorAll(
      'script, style, noscript, svg, img, video, audio, iframe, nav, footer, header, [role="navigation"], [role="banner"], [aria-hidden="true"]'
    );
    removable.forEach((el) => el.remove());

    const text = bodyClone.innerText || bodyClone.textContent || '';

    return text
      .split(/\n+/)
      .map((line) => line.trim())
      .filter((line) => line.length > 20)
      .join('\n');
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'extractText') {
      const text = getPageText();
      sendResponse({ text });
    }
    return true;
  });
})();
