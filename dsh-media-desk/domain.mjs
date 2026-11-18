import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Store } from './lib/store.js';
import { applyOps } from './lib/ops.js';
import { computeInsights, proposeRules } from './lib/learn.js';
import { Producer } from './lib/produce.js';
import { chatTurn, extractStyle } from './lib/conversation.js';
import { callModel, modelInfo, modelStatus, setAssistantModel } from './lib/ai.js';
import { harvest } from './lib/harvest.js';
import { withLang, currentLang } from './lib/i18n.js';
import { samplesNeedLocale, localizeSamples } from './lib/seed.js';

const clone = value => structuredClone(value);
const trUnsupportedMonid = language => language === 'en' ? 'Monid account import is not connected yet. Paste your writing to extract a style, or enter metrics manually.' : '当前尚未接入 Monid 账号导入；可以粘贴内容提炼风格或手动录入数据。';
const defaults = () => ({ language: 'auto', assistant: { provider: '', model: '' }, image: { provider: '', model: '', size: '1536x1024' }, imageCount: 2, shotCount: 6, voice: '' });

/** Upstream state, operations and producer; all host access stays behind the bound broker. */
export function createDomainRuntime({ identity = {}, broker } = {}) {
  if (!broker) throw new Error('媒体创作台需要宿主 broker');
  const scope = new AsyncLocalStorage();
  const lifetime = new AbortController();
  let version = 0, savedSettings, closed = false, settled = false;
  const listeners = new Set();
  const context = () => scope.getStore() ?? { identity, actor: 'human', requestId: randomUUID(), signal: lifetime.signal };
  const call = (method, args, onDelta) => broker(method, args, context(), onDelta);
  const changed = () => {
    version++;
    const event = { type: 'desk.changed', ...identity, version, requestId: context().requestId ?? 'desk', actor: context().actor ?? 'human', payload: {} };
    for (const listener of listeners) listener(clone(event));
  };
  const store = new Store(call, changed);
  let models = [];
  const hostImage = image => {
    const images = models.filter(row => row.modalities.includes('image'));
    return image.model ? images.find(row => row.providerId === image.provider && row.modelId === image.model) : images.find(row => row.isDefault) ?? images[0];
  };
  async function settingsRead() {
    if (!savedSettings) {
      const stored = await call('data.read', ['media-desk/settings.json']);
      savedSettings = stored ? { ...defaults(), ...JSON.parse(stored.content) } : defaults();
    }
    models = await call('models.list', []);
    setAssistantModel(savedSettings.assistant);
    const settings = clone(savedSettings);
    if (!settings.image.source && !settings.image.model && !hostImage(settings.image)) settings.image.source = 'custom';
    const custom = settings.image.source === 'custom';
    settings.image.hasKey = Boolean(settings.image.sealedKey);
    delete settings.image.sealedKey;
    return { ...settings, imageReady: custom ? Boolean(settings.image.baseUrl && settings.image.model) : Boolean(hostImage(settings.image)), imageToolAvailable: false, defaultExportDir: 'Documents / Muster Extensions', assistantEffective: modelInfo(ctx)?.label ?? null };
  }
  const ctx = {
    get(name) {
      if (name === 'llm') return models.some(row => row.modalities.includes('text')) ? {} : null;
      if (name === 'agentDefaultModel') return { currentSelection: () => { const selected = models.find(row => row.isDefault && row.modalities.includes('text')) ?? models.find(row => row.modalities.includes('text')); return selected ? { provider: selected.providerId, model: selected.modelId } : null; } };
    },
    callText: ({ system, user, maxTokens, signal, onText, light, providerId, modelId }) => broker('llm.chatStream', [[{ role: 'system', content: system }, { role: 'user', content: user }], { providerId, modelId, maxTokens, timeoutMs: 240000, thinking: light ? 'light' : 'off' }], { ...context(), signal: signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal }, onText)
  };
  async function generate(image, prompt, { signal = lifetime.signal, preview = false } = {}) {
    const requestContext = { ...context(), signal: AbortSignal.any([signal, lifetime.signal]) };
    let result;
    if (image.source === 'custom') {
      result = await broker('models.customImage', [{ baseUrl: image.baseUrl, model: image.model, size: image.size, apiKey: image.apiKey, sealedKey: image.sealedKey, prompt }], requestContext);
    } else {
      const selected = hostImage(image);
      if (!selected) throw new Error('请在宿主模型设置中接入生图模型');
      result = await broker('models.invoke', [{ modality: 'image', providerId: selected.providerId, modelId: selected.modelId, prompt, size: image.size }], requestContext);
    }
    if (!preview) await call('media.retain', [result.asset.assetId]);
    return result;
  }
  const producer = new Producer({
    store, settings: { read: async () => ({ ...await settingsRead(), image: clone(savedSettings.image) }) },
    callText: options => callModel(ctx, options), ready: settings => settings.imageReady, generate
  });
  const desk = { producer, settings: { read: settingsRead } };

  async function read(path, language) {
    return withLang(language, async () => {
      const settings = await settingsRead();
      if (path === 'settings') return settings;
      if (path === 'models') {
        const providers = [...new Set(models.filter(row => row.modalities.includes('text')).map(row => row.providerId))].map(provider => ({ provider, name: models.find(row => row.providerId === provider).providerName, models: models.filter(row => row.providerId === provider && row.modalities.includes('text')).map(row => ({ id: row.modelId, name: row.modelName })) }));
        return { providers, default: ctx.get('agentDefaultModel').currentSelection(), current: settings.assistant };
      }
      if (path === 'state') {
        if (!settled) { settled = true; await producer.settleAll(); }
        let state = await store.read();
        if (samplesNeedLocale(state, currentLang())) state = await store.mutate('', draft => (localizeSamples(draft, currentLang()), draft), { undoable: false });
        return { state, model: modelInfo(ctx)?.label ?? null, ...{ modelOk: modelStatus.ok, modelError: modelStatus.error }, canUndo: store.undo.length > 0 };
      }
      if (path.startsWith('production?')) {
        const id = new URLSearchParams(path.split('?')[1]).get('id');
        await producer.settle(id);
        const item = (await store.read()).items.find(row => row.id === id);
        return { production: item?.production ?? null, status: item?.status, live: producer.status(id) };
      }
      if (path === 'insights') return computeInsights(await store.read());
      if (path === 'monid/status') return { state: 'unsupported', message: trUnsupportedMonid(language) };
      throw new Error(`未知媒体创作台查询：${path}`);
    });
  }

  async function write(path, body = {}, language) {
    return withLang(language, async () => {
      await settingsRead();
      if (path === 'ops') return store.mutate(String(body.label ?? '操作'), draft => ({ ...applyOps(draft, body.ops), state: draft }), { undoable: body.undoable !== false });
      if (path === 'undo') { const label = await store.undoLast(); return { label, state: await store.read(), canUndo: store.undo.length > 0 }; }
      if (path === 'chat') return chatTurn(ctx, store, desk, body);
      if (path === 'chat/clear') return { state: await store.mutate('清空对话', draft => (draft.chat = [], draft), { undoable: false }) };
      if (path === 'produce') { const started = await producer.start(String(body.id)); return { started, state: await store.read() }; }
      if (path === 'produce/cancel') { await producer.cancel(String(body.id)); return { ok: true }; }
      if (path === 'produce/regen') { await producer.regenerate(String(body.id), body.target); return { state: await store.read() }; }
      if (path === 'style/extract') return extractStyle(ctx, store, body);
      if (path === 'settings') {
        const next = clone(savedSettings);
        if (['auto', 'zh', 'en'].includes(body.language)) next.language = body.language;
        for (const [key, max] of [['imageCount', 4], ['shotCount', 12]]) if (Number.isInteger(Number(body[key]))) next[key] = Math.max(0, Math.min(max, Number(body[key])));
        for (const key of ['assistant', 'image']) if (body[key]) {
          const selection = body[key];
          if (key === 'image' && selection.source === 'custom') {
            if (context().actor === 'agent') throw new Error('请在媒体创作台设置中配置生图连接');
            const baseUrl = String(selection.baseUrl ?? '').trim().replace(/\/+$/, '');
            const model = String(selection.model ?? '').trim();
            const size = String(selection.size ?? '').trim();
            if (!baseUrl && !model && !selection.apiKey) { next.image = { source: 'custom', baseUrl, model, size }; continue; }
            const endpoint = new URL(baseUrl);
            if (!model || !['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('请填写有效的接口地址和模型名称');
            if (savedSettings.image.sealedKey && !selection.apiKey && baseUrl !== savedSettings.image.baseUrl) throw new Error('连接地址已更改，请重新填写 API Key');
            const sealedKey = selection.apiKey ? await call('models.sealImageKey', [baseUrl, selection.apiKey]) : savedSettings.image.sealedKey;
            next.image = { source: 'custom', baseUrl, model, size, ...(sealedKey ? { sealedKey } : {}) };
            continue;
          }
          if (selection.model && !models.some(row => row.modelId === selection.model && row.providerId === selection.provider && row.modalities.includes(key === 'image' ? 'image' : 'text'))) throw new Error('所选模型不可用');
          next[key] = { provider: String(selection.provider ?? ''), model: String(selection.model ?? ''), ...(key === 'image' ? { size: String(selection.size ?? next.image.size).slice(0, 40) } : {}) };
        }
        await call('data.write', ['media-desk/settings.json', JSON.stringify(next)]); savedSettings = next;
        return settingsRead();
      }
      if (path === 'settings/test') {
        const image = body.image ?? savedSettings.image;
        if (context().actor === 'agent' && body.image) throw new Error('请在媒体创作台设置中试画');
        const result = await generate({ ...image, sealedKey: savedSettings.image.sealedKey }, 'A paper boat on calm water, pencil sketch.', { preview: true });
        return { src: result.asset.url };
      }
      if (path === 'capture-url') {
        const page = await harvest(String(body.url ?? ''));
        return store.mutate('收藏链接', draft => {
          const applied = applyOps(draft, [{ op: 'add_item', kind: 'web', title: page.title || page.url, body: page.description || '', url: page.url, source: page.siteName }]);
          return { ...applied, id: applied.receipts[0]?.target, state: draft };
        });
      }
      if (path === 'record-export') return { state: await store.mutate('保存成稿', draft => { const target = draft.items.find(row => row.id === body.id); if (!target?.production) throw new Error('没有可保存的成稿'); target.production.savedPath = String(body.directory); target.production.exportId = String(body.exportId); target.production.savedAt = new Date().toISOString(); return draft; }, { undoable: false }) };
      if (path === 'skills/learn') {
        const proposals = proposeRules(await store.read());
        return { added: proposals.length, state: await store.mutate('从数据中学习', draft => { applyOps(draft, proposals.map(row => ({ op: 'add_skill', ...row, status: 'proposed' }))); return draft; }) };
      }
      throw new Error(`当前宿主尚未接入此操作：${path}`);
    });
  }
  return {
    async getSnapshot(input = {}) { return scope.run(input, async () => { const state = await store.read(); return { version, state, capturedAt: new Date().toISOString() }; }); },
    async query(name, args = {}, input = {}) { if (name !== 'desk.read') throw new Error(`未知查询：${name}`); return scope.run(input, () => read(String(args.path), args.language)); },
    async execute(name, args = {}, input = {}) { if (closed) throw new Error('媒体创作台已关闭'); if (name !== 'desk.write') throw new Error(`未知命令：${name}`); return scope.run(input, async () => ({ ok: true, version, result: await write(String(args.path), args.body, args.language) })).then(result => ({ ...result, version })); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async close() { closed = true; lifetime.abort(); for (const id of producer.jobs.keys()) await producer.cancel(id); await store.queue; listeners.clear(); }
  };
}
