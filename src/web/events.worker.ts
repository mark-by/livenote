/** Один SSE-поток на сервер и токен для всех вкладок браузера. */
interface SharedEventStream {
  source: EventSource;
  ports: Set<MessagePort>;
  hello?: string;
}

type StreamCommand =
  | { type: 'connect'; url: string; names: string[] }
  | { type: 'disconnect' };

const streams = new Map<string, SharedEventStream>();

self.addEventListener('connect', (event: Event) => {
  const port = (event as MessageEvent).ports[0];
  if (!port) return;
  let streamUrl: string | null = null;

  port.onmessage = ({ data }: MessageEvent<StreamCommand>): void => {
    if (data.type === 'disconnect') {
      if (streamUrl !== null) {
        const stream = streams.get(streamUrl);
        if (stream) {
          stream.ports.delete(port);
          if (stream.ports.size === 0) {
            stream.source.close();
            streams.delete(streamUrl);
          }
        }
      }
      port.close();
      return;
    }

    streamUrl = data.url;
    let stream = streams.get(streamUrl);
    if (!stream) {
      const source = new EventSource(streamUrl);
      const ports = new Set<MessagePort>();
      const created: SharedEventStream = { source, ports };
      streams.set(streamUrl, created);
      stream = created;
      source.onopen = (): void => {
        for (const client of ports) client.postMessage({ name: 'open' });
      };
      for (const name of data.names) {
        source.addEventListener(name, (rawEvent: Event) => {
          const value = String((rawEvent as MessageEvent).data);
          if (name === 'hello') created.hello = value;
          for (const client of ports) client.postMessage({ name, data: value });
        });
      }
    }

    stream.ports.add(port);
    if (stream.source.readyState === EventSource.OPEN) {
      port.postMessage({ name: 'open' });
      if (stream.hello !== undefined) port.postMessage({ name: 'hello', data: stream.hello });
    }
  };
});
