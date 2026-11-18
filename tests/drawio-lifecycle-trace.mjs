export function installDrawioLifecycleTrace() {
  if (window !== window.top) return;
  const events = [];
  const documents = new WeakMap();
  let nextDocument = 0;
  let nextFrame = 0;
  const frames = new WeakMap();
  const deferredExports = [];
  window.__drawioTrace = events;
  window.__holdExports = false;
  window.__releaseExports = () => {
    window.__holdExports = false;
    for (const send of deferredExports.splice(0)) send();
  };
  const id = frame => {
    if (!frames.has(frame)) frames.set(frame, ++nextFrame);
    return frames.get(frame);
  };
  const block = frame => {
    const key = Object.keys(frame).find(name => name.startsWith('__reactFiber$'));
    let fiber = key ? frame[key] : null;
    while (fiber) {
      const value = fiber.memoizedProps?.block;
      if (value?.type === 'drawio') return { blockId: value.id, xml: value.source };
      fiber = fiber.return;
    }
    return null;
  };
  window.__frameBlock = block;
  new MutationObserver(records => {
    for (const record of records) {
      if (record.target instanceof HTMLIFrameElement && record.attributeName === 'src') {
        events.push({ event: 'src', frame: id(record.target), old: record.oldValue,
          src: record.target.getAttribute('src'), block: block(record.target), time: performance.now() });
      }
      if (record.type !== 'childList') continue;
      for (const [kind, nodes] of [['removed', record.removedNodes], ['added', record.addedNodes]]) {
        for (const node of nodes) {
          if (!(node instanceof Element)) continue;
          const affected = node instanceof HTMLIFrameElement ? [node] : [...node.querySelectorAll('iframe')];
          for (const frame of affected) {
            if (!frame.matches('.drawio-frame-host, .drawio-fullscreen__frame')) continue;
            events.push({ event: `dom-${kind}`, frame: id(frame), connected: frame.isConnected,
              changedNode: `${node.tagName}.${node.className}`,
              mutationParent: `${record.target.nodeName}.${record.target.className ?? ''}`,
              parent: frame.parentElement?.className, block: block(frame), time: performance.now() });
          }
        }
      }
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeOldValue: true, attributeFilter: ['src'] });
  document.addEventListener('load', event => {
    const frame = event.target;
    if (!(frame instanceof HTMLIFrameElement)) return;
    let url;
    let documentId;
    try {
      url = frame.contentWindow.location.href;
      const frameDocument = frame.contentDocument;
      if (frameDocument && !documents.has(frameDocument)) documents.set(frameDocument, ++nextDocument);
      documentId = frameDocument && documents.get(frameDocument);
    } catch { url = 'foreign'; }
    events.push({ event: 'iframe-load', frame: id(frame), documentId, url, src: frame.getAttribute('src'),
      className: frame.className, block: block(frame), time: performance.now() });
    if (!frame.contentWindow || url === 'foreign' || url === 'about:blank') return;
    const target = frame.contentWindow;
    const send = target.postMessage;
    target.postMessage = function (data, origin, ...rest) {
      let message;
      try { message = JSON.parse(data); } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
      if (message?.action === 'export') {
        events.push({ event: 'export-request', frame: id(frame), requestId: message.requestId,
          held: window.__holdExports, block: block(frame), time: performance.now() });
        if (window.__holdExports) {
          deferredExports.push(() => send.call(target, data, origin, ...rest));
          return;
        }
      }
      return send.call(target, data, origin, ...rest);
    };
  }, true);
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || typeof event.data !== 'string') return;
    try {
      const value = JSON.parse(event.data);
      if (!['init', 'configure', 'load', 'autosave', 'export'].includes(value.event)) return;
      const frame = [...document.querySelectorAll('iframe')].find(item => item.contentWindow === event.source);
      events.push({ event: `message-${value.event}`, frame: frame && id(frame), time: performance.now() });
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  });
}
