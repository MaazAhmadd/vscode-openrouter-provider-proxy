import fs from 'node:fs';
import path from 'node:path';
import http, { IncomingMessage, ServerResponse } from 'node:http';
import { URL, fileURLToPath } from 'node:url';

type JsonObject = Record<string, unknown>;

type AppConfig = {
  openrouterApiKey: string;
  openrouterBaseUrl: string;
  modelProviders: Record<string, string>;
  allowFallbacks: boolean;
  bindHost: string;
  port: number;
};

type RequestLogMeta = {
  model?: string;
  mappedProvider?: string;
  injectedProvider?: boolean;
  upstreamUrl?: string;
  upstreamStatus?: number;
};

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(APP_DIR, 'config.json');

const defaultConfig: AppConfig = {
  openrouterApiKey: '',
  openrouterBaseUrl: 'https://openrouter.ai/api/v1',
  modelProviders: {
    'z-ai/glm-5': 'atlas-cloud/fp8',
  },
  allowFallbacks: false,
  bindHost: '127.0.0.1',
  port: 3434,
};

function safeJsonParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function normalizeModelProviders(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const out: Record<string, string> = {};
  for (const [rawModel, rawProvider] of Object.entries(value as Record<string, unknown>)) {
    const model = String(rawModel || '').trim();
    const provider = String(rawProvider || '').trim();
    if (model && provider) {
      out[model] = provider;
    }
  }

  return out;
}

function migrateLegacyConfig(raw: Record<string, unknown>): AppConfig {
  const merged = {
    ...defaultConfig,
    ...raw,
  };

  const modelProviders = normalizeModelProviders(raw.modelProviders);
  const pinModel = String(raw.pinModel || '').trim();
  const pinProvider = String(raw.pinProvider || '').trim();

  if (pinModel && pinProvider && !modelProviders[pinModel]) {
    modelProviders[pinModel] = pinProvider;
  }

  return {
    openrouterApiKey: String(merged.openrouterApiKey || ''),
    openrouterBaseUrl: String(merged.openrouterBaseUrl || defaultConfig.openrouterBaseUrl),
    modelProviders,
    allowFallbacks: Boolean(merged.allowFallbacks),
    bindHost: String(merged.bindHost || defaultConfig.bindHost),
    port: Number(merged.port || defaultConfig.port),
  };
}

function readConfig(): AppConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2), 'utf8');
    return { ...defaultConfig };
  }

  const rawText = fs.readFileSync(CONFIG_PATH, 'utf8');
  const parsed = safeJsonParse<Record<string, unknown>>(rawText, {});
  const migrated = migrateLegacyConfig(parsed);
  writeConfig(migrated);
  return migrated;
}

function writeConfig(nextConfig: Partial<AppConfig>): AppConfig {
  const merged = {
    ...defaultConfig,
    ...nextConfig,
    modelProviders: normalizeModelProviders(nextConfig.modelProviders),
  };

  const normalized: AppConfig = {
    openrouterApiKey: String(merged.openrouterApiKey || ''),
    openrouterBaseUrl: String(merged.openrouterBaseUrl || defaultConfig.openrouterBaseUrl),
    modelProviders: normalizeModelProviders(merged.modelProviders),
    allowFallbacks: Boolean(merged.allowFallbacks),
    bindHost: String(merged.bindHost || defaultConfig.bindHost),
    port: Number(merged.port || defaultConfig.port),
  };

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(normalized, null, 2), 'utf8');
  return normalized;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function sendHtml(res: ServerResponse, markup: string): void {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(markup);
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { error: 'Not found' });
}

function nowIso(): string {
  return new Date().toISOString();
}

function createRequestId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function logRequest(reqId: string, method: string, pathname: string, meta: RequestLogMeta = {}): void {
  const details = {
    model: meta.model || null,
    mappedProvider: meta.mappedProvider || null,
    injectedProvider: meta.injectedProvider ?? null,
    upstreamUrl: meta.upstreamUrl || null,
    upstreamStatus: meta.upstreamStatus ?? null,
  };
  console.log(`[${nowIso()}] [${reqId}] ${method} ${pathname} ${JSON.stringify(details)}`);
}

