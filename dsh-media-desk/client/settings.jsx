// Upstream dialog layout; provider credentials belong to the host.
import React from 'react'
import { saveSettings, setDesk, testImage, useDesk } from './desk.js'
import { t, useLang } from './i18n.js'
import { Dialog, Icon } from './ui.jsx'
import { usePresenceValue } from './motion.js'

const imagePresets = [
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'chatgpt-image-latest', size: '1536x1024' },
  { label: 'xAI', baseUrl: 'https://api.x.ai/v1', model: 'grok-imagine-image', size: '' },
  { label: '火山方舟', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: '', size: '' },
  { label: '智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'cogview-4', size: '1024x1024' },
  { label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: '', size: '' },
  { label: '其他自定义', baseUrl: '', model: '', size: '' },
]
const normalizedAddress = value => (value ?? '').trim().replace(/\/+$/, '')

export function SettingsDialog() {
  useLang()
  const open = useDesk(s => s.settingsOpen)
  const settings = useDesk(s => s.settings)
  const {value: shown, presence} = usePresenceValue(open ? settings : null)
  const [form, setForm] = React.useState(null)
  const [models, setModels] = React.useState([])
  const [testing, setTesting] = React.useState(false)
  const [sample, setSample] = React.useState(null)
  const previewVersion = React.useRef(0)
  React.useEffect(() => {
    if (!open || !settings) { setForm(null); setSample(null); return }
    setForm(structuredClone(settings)); setSample(null)
    let active = true
    window.ma.models.list().then(rows => {
      if (!active) return
      setModels(rows)
    })
    return () => { active = false; previewVersion.current++; setTesting(false) }
  }, [open, settings])
  if (!shown || !form) return null
  const close = () => setDesk({settingsOpen:false})
  const images = models.filter(row => row.modalities.includes('image'))
  const custom = form.image.source === 'custom'
  const address = normalizedAddress(form.image.baseUrl)
  const selectedPreset = imagePresets.find(p => p.baseUrl && p.baseUrl === address)?.label ?? '其他自定义'
  const choosePreset = preset => {
    if (preset.label === selectedPreset) return
    setSample(null)
    setForm(f => ({ ...f, image: { ...f.image, baseUrl: preset.baseUrl, model: preset.model, size: preset.size, apiKey: '' } }))
  }
  const changeImage = (key, value) => setForm(f => ({ ...f, image: { ...f.image, [key]: value } }))
  const selectSource = source => setForm(f => ({ ...f, image: (settings.image.source ?? 'host') === source
    ? structuredClone(settings.image) : { source, model: '', provider: '', baseUrl: '', size: f.image.size } }))
  const selectImage = value => { const row = images.find(row => `${row.providerId}:${row.modelId}` === value); setForm(f => ({...f,image:{...f.image,provider:row?.providerId ?? '',model:row?.modelId ?? ''}})) }
  const preview = async () => {
    const version = ++previewVersion.current
    setTesting(true)
    setSample(null)
    try {
      const src = await testImage(form)
      if (version === previewVersion.current) setSample(src)
    } finally {
      if (version === previewVersion.current) setTesting(false)
    }
  }
  return <Dialog title={t('设置')} onClose={close} width={520} presence={presence}>
    <form className="md-form" onSubmit={async event => {event.preventDefault();if(await saveSettings(form)) close()}}>
      <div className="md-field"><span>{t('语言')}</span><div className="md-presets" role="radiogroup" aria-label={t('语言')}>
        {[['auto',t('跟随 Muster')],['zh','中文'],['en','English']].map(([value,label]) => <button key={value} type="button" role="radio" aria-checked={form.language===value} className={form.language===value?'is-on':''} onClick={()=>setForm(f=>({...f,language:value}))}>{label}</button>)}
      </div></div>
      <label className="md-field"><span>{t('成稿保存到')}</span><input value={shown.defaultExportDir} readOnly /><small>由宿主保存至当前用户的 Documents 文件夹。</small></label>
      {(images.length > 0 || !custom) && <label className="md-field"><span>{t('生图来源')}</span><select value={custom ? 'custom' : 'host'} onChange={e=>selectSource(e.target.value)}><option value="custom">{t('自定义生图 API')}</option><option value="host">Muster</option></select></label>}
      {custom ? <>
        <div className="md-field"><span>{t('服务商')}</span><div className="md-presets" role="group" aria-label={t('服务商')}>
          {imagePresets.map(preset => <button type="button" key={preset.label} className={preset.label === selectedPreset ? 'is-on' : ''} aria-pressed={preset.label === selectedPreset} onClick={() => choosePreset(preset)}>{t(preset.label)}</button>)}
        </div></div>
        <label className="md-field"><span>{t('接口地址')}</span><input type="url" placeholder="https://api.example.com/v1" value={form.image.baseUrl ?? ''} onChange={e=>changeImage('baseUrl', e.target.value)} /><small>{t('支持任何兼容 OpenAI 图片接口（/images/generations）的服务。')}</small></label>
        <label className="md-field"><span>{t('生图模型')}</span><input value={form.image.model} onChange={e=>changeImage('model', e.target.value)} /></label>
        <label className="md-field"><span>{t('密钥')}</span><input type="password" autoComplete="off" placeholder={settings.image.hasKey && normalizedAddress(settings.image.baseUrl) === address ? t('留空表示不修改') : 'API Key'} value={form.image.apiKey ?? ''} onChange={e=>changeImage('apiKey', e.target.value)} /></label>
      </> : <label className="md-field"><span>{t('生图模型')}</span><select aria-label={t('生图模型')} value={form.image.model?`${form.image.provider}:${form.image.model}`:''} onChange={event=>selectImage(event.target.value)}>
        <option value="">{t('自动选择')}</option>{images.map(row=><option key={`${row.providerId}:${row.modelId}`} value={`${row.providerId}:${row.modelId}`}>{row.providerName} · {row.modelName}</option>)}
      </select></label>}
      <div className="md-field-row">
        <label className="md-field"><span>{t('配图数量')}</span><input type="number" min="0" max="4" value={form.imageCount} onChange={event=>setForm(f=>({...f,imageCount:Number(event.target.value)}))}/></label>
        <label className="md-field"><span>{t('分镜格数')}</span><input type="number" min="0" max="12" value={form.shotCount} onChange={event=>setForm(f=>({...f,shotCount:Number(event.target.value)}))}/></label>
      </div>
      <label className="md-field"><span>{t('尺寸')}</span><input value={form.image.size} onChange={event=>setForm(f=>({...f,image:{...f.image,size:event.target.value}}))}/></label>
      {sample?<img className="md-test-sample" src={sample} alt={t('测试图')}/>:null}
      <div className="md-form-foot"><button type="button" className="md-btn" disabled={testing} onClick={preview}>{testing?t('正在试画…'):t('试画一张')}</button><span style={{flex:1}}/><button type="button" className="md-btn" onClick={close}>{t('取消')}</button><button type="submit" className="md-btn is-primary">{t('保存')}</button></div>
    </form>
  </Dialog>
}
