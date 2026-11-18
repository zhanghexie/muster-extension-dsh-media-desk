// Original three-way undo; persistence is bound to the host data broker.
import { buildSeed } from './seed.js'
const MAX_UNDO = 30

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const keyed = list => list.every(row => isObject(row) && typeof row.id === 'string')

function revertList(before, after, current) {
  const was = new Map(before.map(row => [row.id, row]))
  const now = new Map(after.map(row => [row.id, row]))
  // 这一步新增的行撤掉，两边都有的行逐字段撤回，其余（之后才加的）原样保留
  const result = current
    .filter(row => !(now.has(row.id) && !was.has(row.id)))
    .map(row => (was.has(row.id) && now.has(row.id) ? revertChange(was.get(row.id), now.get(row.id), row) : row))
  // 这一步删掉的行放回原来的位置
  const present = new Set(result.map(row => row.id))
  before.forEach((row, index) => {
    if (now.has(row.id) || present.has(row.id)) return
    result.splice(Math.min(index, result.length), 0, structuredClone(row))
    present.add(row.id)
  })
  return result
}

/**
 * 三方合并式撤销：只撤回这一步改过、之后又没被别的操作改动的部分。
 * 撤销「切换风格」不会抹掉之后生成的成稿；撤销「对话改标题」不会把之后画好的图退回去。
 * @param {*} before - 这一步之前的值。
 * @param {*} after - 这一步之后的值。
 * @param {*} current - 现在的值。
 * @returns {*} 撤销后的值。
 */
export function revertChange(before, after, current) {
  if (same(before, after)) return current
  if (same(current, after)) return before === undefined ? undefined : structuredClone(before)
  if (isObject(before) && isObject(after) && isObject(current)) {
    const result = { ...current }
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const value = revertChange(before[key], after[key], current[key])
      if (value === undefined) delete result[key]
      else result[key] = value
    }
    return result
  }
  if (Array.isArray(before) && Array.isArray(after) && Array.isArray(current)) {
    if (keyed(before) && keyed(after) && keyed(current) && (before.length || after.length)) return revertList(before, after, current)
    if (before.length === after.length && after.length === current.length) return current.map((row, index) => revertChange(before[index], after[index], row))
  }
  // 之后又被改过且无法逐项合并时，保留现在的值
  return current
}


export class Store {
  constructor(call, changed) {
    this.call = call
    this.changed = changed
    this.state = null
    this.undo = []
    this.queue = Promise.resolve()
  }

  run(task) {
    const next = this.queue.then(task, task)
    this.queue = next.catch(() => {})
    return next
  }

  async refresh() {
    if (this.state) return
    const saved = await this.call('data.read', ['media-desk/state.json'])
    const state = saved ? JSON.parse(saved.content) : buildSeed(new Date())
    if (!state || !Array.isArray(state.items)) throw new Error('媒体创作台数据无效')
    this.state = state
    if (!saved) {
      try { await this.persist() }
      catch (error) { this.state = null; throw error }
    }
  }

  async persist() {
    await this.call('data.write', ['media-desk/state.json', JSON.stringify(this.state)])
    this.changed()
  }

  read() {
    return this.run(async () => {
      await this.refresh()
      return structuredClone(this.state)
    })
  }

  mutate(label, mutate, { undoable = true } = {}) {
    return this.run(async () => {
      await this.refresh()
      const before = structuredClone(this.state), draft = structuredClone(before)
      const result = await mutate(draft)
      this.state = draft
      try { await this.persist() }
      catch (error) { this.state = before; throw error }
      if (undoable && !same(before, draft)) {
        this.undo.push({ label, before, after: structuredClone(draft) })
        if (this.undo.length > MAX_UNDO) this.undo.shift()
      }
      return structuredClone(result)
    })
  }

  undoLast() {
    return this.run(async () => {
      await this.refresh()
      const entry = this.undo.at(-1)
      if (!entry) return null
      const before = this.state
      this.state = revertChange(entry.before, entry.after, this.state)
      try { await this.persist() }
      catch (error) { this.state = before; throw error }
      this.undo.pop()
      return entry.label
    })
  }
}
