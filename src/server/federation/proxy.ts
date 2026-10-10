// Forward WebSocket upgrades on `/p2p` to the libp2p listener.
// One cloudflared tunnel pointed at Fastify then carries both the UI and federation.
import { connect } from 'node:net';
import type { Server } from 'node:http';

export function proxyFederation(server: Server, port: number): void {
  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/p2p' && path !== '/p2p/') return;
    const upstream = connect(port, '127.0.0.1', () => {
      const lines = [`GET / HTTP/1.1`];
      for (const [key, value] of Object.entries(req.headers)) {
        if (value == null) continue;
        const v = Array.isArray(value) ? value.join(', ') : value;
        lines.push(key.toLowerCase() === 'host' ? `Host: 127.0.0.1:${port}` : `${key}: ${v}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    const drop = () => {
      socket.destroy();
      upstream.destroy();
    };
    upstream.on('error', drop);
    socket.on('error', drop);
  });
}
