// Adapted from upstream host.js; no DSH web server or credential storage.
import { callModel, chatPrompts, modelInfo, modelStatus, extractJson } from './ai.js'
import { localIntent } from './intents.js'
import { applyOps, newId } from './ops.js'
import { applyRevision } from './produce.js'
import { tr, platformName } from './i18n.js'
import { harvestText } from './harvest.js'
import { normalizeStyle, stylePrompts } from './style.js'
function outageNotice(ctx, wasDown, fallback) {
  if (wasDown) return null
  return modelInfo(ctx) ? tr('模型暂时用不了，{fallback}。可以到设置里检查账号或密钥。', { fallback }) : tr('当前没有连接模型，{fallback}。', { fallback })
}

async function chatTurn(ctx, store, desk, body) {
  const message = String(body.message || '').trim()
  if (!message) throw Object.assign(new Error(tr('消息为空')), { status: 400 })
  const focusId = typeof body.focusId === 'string' ? body.focusId : undefined
  const state = await store.read()
  const snapshot = JSON.parse(JSON.stringify(state))
  let plan
  let engine = 'local'
  let notice = null
  const wasDown = modelStatus.ok === false
  try {
    const history = snapshot.chat.filter(row => (row.itemId ?? null) === (focusId ?? null))
    const { system, user } = chatPrompts(snapshot, message, { focusId, history })
    const editing = snapshot.items.find(row => row.id === focusId)?.production?.status === 'done'
    const { text, model } = await callModel(ctx, { system, user, maxTokens: editing ? 8000 : 2000, light: true, signal: AbortSignal.timeout(editing ? 240_000 : 90_000) })
    engine = model
    try {
      plan = extractJson(text)
      if (typeof plan.reply !== 'string') plan.reply = tr('处理好了。')
    } catch {
      // 模型只回了一段话时，当成普通回答，不算失败
      plan = { reply: text.trim().slice(0, 1200) || tr('我没有听懂，可以换个说法吗？'), ops: [] }
    }
  } catch {
    notice = outageNotice(ctx, wasDown, tr('先用本地规则处理'))
    plan = localIntent(snapshot, message, { focusId })
  }
  const settings = await desk.settings.read()
  const canDraw = desk.producer.ready(settings)
  // 只把真正改了数据的那一步放进撤销；问一句话不占撤销位
  const changed = await store.mutate(tr('对话：{text}', { text: message.slice(0, 18) }), (draft) => {
    const target = focusId ? draft.items.find(row => row.id === focusId) : null
    const production = target?.production?.status === 'done' ? target.production : null
    // 本地规则只会改灵感标题；有成稿时要改的是成稿标题
    const ops = (Array.isArray(plan.ops) ? plan.ops : []).map((op) => {
      if (production && op?.op === 'update_item' && op.id === focusId && typeof op.title === 'string') return { op: 'update_production', id: focusId, title: op.title }
      return op
    })
    const { receipts, errors } = applyOps(draft, ops)
    let targets = []
    if (production && plan.revise) {
      // 没接生图时，图不会重画，回执要说实话
      const revision = applyRevision(production, plan.revise, { canDraw })
      receipts.push(...revision.receipts.map(text => ({ text })))
      errors.push(...revision.errors)
      targets = canDraw ? revision.targets : []
    }
    return { receipts, errors, targets, done: Boolean(production) }
  })
  const result = await store.mutate('对话记录', (draft) => {
    const { receipts, errors, targets, done } = changed
    const at = new Date().toISOString()
    const itemId = focusId ?? undefined
    // 已经做好的成稿不会因为一句话被整篇重做，要重做请点「重新成稿」
    const actions = (Array.isArray(plan.actions) ? plan.actions : [])
      .filter(a => a && ['produce', 'open', 'nav'].includes(a.type))
      .filter(a => !(a.type === 'produce' && (done && a.id === focusId || draft.items.find(row => row.id === a.id)?.production?.status === 'done')))
    draft.chat.push({ id: newId('c'), at, role: 'user', text: message, itemId })
    const answer = { id: newId('c'), at, role: 'assistant', text: plan.reply, receipts, errors, engine, notice, undoable: receipts.length > 0, itemId }
    draft.chat.push(answer)
    draft.chat = draft.chat.slice(-300)
    return { answer, actions, targets, state: draft, modelOk: modelStatus.ok, modelError: modelStatus.error }
  }, { undoable: false })
  if (canDraw) {
    await Promise.all(result.targets.map(target => desk.producer.regenerate(focusId, target).catch(() => {})))
    return { ...result, state: await store.read() }
  }
  return result
}

async function extractStyle(ctx, store, body) {
  const urls = (Array.isArray(body.urls) ? body.urls : []).map(row => String(row).trim()).filter(Boolean).slice(0, 5)
  const parts = [String(body.text ?? '').trim()].filter(Boolean)
  const failures = []
  for (const url of urls) {
    try {
      const page = await harvestText(url)
      if (page.text.length >= 80) parts.push(`${page.title ?? ''}\n${page.text}`)
      else failures.push(tr('{url}：页面上几乎没有文字，可能需要登录', { url }))
    } catch (err) {
      failures.push(tr('{url}：{error}', { url, error: err.message }))
    }
  }
  const material = parts.join('\n\n---\n\n')
  if (material.length < 80) {
    throw Object.assign(new Error(failures.length ? tr('抓不到内容。{reason}。可以把内容直接贴进来。', { reason: failures[0] }) : tr('内容太少了，至少贴一段完整的文字')), { status: 400 })
  }
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 20) : ''
  const source = urls.length && parts.length === urls.length ? tr('链接') : urls.length ? tr('内容和链接') : tr('内容')
  return styleFromMaterial(ctx, store, { material, name, source, sourceUrls: urls, failures })
}

/** 提炼一张风格卡并设为当前风格。同一个账号再抓一次时更新原来那张。 */
async function styleFromMaterial(ctx, store, { material, name, source, sourceUrls = [], failures = [], accountKey = null }) {
  let style
  try {
    const { system, user } = stylePrompts(material, name)
    const { text } = await callModel(ctx, { system, user, maxTokens: 1500, light: true, signal: AbortSignal.timeout(120_000) })
    style = normalizeStyle(extractJson(text), name)
  } catch (err) {
    throw Object.assign(new Error(tr('提炼风格需要文字模型：{error}', { error: err.message })), { status: 502 })
  }
  return store.mutate(tr('提炼风格「{name}」', { name: style.name }), (draft) => {
    const existing = accountKey ? (draft.styles ?? []).find(row => row.accountKey === accountKey) : null
    const id = existing?.id ?? newId('st')
    const row = { id, ...style, source, sourceUrls, ...(accountKey ? { accountKey } : {}), createdAt: existing?.createdAt ?? new Date().toISOString() }
    draft.styles = existing ? draft.styles.map(entry => (entry.id === id ? row : entry)) : [row, ...(draft.styles ?? [])]
    draft.activeStyleId = id
    return { id, failures, state: draft }
  })
}


export { chatTurn, extractStyle }