function shouldInject(pathname: string): boolean {
  return pathname.endsWith('/chat/completions') || pathname.endsWith('/completions') || pathname.endsWith('/responses');
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function resolveRequestedModel(pathname: string, localUrl: URL, headers: IncomingMessage['headers'], parsedBody: unknown): string {
  if (shouldInject(pathname) && parsedBody && typeof parsedBody === 'object') {
    const bodyModel = (parsedBody as JsonObject).model;
    const bodyValue = String(bodyModel || '').trim();
    if (bodyValue) {
      return bodyValue;
    }
  }

  const fromQuery = String(localUrl.searchParams.get('model') || '').trim();
  if (fromQuery) {
    return fromQuery;
  }

  const fromHeader = String(headers['x-openrouter-model'] || '').trim();
  if (fromHeader) {
    return fromHeader;
  }

  return '';
}

function uiPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>LLM Proxy Provider Config</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, Arial; background:#0b1020; color:#e5e7eb; margin:0; }
    .wrap { max-width:900px; margin:36px auto; padding:0 16px; }
    .card { background:#121a31; border:1px solid #273253; border-radius:12px; padding:18px; margin-bottom:14px; }
    h1 { font-size:22px; margin:0 0 8px; }
    h2 { font-size:16px; margin:0 0 12px; color:#c7d2fe; }
    .muted { color:#9ca3af; font-size:13px; }
    .grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    .full { grid-column:1 / -1; }
    label { display:block; font-size:13px; margin-bottom:6px; color:#cbd5e1; }
    input[type="text"], input[type="password"], input[type="url"], input[type="number"], textarea {
      width:100%; padding:10px 11px; border-radius:8px; border:1px solid #334155; background:#0f172a; color:#e2e8f0;
      box-sizing:border-box;
    }
    textarea { min-height:150px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .row { display:flex; gap:10px; align-items:center; }
    button { background:#4f46e5; color:#fff; border:none; border-radius:8px; padding:10px 14px; cursor:pointer; }
    button:hover { background:#4338ca; }
    .ok { color:#34d399; }
    .warn { color:#fbbf24; }
    code { background:#0f172a; border:1px solid #334155; padding:2px 6px; border-radius:6px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>LLM Proxy / Provider</h1>
      <p class="muted">Requests to <code>/v1/*</code> are proxied to OpenRouter. Provider routing is injected only when an incoming model is mapped below.</p>
    </div>

    <div class="card">
      <h2>Configuration</h2>
      <form id="cfg" class="grid">
        <div class="full">
          <label>OpenRouter API Key</label>
          <input id="openrouterApiKey" type="password" placeholder="or-..." />
        </div>

        <div class="full">
          <label>OpenRouter Base URL</label>
          <input id="openrouterBaseUrl" type="url" placeholder="https://openrouter.ai/api/v1" />
        </div>

        <div class="full">
          <label>Model Provider Map (JSON object: model -> provider)</label>
          <textarea id="modelProvidersJson" placeholder='{"z-ai/glm-5":"atlas-cloud/fp8"}'></textarea>
        </div>

        <div>
          <label><input id="allowFallbacks" type="checkbox" /> allow_fallbacks for mapped models</label>
        </div>

        <div></div>

        <div class="full row">
          <button type="submit">Save Config</button>
          <span id="saveMsg" class="muted"></span>
        </div>
      </form>
    </div>

    <div class="card">
      <h2>Use in VS Code Insiders</h2>
      <p class="muted">Custom endpoint base URL: <code id="baseUrl"></code></p>
      <p class="muted">Chat completions URL: <code id="chatUrl"></code></p>
      <p class="muted">Health: <code id="healthUrl"></code></p>
    </div>
  </div>

  <script>
    const state = { host: window.location.origin };

    function setText(id, text) {
      document.getElementById(id).textContent = text;
    }

    async function loadConfig() {
      const res = await fetch('/api/config');
      const data = await res.json();
      document.getElementById('openrouterApiKey').value = data.openrouterApiKey || '';
      document.getElementById('openrouterBaseUrl').value = data.openrouterBaseUrl || '';
      document.getElementById('modelProvidersJson').value = JSON.stringify(data.modelProviders || {}, null, 2);
      document.getElementById('allowFallbacks').checked = !!data.allowFallbacks;
    }

    async function saveConfig(evt) {
      evt.preventDefault();
      const msg = document.getElementById('saveMsg');
      msg.className = 'muted';
      msg.textContent = 'Saving...';

      let modelProviders;
      try {
        modelProviders = JSON.parse(document.getElementById('modelProvidersJson').value || '{}');
      } catch {
        msg.className = 'warn';
        msg.textContent = 'Invalid JSON in model map.';
        return;
      }

      const payload = {
        openrouterApiKey: document.getElementById('openrouterApiKey').value.trim(),
        openrouterBaseUrl: document.getElementById('openrouterBaseUrl').value.trim(),
        modelProviders,
        allowFallbacks: document.getElementById('allowFallbacks').checked,
      };

      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed to save config' }));
        msg.className = 'warn';
        msg.textContent = err.error || 'Failed to save config';
        return;
      }

      msg.className = 'ok';
      msg.textContent = 'Saved.';
      await loadConfig();
    }

    setText('baseUrl', state.host + '/v1');
    setText('chatUrl', state.host + '/v1/chat/completions');
    setText('healthUrl', state.host + '/health');

    document.getElementById('cfg').addEventListener('submit', saveConfig);
    loadConfig().catch(() => {
      const msg = document.getElementById('saveMsg');
      msg.className = 'warn';
      msg.textContent = 'Could not load config.';
    });
  </script>
</body>
</html>`;
}

async function handleProxy(req: IncomingMessage, res: ServerResponse, localUrl: URL, reqId: string): Promise<void> {
  const config = readConfig();

  if (!config.openrouterApiKey) {
    logRequest(reqId, req.method || 'GET', localUrl.pathname, {
      injectedProvider: false,
    });
    sendJson(res, 400, { error: 'Missing OpenRouter API key. Set it in the web UI.' });
    return;
  }

  const base = String(config.openrouterBaseUrl || defaultConfig.openrouterBaseUrl).replace(/\/+$/, '');
  const targetPath = localUrl.pathname.replace(/^\/v1/, '');
  const upstreamUrl = `${base}${targetPath}${localUrl.search}`;
  const method = req.method || 'GET';

  const headers = new Headers();
  headers.set('authorization', `Bearer ${config.openrouterApiKey}`);

  if (req.headers['content-type']) headers.set('content-type', String(req.headers['content-type']));
  if (req.headers['accept']) headers.set('accept', String(req.headers['accept']));
  if (req.headers['x-title']) headers.set('x-title', String(req.headers['x-title']));
  if (req.headers['http-referer']) headers.set('http-referer', String(req.headers['http-referer']));

  let body: string | undefined;

  if (!['GET', 'HEAD'].includes(method)) {
    const raw = await readBody(req);
    const contentType = String(req.headers['content-type'] || '');

    if (raw && contentType.includes('application/json')) {
      const parsed = safeJsonParse<JsonObject | null>(raw, null);
      if (parsed && typeof parsed === 'object' && shouldInject(localUrl.pathname)) {
        const requestedModel = resolveRequestedModel(localUrl.pathname, localUrl, req.headers, parsed);
        const providerForModel = config.modelProviders[requestedModel];
        let injectedProvider = false;

        if (providerForModel) {
          const currentProvider = parsed.provider;
          parsed.provider = {
            ...(currentProvider && typeof currentProvider === 'object' ? currentProvider as JsonObject : {}),
            order: [providerForModel],
            allow_fallbacks: !!config.allowFallbacks,
          };
          injectedProvider = true;
        }

        logRequest(reqId, method, localUrl.pathname, {
          model: requestedModel,
          mappedProvider: providerForModel,
          injectedProvider,
          upstreamUrl,
        });
      }
      body = JSON.stringify(parsed ?? raw);
    } else {
      body = raw;
      logRequest(reqId, method, localUrl.pathname, {
        injectedProvider: false,
        upstreamUrl,
      });
    }
  } else {
    logRequest(reqId, method, localUrl.pathname, {
      injectedProvider: false,
      upstreamUrl,
    });
  }

  const upstream = await fetch(upstreamUrl, {
    method,
    headers,
    body,
    redirect: 'manual',
  });

  const responseHeaders = Object.fromEntries(upstream.headers.entries());
  delete responseHeaders['content-length'];

  logRequest(reqId, method, localUrl.pathname, {
    upstreamUrl,
    upstreamStatus: upstream.status,
  });

  res.writeHead(upstream.status, responseHeaders);

  if (upstream.body) {
    for await (const chunk of upstream.body) {
      res.write(chunk);
    }
  }

  res.end();
}

const initialConfig = readConfig();
const HOST = String(process.env.HOST || initialConfig.bindHost || defaultConfig.bindHost);
const PORT = Number(process.env.PORT || initialConfig.port || defaultConfig.port);

const server = http.createServer(async (req, res) => {
  try {
    const localUrl = new URL(req.url || '/', `http://${HOST}:${PORT}`);
    const method = req.method || 'GET';
    const reqId = createRequestId();

    logRequest(reqId, method, localUrl.pathname);

    if (localUrl.pathname === '/') {
      sendHtml(res, uiPage());
      return;
    }

    if (localUrl.pathname === '/health') {
      const cfg = readConfig();
      sendJson(res, 200, {
        ok: true,
        hasApiKey: Boolean(cfg.openrouterApiKey),
        modelProviderMappings: Object.keys(cfg.modelProviders).length,
        allowFallbacks: !!cfg.allowFallbacks,
        bindHost: cfg.bindHost,
        port: cfg.port,
      });
      return;
    }

    if (localUrl.pathname === '/api/config' && method === 'GET') {
      const cfg = readConfig();
      sendJson(res, 200, cfg);
      return;
    }

    if (localUrl.pathname === '/api/config' && method === 'POST') {
      const raw = await readBody(req);
      const next = safeJsonParse<JsonObject | null>(raw, null);

      if (!next || typeof next !== 'object') {
        sendJson(res, 400, { error: 'Invalid JSON payload.' });
        return;
      }

      const saved = writeConfig({
        openrouterApiKey: String(next.openrouterApiKey || ''),
        openrouterBaseUrl: String(next.openrouterBaseUrl || defaultConfig.openrouterBaseUrl),
        modelProviders: normalizeModelProviders(next.modelProviders),
        allowFallbacks: Boolean(next.allowFallbacks),
      });

      sendJson(res, 200, { ok: true, config: saved });
      return;
    }

    if (localUrl.pathname.startsWith('/v1/')) {
      await handleProxy(req, res, localUrl, reqId);
      return;
    }

    notFound(res);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    sendJson(res, 500, { error: message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`LLM Proxy web app running at http://${HOST}:${PORT}`);
  console.log(`Config UI: http://${HOST}:${PORT}`);
  console.log(`OpenAI-compatible base URL: http://${HOST}:${PORT}/v1`);
});
