import { createServer } from 'node:http';
const lang = process.env.MOCK_LANG ?? 'en';
const text = lang === 'pt-BR'
  ? 'Aldric aperta a chave na mao e jura devolve-la ao amanhecer. O que fazes?'
  : 'Aldric clutches the key and swears to return it by dawn. What do you do?';
const input = { segments: [{ text }], proposals: [
  { kind: 'entity', id: 'aldric', entityKind: 'npc', name: 'Aldric' },
  { kind: 'claim', id: 'aldric-jurou-devolver-chave', entityId: 'aldric', claimKind: 'promise', key: 'return-key', value: 'open' },
] };
createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const request = JSON.parse(body || '{}');
    if (!request.tools) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }));
    }
    if (request.stream) {
      res.setHeader('content-type', 'text/event-stream');
      const ev = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
      ev({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 1 } } });
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'narrate', input: {} } });
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
      ev({ type: 'content_block_stop', index: 0 });
      ev({ type: 'message_delta', usage: { output_tokens: 1 } });
      return res.end();
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ content: [{ type: 'tool_use', id: 't', name: 'narrate', input }], usage: { input_tokens: 1, output_tokens: 1 } }));
  });
}).listen(Number(process.env.MOCK_PORT), '127.0.0.1');
