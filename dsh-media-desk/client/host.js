// The upstream UI calls this adapter instead of DSH HTTP endpoints.
const sdk = () => window.ma;
const exportsByItem = new Map();
const mediaUrls = new Map();
async function hydrate(value) {
  if (Array.isArray(value)) return Promise.all(value.map(hydrate));
  if (value && typeof value === 'object') {
    const next = Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, row]) => [key, await hydrate(row)])));
    if (next.assetId) {
      if (!mediaUrls.has(next.assetId)) mediaUrls.set(next.assetId, sdk().media.url(next.assetId).catch(() => null));
      const asset = await mediaUrls.get(next.assetId);
      if (asset) { if ('src' in next) next.src = asset.url; if ('url' in next) next.url = asset.url; }
      else { delete next.src; delete next.url; next.status = 'failed'; next.error = '媒体文件已被删除，请重新导入或生成'; }
    }
    return next;
  }
  return value;
}
function urls(value) {
  if (typeof value === 'string' && value.startsWith('media-desk/assets/')) return `../assets/${value.slice('media-desk/assets/'.length)}`;
  if (Array.isArray(value)) return value.map(urls);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, row]) => [key, urls(row)]));
  return value;
}
const safeName = value => String(value).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 100) || 'file';

export async function request(path, body, language = 'zh') {
  await sdk().ready;
  if (path === 'produce/save') {
    const snapshot = await sdk().agent.domain.snapshot();
    const item = snapshot.state.items.find(row => row.id === body.id);
    if (!item?.production?.article) throw new Error('还没有可以保存的成稿');
    const production = item.production;
    const files = [{ name: '脚本.md', text: `# ${production.title}\n\n${production.article}` }, { name: '分镜脚本.md', text: (production.shots ?? []).map(row => `## ${row.no}\n\n${row.visual ?? ''}\n\n${row.voice ?? ''}`).join('\n\n') }];
    for (const [index, asset] of [production.cover, ...(production.images ?? []), ...(production.shots ?? [])].entries()) if (asset?.assetId) files.push({ name: `画面-${index + 1}.png`, assetId: asset.assetId });
    const result = await sdk().exports.create(files, safeName(production.title));
    exportsByItem.set(body.id, result.exportId);
    const saved = await request('record-export', { id: body.id, exportId: result.exportId, directory: result.directory }, language);
    return { ...saved, path: result.directory };
  }
  if (path === 'produce/reveal') {
    const exportId = exportsByItem.get(body.id);
    if (!exportId) throw new Error('请先在当前窗口保存成稿，再显示文件夹');
    const result = await sdk().exports.reveal(exportId);
    if (!result.ok) throw new Error(result.error || '无法显示文件夹');
    return result;
  }
  if (path === 'skills/export') {
    const snapshot = await sdk().agent.domain.snapshot();
    const rules = snapshot.state.skills.filter(row => !row.sample && ['active', 'exported'].includes(row.status));
    if (!rules.length) throw new Error('还没有可导出的个人写作规则');
    const text = `---\nname: media-desk-voice\ndescription: 作者的自媒体写作规则\n---\n\n${rules.map(row => `- **${row.name}**：${row.rule}`).join('\n')}`;
    await sdk().exports.create([{ name: 'SKILL.md', text }], 'media-desk-voice');
    return { name: 'media-desk-voice', rules: rules.length, state: snapshot.state };
  }
  if (body === undefined) return hydrate(urls(await sdk().agent.domain.query('desk.read', { path, language })));
  const response = await sdk().agent.domain.command('desk.write', { path, body, language });
  return hydrate(urls(response.result));
}

export async function pickFiles() {
  const paths = await sdk().files.pick();
  const assets = [];
  for (const path of paths) {
    const extension = /\.[A-Za-z0-9]+$/.exec(path)?.[0] ?? '.bin';
    const asset = await sdk().media.import(path, `media-${Date.now()}-${assets.length}${extension}`);
    await sdk().media.retain(asset.assetId); assets.push(asset);
  }
  return assets;
}

export async function uploadFile(file) {
  if (!file?.path) throw new Error('请使用「记灵感 → 图片/视频」的文件选择器导入本地素材');
  const asset = await sdk().media.import(file.path);
  return { src: asset.url, assetId: asset.assetId, kind: asset.mime.startsWith('video/') ? 'video' : 'image' };
}
